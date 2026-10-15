import { afterEach, expect, test } from "bun:test";
import { claudeBilling } from "../../src/core/billing.ts";
import { emptyLimit, observeLimit, waitMs } from "../../src/core/limits.ts";

const KEYS = ["ASE_CLAUDE_BILLING", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
});
const clear = () => KEYS.forEach((k) => delete process.env[k]);

test("billing: subscription unless an API key or cloud provider is configured; explicit setting wins", () => {
  clear();
  expect(claudeBilling()).toBe("subscription");
  process.env.ANTHROPIC_API_KEY = "sk-ant-x";
  expect(claudeBilling()).toBe("api");
  expect(claudeBilling("subscription")).toBe("subscription");
  clear();
  process.env.CLAUDE_CODE_USE_BEDROCK = "1";
  expect(claudeBilling()).toBe("api");
  process.env.ASE_CLAUDE_BILLING = "subscription";
  expect(claudeBilling("api")).toBe("subscription"); // env beats config
});

test("limits: an allowed rate_limit_event is not a limit; a rejected one carries the reset time", () => {
  const s = emptyLimit();
  observeLimit(s, { type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1792099200, rateLimitType: "five_hour" } });
  expect(s.limited).toBe(false);
  observeLimit(s, { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1792099200, rateLimitType: "five_hour" } });
  expect(s).toMatchObject({ limited: true, kind: "five_hour", resetsAt: 1792099200_000 });
});

test("limits: usage-limit result text and paid extra usage are recognised", () => {
  const a = observeLimit(emptyLimit(), { type: "result", subtype: "success", is_error: true, result: "You've hit your session limit · resets 6pm" });
  expect(a.limited).toBe(true);
  const legacy = observeLimit(emptyLimit(), { type: "result", subtype: "success", result: "Claude AI usage limit reached|1792099200" });
  expect(legacy.resetsAt).toBe(1792099200_000);
  const o = observeLimit(emptyLimit(), { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", isUsingOverage: true } });
  expect(o).toMatchObject({ limited: false, overage: true });
  expect(observeLimit(emptyLimit(), { type: "result", subtype: "success", result: "Researched 2 accounts." }).limited).toBe(false);
});

test("limits: wait until the reset plus a minute, or back off when unknown", () => {
  const now = 1_000_000_000_000;
  expect(waitMs({ limited: true, overage: false, resetsAt: now + 3_600_000, kind: null }, 0, now)).toBe(3_660_000);
  expect(waitMs(emptyLimit(), 0, now)).toBe(5 * 60_000);
  expect(waitMs(emptyLimit(), 9, now)).toBe(60 * 60_000);
});
