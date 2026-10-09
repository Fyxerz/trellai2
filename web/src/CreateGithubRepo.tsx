import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CloudUpload, ExternalLink, Lock, Globe } from "lucide-react";
import type { GitHubStatus, Project } from "../../shared/types";
import { api } from "./api";
import { GitHubConnect } from "./GitHubConnect";
import { Button, Spinner } from "./ui";

const input = "ui-field ui-control mt-1 w-full rounded-md bg-zinc-900 px-3 py-2 text-sm text-zinc-100 ring-1 ring-zinc-700 outline-none placeholder:text-zinc-600 focus:ring-indigo-500";

/** Last segment of the repo folder: the proposed GitHub name. */
const folderName = (path: string) => path.replace(/[/\\]+$/, "").split(/[/\\]/).pop()?.replace(/[^\w.-]+/g, "-") || "";

/**
 * "Crear repo en GitHub" for a project whose local repo has no remote: creates it with `gh`
 * in your account (or `org/nombre`), adds it as origin and pushes the base branch.
 */
export function CreateGithubRepo({ project, onClose, onCreated }: { project: Project; onClose: () => void; onCreated: () => void }) {
  const [gh, setGh] = useState<GitHubStatus | null>(null);
  const [name, setName] = useState(() => folderName(project.repo_path ?? project.name));
  const [description, setDescription] = useState("");
  const [isPrivate, setIsPrivate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [done, setDone] = useState<{ url: string; pushError?: string } | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const check = () => {
    setGh(null);
    api<GitHubStatus>("/api/github/status")
      .then(setGh)
      .catch(() => setGh({ available: true, loggedIn: true, login: null }));
  };
  useEffect(check, []);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || busy) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", esc, true);
    return () => window.removeEventListener("keydown", esc, true);
  }, [busy, onClose]);

  const create = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/projects/${project.id}/github`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), description: description.trim() || undefined, private: isPrivate }),
      });
      const data = await r.json().catch(() => ({ error: `Error ${r.status}` }));
      if (!r.ok) {
        setError({ message: data.error ?? `Error ${r.status}`, code: data.code });
        if (data.code === "exists" || data.code === "invalid") setTimeout(() => nameRef.current?.select(), 0);
        if (data.code === "missing" || data.code === "auth") check();
        return;
      }
      setDone({ url: data.url, pushError: data.pushError });
      onCreated();
    } catch (e) {
      setError({ message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const ready = gh?.available && gh.loggedIn;

  return createPortal(
    <div data-modal className="ui-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[2px]" onClick={() => !busy && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="gh-create-title"
        onClick={(e) => e.stopPropagation()}
        className="ui-dialog w-full max-w-md rounded-2xl bg-zinc-900 p-5 shadow-[var(--shadow-pop)] ring-1 ring-ui-ink/[0.08]"
      >
        <h2 id="gh-create-title" className="flex items-center gap-2 text-[15px] font-semibold text-zinc-50">
          <CloudUpload className="h-4 w-4" /> Crear repo en GitHub
        </h2>
        <p className="mt-1 text-[13px] text-zinc-400">
          Se crea el repo, se enlaza como <span className="font-mono">origin</span> y se sube la rama <span className="font-mono">{project.base_branch}</span>.
        </p>

        {done ? (
          <div className="mt-4 space-y-3">
            <p className="text-sm text-zinc-200">¡Listo! El proyecto ya está enlazado con GitHub.</p>
            <a href={done.url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 font-mono text-sm text-indigo-400 hover:underline">
              {done.url.replace(/^https:\/\//, "")} <ExternalLink className="h-3.5 w-3.5" />
            </a>
            {done.pushError && <p className="text-xs text-warning">El repo se creó, pero no pude subir la rama: {done.pushError}</p>}
            <div className="flex justify-end">
              <Button variant="primary" onClick={onClose}>
                Cerrar
              </Button>
            </div>
          </div>
        ) : !gh ? (
          <div className="mt-4 flex items-center gap-2 text-sm text-zinc-400">
            <Spinner /> Comprobando GitHub CLI…
          </div>
        ) : !ready ? (
          <div className="mt-4 space-y-3 text-sm text-zinc-300">
            {!gh.available ? (
              <p>
                Necesito el comando <span className="font-mono">gh</span> (GitHub CLI). Instálalo desde{" "}
                <a href="https://cli.github.com" target="_blank" rel="noreferrer" className="text-indigo-400 hover:underline">
                  cli.github.com
                </a>{" "}
                y vuelve a comprobar para conectar tu cuenta.
              </p>
            ) : (
              <>
                <p>Conecta tu cuenta de GitHub para crear el repo:</p>
                <GitHubConnect onConnected={check} />
              </>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                Cancelar
              </Button>
              <Button onClick={check}>Volver a comprobar</Button>
            </div>
          </div>
        ) : (
          <form
            className="mt-4 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              create();
            }}
          >
            <label className="block text-xs text-zinc-400">
              Nombre {gh.login && <span className="text-zinc-500">· en tu cuenta {gh.login} (o escribe org/nombre)</span>}
              <input ref={nameRef} autoFocus className={input} value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
            </label>
            <label className="block text-xs text-zinc-400">
              Descripción <span className="text-zinc-500">(opcional)</span>
              <input className={input} value={description} onChange={(e) => setDescription(e.target.value)} />
            </label>
            <div className="flex gap-2">
              {[
                { v: true, label: "Privado", icon: Lock },
                { v: false, label: "Público", icon: Globe },
              ].map(({ v, label, icon: Icon }) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => setIsPrivate(v)}
                  aria-pressed={isPrivate === v}
                  className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm ring-1 transition ${
                    isPrivate === v ? "bg-indigo-500/15 text-zinc-100 ring-indigo-500" : "text-zinc-400 ring-zinc-700 hover:text-zinc-200"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" /> {label}
                </button>
              ))}
            </div>
            {error && <p className="text-xs whitespace-pre-line text-danger">{error.message}</p>}
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
                Cancelar
              </Button>
              <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
                {busy ? <Spinner /> : <CloudUpload className="h-3.5 w-3.5" />} {busy ? "Creando…" : "Crear y subir"}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>,
    document.body,
  );
}
