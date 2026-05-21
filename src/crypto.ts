/**
 * Generic HMAC sign/verify helpers used for the Google-auth `state` parameter
 * and the multi-tenant resume tokens.
 *
 * Tokens have the shape `${base64(JSON.stringify(payload))}.${hex(hmac)}`.
 * The payload is augmented with an `exp` (unix seconds) field for TTL.
 */

interface SignedEnvelope<T> {
    p: T;
    exp: number;
}

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

/**
 * Sign an arbitrary JSON-serializable payload with HMAC-SHA-256, embedding a
 * `ttlSeconds` expiration.
 */
export async function signHmac<T>(
    secret: string,
    payload: T,
    ttlSeconds: number,
): Promise<string> {
    const envelope: SignedEnvelope<T> = {
        p: payload,
        exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    };
    const body = btoa(JSON.stringify(envelope));
    const key = await getHmacKey(secret);
    const sig = await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(body),
    );
    return `${body}.${bytesToHex(sig)}`;
}

/**
 * Verify a token produced by {@link signHmac}. Returns the original payload
 * if the signature is valid AND the token has not expired; otherwise null.
 */
export async function verifyHmac<T = unknown>(
    secret: string,
    token: string,
): Promise<T | null> {
    const dot = token.lastIndexOf(".");
    if (dot < 0) return null;
    const body = token.slice(0, dot);
    const sigHex = token.slice(dot + 1);
    const key = await getHmacKey(secret);
    let valid: boolean;
    try {
        valid = await crypto.subtle.verify(
            "HMAC",
            key,
            hexToBytes(sigHex),
            new TextEncoder().encode(body),
        );
    } catch {
        return null;
    }
    if (!valid) return null;
    try {
        const envelope = JSON.parse(atob(body)) as SignedEnvelope<T>;
        if (
            typeof envelope.exp !== "number" ||
            envelope.exp < Math.floor(Date.now() / 1000)
        ) {
            return null;
        }
        return envelope.p;
    } catch {
        return null;
    }
}
