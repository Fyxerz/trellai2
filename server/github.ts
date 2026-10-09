/**
 * Your GitHub account, through the `gh` CLI that's already logged in on this machine
 * (we never store tokens). Used by "Nuevo proyecto → Clonar de GitHub".
 */
import { execFile, spawn } from "node:child_process";
import type { GitHubLoginFlow, GitHubRepo, GitHubRepos, GitHubStatus } from "../shared/types.js";

/** TRELLAI_GH lets tests point at a missing / fake binary (a .js/.mjs one runs with node). */
function ghCmd(args: string[]): [string, string[]] {
  const bin = process.env.TRELLAI_GH || "gh";
  return /\.m?js$/.test(bin) ? [process.execPath, [bin, ...args]] : [bin, args];
}

function gh(args: string[], timeout = 30_000): Promise<{ ok: boolean; missing: boolean; out: string; err: string }> {
  const [bin, argv] = ghCmd(args);
  return new Promise((resolve) =>
    execFile(bin, argv, { timeout, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } }, (error, stdout, stderr) =>
      resolve({
        ok: !error,
        missing: (error as NodeJS.ErrnoException | null)?.code === "ENOENT",
        out: String(stdout),
        err: String(stderr || (error?.message ?? "")).trim(),
      }),
    ),
  );
}

let sshCheck: { at: number; ok: Promise<boolean> } | null = null;

/**
 * Whether ssh to github.com works without asking anything (key loaded, host in known_hosts).
 * Cached for 10 minutes. Never touches StrictHostKeyChecking.
 */
export function githubSshWorks(): Promise<boolean> {
  if (process.env.TRELLAI_GITHUB_SSH) return Promise.resolve(process.env.TRELLAI_GITHUB_SSH === "1");
  if (sshCheck && Date.now() - sshCheck.at < 10 * 60_000) return sshCheck.ok;
  const ok = new Promise<boolean>((resolve) =>
    execFile("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "git@github.com"], { timeout: 20_000 }, (_error, stdout, stderr) =>
      // GitHub answers "Hi user! You've successfully authenticated…" with exit code 1
      resolve(/successfully authenticated/i.test(String(stdout) + String(stderr))),
    ),
  );
  sshCheck = { at: Date.now(), ok };
  return ok;
}

/** Make git use gh's login for https://github.com (`gh auth setup-git`). `missing` = gh isn't installed. */
export async function gitCredentials(): Promise<{ ok: boolean; missing: boolean }> {
  const r = await gh(["auth", "setup-git", "--hostname", "github.com"]);
  return { ok: r.ok, missing: r.missing };
}

/** Make git use gh's login for https://github.com (`gh auth setup-git`). True if gh is logged in and it worked. */
export async function setupGitCredentials(): Promise<boolean> {
  return (await gitCredentials()).ok;
}

/** git@github.com:o/r.git, ssh://git@github.com/o/r.git → https://github.com/o/r.git; anything else → null. */
export function sshToHttps(url: string): string | null {
  const m = url.trim().match(/^(?:ssh:\/\/)?(?:[\w.-]+@)?github\.com(?::\d+)?[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  return m ? `https://github.com/${m[1]}/${m[2]}.git` : null;
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
  // git_protocol=ssh is only honoured when ssh to GitHub really works; otherwise clone over HTTPS
  const protocol = proto.out.trim() === "ssh" && (await githubSshWorks()) ? "ssh" : "https";
  if (!list.ok) return { available: true, loggedIn: true, repos: [], error: `gh no pudo listar tus repos: ${list.err.split("\n")[0]}` };
  return { available: true, loggedIn: true, repos: parseRepos(list.out, protocol) };
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

/** Who `gh` is logged in as (for "Crear repo en GitHub"). Never throws. */
export async function status(): Promise<GitHubStatus> {
  const flow = loginFlow();
  const extra = flow ? { loginFlow: flow } : {};
  const auth = await gh(["auth", "status"]);
  if (auth.missing) return { available: false, loggedIn: false, login: null, ...extra };
  if (!auth.ok) return { available: true, loggedIn: false, login: null, ...extra };
  const user = await gh(["api", "user", "--jq", ".login"]);
  return { available: true, loggedIn: true, login: user.ok ? user.out.trim() || null : null, ...extra };
}

// ---- «Conectar GitHub»: `gh auth login --web` (device code in the browser) ----

const login: { child: ReturnType<typeof spawn> | null; started: boolean; code?: string; url?: string; error?: string; timer?: NodeJS.Timeout } = {
  child: null,
  started: false,
};
const loginListeners: (() => void)[] = [];

/** Called after a successful «Conectar GitHub» (git already uses gh's login by then). */
export function onLogin(fn: () => void) {
  loginListeners.push(fn);
}

/** The login flow, or undefined if none was started in this process. */
export function loginFlow(): GitHubLoginFlow | undefined {
  if (!login.started) return undefined;
  return { running: !!login.child, code: login.code, url: login.url, error: login.error };
}

function openBrowser(url: string) {
  if (process.env.TRELLAI_NO_BROWSER || process.env.VITEST) return;
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true }).on("error", () => {}).unref();
  } catch {
    /* no browser: the UI shows the link */
  }
}

/** Starts `gh auth login --web` (or returns the one already running). Returns at once; poll loginFlow(). */
export function startLogin(): GitHubLoginFlow {
  if (login.child) return loginFlow()!;
  Object.assign(login, { started: true, code: undefined, url: undefined, error: undefined });
  const [bin, argv] = ghCmd(["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--skip-ssh-key"]);
  const output: string[] = [];
  // we open the browser ourselves (gh can't always tell whether it may): its own opener does nothing
  const noop = process.platform === "win32" ? "cmd /c rem" : "true";
  const child = spawn(bin, argv, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, NO_COLOR: "1", GH_BROWSER: noop } });
  login.child = child;
  let entered = false;
  let opened = false;
  const onData = (d: Buffer) => {
    output.push(String(d));
    const all = output.join("");
    login.code ??= all.match(/one-time code: ([A-Z0-9]{4}-[A-Z0-9]{4})/)?.[1];
    login.url ??= all.match(/https:\/\/github\.com\/login\/device\S*/)?.[0]?.replace(/[.,]+$/, "");
    if (login.code) login.url ??= "https://github.com/login/device";
    if (!entered && /Press Enter/i.test(all)) {
      entered = true;
      child.stdin?.write("\n");
    }
    if (!opened && login.code && login.url) {
      opened = true;
      openBrowser(login.url);
    }
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.stdin?.on("error", () => {});
  child.on("error", (err) => {
    if (login.child !== child) return;
    clearTimeout(login.timer);
    login.child = null;
    login.error =
      (err as NodeJS.ErrnoException).code === "ENOENT" ? "gh no está instalado. Instálalo desde https://cli.github.com" : `No se pudo lanzar gh: ${err.message}`;
  });
  child.on("close", async (code, signal) => {
    if (login.child !== child) return; // cancelled or timed out
    clearTimeout(login.timer);
    if (code !== 0) {
      login.child = null;
      if (!login.error) {
        const tail = output.join("").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim().split("\n").filter(Boolean).slice(-2).join(" ").trim();
        login.error = signal ? "Se canceló la conexión con GitHub." : `No se completó la conexión con GitHub${tail ? `: ${tail}` : "."}`;
      }
      return;
    }
    // still "running" until git uses the new login, so whoever polls sees it ready
    await setupGitCredentials();
    login.child = null;
    for (const fn of loginListeners) {
      try {
        fn();
      } catch (err) {
        console.warn(`[github] tras conectar: ${(err as Error).message}`);
      }
    }
  });
  login.timer = setTimeout(() => {
    if (login.child !== child) return;
    login.child = null;
    child.kill();
    login.error = "Se acabó el tiempo esperando a que confirmaras el código en GitHub. Vuelve a intentarlo.";
  }, 5 * 60_000);
  return loginFlow()!;
}

/** Stop a running «Conectar GitHub». */
export function cancelLogin() {
  clearTimeout(login.timer);
  const child = login.child;
  login.child = null;
  child?.kill();
}

/** "nombre" or "owner/nombre" with GitHub's allowed characters. */
export const validRepoName = (name: string) => /^([\w.-]+\/)?[\w.-]+$/.test(name) && !/(^|\/)\.{1,2}$/.test(name);

/**
 * Create a repo on GitHub for a local repo that has no remote and add it as `origin`
 * (gh uses your git_protocol for the URL). Pushing is left to the caller (the base branch only).
 * If that URL is SSH and ssh to GitHub doesn't work here, origin is switched to HTTPS with gh as
 * git's credential helper, so the first push works without asking anything.
 */
export async function createRepo(
  repo: string,
  opts: { name: string; description?: string; private: boolean },
): Promise<{ ok: true; url: string } | { ok: false; code: "missing" | "auth" | "exists" | "invalid" | "failed"; error: string }> {
  const name = opts.name.trim();
  if (!validRepoName(name)) return { ok: false, code: "invalid", error: "Nombre no válido: usa letras, números, «-», «_» o «.» (o «org/nombre»)." };
  const auth = await gh(["auth", "status"]);
  if (auth.missing) return { ok: false, code: "missing", error: "No encuentro el comando `gh` (GitHub CLI). Instálalo desde https://cli.github.com y ejecuta `gh auth login`." };
  if (!auth.ok) return { ok: false, code: "auth", error: "`gh` no tiene sesión iniciada. Ejecuta `gh auth login` en una terminal y vuelve a intentarlo." };
  const args = ["repo", "create", name, opts.private ? "--private" : "--public", "--source", repo, "--remote", "origin"];
  if (opts.description?.trim()) args.push("--description", opts.description.trim());
  const r = await gh(args, 60_000);
  if (!r.ok) {
    if (/already exists/i.test(r.err)) return { ok: false, code: "exists", error: `Ya existe un repo llamado «${name}» en GitHub. Elige otro nombre.` };
    return { ok: false, code: "failed", error: `gh no pudo crear el repo: ${r.err.split("\n").filter(Boolean).slice(0, 2).join(" — ")}` };
  }
  const url = r.out.match(/https:\/\/github\.com\/\S+/)?.[0]?.replace(/\.git$/, "") ?? `https://github.com/${name}`;
  await preferHttps(repo);
  return { ok: true, url };
}

function gitIn(repo: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) =>
    execFile("git", args, { cwd: repo, timeout: 15_000 }, (error, stdout) => resolve({ ok: !error, out: String(stdout).trim() })),
  );
}

/**
 * If origin is an SSH github.com URL and ssh doesn't work here (or `force`), switch it to HTTPS and
 * let gh hand git the credentials. Returns the new URL, or null when nothing changed.
 */
export async function preferHttps(repo: string, force = false): Promise<string | null> {
  const cur = await gitIn(repo, ["remote", "get-url", "origin"]);
  const https = cur.ok ? sshToHttps(cur.out) : null;
  if (!https) return null;
  if (!force && (await githubSshWorks())) return null;
  await setupGitCredentials();
  const r = await gitIn(repo, ["remote", "set-url", "origin", https]);
  return r.ok ? https : null;
}
