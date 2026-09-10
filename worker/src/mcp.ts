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
import { type Busy, type Slot, computeSlots, parseDays } from './slots';
import { slotIsBookable } from './scheduling';

/** Env subset this module reads. Mirrors the defaults handleSlots applies. */
export interface McpEnv {
  OWNER_NAME?: string;
  PUBLIC_FEED_HOST?: string;
  SCHEDULE_WORK_TZ?: string;
  AVAILCAL_DEFAULT_TZ?: string;
  SCHEDULE_WORK_START?: string;
  SCHEDULE_WORK_END?: string;
  SCHEDULE_DAYS?: string;
  SCHEDULE_SLOT_MINUTES?: string;
  SCHEDULE_MAX_RANGE_DAYS?: string;
  MCP_ENABLED?: string;
}

export interface ScheduleConfig {
  ownerName: string;
  workTz: string;
  workStart: string;
  workEnd: string;
  days: number[];
  slotMinutes: number;
  maxRangeDays: number;
  bookUrl: string;
}

/** Owner policy from env. Deliberately the ONLY source of working hours. */
export function scheduleConfig(env: McpEnv): ScheduleConfig {
  const host = (env.PUBLIC_FEED_HOST ?? '').trim();
  return {
    ownerName: (env.OWNER_NAME ?? '').trim() || 'the owner',
    workTz: env.SCHEDULE_WORK_TZ || env.AVAILCAL_DEFAULT_TZ || 'America/New_York',
    workStart: env.SCHEDULE_WORK_START || '08:00',
    workEnd: env.SCHEDULE_WORK_END || '18:00',
    days: parseDays(env.SCHEDULE_DAYS || '1-5'),
    slotMinutes: Number(env.SCHEDULE_SLOT_MINUTES ?? '30') || 30,
    maxRangeDays: Number(env.SCHEDULE_MAX_RANGE_DAYS ?? '62') || 62,
    bookUrl: host ? `https://${host}/book` : '/book',
  };
}

export const MCP_SERVER_NAME = 'availcal';
export const MAX_RESULTS_DEFAULT = 10;
export const MAX_RESULTS_CEILING = 50;
const DAY_MS = 86_400_000;
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

const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** YYYY-MM-DD as UTC midnight, or null when it is not a real calendar date. */
export function utcDateMs(s: string): number | null {
  const t = s.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  const ms = Date.parse(t + 'T00:00:00Z');
  if (!Number.isFinite(ms)) return null;
  return isoDate(ms) === t ? ms : null;
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

/** The params /book re-validates against; MCP must match it exactly. */
function bookingParams(cfg: ScheduleConfig, fromDate: string, toDate: string, nowMs: number) {
  return {
    fromDate,
    toDate,
    tz: cfg.workTz,
    durationMin: cfg.slotMinutes,
    stepMin: cfg.slotMinutes,
    workStart: cfg.workStart,
    workEnd: cfg.workEnd,
    days: cfg.days,
    nowMs,
    maxSlots: 2000,
  };
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
  const todayMs = utcDateMs(isoDate(ctx.nowMs)) as number;

  const parsedFrom = args.from_date === undefined ? todayMs : utcDateMs(args.from_date);
  if (parsedFrom === null) throw new ToolInputError('from_date must be a real calendar date (YYYY-MM-DD).');
  const parsedTo = args.to_date === undefined ? todayMs + 7 * DAY_MS : utcDateMs(args.to_date);
  if (parsedTo === null) throw new ToolInputError('to_date must be a real calendar date (YYYY-MM-DD).');

  const fromMs = Math.max(parsedFrom, todayMs); // never scan the past
  let toMs = parsedTo;
  if (toMs < fromMs) toMs = fromMs;
  let rangeClamped = false;
  if (toMs - fromMs > cfg.maxRangeDays * DAY_MS) {
    toMs = fromMs + cfg.maxRangeDays * DAY_MS;
    rangeClamped = true;
  }
  const fromDate = isoDate(fromMs);
  const toDate = isoDate(toMs);

  // Weekdays NARROW the owner's set; they can never widen it.
  const notices: string[] = [];
  let days = cfg.days;
  if (args.weekdays && args.weekdays.length) {
    days = args.weekdays.filter((d) => cfg.days.includes(d));
    if (days.length !== args.weekdays.length) {
      notices.push('Some requested weekdays are outside the owner’s bookable days and were ignored.');
    }
    if (!days.length) {
      notices.push('None of the requested weekdays are bookable; no times can match.');
    }
  }
  if (rangeClamped) {
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
    ? computeSlots(ctx.busy, { ...bookingParams(cfg, fromDate, toDate, ctx.nowMs), days })
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
    const params = bookingParams(cfg, day, day, ctx.nowMs);
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

// --- server ----------------------------------------------------------------

const INSTRUCTIONS = [
  'This server reports when the owner is free. It cannot book, cancel or modify anything.',
  'All times it returns are UTC instants paired with pre-rendered local strings.',
  'Never state, imply or infer a meeting time that did not come back in a tool result.',
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
    { name: MCP_SERVER_NAME, version: '1.0.0' },
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
