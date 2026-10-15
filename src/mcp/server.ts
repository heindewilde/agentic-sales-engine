#!/usr/bin/env bun
/**
 * `ase` MCP server — the provider gateway. Claude Code starts it with the user's provider keys in env
 * (from plugin userConfig, which never reaches Bash-run scripts). Every paid operation goes through here so
 * budgets are enforced before the call and actual cost is recorded after it.
 *
 * M0: status only. Provider tools (discover_companies, find_people, extract, research, search_news, watch) land in M2.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { tier } from "../core/doctor.ts";
import { currentRun, spentForRun, spentToday } from "../core/ledger.ts";
import { findWorkspace, loadConfig } from "../core/workspace.ts";

const server = new McpServer({ name: "ase", version: "0.1.0" });

const text = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

server.registerTool(
  "status",
  {
    title: "Provider gateway status",
    description: "Which providers are configured (capability tier) and how much budget is left for today and the active run.",
    inputSchema: {},
  },
  async () => {
    const ws = findWorkspace();
    if (!ws) return text({ tier: tier(), workspace: null });
    const cfg = await loadConfig(ws).catch(() => null);
    const run = currentRun(ws);
    return text({
      workspace: ws,
      tier: tier(),
      today: { spent_usd: spentToday(ws), cap_usd: cfg?.budgets.per_day_usd ?? null },
      run: run ? { ...run, spent_usd: spentForRun(ws, run.run_id) } : null,
    });
  },
);

await server.connect(new StdioServerTransport());
