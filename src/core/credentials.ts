import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Provider keys for CLI and batch runs (inside Claude Code the plugin's keychain-backed userConfig is used).
 * Sources, first wins, never overriding variables already set in the environment:
 *   1. the process environment (incl. a workspace .env, which Bun loads from the current directory)
 *   2. <workspace>/.env, when the CLI runs with --workspace from elsewhere
 *   3. ~/.config/agentic-sales-engine/credentials.env (user-level, chmod 600)
 */
export const KEYS = [
  "EXA_API_KEY", "FIRECRAWL_API_KEY", "FIRECRAWL_BASE_URL",
  // observability backends (see src/observability/backends.ts)
  "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_HOST",
  "LANGSMITH_API_KEY", "LANGSMITH_ENDPOINT", "LANGSMITH_PROJECT",
  "BRAINTRUST_API_KEY", "BRAINTRUST_API_URL", "BRAINTRUST_PROJECT",
  // generic OpenTelemetry endpoint (any OTLP backend)
  "OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_HEADERS",
] as const;

export function credentialsPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "agentic-sales-engine", "credentials.env");
}

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]!] = v;
  }
  return out;
}

/** Load provider keys into process.env without overriding anything already set. Returns where each key came from. */
export function loadCredentials(ws?: string | null): Record<string, string> {
  const origin: Record<string, string> = {};
  for (const k of KEYS) if (process.env[k]) origin[k] = "env";
  const files = [ws ? join(ws, ".env") : null, credentialsPath()].filter((f): f is string => Boolean(f && existsSync(f)));
  for (const f of files) {
    const vars = parseEnv(readFileSync(f, "utf8"));
    for (const k of KEYS) {
      if (!process.env[k] && vars[k]) {
        process.env[k] = vars[k];
        origin[k] = f;
      }
    }
  }
  return origin;
}

/** Read known keys from the user-level file without touching process.env (for components that only need to look). */
export function credentialFileValues(): Record<string, string> {
  const p = credentialsPath();
  if (!existsSync(p)) return {};
  const vars = parseEnv(readFileSync(p, "utf8"));
  return Object.fromEntries(KEYS.filter((k) => vars[k]).map((k) => [k, vars[k]!]));
}

/** Store (or replace) one key in the user-level credentials file, kept private (0600). */
export function saveCredential(key: (typeof KEYS)[number], value: string): string {
  const p = credentialsPath();
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  const existing = existsSync(p) ? readFileSync(p, "utf8") : "# agentic-sales-engine provider keys (CLI / batch runs). Keep private.\n";
  const lines = existing.split(/\r?\n/).filter((l) => !new RegExp(`^(export\\s+)?${key}\\s*=`).test(l.trim()));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  lines.push(`${key}=${value}`, "");
  writeFileSync(p, lines.join("\n"), { mode: 0o600 });
  chmodSync(p, 0o600);
  return p;
}

/** Remove keys from the user-level credentials file. */
export function removeCredentials(keys: readonly string[]): string[] {
  const p = credentialsPath();
  if (!existsSync(p)) return [];
  const removed: string[] = [];
  const lines = readFileSync(p, "utf8").split(/\r?\n/).filter((l) => {
    const k = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l.trim())?.[1];
    if (k && keys.includes(k)) {
      removed.push(k);
      return false;
    }
    return true;
  });
  writeFileSync(p, lines.join("\n"), { mode: 0o600 });
  for (const k of removed) delete process.env[k];
  return removed;
}

export function credentialsFileMode(): string | null {
  const p = credentialsPath();
  return existsSync(p) ? (statSync(p).mode & 0o777).toString(8) : null;
}

/** Last 4 characters only — for showing which key is configured without revealing it. */
export function mask(v: string | undefined): string | null {
  return v ? `…${v.slice(-4)}` : null;
}
