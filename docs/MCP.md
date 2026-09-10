# MCP endpoint (`POST /mcp`)

AvailCal exposes its **read-only** availability to AI agents over the
[Model Context Protocol](https://modelcontextprotocol.io). An agent can ask when
you are free and re-check a specific time; it cannot book, cancel or modify
anything.

- **URL** — `https://<PUBLIC_FEED_HOST>/mcp` (e.g. `https://availability.mendelg.tech/mcp`)
- **Transport** — Streamable HTTP, `POST` only. `GET`/`DELETE` return `405`.
  `Accept` **must** include `text/event-stream`; `application/json` alone is
  refused with `406` and a JSON-RPC `-32000`. Responses are SSE-framed even for a
  single reply, so strip the `data: ` prefix before parsing.
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
| `list_open_slots` | The only **bookable** times — free slots inside working hours |
| `list_busy_blocks` | What is **scheduled**, across the full 24 hours |
| `check_slot_available` | Re-verify one instant before committing to it |
| `get_scheduling_policy` | Working hours, timezone, weekdays, meeting length, booking URL |

> **If your client shows an old tool set** (e.g. `toolCount: 3`, no
> `list_busy_blocks`) even after reconnecting: clients cache `tools/list`, and
> several key that cache on `serverInfo`. Check which build you are talking to —
> `initialize` should report `{"name":"availcal","version":"1.1.0"}`. If it
> reports `1.0.0`, the client is serving a cached manifest and needs its entry
> removed and re-added (not just refreshed). Verify the server directly with:
>
> ```bash
> # NOTE the sed: responses are SSE-framed ("event: message\ndata: {...}"), so
> # piping straight into jq fails with "Invalid numeric literal at line 1,
> # column 6" — that is jq hitting the ':' in 'event:', NOT a server error.
> curl -sS https://<PUBLIC_FEED_HOST>/mcp \
>   -H 'Content-Type: application/json' \
>   -H 'Accept: application/json, text/event-stream' \
>   -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
>   | sed -n 's/^data: //p' | jq -r '.result.tools[].name'
> ```
>
> And to see which build is answering:
>
> ```bash
> curl -sS https://<PUBLIC_FEED_HOST>/mcp \
>   -H 'Content-Type: application/json' \
>   -H 'Accept: application/json, text/event-stream' \
>   -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}' \
>   | sed -n 's/^data: //p' | jq -c '.result.serverInfo'
> ```
>
> The server version is bumped whenever the tool set changes, for exactly this
> reason.

> **If a client only ever returns working-hours results**, it is calling
> `list_open_slots`. Ask for `list_busy_blocks` by name. The server's own
> instructions now steer agents to the right one; a client that connected before
> that fix may still hold the old instructions until it reconnects.

### Bookable vs scheduled

These answer different questions and must not be confused:

* `list_open_slots` is the **booking** view. It is confined to working hours and
  bookable weekdays, and every start it returns lands on the grid `POST /book`
  re-validates against — so an offered time is always a bookable time.
* `list_busy_blocks` is the **schedule** view. It is deliberately *not* limited to
  working hours or weekdays, so it includes evenings, nights and weekends. A gap
  in it is **not** necessarily bookable.

`list_busy_blocks` returns busy periods only — no titles, no participants, no
locations, and no indication of which calendar a block came from. Titles,
locations and attendees are discarded at ingestion (`normalize.py`), and source
labels are erased by `flatten_across_sources` before the public feed is written.
This is the same anonymized data already served token-free at `/freebusy.json`,
which the merge job builds with no time-of-day filter — so exposing it here adds
no disclosure, only a queryable shape for agents.

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

## Read-only is enforced, not just declared

The MCP surface never writes — that is policy, and it is held in place by tests
(`worker/test/mcp.test.ts`) rather than by good intentions. `src/mcp.ts` is
asserted to contain no write primitive (`.put(`, `.delete(`, `createGraphEvent`,
`graphToken`, the notification senders), to make no outbound `fetch` of its own,
to import only pure computation, and to annotate every tool `readOnlyHint: true` /
`destructiveHint: false`. Adding a write to that module fails CI.

This matters because `readOnlyHint` alone is **advisory** — clients may ignore it,
so it is a UI/consent signal, never a security control. The structural guarantee
is that the module has nothing to write *with*: `slotIsBookable` is a predicate
returning a boolean, not a booking call.

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
