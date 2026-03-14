import express from "express";
import { randomUUID } from "crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { server } from "./server.js";

const app = express();
app.use(express.json());

// Auth middleware — Bearer token check against MCP_API_KEY
function authMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid Authorization header" });
    return;
  }
  const token = authHeader.slice(7);
  if (token !== process.env.MCP_API_KEY) {
    res.status(401).json({ error: "Invalid API key" });
    return;
  }
  next();
}

// Health check — no auth required
app.get("/health", (_req, res) => {
  res.json({ status: "ok", server: "bright-engine-github" });
});

// Session management for stateful connections
const transports = new Map<string, StreamableHTTPServerTransport>();

// MCP endpoint — POST handles JSON-RPC messages
app.post("/mcp", authMiddleware, async (req, res) => {
  try {
    // Check for existing session
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports.has(sessionId)) {
      // Reuse existing transport
      transport = transports.get(sessionId)!;
    } else {
      // Create new transport for this session
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          transports.delete(transport.sessionId);
        }
      };

      // Connect the MCP server to this transport
      await server.connect(transport);

      // Store transport by session ID after connection
      if (transport.sessionId) {
        transports.set(transport.sessionId, transport);
      }
    }

    await transport.handleRequest(req, res, req.body);
  } catch (err: any) {
    console.error("MCP POST error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// MCP SSE endpoint — GET for server-to-client streaming
app.get("/mcp", authMiddleware, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    res.status(400).json({ error: "No active session. Send a POST first." });
    return;
  }
  const transport = transports.get(sessionId)!;
  await transport.handleRequest(req, res);
});

// MCP session cleanup — DELETE
app.delete("/mcp", authMiddleware, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  const transport = transports.get(sessionId)!;
  await transport.close();
  transports.delete(sessionId);
  res.status(200).json({ status: "session closed" });
});

const PORT = parseInt(process.env.PORT || "3000", 10);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`bright-engine-mcp listening on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`MCP:    http://localhost:${PORT}/mcp`);
});