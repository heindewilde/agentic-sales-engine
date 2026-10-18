#!/usr/bin/env bun
/**
 * Claude Managed Agents runs for the owner's own use (see docs/managed-agents.md).
 *   bun src/managed/cli.ts sync                         agents/*.md + skills/* → versioned agents and skills, the operator
 *   bun src/managed/cli.ts run <skill> [args...] --repo owner/name [--base master] [--cap 5] [--approved-by hein]
 *   bun src/managed/cli.ts reply <session-id> "<answer>"   answer the question a run is waiting on
 *   bun src/managed/cli.ts schedule <skill> [args...] --cron "0 7 * * 1" --repo owner/name [--cap 2]   recurring run
 *   bun src/managed/cli.ts inbox [days]                  finished runs nobody listened to → pull requests; runs waiting on a question
 *   bun src/managed/cli.ts telemetry                     platform traces → Braintrust (needs an Admin key once)
 *   bun src/managed/cli.ts status                        what exists on the platform
 * A run ends as `done` (with a pull request), `question` (answer it with reply) or `failed`.
 */
import { join } from "node:path";
import { parseArgs } from "node:util";
import { connectTelemetry, inbox, managedState, reply, run, schedule, sync } from "./platform.ts";

const ROOT = join(import.meta.dir, "../..");
// everything after the skill name that isn't one of our own flags is passed to the skill as its arguments
const OWN = new Set(["--repo", "--base", "--cap", "--approved-by", "--cron"]);
const argv = process.argv.slice(2);
const own: string[] = [];
const rest: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (OWN.has(argv[i]!)) own.push(argv[i]!, argv[++i] ?? "");
  else rest.push(argv[i]!);
}
const { values: f } = parseArgs({ args: own, options: { repo: { type: "string" }, base: { type: "string" }, cap: { type: "string" }, "approved-by": { type: "string" }, cron: { type: "string" } } });
const [cmd, ...params] = rest;
const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));
const quote = (a: string) => (/^[\w./:@=-]+$/.test(a) ? a : JSON.stringify(a));

try {
  if (cmd === "sync") out(await sync(ROOT));
  else if (cmd === "status") out(managedState());
  else if (cmd === "telemetry") out(await connectTelemetry());
  else if (cmd === "inbox") out((await inbox(Number(params[0] ?? 7), console.error, f.repo)).map((r) => ({ ...r, message: r.message.slice(0, 300) })));
  else if (cmd === "run") {
    const [skill, ...args] = params;
    if (!skill || !f.repo) throw new Error("usage: run <skill> [args...] --repo owner/name");
    const r = await run({ pluginRoot: ROOT, repo: f.repo, baseBranch: f.base ?? "master", skill, args: args.map(quote).join(" "), capUsd: Number(f.cap ?? 5), approvedBy: f["approved-by"] ?? "hein" });
    out(r);
    if (r.status !== "done") process.exitCode = r.status === "question" ? 10 : 2;
  } else if (cmd === "schedule") {
    const [skill, ...args] = params;
    if (!skill || !f.repo || !f.cron) throw new Error('usage: schedule <skill> [args...] --cron "0 7 * * 1" --repo owner/name');
    out(await schedule({ pluginRoot: ROOT, repo: f.repo, baseBranch: f.base ?? "master", skill, args: args.map(quote).join(" "), capUsd: Number(f.cap ?? 2), approvedBy: f["approved-by"] ?? "hein", cron: f.cron }));
  } else if (cmd === "reply") {
    const [session, ...answer] = params;
    if (!session || !answer.length) throw new Error('usage: reply <session-id> "<answer>"');
    const r = await reply(session, answer.join(" "), console.error, f.repo);
    out(r);
    if (r.status !== "done") process.exitCode = r.status === "question" ? 10 : 2;
  } else throw new Error("usage: sync | run <skill> ... | schedule <skill> ... | reply <session> <answer> | inbox [days] | telemetry | status");
} catch (e) {
  console.error(`managed: ${(e as Error).message}`);
  process.exit(1);
}
