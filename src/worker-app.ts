import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

interface AppEnv {
    OAUTH_PROVIDER: OAuthHelpers;
    GOOGLE_CLIENT_ID: string;
    GOOGLE_CLIENT_SECRET: string;
    ALLOWED_EMAILS: string;
    STATE_SECRET: string;
}

interface OAuthReqInfo {
    scope?: string[];
    [key: string]: unknown;
}

interface SignedPayload {
    oauthReqInfo: OAuthReqInfo;
    exp: number;
}

interface GoogleTokenResponse {
    access_token: string;
}

interface GoogleUserInfo {
    email?: string;
    email_verified?: boolean;
}

const STATE_TTL_SECONDS = 600;

function bytesToHex(buffer: ArrayBuffer): string {
    return Array.from(new Uint8Array(buffer))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

function hexToBytes(hex: string): ArrayBuffer {
    const matches = hex.match(/.{2}/g) ?? [];
    const buf = new ArrayBuffer(matches.length);
    const view = new Uint8Array(buf);
    matches.forEach((b, i) => {
        view[i] = parseInt(b, 16);
    });
    return buf;
}

async function getHmacKey(secret: string): Promise<CryptoKey> {
    return crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
    );
}

async function signState(
    secret: string,
    payload: SignedPayload,
): Promise<string> {
    const body = btoa(JSON.stringify(payload));
    const key = await getHmacKey(secret);
    const sig = await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(body),
    );
    return `${body}.${bytesToHex(sig)}`;
}

async function verifyState(
    secret: string,
    state: string,
): Promise<SignedPayload | null> {
    const dot = state.lastIndexOf(".");
    if (dot < 0) return null;
    const body = state.slice(0, dot);
    const sigHex = state.slice(dot + 1);
    const key = await getHmacKey(secret);
    const valid = await crypto.subtle.verify(
        "HMAC",
        key,
        hexToBytes(sigHex),
        new TextEncoder().encode(body),
    );
    if (!valid) return null;
    try {
        const payload = JSON.parse(atob(body)) as SignedPayload;
        if (payload.exp < Math.floor(Date.now() / 1000)) return null;
        return payload;
    } catch {
        return null;
    }
}

function callbackUrl(request: Request): string {
    return new URL("/authorize/callback", request.url).toString();
}

async function startGoogleAuth(
    env: AppEnv,
    request: Request,
): Promise<Response> {
    const oauthReqInfo = (await env.OAUTH_PROVIDER.parseAuthRequest(
        request,
    )) as unknown as OAuthReqInfo;
    const state = await signState(env.STATE_SECRET, {
        oauthReqInfo,
        exp: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS,
    });
    const googleUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    googleUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
    googleUrl.searchParams.set("redirect_uri", callbackUrl(request));
    googleUrl.searchParams.set("response_type", "code");
    googleUrl.searchParams.set("scope", "openid email");
    googleUrl.searchParams.set("state", state);
    googleUrl.searchParams.set("access_type", "online");
    googleUrl.searchParams.set("prompt", "select_account");
    return Response.redirect(googleUrl.toString(), 302);
}

async function finishGoogleAuth(
    env: AppEnv,
    request: Request,
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
    const payload = await verifyState(env.STATE_SECRET, state);
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

    const email = userinfo.email?.toLowerCase();
    if (!email || !userinfo.email_verified) {
        return new Response("Email not verified by Google", { status: 403 });
    }
    const allowed = env.ALLOWED_EMAILS.split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
    if (!allowed.includes(email)) {
        return new Response(`Forbidden: ${email} is not authorized`, {
            status: 403,
        });
    }

    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: payload.oauthReqInfo as never,
        userId: email,
        metadata: { label: email },
        scope: payload.oauthReqInfo.scope ?? [],
        // Intentionally empty: the Durable Object reads secrets from env directly,
        // so KV grants don't carry a copy of any sensitive credential.
        props: {},
    });
    return Response.redirect(redirectTo, 302);
}

export default {
    async fetch(request: Request, env: AppEnv): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname === "/authorize" && request.method === "GET") {
            return startGoogleAuth(env, request);
        }
        if (
            url.pathname === "/authorize/callback" &&
            request.method === "GET"
        ) {
            return finishGoogleAuth(env, request);
        }
        if (url.pathname === "/") {
            return new Response(
                "Remote MCP server. Add this URL to claude.ai as a custom connector.",
                { headers: { "content-type": "text/plain" } },
            );
        }
        return new Response("Not found", { status: 404 });
    },
};
