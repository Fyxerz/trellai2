import { ArrowDown, ArrowUp, ChevronDown, Cloud, CloudOff, FolderGit2, GitBranch, Laptop, Download, Lock, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { COLUMN_LABELS, type Column, type Project } from "../../shared/types";
import { api, useSync, type Board } from "./api";
import { confirmDialog, notice } from "./Confirm";
import { FolderPicker } from "./FolderPicker";
import { Button, COLUMN_ACCENT, Spinner, timeAgo } from "./ui";

interface GitStatus {
  remote: string | null;
  ok: boolean;
  message?: string;
  ahead: number;
  behind: number;
}

interface BranchRow {
  name: string;
  local: boolean;
  remote: boolean;
  ahead: number;
  behind: number;
  merged: boolean;
  current: boolean;
  worktree: string | null;
  /** its worktree has uncommitted changes */
  dirty: boolean;
  /** commits not in the base branch */
  unmerged: number;
  sha: string;
  subject: string;
  date: string;
  card: { id: string; title: string; column: Column } | null;
  /** why it can't be deleted from here (base, current, card in progress) */
  locked: string | null;
}

interface DeleteResult {
  name: string;
  ok: boolean;
  error?: string;
}

interface BranchList {
  head: string;
  detached: boolean;
  remote: string | null;
  remoteLabel: string | null;
  base: string;
  fetch: { ok: boolean; message?: string };
  branches: BranchRow[];
}

/** Base branch pill in the header, with ↓/↑ against GitHub. Click to see every branch (and sync). */
export function BranchStatus({ project, board, onOpenCard }: { project: Project; board: Board; onOpenCard: (id: string) => void }) {
  const [st, setSt] = useState<GitStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) =>
      !root.current?.contains(e.target as Node) && !(e.target as Element).closest?.("[data-modal]") && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !document.querySelector("[data-modal]") && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  useEffect(() => setOpen(false), [project.id]);

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
          ? `${project.repo_path} · ${st.behind ? `${st.behind} commit(s) por bajar` : ""}${st.behind && st.ahead ? " y " : ""}${st.ahead ? `${st.ahead} por subir` : ""}`
          : `${project.repo_path} · al día con ${st.remote}`;

  return (
    <div ref={root} className="relative ml-1 hidden lg:block">
      <button
        onClick={() => project.repo_path && setOpen((v) => !v)}
        title={`${title}${project.repo_path ? " — clic para ver las ramas" : ""}`}
        aria-expanded={open}
        className={`flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[11px] transition ${
          open ? "bg-ui-ink/[0.1] text-zinc-200" : "bg-ui-ink/[0.04] text-zinc-500"
        } ${project.repo_path ? "cursor-pointer hover:bg-ui-ink/[0.08] hover:text-zinc-300" : "cursor-default"}`}
      >
        <GitBranch className="h-3 w-3" />
        {project.base_branch}
        {busy ? (
          <Spinner className="ml-0.5 h-3 w-3" />
        ) : (
          <>
            {st && st.behind > 0 && (
              <span className="flex items-center text-warning">
                <ArrowDown className="h-3 w-3" />
                {st.behind}
              </span>
            )}
            {st && st.ahead > 0 && (
              <span className="flex items-center text-info">
                <ArrowUp className="h-3 w-3" />
                {st.ahead}
              </span>
            )}
            {st?.remote && !st.ok && <span className="h-1.5 w-1.5 rounded-full bg-red-400" />}
          </>
        )}
        <ChevronDown className={`h-3 w-3 transition ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <BranchMenu
          project={project}
          board={board}
          title={title}
          syncing={busy}
          onSync={out ? sync : undefined}
          onOpenCard={(id) => {
            setOpen(false);
            onOpenCard(id);
          }}
        />
      )}
    </div>
  );
}

function BranchMenu({
  project,
  board,
  title,
  syncing,
  onSync,
  onOpenCard,
}: {
  project: Project;
  board: Board;
  title: string;
  syncing: boolean;
  onSync?: () => void;
  onOpenCard: (id: string) => void;
}) {
  const [list, setList] = useState<BranchList | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** branches being deleted right now */
  const [busy, setBusy] = useState<Set<string>>(new Set());
  /** last delete error per branch */
  const [failed, setFailed] = useState<Record<string, string>>({});
  const reload = useRef<() => void>(() => {});

  useEffect(() => {
    let alive = true;
    const load = () =>
      api<BranchList>(`/api/projects/${project.id}/branches`)
        .then((l) => alive && (setList(l), setError(null)))
        .catch((e) => alive && setError((e as Error).message));
    reload.current = load;
    load();
    // reload when a card gets a branch or changes column (merged, discarded…) or another computer pushed;
    // agents' status updates don't count
    const seen = new Map<string, string>();
    let t: ReturnType<typeof setTimeout> | undefined;
    const soon = () => {
      clearTimeout(t);
      t = setTimeout(load, 800);
    };
    const off = board.on((e) => {
      if (e.type === "sync") soon();
      else if (e.type === "card") {
        const key = `${e.card.branch}|${e.card.column}`;
        if (seen.has(e.card.id) && seen.get(e.card.id) !== key) soon();
        seen.set(e.card.id, key);
      }
    });
    return () => {
      alive = false;
      clearTimeout(t);
      off();
    };
  }, [project.id, syncing]);

  const branches = list?.branches ?? [];
  const base = branches.filter((b) => b.name === list?.base).map((b) => ({ ...b, merged: false }));
  const cards = branches.filter((b) => b.name !== list?.base && b.card);
  const others = branches.filter((b) => b.name !== list?.base && !b.card);
  const cleanable = branches.filter((b) => b.merged && !b.locked && b.name !== list?.base);
  const where = (b: BranchRow) =>
    !list?.remoteLabel ? "en este ordenador" : b.local && b.remote ? `en este ordenador y en ${list.remoteLabel}` : b.local ? "en este ordenador" : `en ${list.remoteLabel}`;

  const run = async (names: string[], call: () => Promise<DeleteResult[]>) => {
    setBusy((s) => new Set([...s, ...names]));
    setFailed((f) => Object.fromEntries(Object.entries(f).filter(([n]) => !names.includes(n))));
    let results: DeleteResult[];
    try {
      results = await call();
    } catch (e) {
      results = names.map((name) => ({ name, ok: false, error: (e as Error).message }));
    }
    setFailed((f) => ({ ...f, ...Object.fromEntries(results.filter((r) => !r.ok).map((r) => [r.name, r.error ?? "No se pudo borrar"])) }));
    setBusy((s) => new Set([...s].filter((n) => !names.includes(n))));
    reload.current();
  };

  const remove = async (b: BranchRow) => {
    const lines = [`Se borrará ${where(b)}.`];
    if (!b.merged) lines.push(`⚠️ Tiene ${b.unmerged} commit(s) que no están en ${list?.base}: se perderán.`);
    if (b.worktree) lines.push(`También se quitará su carpeta de trabajo (${b.worktree}).`);
    if (b.dirty) lines.push("⚠️ Esa carpeta tiene cambios sin commitear: se perderán.");
    const ok = await confirmDialog({
      title: `¿Borrar la rama ${b.name}?`,
      body: lines.join("\n"),
      confirmLabel: "Borrar rama",
      danger: true,
    });
    if (!ok) return;
    const force = !b.merged || b.dirty;
    await run([b.name], () =>
      fetch(`/api/projects/${project.id}/branches/delete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: b.name, force }),
      }).then(async (r) => [(await r.json()) as DeleteResult]),
    );
  };

  const cleanup = async () => {
    const dirty = cleanable.filter((b) => b.dirty);
    const ok = await confirmDialog({
      title: `¿Borrar ${cleanable.length} rama(s) ya mergeada(s)?`,
      body: [
        `Ya están en ${list?.base}; se borrarán en este ordenador${list?.remoteLabel ? ` y en ${list.remoteLabel}` : ""}, con sus carpetas de trabajo:`,
        ...cleanable.map((b) => `• ${b.name}${b.worktree ? " (con carpeta de trabajo)" : ""}${b.dirty ? " ⚠️ cambios sin guardar: se saltará" : ""}`),
        ...(dirty.length ? ["", "Las que tienen cambios sin guardar no se borran: hazlo una a una si quieres perderlos."] : []),
      ].join("\n"),
      confirmLabel: "Borrar todas",
      danger: true,
    });
    if (!ok) return;
    await run(
      cleanable.map((b) => b.name),
      () => api<{ results: DeleteResult[] }>(`/api/projects/${project.id}/branches/cleanup`, { names: cleanable.map((b) => b.name) }).then((r) => r.results),
    );
  };
  const rowProps = { remote: list?.remoteLabel ?? null, base: list?.base ?? "", busy, failed, onDelete: remove, onOpenCard };

  return (
    <div className="absolute top-full left-0 z-40 mt-1.5 w-[26rem] rounded-xl bg-zinc-900 p-1.5 font-sans shadow-[var(--shadow-pop)] ring-1 ring-ui-ink/[0.1]">
      <div className="flex items-center gap-2 px-2 pt-1 pb-2">
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-semibold text-zinc-100">Ramas</div>
          <div className="truncate text-[11px] text-zinc-500" title={title}>
            {list?.detached ? `Tu repo está en el commit ${list.head} (sin rama)` : list ? `Tu repo está en ${list.head}` : title}
          </div>
        </div>
        {onSync && (
          <Button onClick={onSync} disabled={syncing}>
            {syncing ? <Spinner className="h-3.5 w-3.5" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Sincronizar {project.base_branch}
          </Button>
        )}
      </div>
      {list && !list.fetch.ok && (
        <div className="mx-1 mb-1.5 rounded-lg bg-red-400/10 px-2.5 py-1.5 text-[11px] text-danger">
          {list.fetch.message} Lo que ves de {list.remoteLabel} puede no estar al día.
        </div>
      )}
      {error ? (
        <div className="px-2 py-3 text-[12px] text-danger">{error}</div>
      ) : !list ? (
        <div className="flex items-center gap-2 px-2 py-3 text-[12px] text-zinc-500">
          <Spinner className="h-3.5 w-3.5" /> Cargando ramas…
        </div>
      ) : (
        <div className="max-h-[60vh] overflow-y-auto">
          {cleanable.length > 0 && (
            <div className="mx-1 mb-1.5 flex items-center gap-2 rounded-lg bg-ui-ink/[0.03] px-2.5 py-1.5">
              <span className="min-w-0 flex-1 text-[11.5px] text-zinc-400">
                {cleanable.length} rama(s) ya están en {list.base}
              </span>
              <Button size="sm" variant="danger" onClick={cleanup} disabled={cleanable.some((b) => busy.has(b.name))}>
                <Trash2 className="h-3.5 w-3.5" />
                Limpiar ramas mergeadas
              </Button>
            </div>
          )}
          <BranchGroup label="Rama base" rows={base} {...rowProps} />
          <BranchGroup label="De tarjetas" rows={cards} {...rowProps} />
          <BranchGroup label="Otras" rows={others} {...rowProps} />
          {branches.length === 1 && <div className="px-2 pt-1 pb-2 text-[11.5px] text-zinc-500">No hay más ramas.</div>}
        </div>
      )}
    </div>
  );
}

interface RowProps {
  remote: string | null;
  base: string;
  busy: Set<string>;
  failed: Record<string, string>;
  onDelete: (b: BranchRow) => void;
  onOpenCard: (id: string) => void;
}

function BranchGroup({ label, rows, ...props }: { label: string; rows: BranchRow[] } & RowProps) {
  if (!rows.length) return null;
  return (
    <div className="mb-1">
      <div className="px-2 pt-1.5 pb-1 text-[10.5px] font-semibold tracking-wide text-zinc-600 uppercase">
        {label} · {rows.length}
      </div>
      <ul>
        {rows.map((b) => (
          <BranchItem key={b.name} b={b} {...props} />
        ))}
      </ul>
    </div>
  );
}

const TAG = "shrink-0 rounded px-1 text-[10px] leading-4";

function BranchItem({ b, remote, base, busy, failed, onDelete, onOpenCard }: { b: BranchRow } & RowProps) {
  const where = !remote ? null : b.local && b.remote ? null : b.local ? "solo aquí" : `solo en ${remote}`;
  const deleting = busy.has(b.name);
  const error = failed[b.name];
  const body = (
    <>
      <GitBranch className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${b.current ? "text-success" : "text-zinc-600"}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className={`truncate font-mono text-[11.5px] ${b.current ? "text-success" : "text-zinc-200"}`}>{b.name}</span>
          {b.current && <span className={`${TAG} bg-teal-400/12 font-semibold text-success`}>actual</span>}
          {where && <span className={`${TAG} bg-ui-ink/[0.06] text-zinc-400`}>{where}</span>}
          <span className="ml-auto flex shrink-0 items-center gap-1 font-mono text-[10.5px]">
            {b.behind > 0 && (
              <span className="flex items-center text-warning" title={`${b.behind} commit(s) en ${remote} que no tienes`}>
                <ArrowDown className="h-3 w-3" />
                {b.behind}
              </span>
            )}
            {b.ahead > 0 && (
              <span className="flex items-center text-info" title={`${b.ahead} commit(s) sin subir a ${remote}`}>
                <ArrowUp className="h-3 w-3" />
                {b.ahead}
              </span>
            )}
            <span className="text-zinc-600">{timeAgo(b.date)}</span>
          </span>
        </div>
        <div className="truncate text-[11px] text-zinc-500" title={`${b.sha} · ${b.subject}`}>
          {b.card ? (
            <>
              <span className={`mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle ${COLUMN_ACCENT[b.card.column]}`} />
              <span className="text-zinc-300">{b.card.title}</span> · {COLUMN_LABELS[b.card.column]}
            </>
          ) : (
            b.subject
          )}
        </div>
        {b.name !== base && (b.merged || b.unmerged > 0 || b.worktree) && (
          <div className="mt-0.5 flex flex-wrap items-center gap-1">
            {b.merged ? (
              <span className={`${TAG} bg-emerald-400/10 text-success`} title={`Todos sus commits ya están en ${base}`}>
                mergeada
              </span>
            ) : (
              b.unmerged > 0 && (
                <span className={`${TAG} bg-amber-400/10 text-warning`} title={`Commits que no están en ${base}`}>
                  {b.unmerged} commit{b.unmerged === 1 ? "" : "s"} sin mergear
                </span>
              )
            )}
            {b.worktree && (
              <span className={`${TAG} bg-sky-400/10 text-info`} title={b.worktree}>
                tiene carpeta de trabajo
              </span>
            )}
            {b.dirty && (
              <span className={`${TAG} bg-red-400/10 text-danger`} title={b.worktree ?? ""}>
                cambios sin guardar
              </span>
            )}
          </div>
        )}
        {b.locked && b.name !== base && <div className="mt-0.5 text-[10.5px] text-zinc-600">{b.locked}</div>}
        {error && <div className="mt-0.5 text-[11px] text-danger">{error}</div>}
      </div>
    </>
  );
  return (
    <li className={`flex items-start rounded-lg transition hover:bg-ui-ink/[0.05] ${deleting ? "opacity-50" : ""}`}>
      {b.card ? (
        <button onClick={() => onOpenCard(b.card!.id)} className="flex min-w-0 flex-1 items-start gap-2 py-1.5 pl-2 text-left" title="Abrir la tarjeta">
          {body}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-start gap-2 py-1.5 pl-2">{body}</div>
      )}
      <div className="flex w-8 shrink-0 justify-center pt-1.5">
        {deleting ? (
          <Spinner className="h-3.5 w-3.5" />
        ) : b.locked ? (
          <span className="p-0.5 text-zinc-700" title={`No se puede borrar: ${b.locked}`} aria-label={`No se puede borrar: ${b.locked}`}>
            <Lock className="h-3 w-3" />
          </span>
        ) : (
          <button
            onClick={() => onDelete(b)}
            className="rounded p-0.5 text-zinc-600 transition hover:bg-red-500/10 hover:text-danger"
            title="Borrar esta rama"
            aria-label={`Borrar la rama ${b.name}`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </li>
  );
}

/** Small cloud chip: board shared with your other computers. */
export function SyncIndicator() {
  const s = useSync();
  if (!s?.enabled) return null;
  const Icon = s.ok ? Cloud : CloudOff;
  return (
    <span
      className={`hidden items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] md:flex ${s.ok ? "text-zinc-500" : "text-danger"}`}
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
    <span className={`inline-flex items-center gap-1 rounded-md bg-sky-400/10 px-1.5 text-[10.5px] leading-4 text-info ${className}`} title={`Su agente y su worktree están en ${machine}`}>
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
        <FolderGit2 className="h-5 w-5 shrink-0 text-info" />
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
