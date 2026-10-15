import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../../src/core/db.ts";
import { stringifyDoc } from "../../src/core/frontmatter.ts";
import { fact, makeWorkspace, runHook } from "../helpers.ts";

const goodCompany = stringifyDoc({ id: "acme.com", name: "Acme", facts: { employees: fact(120) } });
const badCompany = stringifyDoc({ id: "acme.com", name: "Acme", facts: { employees: { value: 120 } } });

describe("pre-write hook", () => {
  test("allows a valid entity write", async () => {
    const ws = makeWorkspace();
    const r = await runHook("pre-write.ts", { cwd: ws, tool_name: "Write", tool_input: { file_path: join(ws, "accounts/acme.com/company.md"), content: goodCompany } });
    expect(r.code).toBe(0);
    expect(r.json).toBeNull();
  });

  test("denies an unsourced fact with an actionable reason", async () => {
    const ws = makeWorkspace();
    const r = await runHook("pre-write.ts", { cwd: ws, tool_name: "Write", tool_input: { file_path: join(ws, "accounts/acme.com/company.md"), content: badCompany } });
    expect(r.json.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(r.json.hookSpecificOutput.permissionDecisionReason).toContain("source_url");
  });

  test("applies Edit old/new strings before validating", async () => {
    const ws = makeWorkspace({ "accounts/acme.com/company.md": goodCompany });
    const r = await runHook("pre-write.ts", {
      cwd: ws, tool_name: "Edit",
      tool_input: { file_path: "accounts/acme.com/company.md", old_string: "source_url: https://example.com/about", new_string: "source_url: somewhere" },
    });
    expect(r.json.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("denies writes for do-not-contact accounts", async () => {
    const ws = makeWorkspace({ "dnc.yaml": "entries:\n  - kind: domain\n    value: acme.com\n    reason: customer\n" });
    const r = await runHook("pre-write.ts", { cwd: ws, tool_name: "Write", tool_input: { file_path: join(ws, "accounts/acme.com/company.md"), content: goodCompany } });
    expect(r.json.hookSpecificOutput.permissionDecisionReason).toContain("do-not-contact");
  });

  test("raw snapshots are write-once", async () => {
    const ws = makeWorkspace({ "raw/2026-10/abc.md": "original" });
    const r = await runHook("pre-write.ts", { cwd: ws, tool_name: "Write", tool_input: { file_path: join(ws, "raw/2026-10/abc.md"), content: "changed" } });
    expect(r.json.hookSpecificOutput.permissionDecisionReason).toContain("immutable");
  });

  test("is a no-op outside a workspace and for non-entity files", async () => {
    const r1 = await runHook("pre-write.ts", { cwd: "/tmp", tool_name: "Write", tool_input: { file_path: "/tmp/x.md", content: "[^1]" } });
    expect(r1.json).toBeNull();
    const ws = makeWorkspace();
    const r2 = await runHook("pre-write.ts", { cwd: ws, tool_name: "Write", tool_input: { file_path: join(ws, ".claude/settings.json"), content: "{}" } });
    expect(r2.json).toBeNull();
  });
});

describe("post-write hook", () => {
  test("indexes the written file", async () => {
    const ws = makeWorkspace();
    writeFileSync(join(ws, "x.tmp"), "");
    const file = join(ws, "accounts/acme.com/company.md");
    await Bun.write(file, goodCompany);
    const r = await runHook("post-write.ts", { cwd: ws, tool_name: "Write", tool_input: { file_path: file } });
    expect(r.code).toBe(0);
    expect(existsSync(join(ws, ".ase/ase.db"))).toBe(true);
    const db = openDb(ws);
    expect(db.query("SELECT name FROM accounts").get()).toEqual({ name: "Acme" });
    db.close();
  });
});

describe("session-start hook", () => {
  test("briefs inside a workspace, silent outside", async () => {
    const ws = makeWorkspace({ "icps/mm/icp.md": stringifyDoc({ slug: "mm", name: "Mid-market", status: "draft", version: 1 }) });
    const r = await runHook("session-start.ts", { cwd: ws, hook_event_name: "SessionStart" }, { EXA_API_KEY: "", CLAUDE_PLUGIN_OPTION_EXA_API_KEY: "", FIRECRAWL_API_KEY: "", CLAUDE_PLUGIN_OPTION_FIRECRAWL_API_KEY: "" });
    const ctx = r.json.hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain("tier T0");
    expect(ctx).toContain('GATE 1 pending: ICP "mm"');
    const r2 = await runHook("session-start.ts", { cwd: "/tmp" });
    expect(r2.json).toBeNull();
  });
});
