import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getFile, listDir, searchFiles } from "./github.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "bright-engine-github",
    version: "1.0.0",
  });

  server.registerTool("getFile", {
    title: "Get File",
    description: "Read a file from the bright_engine GitHub repository. Returns the full file content as text.",
    inputSchema: {
      path: z.string().describe("File path relative to repo root (e.g. 'src/index.ts' or 'prisma/schema.prisma')"),
    },
  }, async ({ path }) => {
    try {
      const content = await getFile(path);
      return { content: [{ type: "text" as const, text: content }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  });

  server.registerTool("listDir", {
    title: "List Directory",
    description: "List files and directories at a given path in the bright_engine GitHub repository.",
    inputSchema: {
      path: z.string().default("").describe("Directory path relative to repo root. Empty string for root."),
    },
  }, async ({ path }) => {
    try {
      const entries = await listDir(path);
      const formatted = entries
        .map((e) => `${e.type === "dir" ? "📁" : "📄"} ${e.name}${e.type === "file" ? ` (${e.size}B)` : ""}`)
        .join("\n");
      return { content: [{ type: "text" as const, text: formatted || "Empty directory" }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  });

  server.registerTool("searchFiles", {
    title: "Search Files",
    description: "Search for files by name pattern in the bright_engine GitHub repository. Returns up to 100 matching file paths.",
    inputSchema: {
      pattern: z.string().describe("Filename pattern to search for (case-insensitive, e.g. 'schema' or 'route.ts')"),
    },
  }, async ({ pattern }) => {
    try {
      const paths = await searchFiles(pattern);
      const text = paths.length > 0
        ? `Found ${paths.length} file(s):\n${paths.join("\n")}`
        : `No files found matching "${pattern}"`;
      return { content: [{ type: "text" as const, text }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  });

  return server;
}