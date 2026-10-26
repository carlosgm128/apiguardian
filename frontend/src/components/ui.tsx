import { useState, type ReactNode } from "react";
import type { Severity } from "../types";

// Status always pairs color with an icon and a label (never color alone).
const STATUS: Record<string, { icon: string; label: string; tone: string }> = {
  running: { icon: "●", label: "Running", tone: "running" },
  queued: { icon: "○", label: "Queued", tone: "muted" },
  done: { icon: "✓", label: "Done", tone: "good" },
  failed: { icon: "✕", label: "Failed", tone: "critical" },
  cancelled: { icon: "■", label: "Cancelled", tone: "muted" },
  skipped: { icon: "–", label: "Skipped", tone: "muted" },
  "not-run": { icon: "–", label: "Not run", tone: "muted" },
  "diff-only": { icon: "◆", label: "Diff only", tone: "muted" },
  idle: { icon: "○", label: "Idle", tone: "muted" },
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const s = STATUS[status] ?? { icon: "?", label: status, tone: "muted" };
  return (
    <span className={`badge tone-${s.tone}`}>
      <span className={`badge-icon${status === "running" ? " pulse" : ""}`} aria-hidden>
        {s.icon}
      </span>
      {label ?? s.label}
    </span>
  );
}

export function SevChip({ severity, children }: { severity: Severity | "critical" | "high" | "medium" | "low"; children?: ReactNode }) {
  return <span className={`sev sev-${severity}`}>{children ?? severity}</span>;
}

export function SevCounts({ changes }: { changes: { severity: Severity }[] }) {
  const b = changes.filter((c) => c.severity === "breaking").length;
  const w = changes.filter((c) => c.severity === "warning").length;
  return (
    <span className="sev-counts">
      {b > 0 && <SevChip severity="breaking">{b}</SevChip>}
      {w > 0 && <SevChip severity="warning">{w}</SevChip>}
    </span>
  );
}

export interface Tile {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
}

export function StatTiles({ tiles }: { tiles: Tile[] }) {
  return (
    <div className="stats">
      {tiles.map((t) => (
        <div className="stat" key={t.label}>
          <div className="stat-label">{t.label}</div>
          <div className="stat-value">
            {t.value}
            {t.sub !== undefined && t.sub !== "" && <small> {t.sub}</small>}
          </div>
        </div>
      ))}
    </div>
  );
}

export function Panel({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`panel ${className ?? ""}`}>
      {(title || actions) && (
        <header className="panel-head">
          <h2>{title}</h2>
          {actions && <div className="panel-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Tabs<T extends string>({ tabs, active, onChange }: { tabs: { id: T; label: string; count?: number }[]; active: T; onChange: (id: T) => void }) {
  return (
    <nav className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={t.id === active} className={t.id === active ? "tab active" : "tab"} onClick={() => onChange(t.id)}>
          {t.label}
          {t.count !== undefined && <span className="tab-count">{t.count}</span>}
        </button>
      ))}
    </nav>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function KeyValues({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="kv">
      {rows.map(([k, v]) => (
        <div key={k} className="kv-row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Preformatted text with a copy button; long blocks start collapsed. */
export function CodeBlock({ title, text, collapsedLines = 24 }: { title: string; text: string; collapsedLines?: number }) {
  const lines = text.split("\n").length;
  const [open, setOpen] = useState(lines <= collapsedLines);
  const [copied, setCopied] = useState(false);
  return (
    <div className="code">
      <div className="code-head">
        <span>{title}</span>
        <span className="code-meta">
          {lines} lines · {text.length.toLocaleString()} chars
        </span>
        <button
          className="btn-link"
          onClick={() => {
            void navigator.clipboard?.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
        {lines > collapsedLines && (
          <button className="btn-link" onClick={() => setOpen(!open)}>
            {open ? "Collapse" : "Expand"}
          </button>
        )}
      </div>
      <pre className={open ? "" : "collapsed"}>{text || "(empty)"}</pre>
    </div>
  );
}
