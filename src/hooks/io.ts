/** Shared helpers for hook entrypoints: read the event JSON from stdin, emit decisions. */

export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  source?: string;
}

export async function readInput(): Promise<HookInput> {
  const text = await Bun.stdin.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as HookInput;
  } catch {
    return {};
  }
}

export function deny(reason: string): never {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
    }),
  );
  process.exit(0);
}

export function context(event: "SessionStart" | "PostToolUse", text: string): never {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }));
  process.exit(0);
}

/** Hooks must never break the session on an internal error: log to stderr and allow. */
export function failOpen(e: unknown): never {
  process.stderr.write(`[agentic-sales-engine] hook error (allowing): ${(e as Error)?.stack ?? e}\n`);
  process.exit(0);
}
