import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDoc, stringifyDoc } from "../core/frontmatter.ts";
import { ENGINE_DIR } from "./agents.ts";

/**
 * The plugin's skills (skills/<name>/SKILL.md) as Managed Agents skills. Same instructions; only what differs in the
 * sandbox is rewritten (the plugin root path). The operator's system prompt explains the rest (provider tools via the
 * CLI, no batch.ts, questions as messages), so the skill text stays identical to the plugin's otherwise.
 */

export interface SkillFile {
  name: string;
  content: string;
  hash: string;
}

export function listSkills(pluginRoot: string): string[] {
  return readdirSync(join(pluginRoot, "skills"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
}

export function convertSkill(pluginRoot: string, name: string): SkillFile {
  const doc = parseDoc<{ name?: string; description?: string }>(readFileSync(join(pluginRoot, "skills", name, "SKILL.md"), "utf8"));
  // only name + description: plugin-only frontmatter (allowed-tools, argument-hint) means nothing on the platform
  const content = stringifyDoc({ name, description: doc.data.description ?? name }, doc.body.replaceAll("${CLAUDE_PLUGIN_ROOT}", ENGINE_DIR));
  return { name, content, hash: createHash("sha256").update(content).digest("hex").slice(0, 16) };
}
