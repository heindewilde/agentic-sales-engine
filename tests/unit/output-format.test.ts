import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ApplyInput } from "../../src/core/apply.ts";
import { BRIEF_SECTIONS, FactorScore, SIGNAL_TYPES } from "../../src/core/schemas.ts";
import { PLUGIN_ROOT } from "../helpers.ts";

const doc = readFileSync(join(PLUGIN_ROOT, "references/output-format.md"), "utf8");

test("the documented apply example is valid against the real schema", () => {
  const json = doc.match(/```json\n([\s\S]*?)\n```/)![1]!;
  const parsed = ApplyInput.parse(JSON.parse(json));
  for (const j of parsed.accounts[0]!.judgements ?? []) expect(FactorScore.safeParse(j).success).toBe(true);
});

test("the doc lists exactly the schema's brief sections and signal types", () => {
  for (const s of BRIEF_SECTIONS.filter((x) => x !== "Open questions" && x !== "Changelog")) expect(doc).toContain(`\`${s}\``);
  const types = doc.match(/`type`: ([a-z_, ]+)\./)![1]!.split(", ");
  expect(types).toEqual([...SIGNAL_TYPES]);
});
