/**
 * MCP (Model Context Protocol) endpoint at POST /mcp on the PUBLIC host.
 *
 * Read-only: it exposes the SAME anonymized availability that token-free
 * /slots.json already serves from public/freebusy.json, so it discloses nothing
 * new and needs no auth. The labeled per-source feed (merged/busy.json) is
 * private-host only and is structurally unreachable from here — this module
 * never names that key, and the route lives inside the public-host branch.
 *
 * Design mirrors chat.ts: the model never invents a time. It picks tool
 * arguments; the Worker deterministically computes slots with computeSlots and
 * re-validates a specific instant with slotIsBookable — the same function POST
 * /book gates on, so an offered time and a bookable time cannot diverge.
 *
 * The tool bodies are pure (args + context in, plain object out) so they unit
 * test without Worker globals, matching the repo's existing test style.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { rankSlots } from './chat';
import {
  type ScheduleConfig,
  type ScheduleEnv,
  bookingSlotParams,
  isoDate,
  narrowDays,
  resolveWindow,
  scheduleConfig,
  utcDateMs,
} from './schedule-config';
import { type Busy, type Slot, computeSlots } from './slots';
import { slotIsBookable } from './scheduling';

// Owner policy, the booking grid and the date helpers live in ./schedule-config
// so /slots.json, /chat, POST /book and this module cannot drift apart. Re-exported
// here because the tools and their tests are written against them.
export type McpEnv = ScheduleEnv;
export { type ScheduleConfig, scheduleConfig, utcDateMs };

export const MCP_SERVER_NAME = 'availcal';
/**
 * Advertised in the initialize response. BUMP THIS whenever the tool set
 * changes: clients cache tools/list, and several key that cache on serverInfo,
 * so a stale version leaves a client showing an old tool set indefinitely even
 * after it re-reads the instructions. 1.1.0 = list_busy_blocks added.
 */
export const MCP_SERVER_VERSION = '1.1.0';
export const MAX_RESULTS_DEFAULT = 10;
export const MAX_RESULTS_CEILING = 50;
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Context a tool body needs. Injected so tests need no Worker globals. */
export interface ToolCtx {
  cfg: ScheduleConfig;
  busy: Busy[];
  nowMs: number;
  /** When the underlying feed was produced, if known. */
  asOf?: string;
  /**
   * Set when the anonymized feed could not be read. Fails CLOSED: the data tools
   * report an error rather than treating "no busy data" as "everything is free".
   */
  dataUnavailable?: boolean;
}

/** True when `tz` is a timezone this runtime actually knows. */
export function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Human-readable instant in `tz`, e.g. "Mon, Sep 14, 7:00 PM GMT+2". */
function display(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(iso));
}

/** Calendar date + weekday of an instant, in the OWNER's business timezone. */
function businessParts(iso: string, tz: string): { date: string; weekday: number } {
  const p: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(new Date(iso))) {
    if (part.type !== 'literal') p[part.type] = part.value;
  }
  const idx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday ?? '');
  return { date: `${p.year}-${p.month}-${p.day}`, weekday: idx };
}

export interface ListArgs {
  from_date?: string;
  to_date?: string;
  part_of_day?: 'any' | 'morning' | 'afternoon' | 'evening';
  weekdays?: number[];
  max_results?: number;
  starting_after_utc?: string;
  display_timezone?: string;
}

/** A tool failure the model can act on (bad args), vs a protocol error. */
export class ToolInputError extends Error {}

/** list_open_slots — the only bookable times, computed server-side. */
export function listOpenSlots(args: ListArgs, ctx: ToolCtx) {
  const { cfg } = ctx;
  // Same window + weekday rules as /slots.json, /chat and POST /book.
  const win = resolveWindow(cfg, args.from_date ?? null, args.to_date ?? null, ctx.nowMs, 7);
  if (!win) throw new ToolInputError('from_date and to_date must be real calendar dates (YYYY-MM-DD).');
  const { fromDate, toDate } = win;

  // Weekdays NARROW the owner's set; they can never widen it.
  const notices: string[] = [];
  const narrowed = narrowDays(cfg, args.weekdays);
  const days = narrowed.days;
  if (narrowed.dropped) {
    notices.push('Some requested weekdays are outside the owner’s bookable days and were ignored.');
  }
  if (args.weekdays?.length && !days.length) {
    notices.push('None of the requested weekdays are bookable; no times can match.');
  }
  if (win.clamped) {
    notices.push(`Requested window exceeded the ${cfg.maxRangeDays}-day limit and was searched only to ${toDate}.`);
  }

  const displayTz = args.display_timezone && validTimezone(args.display_timezone)
    ? args.display_timezone
    : cfg.workTz;
  const displayTzSource = args.display_timezone
    ? (displayTz === args.display_timezone ? 'requested' : 'fallback_business')
    : 'business_default';
  if (displayTzSource === 'fallback_business') {
    notices.push('The requested display timezone was not recognised; times are shown in the business timezone.');
  }

  const limit = Math.min(Math.max(args.max_results ?? MAX_RESULTS_DEFAULT, 1), MAX_RESULTS_CEILING);
  const all: Slot[] = days.length
    ? computeSlots(ctx.busy, { ...bookingSlotParams(cfg, fromDate, toDate, ctx.nowMs), days })
    : [];

  // Cursor is exact and stateless: continue strictly after the given instant.
  const afterMs = args.starting_after_utc ? Date.parse(args.starting_after_utc) : NaN;
  const windowed = Number.isFinite(afterMs)
    ? all.filter((s) => Date.parse(s.start) > afterMs)
    : all;

  // partOfDay is evaluated in the OWNER's timezone (rankSlots -> localHour).
  // `days` is deliberately NOT passed: rankSlots filters weekdays by UTC day,
  // which misclassifies evening slots whose UTC date has already rolled over.
  const part = args.part_of_day && args.part_of_day !== 'any' ? args.part_of_day : undefined;
  const picked = rankSlots(windowed, { partOfDay: part }, cfg.workTz, limit + 1);
  const page = picked.slice(0, limit);
  const truncated = picked.length > limit;

  return {
    business_timezone: cfg.workTz,
    display_timezone: displayTz,
    display_timezone_source: displayTzSource,
    working_hours: {
      start: cfg.workStart,
      end: cfg.workEnd,
      weekdays: cfg.days,
      timezone: cfg.workTz,
      slot_minutes: cfg.slotMinutes,
    },
    query: {
      from_date: fromDate,
      to_date: toDate,
      duration_minutes: cfg.slotMinutes,
      part_of_day: args.part_of_day ?? 'any',
      weekdays: days,
    },
    slots: page.map((s) => {
      const bp = businessParts(s.start, cfg.workTz);
      return {
        start_utc: s.start,
        end_utc: s.end,
        start_display: display(s.start, displayTz),
        end_display: display(s.end, displayTz),
        business_date: bp.date,
        business_weekday: bp.weekday,
      };
    }),
    returned: page.length,
    truncated,
    next_cursor: truncated && page.length ? page[page.length - 1].start : null,
    availability_as_of_utc: ctx.asOf ?? null,
    notices,
  };
}

export interface BusyArgs {
  from_date?: string;
  to_date?: string;
  max_results?: number;
  starting_after_utc?: string;
  display_timezone?: string;
}

/**
 * list_busy_blocks — WHEN the owner is occupied, across the full 24 hours.
 *
 * Deliberately NOT filtered by working hours or bookable weekdays: this is the
 * scheduled picture, not the bookable one. That is the same anonymized data the
 * public feed already serves token-free at /freebusy.json (the merge job unions
 * every source with no time-of-day filter), so it discloses nothing new — but it
 * shows only WHEN, never what the meeting is or which calendar it came from:
 * titles, locations and attendees are discarded at ingestion, and source labels
 * are erased by flatten_across_sources before the feed is written.
 *
 * Output fields are constructed explicitly rather than spread, so a label could
 * not ride along even if this were ever pointed at the labeled private feed.
 */
export function listBusyBlocks(args: BusyArgs, ctx: ToolCtx) {
  const { cfg } = ctx;
  const win = resolveWindow(cfg, args.from_date ?? null, args.to_date ?? null, ctx.nowMs, 7);
  if (!win) throw new ToolInputError('from_date and to_date must be real calendar dates (YYYY-MM-DD).');

  const displayTz = args.display_timezone && validTimezone(args.display_timezone)
    ? args.display_timezone
    : cfg.workTz;
  const notices: string[] = [];
  if (args.display_timezone && displayTz !== args.display_timezone) {
    notices.push('The requested display timezone was not recognised; times are shown in the business timezone.');
  }
  if (win.clamped) {
    notices.push(`Requested window exceeded the ${cfg.maxRangeDays}-day limit and was searched only to ${win.toDate}.`);
  }

  // Window bounds as instants: a block counts if it OVERLAPS the window at all,
  // so a meeting spanning midnight into the range is not silently dropped.
  const fromMs = Date.parse(win.fromDate + 'T00:00:00Z');
  const toMs = Date.parse(win.toDate + 'T00:00:00Z') + 86_400_000;
  const afterMs = args.starting_after_utc ? Date.parse(args.starting_after_utc) : NaN;

  const inRange = ctx.busy
    .map((b) => ({ s: Date.parse(b.start), e: Date.parse(b.end) }))
    .filter((b) => Number.isFinite(b.s) && Number.isFinite(b.e) && b.e > b.s)
    .filter((b) => b.s < toMs && b.e > fromMs)
    .filter((b) => (Number.isFinite(afterMs) ? b.s > afterMs : true))
    .sort((a, b) => a.s - b.s);

  const limit = Math.min(Math.max(args.max_results ?? MAX_RESULTS_DEFAULT, 1), MAX_RESULTS_CEILING);
  const page = inRange.slice(0, limit);
  const truncated = inRange.length > limit;

  return {
    business_timezone: cfg.workTz,
    display_timezone: displayTz,
    query: { from_date: win.fromDate, to_date: win.toDate, hours: 'all' as const },
    blocks: page.map((b) => {
      const startIso = new Date(b.s).toISOString();
      const endIso = new Date(b.e).toISOString();
      const bp = businessParts(startIso, cfg.workTz);
      return {
        start_utc: startIso,
        end_utc: endIso,
        start_display: display(startIso, displayTz),
        end_display: display(endIso, displayTz),
        business_date: bp.date,
        business_weekday: bp.weekday,
        minutes: Math.round((b.e - b.s) / 60_000),
      };
    }),
    returned: page.length,
    truncated,
    next_cursor: truncated && page.length ? new Date(page[page.length - 1].s).toISOString() : null,
    availability_as_of_utc: ctx.asOf ?? null,
    notices,
  };
}

export type SlotReason = 'free' | 'busy' | 'outside_working_hours' | 'in_the_past';

/** check_slot_available — re-verify one instant before committing to it. */
export function checkSlotAvailable(
  args: { start_utc: string; display_timezone?: string },
  ctx: ToolCtx,
) {
  const { cfg } = ctx;
  const startMs = Date.parse(args.start_utc);
  if (!Number.isFinite(startMs)) {
    throw new ToolInputError('start_utc must be a UTC ISO-8601 instant, exactly as returned by list_open_slots.');
  }
  const endMs = startMs + cfg.slotMinutes * 60_000;
  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(endMs).toISOString();
  const day = isoDate(startMs);

  const displayTz = args.display_timezone && validTimezone(args.display_timezone)
    ? args.display_timezone
    : cfg.workTz;

  let reason: SlotReason;
  if (startMs < ctx.nowMs) {
    reason = 'in_the_past';
  } else {
    const params = bookingSlotParams(cfg, day, day, ctx.nowMs);
    // Authoritative answer — the SAME guard POST /book applies.
    const bookable = slotIsBookable(ctx.busy, params, startIso, endIso);
    if (bookable) {
      reason = 'free';
    } else {
      // Distinguish "taken" from "never on offer" by re-running with no busy
      // data: if it appears then, the grid allows it and something occupies it.
      const onGrid = computeSlots([], params).some((s) => s.start === startIso);
      reason = onGrid ? 'busy' : 'outside_working_hours';
    }
  }

  return {
    available: reason === 'free',
    reason,
    start_utc: startIso,
    end_utc: endIso,
    start_display: display(startIso, displayTz),
    end_display: display(endIso, displayTz),
    business_timezone: cfg.workTz,
    display_timezone: displayTz,
    availability_as_of_utc: ctx.asOf ?? null,
  };
}

/** get_scheduling_policy — the rules, so the agent never has to guess them. */
export function schedulingPolicy(ctx: ToolCtx) {
  const { cfg } = ctx;
  return {
    owner_name: cfg.ownerName,
    business_timezone: cfg.workTz,
    working_hours: { start: cfg.workStart, end: cfg.workEnd },
    bookable_weekdays: cfg.days,
    bookable_weekday_names: cfg.days.map((d) => WEEKDAY_NAMES[d]),
    meeting_length_minutes: cfg.slotMinutes,
    max_search_window_days: cfg.maxRangeDays,
    earliest_bookable_date: isoDate(ctx.nowMs),
    booking: {
      method: 'web_form',
      url: cfg.bookUrl,
      note: 'A person completes the booking on the web form; this server cannot book, cancel or modify anything.',
    },
    availability_as_of_utc: ctx.asOf ?? null,
  };
}

// --- rendering -------------------------------------------------------------

/** Text block for list_open_slots, derived from the SAME object as the JSON. */
export function renderSlotsText(r: ReturnType<typeof listOpenSlots>): string {
  if (!r.slots.length) {
    const why = r.notices.length ? ' ' + r.notices.join(' ') : '';
    return `No open times between ${r.query.from_date} and ${r.query.to_date}` +
      (r.query.part_of_day !== 'any' ? ` matching ${r.query.part_of_day}` : '') + `.${why}`;
  }
  const lines = r.slots.map((s, i) => `${i + 1}. ${s.start_display} – ${s.end_display}  [${s.start_utc}]`);
  const more = r.truncated && r.next_cursor
    ? `\nMore times exist. Call list_open_slots again with starting_after_utc="${r.next_cursor}".`
    : '';
  const note = r.notices.length ? `\n${r.notices.join(' ')}` : '';
  return [
    `${r.returned} open ${r.query.duration_minutes}-minute time(s).`,
    `Shown in ${r.display_timezone}; the owner's business timezone is ${r.business_timezone}.`,
    '',
    lines.join('\n'),
    more,
    note,
    '',
    'These are the only open times in the searched window — do not offer any other time.',
  ].filter(Boolean).join('\n');
}

/** Text block for list_busy_blocks, derived from the SAME object as the JSON. */
export function renderBusyText(r: ReturnType<typeof listBusyBlocks>): string {
  if (!r.blocks.length) {
    return `Nothing scheduled between ${r.query.from_date} and ${r.query.to_date}.` +
      (r.notices.length ? ' ' + r.notices.join(' ') : '');
  }
  const lines = r.blocks.map((b, i) => `${i + 1}. ${b.start_display} – ${b.end_display} (${b.minutes} min)  [${b.start_utc}]`);
  const more = r.truncated && r.next_cursor
    ? `\nMore blocks exist. Call list_busy_blocks again with starting_after_utc="${r.next_cursor}".`
    : '';
  return [
    `${r.returned} scheduled block(s), across the full day (not limited to working hours).`,
    `Shown in ${r.display_timezone}; the owner's business timezone is ${r.business_timezone}.`,
    '',
    lines.join('\n'),
    more,
    r.notices.length ? r.notices.join(' ') : '',
    '',
    'These are busy periods only — no titles, no participants, and no indication of which calendar each came from.',
  ].filter(Boolean).join('\n');
}

// --- server ----------------------------------------------------------------

// Server-level instructions reach the calling model verbatim, so they steer tool
// choice more strongly than any single tool description. They MUST name both
// views: while these said only "reports when the owner is free", agents reached
// for list_open_slots and never saw anything outside working hours.
const INSTRUCTIONS = [
  'This server is READ-ONLY: it reports the owner’s calendar and cannot book, cancel or modify anything.',
  'It answers two DIFFERENT questions.',
  '(1) list_busy_blocks — the SCHEDULE: when the owner is occupied, across the FULL 24 hours, including evenings, nights and weekends. Use this whenever you are asked what is on the calendar, how busy someone is, or about any time outside working hours.',
  '(2) list_open_slots — BOOKABLE time only: free slots inside the owner’s working hours on bookable weekdays. It cannot see evenings, nights or weekends at all, so it is the wrong tool for "what is scheduled".',
  'A gap in list_busy_blocks is NOT necessarily bookable; only list_open_slots returns bookable times.',
  'All times are UTC instants paired with pre-rendered local strings. Never state, imply or infer a time that did not come back in a tool result.',
  'Before committing to a time in a message or invite, confirm it with check_slot_available.',
  'Working hours and meeting length are the owner’s policy and cannot be changed through this server.',
].join(' ');

const UNAVAILABLE = {
  isError: true as const,
  content: [{
    type: 'text' as const,
    text: 'Availability data is not published yet, so no times can be reported. This is not the same as being free — do not infer availability from it.',
  }],
};

/** Bad tool ARGUMENTS are a tool error the model can fix, not a protocol error. */
function toolError(e: unknown) {
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: e instanceof ToolInputError ? e.message : 'The request could not be processed.' }],
  };
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

/**
 * Build a server for ONE request. `createMcpHandler` is stateless and calls this
 * per request, so nothing here may be shared across requests.
 */
export function createMcpServer(ctx: ToolCtx): McpServer {
  const { cfg } = ctx;
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  const hours = `${cfg.workStart}–${cfg.workEnd}, ${cfg.days.map((d) => WEEKDAY_NAMES[d].slice(0, 3)).join('/')}, ${cfg.workTz}`;

  server.registerTool(
    'list_open_slots',
    {
      title: 'Find open meeting times',
      description:
        `Open meeting times on ${cfg.ownerName}'s calendar. Returns the ONLY times that can be booked: ` +
        `free ${cfg.slotMinutes}-minute slots inside the owner's working hours (${hours}), computed from the live calendar. ` +
        'Every slot has an authoritative UTC instant (start_utc) and a pre-rendered local string (start_display) — ' +
        'quote start_display and use start_utc for any machine handoff. NEVER offer, infer, round or extrapolate a time ' +
        'that is not literally in this result: a time that looks adjacent to an open slot is very likely a meeting. ' +
        'If truncated is true, more times exist — page with starting_after_utc rather than concluding the calendar is empty. ' +
        'Working hours, weekdays and meeting length are set by the owner and cannot be widened; weekdays only narrows.',
      inputSchema: z.object({
        from_date: z.string().optional()
          .describe('First date to search (YYYY-MM-DD), in the owner’s business timezone. Defaults to today; earlier dates are treated as today.'),
        to_date: z.string().optional()
          .describe(`Last date to search, inclusive. Defaults to 7 days out. Clamped to ${cfg.maxRangeDays} days.`),
        part_of_day: z.enum(['any', 'morning', 'afternoon', 'evening']).optional()
          .describe('Narrows by the OWNER’s local clock, not the requester’s: morning 05:00–11:59, afternoon 12:00–16:59, evening 17:00–21:59.'),
        weekdays: z.array(z.number().int().min(0).max(6)).optional()
          .describe('0=Sunday … 6=Saturday. Narrows the owner’s bookable weekdays; values outside that set are ignored, never added.'),
        max_results: z.number().int().min(1).max(MAX_RESULTS_CEILING).optional()
          .describe(`Maximum slots to return (default ${MAX_RESULTS_DEFAULT}, max ${MAX_RESULTS_CEILING}).`),
        starting_after_utc: z.string().optional()
          .describe('Pagination cursor. Pass next_cursor from a previous truncated result; do not construct this yourself.'),
        display_timezone: z.string().optional()
          .describe('IANA name used ONLY to render display strings. It does not change which times are open.'),
      }),
      annotations: READ_ONLY,
    },
    async (args) => {
      if (ctx.dataUnavailable) return UNAVAILABLE;
      try {
        const result = listOpenSlots(args as ListArgs, ctx);
        return {
          content: [{ type: 'text' as const, text: renderSlotsText(result) }],
          structuredContent: result,
        };
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    'check_slot_available',
    {
      title: 'Check one time is still open',
      description:
        'Verify that one specific time is still open before you commit to it in a message, invite or summary. ' +
        'The calendar is re-synced periodically and slots do disappear, so always call this if the times you hold ' +
        'were fetched more than a few minutes ago. Takes a UTC instant that came from list_open_slots.',
      inputSchema: z.object({
        start_utc: z.string()
          .describe('UTC ISO-8601 instant ending in Z, exactly as returned in a slot’s start_utc.'),
        display_timezone: z.string().optional(),
      }),
      annotations: READ_ONLY,
    },
    async (args) => {
      if (ctx.dataUnavailable) return UNAVAILABLE;
      try {
        const r = checkSlotAvailable(args as { start_utc: string; display_timezone?: string }, ctx);
          const text = r.available
          ? `Available. ${r.start_display} (${r.start_utc}) is open.`
          : `Not available (${r.reason}). ${r.start_display} (${r.start_utc}) cannot be booked. ` +
            'Call list_open_slots for current openings.';
        return { content: [{ type: 'text' as const, text }], structuredContent: r };
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    'list_busy_blocks',
    {
      title: 'See what is scheduled',
      description:
        `When ${cfg.ownerName} is occupied, across the FULL 24 hours — not limited to working hours or ` +
        'bookable weekdays, so it includes evenings, nights and weekends. Use this to understand what the ' +
        'schedule actually looks like; use list_open_slots instead when you need a time that can be booked ' +
        '(a gap here is not necessarily bookable — bookable times are only those inside working hours). ' +
        'Returns busy periods ONLY: no titles, no participants, no locations, and no indication of which ' +
        'calendar a block came from — that information is not available to this server. Never infer or ' +
        'invent what a block is about.',
      inputSchema: z.object({
        from_date: z.string().optional()
          .describe('First date (YYYY-MM-DD) in the owner’s business timezone. Defaults to today.'),
        to_date: z.string().optional()
          .describe(`Last date, inclusive. Defaults to 7 days out. Clamped to ${cfg.maxRangeDays} days.`),
        max_results: z.number().int().min(1).max(MAX_RESULTS_CEILING).optional()
          .describe(`Maximum blocks to return (default ${MAX_RESULTS_DEFAULT}, max ${MAX_RESULTS_CEILING}).`),
        starting_after_utc: z.string().optional()
          .describe('Pagination cursor. Pass next_cursor from a previous truncated result.'),
        display_timezone: z.string().optional()
          .describe('IANA name used ONLY to render display strings.'),
      }),
      annotations: READ_ONLY,
    },
    async (args) => {
      if (ctx.dataUnavailable) return UNAVAILABLE;
      try {
        const r = listBusyBlocks(args as BusyArgs, ctx);
        return { content: [{ type: 'text' as const, text: renderBusyText(r) }], structuredContent: r };
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    'get_scheduling_policy',
    {
      title: 'Scheduling rules',
      description:
        `The rules that govern when ${cfg.ownerName} can meet: working hours, business timezone, bookable weekdays, ` +
        'meeting length, how far ahead the calendar can be searched, and where a human completes the booking. ' +
        'Call this when you need to reason about availability in general terms. It reports policy only — ' +
        'it never tells you whether any particular time is open.',
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    async () => {
      const r = schedulingPolicy(ctx);
      return {
        content: [{
          type: 'text' as const,
          text: `${r.owner_name} takes ${r.meeting_length_minutes}-minute meetings ${hours}. ` +
            `Bookings are completed by a person at ${r.booking.url}.`,
        }],
        structuredContent: r,
      };
    },
  );

  return server;
}
