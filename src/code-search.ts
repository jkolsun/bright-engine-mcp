import { spawn, execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs/promises";
import * as path from "path";

const execFileP = promisify(execFile);

// Module-level clone state. Persists across MCP requests in one process.
const REPO_DIR = process.env.REPO_CLONE_DIR || "/tmp/bright-engine-clone";
const PULL_DEBOUNCE_MS = 30_000;
const MAX_LINE_LENGTH = 500;
const HARD_LIMIT = 200;
const DEFAULT_LIMIT = 50;

// Globs to exclude when no explicit file_pattern is supplied.
// node_modules / .next / dist / build / .git are excluded automatically because
// ripgrep respects .gitignore; lock files and min.js/css are tracked in git so
// we filter them here. If the caller passes an explicit file_pattern, these
// are NOT applied — per spec, honor the caller's intent.
const DEFAULT_EXCLUDE_GLOBS = [
  "!package-lock.json",
  "!yarn.lock",
  "!pnpm-lock.yaml",
  "!*.min.js",
  "!*.min.css",
];

let lastPullAt = 0;
let pullPromise: Promise<void> | null = null;
let cloneInitPromise: Promise<void> | null = null;

function getRepoUrl(): string {
  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  if (!token || !owner || !repo) {
    throw new Error("Missing GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO env vars");
  }
  return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Clone the repo into REPO_DIR if not already present. Idempotent — concurrent
 * callers share one promise. Call from server startup so the first searchCode
 * request doesn't pay the clone cost.
 */
export async function initRepo(): Promise<void> {
  if (cloneInitPromise) return cloneInitPromise;
  cloneInitPromise = (async () => {
    const branch = process.env.GITHUB_BRANCH || "main";
    const gitDir = path.join(REPO_DIR, ".git");
    if (await dirExists(gitDir)) {
      console.log(`[code-search] Repo already cloned at ${REPO_DIR}`);
      lastPullAt = 0; // Force a pull on first search.
      return;
    }
    console.log(`[code-search] Cloning repo into ${REPO_DIR} (branch=${branch})...`);
    try {
      await execFileP(
        "git",
        ["clone", "--depth", "1", "--branch", branch, getRepoUrl(), REPO_DIR],
        { env: process.env, maxBuffer: 50 * 1024 * 1024 }
      );
      lastPullAt = Date.now();
      console.log(`[code-search] Clone complete`);
    } catch (err: any) {
      // Reset so a subsequent call can retry.
      cloneInitPromise = null;
      console.error(`[code-search] Clone failed: ${err.message}`);
      throw err;
    }
  })();
  return cloneInitPromise;
}

/**
 * git pull if more than PULL_DEBOUNCE_MS has passed since the last pull.
 * Mutex-protected so concurrent calls only fire one pull. A failed pull is
 * logged but not thrown — we serve stale results rather than block the tool.
 */
async function pullIfStale(): Promise<void> {
  const now = Date.now();
  if (now - lastPullAt < PULL_DEBOUNCE_MS) return;
  if (pullPromise) {
    await pullPromise;
    return;
  }
  pullPromise = (async () => {
    try {
      await execFileP("git", ["-C", REPO_DIR, "pull", "--ff-only"], {
        env: process.env,
        maxBuffer: 50 * 1024 * 1024,
      });
      lastPullAt = Date.now();
    } catch (err: any) {
      console.warn(`[code-search] git pull failed, serving from cached clone: ${err.message}`);
    } finally {
      pullPromise = null;
    }
  })();
  await pullPromise;
}

export interface SearchOptions {
  query: string;
  file_pattern?: string;
  case_insensitive?: boolean;
  regex?: boolean;
  limit?: number;
}

export interface SearchHit {
  file: string;
  line: number;
  content: string;
}

export interface SearchResponse {
  query: string;
  matched: number;
  truncated: boolean;
  results: SearchHit[];
}

export interface SearchError {
  error: string;
}

export async function searchCode(
  opts: SearchOptions
): Promise<SearchResponse | SearchError> {
  if (!opts.query || opts.query.length === 0) {
    return { error: "query cannot be empty" };
  }

  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_LIMIT), HARD_LIMIT);

  await initRepo();
  await pullIfStale();

  const args: string[] = ["--json"];
  if (opts.case_insensitive) args.push("-i");
  if (!opts.regex) args.push("-F"); // Fixed-string — literal substring match.
  if (opts.file_pattern) {
    args.push("-g", opts.file_pattern);
  } else {
    for (const g of DEFAULT_EXCLUDE_GLOBS) args.push("-g", g);
  }
  // -- separator so a query starting with `-` isn't parsed as a flag.
  args.push("--", opts.query, REPO_DIR);

  return await new Promise<SearchResponse | SearchError>((resolve) => {
    const proc = spawn("rg", args, { env: process.env });
    const results: SearchHit[] = [];
    const seen = new Set<string>();
    let truncated = false;
    let stdoutBuf = "";
    let stderrBuf = "";
    let finished = false;

    const finishOk = () => {
      if (finished) return;
      finished = true;
      results.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
      resolve({
        query: opts.query,
        matched: results.length,
        truncated,
        results,
      });
    };

    proc.stdout.on("data", (chunk: Buffer) => {
      if (finished) return;
      stdoutBuf += chunk.toString("utf8");
      let nlIdx: number;
      while ((nlIdx = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, nlIdx);
        stdoutBuf = stdoutBuf.slice(nlIdx + 1);
        if (!line) continue;
        try {
          const evt = JSON.parse(line);
          if (evt.type !== "match") continue;
          const filePath: string | undefined = evt.data?.path?.text;
          const lineNumber: number | undefined = evt.data?.line_number;
          const rawContent: string = evt.data?.lines?.text ?? "";
          if (!filePath || typeof lineNumber !== "number") continue;
          const relPath = path.relative(REPO_DIR, filePath);
          const key = `${relPath}:${lineNumber}`;
          if (seen.has(key)) continue;
          seen.add(key);

          let content = rawContent.replace(/\r?\n$/, "").trim();
          if (content.length > MAX_LINE_LENGTH) {
            content = content.slice(0, MAX_LINE_LENGTH) + "…";
          }

          if (results.length >= limit) {
            truncated = true;
            proc.kill("SIGTERM");
            finishOk();
            return;
          }
          results.push({ file: relPath, line: lineNumber, content });
        } catch {
          // Non-JSON line from rg (summary, etc.) — ignore.
        }
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
    });

    proc.on("error", (err) => {
      if (finished) return;
      finished = true;
      resolve({ error: `ripgrep spawn failed: ${err.message}` });
    });

    proc.on("close", (code) => {
      if (finished) return;
      // rg exit codes: 0=match found, 1=no match, 2=error, null=signalled.
      if (code === 0 || code === 1) {
        finishOk();
        return;
      }
      const msg = stderrBuf.trim() || `ripgrep exited with code ${code}`;
      if (opts.regex && /regex/i.test(msg)) {
        resolve({ error: `Invalid regex: ${msg}` });
      } else if (opts.file_pattern && /glob/i.test(msg)) {
        resolve({
          error: `Invalid file_pattern "${opts.file_pattern}": ${msg}. Example valid patterns: "*.ts", "src/app/**/*.ts", "prisma/schema.prisma"`,
        });
      } else {
        resolve({ error: msg });
      }
      finished = true;
    });
  });
}