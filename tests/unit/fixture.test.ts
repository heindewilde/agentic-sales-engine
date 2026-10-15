import { expect, test } from "bun:test";
import { join } from "node:path";
import { lint } from "../../src/core/lint.ts";
import { PLUGIN_ROOT } from "../helpers.ts";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

test("fixture workspace lints clean", async () => {
  const ws = join(mkdtempSync(join(tmpdir(), "ase-fx-")), "ws");
  cpSync(join(PLUGIN_ROOT, "fixtures/workspace-ledgerly"), ws, { recursive: true });
  const issues = await lint(ws);
  expect(issues).toEqual([]);
});
