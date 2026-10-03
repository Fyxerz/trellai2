/**
 * Model engines. Every agent in Trellai (preparation, development, assistant, direct chat)
 * runs through `runEngine`, which can use:
 *
 *   claude  → Claude Agent SDK (your Claude Code login)
 *   codex   → OpenAI Codex CLI (`codex exec`, your ChatGPT/OpenAI login) — GPT models
 *
 * A model is written as "engine" or "engine:model", e.g. "claude", "claude:opus", "codex",
 * "codex:gpt-5-codex". Trellai's own tools (ask_questions, check_checkpoint, create_cards…)
 * reach Codex through a tiny stdio MCP bridge that calls back into this server.
 */
import { createSdkMcpServer, query, tool, type HookCallback, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { z, type ZodRawShape } from "zod";

export type Engine = "claude" | "codex";

export interface ToolSpec {
  name: string;
  description: string;
  shape: ZodRawShape;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run: (args: any) => string;
}

export function parseModel(spec: string | null | undefined): { engine: Engine; model?: string } {
  const s = (spec || "claude").trim();
  const [engine, ...rest] = s.split(":");
  const model = rest.join(":") || undefined;
  return engine === "codex" ? { engine: "codex", model } : { engine: "claude", model };
}

export function modelLabel(spec: string | null | undefined): string {
  const { engine, model } = parseModel(spec);
  if (engine === "codex") return model ? `GPT · ${model}` : "GPT (Codex)";
  return model ? `Claude ${model[0].toUpperCase()}${model.slice(1)}` : "Claude";
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
}

export interface EngineResult {
  /** Encoded session id to store for next time. */
  sessionId: string | null;
  error?: string;
}

export async function runEngine(r: EngineRun): Promise<EngineResult> {
  const { engine, model } = parseModel(r.model);
  const prev = decodeSession(r.resume);
  const resume = prev && prev.engine === engine ? prev.id : null;
  const prompt = !resume && prev && r.contextIfFresh ? `${r.contextIfFresh}\n\n---\n\n${r.prompt}` : r.prompt;
  return engine === "codex"
    ? runCodex({ ...r, prompt }, model, resume)
    : runClaude({ ...r, prompt }, model ?? process.env.TRELLAI_MODEL ?? undefined, resume);
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

async function runClaude(r: EngineRun, model: string | undefined, resume: string | null): Promise<EngineResult> {
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
      if (m.type === "assistant" && !m.parent_tool_use_id) {
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
const codexBin = () => process.env.TRELLAI_CODEX_BIN || "codex";

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

let codexInfo: { at: number; installed: boolean; version?: string } | null = null;

export function codexStatus(): Promise<{ installed: boolean; version?: string }> {
  if (codexInfo && Date.now() - codexInfo.at < 60_000) return Promise.resolve(codexInfo);
  return new Promise((res) =>
    execFile(codexBin(), ["--version"], { timeout: 10_000 }, (err, out) => {
      codexInfo = err ? { at: Date.now(), installed: false } : { at: Date.now(), installed: true, version: out.trim() };
      res(codexInfo);
    }),
  );
}

function toml(s: string) {
  return JSON.stringify(s); // TOML basic strings use the same escaping as JSON for our needs
}

async function runCodex(r: EngineRun, model: string | undefined, resume: string | null): Promise<EngineResult> {
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
  const modelArgs = model ? ["-m", model] : [];
  const prompt = resume ? r.prompt : `<instructions>\n${r.instructions}\n</instructions>\n\n${r.prompt}`;
  const args = resume
    ? ["exec", "resume", "--json", "--skip-git-repo-check", ...access, ...modelArgs, ...config, resume, prompt]
    : ["exec", "--json", "--skip-git-repo-check", ...access, ...modelArgs, ...config, "-C", r.cwd, prompt];

  let sessionId: string | null = resume ? `codex:${resume}` : null;
  let error: string | undefined;
  const stderr: string[] = [];

  try {
    await new Promise<void>((resolve) => {
      const child = spawn(codexBin(), args, {
        cwd: r.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, NO_PROXY: [process.env.NO_PROXY, "127.0.0.1", "localhost"].filter(Boolean).join(",") },
      });
      const onAbort = () => child.kill("SIGTERM");
      r.signal.addEventListener("abort", onAbort);
      child.on("error", (err) => {
        error =
          (err as NodeJS.ErrnoException).code === "ENOENT"
            ? "No encuentro el comando `codex`. Instálalo con `npm i -g @openai/codex` y haz `codex login`."
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
