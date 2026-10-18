import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { RULES_DIGEST } from "../core/context.ts";
import { parseDoc } from "../core/frontmatter.ts";
import { operatorDefinition } from "../managed/agents.ts";
import { extractRefs } from "./data.ts";
import { PROCESS, type Block } from "./process.ts";

/**
 * "The brain": every file that shapes what the agents do, and per process block the context it gets.
 * Engine files come from this repo; your knowledge from the workspace. Which block reads which file is derived from
 * the skill and agent text (the same references the agents follow), not listed by hand.
 */

const ENGINE = join(import.meta.dir, "../..");
export type Layer = "knowledge" | "method" | "template" | "playbook" | "agent";
export interface BrainFile {
  id: string; // "engine:references/rules.md" | "workspace:icps/x/icp.md" | "virtual:operator"
  scope: "engine" | "workspace" | "virtual";
  path: string;
  layer: Layer;
  title: string;
  summary: string;
  tokens: number;
  modified: string | null;
  used_by: string[]; // block ids
}
export type Category = "instructions" | "playbook" | "method" | "knowledge" | "data";
export interface ContextItem { id: string; label: string; category: Category; tokens: number; note?: string }
export interface ResolvedBlock extends Block { context: ContextItem[]; tokens: Record<Category, number> }
export interface Brain { files: BrainFile[]; steps: (Omit<(typeof PROCESS)[number], "blocks"> & { blocks: ResolvedBlock[] })[]; workspace: string | null }

const tok = (s: string) => Math.round(s.length / 4);
const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");

function listFiles(root: string, dir: string, ok: (f: string) => boolean): string[] {
  const full = join(root, dir);
  if (!existsSync(full)) return [];
  const out: string[] = [];
  for (const e of readdirSync(full, { withFileTypes: true })) {
    const rel = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(root, rel, ok));
    else if (ok(rel)) out.push(rel);
  }
  return out;
}

function gitDate(root: string, rel: string): string | null {
  const r = Bun.spawnSync(["git", "-C", root, "log", "-1", "--format=%cs", "--", rel]);
  const d = r.stdout.toString().trim();
  return d || (existsSync(join(root, rel)) ? statSync(join(root, rel)).mtime.toISOString().slice(0, 10) : null);
}

function titleOf(text: string, fallback: string): { title: string; summary: string } {
  const doc = (() => { try { return parseDoc<{ name?: string; description?: string }>(text); } catch { return { data: {}, body: text }; } })();
  const h = doc.body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const desc = (doc.data as { description?: string }).description;
  const para = doc.body.replace(/^#.*$/gm, "").split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !p.startsWith("|") && !p.startsWith("```"));
  return { title: h ?? fallback, summary: (desc ?? para ?? "").replace(/\s+/g, " ").slice(0, 220) };
}

/** Workspace pattern (icps/<icp>/scoring.yaml, icps/*\/icp.md) → regex over relative paths. */
const patternRe = (p: string) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/<[^>]+>|\*/g, "[^/]+")}$`);

export function newestMatch(workspace: string, pattern: string): string | null {
  const re = patternRe(pattern);
  const top = pattern.split("/")[0]!;
  let best: { rel: string; m: number } | null = null;
  for (const rel of listFiles(workspace, top, (f) => re.test(f))) {
    const m = statSync(join(workspace, rel)).mtimeMs;
    if (!best || m > best.m) best = { rel, m };
  }
  return best?.rel ?? null;
}

export function buildBrain(workspace?: string | null): Brain {
  const files: BrainFile[] = [];
  const add = (scope: BrainFile["scope"], root: string, rel: string, layer: Layer, text = read(join(root, rel))) => {
    const { title, summary } = titleOf(text, rel.split("/").pop()!);
    files.push({ id: `${scope}:${rel}`, scope, path: rel, layer, title, summary, tokens: tok(text), modified: scope === "virtual" ? null : gitDate(root, rel), used_by: [] });
  };
  // engine: method, templates, playbooks, agents
  for (const rel of listFiles(ENGINE, "references", (f) => f.endsWith(".md"))) add("engine", ENGINE, rel, "method");
  for (const rel of listFiles(ENGINE, "methodology", (f) => f.endsWith(".md") && !f.endsWith("README.md"))) add("engine", ENGINE, rel, "method");
  for (const rel of listFiles(ENGINE, "templates", () => true)) add("engine", ENGINE, rel, "template");
  for (const rel of listFiles(ENGINE, "skills", (f) => f.endsWith("SKILL.md"))) add("engine", ENGINE, rel, "playbook");
  for (const rel of listFiles(ENGINE, "agents", (f) => f.endsWith(".md"))) add("engine", ENGINE, rel, "agent");
  const op = operatorDefinition();
  files.push({ id: "virtual:operator", scope: "virtual", path: "operator (src/managed/agents.ts)", layer: "agent", title: "Coordinator", summary: op.description, tokens: tok(op.system), modified: gitDate(ENGINE, "src/managed/agents.ts"), used_by: [] });
  // your knowledge: what the workspace says about you, your market and your lessons
  if (workspace) {
    const keep = (f: string) => /^(ase\.config\.yaml|dnc\.yaml|company\/profile\.md|company\/voice\/[^/]+\.md|icps\/[^/]+\/(icp\.md|scoring\.yaml|calibration\.md)|learnings\/[^/]+\.md)$/.test(f);
    for (const top of ["ase.config.yaml", "dnc.yaml"]) if (existsSync(join(workspace, top))) add("workspace", workspace, top, "knowledge");
    for (const dir of ["company", "icps", "learnings"]) for (const rel of listFiles(workspace, dir, keep)) add("workspace", workspace, rel, "knowledge");
  }
  const byId = new Map(files.map((f) => [f.id, f]));
  const engineFile = (rel: string) => byId.get(`engine:${rel}`);
  const workspaceFiles = (pattern: string) => files.filter((f) => f.scope === "workspace" && patternRe(pattern).test(f.path));

  const steps = PROCESS.map((s) => ({
    ...s,
    blocks: s.blocks.map((b): ResolvedBlock => {
      const items = new Map<string, ContextItem>();
      const put = (it: ContextItem, fileId?: string) => {
        if (items.has(it.id)) return;
        items.set(it.id, it);
        if (fileId) byId.get(fileId)?.used_by.push(b.id);
      };
      // instructions: the agent's own prompt
      if (b.agent === "operator") put({ id: "virtual:operator", label: "Coordinator instructions", category: "instructions", tokens: byId.get("virtual:operator")!.tokens }, "virtual:operator");
      else if (b.agent) {
        const f = engineFile(`agents/${b.agent}.md`);
        if (f) put({ id: f.id, label: `${f.title} (agent instructions)`, category: "instructions", tokens: f.tokens }, f.id);
      }
      // playbooks, and every document they or the agent point to
      const texts: string[] = [];
      for (const sk of b.skills ?? []) {
        const f = engineFile(`skills/${sk}/SKILL.md`);
        if (!f) continue;
        put({ id: f.id, label: `${sk} playbook`, category: "playbook", tokens: f.tokens }, f.id);
        texts.push(read(join(ENGINE, f.path)));
      }
      if (b.agent && b.agent !== "operator") texts.push(read(join(ENGINE, "agents", `${b.agent}.md`)));
      const refs = texts.map(extractRefs);
      const engineRefs = new Set(refs.flatMap((r) => r.engine));
      const wsRefs = new Set(refs.flatMap((r) => r.workspace));
      // the digest stands in for rules, ICP, factors, learnings and the account's own files
      if (b.uses?.includes("ase-context") || b.uses?.includes("evidence-pack")) {
        put({ id: "digest:rules", label: "Rules (digest)", category: "method", tokens: tok(String(RULES_DIGEST)), note: "a compact version of references/rules.md, built into `ase context`" });
        for (const p of ["icps/*/icp.md", "icps/*/scoring.yaml", "learnings/*.md", "accounts/*/company.md", "accounts/*/brief.md", "accounts/*/signals/*.md", "team/*/warm-matches.yaml"]) wsRefs.add(p);
      }
      if (b.uses?.includes("evidence-pack")) engineRefs.add("references/judging.md");
      for (const rel of engineRefs) {
        const f = engineFile(rel);
        if (f) put({ id: f.id, label: f.title, category: f.layer === "template" ? "playbook" : "method", tokens: f.tokens }, f.id);
      }
      for (const p of wsRefs) {
        const known = workspaceFiles(p);
        if (known.length) for (const f of known) put({ id: f.id, label: f.path, category: "knowledge", tokens: f.tokens }, f.id);
        else {
          // company data: per account, so show the pattern with a real example's size
          const ex = workspace ? newestMatch(workspace, p) : null;
          put({ id: `data:${p}`, label: p, category: "data", tokens: ex ? tok(read(join(workspace!, ex))) : 0, note: ex ? `example: ${ex}` : "no example in the workspace yet" });
        }
      }
      if (b.uses?.includes("web")) put({ id: "runtime:web", label: "Web pages, news and search results", category: "data", tokens: 0, note: "fetched during the run; measured per run in the Runs tab" });
      const context = [...items.values()];
      const tokens = { instructions: 0, playbook: 0, method: 0, knowledge: 0, data: 0 } as Record<Category, number>;
      for (const it of context) tokens[it.category] += it.tokens;
      return { ...b, context, tokens };
    }),
  }));
  return { files, steps, workspace: workspace ?? null };
}

/** Text of a brain file or a workspace example, only for paths the brain knows or account-level outputs. */
export function readBrainFile(brain: Brain, id: string): { id: string; path: string; text: string } | null {
  if (id === "virtual:operator") return { id, path: "operator", text: operatorDefinition().system };
  const f = brain.files.find((x) => x.id === id);
  if (f) return { id, path: f.path, text: read(join(f.scope === "engine" ? ENGINE : brain.workspace!, f.path)) };
  if (id.startsWith("workspace:") && brain.workspace) {
    const rel = id.slice("workspace:".length);
    // outputs under accounts/, lists/, sync/, outcomes/, icps/; never secrets, raw exports or other people's data dumps
    if (!/^(accounts|lists|sync|icps|learnings|people)\/[\w./@-]+\.(md|ya?ml)$/.test(rel) || rel.includes("..")) return null;
    const full = join(brain.workspace, rel);
    if (relative(brain.workspace, full).startsWith("..")) return null;
    return existsSync(full) ? { id, path: rel, text: read(full) } : null;
  }
  return null;
}
