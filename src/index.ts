import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";

const app = express();
app.use(express.json());

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

// MCP endpoint — stateless mode: fresh server + transport per request
app.post("/mcp", async (req, res) => {
  try {
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
app.get("/mcp", (_req, res) => {
  res.status(405).json({ error: "Method not allowed in stateless mode" });
});

// DELETE /mcp — not needed in stateless mode
app.delete("/mcp", (_req, res) => {
  res.status(405).json({ error: "Method not allowed in stateless mode" });
});

const PORT = parseInt(process.env.PORT || "3000", 10);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`bright-engine-mcp listening on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`MCP:    http://localhost:${PORT}/mcp`);
});