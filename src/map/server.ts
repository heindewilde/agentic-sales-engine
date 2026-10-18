import { existsSync, readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { buildModel, type AgentVersion, type MapModel } from "./data.ts";
import { compactDiff, lineDiff } from "./diff.ts";

/**
 * The agent map as a local web app: read-only, bound to localhost. The model is built once and rebuilt on
 * /api/refresh; finished runs come from the on-disk cache, so a refresh only fetches what's new.
 */

const ROOT = join(import.meta.dir, "../..");
const UI = join(import.meta.dir, "ui");
// engine documents the map may show: the plugin's own instruction files, nothing else
const READABLE = ["references/", "methodology/", "templates/", "skills/", "agents/"];

/** What changed in an agent's configuration besides its prompt: model, tools, subagents, skills and skill versions. */
export function configChanges(a: AgentVersion, b: AgentVersion): string[] {
  const out: string[] = [];
  if (a.model !== b.model) out.push(`model ${a.model} → ${b.model}`);
  const set = (label: string, x: string[], y: string[]) => {
    const add = y.filter((v) => !x.includes(v));
    const del = x.filter((v) => !y.includes(v));
    if (add.length) out.push(`${label} added: ${add.join(", ")}`);
    if (del.length) out.push(`${label} removed: ${del.join(", ")}`);
  };
  set("tools", a.tools, b.tools);
  set("subagents", a.subagents, b.subagents);
  set("skills", a.skills, b.skills);
  const bumped = b.skills.filter((s) => a.skill_versions[s] && a.skill_versions[s] !== b.skill_versions[s]);
  if (bumped.length) out.push(`new skill version: ${bumped.join(", ")}`);
  if (a.system === b.system) out.push("system prompt unchanged");
  return out;
}

export async function serve(port = 4317, log: (l: string) => void = console.error): Promise<string> {
  let model: MapModel | null = null;
  let building: Promise<MapModel> | null = null;
  const load = (fresh = false) => {
    if (fresh || (!model && !building)) {
      building = buildModel(log).then((m) => {
        model = m;
        building = null;
        return m;
      });
    }
    return model && !fresh ? Promise.resolve(model) : building!;
  };
  load();

  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const url = new URL(req.url);
      try {
        if (url.pathname === "/api/model") return json(await load());
        if (url.pathname === "/api/refresh") return json(await load(true));
        if (url.pathname === "/api/doc") {
          const p = normalize(url.searchParams.get("path") ?? "");
          if (!READABLE.some((r) => p.startsWith(r)) || p.includes("..")) return json({ error: "not an engine document" }, 400);
          const f = join(ROOT, p);
          return json({ path: p, text: existsSync(f) ? readFileSync(f, "utf8") : null });
        }
        if (url.pathname === "/api/diff") {
          const m = await load();
          const kind = url.searchParams.get("kind");
          const id = url.searchParams.get("id");
          const [from, to] = [url.searchParams.get("from"), url.searchParams.get("to")];
          let a: string | null | undefined;
          let b: string | null | undefined;
          if (kind === "agent") {
            const ag = m.agents.find((x) => x.key === id);
            const va = ag?.versions.find((v) => String(v.version) === from);
            const vb = ag?.versions.find((v) => String(v.version) === to);
            if (!va || !vb) return json({ error: "version not found" }, 404);
            return json({ config: configChanges(va, vb), lines: compactDiff(lineDiff(va.system, vb.system)) });
          } else {
            const sk = m.skills.find((x) => x.key === id);
            a = sk?.versions.find((v) => v.id === from)?.text;
            b = sk?.versions.find((v) => v.id === to)?.text;
          }
          if (a == null || b == null) return json({ error: "version text not available" }, 404);
          return json({ lines: compactDiff(lineDiff(a, b)) });
        }
        const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        if (file === "vendor/cytoscape.min.js") return new Response(Bun.file(join(ROOT, "node_modules/cytoscape/dist/cytoscape.min.js")));
        if (["index.html", "app.js", "style.css"].includes(file)) return new Response(Bun.file(join(UI, file)));
        return new Response("not found", { status: 404 });
      } catch (e) {
        return json({ error: (e as Error).message }, 500);
      }
    },
  });
  const url = `http://127.0.0.1:${server.port}/`;
  log(`agent map: ${url}`);
  return url;
}
