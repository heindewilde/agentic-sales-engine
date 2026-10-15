/**
 * SessionStart: make sure the plugin's dependencies are installed (the plugin cache ships without
 * node_modules), then give Claude a short workspace briefing: provider tier, spend, funnel state, pending gates.
 * Silent outside a sales-engine workspace.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = process.env.CLAUDE_PLUGIN_ROOT ?? join(import.meta.dir, "..", "..");

try {
  if (!existsSync(join(root, "node_modules", "yaml"))) {
    const p = Bun.spawnSync(["bun", "install", "--frozen-lockfile", "--production"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) {
      process.stderr.write(`[agentic-sales-engine] dependency install failed: ${p.stderr.toString()}\n`);
      process.exit(0);
    }
  }
  const { readInput, context } = await import("./io.ts");
  const input = await readInput();
  const { findWorkspace } = await import("../core/workspace.ts");
  const ws = findWorkspace(input.cwd);
  if (!ws) process.exit(0);
  const { health, formatBrief } = await import("../core/doctor.ts");
  context("SessionStart", formatBrief(await health(ws)));
} catch (e) {
  process.stderr.write(`[agentic-sales-engine] session-start error: ${(e as Error)?.message ?? e}\n`);
  process.exit(0);
}
