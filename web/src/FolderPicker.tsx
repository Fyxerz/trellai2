import { useEffect, useState } from "react";
import { api } from "./api";
import { Button, Spinner } from "./ui";

interface Listing {
  path: string;
  parent: string | null;
  home: string;
  isRepo: boolean;
  branch: string | null;
  entries: { name: string; path: string; isRepo: boolean }[];
  nativePicker: boolean;
}

const LAST_DIR = "trellai:lastDir";

/**
 * In-app folder browser. Calls `onPick(path)` when you choose a folder.
 * A click selects an entry; double click or Enter opens it.
 * Git repos are highlighted; plain folders can be chosen too (the caller decides).
 */
export function FolderPicker({ onPick, selected, start: startAt }: { onPick: (path: string, isRepo: boolean) => void; selected?: string; /** folder to open first (default: the last one visited) */ start?: string }) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [hidden, setHidden] = useState(false);
  const [typed, setTyped] = useState("");
  // Entry selected with a single click (double click / Enter opens it).
  const [highlighted, setHighlighted] = useState<Listing["entries"][number] | null>(null);

  const go = async (path: string): Promise<boolean> => {
    setLoading(true);
    setError("");
    setHighlighted(null);
    try {
      const l = await api<Listing>(`/api/fs?path=${encodeURIComponent(path)}${hidden ? "&hidden=1" : ""}`);
      setListing(l);
      setTyped(l.path);
      setFilter("");
      try {
        localStorage.setItem(LAST_DIR, l.path);
      } catch {
        /* ignore */
      }
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let start = startAt || "~/code";
    if (!startAt) {
      try {
        start = localStorage.getItem(LAST_DIR) ?? start;
      } catch {
        /* ignore */
      }
    }
    go(start).then((ok) => !ok && go("~"));
  }, []);
  useEffect(() => {
    if (listing) go(listing.path);
  }, [hidden]);

  const native = async () => {
    const { path } = await api<{ path: string | null }>("/api/fs/pick", {});
    if (path) {
      await go(path);
      onPick(path, true);
    }
  };

  const crumbs = listing ? breadcrumbs(listing.path, listing.home) : [];
  const entries = (listing?.entries ?? []).filter((e) => e.name.toLowerCase().includes(filter.toLowerCase()));
  // What the footer describes and «Usar esta carpeta» picks: the selected entry, else the current folder.
  // The listing doesn't include subfolders' branches.
  const current = highlighted ? { ...highlighted, branch: null } : listing && { path: listing.path, isRepo: listing.isRepo, branch: listing.branch };

  return (
    <div className="overflow-hidden rounded-lg ring-1 ring-zinc-700">
      {/* path bar */}
      <div
        className="flex items-center gap-1 border-b border-zinc-800 bg-zinc-950 px-2 py-1.5"
      >
        <button type="button" disabled={!listing?.parent} onClick={() => listing?.parent && go(listing.parent)} className="rounded px-1.5 py-0.5 text-zinc-400 hover:bg-zinc-800 disabled:opacity-30" title="Subir">
          ↑
        </button>
        <input
          aria-label="Ruta de carpeta"
          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); if (!e.nativeEvent.isComposing) go(typed); } }}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          className="ui-field min-w-0 flex-1 bg-transparent px-1 font-mono text-xs text-zinc-300 outline-none"
          spellCheck={false}
        />
        {loading && <Spinner className="h-3 w-3 text-zinc-500" />}
      </div>

      {/* breadcrumbs + shortcuts */}
      <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 border-b border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-xs">
        {crumbs.map((c, i) => (
          <span key={c.path} className="flex items-center gap-1">
            {i > 0 && <span className="text-zinc-600">/</span>}
            <button type="button" onClick={() => go(c.path)} className={`hover:underline ${i === crumbs.length - 1 ? "text-zinc-100" : "text-zinc-400"}`}>
              {c.label}
            </button>
          </span>
        ))}
        <span className="ml-auto flex items-center gap-2 text-zinc-500">
          <button type="button" onClick={() => go("~")} className="hover:text-zinc-200">Inicio</button>
          <button type="button" onClick={() => go("~/code")} className="hover:text-zinc-200">~/code</button>
          <label className="flex cursor-pointer items-center gap-1 hover:text-zinc-200">
            <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} className="ui-field accent-indigo-500" /> ocultas
          </label>
        </span>
      </div>

      {/* filter */}
      {(listing?.entries.length ?? 0) > 8 && (
        <input
          onKeyDown={e => { if (e.key === "Enter") e.preventDefault(); }}
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setHighlighted(null);
          }}
          placeholder="Filtrar…"
          className="ui-field w-full border-b border-zinc-800 bg-zinc-950 px-3 py-1.5 text-sm outline-none placeholder:text-zinc-600"
        />
      )}

      {/* list */}
      <ul className="h-64 overflow-y-auto bg-zinc-950 py-1">
        {error && <li className="ui-alert m-2">{error}</li>}
        {!error && listing && entries.length === 0 && <li className="px-3 py-2 text-sm text-zinc-500">Sin subcarpetas.</li>}
        {entries.map((e) => (
          <li
            key={e.path}
            className={`folder-row group flex items-center gap-2 px-3 py-1 ${
              highlighted?.path === e.path ? "bg-indigo-500/25 ring-1 ring-inset ring-indigo-500/50" : selected === e.path ? "bg-indigo-500/10 hover:bg-zinc-800/70" : "hover:bg-zinc-800/70"
            }`}
          >
            <button
              type="button"
              aria-pressed={highlighted?.path === e.path}
              onClick={() => setHighlighted(e)}
              onDoubleClick={() => go(e.path)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter") {
                  ev.preventDefault();
                  ev.stopPropagation();
                  if (!ev.nativeEvent.isComposing) go(e.path);
                }
              }}
              className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm outline-none"
            >
              <FolderIcon repo={e.isRepo} />
              <span className={`truncate ${e.isRepo ? "text-zinc-100" : "text-zinc-400"}`}>{e.name}</span>
              {e.isRepo && <span className="rounded bg-emerald-500/15 px-1.5 py-px text-[10px] font-medium text-success">git</span>}
            </button>
            {e.isRepo && (
              <button type="button" onClick={() => onPick(e.path, true)} className="ui-reveal rounded px-2 py-0.5 text-xs text-accent opacity-0 group-hover:opacity-100 hover:bg-indigo-500/10">
                Elegir
              </button>
            )}
          </li>
        ))}
      </ul>

      {/* footer: choose current */}
      {listing && current && (
        <div className="flex items-center gap-2 border-t border-zinc-800 bg-zinc-900 px-3 py-2">
          <div className="min-w-0 flex-1 text-xs">
            {highlighted && <span className="mr-1.5 font-medium text-zinc-200">{highlighted.name}:</span>}
            {current.isRepo ? (
              <span className="text-success">Repo git{current.branch ? ` · ${current.branch}` : ""}</span>
            ) : (
              <span className="text-zinc-500">No es un repo git</span>
            )}
          </div>
          {listing.nativePicker && (
            <Button type="button" variant="ghost" onClick={native} className="!px-2 !py-1 text-xs">
              Finder…
            </Button>
          )}
          <Button type="button" variant={current.isRepo ? "primary" : "default"} onClick={() => onPick(current.path, current.isRepo)} className="!py-1 text-xs">
            Usar esta carpeta
          </Button>
        </div>
      )}
    </div>
  );
}

function breadcrumbs(path: string, home: string) {
  const out: { label: string; path: string }[] = [];
  path = path.replace(/\\/g, "/");
  home = home.replace(/\\/g, "/");
  let rest = path;
  if (path === home || path.startsWith(home + "/")) {
    out.push({ label: "~", path: home });
    rest = path.slice(home.length);
  } else {
    const drive = path.match(/^[A-Za-z]:/);
    out.push({ label: drive ? drive[0] : "/", path: drive ? drive[0] + "/" : "/" });
    if (drive) rest = path.slice(3);
  }
  let acc = out[0].path.replace(/\/$/, "");
  for (const part of rest.split("/").filter(Boolean)) {
    acc += "/" + part;
    out.push({ label: part, path: acc });
  }
  return out;
}

function FolderIcon({ repo }: { repo: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" className="shrink-0" fill={repo ? "#34d399" : "#52525b"} fillOpacity={repo ? 0.85 : 0.9}>
      <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.38a1.5 1.5 0 0 1 1.06.44L11.5 7h8A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" />
    </svg>
  );
}
