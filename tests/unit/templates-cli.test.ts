import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringifyDoc } from "../../src/core/frontmatter.ts";
import { validateContent } from "../../src/core/validate.ts";
import { fact, makeWorkspace, PLUGIN_ROOT } from "../helpers.ts";

const tpl = (f: string) => readFileSync(join(PLUGIN_ROOT, "templates", f), "utf8");

describe("shipped templates are valid", () => {
  test.each([
    ["person.md", "people/jane-doe-1a2b3c.md"],
    ["signal.md", "accounts/example.com/signals/2026-09-30-funding.md"],
    ["icp.md", "icps/my-icp/icp.md"],
    ["scoring.yaml", "icps/my-icp/scoring.yaml"],
  ])("%s", (file, rel) => {
    expect(validateContent(rel, tpl(file), { privacyMode: true })).toEqual([]);
  });
  test("workspace-template config and dnc are valid", () => {
    const ws = join(PLUGIN_ROOT, "workspace-template");
    expect(validateContent("ase.config.yaml", readFileSync(join(ws, "ase.config.yaml"), "utf8"), { privacyMode: true })).toEqual([]);
    expect(validateContent("dnc.yaml", readFileSync(join(ws, "dnc.yaml"), "utf8"), { privacyMode: true })).toEqual([]);
  });
});

async function ase(args: string[], cwd?: string) {
  const p = Bun.spawn(["bun", join(PLUGIN_ROOT, "src/cli/ase.ts"), ...args], {
    cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, CLAUDE_PROJECT_DIR: "", ASE_WORKSPACE: "" },
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  let json: any = null;
  try {
    json = JSON.parse(out);
  } catch {}
  return { out, err, code, json };
}

describe("ase CLI", () => {
  test("init scaffolds a valid workspace", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "ase-init-")), "ws");
    const r = await ase(["init", dir, "--name", "Acme", "--member", "hein:Hein de Wilde", "--member", "sam:Sam"]);
    expect(r.code).toBe(0);
    expect(r.json.config.members.map((m: { id: string }) => m.id)).toEqual(["hein", "sam"]);
    expect(existsSync(join(dir, ".git"))).toBe(true);
    expect(existsSync(join(dir, ".claude/settings.json"))).toBe(true);
    const lint = await ase(["lint"], dir);
    expect(lint.json.count).toBe(0);
    expect((await ase(["init", dir])).code).toBe(1);
  });

  test("validate --stage enforces handoff contracts", async () => {
    const company = (stage: string, extra: Record<string, unknown> = {}) =>
      stringifyDoc({ id: "acme.com", name: "Acme", facts: { employees: fact(120) }, icp_status: { mm: { stage, updated: "2026-10-15", ...extra } } });
    const ws = makeWorkspace({ "accounts/acme.com/company.md": company("shortlisted") });
    const r = await ase(["validate", "--stage", "shortlisted", "--icp", "mm"], ws);
    expect(r.code).toBe(2);
    const errs: string[] = r.json.failures["acme.com"];
    expect(errs.some((e) => e.includes("[light_scored] brief.md is missing"))).toBe(true);
    expect(errs.some((e) => e.includes("approved_by"))).toBe(true);
    const ok = makeWorkspace({ "accounts/acme.com/company.md": company("discovered") });
    expect((await ase(["validate", "--stage", "discovered", "--icp", "mm"], ok)).json.ok).toBe(true);
  });

  test("dnc add normalizes and blocks", async () => {
    const ws = makeWorkspace();
    await ase(["dnc", "add", "domain", "https://www.Acme.com/x", "--reason", "customer"], ws);
    expect((await ase(["dnc", "check", "jane@acme.com"], ws)).json.blocked).toBe(true);
    expect((await ase(["dnc", "check", "other.com"], ws)).json.blocked).toBe(false);
    expect((await ase(["dnc", "add", "domain", "x", "--reason", "nope"], ws)).code).not.toBe(0);
  });

  test("forget-person erases and reports remaining mentions", async () => {
    const ws = makeWorkspace({
      "people/jane-doe.md": stringifyDoc({ id: "jane-doe", name: "Jane Doe", linkedin_url: "https://www.linkedin.com/in/jane-doe", company: "acme.com" }),
      "team/hein/warm-matches.yaml": "matches:\n  - person_id: jane-doe\n    linkedin_url: https://www.linkedin.com/in/jane-doe\n  - person_id: bob\n",
      "raw/2026-10/abc.md": "Team: Jane Doe (CFO), Bob (CTO)",
      "accounts/acme.com/brief.md": "## People map\n- Jane Doe, CFO — economic buyer\n",
    });
    const r = await ase(["forget-person", "jane-doe", "--dnc"], ws);
    expect(r.code).toBe(0);
    expect(existsSync(join(ws, "people/jane-doe.md"))).toBe(false);
    expect(readFileSync(join(ws, "raw/2026-10/abc.md"), "utf8")).toBe("Team: [redacted] (CFO), Bob (CTO)");
    expect(readFileSync(join(ws, "team/hein/warm-matches.yaml"), "utf8")).not.toContain("jane-doe");
    expect(r.json.remainingMentions).toHaveLength(1);
    expect(r.json.remainingMentions[0].path).toBe("accounts/acme.com/brief.md");
    expect((await ase(["dnc", "check", "linkedin.com/in/jane-doe"], ws)).json.blocked).toBe(true);
  });

  test("ledger runs: start, report, extend needs approver, end", async () => {
    const ws = makeWorkspace();
    const start = await ase(["ledger", "run", "start", "--stage", "research", "--budget", "2"], ws);
    expect(start.json.budget_usd).toBe(2);
    expect((await ase(["ledger", "run", "extend", "--budget", "4"], ws)).code).toBe(1);
    expect((await ase(["ledger", "run", "extend", "--budget", "4", "--approved-by", "hein"], ws)).json.budget_usd).toBe(4);
    await ase(["ledger", "record", "exa", "search", "0.25"], ws);
    const rep = await ase(["ledger", "report"], ws);
    expect(rep.json.total_usd).toBe(0.25);
    const end = await ase(["ledger", "run", "end"], ws);
    expect(end.json.spent_usd).toBe(0.25);
  });
});
