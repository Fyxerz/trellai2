import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Card, Column } from "../../shared/types";

export function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
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

export function StatusBadge({ card }: { card: Card }) {
  if (card.status === "running")
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-amber-300">
        <Spinner /> {card.column === "preparation" ? "Preparando" : "Trabajando"}
      </span>
    );
  if (card.status === "waiting")
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-violet-500/15 px-2 py-0.5 text-[11px] font-medium text-violet-300 ring-1 ring-violet-500/30">
        <span className="h-1.5 w-1.5 rounded-full bg-violet-400 animate-pulse" /> Te necesita
      </span>
    );
  if (card.status === "error")
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] font-medium text-red-300 ring-1 ring-red-500/30">
        Error
      </span>
    );
  return null;
}

export function Spinner({ className = "h-3 w-3" }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity=".25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Button({
  variant = "default",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "primary" | "danger" | "ghost" }) {
  const styles = {
    default: "bg-zinc-800 hover:bg-zinc-700 text-zinc-100 ring-1 ring-zinc-700",
    primary: "bg-sky-500 hover:bg-sky-400 text-zinc-950 font-semibold",
    danger: "bg-transparent hover:bg-red-500/10 text-red-300 ring-1 ring-red-500/30",
    ghost: "bg-transparent hover:bg-zinc-800 text-zinc-300",
  }[variant];
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition disabled:opacity-40 disabled:pointer-events-none ${styles} ${className}`}
    />
  );
}

export function timeAgo(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "ahora";
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}
