import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "../../src/core/credentials.ts";
import { makeWorkspace, PLUGIN_ROOT } from "../helpers.ts";

const run = async (args: string[], env: Record<string, string>, stdin = "") => {
  const p = Bun.spawn(["bun", join(PLUGIN_ROOT, "src/cli/ase.ts"), ...args], { stdin: new Blob([stdin]), stdout: "pipe", stderr: "pipe", env: { ...process.env, EXA_API_KEY: "", FIRECRAWL_API_KEY: "", ...env } });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return { json: out.trim() ? JSON.parse(out) : null, code };
};

test("parseEnv handles quotes, export and comments", () => {
  expect(parseEnv('# c\nexport A="x y"\nB=\'z\'\nC = 1\nbad line')).toEqual({ A: "x y", B: "z", C: "1" });
});

test("keys set stores privately (0600), status masks and reports origin, workspace .env wins", async () => {
  const cfg = mkdtempSync(join(tmpdir(), "ase-cfg-"));
  const ws = makeWorkspace();
  const env = { XDG_CONFIG_HOME: cfg };
  const set = await run(["keys", "set", "EXA_API_KEY", "--workspace", ws], env, "exa-secret-1234\n");
  expect(set.json).toMatchObject({ saved: "EXA_API_KEY", value: "…1234" });
  const file = join(cfg, "agentic-sales-engine/credentials.env");
  expect((statSync(file).mode & 0o777).toString(8)).toBe("600");
  expect(readFileSync(file, "utf8")).toContain("EXA_API_KEY=exa-secret-1234");
  await run(["keys", "set", "EXA_API_KEY", "--workspace", ws], env, "exa-secret-5678");
  expect(readFileSync(file, "utf8").match(/EXA_API_KEY=/g)).toHaveLength(1);
  const st = await run(["keys", "status", "--workspace", ws], env);
  expect(st.json.keys.EXA_API_KEY).toEqual({ set: true, value: "…5678", from: file });
  expect(st.json.tier.tier).toBe("T1");
  expect(JSON.stringify(st.json)).not.toContain("exa-secret");
  await Bun.write(join(ws, ".env"), "FIRECRAWL_API_KEY=fc-ws-9999\n");
  const st2 = await run(["keys", "status", "--workspace", ws], env);
  expect(st2.json.keys.FIRECRAWL_API_KEY.from).toBe(join(ws, ".env"));
  expect(st2.json.tier.tier).toBe("T2");
  expect((await run(["keys", "set", "NOPE"], env, "x")).code).toBe(1);
});
