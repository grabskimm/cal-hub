/**
 * One source of truth for the owner's scheduling policy and the slot grid.
 *
 * Four surfaces compute slots — /slots.json, /chat, POST /book and /mcp — and
 * they had each grown their own copy of the env plumbing. That duplication had
 * already drifted (differing default windows, differing maxSlots, a missing
 * to<from guard in the chat clamp), and the dangerous case is the BOOKING GRID:
 * /book re-validates a posted time by recomputing slots, so if any surface
 * offers a time computed on a different grid, the booking is rejected with 409
 * after the visitor has already committed to it. `bookingSlotParams` is that
 * grid, defined once.
 *
 * Pure and env-shaped (no Worker globals beyond the R2 binding in loadPublicBusy),
 * so it unit tests in plain node like the rest of the repo.
 */
import { type Busy, type SlotParams, parseDays } from './slots';

/** The env subset that defines owner scheduling policy. */
export interface ScheduleEnv {
  OWNER_NAME?: string;
  PUBLIC_FEED_HOST?: string;
  SCHEDULE_WORK_TZ?: string;
  AVAILCAL_DEFAULT_TZ?: string;
  SCHEDULE_WORK_START?: string;
  SCHEDULE_WORK_END?: string;
  SCHEDULE_DAYS?: string;
  SCHEDULE_SLOT_MINUTES?: string;
  SCHEDULE_MAX_RANGE_DAYS?: string;
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

export const DAY_MS = 86_400_000;

/**
 * Owner policy from env. Working hours, timezone, weekdays, slot length and the
 * range cap are OWNER-controlled and deliberately have no per-request override:
 * the working-hours window is what keeps out-of-hours time private.
 */
export function scheduleConfig(env: ScheduleEnv): ScheduleConfig {
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

/**
 * THE booking grid. `durationMin === stepMin === slotMinutes` and weekdays come
 * from env alone, so every offered start lands on the same lattice POST /book
 * re-validates against. Any surface that offers a bookable time MUST use this;
 * a surface that computed a different grid would offer times that 409.
 */
export function bookingSlotParams(cfg: ScheduleConfig, fromDate: string, toDate: string, nowMs: number): SlotParams {
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

/** YYYY-MM-DD for a UTC instant. */
export function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Parse YYYY-MM-DD as UTC midnight, or null when it is not a REAL calendar date.
 * Date.parse alone is not enough: it returns NaN for `9999-99-99`, and a NaN
 * bound must reject the request, never silently disable a range clamp.
 */
export function utcDateMs(s: string): number | null {
  const t = s.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  const ms = Date.parse(t + 'T00:00:00Z');
  if (!Number.isFinite(ms)) return null;
  return isoDate(ms) === t ? ms : null;
}

export interface Window {
  fromDate: string;
  toDate: string;
  clamped: boolean;
}

/**
 * Resolve a requested date window against owner policy. Shared so every surface
 * gets the same three guarantees: `from` never scans the past (computeSlots drops
 * those candidates anyway, so it was pure CPU), `to` is never before `from`, and
 * the span is capped at maxRangeDays. Returns null for a calendar-invalid bound
 * so the caller can reject rather than silently widen.
 */
export function resolveWindow(
  cfg: ScheduleConfig,
  rawFrom: string | null | undefined,
  rawTo: string | null | undefined,
  nowMs: number,
  defaultSpanDays: number,
): Window | null {
  const todayMs = utcDateMs(isoDate(nowMs)) as number;
  const parsedFrom = rawFrom == null ? todayMs : utcDateMs(rawFrom);
  if (parsedFrom === null) return null;
  const fromMs = Math.max(parsedFrom, todayMs);
  const parsedTo = rawTo == null ? fromMs + defaultSpanDays * DAY_MS : utcDateMs(rawTo);
  if (parsedTo === null) return null;

  let toMs = parsedTo;
  if (toMs < fromMs) toMs = fromMs;
  let clamped = false;
  if (toMs - fromMs > cfg.maxRangeDays * DAY_MS) {
    toMs = fromMs + cfg.maxRangeDays * DAY_MS;
    clamped = true;
  }
  return { fromDate: isoDate(fromMs), toDate: isoDate(toMs), clamped };
}

/** Weekdays may only NARROW owner policy, never widen it. */
export function narrowDays(cfg: ScheduleConfig, requested: number[] | null | undefined): { days: number[]; dropped: boolean } {
  if (!requested || !requested.length) return { days: cfg.days, dropped: false };
  const days = requested.filter((d) => cfg.days.includes(d));
  return { days, dropped: days.length !== requested.length };
}

export interface BusyLoad {
  ok: boolean;
  busy: Busy[];
  asOf?: string;
}

/**
 * Read the anonymized public feed. FAILS CLOSED: a missing object must not
 * become `busy = []`, which would advertise every working hour as free —
 * reachable whenever the merge job has not run or the public feed is disabled.
 */
export async function loadPublicBusy(
  bucket: { get(key: string): Promise<{ json<T>(): Promise<T>; uploaded?: Date } | null> },
  key: string,
): Promise<BusyLoad> {
  const obj = await bucket.get(key);
  if (!obj) return { ok: false, busy: [] };
  const busy = await obj.json<Busy[]>();
  return { ok: true, busy, asOf: obj.uploaded ? obj.uploaded.toISOString() : undefined };
}
