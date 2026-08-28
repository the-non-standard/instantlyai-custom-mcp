# Instantly.ai MCP Server

A Model Context Protocol (MCP) server that wraps the [Instantly.ai](https://instantly.ai)
API v2 and exposes it to Claude as a custom connector — campaign analytics, A/B step
analysis, daily trends, leads, lead lists, replies/unibox, and sending-account/warmup
deliverability, plus a guarded raw-API escape hatch.

The Instantly API key never leaves the server; Claude authenticates to this server with
a separate token.

See [`SETUP_GUIDE.md`](./SETUP_GUIDE.md) for the full step-by-step guide to deploying this
to Railway and connecting it to Claude as a custom connector.

## Quick start

```bash
npm install
cp .env.example .env   # fill in INSTANTLY_API_KEY (and optionally MCP_AUTH_TOKEN)
npm run build
npm start
```

The server listens on `PORT` (default `3000`) and exposes:

- `POST /mcp` — Streamable HTTP MCP transport (used by Claude custom connectors)
- `GET /sse` + `POST /messages` — legacy SSE transport
- `GET /healthz` — health check

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `INSTANTLY_API_KEY` | Yes | Instantly API v2 key. Server-side only, never sent to Claude. |
| `MCP_AUTH_TOKEN` | Recommended | Token(s) Claude must present via `x-api-key`. Comma-separate multiple tokens, one per person. |
| `INSTANTLY_BASE_URL` | No | Override the Instantly API base URL. |
| `PORT` | No | Railway sets this automatically. |

## Deploying

Deploy to [Railway](https://railway.app) — it auto-detects the included `Dockerfile` and
`railway.json`. Full instructions, including the exact Claude custom-connector settings,
are in [`SETUP_GUIDE.md`](./SETUP_GUIDE.md).
