/**
 * Pure free-slot computation for the public scheduling endpoint.
 *
 * Given anonymized busy intervals (UTC) and a request (date range, timezone,
 * slot length, working hours, allowed weekdays), produce the bookable FREE slots
 * as UTC instants. No Worker globals here — only `Intl`/`Date` — so it is unit
 * testable in plain Node, and DST is handled correctly via a tz-offset helper.
 */

export interface Busy {
  start: string; // UTC ISO (…Z)
  end: string; // UTC ISO (…Z)
}

export interface SlotParams {
  fromDate: string; // YYYY-MM-DD (inclusive), interpreted in `tz`
  toDate: string; // YYYY-MM-DD (inclusive)
  tz: string; // IANA, e.g. America/New_York
  durationMin: number; // slot length, real minutes
  stepMin: number; // gap between slot starts (defaults to durationMin)
  workStart: string; // HH:MM local
  workEnd: string; // HH:MM local
  days: number[]; // allowed weekdays, 0=Sun … 6=Sat
  nowMs: number; // current instant; slots starting before this are dropped
  maxSlots: number; // hard cap on returned slots
}

export interface Slot {
  start: string; // UTC ISO
  end: string; // UTC ISO
}

/**
 * `Intl.DateTimeFormat` construction dominates slot computation — it was built
 * twice per candidate slot (once per `tzOffsetMs` probe in `wallTimeToUtcMs`),
 * so a wide window cost seconds of CPU. The formatter depends only on the zone,
 * so cache one per tz. Keys come from owner-controlled env (never a query
 * param), but the map is capped anyway so it can't grow without bound.
 */
const OFFSET_DTF = new Map<string, Intl.DateTimeFormat>();

function offsetFormatter(tz: string): Intl.DateTimeFormat {
  const hit = OFFSET_DTF.get(tz);
  if (hit) return hit;
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  if (OFFSET_DTF.size >= 50) OFFSET_DTF.clear();
  OFFSET_DTF.set(tz, dtf);
  return dtf;
}

/**
 * Offset (ms) such that `localWallClock = utcInstant + offset` for `tz` at the
 * given instant. Uses Intl to read the zone's wall time and diff it against UTC.
 */
export function tzOffsetMs(utcMs: number, tz: string): number {
  const dtf = offsetFormatter(tz);
  const p: Record<string, number> = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  // Intl renders hour 24 for midnight in some engines; normalise to 0.
  const hour = p.hour === 24 ? 0 : p.hour;
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, hour, p.minute, p.second);
  return asUtc - utcMs;
}

/**
 * Convert a wall-clock time in `tz` to a UTC instant (ms). Refines once so DST
 * transitions resolve to the correct offset.
 */
export function wallTimeToUtcMs(
  y: number,
  mo: number,
  d: number,
  hh: number,
  mm: number,
  tz: string,
): number {
  const guess = Date.UTC(y, mo - 1, d, hh, mm);
  const off1 = tzOffsetMs(guess, tz);
  let utc = guess - off1;
  const off2 = tzOffsetMs(utc, tz);
  if (off2 !== off1) utc = guess - off2;
  return utc;
}

// These messages deliberately do NOT echo the offending input. Callers surface
// them verbatim to unauthenticated clients (and, via the chat/agent surfaces,
// into an LLM context), so reflecting caller-supplied text would launder
// attacker-controlled strings into output that reads as trusted tool result.
function parseHHMM(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) throw new Error('invalid time: expected HH:MM');
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error('invalid time: expected HH:MM');
  return h * 60 + min;
}

/**
 * Parse YYYY-MM-DD, rejecting anything that is not a REAL calendar date.
 *
 * The regex alone accepted `9999-99-99`. Upstream, `Date.parse` on that same
 * string returns NaN, which skipped the caller's range clamp entirely — so a
 * single unauthenticated request could drive the day loop for millennia. Both
 * halves are fixed: here we reject, and the caller no longer treats an
 * unparseable bound as "no clamp needed".
 */
function parseDate(s: string): { y: number; mo: number; d: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) throw new Error('invalid date: expected YYYY-MM-DD');
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  // Round-trip through UTC so overflow (month 99, Feb 30, Apr 31) is caught:
  // Date.UTC silently rolls those over into a different date.
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (
    mo < 1 ||
    mo > 12 ||
    d < 1 ||
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== mo - 1 ||
    probe.getUTCDate() !== d
  ) {
    throw new Error('invalid date: not a real calendar date');
  }
  return { y, mo, d };
}

/** Parse "1-5" or "0,1,2" into a sorted unique weekday list. */
export function parseDays(spec: string): number[] {
  const out = new Set<number>();
  for (const tok of spec.split(',').map((t) => t.trim()).filter(Boolean)) {
    const range = /^(\d)-(\d)$/.exec(tok);
    if (range) {
      for (let i = Number(range[1]); i <= Number(range[2]); i++) out.add(i % 7);
    } else if (/^\d$/.test(tok)) {
      out.add(Number(tok) % 7);
    } else {
      throw new Error('invalid days spec: expected e.g. "1-5" or "0,6"');
    }
  }
  return [...out].sort((a, b) => a - b);
}

function overlapsBusy(startMs: number, endMs: number, busy: Array<[number, number]>): boolean {
  for (const [bs, be] of busy) {
    if (startMs < be && endMs > bs) return true;
  }
  return false;
}

/**
 * Hard ceilings on WORK, independent of how many slots come out.
 *
 * `maxSlots` bounds only the OUTPUT: past and busy candidates `continue` before
 * anything is pushed, and an empty `days` set skips the inner loop altogether —
 * so with a far-future `toDate` the day cursor spun on with the slot count
 * stuck at zero. These make the function terminate on adversarial input by
 * construction, whatever the caller did or failed to clamp. Both sit far above
 * any legitimate query (the public handler clamps to ~62 days, ≈20 candidates
 * per day), so real requests never reach them.
 */
const MAX_SCAN_DAYS = 366;
const MAX_CANDIDATES = 100_000;

/** Compute bookable free slots. */
export function computeSlots(busyRaw: Busy[], p: SlotParams): Slot[] {
  const busy: Array<[number, number]> = busyRaw
    .map((b) => [Date.parse(b.start), Date.parse(b.end)] as [number, number])
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s)
    .sort((a, b) => a[0] - b[0]);

  const startMin = parseHHMM(p.workStart);
  const endMin = parseHHMM(p.workEnd);
  const step = Math.max(1, p.stepMin || p.durationMin);
  const durMs = p.durationMin * 60_000;
  const allowed = new Set(p.days);

  const from = parseDate(p.fromDate);
  const to = parseDate(p.toDate);
  // Iterate calendar dates inclusively using a UTC midnight cursor (date-only).
  let cursor = Date.UTC(from.y, from.mo - 1, from.d);
  const last = Date.UTC(to.y, to.mo - 1, to.d);

  const slots: Slot[] = [];
  let daysScanned = 0;
  let candidates = 0;
  while (cursor <= last && slots.length < p.maxSlots && daysScanned < MAX_SCAN_DAYS) {
    daysScanned++;
    const cd = new Date(cursor);
    const y = cd.getUTCFullYear();
    const mo = cd.getUTCMonth() + 1;
    const d = cd.getUTCDate();
    if (allowed.has(cd.getUTCDay())) {
      for (let t = startMin; t + p.durationMin <= endMin; t += step) {
        if (++candidates > MAX_CANDIDATES) return slots;
        const startMs = wallTimeToUtcMs(y, mo, d, Math.floor(t / 60), t % 60, p.tz);
        const endMs = startMs + durMs;
        if (startMs < p.nowMs) continue; // past
        if (overlapsBusy(startMs, endMs, busy)) continue; // busy
        slots.push({
          start: new Date(startMs).toISOString(),
          end: new Date(endMs).toISOString(),
        });
        if (slots.length >= p.maxSlots) break;
      }
    }
    cursor += 86_400_000;
  }
  return slots;
}
