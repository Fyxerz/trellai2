import { useEffect, useState } from "react";
import { MOD, readPreference } from "./preferences";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Eye,
  GitMerge,
  Hourglass,
  Hammer,
  Inbox,
  MessageCircleQuestion,
  PencilLine,
  Sparkles,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { Card, Column } from "../../shared/types";

export function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Wide tables scroll inside their own box instead of squeezing columns or overflowing the panel.
          table: ({ node: _node, ...props }) => (
            <div className="md-table">
              <table {...props} />
            </div>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

export const COLUMN_ACCENT: Record<Column, string> = {
  backlog: "bg-zinc-500",
  plan: "bg-sky-400",
  preparation: "bg-violet-400",
  doing: "bg-amber-400",
  review: "bg-emerald-400",
  merged: "bg-zinc-600",
};

/** Hex colours per column (for bars and charts). */
export const COLUMN_HEX: Record<Column, string> = {
  backlog: "#6c717c",
  plan: "#38bdf8",
  preparation: "#a78bfa",
  doing: "#fbbf24",
  review: "#34d399",
  merged: "#3f434b",
};

export const COLUMN_ICON: Record<Column, LucideIcon> = {
  backlog: Inbox,
  plan: PencilLine,
  preparation: Sparkles,
  doing: Hammer,
  review: Eye,
  merged: GitMerge,
};

/** What a running card is doing right now: "Preparando", "Mergeando" (incl. resolving a merge conflict) or "Trabajando". */
export function runningLabel(card: Pick<Card, "column" | "status_text">): string {
  if (card.column === "preparation") return "Preparando";
  if (card.column === "merged" || /^(Mergeando|Resolviendo conflicto)/.test(card.status_text ?? "")) return "Mergeando";
  return "Trabajando";
}

export function StatusBadge({ card }: { card: Card }) {
  if (card.status === "running")
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-amber-500/12 px-2 py-0.5 text-xs font-medium text-warning ring-1 ring-amber-400/25">
        <Spinner /> {runningLabel(card)}
      </span>
    );
  if (card.status === "waiting")
    return (
      <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-violet-500/12 px-2 py-0.5 text-xs font-medium text-waiting ring-1 ring-violet-400/25">
        <MessageCircleQuestion className="h-3 w-3" /> Te necesita
      </span>
    );
  if (card.status === "ready")
    return (
      <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-sky-400/10 px-2 py-0.5 text-xs font-medium text-info ring-1 ring-sky-300/20">
        <Hourglass className="h-3 w-3" /> En espera
      </span>
    );
  if (card.status === "error")
    return (
      <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-red-500/12 px-2 py-0.5 text-xs font-medium text-danger ring-1 ring-red-400/25">
        <TriangleAlert className="h-3 w-3" /> Error
      </span>
    );
  return null;
}

export function Spinner({ className = "h-3 w-3" }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity=".25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Button({
  variant = "default",
  size = "md",
  className = "",
  ...props
}: React.ComponentProps<"button"> & { variant?: "default" | "primary" | "danger" | "ghost"; size?: "sm" | "md" }) {
  const styles = {
    default: "bg-ui-ink/[0.05] hover:bg-ui-ink/[0.09] text-zinc-100 ring-1 ring-ui-ink/[0.08] hover:ring-ui-ink/[0.14]",
    primary:
      "bg-indigo-600 hover:bg-indigo-500 text-white font-medium shadow-[0_1px_0_0_rgb(255_255_255/0.25)_inset,0_1px_2px_rgb(0_0_0/0.4)]",
    danger: "bg-transparent hover:bg-red-500/10 text-danger ring-1 ring-red-400/25",
    ghost: "bg-transparent hover:bg-ui-ink/[0.06] text-zinc-300 hover:text-zinc-100",
  }[variant];
  const sizes = { sm: "h-8 px-2.5 text-xs", md: "h-9 px-3.5 text-sm" }[size];
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg transition-colors disabled:pointer-events-none disabled:opacity-45 ${sizes} ${styles} ${className}`}
    />
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-ui-ink/10 bg-ui-ink/[0.04] px-1 font-mono text-[10px] text-zinc-400">
      {children}
    </kbd>
  );
}

const AVATAR_COLORS = ["#818cf8", "#38bdf8", "#34d399", "#fbbf24", "#f472b6", "#a78bfa", "#fb923c", "#2dd4bf"];

export function projectColor(id: string) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export function ProjectAvatar({ id, name, size = 22 }: { id: string; name: string; size?: number }) {
  const color = projectColor(id);
  const initials = name
    .replace(/[^a-zA-Z0-9 \-_]/g, "")
    .split(/[\s\-_]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("") || "?";
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-md font-semibold"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        color,
        background: `color-mix(in oklab, ${color} 16%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${color} 30%, transparent)`,
      }}
    >
      {initials}
    </span>
  );
}

export function timeAgo(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "ahora";
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

/** Shift+Enter always inserts a newline. Respect the user's sending preference. */
export function chatKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>, send: () => void, _setText?: (v: string) => void) {
  if (e.key !== "Enter" || e.nativeEvent.isComposing || e.shiftKey || e.altKey) return;
  const modified = e.metaKey || e.ctrlKey;
  if (readPreference("send", "enter") === "mod" ? !modified : modified) return;
  e.preventDefault();
  if (e.repeat) return;
  send();
}

export function ChatHint() {
  const [mode, setMode] = useState(() => readPreference("send", "enter"));
  useEffect(() => {
    const update = () => setMode(readPreference("send", "enter"));
    window.addEventListener("trellai:preferences", update);
    window.addEventListener("storage", update);
    return () => { window.removeEventListener("trellai:preferences", update); window.removeEventListener("storage", update); };
  }, []);
  return <span>{mode === "mod" ? `${MOD}+Enter envía · Enter nueva línea` : "Enter envía · Shift+Enter nueva línea"}</span>;
}
