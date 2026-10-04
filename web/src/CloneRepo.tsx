import { useEffect, useState } from "react";
import { Lock, RefreshCw } from "lucide-react";
import type { GitHubRepos, Project } from "../../shared/types";
import { api } from "./api";
import { Button, Spinner, timeAgo } from "./ui";

/** Folder name for a clone URL: last path segment without ".git" (same as the server). */
const dirName = (url: string) =>
  url
    .trim()
    .replace(/[/\\]+$/, "")
    .replace(/\.git$/, "")
    .split(/[/:\\]/)
    .pop() || "";

const input = "mt-1 w-full rounded-md bg-zinc-900 px-3 py-2 text-sm text-zinc-100 ring-1 ring-zinc-700 outline-none placeholder:text-zinc-600 focus:ring-indigo-500";

/**
 * "Nuevo proyecto → Clonar de GitHub": your repos through the `gh` CLI (if it's logged in),
 * or any URL pasted by hand. Clones into ~/code/<name> unless you pick another folder.
 */
export function CloneRepo({ onCreated, footer }: { onCreated: (p: Project) => void; footer: (submit: React.ReactNode) => React.ReactNode }) {
  const [gh, setGh] = useState<GitHubRepos | null>(null);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [query, setQuery] = useState("");
  const [url, setUrl] = useState("");
  const [dest, setDest] = useState("");
  const [name, setName] = useState("");
  const [cloning, setCloning] = useState(false);
  const [error, setError] = useState("");

  const loadRepos = async () => {
    setLoadingRepos(true);
    try {
      setGh(await api<GitHubRepos>("/api/github/repos"));
    } catch (e) {
      setGh({ available: true, loggedIn: true, repos: [], error: (e as Error).message });
    } finally {
      setLoadingRepos(false);
    }
  };
  useEffect(() => {
    loadRepos();
  }, []);

  const folder = dirName(url);
  const defaultDest = folder ? `~/code/${folder}` : "~/code/<nombre>";
  const q = query.trim().toLowerCase();
  const repos = (gh?.repos ?? []).filter((r) => !q || r.name.toLowerCase().includes(q) || (r.description ?? "").toLowerCase().includes(q));

  const clone = async (target = url) => {
    if (!target.trim() || cloning) return;
    setError("");
    setCloning(true);
    try {
      onCreated(await api<Project>("/api/projects/clone", { url: target.trim(), dest: dest.trim() || undefined, name: name.trim() || undefined }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCloning(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        clone();
      }}
      className="space-y-4"
    >
      <div className="overflow-hidden rounded-lg ring-1 ring-zinc-700">
        <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-950 px-3 py-1.5">
          <input
            aria-label="Buscar repos"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}
            disabled={!gh?.loggedIn}
            placeholder={gh?.loggedIn ? `Buscar en tus ${gh.repos.length} repos…` : "Tus repos de GitHub"}
            className="min-w-0 flex-1 bg-transparent py-0.5 text-sm outline-none placeholder:text-zinc-600 disabled:opacity-60"
          />
          <button type="button" onClick={loadRepos} title="Volver a cargar" className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">
            {loadingRepos ? <Spinner className="h-3.5 w-3.5" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </button>
        </div>
        <ul className="h-64 overflow-y-auto bg-zinc-950 py-1">
          {!gh && <li className="flex items-center gap-2 px-3 py-2 text-sm text-zinc-500"><Spinner /> Buscando tus repos…</li>}
          {gh && !gh.available && (
            <GhHelp>
              No encuentro <code>gh</code>, el programa de GitHub para la terminal. Instálalo desde{" "}
              <a href="https://cli.github.com" target="_blank" rel="noreferrer" className="text-indigo-300 hover:underline">cli.github.com</a>, ejecuta{" "}
              <code>gh auth login</code> y pulsa ↻ para ver aquí tus repos.
            </GhHelp>
          )}
          {gh?.available && !gh.loggedIn && (
            <GhHelp>
              Tienes <code>gh</code> pero no has iniciado sesión. Ejecuta <code>gh auth login</code> en una terminal y pulsa ↻ para ver aquí tus repos.
            </GhHelp>
          )}
          {gh?.error && <li className="px-3 py-2 text-sm text-red-300">{gh.error}</li>}
          {gh?.loggedIn && !gh.error && repos.length === 0 && <li className="px-3 py-2 text-sm text-zinc-500">{q ? "Ningún repo coincide." : "No tienes repos."}</li>}
          {gh?.loggedIn &&
            repos.map((r) => (
              <li key={r.name}>
                <button
                  type="button"
                  aria-pressed={url === r.clone_url}
                  onClick={() => {
                    setUrl(r.clone_url);
                    setError("");
                  }}
                  onDoubleClick={() => {
                    setUrl(r.clone_url);
                    clone(r.clone_url);
                  }}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${url === r.clone_url ? "bg-indigo-500/25 ring-1 ring-inset ring-indigo-500/50" : "hover:bg-zinc-800/70"}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-sm text-zinc-100">
                      <span className="truncate">{r.name}</span>
                      {r.private && <Lock className="h-3 w-3 shrink-0 text-zinc-500" aria-label="privado" />}
                    </span>
                    {r.description && <span className="block truncate text-xs text-zinc-500">{r.description}</span>}
                  </span>
                  {r.updated_at && <span className="shrink-0 text-[11px] text-zinc-600">{timeAgo(r.updated_at)}</span>}
                </button>
              </li>
            ))}
        </ul>
      </div>

      <div className="space-y-3 rounded-lg bg-zinc-950 p-3 ring-1 ring-zinc-800">
        <label className="block text-xs text-zinc-400">
          URL del repo
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://github.com/usuario/repo.git · git@github.com:usuario/repo.git · usuario/repo"
            spellCheck={false}
            className={`${input} font-mono`}
          />
        </label>
        <div className="flex gap-3">
          <label className="block flex-1 text-xs text-zinc-400">
            Carpeta de destino
            <input value={dest} onChange={(e) => setDest(e.target.value)} placeholder={defaultDest} spellCheck={false} className={`${input} font-mono`} />
          </label>
          <label className="block w-40 text-xs text-zinc-400">
            Nombre
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={folder || "el del repo"} className={input} />
          </label>
        </div>
        {cloning && (
          <p className="flex items-center gap-2 text-xs text-zinc-400">
            <Spinner /> Clonando… puede tardar un poco si el repo es grande.
          </p>
        )}
      </div>

      {error && <p className="text-sm text-red-300">{error}</p>}
      {footer(
        <Button variant="primary" type="submit" disabled={!url.trim() || cloning}>
          {cloning ? <Spinner /> : null}
          {cloning ? "Clonando…" : "Clonar y crear proyecto"}
        </Button>,
      )}
    </form>
  );
}

function GhHelp({ children }: { children: React.ReactNode }) {
  return (
    <li className="px-3 py-2 text-sm leading-relaxed text-zinc-400 [&_code]:rounded [&_code]:bg-zinc-800 [&_code]:px-1 [&_code]:font-mono [&_code]:text-xs [&_code]:text-zinc-200">
      {children}
      <span className="mt-2 block text-zinc-500">Mientras tanto, puedes pegar la URL del repo abajo.</span>
    </li>
  );
}
