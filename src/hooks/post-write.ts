/** PostToolUse(Write|Edit): keep the derived SQLite index in sync with the file that was just written. */
import { resolve } from "node:path";
import { failOpen, readInput } from "./io.ts";

try {
  const input = await readInput();
  const filePath = input.tool_input?.file_path as string | undefined;
  if (!filePath || !filePath.endsWith(".md")) process.exit(0);
  const { findWorkspace, relPath } = await import("../core/workspace.ts");
  const ws = findWorkspace(input.cwd);
  if (!ws) process.exit(0);
  const abs = resolve(input.cwd ?? ws, filePath);
  if (!relPath(ws, abs)) process.exit(0);
  const { openDb, indexFile } = await import("../core/db.ts");
  const db = openDb(ws);
  try {
    await indexFile(db, ws, abs);
  } finally {
    db.close();
  }
} catch (e) {
  failOpen(e);
}
