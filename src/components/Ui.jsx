import { useState } from "react";
import { Loader2 } from "lucide-react";
import { scoreClass, riskClass, formatTone } from "../format";
import { SingleSelect } from "./Filters.jsx";

/**
 * Drops in the real logo when public/srv-logo.svg (or .png) exists, and falls
 * back to the SRV monogram until then — no broken image in the meantime.
 */
const LOGO_SOURCES = ["/srv-logo.svg", "/srv-logo.png"];

export function BrandLogo({ alt = "SRV Media" }) {
  const [attempt, setAttempt] = useState(0);
  if (attempt >= LOGO_SOURCES.length) return <div className="brand-mark">SRV</div>;
  return (
    <img
      className="brand-logo"
      src={LOGO_SOURCES[attempt]}
      alt={alt}
      onError={() => setAttempt((value) => value + 1)}
    />
  );
}

export function SingleSelectRow({ label, options, value, onChange, placeholder }) {
  return <SingleSelect label={label} options={options} value={value} onChange={onChange} placeholder={placeholder} />;
}

/** Tone sits beside the score, never inside it. */
export function TonePill({ tone, reason }) {
  const meta = formatTone(tone);
  if (!meta) return null;
  return (
    <span className={`tone-pill ${meta.tone}`} title={reason || meta.hint}>
      {meta.label}
    </span>
  );
}

export function Button({ children, icon: Icon, variant = "secondary", className = "", onClick, ...props }) {
  function click(event) {
    // Reveal rows only after an explicit Add/Copy click, not on typing or save.
    const button = event.currentTarget;
    const root = button.closest('.edit-form, .project-configuration-section-body, .bulk-editor-block, section');
    const selector = '.batch-editor-row, .app-user-draft-row, .performance-kpi-row, [data-draft-row]';
    const reveal = /^(?:add|copy)\b/i.test(button.textContent.trim()) && root;
    const before = reveal ? new Set(root.querySelectorAll(selector)) : null;
    onClick?.(event);
    if (reveal) window.requestAnimationFrame(() => {
      const added = [...root.querySelectorAll(selector)].filter(row => !before.has(row));
      added[0]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }
  return (
    <button className={`button ${variant} ${className}`.trim()} type="button" {...props} onClick={click}>
      {Icon ? <Icon size={16} strokeWidth={2.4} aria-hidden="true" /> : null}
      <span>{children}</span>
    </button>
  );
}

export function LinkButton({ children, icon: Icon, variant = "secondary", className = "", ...props }) {
  return (
    <a className={`button ${variant} ${className}`.trim()} {...props}>
      {Icon ? <Icon size={16} strokeWidth={2.4} aria-hidden="true" /> : null}
      <span>{children}</span>
    </a>
  );
}

export function Panel({ title, badge, children, className = "", action, ...props }) {
  return (
    <section className={`panel ${className}`.trim()} {...props}>
      <div className="panel-title">
        <h3>{title}</h3>
        <div className="panel-title-actions">
          {badge ? <StatusPill value={badge} /> : null}
          {action}
        </div>
      </div>
      {children}
    </section>
  );
}

export function MetricCard({ label, value, caption, tone = "neutral", onClick, title, active = false }) {
  const content = (
    <>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{caption}</small>
    </>
  );
  return onClick ? (
    <button
      type="button"
      className={`metric-card interactive ${tone} ${active ? "active" : ""}`.trim()}
      onClick={onClick}
      title={title}
      aria-pressed={active}
    >
      {content}
    </button>
  ) : <div className={`metric-card ${tone}`}>{content}</div>;
}

export function StatusPill({ value, tone }) {
  return <b className={`status-pill ${tone || riskClass(value)}`}>{value || "Unknown"}</b>;
}

export function ScoreMeter({ score }) {
  const width = Math.max(4, Math.min(100, Number(score || 0) * 10));
  return (
    <span className={`score-meter ${scoreClass(score)}`}>
      <i style={{ width: `${width}%` }} />
    </span>
  );
}

export function EmptyState({ title, text }) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      {text ? <p>{text}</p> : null}
    </div>
  );
}

export function LoadingBlock({ label = "Loading CSAT data" }) {
  return (
    <div className="loading-block">
      <Loader2 size={20} className="spin" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorBlock({ error, onRetry }) {
  return (
    <div className="error-block">
      <strong>Could not load data</strong>
      <p>{error?.message || "Something went wrong."}</p>
      {onRetry ? <Button variant="primary" onClick={onRetry}>Retry</Button> : null}
    </div>
  );
}
