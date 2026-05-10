import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import authApp from "./worker-app.js";
import { createConfiguredServer, type McpEnv } from "./mcp-server.js";
import packageJson from "../package.json" with { type: "json" };

export interface WorkerEnv extends McpEnv {
    OAUTH_KV: KVNamespace;
    MCP_OBJECT: DurableObjectNamespace;
    GOOGLE_CLIENT_ID: string;
    GOOGLE_CLIENT_SECRET: string;
    ALLOWED_EMAILS: string;
    STATE_SECRET: string;
}

export class GenericMCP extends McpAgent<WorkerEnv> {
    server!: McpServer;

    async init() {
        this.server = createConfiguredServer(this.env, packageJson.version);
    }
}

export default new OAuthProvider({
    apiRoute: "/mcp",
    apiHandler: GenericMCP.serve("/mcp") as never,
    defaultHandler: authApp as never,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
});
