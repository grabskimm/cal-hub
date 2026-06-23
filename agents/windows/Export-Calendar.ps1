<#
.SYNOPSIS
    AvailCal Windows agent: read the already-synced Outlook calendar via COM,
    emit privacy-safe busy JSON, and PUT it to a write-scoped blob.

.DESCRIPTION
    Reads busy intervals from the local Outlook store (the same data Outlook has
    already synced from Exchange/M365 — no network calendar call, works behind
    Conditional Access). Only start/end/status + a single-word source label leave
    this machine; titles, bodies, attendees and locations are never read.

    Recurrence is expanded by Outlook itself. CRITICAL ORDERING REQUIREMENT:
    `Items.IncludeRecurrences = $true` only takes effect for a *sorted* table and
    the sort MUST be applied first. The supported sequence is:
        $items.Sort("[Start]")          # 1. sort ascending by start
        $items.IncludeRecurrences = $true   # 2. THEN enable recurrence expansion
        $items.Restrict("[Start] >= ... AND [Start] <= ...")  # 3. window filter
    Reversing 1 and 2 silently returns only the master appointments (recurring
    instances vanish) — a classic silent-corruption bug.

    Fails LOUDLY (non-zero exit) when Outlook is unavailable or the profile has
    no calendar, because a misconfigured profile otherwise returns zero events
    and would publish a falsely-empty "you are totally free" feed.

.PARAMETER DryRun
    Parse the local store and print the JSON to stdout. Upload nothing.

.PARAMETER SasUrl
    Write-scoped SAS URL for this source's blob (e.g.
    https://acct.blob.core.windows.net/availcal/raw/WorkX.json?sv=...&sig=...).
    Required unless -DryRun. Prefer an Arc Managed Identity where available
    (see README); SAS is the fallback.

.PARAMETER SourcesToml
    Path to sources.toml. The [device] section maps the Outlook store display
    name to its single-word label. Unmapped stores are slugified and warned.

.PARAMETER HorizonDays
    Days ahead to export (default 90).

.EXAMPLE
    .\Export-Calendar.ps1 -DryRun -SourcesToml .\sources.toml

.EXAMPLE
    .\Export-Calendar.ps1 -SasUrl $env:AVAILCAL_AGENT_SAS_URL -SourcesToml .\sources.toml
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [string]$SasUrl = $env:AVAILCAL_AGENT_SAS_URL,
    [string]$Token = $env:AVAILCAL_AGENT_TOKEN,
    [string]$SourcesToml = ".\sources.toml",
    [int]$HorizonDays = 90
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Outlook OlBusyStatus enum -> AvailCal status. 0 = Free is dropped at source.
$BusyStatusMap = @{
    0 = $null          # olFree   -> drop
    1 = "tentative"    # olTentative
    2 = "busy"         # olBusy
    3 = "oof"          # olOutOfOffice
    4 = "busy"         # olWorkingElsewhere
}

function Fail($message) {
    Write-Error "AvailCal agent FAILED: $message"
    exit 1
}

# Minimal [device] TOML reader: `"Store Name" = "Label"` lines under [device].
# (Avoids a TOML dependency on stock PowerShell 5.1.)
function Read-DeviceLabels([string]$path) {
    $map = @{}
    if (-not (Test-Path $path)) {
        Write-Warning "sources.toml not found at $path; all labels will be slugified."
        return $map
    }
    $section = ""
    foreach ($line in Get-Content -LiteralPath $path) {
        $t = $line.Trim()
        if ($t -eq "" -or $t.StartsWith("#")) { continue }
        if ($t -match '^\[(.+)\]$') { $section = $Matches[1]; continue }
        if ($section -eq "device" -and $t -match '^\s*"?([^"=]+?)"?\s*=\s*"([^"]+)"\s*$') {
            $map[$Matches[1].Trim()] = $Matches[2].Trim()
        }
    }
    return $map
}

function Get-Slug([string]$raw) {
    $s = ($raw -replace '\W+', '_').Trim('_')
    if ([string]::IsNullOrEmpty($s)) { $s = "Unknown" }
    return $s
}

function Resolve-Label($map, [string]$storeName) {
    if ($map.ContainsKey($storeName)) { return $map[$storeName] }
    $slug = Get-Slug $storeName
    Write-Warning "Unmapped Outlook store '$storeName' -> '$slug'; add it to [device] in sources.toml."
    return $slug
}

if (-not $DryRun -and [string]::IsNullOrWhiteSpace($SasUrl)) {
    Fail "no -SasUrl provided and AVAILCAL_AGENT_SAS_URL is empty (required unless -DryRun)."
}

$deviceLabels = Read-DeviceLabels $SourcesToml

# Connect to the running/headless Outlook COM application.
try {
    $outlook = New-Object -ComObject Outlook.Application
    $namespace = $outlook.GetNamespace("MAPI")
} catch {
    Fail "could not start Outlook COM (is Outlook installed and a profile configured?). $_"
}

$windowStart = (Get-Date)
$windowEnd = $windowStart.AddDays($HorizonDays)
# Outlook Restrict needs locale-formatted datetimes in quotes.
$fmt = "g"
$restrict = "[Start] >= '" + $windowStart.ToString($fmt) + "' AND [Start] <= '" + $windowEnd.ToString($fmt) + "'"

$results = New-Object System.Collections.Generic.List[object]
$calendarsSeen = 0

foreach ($store in $namespace.Stores) {
    try {
        $calFolder = $store.GetDefaultFolder(9)   # olFolderCalendar = 9
    } catch {
        Write-Warning "store '$($store.DisplayName)' has no calendar folder; skipping."
        continue
    }
    $calendarsSeen++
    $label = Resolve-Label $deviceLabels $store.DisplayName

    $items = $calFolder.Items
    # --- ORDER MATTERS (see .DESCRIPTION) ---
    $items.Sort("[Start]")                 # 1. sort first
    $items.IncludeRecurrences = $true      # 2. then expand recurrences
    $restricted = $items.Restrict($restrict)   # 3. then window-filter

    foreach ($appt in $restricted) {
        $status = $BusyStatusMap[[int]$appt.BusyStatus]
        if ($null -eq $status) { continue }   # drop free
        # StartUTC / EndUTC are provided by Outlook already in UTC.
        $startUtc = $appt.StartUTC.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss+00:00")
        $endUtc = $appt.EndUTC.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss+00:00")
        $results.Add([ordered]@{
            source = $label
            start  = $startUtc
            end    = $endUtc
            status = $status
        })
    }
}

if ($calendarsSeen -eq 0) {
    Fail "no calendar folders found in any Outlook store. Refusing to publish an empty feed (likely a profile/permission problem)."
}

$json = $results | ConvertTo-Json -Depth 4
if ($results.Count -eq 0) {
    # An empty array is valid but suspicious; warn loudly, still allow upload.
    Write-Warning "0 busy events in the next $HorizonDays days. Verify this is correct."
    $json = "[]"
}

if ($DryRun) {
    Write-Output $json
    Write-Output ""
    Write-Output "# DRY RUN: parsed $($results.Count) busy interval(s) from $calendarsSeen calendar(s). Nothing uploaded."
    exit 0
}

# Upload the JSON. The URL must be write-scoped to this object path only.
# Azure Blob needs x-ms-blob-type; an R2/S3 presigned PUT must NOT receive an
# unsigned header that could break its signature, so add it only for Azure.
try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $headers = @{ "Content-Type" = "application/json" }
    if ($SasUrl -match "blob\.core\.windows\.net") { $headers["x-ms-blob-type"] = "BlockBlob" }
    # Cloudflare Worker upload endpoint authenticates with a Bearer token.
    if (-not [string]::IsNullOrWhiteSpace($Token)) { $headers["Authorization"] = "Bearer $Token" }
    Invoke-RestMethod -Uri $SasUrl -Method Put -Headers $headers -Body $bytes | Out-Null
    Write-Output "Uploaded $($results.Count) busy interval(s)."
} catch {
    Fail "upload failed: $_"
}
