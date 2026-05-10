# remote-mcp-cloudflare

Generic Cloudflare Worker template that wraps any **stdio MCP server** with
Google OAuth + email allowlist and exposes it as a **remote MCP endpoint**
that Claude Desktop, the Claude mobile app, or any other MCP-over-HTTP client
can connect to.

The default wiring uses
[`@akutishevsky/lunchmoney-mcp`](https://github.com/akutishevsky/lunchmoney-mcp)
as the demo server (41 tools across the LunchMoney v2 API). To use this
template with a different MCP server, see [Using your own MCP server](#using-your-own-mcp-server)
below — it's a one-file change.

## Why this exists

Most MCP servers in the wild ship as stdio binaries. Claude Desktop can run
those locally; the mobile app cannot. Anthropic's "remote MCP" path expects
a server that speaks Streamable HTTP transport with OAuth 2.1, which is
significantly more involved than stdio. This template stitches together two
Cloudflare libraries — [`workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider)
for OAuth scaffolding and [`agents/mcp`](https://github.com/cloudflare/agents)
for the MCP transport — and adds a small Google OAuth front-end so you can
keep the server private to a known set of gmail addresses.

## Architecture

```
                              ┌──────────────────────────────┐
  Claude Desktop / mobile     │  Cloudflare Worker           │
  ─────────────────────────►  │   ├─ /register               │ ─┐
  (Streamable HTTP + OAuth)   │   ├─ /authorize  ─────────►  │  │  Google
                              │   ├─ /authorize/callback ◄──   │  │  OAuth
                              │   ├─ /token                  │  │  consent
                              │   └─ /mcp  (auth-gated)      │  │
                              │       │                       │
                              │       ▼                       │
                              │   Durable Object              │
                              │     ├─ McpAgent (transport)   │
                              │     └─ McpServer (your tools) │
                              └──────────────────────────────┘
```

`workers-oauth-provider` handles dynamic client registration, code/token
exchange, and bearer-token validation on `/mcp`. The `defaultHandler` (this
template's `worker-app.ts`) implements the consent flow: browser → Google →
email allowlist → `completeAuthorization`. The Durable Object is keyed by
the issued token; on each new token, `init()` runs once and constructs the
underlying MCP server with whatever secrets it needs.

## Prerequisites

- A **Cloudflare account** (free tier is fine).
- A **Google Cloud project** with an OAuth Web Client.
- **Node 22+** (wrangler v4 requires it). On older Node, use the Docker
  recipe at the bottom of this README.

## Quickstart (deploy LunchMoney as the demo server)

### 1. Clone and install

```sh
git clone https://github.com/<you>/remote-mcp-cloudflare.git
cd remote-mcp-cloudflare
npm install
```

> **Note:** the LunchMoney demo dependency currently points at a fork branch
> with the necessary subpath exports. Once those changes land upstream and
> a new `@akutishevsky/lunchmoney-mcp` is published, swap the dep in
> `package.json` to a regular semver range.

### 2. Authenticate wrangler

The cleanest way is a scoped API Token:

1. Visit https://dash.cloudflare.com/profile/api-tokens
2. Create a token with **Workers Scripts:Edit**, **Workers KV Storage:Edit**,
   and **Account:Read** permissions.
3. Export it: `export CLOUDFLARE_API_TOKEN=…`

(Avoid the Global API Key — it grants full account access and is harder to
rotate. If you must use it, set `CLOUDFLARE_EMAIL` and `CLOUDFLARE_API_KEY`.)

### 3. Create the KV namespace and patch wrangler.jsonc

```sh
npx wrangler kv namespace create OAUTH_KV
```

Paste the printed `id` into `wrangler.jsonc` (replaces `REPLACE_WITH_YOUR_KV_ID`).

### 4. First deploy (to mint the workers.dev URL)

```sh
npx wrangler deploy
```

Output gives you `https://remote-mcp-cloudflare.<your-subdomain>.workers.dev`.
The worker is live but `/authorize` will fail until secrets are set —
nobody knows the URL yet, so this is fine.

### 5. Register a Google OAuth Web Client

At https://console.cloud.google.com/apis/credentials:

1. Configure the **OAuth consent screen** (External, Testing mode is
   simplest — add your gmail addresses as test users).
2. Create an **OAuth 2.0 Client ID** of type **Web application**.
3. Add an authorized redirect URI:
   ```
   https://remote-mcp-cloudflare.<your-subdomain>.workers.dev/authorize/callback
   ```
4. Copy the **Client ID** and **Client Secret**.

### 6. Set the secrets

```sh
echo -n "<client-id>"        | npx wrangler secret put GOOGLE_CLIENT_ID
echo -n "<client-secret>"    | npx wrangler secret put GOOGLE_CLIENT_SECRET
echo -n "you@gmail.com"      | npx wrangler secret put ALLOWED_EMAILS
openssl rand -hex 32         | npx wrangler secret put STATE_SECRET
echo -n "<lunchmoney-token>" | npx wrangler secret put LUNCHMONEY_API_TOKEN
```

`ALLOWED_EMAILS` may be a comma-separated list. `STATE_SECRET` is used to
HMAC-sign the OAuth `state` parameter — see [Security](#security) below.

### 7. Connect from claude.ai

claude.ai → **Settings → Connectors → Add custom connector**

URL: `https://remote-mcp-cloudflare.<your-subdomain>.workers.dev/mcp`

The first connect kicks you through Google's consent screen; pick an
allowlisted account and you should land back in claude.ai with the wrapped
server's tools registered.

## Using your own MCP server

The whole template is generic except for one file: **`src/mcp-server.ts`**.

```ts
import { createServer as createBareServer } from "@your-org/your-mcp";
import { initializeConfig } from "@your-org/your-mcp/config";

export interface McpEnv {
    YOUR_API_KEY: string;
    OTHER_SECRET: string;
}

export function createConfiguredServer(env: McpEnv, version: string) {
    initializeConfig(env.YOUR_API_KEY, env.OTHER_SECRET);
    return createBareServer(version);
}
```

Constraints on the wrapped MCP server:

- It must export a `createServer(version: string)` factory that returns an
  `McpServer` (the `@modelcontextprotocol/sdk` type).
- Anything that needs to happen at construction time (token validation,
  config singletons, etc.) should run inside `createConfiguredServer` so
  it's deterministic per Durable Object instance.
- Avoid module-level `process.env` reads inside the wrapped server — those
  don't run reliably in Worker isolates. Pass values in via the factory
  signature instead.

Then update `package.json` deps and re-run `npm install`. No worker code
changes are needed.

## Local development

```sh
cp .dev.vars.example .dev.vars
# fill in real values
npx wrangler dev
```

`wrangler dev` runs the worker locally against real KV (remote-bound) and
real Durable Objects. It's the highest-fidelity dev environment — but it
**does** consume your Cloudflare account quota, so don't lean on it for
load testing.

To complete the OAuth dance against the local worker, register the local
URL (`http://localhost:8787/authorize/callback`) as a redirect URI in the
same Google client — Google allows multiple redirect URIs per client.

## Security

The defaults bake in three layers:

1. **Google's "Testing" mode.** Only listed test users can complete Google
   consent. Promoting the OAuth app to "In production" removes this gate
   (only `openid email` scopes work without verification). Keep it in
   Testing unless you've thought about it.
2. **`ALLOWED_EMAILS` allowlist.** Even if Google lets someone through, the
   worker rejects emails that aren't on this list. `email_verified` is
   required.
3. **HMAC-signed OAuth `state`.** The `state` parameter sent to Google
   carries the parsed `oauthReqInfo` and an expiration, signed with
   `STATE_SECRET`. This prevents an attacker from crafting a malicious
   `/authorize` URL with their own `client_id` / `redirect_uri` (the
   classic OAuth CSRF). State expires after 10 minutes.

Other notes:

- **Tokens are stored in KV.** `workers-oauth-provider` keeps issued tokens
  there with TTLs. The OAuth grant `props` are intentionally **empty** in
  this template — secrets are read from env inside the Durable Object so
  they never get serialized into KV grants.
- **Dynamic Client Registration is unauthenticated** at `/register`, per
  the MCP spec. Owning a `client_id` alone gives nothing — the auth flow
  still has to pass both gates above.
- **No rate limiting** is configured. If you make the worker public, add
  a Cloudflare Rate Limiting rule on `/register` to prevent KV-quota abuse.
- **All MCP tools are equally accessible** to any authorized session. There
  is no per-tool ACL. If your wrapped server exposes destructive operations,
  consider gating them with an additional check inside the tool's handler.

## Old Node? Use the Docker recipe

If you're on Node 18 or 20, `wrangler@4` won't run natively. Run it through
a Node 22 container:

```sh
docker run --rm -e CLOUDFLARE_API_TOKEN \
  -v "$PWD:/app" -w /app \
  node:22 npx wrangler@4 deploy
```

Apply the same pattern to `kv namespace create`, `secret put`, `dev`,
`tail`, etc. For interactive `secret put`, add `-i`.

## Operational notes

- **`wrangler tail`** streams live logs from the deployed worker, including
  full request/response bodies for OAuth flow steps. Run it while clicking
  through the consent flow if something goes wrong.
- **Log retention** is governed by Cloudflare's Workers Observability
  settings (default in `wrangler.jsonc`: enabled).
- **Cost.** This setup runs entirely on the Cloudflare free tier for
  personal use: Workers free tier is 100k req/day, KV is 1k writes/day,
  Durable Objects on the SQLite-backed class are free up to small request
  volumes. The OAuth flow makes ~3 KV writes per fresh authorization, so
  you'd have to reauth thousands of times a day to hit limits.

## License

MIT
