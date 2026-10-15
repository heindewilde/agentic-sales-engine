import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Provider rate limits shared by every process on this machine (parallel batch sessions each run their own gateway).
 * Adaptive: no limit is applied until the provider answers 429. The limit it reports (or a safe guess) is then kept
 * for a while, and every process paces its requests to it. Paid plans with high limits are never slowed down.
 */

const WINDOW_MS = 60_000;
const LEARNED_FOR_MS = 15 * 60_000;

interface State {
  rpm: number | null;
  learned_at: number;
  sent: number[];
}

export function limiterPath(provider: string, key: string | undefined, dir = tmpdir()): string {
  const id = createHash("sha256").update(`${provider}:${key ?? ""}`).digest("hex").slice(0, 12);
  return join(dir, `ase-ratelimit-${provider}-${id}.json`);
}

function withLock<T>(path: string, fn: () => T): T {
  const lock = `${path}.lock`;
  for (let i = 0; ; i++) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      // a lock left behind by a crashed process expires after 5s
      try {
        if (Date.now() - statSync(lock).mtimeMs > 5000) rmSync(lock, { recursive: true, force: true });
      } catch {}
      if (i > 500) break;
      Bun.sleepSync(10);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function read(path: string): State {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as State;
  } catch {}
  return { rpm: null, learned_at: 0, sent: [] };
}

/** How long to wait before the next request may go out (0 = now); reserves the slot when it is free. */
export function reserve(path: string, now = Date.now()): number {
  return withLock(path, () => {
    const s = read(path);
    if (s.rpm && now - s.learned_at > LEARNED_FOR_MS) s.rpm = null;
    s.sent = s.sent.filter((t) => now - t < WINDOW_MS);
    if (s.rpm && s.sent.length >= s.rpm) {
      const wait = s.sent[s.sent.length - s.rpm]! + WINDOW_MS - now + 50;
      writeFileSync(path, JSON.stringify(s));
      return Math.max(50, wait);
    }
    s.sent.push(now);
    writeFileSync(path, JSON.stringify(s));
    return 0;
  });
}

/** Remember the provider's limit after a 429 ("Consumed (req/min): 13, Remaining (req/min): 0" → 12/min). */
export function learnLimit(path: string, message: string, now = Date.now()): number {
  const consumed = Number(/consumed[^0-9]*(\d+)/i.exec(message)?.[1] ?? 0);
  const rpm = consumed > 1 ? consumed - 1 : 8;
  withLock(path, () => {
    const s = read(path);
    s.rpm = s.rpm ? Math.min(s.rpm, rpm) : rpm;
    s.learned_at = now;
    writeFileSync(path, JSON.stringify(s));
  });
  return rpm;
}

export const isRateLimit = (e: unknown): boolean => {
  const x = e as { status?: number; statusCode?: number; message?: string };
  return x?.status === 429 || x?.statusCode === 429 || /rate limit/i.test(String(x?.message ?? ""));
};

/** Seconds the provider asked us to wait, if it said so. */
export const retryAfterMs = (message: string): number | null => {
  const m = /retry after (\d+)\s*s/i.exec(message) ?? /try again in (\d+)\s*s/i.exec(message);
  return m ? Number(m[1]) * 1000 : null;
};

/** Run one request under the shared limit, retrying 429s (pacing to the learned limit) up to `retries` times. */
export async function limited<T>(path: string, fn: () => Promise<T>, opts: { retries?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {}): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const retries = opts.retries ?? 4;
  for (let attempt = 0; ; attempt++) {
    for (let wait = reserve(path, now()); wait > 0; wait = reserve(path, now())) await sleep(wait);
    try {
      return await fn();
    } catch (e) {
      if (!isRateLimit(e) || attempt >= retries) throw e;
      learnLimit(path, String((e as Error).message ?? ""), now());
      const hinted = retryAfterMs(String((e as Error).message ?? ""));
      if (hinted) await sleep(hinted);
    }
  }
}
