/**
 * Model engines. Every agent in Trellai (preparation, development, assistant, direct chat)
 * runs through `runEngine`, which can use:
 *
 *   claude  → Claude Agent SDK (your Claude Code login)
 *   codex   → OpenAI Codex CLI (`codex exec`, your ChatGPT/OpenAI login) — GPT models
 *
 * A model is written as "engine" or "engine:model", e.g. "claude", "claude:opus", "codex",
 * "codex:gpt-5-codex", optionally followed by an effort: "claude:opus@high". Trellai's own tools (ask_questions, check_checkpoint, create_cards…)
 * reach Codex through a tiny stdio MCP bridge that calls back into this server.
 */
import { createSdkMcpServer, query, tool, type HookCallback, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { execFile, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { z, type ZodRawShape } from "zod";
import { EFFORT_LABELS, EFFORTS, splitEffort, withEffort, type Effort } from "../shared/models.js";

export type Engine = "claude" | "codex";

export interface ToolSpec {
  name: string;
  description: string;
  shape: ZodRawShape;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run: (args: any) => string;
}

export function parseModel(full: string | null | undefined): { engine: Engine; model?: string; effort: Effort | null } {
  const { spec, effort } = splitEffort((full || "claude").trim());
  const [engine, ...rest] = (spec || "claude").split(":");
  const model = rest.join(":") || undefined;
  return engine === "codex" ? { engine: "codex", model, effort } : { engine: "claude", model, effort };
}

export function modelLabel(spec: string | null | undefined): string {
  const { engine, model, effort } = parseModel(spec);
  const name = engine === "codex" ? (model ? `GPT · ${model}` : "GPT (Codex)") : model ? `Claude ${model[0].toUpperCase()}${model.slice(1)}` : "Claude";
  return effort ? `${name} · ${EFFORT_LABELS[effort]}` : name;
}

export interface ClaudeModel {
  /** what we store after "claude:" ("default" = no model) */
  value: string;
  /** exact model id it runs today, e.g. "claude-opus-5-5" */
  resolved: string | null;
  /** e.g. "Opus 5.5" */
  label: string;
  description: string;
  /** effort levels this model accepts (empty = no effort setting) */
  efforts: Effort[];
}

let claudeModelsCache: { at: number; models: Promise<ClaudeModel[]> } | null = null;

/** Models your Claude Code login offers, with the exact version each alias points to (cached for an hour). */
export function claudeModels(): Promise<ClaudeModel[]> {
  if (claudeModelsCache && Date.now() - claudeModelsCache.at < 3_600_000) return claudeModelsCache.models;
  const models = (async () => {
    const abort = new AbortController();
    // Streaming input that never sends anything: we only ask the session for its model list.
    async function* idle(): AsyncGenerator<never> {
      await new Promise((r) => abort.signal.addEventListener("abort", r));
    }
    const q = query({ prompt: idle(), options: { abortController: abort, cwd: process.cwd() } });
    try {
      const list = await q.supportedModels();
      return list.map((m) => ({
        value: m.value,
        resolved: m.resolvedModel ?? null,
        label: m.displayName,
        description: m.description,
        efforts: m.supportsEffort ? (m.supportedEffortLevels ?? []) : [],
      }));
    } finally {
      abort.abort();
    }
  })();
  models.catch(() => (claudeModelsCache = null));
  claudeModelsCache = { at: Date.now(), models };
  return models;
}

/** The model `codex exec` uses when none is given (from ~/.codex/config.toml). */
export function codexDefaultModel(): string | null {
  try {
    const toml = readFileSync(join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml"), "utf8");
    // top-level key only: stop at the first [table]
    return toml.split(/^\s*\[/m)[0].match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1] ?? null;
  } catch {
    return null;
  }
}

export interface CodexModel {
  slug: string;
  label: string;
  efforts: Effort[];
  defaultEffort: Effort | null;
}

/** The GPT models of your ChatGPT account, from the list Codex caches ($CODEX_HOME/models_cache.json). [] if there is none. */
export function codexModels(): CodexModel[] {
  try {
    const raw = JSON.parse(readFileSync(join(process.env.CODEX_HOME || join(homedir(), ".codex"), "models_cache.json"), "utf8"));
    const isEffort = (e: unknown): e is Effort => (EFFORTS as readonly unknown[]).includes(e);
    return (Array.isArray(raw?.models) ? raw.models : [])
      .filter((m: { slug?: unknown; visibility?: unknown }) => typeof m?.slug === "string" && m.visibility === "list")
      .map((m: { slug: string; display_name?: string; supported_reasoning_levels?: { effort?: unknown }[]; default_reasoning_level?: unknown }) => ({
        slug: m.slug,
        label: m.display_name || m.slug,
        // Codex has levels we don't (e.g. "ultra"): keep only ours
        efforts: (m.supported_reasoning_levels ?? []).map((l) => l?.effort).filter(isEffort),
        defaultEffort: isEffort(m.default_reasoning_level) ? m.default_reasoning_level : null,
      }));
  } catch {
    return [];
  }
}

/** Session ids are stored with the engine as prefix ("codex:<id>"); Claude ids are stored bare. */
function decodeSession(stored: string | null | undefined): { engine: Engine; id: string } | null {
  if (!stored) return null;
  if (stored.startsWith("codex:")) return { engine: "codex", id: stored.slice(6) };
  return { engine: "claude", id: stored.replace(/^claude:/, "") };
}

export interface EngineRun {
  model: string | null | undefined;
  cwd: string;
  /** Main checkout when cwd is a worktree (Claude reads project config from there). */
  configRoot?: string;
  /** Role instructions (appended to Claude's system prompt; prepended to Codex's first prompt). */
  instructions: string;
  prompt: string;
  /** Stored session from a previous run (any engine). */
  resume?: string | null;
  /** Prepended to the prompt when the stored session can't be resumed (e.g. the model changed engine). */
  contextIfFresh?: string;
  /** read = no file edits · write = full access */
  access: "read" | "write";
  tools: ToolSpec[];
  /** Messages from other agents to inject while working (Claude: after every tool; Codex: in Trellai tool results). */
  pollNotes?: () => string | null;
  signal: AbortSignal;
  onText: (text: string) => void;
  onTool: (summary: string) => void;
  /** The exact model this run uses, e.g. "claude-opus-5-5" or "codex:gpt-5-codex". */
  onModel?: (model: string) => void;
}

export interface EngineResult {
  /** Encoded session id to store for next time. */
  sessionId: string | null;
  error?: string;
}

export async function runEngine(r: EngineRun): Promise<EngineResult> {
  const { engine, model, effort } = parseModel(r.model);
  const prev = decodeSession(r.resume);
  const resume = prev && prev.engine === engine ? prev.id : null;
  const prompt = !resume && prev && r.contextIfFresh ? `${r.contextIfFresh}\n\n---\n\n${r.prompt}` : r.prompt;
  // the exact model reported for each run carries the effort too: "claude-opus-5-5@high"
  const onModel = r.onModel && ((m: string) => r.onModel!(withEffort(m, effort)));
  return engine === "codex"
    ? runCodex({ ...r, prompt, onModel }, model, resume, effort)
    : runClaude({ ...r, prompt, onModel }, model ?? process.env.TRELLAI_MODEL ?? undefined, resume, effort);
}

// ---------------------------------------------------------------------------
// Claude (Agent SDK)
// ---------------------------------------------------------------------------

const READ_ONLY_BLOCK = ["Edit", "Write", "NotebookEdit"];
const NEVER = ["AskUserQuestion", "ExitPlanMode", "EnterPlanMode"];

function summarize(name: string, input: Record<string, unknown>): string {
  const arg = input.file_path ?? input.path ?? input.pattern ?? input.command ?? input.description ?? input.url ?? "";
  const s = String(arg).replace(/\s+/g, " ");
  return s ? `${name} · ${s.length > 140 ? s.slice(0, 140) + "…" : s}` : name;
}

async function runClaude(r: EngineRun, model: string | undefined, resume: string | null, effort: Effort | null): Promise<EngineResult> {
  const abort = new AbortController();
  r.signal.addEventListener("abort", () => abort.abort());
  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
  const server = createSdkMcpServer({
    name: "trellai",
    version: "2.0.0",
    tools: r.tools.map((t) => tool(t.name, t.description, t.shape, async (args) => text(t.run(args)))),
  });
  const noteHook: HookCallback = async () => {
    const notes = r.pollNotes?.();
    return notes ? { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: notes } } : {};
  };

  let sessionId: string | null = resume;
  let error: string | undefined;
  try {
    const q = query({
      prompt: r.prompt,
      options: {
        cwd: r.cwd,
        resume: resume ?? undefined,
        abortController: abort,
        model,
        effort: effort ?? undefined,
        systemPrompt: { type: "preset", preset: "claude_code", append: r.instructions },
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        disallowedTools: r.access === "read" ? [...READ_ONLY_BLOCK, ...NEVER] : NEVER,
        mcpServers: { trellai: server },
        hooks: r.pollNotes ? { PostToolUse: [{ hooks: [noteHook] }] } : undefined,
        projectConfigRoot: r.configRoot && r.configRoot !== r.cwd ? r.configRoot : undefined,
      },
    });
    for await (const m of q as AsyncIterable<SDKMessage>) {
      if ("session_id" in m && m.session_id) sessionId = m.session_id;
      if (m.type === "system" && m.subtype === "init") r.onModel?.(m.model);
      else if (m.type === "assistant" && !m.parent_tool_use_id) {
        for (const block of m.message.content) {
          if (block.type === "text" && block.text.trim()) r.onText(block.text.trim());
          if (block.type === "tool_use" && !block.name.startsWith("mcp__trellai__"))
            r.onTool(summarize(block.name, block.input as Record<string, unknown>));
        }
      } else if (m.type === "result" && m.subtype !== "success") {
        error = ("errors" in m && Array.isArray(m.errors) && m.errors.join("; ")) || m.subtype;
      }
    }
  } catch (err) {
    if (!r.signal.aborted) error = (err as Error).message;
  }
  return { sessionId, error };
}

// ---------------------------------------------------------------------------
// Codex (OpenAI) via `codex exec --json`
// ---------------------------------------------------------------------------

const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), "mcp-bridge.mjs");
let codexBinCache: string | null = null;

/**
 * The Codex CLI: TRELLAI_CODEX_BIN, `codex` from the PATH (npm i -g @openai/codex), or the one bundled
 * with OpenAI's Codex desktop app, which shares its ChatGPT login (~/.codex).
 */
function codexBin(): string {
  if (process.env.TRELLAI_CODEX_BIN) return process.env.TRELLAI_CODEX_BIN;
  if (codexBinCache) return codexBinCache;
  return (codexBinCache = findCodexBin());
}

/** Command line for Codex; a .js/.mjs TRELLAI_CODEX_BIN runs with node (a simulated Codex in tests). */
function codexCmd(args: string[]): [string, string[]] {
  const bin = codexBin();
  return /\.m?js$/.test(bin) ? [process.execPath, [bin, ...args]] : [bin, args];
}

function findCodexBin(): string {
  const works = (bin: string) => {
    try {
      execFileSync(bin, ["--version"], { timeout: 10_000, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  if (works("codex")) return "codex";
  const candidates: string[] = [];
  if (process.platform === "win32") {
    // Microsoft Store app: its folder can't be listed, so ask Windows where it lives
    try {
      const dir = execFileSync("powershell.exe", ["-NoProfile", "-Command", "(Get-AppxPackage OpenAI.Codex).InstallLocation"], {
        timeout: 15_000,
        encoding: "utf8",
      }).trim();
      if (dir) candidates.push(join(dir.split(/\r?\n/)[0], "app", "resources", "codex.exe"));
    } catch {
      // no PowerShell / no app
    }
  } else if (process.platform === "darwin") {
    candidates.push("/Applications/Codex.app/Contents/Resources/codex", join(homedir(), "Applications/Codex.app/Contents/Resources/codex"));
  }
  return candidates.find((c) => existsSync(c) && works(c)) ?? "codex";
}

/** Live tool sets for running Codex agents, keyed by a per-run token. */
const toolRuns = new Map<string, ToolSpec[]>();

export function mcpListTools(token: string) {
  const tools = toolRuns.get(token);
  if (!tools) return null;
  return tools.map((t) => {
    const { $schema: _s, ...schema } = z.toJSONSchema(z.object(t.shape)) as Record<string, unknown>;
    return { name: t.name, description: t.description, inputSchema: schema };
  });
}

export function mcpCallTool(token: string, name: string, args: unknown): string | null {
  const t = toolRuns.get(token)?.find((x) => x.name === name);
  if (!t) return null;
  const parsed = z.object(t.shape).parse(args ?? {});
  return t.run(parsed);
}

let codexInfo: { at: number; installed: boolean; version?: string; loggedIn: boolean } | null = null;

/** Is Codex installed, and is there a ChatGPT/OpenAI session (`codex login status`)? Cached 10 s. */
export function codexStatus(): Promise<{ installed: boolean; version?: string; loggedIn: boolean }> {
  if (codexInfo && Date.now() - codexInfo.at < 10_000) return Promise.resolve(codexInfo);
  return new Promise((res) =>
    execFile(...codexCmd(["--version"]), { timeout: 10_000 }, (err, out) => {
      codexInfo = { at: Date.now(), installed: false, loggedIn: false };
      if (err) return res(codexInfo);
      const version = out.trim();
      execFile(...codexCmd(["login", "status"]), { timeout: 10_000 }, (err2, out2, errOut2) => {
        const text = `${out2}
${errOut2}`;
        const loggedIn = !err2 && !/not logged in/i.test(text);
        codexInfo = { at: Date.now(), installed: true, version, loggedIn };
        res(codexInfo);
      });
    }),
  );
}

// ---------------------------------------------------------------------------
// Login (Claude / Codex): runs the CLI's own login, which opens the browser and waits for its callback
// ---------------------------------------------------------------------------

/** The Claude Code CLI bundled with the Agent SDK, or `claude` from the PATH. */
function claudeBin(): string {
  if (process.env.TRELLAI_CLAUDE_BIN) return process.env.TRELLAI_CLAUDE_BIN;
  try {
    const req = createRequire(import.meta.url);
    const pkg = req.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`);
    const bin = join(dirname(pkg), process.platform === "win32" ? "claude.exe" : "claude");
    if (existsSync(bin)) return bin;
  } catch {
    // not installed for this platform
  }
  return "claude";
}

let claudeAuthCache: { at: number; loggedIn: Promise<boolean> } | null = null;

/** `claude auth status` → is there a Claude session? Cached 10 s. */
export function claudeLoggedIn(): Promise<boolean> {
  if (claudeAuthCache && Date.now() - claudeAuthCache.at < 10_000) return claudeAuthCache.loggedIn;
  const loggedIn = new Promise<boolean>((res) =>
    execFile(claudeBin(), ["auth", "status"], { timeout: 15_000, shell: process.platform === "win32" && !/\.exe$/i.test(claudeBin()) }, (err, out) => {
      try {
        res(!!JSON.parse(out).loggedIn);
      } catch {
        res(!err);
      }
    }),
  );
  claudeAuthCache = { at: Date.now(), loggedIn };
  return loggedIn;
}

export interface LoginState {
  /** a login is waiting for the browser */
  running: boolean;
  /** why the last login failed (cleared when a new one starts) */
  error?: string;
}

const logins: Record<Engine, { child: ReturnType<typeof spawn> | null; error?: string; timer?: NodeJS.Timeout }> = {
  claude: { child: null },
  codex: { child: null },
};

export function loginState(engine: Engine): LoginState {
  const l = logins[engine];
  return { running: !!l.child, error: l.error };
}

/** Forget cached sessions / model lists so the next /api/engines sees the new login. */
function resetEngineCaches() {
  codexBinCache = null;
  claudeAuthCache = null;
  claudeModelsCache = null;
  codexInfo = null;
}

/** Starts `claude auth login` / `codex login` (kills a previous one). Returns at once; poll loginState(). */
export function startLogin(engine: Engine): LoginState {
  const l = logins[engine];
  cancelLogin(engine);
  l.error = undefined;
  resetEngineCaches();
  const bin = engine === "claude" ? claudeBin() : codexBin();
  const args = engine === "claude" ? ["auth", "login"] : ["login"];
  const output: string[] = [];
  const child = spawn(bin, args, {
    stdio: ["ignore", "pipe", "pipe"],
    shell: engine === "claude" && process.platform === "win32" && !/\.exe$/i.test(bin),
    env: { ...process.env, NO_PROXY: [process.env.NO_PROXY, "127.0.0.1", "localhost"].filter(Boolean).join(",") },
  });
  l.child = child;
  child.stdout?.on("data", (d) => output.push(String(d)));
  child.stderr?.on("data", (d) => output.push(String(d)));
  const name = engine === "claude" ? "Claude" : "Codex";
  child.on("error", (err) => {
    if (l.child !== child) return;
    l.error =
      (err as NodeJS.ErrnoException).code === "ENOENT"
        ? engine === "claude"
          ? "No encuentro el comando `claude`. Instala Claude Code y vuelve a intentarlo."
          : "No encuentro Codex. Instala la app de Codex de OpenAI (o `npm i -g @openai/codex`)."
        : `No se pudo lanzar el login de ${name}: ${err.message}`;
  });
  child.on("close", (code, signal) => {
    if (l.child !== child) return; // replaced or cancelled
    clearTimeout(l.timer);
    l.child = null;
    resetEngineCaches();
    if (code !== 0 && !l.error) {
      const tail = output.join("").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim().split("\n").slice(-2).join(" ").trim();
      l.error = signal
        ? `Se canceló el login de ${name}.`
        : `El login de ${name} no se completó${tail ? `: ${tail}` : "."}`;
    }
  });
  // nobody finished in the browser: give up so the port and process don't linger
  l.timer = setTimeout(() => {
    if (l.child !== child) return;
    l.child = null;
    child.kill();
    l.error = `Se agotó el tiempo esperando el login de ${name} en el navegador. Vuelve a intentarlo.`;
  }, 5 * 60_000);
  return loginState(engine);
}

export function cancelLogin(engine: Engine) {
  const l = logins[engine];
  clearTimeout(l.timer);
  const child = l.child;
  l.child = null;
  child?.kill();
}

function toml(s: string) {
  return JSON.stringify(s); // TOML basic strings use the same escaping as JSON for our needs
}

async function runCodex(r: EngineRun, model: string | undefined, resume: string | null, effort: Effort | null): Promise<EngineResult> {
  const token = randomBytes(16).toString("hex");
  const tools = r.pollNotes
    ? r.tools.map((t) => ({
        ...t,
        run: (a: unknown) => {
          const out = t.run(a);
          const notes = r.pollNotes!();
          return notes ? `${out}\n\n${notes}` : out;
        },
      }))
    : r.tools;
  toolRuns.set(token, tools);

  const port = process.env.PORT ?? "4317";
  const url = process.env.TRELLAI_INTERNAL_URL ?? `http://127.0.0.1:${port}`;
  const config = [
    "-c", `mcp_servers.trellai.command=${toml(process.execPath)}`,
    "-c", `mcp_servers.trellai.args=[${toml(BRIDGE)}]`,
    "-c", `mcp_servers.trellai.env={ TRELLAI_URL = ${toml(url)}, TRELLAI_TOKEN = ${toml(token)} }`,
    "-c", "mcp_servers.trellai.tool_timeout_sec=600",
    // Trellai's tools are ours: never ask for approval (exec has no one to ask).
    "-c", 'mcp_servers.trellai.default_tools_approval_mode="approve"',
  ];
  const access =
    r.access === "write" ? ["--dangerously-bypass-approvals-and-sandbox"] : ["-c", 'sandbox_mode="read-only"'];
  const modelArgs = [...(model ? ["-m", model] : []), ...(effort ? ["-c", `model_reasoning_effort=${toml(effort)}`] : [])];
  const prompt = resume ? r.prompt : `<instructions>\n${r.instructions}\n</instructions>\n\n${r.prompt}`;
  const args = resume
    ? ["exec", "resume", "--json", "--skip-git-repo-check", ...access, ...modelArgs, ...config, resume, prompt]
    : ["exec", "--json", "--skip-git-repo-check", ...access, ...modelArgs, ...config, "-C", r.cwd, prompt];

  let sessionId: string | null = resume ? `codex:${resume}` : null;
  let error: string | undefined;
  const stderr: string[] = [];
  r.onModel?.(`codex:${model ?? codexDefaultModel() ?? "default"}`);

  try {
    await new Promise<void>((resolve) => {
      const child = spawn(...codexCmd(args), {
        cwd: r.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, NO_PROXY: [process.env.NO_PROXY, "127.0.0.1", "localhost"].filter(Boolean).join(",") },
      });
      const onAbort = () => child.kill("SIGTERM");
      r.signal.addEventListener("abort", onAbort);
      child.on("error", (err) => {
        error =
          (err as NodeJS.ErrnoException).code === "ENOENT"
            ? "No encuentro Codex. Instala la app de Codex de OpenAI (o `npm i -g @openai/codex`) y conéctalo con tu cuenta de ChatGPT en Modelos del proyecto."
            : err.message;
      });
      child.stderr.on("data", (d) => stderr.push(String(d)));
      createInterface({ input: child.stdout }).on("line", (line) => {
        let ev: any; // eslint-disable-line @typescript-eslint/no-explicit-any
        try {
          ev = JSON.parse(line);
        } catch {
          return;
        }
        if (ev.type === "thread.started" && ev.thread_id) sessionId = `codex:${ev.thread_id}`;
        else if (ev.type === "turn.failed") error = ev.error?.message ?? "Codex falló";
        else if (ev.type === "error") error = ev.message ?? "Codex falló";
        else if (ev.type === "item.completed" && ev.item) handleItem(ev.item, r);
      });
      child.on("close", (code) => {
        r.signal.removeEventListener("abort", onAbort);
        if (code && code !== 0 && !error && !r.signal.aborted) {
          error = `codex terminó con código ${code}: ${stderr.join("").trim().split("\n").slice(-3).join(" ")}`;
        }
        resolve();
      });
    });
  } finally {
    toolRuns.delete(token);
  }
  return { sessionId, error: r.signal.aborted ? undefined : error };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleItem(item: any, r: EngineRun) {
  switch (item.type) {
    case "agent_message":
      if (item.text?.trim()) r.onText(item.text.trim());
      break;
    case "command_execution":
      r.onTool(summarize("Bash", { command: item.command }));
      break;
    case "file_change":
      r.onTool(`Edit · ${(item.changes ?? []).map((c: { path: string }) => c.path).join(", ")}`);
      break;
    case "mcp_tool_call":
      if (item.server !== "trellai") r.onTool(`${item.server}.${item.tool}`);
      break;
    case "web_search":
      r.onTool(`WebSearch · ${item.query ?? ""}`);
      break;
    case "error":
      // Codex reports harmless warnings this way (e.g. unknown model metadata); keep only real ones.
      if (item.message && !/metadata/i.test(item.message)) r.onTool(`⚠ ${item.message}`);
      break;
  }
}
