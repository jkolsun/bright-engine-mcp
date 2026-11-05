import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";
import { initRepo } from "./code-search.js";
import { createAuth, clientIp } from "./auth.js";

const app = express();
app.use(express.json());

// 2026-10-30 — every MCP route lives on this router, which is mounted only
// behind the secret (auth.ts): at /k/<MCP_API_KEY>/mcp and, for a client that
// sends Authorization: Bearer, at /mcp. Only /health stays on the open app.
const mcp = express.Router();

// CORS — allow claude.ai and other browser clients
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Authorization, Content-Type, mcp-session-id");
  res.header("Access-Control-Expose-Headers", "mcp-session-id");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", server: "bright-engine-github" });
});

// 2026-11-05 — no OAuth here. claude.ai probes /.well-known/oauth-* when a
// connector does not answer a plain initialize; every such path is a clean 404
// (never the 401 the bearer guard used to give), so it never tries a login.
app.all("/.well-known/*", (_req, res) => {
  res.status(404).end();
});

// A plain root page, so the domain root is never an auth refusal in a browser.
app.get("/", (_req, res) => {
  res.status(200).type("text/plain").send("bright-engine-mcp ok");
});

// MCP endpoint — stateless mode: fresh server + transport per request
mcp.post("/mcp", async (req, res) => {
  try {
    // Audit line (no arguments, no secret): who called what.
    const b = (req.body || {}) as { method?: string; params?: { name?: string } };
    console.log(`[mcp] ${b.method || "?"}${b.params?.name ? ` ${b.params.name}` : ""} from ${clientIp(req)}`);
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });

    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err: any) {
    console.error("MCP POST error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// GET /mcp — not needed in stateless mode
mcp.get("/mcp", (_req, res) => {
  res.status(405).json({ error: "Method not allowed in stateless mode" });
});

// DELETE /mcp — not needed in stateless mode
mcp.delete("/mcp", (_req, res) => {
  res.status(405).json({ error: "Method not allowed in stateless mode" });
});

const auth = createAuth();
if (!auth.configured) {
  console.error("[auth] MCP_API_KEY is not set (or shorter than 32 characters) — every MCP route answers 503 until it is (fail closed)");
}
app.use("/k/:key", auth.pathKey, mcp);
app.use(auth.bearer, mcp);

const PORT = parseInt(process.env.PORT || "3000", 10);
app.listen(PORT, "0.0.0.0", async () => {
  console.log(`bright-engine-mcp listening on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`MCP:    http://localhost:${PORT}/mcp`);

  // Pre-warm the local clone so the first searchCode call doesn't pay clone
  // cost. Failure is non-fatal — searchCode will retry on demand and the
  // legacy tools (getFile/listDir/searchFiles) work via the GitHub API
  // regardless of clone state.
  try {
    await initRepo();
  } catch (err: any) {
    console.error(`[startup] Initial repo clone failed — searchCode will retry on first call: ${err.message}`);
  }
});