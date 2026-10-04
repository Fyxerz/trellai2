/**
 * Your GitHub account, through the `gh` CLI that's already logged in on this machine
 * (we never store tokens). Used by "Nuevo proyecto → Clonar de GitHub".
 */
import { execFile } from "node:child_process";
import type { GitHubRepo, GitHubRepos } from "../shared/types.js";

/** TRELLAI_GH lets tests point at a missing / fake binary. */
const GH = process.env.TRELLAI_GH || "gh";

function gh(args: string[], timeout = 30_000): Promise<{ ok: boolean; missing: boolean; out: string; err: string }> {
  return new Promise((resolve) =>
    execFile(GH, args, { timeout, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } }, (error, stdout, stderr) =>
      resolve({
        ok: !error,
        missing: (error as NodeJS.ErrnoException | null)?.code === "ENOENT",
        out: String(stdout),
        err: String(stderr || (error?.message ?? "")).trim(),
      }),
    ),
  );
}

/** One `{full_name, …}` JSON object per line (gh api --jq '.[] | {...}') → repos, newest first. */
export function parseRepos(out: string, protocol: string): GitHubRepo[] {
  const seen = new Set<string>();
  const repos: GitHubRepo[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    let r: { full_name?: string; description?: string | null; private?: boolean; updated_at?: string; ssh_url?: string; clone_url?: string };
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (!r.full_name || seen.has(r.full_name)) continue;
    seen.add(r.full_name);
    repos.push({
      name: r.full_name,
      description: r.description ?? null,
      private: !!r.private,
      updated_at: r.updated_at ?? "",
      clone_url: (protocol === "ssh" ? r.ssh_url : r.clone_url) ?? `https://github.com/${r.full_name}.git`,
    });
  }
  return repos.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

/** Your repos (own, collaborator and from your orgs). Never throws: says what's missing instead. */
export async function listRepos(): Promise<GitHubRepos> {
  const auth = await gh(["auth", "status"]);
  if (auth.missing) return { available: false, loggedIn: false, repos: [] };
  if (!auth.ok) return { available: true, loggedIn: false, repos: [] };
  const [list, proto] = await Promise.all([
    gh(
      [
        "api",
        "--paginate",
        "user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member",
        "--jq",
        ".[] | {full_name, description, private, updated_at, ssh_url, clone_url}",
      ],
      60_000,
    ),
    gh(["config", "get", "git_protocol"]),
  ]);
  if (!list.ok) return { available: true, loggedIn: true, repos: [], error: `gh no pudo listar tus repos: ${list.err.split("\n")[0]}` };
  return { available: true, loggedIn: true, repos: parseRepos(list.out, proto.out.trim()) };
}

/** Folder name for a clone URL: last path segment without ".git". */
export function repoDirName(url: string): string {
  return (
    url
      .trim()
      .replace(/[/\\]+$/, "")
      .replace(/\.git$/, "")
      .split(/[/:\\]/)
      .pop() || ""
  );
}
