import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Adapter, AdapterResult, Op, OpInputs, ProviderName } from "./types.ts";
import { ProviderError } from "./types.ts";

/**
 * Record/replay for provider calls, so tests and demos run offline and deterministically.
 *   ASE_PROVIDER_MODE=replay  — answer only from cassettes (missing cassette = error)
 *   ASE_PROVIDER_MODE=record  — call the real provider and save the response
 *   ASE_CASSETTES=<dir>       — cassette directory (default: <plugin>/fixtures/cassettes)
 */
export type Mode = "live" | "record" | "replay";

export function providerMode(): Mode {
  const m = process.env.ASE_PROVIDER_MODE;
  return m === "record" || m === "replay" ? m : "live";
}

export function cassetteDir(): string {
  return process.env.ASE_CASSETTES ?? join(import.meta.dir, "..", "..", "..", "fixtures", "cassettes");
}

/** Stable JSON: object keys sorted, so equivalent inputs hash identically. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export function cassetteKey(provider: ProviderName, op: Op, input: unknown): string {
  return `${provider}-${op}-${createHash("sha256").update(stableJson(input)).digest("hex").slice(0, 16)}`;
}

interface Cassette {
  provider: ProviderName;
  op: Op;
  input: unknown;
  recorded_at: string;
  response: AdapterResult<Op>;
}

/** Wrap an adapter with record/replay behaviour. In replay mode the inner adapter may be null. */
export function withCassettes(name: ProviderName, supports: readonly Op[], inner: Adapter | null, mode: Mode, dir = cassetteDir()): Adapter {
  return {
    name,
    supports,
    async run<O extends Op>(op: O, input: OpInputs[O]): Promise<AdapterResult<O>> {
      const file = join(dir, `${cassetteKey(name, op, input)}.json`);
      if (mode === "replay") {
        if (!existsSync(file)) {
          throw new ProviderError(`no cassette for ${name}.${op} (${file}); record it with ASE_PROVIDER_MODE=record`, "replay_miss");
        }
        return (JSON.parse(readFileSync(file, "utf8")) as Cassette).response as AdapterResult<O>;
      }
      if (!inner) throw new ProviderError(`${name} is not configured`, "no_provider");
      const res = await inner.run(op, input);
      if (mode === "record") {
        mkdirSync(dir, { recursive: true });
        const c: Cassette = { provider: name, op, input, recorded_at: new Date().toISOString(), response: res as AdapterResult<Op> };
        writeFileSync(file, `${JSON.stringify(c, null, 2)}\n`);
      }
      return res;
    },
  };
}
