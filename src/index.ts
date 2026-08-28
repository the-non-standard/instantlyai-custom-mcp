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
