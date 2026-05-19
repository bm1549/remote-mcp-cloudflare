import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { signHmac, verifyHmac } from "./crypto.js";

export interface AppEnv {
    OAUTH_PROVIDER: OAuthHelpers;
    GOOGLE_CLIENT_ID: string;
    GOOGLE_CLIENT_SECRET: string;
    ALLOWED_EMAILS: string;
    STATE_SECRET: string;
}

interface OAuthReqInfo {
    scope?: string[];
    codeChallenge?: string;
    [key: string]: unknown;
}

interface StatePayload {
    oauthReqInfo: OAuthReqInfo;
}

interface GoogleTokenResponse {
    access_token: string;
}

/**
 * Userinfo returned by Google's `/v1/userinfo` endpoint. Consumers' resolveUser
 * hooks may need `name`, `picture`, `hd`, etc., so we deliberately keep this
 * loose with an index signature.
 */
export interface GoogleUserInfo {
    sub?: string;
    email?: string;
    email_verified?: boolean;
    [key: string]: unknown;
}

export type ResolveUserResult =
    | { userId: string; props: Record<string, unknown> }
    | { redirect: string; resumeToken: string }
    | { reject: string };

export type ResolveUserFn = (
    userinfo: GoogleUserInfo,
    env: AppEnv,
    request: Request,
) => Promise<ResolveUserResult>;

export type RouteHandler = (
    request: Request,
    env: AppEnv,
    ctx: ExecutionContext,
) => Promise<Response>;

export interface AuthAppOptions {
    /**
     * Controls what string becomes the `userId` passed to
     * `OAUTH_PROVIDER.completeAuthorization` by the *default* resolver.
     * Ignored when `resolveUser` is supplied — that hook returns its own
     * `userId`. Default: `"email"`.
     */
    userIdSource?: "email" | "sub";
    /**
     * Replaces the default "check email_verified + ALLOWED_EMAILS, return
     * {userId: email, props: {}}" behavior. See {@link ResolveUserResult}.
     */
    resolveUser?: ResolveUserFn;
    /**
     * Custom route handlers, matched on exact pathname AFTER the built-in
     * `/`, `/authorize`, and `/authorize/callback` routes and BEFORE the 404.
     */
    routes?: Record<string, RouteHandler>;
    /**
     * When true, `/authorize` requires the OAuth client to supply a PKCE
     * `code_challenge`. Used by `createOAuthWorker`'s `registerPolicy`.
     */
    requirePkceAtAuthorize?: boolean;
}

const STATE_TTL_SECONDS = 600;

function callbackUrl(request: Request): string {
    return new URL("/authorize/callback", request.url).toString();
}

async function startGoogleAuth(
    env: AppEnv,
    request: Request,
    options: AuthAppOptions,
): Promise<Response> {
    const oauthReqInfo = (await env.OAUTH_PROVIDER.parseAuthRequest(
        request,
    )) as unknown as OAuthReqInfo;

    if (options.requirePkceAtAuthorize && !oauthReqInfo.codeChallenge) {
        return new Response(
            "PKCE required: client must supply code_challenge",
            { status: 400 },
        );
    }

    const state = await signHmac<StatePayload>(
        env.STATE_SECRET,
        { oauthReqInfo },
        STATE_TTL_SECONDS,
    );
    const googleUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    googleUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
    googleUrl.searchParams.set("redirect_uri", callbackUrl(request));
    googleUrl.searchParams.set("response_type", "code");
    // `openid email` already includes `sub` in the userinfo response — no
    // scope change needed when consumers opt into `userIdSource: "sub"`.
    googleUrl.searchParams.set("scope", "openid email");
    googleUrl.searchParams.set("state", state);
    googleUrl.searchParams.set("access_type", "online");
    googleUrl.searchParams.set("prompt", "select_account");
    return Response.redirect(googleUrl.toString(), 302);
}

async function defaultResolveUser(
    userinfo: GoogleUserInfo,
    env: AppEnv,
    userIdSource: "email" | "sub",
): Promise<ResolveUserResult> {
    const email = userinfo.email?.toLowerCase();
    if (!email || !userinfo.email_verified) {
        return { reject: "Email not verified by Google" };
    }
    const allowed = env.ALLOWED_EMAILS.split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
    if (!allowed.includes(email)) {
        return { reject: `Forbidden: ${email} is not authorized` };
    }
    const userId =
        userIdSource === "sub" ? (userinfo.sub ?? email) : email;
    return { userId, props: {} };
}

async function finishGoogleAuth(
    env: AppEnv,
    request: Request,
    options: AuthAppOptions,
): Promise<Response> {
    const url = new URL(request.url);
    const errorParam = url.searchParams.get("error");
    if (errorParam) {
        return new Response(`Google auth error: ${errorParam}`, {
            status: 400,
        });
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) {
        return new Response("Missing code or state", { status: 400 });
    }
    const payload = await verifyHmac<StatePayload>(env.STATE_SECRET, state);
    if (!payload) {
        return new Response("Invalid or expired state", { status: 400 });
    }

    const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            code,
            client_id: env.GOOGLE_CLIENT_ID,
            client_secret: env.GOOGLE_CLIENT_SECRET,
            redirect_uri: callbackUrl(request),
            grant_type: "authorization_code",
        }),
    });
    if (!tokenResp.ok) {
        const detail = await tokenResp.text();
        return new Response(`Google token exchange failed: ${detail}`, {
            status: 502,
        });
    }
    const tokens = (await tokenResp.json()) as GoogleTokenResponse;

    const userResp = await fetch(
        "https://openidconnect.googleapis.com/v1/userinfo",
        { headers: { authorization: `Bearer ${tokens.access_token}` } },
    );
    if (!userResp.ok) {
        return new Response("Google userinfo fetch failed", { status: 502 });
    }
    const userinfo = (await userResp.json()) as GoogleUserInfo;

    const userIdSource = options.userIdSource ?? "email";
    const resolved = options.resolveUser
        ? await options.resolveUser(userinfo, env, request)
        : await defaultResolveUser(userinfo, env, userIdSource);

    if ("reject" in resolved) {
        return new Response(resolved.reject, { status: 403 });
    }
    if ("redirect" in resolved) {
        const target = new URL(resolved.redirect, request.url);
        // Merge `rt` via URLSearchParams so existing query strings on the
        // consumer-supplied redirect URL are preserved.
        target.searchParams.set("rt", resolved.resumeToken);
        return Response.redirect(target.toString(), 302);
    }

    const label =
        typeof userinfo.email === "string" ? userinfo.email : resolved.userId;
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: payload.oauthReqInfo as never,
        userId: resolved.userId,
        metadata: { label },
        scope: payload.oauthReqInfo.scope ?? [],
        props: resolved.props,
    });
    return Response.redirect(redirectTo, 302);
}

export function createAuthApp(options: AuthAppOptions = {}): {
    fetch: (
        request: Request,
        env: AppEnv,
        ctx: ExecutionContext,
    ) => Promise<Response>;
} {
    return {
        async fetch(
            request: Request,
            env: AppEnv,
            ctx: ExecutionContext,
        ): Promise<Response> {
            const url = new URL(request.url);

            if (url.pathname === "/authorize" && request.method === "GET") {
                return startGoogleAuth(env, request, options);
            }
            if (
                url.pathname === "/authorize/callback" &&
                request.method === "GET"
            ) {
                return finishGoogleAuth(env, request, options);
            }
            if (url.pathname === "/") {
                return new Response(
                    "Remote MCP server. Add this URL to claude.ai as a custom connector.",
                    { headers: { "content-type": "text/plain" } },
                );
            }
            const custom = options.routes?.[url.pathname];
            if (custom) {
                return custom(request, env, ctx);
            }
            return new Response("Not found", { status: 404 });
        },
    };
}

// Backwards-compatible default export: the original singleton, with no
// resolveUser override and no custom routes. Behavior is identical to 0.1.1.
export default createAuthApp();
