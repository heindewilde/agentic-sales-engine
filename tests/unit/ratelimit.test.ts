import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { learnLimit, limited, limiterPath, reserve, retryAfterMs } from "../../src/core/providers/ratelimit.ts";

const fresh = () => limiterPath("firecrawl", "k", mkdtempSync(join(tmpdir(), "ase-rl-")));

test("no pacing until the provider says 429; then requests are paced to the learned limit", () => {
  const p = fresh();
  const t0 = 1_000_000;
  for (let i = 0; i < 30; i++) expect(reserve(p, t0 + i)).toBe(0); // unknown limit: never slowed down
  expect(learnLimit(p, "Rate limit exceeded. Consumed (req/min): 13, Remaining (req/min): 0.", t0 + 100)).toBe(12);
  const wait = reserve(p, t0 + 200);
  expect(wait).toBeGreaterThan(50_000); // 30 sent in this minute ≥ 12 → wait for the window
  expect(reserve(p, t0 + 61_000 + 100)).toBe(0); // next minute: free again
  expect(reserve(p, t0 + 16 * 60_000)).toBe(0); // learned limit expires
});

test("429s are retried after pacing; other errors are not", async () => {
  const p = fresh();
  let calls = 0;
  const slept: number[] = [];
  let clock = 5_000_000;
  const r = await limited(
    p,
    async () => {
      if (++calls < 3) throw Object.assign(new Error("Rate limit exceeded. Consumed (req/min): 3, Remaining (req/min): 0. retry after 2s"), { status: 429 });
      return "page";
    },
    { sleep: async (ms) => void (slept.push(ms), (clock += ms)), now: () => clock },
  );
  expect(r).toBe("page");
  expect(calls).toBe(3);
  expect(slept).toContain(2000);
  await expect(limited(fresh(), async () => { throw new Error("HTTP 500"); }, { sleep: async () => {} })).rejects.toThrow("500");
  expect(retryAfterMs("please retry after 17s")).toBe(17_000);
});
