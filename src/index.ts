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
    REGISTER_LIMITER?: RateLimit;
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
    const registerRoute =
        options.clientRegistrationEndpoint ?? "/register";
    const oauth = new OAuthProvider({
        apiRoute,
        apiHandler: AgentClass.serve(apiRoute) as never,
        defaultHandler: authApp as never,
        authorizeEndpoint: options.authorizeEndpoint ?? "/authorize",
        tokenEndpoint: options.tokenEndpoint ?? "/token",
        clientRegistrationEndpoint: registerRoute,
    });

    return {
        async fetch(
            request: Request,
            env: BaseEnv,
            ctx: ExecutionContext,
        ): Promise<Response> {
            if (env.REGISTER_LIMITER) {
                const url = new URL(request.url);
                if (url.pathname === registerRoute) {
                    const key =
                        request.headers.get("cf-connecting-ip") ?? "anon";
                    const { success } = await env.REGISTER_LIMITER.limit({
                        key,
                    });
                    if (!success) {
                        return new Response("Too many requests", {
                            status: 429,
                            headers: { "content-type": "text/plain" },
                        });
                    }
                }
            }
            return oauth.fetch(request, env, ctx);
        },
    };
}
