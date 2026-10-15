/**
 * How Claude is paid for in this environment.
 *   subscription — Claude Code logged in with a claude.ai plan (Pro/Max/Team/Enterprise seat): no per-token bill,
 *                  but plan usage limits apply. Claude cost figures are API-equivalent estimates, for information.
 *   api          — ANTHROPIC_API_KEY / auth token, Bedrock, Vertex or Foundry: billed per token; budgets apply.
 * Data providers (Exa, Firecrawl) are always real money and always budgeted.
 * Override with `claude_billing: subscription | api` (default auto) in ase.config.yaml or ASE_CLAUDE_BILLING.
 */
export type ClaudeBilling = "subscription" | "api";

export function claudeBilling(configured?: string | null): ClaudeBilling {
  const forced = process.env.ASE_CLAUDE_BILLING || configured;
  if (forced === "subscription" || forced === "api") return forced;
  const e = process.env;
  if (e.ANTHROPIC_API_KEY || e.ANTHROPIC_AUTH_TOKEN || e.CLAUDE_CODE_USE_BEDROCK || e.CLAUDE_CODE_USE_VERTEX || e.CLAUDE_CODE_USE_FOUNDRY) return "api";
  return "subscription";
}

/** Model spend counts against budgets only when it is actually billed per token. */
export const modelSpendIsBilled = (b: ClaudeBilling) => b === "api";
