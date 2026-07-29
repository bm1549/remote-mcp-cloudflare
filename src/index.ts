import OAuthProvider from "@cloudflare/workers-oauth-provider";
import {
    createAuthApp,
    type AuthAppOptions,
    type ResolveUserFn,
    type ResolveUserResult,
    type RouteHandler,
    type GoogleUserInfo,
    type AppEnv,
} from "./worker-app.js";

export { signHmac, verifyHmac } from "./crypto.js";
export {
    signResumeToken,
    verifyResumeToken,
    resumeAuthorization,
} from "./resume.js";
export type {
    AppEnv,
    AuthAppOptions,
    GoogleUserInfo,
    ResolveUserFn,
    ResolveUserResult,
    RouteHandler,
} from "./worker-app.js";

export interface BaseEnv {
    OAUTH_KV: KVNamespace;
    MCP_OBJECT: DurableObjectNamespace;
    GOOGLE_CLIENT_ID: string;
    GOOGLE_CLIENT_SECRET: string;
    ALLOWED_EMAILS: string;
    STATE_SECRET: string;
    REGISTER_LIMITER?: RateLimit;
}

/**
 * The only thing this library ever needs from the MCP side: something that can
 * hand back a fetch handler for the API route.
 *
 * Historically this was typed as an `McpAgent` subclass, which forced every
 * consumer onto `agents`' `McpAgent`. That class is deprecated and
 * feature-frozen upstream as of `agents@0.20.0` (it is MCP SDK v1 / protocol
 * sessions only), and MCP revision 2026-07-28 removed protocol sessions
 * outright — so a server on the modern path has no `McpAgent` to pass. The
 * constraint is now structural: any class or object with a static/own
 * `serve(path)` satisfies it, including one built on
 * `createMcpHandler` from `agents/mcp/server`.
 */
export interface McpApiHandlerSource {
    serve(path: string): McpApiHandler;
}

/** What `serve()` returns — the shape the OAuth provider mounts on `apiRoute`. */
export interface McpApiHandler {
    fetch(
        request: Request,
        env: never,
        ctx: ExecutionContext,
    ): Promise<Response>;
}

/**
 * Pre-validates Dynamic Client Registration requests before they reach the
 * underlying OAuth provider. All fields default to "no enforcement" so that
 * omitting `registerPolicy` preserves the 0.1.x behavior exactly.
 */
export interface RegisterPolicy {
    /**
     * If true, the `/authorize` endpoint will reject clients that don't supply
     * a PKCE `code_challenge`. NOTE: this is enforced at /authorize time, not
     * at /register time — DCR does not carry PKCE parameters, so a registration
     * check would be either too strict or vacuous. Pairing the flag with an
     * /authorize-time check covers the real attack surface.
     */
    requirePkce?: boolean;
    /**
     * Allowed protocols for client `redirect_uris`. Pass schemes without the
     * trailing colon, e.g. `["https"]`. The special marker `"http-localhost"`
     * additionally permits `http://localhost` and `http://127.0.0.1` URLs
     * (useful for loopback dev clients).
     */
    allowedRedirectSchemes?: string[];
    /**
     * If true, reject `redirect_uris` whose hostname is a raw IP literal
     * (IPv4 or IPv6). Loopback addresses (`127.0.0.1`, `[::1]`) are still
     * permitted when `allowedRedirectSchemes` includes `"http-localhost"`.
     */
    rejectIpHosts?: boolean;
    /**
     * Maximum number of entries in the `redirect_uris` array.
     */
    maxRedirectUris?: number;
    /**
     * Allowed `application_type` values at DCR. MCP revision 2026-07-28
     * (SEP-837) requires clients to declare one, so that OpenID Connect's
     * per-type redirect-URI rules don't conflict — `"web"` forbids the
     * `http://localhost` redirects a `"native"` client needs, and a server
     * that can't tell them apart has to accept both for everyone.
     *
     * Pass e.g. `["native", "web"]` to require the field be present and be one
     * of those. Omit for no enforcement (a client that sends nothing is
     * accepted, matching pre-0.3.0 behavior).
     */
    allowedApplicationTypes?: string[];
}

export interface CreateOAuthWorkerOptions {
    apiRoute?: string;
    authorizeEndpoint?: string;
    tokenEndpoint?: string;
    clientRegistrationEndpoint?: string;
    /**
     * What string becomes the `userId` in `completeAuthorization`. Default
     * `"email"` (matches 0.1.x). `"sub"` uses Google's stable subject id.
     */
    userIdSource?: "email" | "sub";
    /**
     * Hook that decides who the authenticated user is, or redirects them
     * elsewhere (e.g. a `/setup` page) to collect additional info before
     * completing the grant. Omit to keep the 0.1.x default of
     * `ALLOWED_EMAILS`-allowlist + email-as-userId + empty props.
     */
    resolveUser?: ResolveUserFn;
    /**
     * Extra route handlers on the auth app, e.g. for `/setup`. Matched by
     * exact pathname, after the built-in `/`, `/authorize`, and
     * `/authorize/callback` routes and before the 404 fallback.
     */
    routes?: Record<string, RouteHandler>;
    /**
     * Optional DCR policy enforced before requests hit the OAuth provider.
     */
    registerPolicy?: RegisterPolicy;
}

interface DcrBody {
    redirect_uris?: unknown;
    token_endpoint_auth_method?: unknown;
    [key: string]: unknown;
}

const LOCALHOST_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function validateRegisterBody(
    body: DcrBody,
    policy: RegisterPolicy,
): string | null {
    const redirectUris = Array.isArray(body.redirect_uris)
        ? (body.redirect_uris as unknown[])
        : null;

    if (policy.allowedApplicationTypes) {
        const appType = body.application_type;
        if (typeof appType !== "string") {
            return "application_type is required";
        }
        if (!policy.allowedApplicationTypes.includes(appType)) {
            return `application_type not allowed: ${appType}`;
        }
    }

    if (
        policy.maxRedirectUris !== undefined &&
        redirectUris &&
        redirectUris.length > policy.maxRedirectUris
    ) {
        return `Too many redirect_uris (max ${policy.maxRedirectUris})`;
    }

    if (policy.allowedRedirectSchemes || policy.rejectIpHosts) {
        if (!redirectUris) {
            return "redirect_uris missing or not an array";
        }
        const schemes = policy.allowedRedirectSchemes ?? [];
        const allowHttpLocalhost = schemes.includes("http-localhost");
        const normalSchemes = new Set(
            schemes.filter((s) => s !== "http-localhost"),
        );

        for (const raw of redirectUris) {
            if (typeof raw !== "string") {
                return "redirect_uris must be strings";
            }
            let parsed: URL;
            try {
                parsed = new URL(raw);
            } catch {
                return `Invalid redirect_uri: ${raw}`;
            }
            const protocol = parsed.protocol.replace(/:$/, "");
            const hostname = parsed.hostname; // IPv6 returns "[::1]"

            // Scheme check
            if (policy.allowedRedirectSchemes) {
                const schemeOk =
                    normalSchemes.has(protocol) ||
                    (allowHttpLocalhost &&
                        protocol === "http" &&
                        LOCALHOST_HOSTS.has(hostname));
                if (!schemeOk) {
                    return `redirect_uri scheme not allowed: ${raw}`;
                }
            }

            // IP-host check
            if (policy.rejectIpHosts) {
                const isIpv4 = /^\d+\.\d+\.\d+\.\d+$/.test(hostname);
                const isIpv6 =
                    hostname.startsWith("[") && hostname.endsWith("]");
                if (isIpv4 || isIpv6) {
                    const loopbackOk =
                        allowHttpLocalhost &&
                        protocol === "http" &&
                        (hostname === "127.0.0.1" || hostname === "[::1]");
                    if (!loopbackOk) {
                        return `redirect_uri host must not be an IP literal: ${raw}`;
                    }
                }
            }
        }
    }

    return null;
}

export function createOAuthWorker(
    AgentClass: McpApiHandlerSource,
    options: CreateOAuthWorkerOptions = {},
) {
    const apiRoute = options.apiRoute ?? "/mcp";
    const registerRoute =
        options.clientRegistrationEndpoint ?? "/register";

    const authAppOptions: AuthAppOptions = {
        userIdSource: options.userIdSource,
        resolveUser: options.resolveUser,
        routes: options.routes,
        requirePkceAtAuthorize: options.registerPolicy?.requirePkce,
    };
    const authApp = createAuthApp(authAppOptions);

    const oauth = new OAuthProvider({
        apiRoute,
        apiHandler: AgentClass.serve(apiRoute) as never,
        defaultHandler: authApp as never,
        authorizeEndpoint: options.authorizeEndpoint ?? "/authorize",
        tokenEndpoint: options.tokenEndpoint ?? "/token",
        clientRegistrationEndpoint: registerRoute,
    });

    const registerPolicy = options.registerPolicy;
    // Whether registerPolicy has any DCR-time checks to run. `requirePkce` is
    // enforced at /authorize, not here, so it doesn't count.
    const hasDcrChecks =
        !!registerPolicy &&
        (registerPolicy.allowedRedirectSchemes !== undefined ||
            registerPolicy.rejectIpHosts === true ||
            registerPolicy.maxRedirectUris !== undefined ||
            registerPolicy.allowedApplicationTypes !== undefined);

    return {
        async fetch(
            request: Request,
            env: BaseEnv,
            ctx: ExecutionContext,
        ): Promise<Response> {
            const url = new URL(request.url);

            if (env.REGISTER_LIMITER && url.pathname === registerRoute) {
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

            if (
                hasDcrChecks &&
                url.pathname === registerRoute &&
                request.method === "POST"
            ) {
                // Clone before consuming the body so we can still forward the
                // original request to oauth.fetch on success. (Standard
                // Workers gotcha: a Request's body can only be read once.)
                const clone = request.clone();
                let body: DcrBody;
                try {
                    body = (await clone.json()) as DcrBody;
                } catch {
                    return new Response("Invalid JSON body", { status: 400 });
                }
                const violation = validateRegisterBody(body, registerPolicy!);
                if (violation) {
                    return new Response(violation, {
                        status: 400,
                        headers: { "content-type": "text/plain" },
                    });
                }
            }

            return oauth.fetch(request, env, ctx);
        },
    };
}
