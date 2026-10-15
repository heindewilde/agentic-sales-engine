import YAML from "yaml";

export interface Doc<T = Record<string, unknown>> {
  data: T;
  body: string;
}

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Split a markdown file into YAML frontmatter and body. Files without frontmatter get `{}`. */
export function parseDoc<T = Record<string, unknown>>(text: string): Doc<T> {
  const m = FENCE.exec(text);
  if (!m) return { data: {} as T, body: text };
  const parsed = YAML.parse(m[1] ?? "") ?? {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("frontmatter must be a YAML mapping");
  }
  return { data: parsed as T, body: text.slice(m[0].length) };
}

export function stringifyDoc(data: unknown, body = ""): string {
  const yaml = YAML.stringify(data, { lineWidth: 0 }).trimEnd();
  const rest = body.startsWith("\n") ? body : `\n${body}`;
  return `---\n${yaml}\n---\n${rest}`;
}

export async function readDoc<T = Record<string, unknown>>(path: string): Promise<Doc<T>> {
  return parseDoc<T>(await Bun.file(path).text());
}

export async function writeDoc(path: string, data: unknown, body = ""): Promise<void> {
  await Bun.write(path, stringifyDoc(data, body));
}

export function parseYaml<T = unknown>(text: string): T {
  return YAML.parse(text) as T;
}

export function stringifyYaml(data: unknown): string {
  return YAML.stringify(data, { lineWidth: 0 });
}
