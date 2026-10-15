/**
 * Recognising plan usage limits in a headless session's message stream (Agent SDK or `claude -p --output-format
 * stream-json` — same message shapes). Used to pause instead of failing, and to stop before paid extra usage.
 */

/** Texts Claude Code emits when a usage limit is genuinely reached (mirrors the SDK's USAGE_LIMIT_ERROR_PREFIXES). */
export const USAGE_LIMIT_PREFIXES = [
  "You've hit your", "You've reached your", "You're out of usage credits", "Your org is out of usage",
  "Your seat type doesn't include usage", "Your usage allocation has been disabled", "Your group's usage limit is set to $0",
  "You're out of extra usage", "Claude AI usage limit reached",
];

export interface LimitState {
  /** a usage limit stopped (or would stop) the session */
  limited: boolean;
  /** the session started drawing paid extra usage / overage credits */
  overage: boolean;
  /** epoch ms when the limit resets, if known */
  resetsAt: number | null;
  kind: string | null;
}

export const emptyLimit = (): LimitState => ({ limited: false, overage: false, resetsAt: null, kind: null });

/** Fold one stream message into the limit state. */
export function observeLimit(state: LimitState, m: Record<string, unknown>): LimitState {
  if (m.type === "rate_limit_event") {
    const info = (m.rate_limit_info ?? {}) as { status?: string; resetsAt?: number; rateLimitType?: string; isUsingOverage?: boolean; overageInUse?: boolean };
    if (info.status === "rejected") {
      state.limited = true;
      state.kind = info.rateLimitType ?? state.kind;
      if (info.resetsAt) state.resetsAt = info.resetsAt * (info.resetsAt < 1e12 ? 1000 : 1);
    }
    if (info.isUsingOverage || info.overageInUse) state.overage = true;
  }
  if (m.type === "assistant" && (m as { error?: string }).error === "rate_limit") state.limited = true;
  if (m.type === "result") {
    const text = String((m as { result?: unknown }).result ?? "");
    if (USAGE_LIMIT_PREFIXES.some((p) => text.startsWith(p) || text.includes(p))) {
      state.limited = true;
      // legacy format: "Claude AI usage limit reached|1760540400"
      const ts = /\|(\d{10,13})\b/.exec(text)?.[1];
      if (ts && !state.resetsAt) state.resetsAt = Number(ts) * (ts.length === 10 ? 1000 : 1);
    }
  }
  return state;
}

/** How long to wait before retrying: until the reset (plus a minute), or a backoff when the reset is unknown. */
export function waitMs(state: LimitState, attempt: number, now = Date.now()): number {
  if (state.resetsAt) return Math.max(60_000, state.resetsAt - now + 60_000);
  return [5, 15, 30, 60][Math.min(attempt, 3)]! * 60_000;
}
