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
 * Git repos are highlighted; plain folders can be chosen too (the caller decides).
 */
export function FolderPicker({ onPick, selected }: { onPick: (path: string, isRepo: boolean) => void; selected?: string }) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [hidden, setHidden] = useState(false);
  const [typed, setTyped] = useState("");

  const go = async (path: string): Promise<boolean> => {
    setLoading(true);
    setError("");
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
    let start = "~/code";
    try {
      start = localStorage.getItem(LAST_DIR) ?? start;
    } catch {
      /* ignore */
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

  return (
    <div className="overflow-hidden rounded-lg ring-1 ring-zinc-700">
      {/* path bar */}
      <form
        className="flex items-center gap-1 border-b border-zinc-800 bg-zinc-950 px-2 py-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          go(typed);
        }}
      >
        <button type="button" disabled={!listing?.parent} onClick={() => listing?.parent && go(listing.parent)} className="rounded px-1.5 py-0.5 text-zinc-400 hover:bg-zinc-800 disabled:opacity-30" title="Subir">
          ↑
        </button>
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          className="min-w-0 flex-1 bg-transparent px-1 font-mono text-xs text-zinc-300 outline-none"
          spellCheck={false}
        />
        {loading && <Spinner className="h-3 w-3 text-zinc-500" />}
      </form>

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
            <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} className="accent-indigo-500" /> ocultas
          </label>
        </span>
      </div>

      {/* filter */}
      {(listing?.entries.length ?? 0) > 8 && (
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filtrar…"
          className="w-full border-b border-zinc-800 bg-zinc-950 px-3 py-1.5 text-sm outline-none placeholder:text-zinc-600"
        />
      )}

      {/* list */}
      <ul className="h-64 overflow-y-auto bg-zinc-950 py-1">
        {error && <li className="px-3 py-2 text-sm text-red-300">{error}</li>}
        {!error && listing && entries.length === 0 && <li className="px-3 py-2 text-sm text-zinc-500">Sin subcarpetas.</li>}
        {entries.map((e) => (
          <li key={e.path} className={`group flex items-center gap-2 px-3 py-1 hover:bg-zinc-800/70 ${selected === e.path ? "bg-indigo-500/10" : ""}`}>
            <button type="button" onClick={() => go(e.path)} onDoubleClick={() => e.isRepo && onPick(e.path, true)} className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm">
              <FolderIcon repo={e.isRepo} />
              <span className={`truncate ${e.isRepo ? "text-zinc-100" : "text-zinc-400"}`}>{e.name}</span>
              {e.isRepo && <span className="rounded bg-emerald-500/15 px-1.5 py-px text-[10px] font-medium text-emerald-300">git</span>}
            </button>
            {e.isRepo && (
              <button type="button" onClick={() => onPick(e.path, true)} className="rounded px-2 py-0.5 text-xs text-indigo-400 opacity-0 group-hover:opacity-100 hover:bg-indigo-500/10">
                Elegir
              </button>
            )}
          </li>
        ))}
      </ul>

      {/* footer: choose current */}
      {listing && (
        <div className="flex items-center gap-2 border-t border-zinc-800 bg-zinc-900 px-3 py-2">
          <div className="min-w-0 flex-1 text-xs">
            {listing.isRepo ? (
              <span className="text-emerald-300">Repo git{listing.branch ? ` · ${listing.branch}` : ""}</span>
            ) : (
              <span className="text-zinc-500">No es un repo git</span>
            )}
          </div>
          {listing.nativePicker && (
            <Button type="button" variant="ghost" onClick={native} className="!px-2 !py-1 text-xs">
              Finder…
            </Button>
          )}
          <Button type="button" variant={listing.isRepo ? "primary" : "default"} onClick={() => onPick(listing.path, listing.isRepo)} className="!py-1 text-xs">
            Usar esta carpeta
          </Button>
        </div>
      )}
    </div>
  );
}

function breadcrumbs(path: string, home: string) {
  const out: { label: string; path: string }[] = [];
  let rest = path;
  if (path === home || path.startsWith(home + "/")) {
    out.push({ label: "~", path: home });
    rest = path.slice(home.length);
  } else {
    out.push({ label: "/", path: "/" });
  }
  let acc = out[0].path === "/" ? "" : home;
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
