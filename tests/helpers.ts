import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const fact = (value: unknown, extra: Record<string, unknown> = {}) => ({
  value,
  source_url: "https://example.com/about",
  retrieved_at: "2026-10-01",
  confidence: 0.8,
  ...extra,
});

export const CONFIG = `workspace:\n  name: Test Co\nmembers:\n  - id: hein\n    name: Hein\nprivacy_mode: true\nbudgets:\n  per_run_usd: 1\n  per_day_usd: 2\n`;

/** Create a throwaway workspace with the given files (path -> content). */
export function makeWorkspace(files: Record<string, string> = {}): string {
  const ws = mkdtempSync(join(tmpdir(), "ase-ws-"));
  const all: Record<string, string> = { "ase.config.yaml": CONFIG, ...files };
  for (const [p, c] of Object.entries(all)) {
    const abs = join(ws, p);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, c);
  }
  return ws;
}

export const PLUGIN_ROOT = join(import.meta.dir, "..");

/** Run a hook script with a JSON event on stdin; returns parsed stdout (or null) and exit code. */
export async function runHook(script: string, event: unknown, env: Record<string, string> = {}) {
  const p = Bun.spawn(["bun", join(PLUGIN_ROOT, "src/hooks", script)], {
    stdin: new Blob([JSON.stringify(event)]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_PROJECT_DIR: "", ASE_WORKSPACE: "", ...env },
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { json: out.trim() ? JSON.parse(out) : null, stderr: err, code };
}
