/**
 * Small shared presentational components: loading/empty/error states, status
 * badges, pagination, a basic modal, a skeleton loader, and a KPI stat card.
 * Kept dependency-free (icons come from the inline-SVG Icon component).
 */
import { useEffect } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { ApiError } from '../lib/apiClient';
import { Icon } from './Icon';
import type { IconName } from './Icon';
import { useCountUp } from '../lib/useCountUp';

/**
 * Skeleton placeholder block (shimmer is disabled under prefers-reduced-motion
 * via styles.css). Shape it like the content it stands in for.
 */
export function Skeleton({
  width,
  height,
  className,
  style,
}: {
  width?: number | string;
  height?: number | string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      className={className ? `skeleton ${className}` : 'skeleton'}
      style={{ width, height, ...style }}
      aria-hidden="true"
    />
  );
}

/**
 * Loading state. Defaults to a small set of skeleton rows shaped like a card's
 * content; pass `inline` for a compact spinner+label (e.g. inside a button row).
 * The `label` API is preserved.
 */
export function Loading({
  label = 'Loading…',
  inline = false,
  rows = 3,
}: {
  label?: string;
  inline?: boolean;
  rows?: number;
}) {
  if (inline) {
    return (
      <div className="state" role="status" aria-live="polite">
        <span className="spinner" aria-hidden="true" /> {label}
      </div>
    );
  }
  return (
    <div className="skeleton-stack" role="status" aria-live="polite" aria-label={label}>
      <Skeleton height={16} width="40%" />
      {Array.from({ length: Math.max(1, rows) }).map((_, i) => (
        <Skeleton key={i} className="skeleton--row" />
      ))}
    </div>
  );
}

export function Empty({
  label = 'Nothing to show yet.',
  icon = 'file-text',
  action,
}: {
  label?: string;
  icon?: IconName;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <Icon name={icon} size={32} />
      <div className="empty-state__title">{label}</div>
      {action}
    </div>
  );
}

/**
 * Render an error. Recognizes the backend ApiError (with code/message) and
 * surfaces a friendly "service not configured" note for 502s (Gemini / social
 * platforms not configured on the server).
 */
export function ErrorMessage({ error }: { error: unknown }) {
  if (error instanceof ApiError) {
    const notConfigured = error.status === 502;
    return (
      <div className={notConfigured ? 'notice' : 'error-box'}>
        {notConfigured ? (
          <>
            <strong>Service not configured.</strong> This action needs an external
            service (AI / social platform) that isn’t set up on the server.
            <div style={{ marginTop: 6 }}>
              <code>
                {error.code}: {error.message}
              </code>
            </div>
          </>
        ) : (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <Icon name="alert-triangle" size={16} />
            <span>
              <strong>{error.code}</strong> — {error.message}
            </span>
          </span>
        )}
      </div>
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="error-box">
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <Icon name="alert-triangle" size={16} />
        <span>
          <strong>Error</strong> — {message}
        </span>
      </span>
    </div>
  );
}

export function SuccessMessage({ children }: { children: ReactNode }) {
  return (
    <div className="success-box">
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <Icon name="check" size={16} />
        <span>{children}</span>
      </span>
    </div>
  );
}

const STATUS_CLASS: Record<string, string> = {
  // content / posts
  DRAFT: 'badge-gray',
  PENDING_REVIEW: 'badge-yellow',
  APPROVED: 'badge-green',
  REJECTED: 'badge-red',
  SCHEDULED: 'badge-blue',
  PUBLISHED: 'badge-green',
  FAILED: 'badge-red',
  // leads
  NEW: 'badge-blue',
  CONTACTED: 'badge-yellow',
  QUALIFIED: 'badge-blue',
  CONVERTED: 'badge-green',
  LOST: 'badge-red',
  // workflows
  RUNNING: 'badge-blue',
  WAITING_APPROVAL: 'badge-yellow',
  COMPLETED: 'badge-green',
  CANCELLED: 'badge-gray',
  PENDING: 'badge-gray',
  DONE: 'badge-green',
  SKIPPED: 'badge-gray',
  // tokens / sync
  VALID: 'badge-green',
  MISSING: 'badge-red',
  REFRESH_FAILED: 'badge-red',
  CURRENT: 'badge-green',
  STALE: 'badge-yellow',
};

export function StatusBadge({ status }: { status: string }) {
  const cls = STATUS_CLASS[status] ?? 'badge-gray';
  return <span className={`badge ${cls}`}>{status}</span>;
}

/**
 * Count-up number for KPI cards. Animates 0 → value on mount (reduced-motion
 * aware via useCountUp). `suffix` (e.g. "%") and `decimals` shape the display.
 */
export function CountUp({
  value,
  decimals = 0,
  suffix = '',
}: {
  value: number;
  decimals?: number;
  suffix?: string;
}) {
  const animated = useCountUp(value);
  const text = animated.toLocaleString('vi-VN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return (
    <>
      {text}
      {suffix}
    </>
  );
}

/**
 * KPI stat card with an optional trend delta. Additive helper — existing pages
 * keep using the raw `.stat` markup; new callers can opt into this for the
 * green-up / red-down delta convention (invertible for cost metrics).
 *
 * Pass a numeric `count` (with optional `decimals`/`suffix`) instead of `value`
 * to get an animated count-up; `value` still accepts arbitrary nodes.
 */
export function StatCard({
  label,
  value,
  count,
  decimals = 0,
  suffix = '',
  hint,
  delta,
  invertDelta = false,
  valueColor,
}: {
  label: string;
  value?: ReactNode;
  /** When set, renders an animated count-up number (takes precedence over `value`). */
  count?: number;
  decimals?: number;
  suffix?: string;
  /** Optional muted sub-line under the value (e.g. a breakdown). */
  hint?: ReactNode;
  /** Positive = up, negative = down, 0/undefined = flat. */
  delta?: { value: number; text: string; period?: string };
  invertDelta?: boolean;
  valueColor?: string;
}) {
  const dir = !delta || delta.value === 0 ? 'flat' : delta.value > 0 ? 'up' : 'down';
  const deltaIcon: IconName =
    dir === 'up' ? 'trending-up' : dir === 'down' ? 'trending-down' : 'minus';
  return (
    <div className="stat">
      <div className="stat__label">{label}</div>
      <div className="stat__value" style={valueColor ? { color: valueColor } : undefined}>
        {typeof count === 'number' ? (
          <CountUp value={count} decimals={decimals} suffix={suffix} />
        ) : (
          value
        )}
      </div>
      {delta && (
        <span
          className={`stat__delta stat__delta--${dir}${invertDelta ? ' stat__delta--invert' : ''}`}
        >
          <Icon name={deltaIcon} size={14} />
          {delta.text}
          {delta.period ? <span className="stat__delta-period">{delta.period}</span> : null}
        </span>
      )}
      {hint ? <div className="muted" style={{ fontSize: 'var(--fs-xs)' }}>{hint}</div> : null}
    </div>
  );
}

export function Pagination({
  page,
  limit,
  total,
  onPage,
}: {
  page: number;
  limit: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return (
    <div className="pagination">
      <span className="muted">
        Page {page} of {totalPages} · {total} total
      </span>
      <button
        className="btn btn-sm"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
      >
        <Icon name="chevron-left" size={16} />
        Prev
      </button>
      <button
        className="btn btn-sm"
        disabled={page >= totalPages}
        onClick={() => onPage(page + 1)}
      >
        Next
        <Icon name="chevron-right" size={16} />
      </button>
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  // Close on Esc; lock body scroll while open; return focus to the trigger.
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      // Restore focus to whatever opened the modal (if still in the DOM).
      if (trigger && typeof trigger.focus === 'function') trigger.focus();
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="modal-close" onClick={onClose} aria-label="Đóng" title="Đóng">
            <Icon name="x" size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString();
}
