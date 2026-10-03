import { ArrowDown, ArrowUp, Cloud, CloudOff, FolderGit2, GitBranch, Laptop, Download, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { Project } from "../../shared/types";
import { api, useSync, type Board } from "./api";
import { notice } from "./Confirm";
import { FolderPicker } from "./FolderPicker";
import { Button, Spinner, timeAgo } from "./ui";

interface GitStatus {
  remote: string | null;
  ok: boolean;
  message?: string;
  ahead: number;
  behind: number;
}

/** Base branch pill in the header, with ↓/↑ against GitHub. Click to pull (and push). */
export function BranchStatus({ project, board }: { project: Project; board: Board }) {
  const [st, setSt] = useState<GitStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSt(null);
    if (!project.repo_path) return;
    let alive = true;
    const load = () => api<GitStatus>(`/api/projects/${project.id}/git`).then((s) => alive && setSt(s)).catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    // a merge here or on another computer moves things
    const off = board.on((e) => {
      if (e.type === "sync" || (e.type === "card" && e.card.column === "merged")) setTimeout(load, 1500);
    });
    return () => {
      alive = false;
      clearInterval(t);
      off();
    };
  }, [project.id, project.repo_path]);

  const out = st && (st.ahead > 0 || st.behind > 0);
  const sync = async () => {
    setBusy(true);
    try {
      await api(`/api/projects/${project.id}/pull`, {});
      setSt(await api<GitStatus>(`/api/projects/${project.id}/git`));
    } catch (e) {
      notice("No pude sincronizar con GitHub", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const title = !project.repo_path
    ? "Este proyecto no está en este ordenador"
    : !st?.remote
      ? `${project.repo_path} · sin remoto (no se hace push ni pull)`
      : !st.ok
        ? `${project.repo_path} · ${st.message}`
        : out
          ? `${project.repo_path} · ${st.behind ? `${st.behind} commit(s) por bajar` : ""}${st.behind && st.ahead ? " y " : ""}${st.ahead ? `${st.ahead} por subir` : ""} — clic para sincronizar`
          : `${project.repo_path} · al día con ${st.remote}`;

  return (
    <button
      onClick={out ? sync : undefined}
      title={title}
      className={`ml-1 hidden items-center gap-1 rounded-md bg-white/[0.04] px-1.5 py-0.5 font-mono text-[11px] text-zinc-500 lg:flex ${
        out ? "cursor-pointer hover:bg-white/[0.08] hover:text-zinc-300" : "cursor-default"
      }`}
    >
      <GitBranch className="h-3 w-3" />
      {project.base_branch}
      {busy ? (
        <Spinner className="ml-0.5 h-3 w-3" />
      ) : (
        <>
          {st && st.behind > 0 && (
            <span className="flex items-center text-amber-300">
              <ArrowDown className="h-3 w-3" />
              {st.behind}
            </span>
          )}
          {st && st.ahead > 0 && (
            <span className="flex items-center text-sky-300">
              <ArrowUp className="h-3 w-3" />
              {st.ahead}
            </span>
          )}
          {st?.remote && !st.ok && <span className="h-1.5 w-1.5 rounded-full bg-red-400" />}
        </>
      )}
    </button>
  );
}

/** Small cloud chip: board shared with your other computers. */
export function SyncIndicator() {
  const s = useSync();
  if (!s?.enabled) return null;
  const Icon = s.ok ? Cloud : CloudOff;
  return (
    <span
      className={`hidden items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] md:flex ${s.ok ? "text-zinc-500" : "text-red-300"}`}
      title={
        s.ok
          ? `Tablero compartido entre tus ordenadores. Este es "${s.machine}".${s.last_sync ? ` Última sincronización: hace ${timeAgo(s.last_sync)}.` : ""}`
          : `Sin conexión con la base de datos compartida: ${s.error}. Sigues trabajando en local; se sincroniza al volver.${s.pending ? ` (${s.pending} cambios pendientes)` : ""}`
      }
    >
      <Icon className="h-3.5 w-3.5" />
      {s.machine}
      {!s.ok && s.pending > 0 && <span className="tabular">· {s.pending}</span>}
    </span>
  );
}

/** "en mac-casa" chip for cards whose agent/worktree is on another computer. */
export function MachineChip({ machine, className = "" }: { machine: string | null; className?: string }) {
  const s = useSync();
  if (!machine || !s?.enabled || machine === s.machine) return null;
  return (
    <span className={`inline-flex items-center gap-1 rounded-md bg-sky-400/10 px-1.5 text-[10.5px] leading-4 text-sky-200 ${className}`} title={`Su agente y su worktree están en ${machine}`}>
      <Laptop className="h-3 w-3" />
      {machine}
    </span>
  );
}

/** A project that came from another computer: clone it or point to its folder. */
export function UnlinkedBanner({ project, onLinked }: { project: Project; onLinked: () => void }) {
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState<"clone" | "link" | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const name = project.remote_url?.replace(/\.git$/, "").split(/[/:]/).pop() || project.name;

  const run = async (kind: "clone" | "link", body: unknown) => {
    setBusy(kind);
    try {
      await api(`/api/projects/${project.id}/${kind}`, body);
      setPicking(false);
      onLinked();
    } catch (e) {
      notice(kind === "clone" ? "No pude clonarlo" : "Esa carpeta no vale", (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-4 mb-3 rounded-xl bg-sky-400/[0.06] p-4 ring-1 ring-sky-300/15">
      <div className="flex flex-wrap items-center gap-3">
        <FolderGit2 className="h-5 w-5 shrink-0 text-sky-300" />
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-medium text-zinc-100">Este proyecto no está en este ordenador</div>
          <div className="mt-0.5 text-[12px] text-zinc-400">
            Ves el tablero, pero para que los agentes trabajen aquí necesito el repo
            {project.remote_url ? (
              <>
                {" "}(<span className="font-mono text-zinc-300">{project.remote_url}</span>)
              </>
            ) : (
              " (no tiene remoto: elige su carpeta)"
            )}
            .
          </div>
        </div>
        {project.remote_url && (
          <Button variant="primary" disabled={!!busy} onClick={() => run("clone", {})}>
            {busy === "clone" ? <Spinner className="h-3.5 w-3.5" /> : <Download className="h-3.5 w-3.5" />}
            Clonar en ~/code/{name}
          </Button>
        )}
        <Button onClick={() => setPicking((v) => !v)} disabled={!!busy}>
          Ya lo tengo: elegir carpeta…
        </Button>
      </div>
      {picking && (
        <div className="mt-3 space-y-2">
          <FolderPicker onPick={(p) => setPath(p)} selected={path ?? undefined} />
          <div className="flex justify-end">
            <Button variant="primary" disabled={!path || !!busy} onClick={() => run("link", { repo_path: path })}>
              {busy === "link" ? <Spinner className="h-3.5 w-3.5" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Usar esta carpeta
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
