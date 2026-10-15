/**
 * PreToolUse(Write|Edit): the knowledge-base gatekeeper. Computes the file as it would look after the
 * write and denies it when it breaks the workspace contracts — unsourced facts, schema violations,
 * do-not-contact entities, non-business personal data, or edits to immutable raw/ snapshots.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { deny, failOpen, readInput } from "./io.ts";

try {
  const input = await readInput();
  const ti = input.tool_input ?? {};
  const filePath = ti.file_path as string | undefined;
  if (!filePath) process.exit(0);

  const { findWorkspace, relPath, loadConfig, loadDnc, dncMatcher } = await import("../core/workspace.ts");
  const ws = findWorkspace(input.cwd);
  if (!ws) process.exit(0);
  const abs = resolve(input.cwd ?? ws, filePath);
  const rel = relPath(ws, abs);
  if (!rel || rel.startsWith(".ase/") || rel.startsWith(".claude/") || rel.startsWith(".git/")) process.exit(0);

  const exists = existsSync(abs);
  let content: string;
  if (input.tool_name === "Write") {
    content = String(ti.content ?? "");
  } else {
    if (!exists) process.exit(0); // Edit on a missing file fails on its own
    const current = await Bun.file(abs).text();
    const oldS = String(ti.old_string ?? "");
    const newS = String(ti.new_string ?? "");
    if (!oldS || !current.includes(oldS)) process.exit(0); // the Edit tool will report the mismatch itself
    content = ti.replace_all ? current.split(oldS).join(newS) : current.replace(oldS, () => newS);
  }

  const { validateContent } = await import("../core/validate.ts");
  let privacyMode = true;
  try {
    privacyMode = (await loadConfig(ws)).privacy_mode;
  } catch {
    // an invalid config is reported when the config itself is written; default to the safe setting
  }
  const dnc = dncMatcher(await loadDnc(ws).catch(() => ({ entries: [] })));
  const errors = validateContent(rel, content, { privacyMode, dnc, exists });
  if (errors.length) {
    deny(
      `agentic-sales-engine blocked this write to ${rel}:\n${errors.join("\n")}\n\n` +
        "Fix the content and retry. Every fact needs {value, source_url, retrieved_at, confidence}; use level: null / leave a fact out when you have no source.",
    );
  }
} catch (e) {
  failOpen(e);
}
