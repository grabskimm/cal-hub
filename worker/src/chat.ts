/**
 * Natural-language chat booker (POST /chat). HYBRID design for reliability on a
 * smaller model: Workers AI (Llama 3.3 70B) does ONLY the language understanding
 * — it maps the conversation to a structured ACTION — and the Worker
 * deterministically computes/validates the slots and books through the existing
 * scheduling path. The model never invents a time and never bypasses the
 * server-side slot re-validation, so it can't cause a bad booking.
 *
 * Gated by config: disabled unless the AI binding is present.
 */
import { type Busy, type Slot, computeSlots, type SlotParams } from './slots';

export interface AiBinding {
  run(model: string, input: Record<string, unknown>): Promise<{ response?: string } | string>;
}
export interface ChatEnv {
  AI?: AiBinding;
  CHAT_MODEL?: string;
}

export const CHAT_MODEL_DEFAULT = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

export function chatEnabled(env: { AI?: unknown }): boolean {
  return Boolean(env.AI);
}

export interface ChatMessage { role: 'user' | 'assistant'; content: string }

/** The structured action the model must emit; the Worker acts on it. */
export interface ChatAction {
  kind: 'propose' | 'book' | 'reply';
  reply?: string; // assistant text to show (for 'reply', and as a preamble)
  // --- 'propose' preferences (the Worker computes the real slots) ---
  durationMin?: number;
  fromDate?: string; // YYYY-MM-DD
  toDate?: string; // YYYY-MM-DD
  partOfDay?: 'morning' | 'afternoon' | 'evening' | 'any';
  days?: number[]; // preferred weekdays 0=Sun..6=Sat
  // --- 'book' selection (pickIndex into the last proposed list) + details ---
  pickIndex?: number; // 1-based
  email?: string;
  name?: string;
  meeting?: 'teams' | 'zoom' | 'phone' | 'none';
}

const PART_BOUNDS: Record<string, [number, number]> = {
  morning: [5, 12],
  afternoon: [12, 17],
  evening: [17, 22],
};

/** Local hour-of-day (0–23) of a UTC instant in tz. */
export function localHour(iso: string, tz: string): number {
  const h = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: tz }).format(new Date(iso));
  return Number(h) % 24;
}

/** Filter + cap the computed slots by the model's preferences (pure). */
export function rankSlots(
  slots: Slot[],
  prefs: { partOfDay?: string; days?: number[]; exclude?: Set<string> },
  tz: string,
  max = 3,
): Slot[] {
  const bounds = prefs.partOfDay && prefs.partOfDay !== 'any' ? PART_BOUNDS[prefs.partOfDay] : null;
  const days = prefs.days && prefs.days.length ? new Set(prefs.days) : null;
  const out: Slot[] = [];
  for (const s of slots) {
    // Skip already-shown slots so "give me more times" returns fresh options.
    if (prefs.exclude && prefs.exclude.has(s.start)) continue;
    if (bounds) {
      const h = localHour(s.start, tz);
      if (h < bounds[0] || h >= bounds[1]) continue;
    }
    if (days) {
      const wd = new Date(s.start).getUTCDay(); // good enough for day-of-week pref
      if (!days.has(wd)) continue;
    }
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/** Extract the first JSON object from the model's text and validate it (pure). */
export function parseAction(text: unknown): ChatAction {
  let obj: Record<string, unknown> = {};
  // The model output should be a string, but the AI binding can hand back a
  // non-string (e.g. an already-parsed object); coerce so .match never throws.
  const s = typeof text === 'string' ? text : text == null ? '' : JSON.stringify(text);
  const m = s.match(/\{[\s\S]*\}/);
  if (m) {
    try { obj = JSON.parse(m[0]) as Record<string, unknown>; } catch { obj = {}; }
  }
  const kind = obj.kind === 'propose' || obj.kind === 'book' ? obj.kind : 'reply';
  const action: ChatAction = { kind };
  if (typeof obj.reply === 'string') action.reply = obj.reply.slice(0, 600);
  if (typeof obj.durationMin === 'number') action.durationMin = obj.durationMin;
  if (typeof obj.fromDate === 'string') action.fromDate = obj.fromDate.slice(0, 10);
  if (typeof obj.toDate === 'string') action.toDate = obj.toDate.slice(0, 10);
  if (['morning', 'afternoon', 'evening', 'any'].includes(obj.partOfDay as string)) action.partOfDay = obj.partOfDay as ChatAction['partOfDay'];
  if (Array.isArray(obj.days)) action.days = obj.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) as number[];
  if (Number.isInteger(obj.pickIndex)) action.pickIndex = obj.pickIndex as number;
  if (typeof obj.email === 'string') action.email = obj.email.trim().slice(0, 200);
  if (typeof obj.name === 'string') action.name = obj.name.trim().slice(0, 120);
  if (['teams', 'zoom', 'phone', 'none'].includes(obj.meeting as string)) action.meeting = obj.meeting as ChatAction['meeting'];
  return action;
}

/**
 * Chat persona, by entry point:
 *  - 'schedule'  — launched from the availability/booking surface: stay focused
 *                  on finding and booking a time.
 *  - 'assistant' — launched from the standalone chat host: a personal assistant
 *                  that can also answer questions about the owner (from `bio`)
 *                  AND still book time.
 */
export type ChatMode = 'schedule' | 'assistant';

/** System prompt: the model's whole job is to emit one JSON ChatAction. */
export function systemPrompt(opts: {
  todayIso: string; ownerName: string; tz: string; durationMin: number;
  proposed?: Slot[]; meetings: string[]; mode?: ChatMode; bio?: string;
}): string {
  const proposedList = (opts.proposed ?? [])
    .map((s, i) => `${i + 1}. ${new Date(s.start).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: opts.tz })}`)
    .join('\n');
  const persona = opts.mode === 'assistant'
    ? [
        `You are ${opts.ownerName}'s friendly personal assistant. You can (a) answer questions about ${opts.ownerName} using the ABOUT section below, and (b) help visitors book time with ${opts.ownerName}.`,
        opts.bio?.trim()
          ? `ABOUT ${opts.ownerName}:\n${opts.bio.trim()}`
          : `You have no detailed bio for ${opts.ownerName}; if asked something you don't know, say so briefly and offer to help schedule.`,
        `Only use the ABOUT section for facts about ${opts.ownerName} — never invent biographical details.`,
      ]
    : [`You are a friendly scheduling assistant for ${opts.ownerName}. Keep the focus on finding and booking a time.`];
  return [
    ...persona,
    `Today is ${opts.todayIso} (${opts.tz}). Default meeting length is ${opts.durationMin} minutes.`,
    `You DO NOT know the real calendar — never state or invent specific available times. Output ONE JSON object (no prose outside it) describing the next action:`,
    `- {"kind":"propose", "partOfDay":"morning|afternoon|evening|any", "days":[1,2], "fromDate":"YYYY-MM-DD","toDate":"YYYY-MM-DD","durationMin":30, "reply":"short friendly sentence"} — when the user wants to find a time. The app fills in the real slots.`,
    `- {"kind":"book", "pickIndex":N, "email":"...","name":"...","meeting":"teams|zoom|phone|none", "reply":"..."} — when the user picks one of the numbered proposed slots and has given an email. pickIndex is 1-based into the proposed list.`,
    `- {"kind":"reply", "reply":"..."} — to answer a question${opts.mode === 'assistant' ? ` about ${opts.ownerName}` : ''}, ask for missing info, or chat.`,
    `If the user asks for MORE, OTHER, or DIFFERENT times (e.g. "give me more times for Monday"), emit another "propose" — the app returns fresh options each time and never repeats one it already showed. Do NOT restate times yourself.`,
    `Meeting options available: ${opts.meetings.join(', ')}. If the user doesn't say, default meeting to "teams".`,
    opts.proposed && opts.proposed.length ? `Currently proposed slots (use pickIndex):\n${proposedList}` : `No slots are proposed yet.`,
    `Always include a brief, warm "reply". Output ONLY the JSON.`,
  ].join('\n');
}

/** Call the model and return its raw text. */
export async function callModel(env: ChatEnv, system: string, history: ChatMessage[]): Promise<string> {
  if (!env.AI) return '';
  const messages = [{ role: 'system', content: system }, ...history.slice(-12)];
  const res = await env.AI.run(env.CHAT_MODEL ?? CHAT_MODEL_DEFAULT, {
    messages,
    max_tokens: 400,
    temperature: 0.2,
  });
  if (typeof res === 'string') return res;
  const r = (res as { response?: unknown })?.response;
  // Most models return { response: "..." }, but some return a structured value;
  // stringify so parseAction can still recover the JSON action from it.
  return typeof r === 'string' ? r : r == null ? '' : JSON.stringify(r);
}

/** Build the SlotParams for the chat's deterministic slot search (mirrors /slots.json). */
export function chatSlotParams(
  base: { tz: string; durationMin: number; workStart: string; workEnd: string; days: number[]; nowMs: number },
  fromDate: string, toDate: string,
): SlotParams {
  return {
    fromDate, toDate, tz: base.tz, durationMin: base.durationMin, stepMin: base.durationMin,
    workStart: base.workStart, workEnd: base.workEnd, days: base.days, nowMs: base.nowMs, maxSlots: 400,
  };
}

/** Compute candidate slots over a date window (re-exported convenience). */
export function findSlots(busy: Busy[], params: SlotParams): Slot[] {
  return computeSlots(busy, params);
}

/** The Worker writes the real proposed times into the reply (never the model). */
export function formatProposedReply(preamble: string, slots: Slot[], tz: string): string {
  if (!slots.length) {
    return (preamble ? preamble + ' ' : '') + "I couldn't find an open time matching that — want to try a different day or part of the day?";
  }
  const lines = slots.map((s, i) =>
    `${i + 1}. ${new Date(s.start).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz })}`,
  );
  const head = preamble || 'Here are a few open times:';
  return `${head}\n${lines.join('\n')}\nReply with the number that works (and your email if you haven't shared it).`;
}
