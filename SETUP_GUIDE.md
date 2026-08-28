# Instantly.ai → Claude Custom Connector — Complete Setup Guide

This is a **step-by-step, self-contained guide** to build the Instantly.ai MCP server,
host it on Railway, and connect it to a Claude account as a custom connector. It is
written so that **both a person and an AI assistant (e.g. Claude Code) can follow it
end-to-end**, and it includes every gotcha we hit the first time so you don't repeat them.

> **What this produces:** a hosted server that wraps the Instantly.ai API and exposes it
> to Claude as 16 tools (campaign analytics, A/B step analysis, daily trends, leads, lead
> lists, replies/unibox, sending-account/warmup deliverability, plus a raw-API escape
> hatch). Claude never sees the Instantly API key — it stays on the server.

---

## Table of contents

1. [How it works (architecture)](#1-how-it-works-architecture)
2. [Prerequisites](#2-prerequisites)
3. [Get the code (two paths)](#3-get-the-code-two-paths)
4. [Deploy to Railway](#4-deploy-to-railway)
5. [Set environment variables](#5-set-environment-variables)
6. [Generate a domain & verify the server](#6-generate-a-domain--verify-the-server)
7. [Connect it to Claude — the critical part](#7-connect-it-to-claude--the-critical-part)
8. [Verify end-to-end](#8-verify-end-to-end)
9. [Troubleshooting (every error we hit)](#9-troubleshooting-every-error-we-hit)
10. [Multiple Claude accounts & per-person tokens](#10-multiple-claude-accounts--per-person-tokens)
11. [Tool reference (all 16)](#11-tool-reference-all-16)
12. [Maintenance & updates](#12-maintenance--updates)
13. [Appendix A — full source code](#appendix-a--full-source-code)
14. [Appendix B — one-shot prompt to rebuild with an AI](#appendix-b--one-shot-prompt-to-rebuild-with-an-ai)

---

## 1. How it works (architecture)

```
┌────────────┐     MCP over HTTPS      ┌──────────────────────┐   Instantly API v2   ┌───────────────┐
│  Claude    │  POST /mcp  +           │  MCP server on       │   Bearer <API key>   │  Instantly.ai │
│ (account)  │  x-api-key: <token>     │  Railway (Node/TS)   │  ──────────────────► │   API         │
│            │ ──────────────────────► │                      │                      │               │
└────────────┘                         └──────────────────────┘                      └───────────────┘
        the token authenticates              holds INSTANTLY_API_KEY
        Claude → your server                 (never exposed to Claude)
```

- **Transport:** stateless **Streamable HTTP** at `POST /mcp` (what Claude custom
  connectors speak). A legacy SSE transport (`GET /sse` + `POST /messages`) is also
  included for older clients.
- **Two secrets, two jobs:**
  - `INSTANTLY_API_KEY` — the server uses this to call Instantly. Server-side only.
  - `MCP_AUTH_TOKEN` — the shared secret Claude must present to use the server. Supports
    multiple comma-separated tokens (one per person/account).
- **Read-first by design:** all tools are reads/analytics except one guarded raw-request
  tool limited to GET/POST (no destructive PATCH/DELETE).

---

## 2. Prerequisites

Collect these before you start:

| Thing | Where to get it | Notes |
|---|---|---|
| **Instantly API v2 key** | Instantly → **Settings → Integrations → API Keys** → create a **V2** key | Requires Instantly **Growth plan or above** for API v2. Copy it once. |
| **GitHub account** | github.com | To host the repo Railway deploys from. |
| **Railway account** | railway.app | Free/Hobby tier is fine for a small team. |
| **Claude paid plan** | claude.ai | Custom connectors require a plan that supports them (Pro/Team/Enterprise). |
| **An MCP auth token** | Generate one (see §5) | A long random string you invent; not from any provider. |

---

## 3. Get the code (two paths)

### Path A — reuse the existing repo (fastest)

The reference implementation lives at **`github.com/igetobi/client-acquisition`**
(branch `claude/instantly-ai-custom-mcp-opofmd`, or `main` if it's been merged). If you
have access, you can point Railway straight at it (see §4) or fork it into another org.

### Path B — build it from scratch

If the second account/team can't access that repo, recreate it. Create a new empty repo
and add the files exactly as listed in **[Appendix A](#appendix-a--full-source-code)**.
The file tree is:

```
.
├── src/
│   ├── index.ts        # HTTP server: /mcp, /sse, auth gate, logging, health
│   ├── server.ts       # MCP server + all 16 tool definitions
│   └── instantly.ts    # thin Instantly API v2 client
├── package.json
├── package-lock.json   # run `npm install` to generate this
├── tsconfig.json
├── Dockerfile
├── railway.json
├── .dockerignore
├── .gitignore
└── .env.example
```

Then locally:

```bash
npm install          # installs deps and creates package-lock.json
npm run build        # compiles TypeScript → dist/ (must succeed with no errors)
```

Commit and push to GitHub. **An AI assistant can do all of Path B automatically** using
the prompt in [Appendix B](#appendix-b--one-shot-prompt-to-rebuild-with-an-ai).

> ℹ️ You do **not** commit `node_modules/`, `dist/`, or `.env` — they're in `.gitignore`.
> Railway builds `dist/` itself inside the Docker image.

---

## 4. Deploy to Railway

1. Go to **railway.app** → **New Project**.
2. Choose **Deploy from GitHub repo** → select your repo (`client-acquisition` or your fork).
3. If prompted for a branch, pick the branch that has the code.
4. Railway detects the **`Dockerfile`** automatically and starts building. The build
   config is pinned in `railway.json`:
   - Builder: **Dockerfile**
   - Start command: `node dist/index.js`
   - Healthcheck path: `/healthz`
5. **Important — Root Directory:** leave it **blank/empty**. The `Dockerfile`,
   `package.json`, and `railway.json` are all at the repo root. (If you ever see `/src`
   typed in the Root Directory field, clear it, or the build won't find the Dockerfile.)
6. **Do NOT set a `PORT` variable** — Railway injects `PORT` automatically and the server
   reads it. Setting your own can cause a port mismatch.

The service will show **🟢 Online** once the build finishes and the `/healthz` healthcheck
passes.

---

## 5. Set environment variables

In the Railway service → **Variables** tab → add:

| Variable | Required | Value |
|---|---|---|
| `INSTANTLY_API_KEY` | ✅ Yes | Your Instantly **v2** API key. |
| `MCP_AUTH_TOKEN` | ✅ Strongly recommended | One long random token, **or** several comma-separated (one per person). |
| `INSTANTLY_BASE_URL` | Optional | Only to override the default `https://api.instantly.ai/api/v2`. |

### Generating a clean token

Use a token with **no spaces, no line breaks, and no commas inside it** (commas separate
multiple tokens). Any of these work:

```bash
# Option 1: Node
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"

# Option 2: OpenSSL
openssl rand -hex 24
```

Example single token: `c5d906931e27c53e723b552448fc063811c93a5f76d64814`

> ⚠️ **Gotcha we hit:** if you paste a multi-token value and the field visually wraps,
> make sure no real newline got inserted *inside* a token. Safest: start with **one**
> clean token, confirm it connects, then add more (see §10). The exact same string must
> appear in Railway **and** in Claude — a single character mismatch causes a `401`.

After adding/editing variables, **click Deploy** (Railway shows a pending "Apply changes /
Deploy"). Variable changes only take effect after a redeploy. Wait for **🟢 Online**.

---

## 6. Generate a domain & verify the server

1. Railway service → **Settings → Networking → Public Networking → Generate Domain**.
   You'll get something like `https://<your-app>.up.railway.app`.
2. Open **`https://<your-app>.up.railway.app/healthz`** in a browser. You must see:
   ```json
   {"ok":true,"server":"instantly-ai","version":"1.2.0"}
   ```
   - If it loads → server is live. Note the `version` — it confirms which build is running
     (bump the version in code whenever you want to prove a redeploy went out).
   - If it doesn't load → check Railway **Deployments** (building? failed? crashed?) and
     the build/deploy logs.

Your **MCP endpoint** is that domain + **`/mcp`**:
```
https://<your-app>.up.railway.app/mcp
```

---

## 7. Connect it to Claude — the critical part

This is where the first setup went wrong several times. Follow it **exactly**.

In Claude: **Settings → Connectors → Add custom connector**.

1. **Name:** `Instantly` (or anything).
2. **URL:** the MCP endpoint **without any token in it**:
   ```
   https://<your-app>.up.railway.app/mcp
   ```
3. **Authentication: choose `None`.**
   - ❗ Claude will likely auto-select **"Always required (Detected)"**. **Do not use it.**
     That option triggers an **OAuth** sign-in flow, which this server does **not**
     implement, and the connection will fail.
   - `None` is correct because this server authenticates with an **API-key header**, not
     OAuth. (Claude's own hint under `None` says: *"…or for servers that use an API key
     instead of OAuth."*)
4. **Request headers → Add header:**
   - **Name:** `x-api-key`
   - **Value:** the exact token from `MCP_AUTH_TOKEN` (raw token, **no** "Bearer" prefix)
   - Leave "Required" checked.
5. Click **Add**, then **Connect**.

### Why a header and not the URL

The server also accepts a `?token=` in the URL, **but Claude's connection-check does not
forward the query string**, so it returns `401` and the setup fails. A configured
**request header is sent on every request** (including the check), so the header method is
the one that works. The server accepts the token via any of:

- `x-api-key: <token>`  ← **use this**
- `x-mcp-token: <token>`
- `Authorization: Bearer <token>`
- `?token=<token>` (works for tool calls, but **not** for Claude's setup check — avoid)

### After connecting

- Claude shows the connector with a **Disconnect** button and lists **16 tools** under
  **Tool permissions**.
- Tools default to **"Needs approval."** Since every tool is read-only, you may switch the
  dropdown to **"Always allow"** if you don't want to approve each call.
- If you add tools later (new server version), open the connector's **⋮ menu → Refresh** to
  re-pull the tool list ("Tools list refreshed").

---

## 8. Verify end-to-end

Open a normal Claude chat (with the connector enabled) and try:

- `Using Instantly, list my campaigns.`
- `Show me open and reply rates for all active campaigns this month.`
- `Compare the subject-line variants in <campaign> and tell me which is winning.` *(A/B steps)*
- `Show me my lead lists.`

**If tools run but return an Instantly `401`/`403`:** the connector is fine — the problem
is the `INSTANTLY_API_KEY`. Regenerate a v2 key in Instantly and update the Railway
variable (then redeploy).

---

## 9. Troubleshooting (every error we hit)

| Symptom in Claude / Railway | Cause | Fix |
|---|---|---|
| **"Always required — Detected"** auto-selected | Server returns `401` without a token, which Claude reads as "wants OAuth." | Manually select **Authentication: None** and use the `x-api-key` header. |
| **"…set up as not requiring sign-in, but the server asked for sign-in (status 401)"** | You put the token only in the **URL** (`?token=`); Claude's check drops the query string. | Move the token to the **`x-api-key` request header**; use a plain `/mcp` URL. |
| **"Couldn't reach Instantly.ai"** right after a redeploy | You clicked Connect while Railway was mid-deploy (brief unreachable window). | Wait for **🟢 Online**, confirm `/healthz`, click Connect again. |
| **"Couldn't reach Instantly.ai"** but `/healthz` works in browser | The `x-api-key` **value doesn't match** `MCP_AUTH_TOKEN` in Railway → server returns `401`. | Make the token **identical** in both places (re-paste fresh). Check Railway **Network Logs**: a `POST /mcp → 401` confirms a token mismatch. |
| Railway **Network Logs** show `POST /mcp 401` | Token mismatch or wrong header. | Align the token; ensure header name is exactly `x-api-key`. |
| Railway **Deploy Logs** show `[req] POST /mcp cred=none` | No credential arrived — header not configured on the Claude side. | Add the `x-api-key` header in the connector. |
| Railway **Deploy Logs** show `[req] ... cred=x-api-key` **but** Network Logs show `401` | Header arrived but value doesn't match. | Fix the token value to match exactly. |
| Build fails on Railway | Root Directory set to `/src`, or Dockerfile not found. | Clear **Root Directory** (leave blank); Dockerfile is at repo root. |
| Server crashes on start: `FATAL: INSTANTLY_API_KEY is not set` | Missing required variable. | Set `INSTANTLY_API_KEY` in Railway and redeploy. |
| Tools call succeeds but returns Instantly `401/403` | `INSTANTLY_API_KEY` invalid/expired, or plan lacks API v2. | Regenerate a v2 key (Growth plan+) and update the variable. |

**How to read the built-in logging:** every request logs a line like
`[req] POST /mcp cred=x-api-key rpc=initialize accept="application/json, text/event-stream"`.
`cred=` tells you which credential channel arrived (or `none`); token **values are never
logged**. Railway → service → **Deployments → View Logs** (app logs) and the **Network
Logs** tab (HTTP status per request) are your two diagnostic views.

---

## 10. Multiple Claude accounts & per-person tokens

The server is one URL; **any number of Claude accounts connect to the same deployment** —
no redeploy needed. They all share the one Instantly account behind `INSTANTLY_API_KEY`.

**Per-person revocable tokens:** set `MCP_AUTH_TOKEN` to several tokens, comma-separated,
**on one line, no spaces:**

```
c5d906931e27c53e723b552448fc063811c93a5f76d64814,a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718
```

- Give each person their own token to put in **their** connector's `x-api-key` header.
- **To revoke one person:** remove their token (and its comma) from `MCP_AUTH_TOKEN`,
  then redeploy. The others keep working.
- **Do NOT delete the whole `MCP_AUTH_TOKEN` variable** to revoke — an empty value makes
  the server **open** (no auth). To kill all access, replace it with a fresh token instead.

---

## 11. Tool reference (all 16)

| Tool | Purpose |
|---|---|
| `list_campaigns` | Find campaigns and their IDs. |
| `get_campaign` | Full config/status of one campaign. |
| `get_campaign_analytics` | Per-campaign totals: leads, contacted, opens, replies, clicks, bounces, unsubscribes, sent. Main tool for comparing campaigns. |
| `get_campaign_analytics_overview` | One rolled-up account-health summary. |
| `get_daily_campaign_analytics` | Day-by-day trend data (measure effect of a change on a date). |
| `get_campaign_steps_analytics` | **A/B testing:** per-step, per-variant metrics — pick the winning subject line / copy. |
| `list_leads` | List/search leads (optionally by campaign or lead list). |
| `get_lead` | One lead, with status and custom variables. |
| `list_lead_lists` | Saved lead lists by niche (find IDs, avoid duplicating). |
| `get_lead_list` | One lead list's details. |
| `list_emails` | Unibox: sent mail and prospect replies. |
| `get_email` | Full content of one email. |
| `list_accounts` | Sending inboxes with status/warmup (spot disconnected ones). |
| `get_account` | One sending account's details. |
| `get_warmup_analytics` | Warmup/deliverability health for sending accounts. |
| `instantly_api_request` | Guarded escape hatch (GET/POST only) for any endpoint without a dedicated tool. |

Instantly API v2 base: `https://api.instantly.ai/api/v2` (Bearer auth). Dates are
`YYYY-MM-DD`. Tools return raw Instantly JSON so Claude reasons over exact field names.

---

## 12. Maintenance & updates

- **Auto-deploy:** Railway is connected to the GitHub branch with **"Auto deploys when
  pushed to GitHub"** on. Push a commit → Railway rebuilds and redeploys.
- **Prove a deploy went live:** bump `SERVER_VERSION` in `src/server.ts` (and `version`
  in `package.json`), push, then check `/healthz` shows the new version.
- **Add a tool:** add another `server.registerTool(...)` block in `src/server.ts`
  (copy an existing one), `npm run build` to verify, push, wait for deploy, then
  **Refresh** the connector in Claude.
- **Rotate the auth token:** change `MCP_AUTH_TOKEN` in Railway, redeploy, update the
  `x-api-key` header in each connector.

---

## Appendix A — full source code

Create each file exactly as below. After creating them, run `npm install` (generates
`package-lock.json`) and `npm run build` (must succeed).

### `package.json`

```json
{
  "name": "instantly-mcp-server",
  "version": "1.2.0",
  "description": "Custom Model Context Protocol (MCP) server for Instantly.ai, hostable on Railway and connectable to Claude as a custom connector.",
  "type": "module",
  "engines": {
    "node": ">=20"
  },
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "dev": "tsc -w -p tsconfig.json & node --watch dist/index.js",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.17.0",
    "express": "^4.21.2",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^20.14.0",
    "typescript": "^5.5.4"
  }
}
```

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": false
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

### `Dockerfile`

```dockerfile
# ---- Build stage ----
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Runtime stage ----
FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist

# Railway sets PORT at runtime; default to 3000 locally.
ENV PORT=3000
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

### `railway.json`

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "DOCKERFILE",
    "dockerfilePath": "Dockerfile"
  },
  "deploy": {
    "startCommand": "node dist/index.js",
    "healthcheckPath": "/healthz",
    "healthcheckTimeout": 100,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 10
  }
}
```

### `.gitignore`

```gitignore
node_modules/
dist/
.env
.env.local
*.log
.DS_Store
```

### `.dockerignore`

```gitignore
node_modules
dist
.git
.env
.env.local
*.log
npm-debug.log*
.DS_Store
```

### `.env.example`

```bash
# ---- Instantly.ai MCP server configuration ----

# REQUIRED. Your Instantly.ai API v2 key.
# Get it in Instantly: Settings -> Integrations -> API Keys (create a v2 key).
# This is used server-side only and is never exposed to Claude.
INSTANTLY_API_KEY=

# OPTIONAL (recommended). Secret token(s) clients must present to use this server.
# If set, Claude must send it as an x-api-key header (or Authorization: Bearer).
# You can set MULTIPLE tokens, comma-separated, one per person / Claude account.
#   MCP_AUTH_TOKEN=tok_ashley_9f3k...,tok_izzy_2m7p...,tok_mildred_1q8x...
MCP_AUTH_TOKEN=

# OPTIONAL. Override the Instantly API base URL. Defaults to the v2 API.
# INSTANTLY_BASE_URL=https://api.instantly.ai/api/v2

# OPTIONAL. Port. Railway sets this automatically; default is 3000 locally.
# PORT=3000
```

### `src/instantly.ts`

```typescript
/**
 * Thin, typed wrapper around the Instantly.ai API (v2).
 *
 * Docs: https://developer.instantly.ai/api/v2
 * Base URL: https://api.instantly.ai/api/v2
 * Auth:     Authorization: Bearer <API_KEY>
 *
 * The API key is read from the INSTANTLY_API_KEY environment variable and is
 * only ever used server-side. It is never exposed to the MCP client (Claude).
 */

const DEFAULT_BASE_URL = "https://api.instantly.ai/api/v2";

export class InstantlyError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "InstantlyError";
    this.status = status;
    this.body = body;
  }
}

export interface InstantlyClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
}

export type QueryValue = string | number | boolean | undefined | null | Array<string | number>;
export type Query = Record<string, QueryValue>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
}

export class InstantlyClient {
  private apiKey: string;
  private baseUrl: string;
  private timeoutMs: number;

  constructor(opts: InstantlyClientOptions) {
    if (!opts.apiKey) {
      throw new Error("INSTANTLY_API_KEY is required to create an InstantlyClient.");
    }
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  private buildUrl(path: string, query?: Query): string {
    const cleanPath = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(this.baseUrl + cleanPath);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
          // Instantly repeats the key for array params, e.g. ?id=a&id=b
          for (const item of value) url.searchParams.append(key, String(item));
        } else {
          url.searchParams.append(key, String(value));
        }
      }
    }
    return url.toString();
  }

  async request<T = unknown>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    opts: RequestOptions = {},
  ): Promise<T> {
    const url = this.buildUrl(path, opts.query);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
    };
    let bodyInit: string | undefined;
    if (opts.body !== undefined && method !== "GET") {
      headers["Content-Type"] = "application/json";
      bodyInit = JSON.stringify(opts.body);
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: bodyInit,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof Error && err.name === "AbortError") {
        throw new InstantlyError(0, `Request to Instantly timed out after ${this.timeoutMs}ms`, null);
      }
      throw new InstantlyError(0, `Network error calling Instantly: ${(err as Error).message}`, null);
    }
    clearTimeout(timeout);

    const text = await res.text();
    let parsed: unknown = text;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // leave as text
      }
    }

    if (!res.ok) {
      const msg =
        (parsed && typeof parsed === "object" && "message" in parsed
          ? String((parsed as Record<string, unknown>).message)
          : `Instantly API returned HTTP ${res.status}`);
      throw new InstantlyError(res.status, msg, parsed);
    }

    return parsed as T;
  }

  // ---- Convenience wrappers -------------------------------------------------

  get<T = unknown>(path: string, query?: Query) {
    return this.request<T>("GET", path, { query });
  }
  post<T = unknown>(path: string, body?: unknown, query?: Query) {
    return this.request<T>("POST", path, { body, query });
  }
}
```

### `src/server.ts`

```typescript
/**
 * Builds an MCP server instance exposing Instantly.ai as a set of tools.
 *
 * The tools are read-first and analytics-focused, which is what the
 * client-acquisition workflow needs: pull campaign metrics, compare
 * A/B (step/variant) performance, read replies, monitor deliverability,
 * and query leads. A guarded generic escape hatch is included for
 * endpoints not yet given a first-class tool.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { InstantlyClient, InstantlyError, type Query } from "./instantly.js";

const SERVER_NAME = "instantly-ai";
const SERVER_VERSION = "1.2.0";

/** Format any value as a pretty JSON tool result. */
function jsonResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

/** Wrap a tool handler with consistent Instantly error reporting. */
function safe<T>(fn: (args: T) => Promise<unknown>) {
  return async (args: T) => {
    try {
      const data = await fn(args);
      return jsonResult(data);
    } catch (err) {
      if (err instanceof InstantlyError) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Instantly API error (HTTP ${err.status}): ${err.message}\n\n${JSON.stringify(
                err.body,
                null,
                2,
              )}`,
            },
          ],
        };
      }
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Unexpected error: ${(err as Error).message}` }],
      };
    }
  };
}

export function buildServer(client: InstantlyClient): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Tools for Instantly.ai cold-email campaigns. Use the analytics tools to measure " +
        "open/reply/bounce rates, compare sequence steps and A/B variants (get_campaign_steps_analytics), " +
        "track trends over time (get_daily_campaign_analytics), read replies (list_emails), " +
        "monitor sender deliverability/warmup (list_accounts, get_warmup_analytics), and query leads " +
        "(list_leads). Dates use YYYY-MM-DD. Prefer the specific tools; use instantly_api_request " +
        "only for endpoints without a dedicated tool.",
    },
  );

  // ---- Campaigns ------------------------------------------------------------

  server.registerTool(
    "list_campaigns",
    {
      title: "List campaigns",
      description:
        "List email campaigns with id, name and status. Use this first to find campaign IDs " +
        "for the analytics tools. Supports search and pagination.",
      inputSchema: {
        search: z.string().optional().describe("Filter campaigns by name."),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (default 20)."),
        starting_after: z
          .string()
          .optional()
          .describe("Pagination cursor: the id of the last item from the previous page."),
        tag_ids: z.array(z.string()).optional().describe("Filter by tag IDs."),
      },
    },
    safe(async (a) =>
      client.get("/campaigns", {
        search: a.search,
        limit: a.limit ?? 20,
        starting_after: a.starting_after,
        tag_ids: a.tag_ids,
      } as Query),
    ),
  );

  server.registerTool(
    "get_campaign",
    {
      title: "Get campaign",
      description: "Get full configuration and status for a single campaign by ID.",
      inputSchema: {
        campaign_id: z.string().describe("The campaign ID (UUID)."),
      },
    },
    safe(async (a) => client.get(`/campaigns/${encodeURIComponent(a.campaign_id)}`)),
  );

  // ---- Analytics ------------------------------------------------------------

  server.registerTool(
    "get_campaign_analytics",
    {
      title: "Get campaign analytics",
      description:
        "Per-campaign totals: leads, contacted, opens, replies, link clicks, bounces, " +
        "unsubscribes, completed and emails sent. Omit campaign_ids for all campaigns. " +
        "Optionally scope to a date range. This is the main tool for comparing whole campaigns.",
      inputSchema: {
        campaign_ids: z
          .array(z.string())
          .optional()
          .describe("One or more campaign IDs. Omit for all campaigns."),
        start_date: z.string().optional().describe("Start date (YYYY-MM-DD)."),
        end_date: z.string().optional().describe("End date (YYYY-MM-DD)."),
        campaign_status: z
          .number()
          .int()
          .optional()
          .describe("Filter by campaign status code (e.g. 1=active, 2=paused, 3=completed)."),
        include_opportunities: z
          .boolean()
          .optional()
          .describe("Include opportunity/CRM counts in the response."),
      },
    },
    safe(async (a) =>
      client.get("/campaigns/analytics", {
        id: a.campaign_ids,
        start_date: a.start_date,
        end_date: a.end_date,
        campaign_status: a.campaign_status,
        expand_crm_events: a.include_opportunities,
      } as Query),
    ),
  );

  server.registerTool(
    "get_campaign_analytics_overview",
    {
      title: "Get analytics overview",
      description:
        "Aggregated analytics across campaigns (a single rolled-up summary rather than per-campaign rows). " +
        "Useful for an at-a-glance account health snapshot.",
      inputSchema: {
        campaign_ids: z.array(z.string()).optional().describe("Scope to specific campaign IDs."),
        start_date: z.string().optional().describe("Start date (YYYY-MM-DD)."),
        end_date: z.string().optional().describe("End date (YYYY-MM-DD)."),
        campaign_status: z.number().int().optional().describe("Filter by campaign status code."),
      },
    },
    safe(async (a) =>
      client.get("/campaigns/analytics/overview", {
        id: a.campaign_ids,
        start_date: a.start_date,
        end_date: a.end_date,
        campaign_status: a.campaign_status,
      } as Query),
    ),
  );

  server.registerTool(
    "get_daily_campaign_analytics",
    {
      title: "Get daily campaign analytics",
      description:
        "Day-by-day metrics (date, sent, opened, unique_opened, replies, unique_replies, clicks, " +
        "unique_clicks). Use this to see trends over time and to check the effect of a change made " +
        "on a specific date.",
      inputSchema: {
        campaign_id: z.string().optional().describe("Campaign ID. Omit for all campaigns."),
        start_date: z.string().optional().describe("Start date (YYYY-MM-DD)."),
        end_date: z.string().optional().describe("End date (YYYY-MM-DD)."),
        campaign_status: z.number().int().optional().describe("Filter by campaign status code."),
      },
    },
    safe(async (a) =>
      client.get("/campaigns/analytics/daily", {
        campaign_id: a.campaign_id,
        start_date: a.start_date,
        end_date: a.end_date,
        campaign_status: a.campaign_status,
      } as Query),
    ),
  );

  server.registerTool(
    "get_campaign_steps_analytics",
    {
      title: "Get step / variant analytics (A/B tests)",
      description:
        "Per-sequence-step and per-variant metrics (step, variant, sent, opened, unique_opened, " +
        "replies, unique_replies, clicks, unique_clicks). This is the tool for evaluating split " +
        "tests: compare subject-line or copy variants within a step to decide the winner before " +
        "changing the next variable.",
      inputSchema: {
        campaign_id: z.string().optional().describe("Campaign ID. Omit for all campaigns."),
        start_date: z.string().optional().describe("Start date (YYYY-MM-DD)."),
        end_date: z.string().optional().describe("End date (YYYY-MM-DD)."),
      },
    },
    safe(async (a) =>
      client.get("/campaigns/analytics/steps", {
        campaign_id: a.campaign_id,
        start_date: a.start_date,
        end_date: a.end_date,
      } as Query),
    ),
  );

  // ---- Leads ----------------------------------------------------------------

  server.registerTool(
    "list_leads",
    {
      title: "List / search leads",
      description:
        "List leads, optionally scoped to a campaign or lead list, with search and status filters. " +
        "Returns lead records (email, name, company, status, custom variables).",
      inputSchema: {
        campaign_id: z.string().optional().describe("Restrict to leads in this campaign."),
        list_id: z.string().optional().describe("Restrict to leads in this lead list."),
        search: z.string().optional().describe("Free-text search (email, name, company)."),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (default 20)."),
        starting_after: z.string().optional().describe("Pagination cursor from a previous page."),
        filter: z
          .record(z.any())
          .optional()
          .describe("Advanced filter object passed straight through to the Instantly leads filter."),
      },
    },
    safe(async (a) =>
      client.post("/leads/list", {
        campaign: a.campaign_id,
        list_id: a.list_id,
        search: a.search,
        limit: a.limit ?? 20,
        starting_after: a.starting_after,
        ...(a.filter ?? {}),
      }),
    ),
  );

  server.registerTool(
    "get_lead",
    {
      title: "Get lead",
      description: "Get a single lead by ID, including status and all custom variables.",
      inputSchema: {
        lead_id: z.string().describe("The lead ID."),
      },
    },
    safe(async (a) => client.get(`/leads/${encodeURIComponent(a.lead_id)}`)),
  );

  // ---- Lead lists -----------------------------------------------------------

  server.registerTool(
    "list_lead_lists",
    {
      title: "List lead lists",
      description:
        "List saved lead lists (e.g. by niche: plumbers, roofing, window installation). Use this " +
        "to find list IDs, reference existing lists, or avoid duplicating a niche already built. " +
        "Pass a list_id from here to list_leads to see the leads inside a list.",
      inputSchema: {
        search: z.string().optional().describe("Filter lead lists by name."),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (default 20)."),
        starting_after: z.string().optional().describe("Pagination cursor from a previous page."),
      },
    },
    safe(async (a) =>
      client.get("/lead-lists", {
        search: a.search,
        limit: a.limit ?? 20,
        starting_after: a.starting_after,
      } as Query),
    ),
  );

  server.registerTool(
    "get_lead_list",
    {
      title: "Get lead list",
      description: "Get a single lead list by ID, including its name and metadata.",
      inputSchema: {
        list_id: z.string().describe("The lead list ID."),
      },
    },
    safe(async (a) => client.get(`/lead-lists/${encodeURIComponent(a.list_id)}`)),
  );

  // ---- Emails / replies -----------------------------------------------------

  server.registerTool(
    "list_emails",
    {
      title: "List emails / replies",
      description:
        "List emails sent and received (the unibox). Use this to read prospect replies and " +
        "message threads. Filter by campaign or sending account.",
      inputSchema: {
        campaign_id: z.string().optional().describe("Restrict to a campaign."),
        eaccount: z.string().optional().describe("Restrict to a sending account email address."),
        search: z.string().optional().describe("Free-text search over emails."),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (default 20)."),
        starting_after: z.string().optional().describe("Pagination cursor from a previous page."),
        i_status: z
          .number()
          .int()
          .optional()
          .describe("Interest status filter (e.g. interested / not interested codes)."),
      },
    },
    safe(async (a) =>
      client.get("/emails", {
        campaign_id: a.campaign_id,
        eaccount: a.eaccount,
        search: a.search,
        limit: a.limit ?? 20,
        starting_after: a.starting_after,
        i_status: a.i_status,
      } as Query),
    ),
  );

  server.registerTool(
    "get_email",
    {
      title: "Get email",
      description: "Get the full content of a single email/message by ID.",
      inputSchema: {
        email_id: z.string().describe("The email ID."),
      },
    },
    safe(async (a) => client.get(`/emails/${encodeURIComponent(a.email_id)}`)),
  );

  // ---- Sending accounts / deliverability ------------------------------------

  server.registerTool(
    "list_accounts",
    {
      title: "List sending accounts",
      description:
        "List connected sending accounts (inboxes) with status and warmup info. Use this to " +
        "monitor deliverability and spot disconnected or paused inboxes.",
      inputSchema: {
        search: z.string().optional().describe("Filter by email address."),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (default 20)."),
        starting_after: z.string().optional().describe("Pagination cursor from a previous page."),
        tag_ids: z.array(z.string()).optional().describe("Filter by tag IDs."),
      },
    },
    safe(async (a) =>
      client.get("/accounts", {
        search: a.search,
        limit: a.limit ?? 20,
        starting_after: a.starting_after,
        tag_ids: a.tag_ids,
      } as Query),
    ),
  );

  server.registerTool(
    "get_account",
    {
      title: "Get sending account",
      description: "Get details for a single sending account by its email address.",
      inputSchema: {
        email: z.string().describe("The sending account email address."),
      },
    },
    safe(async (a) => client.get(`/accounts/${encodeURIComponent(a.email)}`)),
  );

  server.registerTool(
    "get_warmup_analytics",
    {
      title: "Get warmup analytics",
      description:
        "Warmup performance for one or more sending accounts (health / deliverability signal). " +
        "Provide the account email addresses to inspect.",
      inputSchema: {
        emails: z.array(z.string()).min(1).describe("Sending account email addresses."),
      },
    },
    safe(async (a) => client.post("/accounts/warmup-analytics", { emails: a.emails })),
  );

  // ---- Generic escape hatch (guarded) --------------------------------------

  server.registerTool(
    "instantly_api_request",
    {
      title: "Raw Instantly API request",
      description:
        "Power tool: call any Instantly API v2 endpoint not covered by a dedicated tool. " +
        "Only GET and POST are allowed (no mutations via PATCH/DELETE). Path is relative to " +
        "the API v2 base, e.g. '/campaigns' or '/leads/list'.",
      inputSchema: {
        method: z.enum(["GET", "POST"]).describe("HTTP method."),
        path: z.string().describe("Path relative to https://api.instantly.ai/api/v2, e.g. '/campaigns'."),
        query: z
          .record(z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]))
          .optional()
          .describe("Query parameters."),
        body: z.record(z.any()).optional().describe("JSON body (POST only)."),
      },
    },
    safe(async (a) => {
      const path = a.path.replace(/^\/api\/v2/, "");
      return client.request(a.method, path, { query: a.query as Query, body: a.body });
    }),
  );

  return server;
}

export { SERVER_NAME, SERVER_VERSION };
```

### `src/index.ts`

```typescript
/**
 * HTTP entrypoint for the Instantly.ai MCP server.
 *
 * Exposes:
 *   - POST /mcp            Streamable HTTP transport (modern, used by Claude custom connectors)
 *   - GET  /sse            Legacy SSE transport (open a stream)
 *   - POST /messages       Legacy SSE transport (client -> server messages)
 *   - GET  /healthz        Health check for Railway
 *   - GET  /               Human-readable info page
 *
 * Auth: if MCP_AUTH_TOKEN is set, every MCP request must present the token via an
 * x-api-key / x-mcp-token / Authorization: Bearer header, or a ?token= query param.
 * The Instantly API key (INSTANTLY_API_KEY) is used server-side only.
 */
import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { InstantlyClient } from "./instantly.js";
import { buildServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

const PORT = Number(process.env.PORT ?? 3000);
const INSTANTLY_API_KEY = process.env.INSTANTLY_API_KEY ?? "";
const INSTANTLY_BASE_URL = process.env.INSTANTLY_BASE_URL || undefined;
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN ?? "";

if (!INSTANTLY_API_KEY) {
  console.error(
    "FATAL: INSTANTLY_API_KEY is not set. Set it in the Railway service variables before starting.",
  );
  process.exit(1);
}

const client = new InstantlyClient({ apiKey: INSTANTLY_API_KEY, baseUrl: INSTANTLY_BASE_URL });

// MCP_AUTH_TOKEN may hold one token or several comma-separated tokens, so each
// person/Claude account can get its own token and be revoked independently.
const MCP_AUTH_TOKENS = MCP_AUTH_TOKEN.split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const app = express();
app.use(express.json({ limit: "4mb" }));

// Lightweight request logging to help diagnose client connections. Logs the
// method, path, which credential channel was presented (never the value), and
// the JSON-RPC method for POST bodies. Health checks are skipped to reduce noise.
app.use((req, _res, next) => {
  if (req.path === "/healthz") return next();
  const cred = req.headers.authorization
    ? "authorization"
    : req.headers["x-api-key"]
      ? "x-api-key"
      : req.headers["x-mcp-token"]
        ? "x-mcp-token"
        : req.query.token
          ? "query-token"
          : "none";
  const rpcMethod =
    req.body && typeof req.body === "object" && "method" in req.body
      ? String((req.body as Record<string, unknown>).method)
      : "";
  const accept = headerValue(req.headers.accept);
  console.log(
    `[req] ${req.method} ${req.path} cred=${cred} rpc=${rpcMethod || "-"} accept="${accept}"`,
  );
  next();
});

/** First string value for a header that may arrive as string | string[]. */
function headerValue(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? "";
  return v ?? "";
}

/**
 * Auth gate: no-op when no tokens are configured; otherwise requires a match.
 * The token may be presented as any of:
 *   - Authorization: Bearer <token>
 *   - X-API-Key: <token>
 *   - X-MCP-Token: <token>
 *   - ?token=<token>  (query string)
 * Headers are preferred because clients (e.g. Claude custom connectors) send
 * configured headers on every request — including their auth-detection check —
 * whereas a query string can be dropped during that check.
 */
function requireAuth(req: Request, res: Response): boolean {
  if (MCP_AUTH_TOKENS.length === 0) return true;
  const authHeader = headerValue(req.headers.authorization);
  const bearer = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";
  const apiKeyHeader = headerValue(req.headers["x-api-key"]).trim();
  const mcpTokenHeader = headerValue(req.headers["x-mcp-token"]).trim();
  const queryToken = typeof req.query.token === "string" ? req.query.token : "";
  const presented = [bearer, apiKeyHeader, mcpTokenHeader, queryToken];
  if (presented.some((t) => t && MCP_AUTH_TOKENS.includes(t))) {
    return true;
  }
  res.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32001, message: "Unauthorized: missing or invalid MCP auth token." },
    id: null,
  });
  return false;
}

// ---- Health & info ----------------------------------------------------------

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, server: SERVER_NAME, version: SERVER_VERSION });
});

app.get("/", (_req, res) => {
  res
    .type("text/plain")
    .send(
      `${SERVER_NAME} MCP server v${SERVER_VERSION}\n\n` +
        "Connect Claude to this server as a custom connector using the /mcp endpoint:\n" +
        "  <this-url>/mcp\n\n" +
        (MCP_AUTH_TOKENS.length > 0
          ? "This server requires an auth token. Send it as an x-api-key header\n" +
            "(or Authorization: Bearer).\n"
          : "This server is open (no MCP_AUTH_TOKEN set).\n") +
        "\nEndpoints: POST /mcp, GET /sse, POST /messages, GET /healthz\n",
    );
});

// ---- Streamable HTTP transport (stateless) ----------------------------------
// Stateless mode: a fresh server + transport per request. This is the simplest
// and most robust setup for a hosted/remote connector and matches how Claude's
// custom connectors talk to remote MCP servers.

app.post("/mcp", async (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  try {
    const server = buildServer(client);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("Error handling /mcp request:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Some Streamable HTTP clients open a GET stream on the MCP endpoint to receive
// server-initiated notifications. In stateless mode we have nothing to push, but
// returning 405 can make strict clients report the connection as unreachable, so
// hold an empty (heartbeat-only) SSE stream open instead.
app.get("/mcp", (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("x-accel-buffering", "no");
  res.write(": connected\n\n");
  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 25_000);
  req.on("close", () => clearInterval(heartbeat));
});

// DELETE on /mcp (session teardown) is a no-op in stateless mode.
app.delete("/mcp", (_req: Request, res: Response) => {
  res.status(200).json({ jsonrpc: "2.0", result: {}, id: null });
});

// ---- Legacy SSE transport ---------------------------------------------------
// Kept for compatibility with older MCP clients. Each SSE connection gets its
// own transport keyed by session id.

const sseTransports = new Map<string, SSEServerTransport>();

app.get("/sse", async (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  try {
    const transport = new SSEServerTransport("/messages", res);
    sseTransports.set(transport.sessionId, transport);
    res.on("close", () => {
      sseTransports.delete(transport.sessionId);
    });
    const server = buildServer(client);
    await server.connect(transport);
  } catch (err) {
    console.error("Error opening SSE stream:", err);
    if (!res.headersSent) res.status(500).end();
  }
});

app.post("/messages", async (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : "";
  const transport = sseTransports.get(sessionId);
  if (!transport) {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "No active SSE session for the provided sessionId." },
      id: null,
    });
    return;
  }
  await transport.handlePostMessage(req, res, req.body);
});

// ---- Start ------------------------------------------------------------------

const httpServer = app.listen(PORT, () => {
  console.log(`${SERVER_NAME} MCP server v${SERVER_VERSION} listening on port ${PORT}`);
  console.log(`  Streamable HTTP: POST /mcp`);
  console.log(`  Legacy SSE:      GET /sse, POST /messages`);
  console.log(
    `  Auth required:   ${
      MCP_AUTH_TOKENS.length > 0 ? `yes (${MCP_AUTH_TOKENS.length} token(s))` : "no"
    }`,
  );
});

const shutdown = () => {
  console.log("Shutting down...");
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
```

---

## Appendix B — one-shot prompt to rebuild with an AI

Paste this into Claude Code (or any capable coding agent) in an empty repo to regenerate
everything from scratch:

> Build a remote MCP (Model Context Protocol) server in **TypeScript + Node 20** that wraps
> the **Instantly.ai API v2** (`https://api.instantly.ai/api/v2`, auth
> `Authorization: Bearer <INSTANTLY_API_KEY>`) and is deployable to **Railway**, to be
> connected to Claude as a custom connector.
>
> Requirements:
> - Use `@modelcontextprotocol/sdk`, `express`, and `zod`. `"type": "module"`, ES2022,
>   NodeNext.
> - Transport: stateless **Streamable HTTP** at `POST /mcp`
>   (`StreamableHTTPServerTransport` with `sessionIdGenerator: undefined`, a fresh server
>   per request). Also expose legacy SSE at `GET /sse` + `POST /messages`.
> - `GET /mcp` must hold an empty heartbeat SSE stream open (NOT return 405). `DELETE /mcp`
>   is a 200 no-op. `GET /healthz` returns `{ ok:true, server, version }`.
> - Config from env: `INSTANTLY_API_KEY` (required; exit if missing), `MCP_AUTH_TOKEN`
>   (optional, **comma-separated** = multiple valid tokens), `PORT` (Railway-provided),
>   `INSTANTLY_BASE_URL` (optional).
> - Auth gate on all MCP endpoints: accept the token via `x-api-key`, `x-mcp-token`,
>   `Authorization: Bearer`, or `?token=`; return `401` if configured and none match;
>   no-op if no tokens set. Add per-request logging `[req] METHOD PATH cred=<channel>
>   rpc=<method>` that never logs token values.
> - The Instantly API key is server-side only and never returned to the client.
> - Register these read-first tools (return raw Instantly JSON), mapped to these endpoints:
>   `list_campaigns` (GET /campaigns), `get_campaign` (GET /campaigns/{id}),
>   `get_campaign_analytics` (GET /campaigns/analytics, repeatable `id`),
>   `get_campaign_analytics_overview` (GET /campaigns/analytics/overview),
>   `get_daily_campaign_analytics` (GET /campaigns/analytics/daily),
>   `get_campaign_steps_analytics` (GET /campaigns/analytics/steps),
>   `list_leads` (POST /leads/list), `get_lead` (GET /leads/{id}),
>   `list_lead_lists` (GET /lead-lists), `get_lead_list` (GET /lead-lists/{id}),
>   `list_emails` (GET /emails), `get_email` (GET /emails/{id}),
>   `list_accounts` (GET /accounts), `get_account` (GET /accounts/{email}),
>   `get_warmup_analytics` (POST /accounts/warmup-analytics), and a guarded
>   `instantly_api_request` (GET/POST only).
> - Add a multi-stage `Dockerfile`, `railway.json` (Dockerfile builder, start
>   `node dist/index.js`, healthcheck `/healthz`), `.gitignore`, `.dockerignore`,
>   `.env.example`, and a `README.md`.
> - Ensure `npm install` and `npm run build` succeed. Do not commit `node_modules`,
>   `dist`, or `.env`.
>
> Then tell me the exact Railway env vars to set and the exact Claude connector settings:
> **Authentication = None**, and an `x-api-key` request header whose value equals
> `MCP_AUTH_TOKEN` (no "Bearer" prefix), with the connector URL ending in `/mcp` and **no**
> token in the URL.

---

### Quick reference card

| Item | Value |
|---|---|
| MCP endpoint | `https://<your-app>.up.railway.app/mcp` |
| Health check | `https://<your-app>.up.railway.app/healthz` |
| Claude auth | **None** + header `x-api-key: <MCP_AUTH_TOKEN>` |
| Railway vars | `INSTANTLY_API_KEY` (required), `MCP_AUTH_TOKEN` (recommended) |
| Never set | `PORT` (Railway provides it); Root Directory (leave blank) |
| Golden rule | the `x-api-key` value in Claude must **exactly** equal `MCP_AUTH_TOKEN` in Railway |
