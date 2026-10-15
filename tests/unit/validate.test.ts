import { describe, expect, test } from "bun:test";
import { stringifyDoc, stringifyYaml } from "../../src/core/frontmatter.ts";
import { BRIEF_SECTIONS } from "../../src/core/schemas.ts";
import { checkFootnotes, classify, validateContent } from "../../src/core/validate.ts";
import { dncMatcher } from "../../src/core/workspace.ts";
import { fact } from "../helpers.ts";

const opts = { privacyMode: true };

const company = (over: Record<string, unknown> = {}) =>
  stringifyDoc({ id: "acme.com", name: "Acme", facts: { employees: fact(120) }, icp_status: {}, ...over }, "Acme makes widgets.[^1]\n\n[^1]: https://acme.com/about\n");

describe("classify", () => {
  test("recognizes entity paths", () => {
    expect(classify("accounts/acme.com/company.md")).toEqual({ kind: "company", account: "acme.com" });
    expect(classify("accounts/acme.com/scores/mid-market.md")).toEqual({ kind: "score", account: "acme.com", icp: "mid-market" });
    expect(classify("icps/mid-market/scoring.yaml")).toEqual({ kind: "scoring", icp: "mid-market" });
    expect(classify("raw/2026-10/abc.md").kind).toBe("raw");
    expect(classify("README.md").kind).toBe("other");
  });
});

describe("company files", () => {
  test("valid company passes", () => {
    expect(validateContent("accounts/acme.com/company.md", company(), opts)).toEqual([]);
  });
  test("unsourced fact is rejected", () => {
    const bad = company({ facts: { employees: { value: 120 } } });
    const errs = validateContent("accounts/acme.com/company.md", bad, opts);
    expect(errs.join("\n")).toContain("facts.employees.source_url");
  });
  test("non-URL source is rejected, user:/import: refs accepted", () => {
    expect(validateContent("accounts/acme.com/company.md", company({ facts: { x: fact(1, { source_url: "their website" }) } }), opts).length).toBe(1);
    expect(validateContent("accounts/acme.com/company.md", company({ facts: { x: fact(1, { source_url: "user:hein" }) } }), opts)).toEqual([]);
    expect(validateContent("accounts/acme.com/company.md", company({ facts: { x: fact(1, { source_url: "import:imports/seeds/a.csv" }) } }), opts)).toEqual([]);
  });
  test("id must match folder", () => {
    expect(validateContent("accounts/other.com/company.md", company(), opts).join()).toContain("must match the folder");
  });
  test("DNC account cannot be written", () => {
    const dnc = dncMatcher({ entries: [{ kind: "domain", value: "acme.com", reason: "customer" }] });
    expect(validateContent("accounts/acme.com/company.md", company(), { ...opts, dnc }).join()).toContain("do-not-contact");
    expect(validateContent("accounts/acme.com/notes.md", "hi", { ...opts, dnc }).join()).toContain("do-not-contact");
  });
});

describe("footnotes", () => {
  test("undefined and unsourced footnotes are flagged", () => {
    expect(checkFootnotes("Claim.[^1]")).toEqual(["footnote [^1] is used but never defined"]);
    expect(checkFootnotes("Claim.[^a]\n\n[^a]: their about page")[0]).toContain("no source");
    expect(checkFootnotes("Claim.[^a]\n\n[^a]: About page, https://acme.com/about (2026-10-01)")).toEqual([]);
  });
});

describe("brief", () => {
  const body = BRIEF_SECTIONS.map((s) => `## ${s}\n\n_tbd_\n`).join("\n");
  test("complete skeleton passes", () => {
    expect(validateContent("accounts/acme.com/brief.md", stringifyDoc({ account: "acme.com" }, body), opts)).toEqual([]);
  });
  test("missing section is reported", () => {
    const partial = body.replace("## Ways in", "## Something else");
    expect(validateContent("accounts/acme.com/brief.md", stringifyDoc({ account: "acme.com" }, partial), opts).join()).toContain('"## Ways in"');
  });
});

describe("people & privacy", () => {
  const person = (over: Record<string, unknown> = {}) =>
    stringifyDoc({ id: "jane-doe", name: "Jane Doe", linkedin_url: "https://www.linkedin.com/in/jane-doe", company: "acme.com", facts: { title: fact("CFO") }, ...over });
  test("valid person passes", () => {
    expect(validateContent("people/jane-doe.md", person(), opts)).toEqual([]);
  });
  test("special-category / private keys are rejected", () => {
    expect(validateContent("people/jane-doe.md", person({ facts: { title: fact("CFO"), date_of_birth: fact("1980-01-01") } }), opts).join()).toContain("date_of_birth");
  });
  test("personal mailbox rejected in privacy mode only", () => {
    const p = person({ facts: { email: fact("jane@gmail.com") } });
    expect(validateContent("people/jane-doe.md", p, opts).join()).toContain("personal mailbox");
    expect(validateContent("people/jane-doe.md", p, { privacyMode: false })).toEqual([]);
  });
  test("DNC person and person at DNC company rejected", () => {
    const dnc = dncMatcher({ entries: [{ kind: "linkedin", value: "linkedin.com/in/Jane-Doe", reason: "opted_out" }] });
    expect(validateContent("people/jane-doe.md", person(), { ...opts, dnc }).join()).toContain("do-not-contact");
  });
});

describe("raw snapshots", () => {
  test("new snapshot ok, overwrite denied", () => {
    expect(validateContent("raw/2026-10/abc.md", "x", { ...opts, exists: false })).toEqual([]);
    expect(validateContent("raw/2026-10/abc.md", "x", { ...opts, exists: true }).join()).toContain("immutable");
  });
});

describe("scoring.yaml", () => {
  const scoring = {
    icp: "mm",
    version: 1,
    groups: { fit: 0.5, intent: 0.3, access: 0.2 },
    factors: [
      { id: "size", name: "Size", group: "fit", weight: 3, question: "?", levels: { 0: "a", 1: "b", 2: "c", 3: "d" } },
      { id: "trigger", name: "Trigger", group: "intent", weight: 2, question: "?", levels: { 0: "a", 1: "b", 2: "c", 3: "d" } },
      { id: "warm", name: "Warm path", group: "access", weight: 1, question: "?", levels: { 0: "a", 1: "b", 2: "c", 3: "d" } },
    ],
  };
  test("valid model passes", () => {
    expect(validateContent("icps/mm/scoring.yaml", stringifyYaml(scoring), opts)).toEqual([]);
  });
  test("group weights must sum to 1 and groups need factors", () => {
    const bad = { ...scoring, groups: { fit: 0.6, intent: 0.3, access: 0.2 }, factors: scoring.factors.slice(0, 2) };
    const errs = validateContent("icps/mm/scoring.yaml", stringifyYaml(bad), opts).join();
    expect(errs).toContain("sum to 1");
    expect(errs).toContain("group access has weight but no factors");
  });
});

describe("score files", () => {
  const score = (factors: unknown[]) =>
    stringifyDoc({ icp: "mm", account: "acme.com", scoring_version: 1, mode: "full", total: 60, upside: 80, coverage: 0.5, tier: "B", scored_at: "2026-10-15", factors });
  test("a level needs evidence; null level does not", () => {
    expect(validateContent("accounts/acme.com/scores/mm.md", score([{ id: "size", level: null, confidence: 0 }]), opts)).toEqual([]);
    expect(validateContent("accounts/acme.com/scores/mm.md", score([{ id: "size", level: 2, confidence: 0.7 }]), opts).join()).toContain("must cite evidence");
    expect(
      validateContent("accounts/acme.com/scores/mm.md", score([{ id: "size", level: 2, confidence: 0.7, evidence: [{ quote: "120 staff", source_url: "https://acme.com" }] }]), opts),
    ).toEqual([]);
  });

  test("a checked absence backs level 0 only", () => {
    const absent = { quote: "careers page lists no marketing roles — not found", source_url: "https://acme.com/careers", checked: true };
    expect(validateContent("accounts/acme.com/scores/mm.md", score([{ id: "hire", level: 0, confidence: 0.7, evidence: [absent] }]), opts)).toEqual([]);
    expect(validateContent("accounts/acme.com/scores/mm.md", score([{ id: "hire", level: 2, confidence: 0.7, evidence: [absent] }]), opts).join()).toContain("only back level 0");
  });
});

describe("icp", () => {
  test("approved ICP needs approver", () => {
    const icp = stringifyDoc({ slug: "mm", name: "Mid-market", status: "approved", version: 1 });
    expect(validateContent("icps/mm/icp.md", icp, opts).join()).toContain("approved_by");
  });
});
