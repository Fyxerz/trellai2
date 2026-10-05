/**
 * Who uses Trellai: your name and avatar, other people's on cards / activity / channel,
 * and sharing a project with someone through an invitation code.
 */
import { Check, Copy, FolderGit2, Link2, LogIn, Share2, TriangleAlert, UserMinus, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AVATAR_COLORS, type Person, type Project, type Sharing } from "../../shared/types";
import { api, useSync } from "./api";
import { confirmDialog, notice } from "./Confirm";
import { useDialogFocus } from "./preferences";
import { Button, Spinner, timeAgo } from "./ui";

interface PeopleState {
  me: string | null;
  machine: string;
  people: Person[];
}

let cache: PeopleState | null = null;
const subs = new Set<(s: PeopleState) => void>();
let timer: ReturnType<typeof setInterval> | null = null;

/** Reload everyone (after changing your profile, joining a project…). */
export const reloadPeople = () =>
  api<PeopleState>("/api/people")
    .then((s) => {
      cache = s;
      subs.forEach((fn) => fn(s));
      return s;
    })
    .catch(() => cache);

export function usePeople() {
  const [s, setS] = useState(cache);
  useEffect(() => {
    subs.add(setS);
    if (!timer) {
      reloadPeople();
      timer = setInterval(reloadPeople, 15_000);
    }
    return () => void subs.delete(setS);
  }, []);
  const byId = Object.fromEntries((s?.people ?? []).map((p) => [p.id, p]));
  return { loaded: !!s, meId: s?.me ?? null, me: s?.me ? (byId[s.me] ?? null) : null, people: s?.people ?? [], byId, machine: s?.machine ?? "" };
}

const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("") || "?";

/** Round avatar with initials. `id` = Person.id (nothing is shown for unknown/old authors). */
export function Avatar({ id, person, size = 18, title, className = "" }: { id?: string | null; person?: Person | null; size?: number; title?: string; className?: string }) {
  const { byId } = usePeople();
  const p = person ?? (id ? byId[id] : undefined);
  if (!p) return null;
  return (
    <span
      title={title ?? p.name}
      aria-label={title ?? p.name}
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-zinc-950 select-none ${className}`}
      style={{ width: size, height: size, background: p.color, fontSize: Math.max(8, Math.round(size * 0.42)), lineHeight: 1 }}
    >
      {initials(p.name)}
    </span>
  );
}

/** Avatar + name, e.g. in activity and the channel. */
export function Byline({ id, className = "" }: { id: string | null; className?: string }) {
  const { byId } = usePeople();
  const p = id ? byId[id] : undefined;
  if (!p) return null;
  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      <Avatar person={p} size={14} />
      <span className="font-medium text-zinc-300">{p.name}</span>
    </span>
  );
}

const MODAL_BACKDROP = "ui-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[2px]";
const MODAL = "ui-dialog w-full max-w-md rounded-2xl bg-zinc-900 p-5 ring-1 ring-ui-ink/[0.08] shadow-[var(--shadow-pop)]";
const FIELD = "ui-field ui-control w-full rounded-lg bg-zinc-950 px-3 py-2 text-sm text-zinc-100 ring-1 ring-zinc-700 outline-none focus:ring-indigo-500";

/** Your avatar in the header. Asks your name the first time Trellai opens. */
export function ProfileChip() {
  const { loaded, me, machine } = usePeople();
  const [open, setOpen] = useState(false);
  const [later, setLater] = useState(false);
  const ask = loaded && !me && !later;
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title={me ? `Eres ${me.name} en ${machine}. Clic para cambiar tu nombre o color.` : "Pon tu nombre para que se vea quién hace cada cosa"}
        className="flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-[12px] text-zinc-300 transition hover:bg-ui-ink/[0.06]"
      >
        {me ? <Avatar person={me} size={22} /> : <Users className="h-4 w-4 text-zinc-500" />}
        <span className="hidden max-w-[8rem] truncate md:inline">{me ? me.name : "¿Quién eres?"}</span>
      </button>
      {(open || ask) && (
        <ProfileDialog
          first={!me}
          onClose={() => {
            setOpen(false);
            setLater(true);
          }}
        />
      )}
    </>
  );
}

function ProfileDialog({ first, onClose }: { first: boolean; onClose: () => void }) {
  const { me, people, meId } = usePeople();
  const [name, setName] = useState(me?.name ?? "");
  const [color, setColor] = useState(me?.color ?? AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useDialogFocus();
  // People that came from your other computers: "I'm already this person".
  const others = first ? people.filter((p) => p.id !== meId) : [];

  const save = async (body: { name?: string; color?: string; adopt?: string }) => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/me", body);
      await reloadPeople();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-modal className={MODAL_BACKDROP} onClick={onClose}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label="Tu perfil" onClick={(e) => e.stopPropagation()} className={MODAL}>
        <h2 className="text-base font-semibold text-zinc-100">{first ? "¿Quién eres?" : "Tu perfil"}</h2>
        <p className="mt-1 text-[12.5px] text-zinc-400">
          Tu nombre y tu color se ven en las tarjetas que creas, en tus mensajes y en el canal. Así, en los proyectos compartidos, se sabe quién hizo cada cosa.
        </p>
        {others.length > 0 && (
          <div className="mt-4">
            <div className="mb-1.5 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">Ya eres alguien en otro ordenador</div>
            <div className="flex flex-wrap gap-1.5">
              {others.map((p) => (
                <button
                  key={p.id}
                  disabled={busy}
                  onClick={() => save({ adopt: p.id })}
                  className="flex items-center gap-1.5 rounded-full bg-ui-ink/[0.05] py-1 pr-2.5 pl-1 text-[12.5px] text-zinc-200 ring-1 ring-ui-ink/[0.08] hover:bg-ui-ink/[0.1]"
                >
                  <Avatar person={p} size={20} /> Soy {p.name}
                </button>
              ))}
            </div>
          </div>
        )}
        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            save({ name, color });
          }}
        >
          <label className="block">
            <span className="mb-1 block text-[12px] text-zinc-400">Nombre</span>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="Tu nombre" className={FIELD} />
          </label>
          <div>
            <span className="mb-1 block text-[12px] text-zinc-400">Color</span>
            <div className="flex flex-wrap items-center gap-1.5">
              {AVATAR_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Color ${c}`}
                  aria-pressed={color === c}
                  onClick={() => setColor(c)}
                  className={`h-6 w-6 rounded-full transition ${color === c ? "ring-2 ring-zinc-100 ring-offset-2 ring-offset-zinc-900" : "hover:scale-110"}`}
                  style={{ background: c }}
                />
              ))}
              <span className="ml-2">
                <Avatar person={{ id: "", name: name || "?", color, machines: [], updated_at: "" }} size={28} title="Así te verán" />
              </span>
            </div>
          </div>
          {error && <div className="text-[12px] text-danger">{error}</div>}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={onClose}>
              {first ? "Más tarde" : "Cancelar"}
            </Button>
            <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
              {busy && <Spinner className="h-3.5 w-3.5" />}
              Guardar
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** "Unirse con código": paste an invitation and the shared project shows up. */
export function JoinDialog({ initialCode = "", onClose, onJoined }: { initialCode?: string; onClose: () => void; onJoined: (p: Project) => void }) {
  const { me, loaded } = usePeople();
  const [code, setCode] = useState(initialCode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useDialogFocus();
  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      const p = await api<Project>("/api/shares", { code });
      await reloadPeople();
      onJoined(p);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // Opened from an invitation link: join right away (once we know who you are).
  const auto = useRef(!!initialCode);
  useEffect(() => {
    if (auto.current && loaded && me) {
      auto.current = false;
      join();
    }
  }, [loaded, me]);
  return (
    <div data-modal className={MODAL_BACKDROP} onClick={onClose}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label="Unirse a un proyecto" onClick={(e) => e.stopPropagation()} className={MODAL}>
        <h2 className="flex items-center gap-2 text-base font-semibold text-zinc-100">
          <LogIn className="h-4 w-4" /> Unirse con un código
        </h2>
        <p className="mt-1 text-[12.5px] text-zinc-400">
          Pega el código que te pasaron. Verás su tablero y su canal de agentes; si ya tienes clonado el mismo repo de GitHub se enlaza solo, y si no, podrás clonarlo
          desde el aviso del tablero.
        </p>
        {!me && <div className="mt-3 rounded-lg bg-amber-400/10 px-3 py-2 text-[12px] text-warning">Pon antes tu nombre (arriba a la derecha) para que sepan quién eres.</div>}
        <textarea
          autoFocus
          rows={3}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="trellai1.…"
          aria-label="Código de invitación"
          className={`${FIELD} mt-3 resize-none font-mono text-[12px] break-all`}
        />
        {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" disabled={busy || !code.trim() || !me} onClick={join}>
            {busy && <Spinner className="h-3.5 w-3.5" />}
            Unirme
          </Button>
        </div>
      </div>
    </div>
  );
}

/** The link that opens someone's Trellai on the invitation (their Trellai usually runs on the same port as yours). */
export const inviteLink = (code: string) => `${location.origin}/?join=${encodeURIComponent(code)}`;

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          notice("No pude copiarlo", "Selecciónalo y cópialo a mano.");
        }
      }}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? "Copiado" : label}
    </Button>
  );
}

/** Project settings → "Compartir": who shares it, sharing with whoever has the repo, the invitation link. */
export function SharingSettings({ project }: { project: Project }) {
  const { byId, meId } = usePeople();
  const sync = useSync();
  const [data, setData] = useState<Sharing | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [dbUrl, setDbUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [autoBusy, setAutoBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api<Sharing>(`/api/projects/${project.id}/sharing`)
      .then((s) => {
        setData(s);
        reloadPeople();
      })
      .catch((e) => setError((e as Error).message));
  useEffect(() => {
    setCode(null);
    setCodeError(null);
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [project.id]);
  // The link is ready as soon as you open this: nothing to press.
  const canInvite = !!data && !data.problem && (data.ownDb || !!data.share);
  useEffect(() => {
    if (!canInvite || code) return;
    api<{ code: string }>(`/api/projects/${project.id}/invite`)
      .then((r) => setCode(r.code))
      .catch((e) => setCodeError((e as Error).message));
  }, [canInvite, project.id]);

  const members = (data?.members ?? []).filter((m) => !m.left_at);
  const shared = members.some((m) => m.person_id !== meId);
  const shareStatus = sync?.shares?.find((s) => s.project_id === project.id);

  /** No database of your own: the invitation needs one. */
  const inviteWithDb = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ code: string }>(`/api/projects/${project.id}/invite`, { db: dbUrl });
      setCode(r.code);
      setCodeError(null);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const setAuto = async (on: boolean) => {
    setAutoBusy(true);
    try {
      await api(`/api/projects/${project.id}/autoshare`, { on });
      await load();
    } catch (e) {
      notice("No se pudo", (e as Error).message);
    } finally {
      setAutoBusy(false);
    }
  };
  const remove = async (personId: string) => {
    const self = personId === meId;
    const name = byId[personId]?.name ?? "esta persona";
    const ok = await confirmDialog({
      title: self ? "¿Salir de este proyecto compartido?" : `¿Quitar a ${name}?`,
      body: self
        ? "Este ordenador deja de sincronizarlo (y no vuelve a unirse solo). El tablero se queda aquí tal como está ahora."
        : `Su Trellai deja de sincronizar este proyecto. Ojo: la invitación sigue dando acceso a la base de datos; si quieres cortarlo del todo, cambia su contraseña.`,
      confirmLabel: self ? "Salir" : "Quitar",
      danger: true,
    });
    if (!ok) return;
    await api(`/api/projects/${project.id}/members/${personId}/remove`, {}).catch((e) => notice("No se pudo", (e as Error).message));
    load();
  };
  const unshare = async () => {
    const ok = await confirmDialog({
      title: "¿Dejar de compartir este proyecto?",
      body: "Todos dejan de sincronizarlo, se quita la invitación del repo y deja de compartirse solo. Cada uno se queda con el tablero tal como está ahora.",
      confirmLabel: "Dejar de compartir",
      danger: true,
    });
    if (!ok) return;
    await api(`/api/projects/${project.id}/unshare`, {}).catch((e) => notice("No se pudo", (e as Error).message));
    setCode(null);
    load();
  };

  return (
    <div className="space-y-5">
      <section>
        <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
          <Users className="h-4 w-4" /> Quién lo comparte
        </h3>
        {!data ? (error ? null : (
          <div className="mt-2 flex items-center gap-2 text-[12px] text-zinc-500">
            <Spinner className="h-3.5 w-3.5" /> Cargando…
          </div>
        )
        ) : !shared ? (
          <p className="mt-1 text-[12.5px] text-zinc-500">Solo tú, de momento.</p>
        ) : (
          <ul className="mt-2 space-y-1">
            {members.map((m) => {
              const p = byId[m.person_id];
              return (
                <li key={m.id} className="flex items-center gap-2.5 rounded-lg bg-ui-ink/[0.03] px-2.5 py-1.5">
                  <Avatar person={p} size={24} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] text-zinc-100">
                      {p?.name ?? "Alguien"} {m.person_id === meId && <span className="text-zinc-500">(tú)</span>}
                    </div>
                    <div className="truncate text-[11px] text-zinc-500">
                      desde hace {timeAgo(m.joined_at)}
                      {p?.machines.length ? ` · ${p.machines.join(", ")}` : ""}
                    </div>
                  </div>
                  {/* you can only leave a project you reach through an invitation; your own database always has it */}
                  {(m.person_id !== meId || data.share) && (
                    <Button size="sm" variant="ghost" onClick={() => remove(m.person_id)} title={m.person_id === meId ? "Salir del proyecto compartido" : "Quitar del proyecto"}>
                      <UserMinus className="h-3.5 w-3.5" /> {m.person_id === meId ? "Salir" : "Quitar"}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {data?.share && (
          <p className="mt-2 text-[11.5px] text-zinc-500">
            Se sincroniza a través de <span className="font-mono text-zinc-400">{data.share.host}</span>
            {shareStatus && !shareStatus.ok && shareStatus.error ? <span className="text-danger"> · sin conexión: {shareStatus.error}</span> : null}
          </p>
        )}
      </section>

      {data && !data.problem && (
        <section>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
            <FolderGit2 className="h-4 w-4" /> Con quien tenga el repo
          </h3>
          <label className="mt-1.5 flex items-start gap-2 text-[12.5px] text-zinc-300">
            <input type="checkbox" className="mt-0.5" checked={data.auto?.enabled ?? false} disabled={autoBusy} onChange={(e) => setAuto(e.target.checked)} />
            <span>
              Compartir el tablero automáticamente con quien abra este repo de GitHub en su Trellai
              <span className="block text-[11.5px] text-zinc-500">
                {autoBusy ? (
                  "Comprobando…"
                ) : data.auto?.on ? (
                  <span className="text-success">✓ Activo: quien tenga acceso al repo y lo añada a su Trellai verá este tablero sin hacer nada más.</span>
                ) : (
                  data.auto?.reason
                )}
              </span>
            </span>
          </label>
        </section>
      )}

      <section>
        <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
          <Link2 className="h-4 w-4" /> Enlace de invitación
        </h3>
        {data?.problem ? (
          <div className="mt-2 rounded-lg bg-amber-400/10 px-3 py-2 text-[12px] text-warning">{data.problem}</div>
        ) : !data ? null : code ? (
          <div className="mt-2 space-y-2">
            <p className="text-[12.5px] text-zinc-400">Pásaselo: si lo abre con su Trellai en marcha, se une sola. Si no, que pegue el código en «Unirse con código».</p>
            <div className="flex items-center gap-2">
              <input readOnly value={inviteLink(code)} aria-label="Enlace de invitación" onFocus={(e) => e.currentTarget.select()} className={`${FIELD} min-w-0 flex-1 font-mono text-[11.5px]`} />
              <CopyButton text={inviteLink(code)} label="Copiar enlace" />
              <CopyButton text={code} label="Copiar código" />
            </div>
            <div className="flex items-start gap-2 rounded-lg bg-red-400/[0.07] px-3 py-2 text-[11.5px] text-zinc-300">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" />
              <span>Lleva la URL de la base de datos con su contraseña: dáselo solo a quien quieras. Trellai solo le sincroniza este proyecto.</span>
            </div>
          </div>
        ) : canInvite ? (
          codeError ? (
            <div className="mt-2 text-[12px] text-danger">{codeError}</div>
          ) : (
            <div className="mt-2 flex items-center gap-2 text-[12px] text-zinc-500">
              <Spinner className="h-3.5 w-3.5" /> Preparando el enlace…
            </div>
          )
        ) : (
          <div className="mt-2 space-y-2">
            <p className="text-[12.5px] text-zinc-400">
              Para compartir hace falta una base de datos Postgres (Supabase) por la que se sincronice. Configura <span className="font-mono">TRELLAI_DATABASE_URL</span> (ver
              README) o pega aquí la URL de una:
            </p>
            <input
              value={dbUrl}
              onChange={(e) => setDbUrl(e.target.value)}
              placeholder="postgresql://postgres.xxx:contraseña@aws-0-eu-west-1.pooler.supabase.com:6543/postgres"
              aria-label="URL de la base de datos para compartir"
              className={`${FIELD} font-mono text-[12px]`}
            />
            <Button variant="primary" onClick={inviteWithDb} disabled={busy || !dbUrl.trim()}>
              {busy ? <Spinner className="h-3.5 w-3.5" /> : <Share2 className="h-3.5 w-3.5" />}
              Crear enlace
            </Button>
          </div>
        )}
        {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
      </section>

      {(shared || data?.share || data?.auto?.on) && (
        <section>
          <Button variant="danger" onClick={unshare}>
            Dejar de compartir
          </Button>
        </section>
      )}
    </div>
  );
}
