import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reindexAll } from "../../src/core/db.ts";
import { readDoc } from "../../src/core/frontmatter.ts";
import type { Company } from "../../src/core/schemas.ts";
import { hostAllowed, serve, writeAllowed } from "../../src/app/server.ts";
import { PLUGIN_ROOT } from "../helpers.ts";

const ICP = "ap-automation-midmarket";
let app: Awaited<ReturnType<typeof serve>>;
let ws: string;
let base: string;

beforeAll(async () => {
  ws = join(mkdtempSync(join(tmpdir(), "ase-app-")), "ws");
  cpSync(join(PLUGIN_ROOT, "fixtures/workspace-ledgerly"), ws, { recursive: true });
  await reindexAll(ws);
  app = await serve({ port: 0, workspace: ws, platform: false, log: () => {} });
  base = `http://127.0.0.1:${app.port}`;
});
afterAll(() => app.stop());

// biome-ignore lint: test JSON
type J = any;
const getJ = async (path: string): Promise<J> => (await fetch(`${base}${path}`)).json();
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "x-ase-token": app.token, ...headers }, body: JSON.stringify(body) });

describe("app server security", () => {
  test("only requests addressed to this machine; writes need the token and this origin", () => {
    expect(hostAllowed("127.0.0.1:4317", 4317)).toBe(true);
    expect(hostAllowed("localhost:4317", 4317)).toBe(true);
    expect(hostAllowed("evil.example:4317", 4317)).toBe(false);
    const req = (h: Record<string, string>) => new Request("http://127.0.0.1:4317/api/act/x", { method: "POST", headers: h });
    expect(writeAllowed(req({ "x-ase-token": "t" }), "t", 4317)).toBe(true);
    expect(writeAllowed(req({ "x-ase-token": "t", origin: "http://127.0.0.1:4317" }), "t", 4317)).toBe(true);
    expect(writeAllowed(req({ "x-ase-token": "t", origin: "https://evil.example" }), "t", 4317)).toBe(false);
    expect(writeAllowed(req({ "x-ase-token": "wrong" }), "t", 4317)).toBe(false);
    expect(writeAllowed(req({}), "t", 4317)).toBe(false);
  });

  test("a write without the token or from another site is refused; the page carries the token", async () => {
    expect((await fetch(`${base}/api/act/icp/approve`, { method: "POST", body: "{}" })).status).toBe(403);
    expect((await post("/api/act/icp/approve", { icp: ICP, by: "hein" }, { origin: "https://evil.example" })).status).toBe(403);
    const page = await (await fetch(`${base}/today`)).text();
    expect(page).toContain(app.token);
    expect(page).not.toContain("__ASE_TOKEN__");
  });

  test("files outside the engine and workspace are not served", async () => {
    expect((await fetch(`${base}/api/file?id=${encodeURIComponent("workspace:.env")}`)).status).toBe(404);
    expect((await fetch(`${base}/api/doc?path=${encodeURIComponent("../../etc/passwd")}`)).status).toBe(400);
  });
});

describe("app work API", () => {
  test("today, accounts and an account read from the workspace", async () => {
    const t = await getJ("/api/today");
    expect(t.icps.map((i: { slug: string }) => i.slug)).toContain(ICP);
    expect(t.items.some((i: { href: string }) => i.href === `/today/scores/${ICP}`)).toBe(true);
    const list = await getJ(`/api/accounts?icp=${ICP}`);
    expect(list.rows.length).toBeGreaterThan(0);
    const a = await getJ("/api/account?domain=maasverhoeven.example");
    expect(a.company.icp_status[ICP].stage).toBe("scored");
    expect(a.scores[ICP].factors[0].name).toBeTruthy();
    expect((await fetch(`${base}/api/account?domain=${encodeURIComponent("../etc")}`)).status).toBe(400);
  });

  test("a write goes through the engine: reviewing a score records the reviewer", async () => {
    const r: J = await (await post("/api/act/scores/review", { icp: ICP, domains: ["maasverhoeven.example"], by: "sam" })).json();
    expect(r.reviewed).toEqual(["maasverhoeven.example"]);
    const st = (await readDoc<Company>(join(ws, "accounts/maasverhoeven.example/company.md"))).data.icp_status![ICP]!;
    expect(st.reviewed_by).toBe("sam");
    const bad: J = await (await post("/api/act/scores/review", { icp: ICP, domains: ["maasverhoeven.example"], by: "mallory" })).json();
    expect(bad.error).toContain("not a member");
  });
});
