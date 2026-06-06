/**
 * Small shared presentational components: loading/empty/error states, status
 * badges, pagination, a basic modal, a skeleton loader, and a KPI stat card.
 * Kept dependency-free (icons come from the inline-SVG Icon component).
 */
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { CSSProperties, ReactNode } from 'react';
import { Icon } from './Icon';
import type { IconName } from './Icon';
import { useCountUp } from '../lib/useCountUp';
import { classifyError } from '../lib/errors';

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
 * Loading state. Renders skeletons shaped like the content they stand in for
 * (Requirement 8.1) rather than a generic spinner. The default `card` variant
 * keeps the original behaviour (a title bar + N skeleton rows); `kpi` mimics a
 * row of StatCards and `table` mimics table rows. Pass `inline` for a compact
 * spinner+label (e.g. inside a button row). The original `label`/`inline`/`rows`
 * API is preserved.
 */
export function Loading({
  label = 'Đang tải…',
  inline = false,
  rows = 3,
  variant = 'card',
  cols = 4,
}: {
  label?: string;
  inline?: boolean;
  rows?: number;
  /** Skeleton shape to render. Defaults to the card-content shape. */
  variant?: 'card' | 'kpi' | 'table';
  /** Number of KPI tiles (variant="kpi") or table columns (variant="table"). */
  cols?: number;
}) {
  if (inline) {
    return (
      <div className="state" role="status" aria-live="polite">
        <span className="spinner" aria-hidden="true" /> {label}
      </div>
    );
  }

  if (variant === 'kpi') {
    return (
      <div className="skeleton-kpi-grid" role="status" aria-live="polite" aria-label={label}>
        {Array.from({ length: Math.max(1, cols) }).map((_, i) => (
          <div key={i} className="skeleton skeleton--kpi" aria-hidden="true" />
        ))}
      </div>
    );
  }

  if (variant === 'table') {
    return (
      <div className="skeleton-stack" role="status" aria-live="polite" aria-label={label}>
        {Array.from({ length: Math.max(1, rows) }).map((_, i) => (
          <span key={i} className="skeleton skeleton--table-row" aria-hidden="true" />
        ))}
      </div>
    );
  }

  return (
    <div className="skeleton-stack" role="status" aria-live="polite" aria-label={label}>
      <Skeleton className="skeleton--title" />
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
 * Render an error. Delegates the value→variant decision to the pure
 * `classifyError` (see lib/errors.ts, Design — Property 4): a 502 ApiError
 * (external AI / social service not configured on the server) becomes a soft
 * "notice"; any other error becomes an inline "error-box". Both variants always
 * surface the backend `code` (when present) alongside the `message`.
 */
export function ErrorMessage({ error }: { error: unknown }) {
  const view = classifyError(error);

  if (view.kind === 'notice') {
    return (
      <div className="notice">
        <strong>Dịch vụ chưa cấu hình.</strong> Thao tác này cần một dịch vụ ngoài
        (AI / nền tảng mạng xã hội) chưa được thiết lập trên máy chủ.
        <div className="state__detail">
          <code>
            {view.code}: {view.message}
          </code>
        </div>
      </div>
    );
  }

  return (
    <div className="error-box">
      <span className="state__line">
        <Icon name="alert-triangle" size={16} />
        <span>
          <strong>{view.code ?? 'Error'}</strong> — {view.message}
        </span>
      </span>
    </div>
  );
}

export function SuccessMessage({ children }: { children: ReactNode }) {
  return (
    <div className="success-box">
      <span className="state__line">
        <Icon name="check" size={16} />
        <span>{children}</span>
      </span>
    </div>
  );
}

/** The only badge color classes the contract allows (Design — Property 3). */
const BADGE_CLASSES = ['badge-gray', 'badge-green', 'badge-red', 'badge-blue', 'badge-yellow'] as const;
type BadgeClass = (typeof BADGE_CLASSES)[number];
const VALID_BADGE_CLASSES = new Set<string>(BADGE_CLASSES);

const STATUS_CLASS: Record<string, BadgeClass> = {
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

/**
 * Resolve a status string to a valid badge color class. Total: any unknown or
 * empty status (or a mapping that somehow falls outside the allowed set) yields
 * `badge-gray`. Pure so it can back Property 3.
 */
export function statusBadgeClass(status: string): BadgeClass {
  const mapped = STATUS_CLASS[status];
  return mapped && VALID_BADGE_CLASSES.has(mapped) ? mapped : 'badge-gray';
}

/**
 * Status pill. Always renders the textual `status` label alongside the color so
 * state is never conveyed by color alone (a11y, Requirement 9.6), and always
 * returns a `"badge " + <valid class>` string (Requirement 5.6).
 */
export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge ${statusBadgeClass(status)}`}>{status}</span>;
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

  // Render via a portal to <body> so the fixed-position overlay is NOT trapped
  // inside an ancestor that establishes a containing block for fixed elements
  // (e.g. the page's `.reveal` wrapper animates `transform`, which would
  // otherwise position the modal relative to that wrapper instead of the
  // viewport — making the dialog render off-screen while only the backdrop dims).
  return createPortal(
    <div
      className="modal-backdrop"
      onClick={onClose}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: '100vw',
        height: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
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
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString();
}
