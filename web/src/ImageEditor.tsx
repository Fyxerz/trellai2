import { ImagePlus, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Annotation, Attachment, Card } from "../../shared/types";
import { api, type Board } from "./api";
import { confirmDialog } from "./Confirm";
import { reportError } from "./notifications";
import { Button, Spinner } from "./ui";

/** Longest side after resizing in the browser: keeps DB rows (and the sync) light. */
const MAX_SIDE = 1600;
const BOX = "#f43f5e";

const imageUrl = (a: Attachment, annotated = false) =>
  `/api/attachments/${a.id}/image${annotated ? `?annotated=1&t=${Date.now()}` : ""}`;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("No se pudo leer la imagen"));
    img.src = src;
  });
}

/** WebP if the browser can encode it, JPEG otherwise. */
function encode(canvas: HTMLCanvasElement): string {
  const webp = canvas.toDataURL("image/webp", 0.9);
  return webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/jpeg", 0.9);
}

/** Read a file, shrink it to MAX_SIDE and re-encode it. */
async function prepareImage(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return encode(canvas);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The image with the numbered boxes drawn on it, so the agent sees what is pointed at. */
async function drawAnnotated(src: string, regions: Annotation[]): Promise<string> {
  const img = await loadImage(src);
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  const line = Math.max(2, Math.round(Math.max(canvas.width, canvas.height) / 400));
  const font = Math.max(14, line * 7);
  regions.forEach((r, i) => {
    const x = r.x * canvas.width;
    const y = r.y * canvas.height;
    ctx.lineWidth = line;
    ctx.strokeStyle = BOX;
    ctx.fillStyle = "rgba(244, 63, 94, 0.08)";
    ctx.fillRect(x, y, r.w * canvas.width, r.h * canvas.height);
    ctx.strokeRect(x, y, r.w * canvas.width, r.h * canvas.height);
    const label = String(i + 1);
    ctx.font = `bold ${font}px sans-serif`;
    const pad = Math.round(font * 0.3);
    const w = ctx.measureText(label).width + pad * 2;
    const h = font + pad;
    const ly = y - h >= 0 ? y - h : y; // above the box when it fits
    ctx.fillStyle = BOX;
    ctx.fillRect(x - line / 2, ly, w, h);
    ctx.fillStyle = "#fff";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x - line / 2 + pad, ly + h / 2 + 1);
  });
  return encode(canvas);
}

const imageFiles = (list: FileList | null | undefined) => [...(list ?? [])].filter((f) => f.type.startsWith("image/"));

/** The card's images under the spec: upload (button, drop, Ctrl+V), thumbnails, and the region editor. */
export function SpecImages({ card, board }: { card: Card; board: Board }) {
  const [items, setItems] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    const load = () => api<Attachment[]>(`/api/cards/${card.id}/attachments`).then((a) => alive && setItems(a)).catch(() => {});
    load();
    const off = board.on((e) => {
      if ((e.type === "attachments" && e.cardId === card.id) || e.type === "sync") load();
    });
    return () => {
      alive = false;
      off();
    };
  }, [card.id]);

  const upload = async (files: File[]) => {
    if (!files.length) return;
    setUploading((n) => n + files.length);
    for (const file of files) {
      try {
        const data = await prepareImage(file);
        const name = file.name && file.name !== "image.png" ? file.name : `captura-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}`;
        const att = await api<Attachment>(`/api/cards/${card.id}/attachments`, { name, data });
        setItems((prev) => (prev.some((a) => a.id === att.id) ? prev : [...prev, att]));
      } catch (e) {
        reportError(`No se pudo subir ${file.name || "la imagen"}: ${(e as Error).message}`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };
  const latestUpload = useRef(upload);
  latestUpload.current = upload;

  // Ctrl+V anywhere while the Spec tab is open, and dropping files on the panel.
  useEffect(() => {
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
    const onPaste = (e: ClipboardEvent) => {
      if (document.querySelector("[data-modal]")) return;
      const files = imageFiles(e.clipboardData?.files);
      if (!files.length) return;
      e.preventDefault();
      void latestUpload.current(files);
    };
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragging(true);
    };
    const onLeave = (e: DragEvent) => {
      if (!e.relatedTarget) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      setDragging(false);
      if (!hasFiles(e)) return;
      e.preventDefault();
      void latestUpload.current(imageFiles(e.dataTransfer?.files));
    };
    document.addEventListener("paste", onPaste);
    document.addEventListener("dragover", onOver);
    document.addEventListener("dragleave", onLeave);
    document.addEventListener("drop", onDrop);
    return () => {
      document.removeEventListener("paste", onPaste);
      document.removeEventListener("dragover", onOver);
      document.removeEventListener("dragleave", onLeave);
      document.removeEventListener("drop", onDrop);
    };
  }, []);

  const remove = async (a: Attachment) => {
    if (!(await confirmDialog({ title: "¿Borrar la imagen?", body: a.name, confirmLabel: "Borrar", danger: true }))) return;
    setItems((prev) => prev.filter((x) => x.id !== a.id));
    await api(`/api/attachments/${a.id}`, undefined, "DELETE").catch((e) => reportError((e as Error).message));
  };

  const current = items.find((a) => a.id === editing);

  return (
    <section className="mt-4" aria-label="Imágenes">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-zinc-400 uppercase">Imágenes</h3>
        {uploading > 0 && <Spinner />}
        <button onClick={() => input.current?.click()} className="ml-auto flex items-center gap-1 text-xs text-accent hover:underline">
          <ImagePlus className="h-3.5 w-3.5" /> Añadir
        </button>
        <input
          ref={input}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            void upload(imageFiles(e.target.files));
            e.target.value = "";
          }}
        />
      </div>
      <div
        className={`flex flex-wrap gap-2 rounded-lg p-2 ring-1 transition ${
          dragging ? "bg-indigo-500/10 ring-indigo-400" : "ring-zinc-800"
        }`}
      >
        {items.map((a) => (
          <div key={a.id} className="group relative">
            <button
              onClick={() => setEditing(a.id)}
              title="Marcar zonas y comentar"
              className="block h-24 overflow-hidden rounded-md bg-zinc-900 ring-1 ring-zinc-800 hover:ring-indigo-400"
            >
              <img src={imageUrl(a)} alt={a.name} className="h-full w-auto max-w-[220px] object-cover" draggable={false} />
            </button>
            {a.annotations.length > 0 && (
              <span className="pointer-events-none absolute bottom-1 left-1 rounded bg-rose-500 px-1.5 text-[10px] font-semibold text-white">
                {a.annotations.length} {a.annotations.length === 1 ? "zona" : "zonas"}
              </span>
            )}
            <button
              onClick={() => void remove(a)}
              aria-label={`Borrar ${a.name}`}
              className="ui-reveal absolute top-1 right-1 rounded bg-zinc-900/95 p-1 text-zinc-300 opacity-0 transition group-hover:opacity-100 hover:text-danger focus:opacity-100"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        ))}
        <p className="self-center px-1 text-[11px] text-zinc-500">
          {items.length ? "Pulsa una imagen para marcar zonas y comentarlas." : "Arrastra, pega (Ctrl+V) o añade capturas para señalar qué parte cambiar."}
        </p>
      </div>
      {current && <ImageEditor attachment={current} onClose={() => setEditing(null)} onSaved={(a) => setItems((prev) => prev.map((x) => (x.id === a.id ? a : x)))} />}
    </section>
  );
}

type Draft = Annotation & { key: number };
let nextKey = 1;

/** Full-screen editor: drag on the image to draw a box, write a comment for each one. */
export function ImageEditor({ attachment, onClose, onSaved }: { attachment: Attachment; onClose: () => void; onSaved: (a: Attachment) => void }) {
  const [regions, setRegions] = useState<Draft[]>(() => attachment.annotations.map((a) => ({ ...a, key: nextKey++ })));
  const [selected, setSelected] = useState<number | null>(null);
  const [drawing, setDrawing] = useState<{ x0: number; y0: number; x: number; y: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const area = useRef<HTMLDivElement>(null);
  const dirty = useRef(false);

  const point = (e: React.PointerEvent) => {
    const r = area.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };

  const confirming = useRef(false);
  const close = async () => {
    if (confirming.current) return;
    confirming.current = true;
    const discard = !dirty.current || (await confirmDialog({ title: "¿Descartar los cambios?", body: "Hay zonas o comentarios sin guardar.", confirmLabel: "Descartar", danger: true }));
    confirming.current = false;
    if (discard) onClose();
  };
  const latestClose = useRef(close);
  latestClose.current = close;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !confirming.current) {
        e.preventDefault();
        void latestClose.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const update = (key: number, patch: Partial<Draft>) => {
    dirty.current = true;
    setRegions((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };
  const removeRegion = (key: number) => {
    dirty.current = true;
    setRegions((prev) => prev.filter((r) => r.key !== key));
    if (selected === key) setSelected(null);
  };

  const save = async () => {
    setSaving(true);
    try {
      const annotations = regions.map(({ key: _k, ...r }) => r);
      const annotated = annotations.length ? await drawAnnotated(imageUrl(attachment), annotations) : null;
      const a = await api<Attachment>(`/api/attachments/${attachment.id}`, { annotations, annotated }, "PATCH");
      dirty.current = false;
      onSaved(a);
      onClose();
    } catch (e) {
      reportError(`No se guardaron las zonas: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const box = drawing && {
    x: Math.min(drawing.x0, drawing.x),
    y: Math.min(drawing.y0, drawing.y),
    w: Math.abs(drawing.x - drawing.x0),
    h: Math.abs(drawing.y - drawing.y0),
  };
  const pctStyle = (r: { x: number; y: number; w: number; h: number }) => ({
    left: `${r.x * 100}%`,
    top: `${r.y * 100}%`,
    width: `${r.w * 100}%`,
    height: `${r.h * 100}%`,
  });

  return (
    <div data-modal className="image-editor fixed inset-0 z-50 flex bg-black/80 backdrop-blur-[2px]" role="dialog" aria-label={`Editar ${attachment.name}`}>
      <div className="image-editor-canvas flex min-w-0 flex-1 items-center justify-center p-6">
        <div
          ref={area}
          className="relative max-h-full max-w-full cursor-crosshair touch-none select-none"
          onPointerDown={(e) => {
            if (e.button !== 0 || (e.target as HTMLElement).closest("[data-region]")) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            const p = point(e);
            setSelected(null);
            setDrawing({ x0: p.x, y0: p.y, x: p.x, y: p.y });
          }}
          onPointerMove={(e) => {
            if (!drawing) return;
            const p = point(e);
            setDrawing({ ...drawing, x: p.x, y: p.y });
          }}
          onPointerUp={() => {
            if (!drawing || !box) return;
            setDrawing(null);
            if (box.w < 0.01 || box.h < 0.01) return; // a click, not a box
            const key = nextKey++;
            dirty.current = true;
            setRegions((prev) => [...prev, { ...box, comment: "", key }]);
            setSelected(key);
            setTimeout(() => document.querySelector<HTMLTextAreaElement>(`[data-comment="${key}"]`)?.focus(), 30);
          }}
        >
          <img src={imageUrl(attachment)} alt={attachment.name} draggable={false} className="block max-h-[calc(100vh-3rem)] max-w-full" />
          {regions.map((r, i) => (
            <div
              key={r.key}
              data-region
              onPointerDown={(e) => {
                e.stopPropagation();
                setSelected(r.key);
                document.querySelector<HTMLTextAreaElement>(`[data-comment="${r.key}"]`)?.focus();
              }}
              className={`absolute border-2 ${selected === r.key ? "border-amber-300 bg-amber-300/15" : "border-rose-500 bg-rose-500/10"}`}
              style={pctStyle(r)}
              title={r.comment}
            >
              <span
                className={`absolute -top-5 -left-0.5 rounded-t px-1.5 text-[11px] font-bold text-white ${selected === r.key ? "bg-amber-500" : "bg-rose-500"}`}
              >
                {i + 1}
              </span>
            </div>
          ))}
          {box && <div className="pointer-events-none absolute border-2 border-dashed border-amber-300 bg-amber-300/10" style={pctStyle(box)} />}
        </div>
      </div>

      <aside className="image-editor-controls flex w-80 shrink-0 flex-col border-l border-ui-ink/[0.08] bg-panel">
        <header className="flex items-center gap-2 border-b border-ui-ink/[0.06] px-4 py-3">
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-100" title={attachment.name}>
            {attachment.name}
          </h2>
          <button onClick={() => void close()} aria-label="Cerrar" className="text-zinc-500 hover:text-zinc-200">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {!regions.length && <p className="text-sm text-zinc-500">Arrastra sobre la imagen para marcar una zona y escribe qué quieres cambiar ahí.</p>}
          {regions.map((r, i) => (
            <div
              key={r.key}
              className={`rounded-lg p-2 ring-1 ${selected === r.key ? "bg-amber-300/5 ring-amber-400/50" : "ring-zinc-800"}`}
              onClick={() => setSelected(r.key)}
            >
              <div className="mb-1 flex items-center gap-2">
                <span className={`rounded px-1.5 text-[11px] font-bold text-white ${selected === r.key ? "bg-amber-500" : "bg-rose-500"}`}>{i + 1}</span>
                <button onClick={() => removeRegion(r.key)} aria-label={`Borrar zona ${i + 1}`} className="ml-auto text-zinc-500 hover:text-danger">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <textarea
                data-comment={r.key}
                value={r.comment}
                onFocus={() => setSelected(r.key)}
                onChange={(e) => update(r.key, { comment: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    void save();
                  }
                }}
                placeholder="¿Qué hay que cambiar aquí?"
                rows={3}
                className="ui-field ui-control w-full resize-y rounded-md bg-zinc-900 p-2 text-sm text-zinc-200 ring-1 ring-zinc-800 outline-none focus:ring-indigo-600"
              />
            </div>
          ))}
        </div>
        <footer className="flex justify-end gap-2 border-t border-ui-ink/[0.06] px-4 py-3">
          <Button variant="ghost" onClick={() => void close()}>
            Cancelar
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={saving}>
            {saving && <Spinner />} Guardar
          </Button>
        </footer>
      </aside>
    </div>
  );
}

/**
 * Images for a chat message: uploaded right away as the card's images (so the agent gets them
 * with the card from then on), sent as ids with the message. Removing one before sending deletes it.
 */
export function useChatImages(card: Card) {
  const [items, setItems] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const [editing, setEditing] = useState<number | null>(null);
  useEffect(() => setItems([]), [card.id]);

  const add = async (files: File[]) => {
    if (!files.length) return;
    setUploading((n) => n + files.length);
    for (const file of files) {
      try {
        const data = await prepareImage(file);
        const name = file.name && file.name !== "image.png" ? file.name : `captura-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}`;
        const att = await api<Attachment>(`/api/cards/${card.id}/attachments`, { name, data });
        setItems((prev) => [...prev, att]);
      } catch (e) {
        reportError(`No se pudo subir ${file.name || "la imagen"}: ${(e as Error).message}`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };
  const remove = (a: Attachment) => {
    setItems((prev) => prev.filter((x) => x.id !== a.id));
    void api(`/api/attachments/${a.id}`, undefined, "DELETE").catch((e) => reportError((e as Error).message));
  };
  const onPaste = (e: React.ClipboardEvent) => {
    const files = imageFiles(e.clipboardData?.files);
    if (!files.length) return;
    e.preventDefault();
    void add(files);
  };
  const onDrop = (e: React.DragEvent) => {
    const files = imageFiles(e.dataTransfer?.files);
    if (!files.length) return;
    e.preventDefault();
    void add(files);
  };
  const current = items.find((a) => a.id === editing);
  const strip =
    items.length || uploading ? (
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {items.map((a) => (
          <div key={a.id} className="group relative">
            <button
              onClick={() => setEditing(a.id)}
              title="Marcar zonas y comentar"
              className="block h-14 overflow-hidden rounded-md bg-zinc-900 ring-1 ring-zinc-800 hover:ring-indigo-400"
            >
              <img src={imageUrl(a)} alt={a.name} className="h-full w-auto max-w-[120px] object-cover" draggable={false} />
            </button>
            {a.annotations.length > 0 && (
              <span className="pointer-events-none absolute bottom-0.5 left-0.5 rounded bg-rose-500 px-1 text-[10px] font-semibold text-white">{a.annotations.length}</span>
            )}
            <button
              onClick={() => remove(a)}
              aria-label={`Quitar ${a.name}`}
              className="absolute -top-1.5 -right-1.5 rounded-full bg-zinc-800 p-0.5 text-zinc-300 ring-1 ring-zinc-700 hover:text-danger"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
        {uploading > 0 && <Spinner />}
        {current && (
          <ImageEditor attachment={current} onClose={() => setEditing(null)} onSaved={(a) => setItems((prev) => prev.map((x) => (x.id === a.id ? a : x)))} />
        )}
      </div>
    ) : null;
  return { items, ids: items.map((a) => a.id), uploading: uploading > 0, add, onPaste, onDrop, clear: () => setItems([]), strip };
}

/** Paperclip-style button that opens the file picker for chat images. */
export function AddImageButton({ onFiles }: { onFiles: (files: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button variant="ghost" size="md" aria-label="Añadir imagen" title="Añadir imagen (también puedes pegarla o arrastrarla)" onClick={() => input.current?.click()} className="px-2.5">
        <ImagePlus className="h-4 w-4" />
      </Button>
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          onFiles(imageFiles(e.target.files));
          e.target.value = "";
        }}
      />
    </>
  );
}
