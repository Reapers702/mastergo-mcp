/**
 * mastergo-mcp — 基于 MasterGo **网页接口**自研的内部 MCP Server（不依赖官方 MCP 网关 /mcp/*）。
 *
 * 用法：
 *   MG_COOKIE="gfsessionid=..." npx tsx src/index.ts   # 浏览器 Cookie（网页 API）
 *   npx tsx src/index.ts --cookie "gfsessionid=..." --url https://mastergo.com
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { MasterGoClient } from "./mastergo.js";
import { buildTools } from "./tools.js";

const cfg = loadConfig();
const client = new MasterGoClient(cfg);

const server = new McpServer({
  name: "mastergo-mcp",
  version: "0.1.0",
});

for (const tool of buildTools()) {
  server.tool(tool.name, tool.description, tool.params as any, async (args: any) => {
    try {
      const text = await tool.run(client, args);
      return { content: [{ type: "text" as const, text }] };
    } catch (err: any) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: JSON.stringify({ error: err.message }) }],
      };
    }
  });
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[mastergo-mcp] 已启动 token=${cfg.token ? "yes" : "no"} cookie=${cfg.cookie ? "yes" : "no"} baseUrl=${cfg.baseUrl}`
  );
}

main().catch((err) => {
  console.error("[mastergo-mcp] 启动失败:", err);
  process.exit(1);
});
