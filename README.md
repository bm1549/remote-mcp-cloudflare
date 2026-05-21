# remote-mcp-cloudflare

A small library for building a **remote MCP server on Cloudflare Workers** — the kind Claude Desktop or the Claude mobile app can connect to over Streamable HTTP.

You bring an `McpServer` from `@modelcontextprotocol/sdk`. This library wraps it in:

- **OAuth 2.1 + dynamic client registration** (via `@cloudflare/workers-oauth-provider`)
- A **Google OAuth consent flow** with an **email allowlist**, so only people you trust can complete authorization
- A **Durable Object–backed MCP transport** (via `agents/mcp`), so each issued token gets its own session

The result is a single `export default` you can deploy to Cloudflare. See [`lunchmoney-mcp-cloudflare`](https://github.com/bm1549/lunchmoney-mcp-cloudflare) for a real-world consumer.

## Why this exists

Most MCP servers ship as stdio binaries. Claude Desktop runs them locally; the mobile app cannot. Anthropic's "remote MCP" path expects a server that speaks Streamable HTTP transport with OAuth 2.1, which is significantly more involved than stdio. This library stitches together two Cloudflare libraries (`workers-oauth-provider` + `agents/mcp`) and adds a Google OAuth front-end so the server stays private to a known set of Gmail addresses.

## Architecture

```
                              ┌──────────────────────────────┐
  Claude Desktop / mobile     │  Cloudflare Worker           │
  ─────────────────────────►  │   ├─ /register               │
  (Streamable HTTP + OAuth)   │   ├─ /authorize  ─────────►  │ ──► Google
                              │   ├─ /authorize/callback ◄──   │ ◄── consent
                              │   ├─ /token                  │
                              │   └─ /mcp  (auth-gated)      │
                              │       │                      │
                              │       ▼                      │
                              │   Durable Object             │
                              │     ├─ McpAgent (transport)  │
                              │     └─ McpServer (your tools)│
                              └──────────────────────────────┘
```

`workers-oauth-provider` handles dynamic client registration, code/token exchange, and bearer-token validation on `/mcp`. The library's `defaultHandler` implements the Google consent flow: browser → Google → email allowlist → `completeAuthorization`. The Durable Object is keyed by the issued token; on each new token, `init()` runs once and constructs your underlying MCP server.

## Install

```sh
npm install @bm1549/remote-mcp-cloudflare
npm install @modelcontextprotocol/sdk agents @cloudflare/workers-oauth-provider
```

Peer deps: `@modelcontextprotocol/sdk`. The other two are direct deps of this package but will normally already be in your worker's `package.json`.

## Usage

Your consumer worker is two files: `wrangler.jsonc` and `src/worker.ts`.

```ts
// src/worker.ts
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createOAuthWorker, type BaseEnv } from "@bm1549/remote-mcp-cloudflare";

import { createServer } from "@your-org/your-mcp-server/server";
import { initializeConfig } from "@your-org/your-mcp-server/config";

interface WorkerEnv extends BaseEnv {
    YOUR_API_TOKEN: string;
}

export class YourMCP extends McpAgent<WorkerEnv> {
    server!: McpServer;
    async init() {
        initializeConfig(this.env.YOUR_API_TOKEN);
        this.server = createServer("1.0.0");
    }
}

export default createOAuthWorker(YourMCP);
```

A full template lives at [`wrangler.example.jsonc`](./wrangler.example.jsonc) — copy it into your consumer repo and fill in the placeholders. Minimal shape:

```jsonc
// wrangler.jsonc
{
    "name": "your-mcp",
    "main": "src/worker.ts",
    "compatibility_date": "2025-03-10",
    "compatibility_flags": ["nodejs_compat"],
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["YourMCP"] }],
    "durable_objects": {
        "bindings": [{ "name": "MCP_OBJECT", "class_name": "YourMCP" }]
    },
    "kv_namespaces": [
        { "binding": "OAUTH_KV", "id": "REPLACE_WITH_YOUR_KV_ID" }
    ],
    "ratelimits": [
        {
            "name": "REGISTER_LIMITER",
            "namespace_id": "1001",
            "simple": { "limit": 10, "period": 60 }
        }
    ],
    "observability": { "enabled": true }
}
```

The DO class name (`YourMCP`) must match between the exported class, the migration entry, and the durable_objects binding.

`REGISTER_LIMITER` is optional. If present, `createOAuthWorker` rate-limits `POST /register` per `cf-connecting-ip` before delegating to the OAuth provider. Without it, `/register` is unauthenticated and unbounded (per the MCP spec).

### Constraints on the wrapped MCP server

- It should expose a `createServer(version: string)` factory that returns an `McpServer`.
- Anything that needs to happen at construction time (token validation, config singletons, etc.) should run inside `init()` so it's deterministic per Durable Object instance.
- Avoid module-level `process.env` reads inside the wrapped server — those don't run reliably in Worker isolates. Pass values in via `this.env`.

### Required secrets

Each consumer worker must set these:

| Secret                  | What it's for                                                       |
| ----------------------- | ------------------------------------------------------------------- |
| `GOOGLE_CLIENT_ID`      | Google OAuth Web Client ID                                          |
| `GOOGLE_CLIENT_SECRET`  | Google OAuth Web Client secret                                      |
| `ALLOWED_EMAILS`        | Comma-separated allowlist of Gmail addresses                        |
| `STATE_SECRET`          | Random secret used to HMAC-sign the OAuth `state` (generate: `openssl rand -hex 32`) |

Plus whatever secrets your wrapped MCP server needs.

### Routes

By default the library mounts:

| Route                  | Purpose                                  |
| ---------------------- | ---------------------------------------- |
| `GET /`                | Plain-text smoke test                    |
| `GET /authorize`       | Starts the Google OAuth flow             |
| `GET /authorize/callback` | Completes the flow, issues OAuth grant |
| `POST /register`       | Dynamic Client Registration (MCP spec)   |
| `POST /token`          | OAuth token endpoint                     |
| `* /mcp`               | The bearer-gated MCP endpoint            |

Pass overrides to `createOAuthWorker(AgentClass, { apiRoute, authorizeEndpoint, ... })` if you need to relocate any of them.

## Multi-tenant servers

Single-tenant (the example above) means the worker holds one shared API token and uses `ALLOWED_EMAILS` to gate access. For multi-tenant servers — where each end-user supplies their own credentials — `createOAuthWorker` accepts these additional options:

| Option              | Purpose                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `userIdSource`      | `"email"` (default) or `"sub"`. Picks which Google identifier becomes the OAuth `userId`. |
| `resolveUser`       | Replaces the default allowlist check. Decides whether to complete, redirect, or reject.   |
| `routes`            | Map of `pathname -> handler` for custom routes (e.g. `/setup`).                          |
| `registerPolicy`    | Tightens Dynamic Client Registration: PKCE, redirect schemes, IP hosts, max URIs.        |

The library also exports three helpers consumers use to drive a deferred-completion flow:

```ts
import {
    signResumeToken,
    verifyResumeToken,
    resumeAuthorization,
} from "@bm1549/remote-mcp-cloudflare";
```

`signResumeToken(env, payload)` produces a 30-minute HMAC-signed opaque token. `verifyResumeToken(env, token)` returns the payload or `null`. `resumeAuthorization(env, oauthReqInfo, userId, props)` is a thin wrapper around `OAUTH_PROVIDER.completeAuthorization` so custom routes don't need to import OAuth provider types directly.

### Example: per-user token via `/setup`

```ts
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
    createOAuthWorker,
    signResumeToken,
    verifyResumeToken,
    resumeAuthorization,
    type BaseEnv,
    type GoogleUserInfo,
} from "@bm1549/remote-mcp-cloudflare";

interface WorkerEnv extends BaseEnv {
    TOKENS_KV: KVNamespace; // per-user token storage
}

export class YourMCP extends McpAgent<WorkerEnv> {
    server!: McpServer;
    async init() {
        // `props.userToken` is populated by resumeAuthorization below.
        const token = (this.props as { userToken?: string }).userToken;
        this.server = createServer("1.0.0", token);
    }
}

export default createOAuthWorker(YourMCP, {
    userIdSource: "sub",
    registerPolicy: {
        requirePkce: true,
        allowedRedirectSchemes: ["https", "http-localhost"],
        rejectIpHosts: true,
        maxRedirectUris: 5,
    },
    async resolveUser(userinfo: GoogleUserInfo, env, _request, oauthReqInfo) {
        if (!userinfo.email_verified || !userinfo.sub) {
            return { reject: "Email not verified" };
        }
        const existing = await (env as WorkerEnv).TOKENS_KV.get(userinfo.sub);
        if (existing) {
            return { userId: userinfo.sub, props: { userToken: existing } };
        }
        // First-time user: bounce to /setup with a signed resume token
        // carrying the parsed OAuth request so we can finish later.
        const rt = await signResumeToken(env, {
            sub: userinfo.sub,
            oauthReqInfo,
        });
        return { redirect: "/setup", resumeToken: rt };
    },
    routes: {
        "/setup": async (request, env, _ctx) => {
            const url = new URL(request.url);
            const rt = url.searchParams.get("rt");
            if (!rt) return new Response("Missing rt", { status: 400 });
            const data = await verifyResumeToken<{
                sub: string;
                oauthReqInfo: unknown;
            }>(env, rt);
            if (!data) return new Response("Expired", { status: 400 });

            if (request.method === "GET") {
                return new Response(
                    `<form method="POST"><input name="token"/><input type="hidden" name="rt" value="${rt}"/><button>Save</button></form>`,
                    { headers: { "content-type": "text/html" } },
                );
            }
            const form = await request.formData();
            const token = String(form.get("token") ?? "");
            await (env as WorkerEnv).TOKENS_KV.put(data.sub, token);
            const { redirectTo } = await resumeAuthorization(
                env,
                data.oauthReqInfo,
                data.sub,
                { userToken: token },
            );
            return Response.redirect(redirectTo, 302);
        },
    },
});
```

Note: when consumer code stores per-user credentials in `props`, they end up in the OAuth grant in KV. That's a deliberate tradeoff for multi-tenant — the single-tenant example above keeps `props: {}` because the DO reads the shared token from `env`.

### `registerPolicy` semantics

- `requirePkce`: enforced at `/authorize` (rejects requests with no `code_challenge`), not at `/register`. DCR doesn't carry PKCE parameters.
- `allowedRedirectSchemes`: scheme strings without trailing colons (e.g. `["https"]`). The literal `"http-localhost"` is a marker permitting `http://localhost` and `http://127.0.0.1`.
- `rejectIpHosts`: rejects raw IPv4 / IPv6 literal hostnames. Loopback (`127.0.0.1`, `[::1]`) is still allowed when `"http-localhost"` is in `allowedRedirectSchemes`.
- `maxRedirectUris`: simple array-length cap.

All four default to "no enforcement", so omitting `registerPolicy` reproduces 0.1.x behavior exactly.

## Security model

Three layers gate access:

1. **Google's "Testing" mode.** Keep your OAuth app in Testing — only listed test users can complete consent. Production mode removes this gate for `openid email` scopes.
2. **`ALLOWED_EMAILS` allowlist.** Even if Google approves, the worker rejects emails that aren't on this list. `email_verified` is required.
3. **HMAC-signed OAuth `state`.** The `state` carries the parsed `oauthReqInfo` + a 10-minute expiration, signed with `STATE_SECRET`. This prevents an attacker from crafting a malicious `/authorize` URL with their own `client_id` / `redirect_uri` (the classic OAuth CSRF).

Other notes:

- **OAuth grants in KV carry no secrets.** The Durable Object reads sensitive credentials from `this.env` directly, so `completeAuthorization` is called with `props: {}` and KV never sees your wrapped server's tokens.
- **Dynamic Client Registration is unauthenticated** at `/register`, per the MCP spec. Owning a `client_id` alone grants nothing — both gates above still apply.
- **`/register` rate limiting is opt-in** via the `REGISTER_LIMITER` binding. Recommended for any publicly addressable worker to prevent KV-quota abuse. Other routes are not rate-limited by this library — add Cloudflare dashboard rules if you need broader coverage.
- **All MCP tools are equally accessible** to any authorized session. There's no per-tool ACL. If your wrapped server exposes destructive operations, gate them inside the tool's handler.

## License

MIT
