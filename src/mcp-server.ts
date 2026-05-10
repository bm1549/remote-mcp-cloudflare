// Customize this file to wire your MCP server to env vars.
//
// The default wiring uses @akutishevsky/lunchmoney-mcp as a demo. To swap in
// your own MCP server:
//   1. npm install <your-mcp-server>
//   2. Replace the imports below with your server's createServer + config init
//   3. Update McpEnv to declare any env vars / secrets your server needs
//   4. Set the matching secrets via `wrangler secret put`
//
// The wrapped server's createServer must take `version: string` and return an
// McpServer instance. See the lunchmoney-mcp factory for a reference shape.

import { createServer as createBareServer } from "@akutishevsky/lunchmoney-mcp/server";
import { initializeConfig } from "@akutishevsky/lunchmoney-mcp/config";

export interface McpEnv {
    LUNCHMONEY_API_TOKEN: string;
}

export function createConfiguredServer(env: McpEnv, version: string) {
    initializeConfig(env.LUNCHMONEY_API_TOKEN);
    return createBareServer(version);
}
