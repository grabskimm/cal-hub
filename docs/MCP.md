# MCP endpoint (`POST /mcp`)

AvailCal exposes its **read-only** availability to AI agents over the
[Model Context Protocol](https://modelcontextprotocol.io). An agent can ask when
you are free and re-check a specific time; it cannot book, cancel or modify
anything.

- **URL** — `https://<PUBLIC_FEED_HOST>/mcp` (e.g. `https://availability.mendelg.tech/mcp`)
- **Transport** — Streamable HTTP, `POST` only. `GET`/`DELETE` return `405`.
- **Auth** — none. See [Why no auth](#why-no-auth).
- **Enable/disable** — the `MCP_ENABLED` var in `worker/wrangler.jsonc`. Set it
  to `"false"` and redeploy to turn the endpoint off; the route stops matching
  and `/mcp` falls through to `404`. This is the kill switch.

## Connecting

**Claude Code**

```bash
claude mcp add --transport http availcal https://availability.mendelg.tech/mcp
claude mcp list
```

**Claude.ai / Claude Desktop** — Settings → Connectors → Add custom connector,
paste the URL above.

**Raw check** — `tools/list` over plain JSON-RPC:

```bash
curl -sS https://availability.mendelg.tech/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Tools

| Tool | Purpose |
| --- | --- |
| `list_open_slots` | The only bookable times, computed from the live calendar |
| `check_slot_available` | Re-verify one instant before committing to it |
| `get_scheduling_policy` | Working hours, timezone, weekdays, meeting length, booking URL |

`list_open_slots` accepts `from_date`, `to_date`, `part_of_day`, `weekdays`,
`max_results` (default 10, max 50), `starting_after_utc` and `display_timezone`.

**Owner-controlled, and not reachable from any tool argument:** working hours,
business timezone, the bookable weekday set, meeting length, the slot grid, the
maximum search window, and the data source. `weekdays` may only *narrow* the
owner's set — a request for a non-bookable day is dropped and reported in
`notices`, never honoured. This matters: `POST /book` re-validates against env
alone, so a time this server offered outside owner policy would be rejected at
booking time.

### Time semantics

Compute in the **business** timezone, display in the **viewer's**, transport in
**UTC**. Every slot carries an authoritative `start_utc` plus a pre-rendered
`start_display`, so the model never performs timezone arithmetic. `part_of_day`
and working hours are evaluated on the **owner's** clock, not the requester's.

`display_timezone` only affects rendering. An unrecognised zone falls back to the
business timezone and says so via `display_timezone_source` — it is never echoed
back unvalidated.

### Volume

A 62-day window at 30 minutes across weekday working hours is ~880 slots, far too
many for a tool result. Results are paged (`max_results`, `truncated`,
`next_cursor`). `truncated: true` means *more times exist* — not that the
calendar is empty.

## Why no auth

The tools serve exactly the anonymized data that `/slots.json` and
`/freebusy.json` already serve on the same public host, token-free, with
`Access-Control-Allow-Origin: *`. Adding a token would protect nothing while
breaking zero-config connection, which is most of the value. The labeled
per-source feed (`merged/busy.json`) is private-host only and is unreachable from
here: this route lives inside the `PUBLIC_FEED_HOST` branch, and `worker/src/mcp.ts`
never names that key — a test asserts both.

The real exposure here is **compute, not disclosure**, which is why the input
clamps and the `computeSlots` work bounds matter more than a credential would.

### Origin policy: `allowedOriginHostnames: "*"`

The MCP spec makes `Origin` validation a MUST for browser clients, and the SDK
default allows localhost plus the endpoint's own `workers.dev` hostname. We set
`"*"` deliberately:

- A third-party browser client sends **its own** origin (`https://claude.ai`,
  `https://chatgpt.com`), never ours — so allowlisting our hostname would admit
  nobody and no browser client could ever connect.
- Enumerating client origins is unmaintainable and breaks on every new client.
- Origin validation exists to stop DNS rebinding reaching data a browser could
  not otherwise fetch. Here there is none: the endpoint is token-free, read-only
  and anonymized, and everything it returns is already public over CORS.

If the endpoint ever serves labeled data or accepts writes, this decision must be
revisited **before** that lands.

## Booking is deliberately absent

`verifyTurnstile` validates a token a human produced in a browser widget; a
headless agent cannot produce one. `createGraphEvent` writes to the owner's real
mailbox with an attacker-chosen attendee address, which Graph then emails — an
unauthenticated outbound-mail primitive wearing the owner's tenant identity — and
the Worker has no cancellation route. Any future write tool should return a
signed, short-lived hold plus a `/book?hold=` URL that a person opens, keeping
Turnstile where it functions.

## Operational notes

- **Stateless.** No Durable Object, no session state. Safe under
  `wrangler versions deploy` traffic splitting.
- **Fails closed.** If the anonymized feed is missing (merge job not yet run, or
  `AVAILCAL_EMIT_PUBLIC` off) the data tools return `isError` rather than
  reporting an empty calendar as "completely free".
- **Rate limited.** `POST /mcp` is per-IP limited (60 requests/minute) via the
  `MCP_RATE_LIMIT` binding in `wrangler.jsonc`; over-limit requests get a
  JSON-RPC-shaped `429` with `Retry-After`. Cloudflare's limiter is per-location
  and eventually consistent, so treat it as a smoother, not a hard quota — and
  note that agents behind a shared egress proxy share an IP. The hard bounds on
  a single request live in `computeSlots` (`MAX_SCAN_DAYS`, `MAX_CANDIDATES`).
- **Bundle cost.** The SDK takes the Worker from ~62 KiB to ~272 KiB gzipped.
  Well inside the limit, but it is a 4x step — worth remembering when judging
  cold-start CPU.
- **Dual protocol era.** The SDK serves both `2025-11-25` and `2026-07-28`, so
  clients that still open with `initialize` work alongside newer ones.
