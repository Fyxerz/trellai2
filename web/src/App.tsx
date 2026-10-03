import { Notifications, reportError } from "./notifications";
import { useMessageDraft, useChatScroll } from "./chat";
import { projectName, MOD, Appearance, useDialogFocus } from "./preferences";
import { useEffect, useRef, useState } from "react";
import { COLUMNS, type Column, type Project } from "../../shared/types";
import { api, useBoard, useProjects, type Board as BoardState } from "./api";
import { AssistantPanel, type AssistantMode } from "./Assistant";
import { Board, CAN_ADD, columnCards, moveCard } from "./Board";
import { CardPanel } from "./CardPanel";
import { FolderPicker } from "./FolderPicker";
import { Help } from "./Help";
import { ConfirmHost, confirmDeleteCard, togglePreview } from "./Confirm";
import { Home } from "./Home";
import {
  ChevronRight,
  Eye,
  Keyboard,
  MessageCircleQuestion,
  PanelLeft,
  Radio,
  SlidersHorizontal,
  Sparkles,
  Search,
  X,
} from "lucide-react";
import { ProjectSettings } from "./models";
import { Sidebar } from "./Sidebar";
import { BranchStatus, SyncIndicator, UnlinkedBanner } from "./SyncUI";
import { Button, ChatHint, chatKeyDown, Kbd, ProjectAvatar, timeAgo } from "./ui";

const LAST_PROJECT = "trellai:project";
const SIDEBAR_OPEN = "trellai:sidebar";
const VIEW = "trellai:view";

const store = {
  get(k: string) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* ignore */
    }
  },
};

export function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

type Zone = "board" | "sidebar";

export default function App() {
  const { projects, reload } = useProjects();
  const [projectId, setProjectId] = useState<string | null>(() => store.get(LAST_PROJECT));
  const [showNew, setShowNew] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showAssistant, setShowAssistant] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [assistantMode, setAssistantMode] = useState<AssistantMode>("plan");
  const [selected, setSelected] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(() => store.get(SIDEBAR_OPEN) !== "0");
  const [zone, setZone] = useState<Zone>("board");
  const [sideCursor, setSideCursor] = useState(0);
  const [cursor, setCursor] = useState<{ col: Column; id: string | null }>({ col: "plan", id: null });
  const [adding, setAdding] = useState<Column | null>(null);
  const [view, setView] = useState<"home" | "board">(() => (store.get(VIEW) === "home" ? "home" : "board"));
  const [homeCursor, setHomeCursor] = useState(0);
  const board = useBoard(projectId);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const visibleBoard = { ...board, cards: Object.fromEntries(Object.entries(board.cards).filter(([, c]) =>
    (!query.trim() || `${c.title} ${c.spec}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) &&
    (filter === "all" || (filter === "waiting" ? c.status === "waiting" : filter === "review" ? c.column === "review" : c.status === "error"))
  )) };
  useEffect(() => { setQuery(""); setFilter("all"); }, [projectId]);

  useEffect(() => {
    if (!projects) return;
    if (!projects.length) setShowNew(true);
    else if (!projects.some((p) => p.id === projectId)) setProjectId(projects[0].id);
  }, [projects]);
  useEffect(() => {
    if (projectId) store.set(LAST_PROJECT, projectId);
    setSelected(null);
    setAdding(null);
    setCursor((c) => ({ col: c.col, id: null }));
  }, [projectId]);
  useEffect(() => store.set(SIDEBAR_OPEN, sidebarOpen ? "1" : "0"), [sidebarOpen]);
  useEffect(() => store.set(VIEW, view), [view]);
  // "Ver esta rama" changes live on the project row
  useEffect(() => {
    const off = board.on((e) => {
      if (e.type === "preview" || e.type === "sync") reload();
    });
    return () => void off();
  }, [projectId]);

  const openProject = (id: string) => {
    setProjectId(id);
    setView("board");
    setZone("board");
  };
  const goHome = () => {
    setView("home");
    setSelected(null);
    setShowAssistant(false);
    setShowNotes(false);
    setZone("board");
    setHomeCursor(Math.max(0, projects?.findIndex((p) => p.id === projectId) ?? 0));
  };

  const project = projects?.find((p) => p.id === projectId);
  const previewCard = project?.preview_card_id ? board.cards[project.preview_card_id] : undefined;
  const card = selected ? board.cards[selected] : undefined;
  const cards = Object.values(board.cards);
  const running = cards.filter((c) => c.status === "running").length;
  const waiting = cards.filter((c) => c.status === "waiting").length;

  // ------------------------------------------------------------------ keyboard
  // Everything the handler needs, read through a ref so the listener is attached once.
  const st = useRef({ projects, projectId, zone, sideCursor, cursor, board: visibleBoard, selected, sidebarOpen, showHelp, showNew, adding, view, homeCursor });
  st.current = { projects, projectId, zone, sideCursor, cursor, board: visibleBoard, selected, sidebarOpen, showHelp, showNew, adding, view, homeCursor };

  // Clicking anywhere outside the open card's panel (or a card on the board) closes it.
  useEffect(() => {
    if (!selected) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t?.isConnected || document.querySelector("[data-modal]")) return;
      if (t.closest('[aria-label="Detalle de tarjeta"], [data-card], [role="alert"], [role="status"]')) return;
      setSelected(null);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [selected]);
  const actions = useRef({ openProject, goHome });
  actions.current = { openProject, goHome };
  const pendingG = useRef(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.repeat) return;
      const s = st.current;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key;

      // Keep editor shortcuts intact while typing.
      if (mod && key.toLowerCase() === "b" && !isTyping(e) && !document.querySelector("[data-modal]")) {
        e.preventDefault();
        if (s.sidebarOpen && s.zone === "sidebar") {
          setSidebarOpen(false);
          setZone("board");
        } else {
          setSidebarOpen(true);
          setZone("sidebar");
          setSideCursor(Math.max(0, s.projects?.findIndex((p) => p.id === s.projectId) ?? 0));
        }
        return;
      }
      if (isTyping(e)) {
        if (key === "Escape") (e.target as HTMLElement).blur();
        return;
      }
      if (s.showNew || document.querySelector("[data-modal]")) {
        if (key === "Escape") {
          setShowSettings(false);
          setShowHelp(false);
          if (s.projects?.length) setShowNew(false);
        }
        return;
      }
      if (key === "Escape") {
        setSelected(null); setShowAssistant(false); setShowNotes(false);
        if (s.zone === "sidebar") setZone("board");
        return;
      }
      if ((e.target as HTMLElement)?.closest("button, a")) return;
      if (s.showHelp) {
        if (key === "Escape" || key === "?") setShowHelp(false);
        return;
      }
      if (mod || e.altKey) {
        // ⌘N is reserved by most browsers, but try anyway (works in app-mode windows)
        if (mod && key.toLowerCase() === "n" && !e.shiftKey) {
          e.preventDefault();
          newCard();
        }
        return;
      }

      if (key === "?") return setShowHelp(true);
      if (key === "p") {
        if (s.view === "home" && s.projectId) actions.current.openProject(s.projectId);
        else actions.current.goHome();
        return;
      }

      // ---------------- projects overview
      if (s.view === "home" && s.zone !== "sidebar") {
        const n = s.projects?.length ?? 0;
        if (!n) return;
        if (["j", "l", "ArrowDown", "ArrowRight"].includes(key)) return e.preventDefault(), setHomeCursor((i) => Math.min(n - 1, i + 1));
        if (["k", "h", "ArrowUp", "ArrowLeft"].includes(key)) return e.preventDefault(), setHomeCursor((i) => Math.max(0, i - 1));
        if (key === "Enter" || key === "o") return actions.current.openProject(s.projects![s.homeCursor].id);
        if (/^[1-9]$/.test(key) && Number(key) <= n) return actions.current.openProject(s.projects![Number(key) - 1].id);
        if (key === "n") return setShowNew(true);
        if (key === "[" || key === "]") return;
        if (key !== "t" && key !== "d" && key !== "a") return;
      }
      if (key === "[" || key === "]") return switchProject(key === "]" ? 1 : -1);
      if (key === "a") {
        if (st.current.view === "home") setView("board");
        setShowAssistant(false);
        // The open card hides the channel: close it so the channel shows.
        if (st.current.selected) {
          setSelected(null);
          return setShowNotes(true);
        }
        return setShowNotes((v) => !v);
      }
      if (key === "t" || key === "d") {
        e.preventDefault();
        if (st.current.view === "home") setView("board");
        setShowNotes(false);
        setSelected(null);
        setShowAssistant(true);
        setAssistantMode(key === "t" ? "plan" : "do");
        setTimeout(() => document.querySelector<HTMLElement>('[data-kb="assistant"]')?.focus(), 30);
        return;
      }

      // ---------------- sidebar
      if (s.zone === "sidebar" && s.projects?.length) {
        const n = s.projects.length;
        if (key === "j" || key === "ArrowDown") return e.preventDefault(), setSideCursor((i) => Math.min(n - 1, i + 1));
        if (key === "k" || key === "ArrowUp") return e.preventDefault(), setSideCursor((i) => Math.max(0, i - 1));
        if (key === "Enter" || key === "l" || key === "ArrowRight") return actions.current.openProject(s.projects[s.sideCursor].id);
        if (/^[1-9]$/.test(key) && Number(key) <= n) return actions.current.openProject(s.projects[Number(key) - 1].id);
        if (key === "n") return setShowNew(true);
        if (key === "Escape" || key === "h" || key === "ArrowLeft") return setZone("board");
        return;
      }

      // ---------------- board
      const cur = resolveCursor();
      const colIdx = COLUMNS.indexOf(cur.col);
      const list = columnCards(s.board.cards, cur.col);
      const follow = (id: string | null) => {
        if (s.selected && id) setSelected(id);
      };
      const go = (col: Column, id: string | null) => {
        setCursor({ col, id });
        follow(id);
      };

      if (key === "Escape") {
        if (s.selected) setSelected(null);
        return;
      }
      if (e.shiftKey && (key === "H" || key === "L")) {
        if (!cur.id) return;
        const to = COLUMNS[colIdx + (key === "L" ? 1 : -1)];
        if (!to) return;
        moveCard(s.board, cur.id, to, Number.MAX_SAFE_INTEGER);
        setCursor({ col: to, id: cur.id });
        return;
      }
      if (e.shiftKey && (key === "J" || key === "K")) {
        if (!cur.id) return;
        const i = list.findIndex((c) => c.id === cur.id);
        const j = i + (key === "J" ? 1 : -1);
        if (j < 0 || j >= list.length) return;
        moveCard(s.board, cur.id, cur.col, j);
        return;
      }
      if (key === "h" || key === "l" || key === "ArrowLeft" || key === "ArrowRight") {
        e.preventDefault();
        const dir = key === "l" || key === "ArrowRight" ? 1 : -1;
        const col = COLUMNS[Math.max(0, Math.min(COLUMNS.length - 1, colIdx + dir))];
        const target = columnCards(s.board.cards, col);
        const pos = Math.max(0, list.findIndex((c) => c.id === cur.id));
        go(col, target[Math.min(pos, target.length - 1)]?.id ?? null);
        return;
      }
      if (key === "j" || key === "k" || key === "ArrowDown" || key === "ArrowUp") {
        e.preventDefault();
        if (!list.length) return;
        const i = list.findIndex((c) => c.id === cur.id);
        const dir = key === "j" || key === "ArrowDown" ? 1 : -1;
        const next = i === -1 ? 0 : Math.max(0, Math.min(list.length - 1, i + dir));
        go(cur.col, list[next].id);
        return;
      }
      if (key === "g" || key === "G") {
        if (!list.length) return;
        if (key === "G") return go(cur.col, list[list.length - 1].id);
        if (Date.now() - pendingG.current < 500) go(cur.col, list[0].id);
        else pendingG.current = Date.now();
        return;
      }
      if (key === "Enter" || key === "o") {
        if (cur.id) setSelected(cur.id);
        return;
      }
      if (key === "n") {
        e.preventDefault();
        newCard();
        return;
      }
      if (key === "v" && cur.id) {
        const target = s.board.cards[cur.id];
        const proj = s.projects?.find((p) => p.id === s.projectId);
        if (target?.branch) togglePreview(target, proj?.preview_card_id === target.id);
        return;
      }
      if ((key === "x" || key === "Delete" || key === "Backspace") && cur.id) {
        e.preventDefault();
        const target = s.board.cards[cur.id];
        if (!target) return;
        const i = list.findIndex((c) => c.id === cur.id);
        const next = list[i + 1] ?? list[i - 1];
        confirmDeleteCard(target).then((ok) => {
          if (!ok) return;
          api(`/api/cards/${target.id}`, undefined, "DELETE").catch((err) => reportError(err.message));
          if (st.current.selected === target.id) setSelected(null);
          setCursor({ col: cur.col, id: next?.id ?? null });
        });
      }
    };

    /** Cursor with a valid id (cards move under our feet when agents finish). */
    function resolveCursor() {
      const s = st.current;
      const c = s.cursor;
      const list = columnCards(s.board.cards, c.col);
      if (c.id && list.some((x) => x.id === c.id)) return c;
      return { col: c.col, id: list[0]?.id ?? null };
    }

    function newCard() {
      const s = st.current;
      if (!s.projectId) return;
      const col = CAN_ADD.has(s.cursor.col) ? s.cursor.col : "plan";
      setZone("board");
      setCursor({ col, id: null });
      setAdding(col);
    }

    function switchProject(dir: number) {
      const s = st.current;
      if (!s.projects?.length) return;
      const i = s.projects.findIndex((p) => p.id === s.projectId);
      const next = s.projects[(i + dir + s.projects.length) % s.projects.length];
      setProjectId(next.id);
      setSideCursor(s.projects.indexOf(next));
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const inBoard = view === "board" && !!project;

  return (
    <div className="flex h-full flex-col">
      <header className="app-header flex min-h-16 shrink-0 items-center gap-2 border-b border-ui-ink/[0.05] px-3">
        <button
          onClick={() => setSidebarOpen((v) => !v)}
          className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-ui-ink/[0.06] hover:text-zinc-200"
          title={`${MOD}+B · Barra de proyectos`}
        >
          <PanelLeft className="h-4 w-4" />
        </button>
        <button onClick={goHome} className="flex items-center gap-2 rounded-lg px-1.5 py-1 transition hover:bg-ui-ink/[0.04]" title="Todos los proyectos (p)">
          <Logo />
          <span className="text-[14px] font-semibold tracking-tight text-zinc-100">Trellai</span>
        </button>
        {inBoard && (
          <>
            <ChevronRight className="h-3.5 w-3.5 text-zinc-600" />
            <ProjectAvatar id={project!.id} name={projectName(project!.name)} size={30} />
            <span title={project!.repo_path || project!.name} className="max-w-[28rem] truncate text-2xl font-bold tracking-tight text-zinc-50">{projectName(project!.name)}</span>
            <BranchStatus project={project!} board={board} />
          </>
        )}
        {view === "home" && (
          <>
            <ChevronRight className="h-3.5 w-3.5 text-zinc-600" />
            <span className="text-sm font-medium text-zinc-300">Proyectos</span>
          </>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          <Appearance />
          <SyncIndicator />
          {inBoard && project?.preview_card_id && (
            <span className="mr-1 flex items-center gap-2 rounded-full bg-teal-400/10 py-1 pr-1 pl-2.5 text-[11.5px] text-teal-300 ring-1 ring-teal-300/20">
              <Eye className="h-3.5 w-3.5 text-teal-300" />
              <span className="max-w-[260px] truncate">
                Tu repo muestra: <button className="font-medium hover:underline" onClick={() => previewCard && setSelected(previewCard.id)}>{previewCard?.title ?? "otra rama"}</button>
              </span>
              <button
                onClick={() => togglePreview({ id: project.preview_card_id!, project_id: project.id, title: "" }, true)}
                className="rounded-full bg-teal-300/15 px-2 py-0.5 font-medium text-teal-300 transition hover:bg-teal-300/25"
              >
                Volver a {project.base_branch}
              </button>
            </span>
          )}
          {inBoard && running > 0 && (
            <span className="mr-1 flex items-center gap-1.5 rounded-full bg-amber-400/10 px-2.5 py-1 text-[11.5px] text-amber-200">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
              {running} trabajando
            </span>
          )}
          {inBoard && waiting > 0 && (
            <span className="mr-1 flex items-center gap-1.5 rounded-full bg-violet-400/10 px-2.5 py-1 text-[11.5px] text-violet-200">
              <MessageCircleQuestion className="h-3 w-3" />
              {waiting} te {waiting === 1 ? "necesita" : "necesitan"}
            </span>
          )}
          {inBoard && (
            <>
              {/* An open card hides these panels: opening one closes the card. */}
              <HeaderButton
                active={showAssistant && !card}
                icon={<Sparkles className="h-3.5 w-3.5" />}
                label="Asistente"
                kbd="t"
                onClick={() => {
                  setShowNotes(false);
                  setShowAssistant(!!card || !showAssistant);
                  setSelected(null);
                }}
              />
              <HeaderButton
                active={showNotes && !card}
                icon={<Radio className="h-3.5 w-3.5" />}
                label={`Canal${board.notes.length ? ` · ${board.notes.length}` : ""}`}
                kbd="a"
                onClick={() => {
                  setShowAssistant(false);
                  setShowNotes(!!card || !showNotes);
                  setSelected(null);
                }}
              />
              <span className="mx-1 h-4 w-px bg-ui-ink/[0.08]" />
              <IconButton title="Modelos del proyecto" onClick={() => setShowSettings(true)}>
                <SlidersHorizontal className="h-4 w-4" />
              </IconButton>
            </>
          )}
          <IconButton title="Atajos de teclado (?)" onClick={() => setShowHelp(true)}>
            <Keyboard className="h-4 w-4" />
          </IconButton>
          <span
            className={`ml-1 h-1.5 w-1.5 rounded-full ${board.connected || view === "home" ? "bg-emerald-400" : "bg-red-500"}`}
            title={board.connected ? "Conectado" : "Desconectado"}
          />
        </div>
      </header>

      <main className="flex min-h-0 flex-1">
        {sidebarOpen && projects && projects.length > 0 && (
          <Sidebar
            projects={projects}
            currentId={projectId}
            home={view === "home"}
            focused={zone === "sidebar"}
            cursor={sideCursor}
            onPick={openProject}
            onHome={goHome}
            onNew={() => setShowNew(true)}
            onRemoved={reload}
          />
        )}
        <div className="min-w-0 flex-1 pt-3" onMouseDown={() => setZone("board")}>
          {view === "home" && projects ? (
            <Home projects={projects} cursor={homeCursor} onOpen={openProject} onNew={() => setShowNew(true)} onRemoved={reload} />
          ) : projectId && project ? (
            <div className="flex h-full flex-col">
            <div className="flex flex-wrap items-center gap-3 px-4 pb-3">
              <label className="flex min-w-48 max-w-sm flex-1 items-center gap-2 rounded-lg border border-ui-ink/10 bg-panel px-3 py-2"><Search className="h-4 w-4 text-zinc-500" /><input aria-label="Buscar tarjetas" placeholder="Buscar tarjetas…" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === "Escape") { e.stopPropagation(); if (query) setQuery(""); else e.currentTarget.blur(); } }} className="min-w-0 flex-1 bg-transparent text-sm outline-none" />{query && <button aria-label="Limpiar búsqueda" className="text-zinc-500" onClick={() => setQuery("")}>×</button>}</label>
              <div role="group" aria-label="Filtrar tarjetas" className="flex flex-wrap gap-1">{[["all", "Todas"], ["waiting", "Te necesitan"], ["review", "Por revisar"], ["error", "Errores"]].map(([value, label]) => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)} className={`rounded-lg px-3 py-2 text-sm transition ${filter === value ? "bg-indigo-500/10 text-indigo-300 ring-1 ring-indigo-400/30" : "text-zinc-400 hover:bg-ui-ink/5"}`}>{label}</button>)}</div>
              {(query || filter !== "all") && <span role="status" className="text-xs text-zinc-500">{Object.keys(visibleBoard.cards).length} resultados</span>}
            </div>
            {!project.repo_path && <UnlinkedBanner project={project} onLinked={reload} />}
            <div className="min-h-0 flex-1">
            <Board
              projectId={projectId}
              board={visibleBoard}
              onOpen={setSelected}
              selectedId={selected}
              adding={adding}
              setAdding={setAdding}
              cursor={cursor}
              focused={zone === "board"}
              onCursor={(col, id) => setCursor({ col, id })}
              previewCardId={project?.preview_card_id}
            />
            </div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-zinc-500">Crea un proyecto para empezar.</div>
          )}
        </div>
        {inBoard && card && <CardPanel key={card.id} card={card} board={board} project={project} onClose={() => setSelected(null)} />}
        {inBoard && showAssistant && projectId && !card && (
          <AssistantPanel
            key={projectId}
            projectId={projectId}
            board={board}
            onOpenCard={setSelected}
            mode={assistantMode}
            setMode={setAssistantMode}
            project={project}
            onProjectChange={reload}
            onClose={() => setShowAssistant(false)}
          />
        )}
        {inBoard && showNotes && projectId && !card && <NotesPanel key={projectId} projectId={projectId} board={board} onOpen={setSelected} onClose={() => setShowNotes(false)} />}
      </main>

      <Notifications />
      <ConfirmHost />
      {showHelp && <Help onClose={() => setShowHelp(false)} />}
      {showSettings && project && <ProjectSettings project={project} onClose={() => setShowSettings(false)} onSaved={reload} />}
      {showNew && (
        <NewProject
          canClose={!!projects?.length}
          onClose={() => setShowNew(false)}
          onCreated={(p) => {
            setShowNew(false);
            reload();
            openProject(p.id);
          }}
        />
      )}
    </div>
  );
}

function NotesPanel({ projectId, board, onOpen, onClose }: { projectId: string; board: BoardState; onOpen: (id: string) => void; onClose: () => void }) {
  const { text, setText, current } = useMessageDraft(`notes-draft:${projectId}`);
  const scroll = useChatScroll(board.notes.length);
  const busy = useRef(false);
  const [sending, setSending] = useState(false);
  const send = async () => {
    const submitted = current.current;
    if (!submitted.trim() || busy.current) return;
    busy.current = true; setSending(true);
    try { await api(`/api/projects/${projectId}/notes`, { content: submitted.trim() }); if (current.current === submitted) setText(""); }
    catch (e) { reportError((e as Error).message); }
    finally { busy.current = false; setSending(false); }
  };
  return (
    <aside className="work-panel flex h-full w-[360px] shrink-0 flex-col border-l border-ui-ink/[0.06] bg-panel shadow-[-24px_0_48px_-24px_rgb(0_0_0/0.6)]">
      <div className="border-b border-zinc-800 px-4 py-3">
        <div className="flex items-center justify-between"><h2 className="text-sm font-semibold text-zinc-100">Canal de agentes</h2><button aria-label="Cerrar canal" onClick={onClose} className="rounded-lg p-2 text-zinc-400 hover:bg-ui-ink/5"><X className="h-4 w-4" /></button></div>
        <p className="text-xs text-zinc-500">Lo que se cuentan entre ellos mientras trabajan en paralelo.</p>
      </div>
      <div ref={scroll.container} onScroll={scroll.onScroll} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {board.notes.length === 0 && <p className="text-sm text-zinc-500">Todavía nada.</p>}
        {board.notes.map((n) => (
          <div key={n.id} className="text-sm">
            <div className="mb-0.5 flex items-center gap-2 text-[11px] text-zinc-500">
              {n.card_id ? (
                <button onClick={() => onOpen(n.card_id!)} className="font-medium text-zinc-300 hover:underline">
                  {n.card_title}
                </button>
              ) : (
                <span className="font-medium text-zinc-400">Trellai</span>
              )}
              <span>{timeAgo(n.created_at)}</span>
            </div>
            <div className="text-zinc-300">{n.content}</div>
          </div>
        ))}
        <div ref={scroll.end} />
      </div>
      {scroll.unread && <button onClick={scroll.jump} className="self-center rounded-full bg-indigo-500/10 px-3 py-1 text-xs text-indigo-300">Nuevos mensajes ↓</button>}
      <div className="border-t border-zinc-800 p-3">
        <textarea aria-label="Mensaje al canal de agentes" rows={2} value={text} onChange={e => setText(e.target.value)} onKeyDown={e => chatKeyDown(e, send, setText)} placeholder="Avisa a todos los agentes…" className="w-full resize-y rounded-lg bg-zinc-900 px-3 py-2 text-sm ring-1 ring-zinc-800 outline-none focus:ring-indigo-500" />
        <div className="mt-2 flex items-center justify-between gap-2"><p className="text-xs text-zinc-500"><ChatHint /></p><Button onClick={send} disabled={!text.trim() || sending}>Enviar</Button></div>
      </div>
    </aside>
  );
}

function NewProject({ onClose, onCreated, canClose }: { onClose: () => void; onCreated: (p: Project) => void; canClose: boolean }) {
  const dialogRef = useDialogFocus<HTMLFormElement>();
  const [repo, setRepo] = useState<{ path: string; isRepo: boolean } | null>(null);
  const [name, setName] = useState("");
  const [base, setBase] = useState("");
  const [init, setInit] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const pick = (path: string, isRepo: boolean) => {
    setRepo({ path, isRepo });
    setName(projectName(path));
    setInit(!isRepo);
    setError("");
  };

  return (
    <div data-modal className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[2px]" onClick={() => canClose && onClose()}>
      <form
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Nuevo proyecto"
        onClick={(e) => e.stopPropagation()}
        onSubmit={async (e) => {
          e.preventDefault();
          if (!repo || saving || (!repo.isRepo && !init)) return;
          setError("");
          setSaving(true);
          try {
            onCreated(await api<Project>("/api/projects", { repo_path: repo.path, name, base_branch: base, init }));
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setSaving(false);
          }
        }}
        className="w-full max-w-xl space-y-4 rounded-2xl bg-zinc-900 p-5 ring-1 ring-ui-ink/[0.08] shadow-[var(--shadow-pop)]"
      >
        <div>
          <h2 className="text-base font-semibold text-zinc-100">Nuevo proyecto</h2>
          <p className="text-xs text-zinc-500">Elige la carpeta del repo. Las carpetas con git salen en verde.</p>
        </div>

        <FolderPicker onPick={pick} selected={repo?.path} />

        {repo && (
          <div className="space-y-3 rounded-lg bg-zinc-950 p-3 ring-1 ring-zinc-800">
            <div className="truncate font-mono text-xs text-zinc-300">{repo.path}</div>
            {!repo.isRepo && (
              <label className="flex items-center gap-2 text-xs text-amber-200">
                <input type="checkbox" checked={init} onChange={(e) => setInit(e.target.checked)} className="accent-amber-400" />
                No es un repo git — inicializarlo aquí (git init + primer commit)
              </label>
            )}
            <div className="flex gap-3">
              <label className="block flex-1 text-xs text-zinc-400">
                Nombre
                <input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 w-full rounded-md bg-zinc-900 px-3 py-2 text-sm text-zinc-100 ring-1 ring-zinc-700 outline-none focus:ring-indigo-500" />
              </label>
              <label className="block w-40 text-xs text-zinc-400">
                Rama base
                <input value={base} onChange={(e) => setBase(e.target.value)} placeholder="la actual" className="mt-1 w-full rounded-md bg-zinc-900 px-3 py-2 font-mono text-sm text-zinc-100 ring-1 ring-zinc-700 outline-none placeholder:text-zinc-600 focus:ring-indigo-500" />
              </label>
            </div>
          </div>
        )}

        {error && <p className="text-sm text-red-300">{error}</p>}
        <div className="flex justify-end gap-2">
          {canClose && (
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
          )}
          <Button variant="primary" type="submit" disabled={!repo || (!repo.isRepo && !init) || saving}>
            Crear proyecto
          </Button>
        </div>
      </form>
    </div>
  );
}

function Logo() {
  return (
    <span className="flex h-6 w-6 items-center justify-center rounded-[7px] bg-gradient-to-br from-indigo-400 to-indigo-500 shadow-[0_1px_0_0_rgb(255_255_255/0.3)_inset,0_2px_8px_-2px_rgb(99_102_241/0.6)]">
      <svg width="14" height="14" viewBox="0 0 32 32">
        <rect x="4" y="6" width="6" height="20" rx="2" fill="white" />
        <rect x="13" y="6" width="6" height="13" rx="2" fill="white" fillOpacity=".8" />
        <rect x="22" y="6" width="6" height="16" rx="2" fill="white" fillOpacity=".6" />
      </svg>
    </span>
  );
}

function HeaderButton({ active, icon, label, kbd, onClick }: { active: boolean; icon: React.ReactNode; label: string; kbd: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] transition ${
        active ? "bg-ui-ink/[0.09] text-zinc-50 ring-1 ring-ui-ink/[0.1]" : "text-zinc-400 hover:bg-ui-ink/[0.05] hover:text-zinc-100"
      }`}
    >
      {icon}
      {label}
      <span className="ml-0.5 hidden xl:inline-flex">
        <Kbd>{kbd}</Kbd>
      </span>
    </button>
  );
}

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} title={title} className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-ui-ink/[0.06] hover:text-zinc-200">
      {children}
    </button>
  );
}
