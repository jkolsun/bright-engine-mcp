import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getFile, listDir, searchFiles } from "./github.js";
import { searchCode } from "./code-search.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "bright-engine-github",
    version: "1.0.0",
  });

  server.tool(
    "getFile",
    "Read a file from the bright_engine GitHub repository. Returns the full file content as text.",
    { path: z.string().describe("File path relative to repo root (e.g. 'src/index.ts' or 'prisma/schema.prisma')") },
    async ({ path }) => {
      try {
        const content = await getFile(path);
        return { content: [{ type: "text" as const, text: content }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "listDir",
    "List files and directories at a given path in the bright_engine GitHub repository.",
    { path: z.string().default("").describe("Directory path relative to repo root. Empty string for root.") },
    async ({ path }) => {
      try {
        const entries = await listDir(path);
        const formatted = entries
          .map((e) => `${e.type === "dir" ? "📁" : "📄"} ${e.name}${e.type === "file" ? ` (${e.size}B)` : ""}`)
          .join("\n");
        return { content: [{ type: "text" as const, text: formatted || "Empty directory" }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "searchFiles",
    "Search for files by name pattern in the bright_engine GitHub repository. Returns up to 100 matching file paths.",
    { pattern: z.string().describe("Filename pattern to search for (case-insensitive, e.g. 'schema' or 'route.ts')") },
    async ({ pattern }) => {
      try {
        const paths = await searchFiles(pattern);
        const text = paths.length > 0
          ? `Found ${paths.length} file(s):\n${paths.join("\n")}`
          : `No files found matching "${pattern}"`;
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "searchCode",
    "Full-text search across the bright_engine repo contents (file contents, not just filenames). Uses ripgrep on a locally cloned copy of the repo, refreshed every 30 seconds. Supports literal (default), case-insensitive, regex, and glob-filtered searches. Prefer this over calling getFile repeatedly when looking for where a symbol/string appears in the codebase.",
    {
      query: z.string().describe("The string to search for. Literal substring by default (special chars are not interpreted). Treated as a regex only when regex: true."),
      file_pattern: z.string().optional().describe("Glob to restrict which files are searched (e.g. '*.ts', 'src/app/api/**/*.ts', 'prisma/schema.prisma'). Omit to search the whole repo, excluding lock files and minified assets."),
      case_insensitive: z.boolean().optional().default(false).describe("Case-insensitive match. Default false."),
      regex: z.boolean().optional().default(false).describe("Treat query as a regex (ripgrep default syntax). Default false."),
      limit: z.number().int().positive().optional().default(50).describe("Max results to return. Default 50, hard cap 200. When exceeded, truncated: true in the response."),
    },
    async ({ query, file_pattern, case_insensitive, regex, limit }) => {
      try {
        const result = await searchCode({ query, file_pattern, case_insensitive, regex, limit });
        if ("error" in result) {
          return { content: [{ type: "text" as const, text: `Error: ${result.error}` }], isError: true };
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  return server;
}