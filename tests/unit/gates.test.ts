import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addDnc, checkDnc, dncKind, listDnc, removeDnc } from "../../src/core/dnc.ts";
import { saveDraft } from "../../src/core/drafts.ts";
import { readDoc, stringifyDoc } from "../../src/core/frontmatter.ts";
import { approveIcp, awaitingReview, reviewScores } from "../../src/core/gates.ts";
import type { Company } from "../../src/core/schemas.ts";
import { PLUGIN_ROOT } from "../helpers.ts";

const ICP = "ap-automation-midmarket";
const fixture = () => {
  const ws = join(mkdtempSync(join(tmpdir(), "ase-gates-")), "ws");
  cpSync(join(PLUGIN_ROOT, "fixtures/workspace-ledgerly"), ws, { recursive: true });
  return ws;
};

describe("gates", () => {
  test("GATE 1: approveIcp records who approved; unknown members are refused", async () => {
    const ws = fixture();
    const p = join(ws, `icps/${ICP}/icp.md`);
    const { data, body } = await readDoc<Record<string, unknown>>(p);
    writeFileSync(p, stringifyDoc({ ...data, status: "draft", approved_by: undefined, approved_at: undefined }, body));
    await expect(approveIcp(ws, ICP, "mallory")).rejects.toThrow("not a member");
    const r = await approveIcp(ws, ICP, "sam");
    expect(r).toMatchObject({ status: "approved", approved_by: "sam", already: false });
    expect((await readDoc<{ status: string; approved_by: string }>(p)).data).toMatchObject({ status: "approved", approved_by: "sam" });
    expect((await approveIcp(ws, ICP, "hein")).already).toBe(true);
  });

  test("GATE 3: reviewScores marks scored accounts reviewed and skips the rest", async () => {
    const ws = fixture();
    const before = await awaitingReview(ws, ICP);
    const r = await reviewScores(ws, ICP, ["maasverhoeven.example", "nope.example"], "hein");
    expect(r.reviewed).toEqual(["maasverhoeven.example"]);
    expect(r.skipped[0]).toMatchObject({ domain: "nope.example" });
    const st = (await readDoc<Company>(join(ws, "accounts/maasverhoeven.example/company.md"))).data.icp_status![ICP]!;
    expect(st.reviewed_by).toBe("hein");
    expect(await awaitingReview(ws, ICP)).not.toContain("maasverhoeven.example");
    expect(before.length).toBeGreaterThanOrEqual((await awaitingReview(ws, ICP)).length);
  });
});

describe("dnc", () => {
  test("add, check, list and remove go through one module; the kind is read from the value", async () => {
    const ws = fixture();
    expect(dncKind("https://www.linkedin.com/in/jane")).toBe("linkedin");
    expect(dncKind("jane@acme.com")).toBe("email");
    expect(dncKind("acme.com")).toBe("domain");
    const a = addDnc(ws, "https://www.Acme-Blocked.example/about", { reason: "opted_out" });
    expect(a.added).toMatchObject({ kind: "domain", value: "acme-blocked.example", reason: "opted_out" });
    expect(addDnc(ws, "acme-blocked.example").existing).toBeTruthy(); // no duplicate
    expect((await checkDnc(ws, "acme-blocked.example")).blocked).toBe(true);
    expect(listDnc(ws).entries.some((e) => (e as { value: string }).value === "acme-blocked.example")).toBe(true);
    expect(removeDnc(ws, "acme-blocked.example").removed).toBe(1);
    expect((await checkDnc(ws, "acme-blocked.example")).blocked).toBe(false);
  });
});

describe("drafts", () => {
  test("saveDraft keeps the engine's original, validates, and marks the draft edited", async () => {
    const ws = fixture();
    const rel = "accounts/maasverhoeven.example/drafts/2026-10-02-sofie-claes-linkedin_connect.md";
    const original = readFileSync(join(ws, rel), "utf8");
    const r = await saveDraft(ws, rel, "Hi Sofie, saw the new Antwerp site.[^1]\n\n[^1]: Brief, import:accounts/maasverhoeven.example/brief.md\n");
    expect(r.status).toBe("edited");
    const orig = join(ws, "accounts/maasverhoeven.example/drafts/.originals/2026-10-02-sofie-claes-linkedin_connect.md");
    expect(existsSync(orig)).toBe(true);
    expect(readFileSync(orig, "utf8")).toBe(original);
    expect(readFileSync(join(ws, rel), "utf8")).toContain("status: edited");
    await expect(saveDraft(ws, "accounts/maasverhoeven.example/brief.md", "x")).rejects.toThrow("not a draft");
  });
});
