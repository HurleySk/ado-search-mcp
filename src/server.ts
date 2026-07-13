#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRequire } from "module";
import { loadConfig } from "./config.js";
import { registerTools } from "./registerTools.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const config = loadConfig();

const server = new McpServer({
  name: "ado-search",
  version,
});

registerTools(server, config);

process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

const transport = new StdioServerTransport();
await server.connect(transport);
