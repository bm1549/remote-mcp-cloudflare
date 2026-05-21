import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { signHmac, verifyHmac } from "./crypto.js";

/**
 * Multi-tenant resume-token helpers.
 *
 * When `resolveUser` returns `{ redirect, resumeToken }`, the worker 302s the
 * end-user out to a consumer-owned setup page (e.g. `/setup`) with `?rt=<token>`.
 * The consumer's route reads the token, collects whatever per-user state it
 * needs (e.g. an API key), then calls {@link verifyResumeToken} to recover the
 * parsed `oauthReqInfo` and finishes the flow with {@link resumeAuthorization}.
 */

const RESUME_TTL_SECONDS = 30 * 60;

/**
 * Sign a resume token with a 30-minute TTL.
 *
 * The payload is opaque to this library; consumers typically stash the parsed
 * `oauthReqInfo` returned by `OAUTH_PROVIDER.parseAuthRequest` along with any
 * identifying data (email, sub, etc.) so the setup page can recover the user's
 * pending OAuth context.
 */
export async function signResumeToken(
    env: { STATE_SECRET: string },
    payload: unknown,
): Promise<string> {
    return signHmac(env.STATE_SECRET, payload, RESUME_TTL_SECONDS);
}

/**
 * Verify and parse a resume token signed with {@link signResumeToken}. Returns
 * null if the signature is bad or the token has expired.
 */
export async function verifyResumeToken<T = unknown>(
    env: { STATE_SECRET: string },
    token: string,
): Promise<T | null> {
    return verifyHmac<T>(env.STATE_SECRET, token);
}

/**
 * Thin wrapper around `OAUTH_PROVIDER.completeAuthorization` so consumer routes
 * (e.g. a `/setup` handler) can finish the OAuth flow without importing
 * `@cloudflare/workers-oauth-provider` types directly.
 */
export async function resumeAuthorization(
    env: { OAUTH_PROVIDER: OAuthHelpers },
    oauthReqInfo: unknown,
    userId: string,
    props: Record<string, unknown>,
): Promise<{ redirectTo: string }> {
    // The OAuth provider's CompleteAuthorizationOptions type is generic; we
    // accept `unknown` from the consumer because the resume token contents
    // are opaque to this library. The call shape matches what worker-app.ts
    // already does in `finishGoogleAuth`.
    const req = oauthReqInfo as { scope?: string[] };
    return env.OAUTH_PROVIDER.completeAuthorization({
        request: oauthReqInfo as never,
        userId,
        metadata: { label: userId },
        scope: req.scope ?? [],
        props,
    });
}
