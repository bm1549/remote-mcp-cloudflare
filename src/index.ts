import OAuthProvider from "@cloudflare/workers-oauth-provider";
import type { McpAgent } from "agents/mcp";
import authApp from "./worker-app.js";

export interface BaseEnv {
    OAUTH_KV: KVNamespace;
    MCP_OBJECT: DurableObjectNamespace;
    GOOGLE_CLIENT_ID: string;
    GOOGLE_CLIENT_SECRET: string;
    ALLOWED_EMAILS: string;
    STATE_SECRET: string;
}

interface McpAgentClass {
    serve(path: string): unknown;
    new (...args: never[]): McpAgent<BaseEnv>;
}

export interface CreateOAuthWorkerOptions {
    apiRoute?: string;
    authorizeEndpoint?: string;
    tokenEndpoint?: string;
    clientRegistrationEndpoint?: string;
}

export function createOAuthWorker(
    AgentClass: McpAgentClass,
    options: CreateOAuthWorkerOptions = {},
) {
    const apiRoute = options.apiRoute ?? "/mcp";
    return new OAuthProvider({
        apiRoute,
        apiHandler: AgentClass.serve(apiRoute) as never,
        defaultHandler: authApp as never,
        authorizeEndpoint: options.authorizeEndpoint ?? "/authorize",
        tokenEndpoint: options.tokenEndpoint ?? "/token",
        clientRegistrationEndpoint:
            options.clientRegistrationEndpoint ?? "/register",
    });
}
