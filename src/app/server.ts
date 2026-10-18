import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import YAML from "yaml";
import * as work from "./api/work.ts";
import { buildBrain, newestMatch, readBrainFile, type Brain } from "./brain.ts";
import { buildModel, type AgentVersion, type MapModel } from "./data.ts";
import { compactDiff, lineDiff } from "./diff.ts";
import { ACTORS } from "./process.ts";
import { Runs, SKILLS, type RunDeps } from "./runs.ts";

/**
 * The sales engine app, bound to localhost: Work (today, accounts, gates, drafts) and System (process, brain).
 * Reads are open to the page; every write is a POST that must carry this server's token from a same-origin page,
 * and every request must be addressed to 127.0.0.1/localhost (no DNS rebinding). Writes go through engine functions.
 */

const ROOT = join(import.meta.dir, "../..");
const UI = join(import.meta.dir, "ui");
// engine documents the app may show: the plugin's own instruction files, nothing else
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

/** Requests must name this machine: a page on another site that resolves its host to 127.0.0.1 is refused. */
export function hostAllowed(host: string | null, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}
/** A write needs this server's token and, when the browser sends one, an Origin of this app. */
export function writeAllowed(req: Request, token: string, port: number): boolean {
  if (req.headers.get("x-ase-token") !== token) return false;
  const origin = req.headers.get("origin");
  return !origin || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

export interface ServeOptions { port?: number; log?: (l: string) => void; workspace?: string; platform?: boolean; runDeps?: RunDeps }

export async function serve(portOrOpts: number | ServeOptions = 4317, log: (l: string) => void = console.error, workspace?: string) {
  const o: ServeOptions = typeof portOrOpts === "number" ? { port: portOrOpts, log, workspace } : portOrOpts;
  const ws = o.workspace;
  const say = o.log ?? console.error;
  const token = randomBytes(24).toString("hex");
  let model: MapModel | null = null;
  let brain: Brain | null = null;
  let building: Promise<MapModel> | null = null;
  // live platform data (agents, runs, schedules); off in tests and when no Managed Agents key is set
  const load = (fresh = false): Promise<MapModel | null> => {
    if (o.platform === false) return Promise.resolve(null);
    if (fresh || (!model && !building)) {
      building = buildModel(say, ws).then((m) => {
        model = m;
        building = null;
        return m;
      }).catch((e) => {
        building = null;
        say(`platform data unavailable: ${(e as Error).message}`);
        return null as unknown as MapModel;
      });
    }
    return model && !fresh ? Promise.resolve(model) : building!;
  };
  load();

  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  const needWs = () => ws ?? (() => { throw new Error("no workspace: start the app with --workspace <dir>"); })();
  const index = () => readFileSync(join(UI, "index.html"), "utf8").replace("__ASE_TOKEN__", token);
  const port = o.port ?? 4317;
  const runs = ws ? new Runs(ws, ROOT, o.runDeps) : null;
  const needRuns = () => runs ?? (() => { throw new Error("no workspace: start the app with --workspace <dir>"); })();
  // finished cloud runs (with their pull requests): asked on demand, cached for a minute
  let cloud: { at: number; data: unknown } | null = null;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    idleTimeout: 255, // a platform refresh reads every run and skill version, longer than the 10 s default
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;
      if (!hostAllowed(req.headers.get("host"), server.port!)) return new Response("forbidden host", { status: 403 });
      const q = (k: string) => url.searchParams.get(k) ?? "";
      try {
        // ---- writes: token + same origin, then an engine function ----
        if (req.method === "POST") {
          if (!writeAllowed(req, token, server.port!)) return json({ error: "forbidden" }, 403);
          const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
          if (p === "/api/refresh") return json(await load(true));
          if (p.startsWith("/api/act/")) return json(await work.act(needWs(), p.slice("/api/act/".length), body));
          if (p === "/api/runs/plan") return json(await needRuns().plan(body as never));
          if (p === "/api/runs/start") return json({ ...needRuns().start(body as never), lines: [] });
          if (p === "/api/cloud/merge") {
            const { mergeRun } = await import("../managed/platform.ts");
            cloud = null;
            return json(await mergeRun(String(body.pr ?? ""), needWs(), say));
          }
          const sa = /^\/api\/schedules\/([\w-]+)\/(pause|unpause|run)$/.exec(p);
          if (sa) {
            const { scheduleAction } = await import("../managed/platform.ts");
            await scheduleAction(sa[1]!, sa[2] as "pause");
            model = null;
            return json({ ok: true });
          }
          return json({ error: "not found" }, 404);
        }
        if (req.method !== "GET") return json({ error: "method not allowed" }, 405);

        // ---- system: process, brain, platform model ----
        if (p === "/api/model") return json(await load());
        if (p === "/api/process") {
          brain = buildBrain(ws); // cheap: local files only, so always fresh
          return json({ steps: brain.steps, files: brain.files, graph: brain.graph, actors: ACTORS, workspace: brain.workspace });
        }
        if (p === "/api/file") {
          const f = readBrainFile(brain ?? (brain = buildBrain(ws)), q("id"));
          if (!f) return json({ error: "not a file the app can show" }, 404);
          let parsed: unknown = null;
          if (/\.ya?ml$/.test(f.path)) try { parsed = YAML.parse(f.text); } catch { /* show raw */ }
          return json({ ...f, parsed });
        }
        if (p === "/api/example") {
          const rel = ws ? newestMatch(ws, q("pattern")) : null;
          const f = rel ? readBrainFile(brain ?? (brain = buildBrain(ws)), `workspace:${rel}`) : null;
          return f ? json(f) : json({ error: "no example in the workspace yet" }, 404);
        }
        if (p === "/api/doc") {
          const d = normalize(q("path"));
          if (!READABLE.some((r) => d.startsWith(r)) || d.includes("..")) return json({ error: "not an engine document" }, 400);
          const f = join(ROOT, d);
          return json({ path: d, text: existsSync(f) ? readFileSync(f, "utf8") : null });
        }
        if (p === "/api/diff") {
          const m = await load();
          if (!m) return json({ error: "platform data unavailable" }, 404);
          const id = q("id");
          const [from, to] = [q("from"), q("to")];
          if (q("kind") === "agent") {
            const ag = m.agents.find((x) => x.key === id);
            const va = ag?.versions.find((v) => String(v.version) === from);
            const vb = ag?.versions.find((v) => String(v.version) === to);
            if (!va || !vb) return json({ error: "version not found" }, 404);
            return json({ config: configChanges(va, vb), lines: compactDiff(lineDiff(va.system, vb.system)) });
          }
          const sk = m.skills.find((x) => x.key === id);
          const a = sk?.versions.find((v) => v.id === from)?.text;
          const b = sk?.versions.find((v) => v.id === to)?.text;
          if (a == null || b == null) return json({ error: "version text not available" }, 404);
          return json({ lines: compactDiff(lineDiff(a, b)) });
        }

        // ---- work: reads ----
        if (p === "/api/today") return json(await work.today(needWs()));
        if (p === "/api/meta") return json(await work.meta(needWs()));
        if (p === "/api/accounts") return json(work.accounts(needWs(), { icp: q("icp"), stage: q("stage"), tier: q("tier"), search: q("q") }));
        if (p === "/api/account") return json(await work.account(needWs(), q("domain")));
        if (p === "/api/icp") return json(await work.icpDoc(needWs(), q("icp")));
        if (p === "/api/shortlist") return json(await work.shortlist(needWs(), q("icp")));
        if (p === "/api/scores") return json(await work.scoresToReview(needWs(), q("icp")));
        if (p === "/api/drafts") return json(await work.drafts(needWs()));
        if (p === "/api/draft") return json(await work.draft(needWs(), q("path")));
        if (p === "/api/outcomes") return json(await work.outcomes(needWs(), q("icp")));
        if (p === "/api/runs") return json({ skills: SKILLS, jobs: needRuns().list(), busy: needRuns().localBusy()?.id ?? null });
        const rm = /^\/api\/runs\/([\w-]+)(\/stream)?$/.exec(p);
        if (rm) {
          if (rm[2]) return needRuns().stream(rm[1]!);
          const j = needRuns().get(rm[1]!);
          return j ? json(j) : json({ error: "no such run" }, 404);
        }
        if (p === "/api/cloud") {
          if (!cloud || Date.now() - cloud.at > 60_000 || q("fresh")) {
            const { inbox } = await import("../managed/platform.ts");
            cloud = { at: Date.now(), data: await inbox(14, say) };
          }
          return json({ runs: cloud.data });
        }
        if (p === "/api/cloud/pr") {
          const { prDetails } = await import("../managed/platform.ts");
          return json(prDetails(q("url")));
        }
        if (p === "/api/schedules") {
          const m = await load();
          return json({ schedules: m?.schedules ?? [] });
        }

        // ---- static ----
        if (p === "/vendor/marked.js") return new Response(Bun.file(join(ROOT, "node_modules/marked/lib/marked.umd.js")));
        const file = normalize(p.slice(1));
        if (/\.(js|css|svg)$/.test(file) && !file.startsWith("..") && existsSync(join(UI, file))) return new Response(Bun.file(join(UI, file)));
        if (p.startsWith("/api/")) return json({ error: "not found" }, 404);
        // every other path is a page of the app
        return new Response(index(), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    },
  });
  const url = `http://127.0.0.1:${server.port}/`;
  say(`sales engine app: ${url}${ws ? ` (workspace ${ws})` : ""}`);
  return { url, port: server.port!, token, stop: () => server.stop(true) };
}
