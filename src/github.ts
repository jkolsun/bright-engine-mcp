import { Octokit } from "@octokit/rest";

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const owner = process.env.GITHUB_OWNER!;
const repo = process.env.GITHUB_REPO!;
const branch = process.env.GITHUB_BRANCH || "main";

export async function getFile(path: string): Promise<string> {
  const { data } = await octokit.repos.getContent({
    owner,
    repo,
    path,
    ref: branch,
  });

  if (Array.isArray(data) || data.type !== "file") {
    throw new Error(`Path "${path}" is not a file`);
  }

  return Buffer.from(data.content, "base64").toString("utf-8");
}

export async function listDir(
  path: string = ""
): Promise<Array<{ name: string; type: string; size: number }>> {
  const { data } = await octokit.repos.getContent({
    owner,
    repo,
    path,
    ref: branch,
  });

  if (!Array.isArray(data)) {
    throw new Error(`Path "${path}" is not a directory`);
  }

  return data.map((item) => ({
    name: item.name,
    type: item.type === "dir" ? "dir" : "file",
    size: item.size ?? 0,
  }));
}

export async function searchFiles(pattern: string): Promise<string[]> {
  const { data } = await octokit.git.getTree({
    owner,
    repo,
    tree_sha: branch,
    recursive: "true",
  });

  const lowerPattern = pattern.toLowerCase();
  return data.tree
    .filter(
      (item) =>
        item.path && item.path.toLowerCase().includes(lowerPattern)
    )
    .map((item) => item.path!)
    .slice(0, 100);
}