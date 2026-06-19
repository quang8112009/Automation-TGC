/**
 * ErrorBoundary — catches render-time errors anywhere in the subtree so a single
 * throwing page can no longer blank the whole app (white screen).
 *
 * Two failure modes are handled:
 *
 *  1. **Stale lazy-chunk after a deploy.** Pages are code-split with
 *     `React.lazy(() => import(...))`. When a new frontend build is deployed, the
 *     old hashed chunk files are removed. A tab that is still open references the
 *     old filenames, so the NEXT route navigation triggers a dynamic `import()`
 *     that 404s and rejects with a "Failed to fetch dynamically imported module"
 *     / "Importing a module script failed" / ChunkLoadError. React then unmounts
 *     the tree under <Suspense>, which looked like a frozen blank page on page
 *     change. We detect this class of error and auto-recover with a ONE-TIME hard
 *     reload (guarded by a sessionStorage flag so we never loop), which re-fetches
 *     index.html and the current chunk manifest.
 *
 *  2. **Any other render error.** Shown as an inline, recoverable error card with
 *     "Thử lại" (reset the boundary) and "Tải lại trang" (hard reload) actions —
 *     the rest of the app shell (sidebar/topbar) stays intact.
 *
 * The boundary is keyed by route in App.tsx so navigating away from a broken page
 * automatically clears the error state.
 */
import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { Icon } from './Icon';

/** sessionStorage flag so a chunk-error reload happens at most once per session-burst. */
const CHUNK_RELOAD_FLAG = 'autotgc.chunkReloadAt';
/** Within this window we treat a repeat chunk error as "reload didn't help" and stop looping. */
const CHUNK_RELOAD_COOLDOWN_MS = 30_000;

/**
 * Heuristic: is this error a failed dynamic-import (stale chunk) rather than a
 * genuine app bug? Matches the messages browsers use across engines.
 */
export function isChunkLoadError(error: unknown): boolean {
  if (!error) return false;
  const name = (error as { name?: unknown }).name;
  if (typeof name === 'string' && name === 'ChunkLoadError') return true;
  const message = (error as { message?: unknown }).message;
  const text = typeof message === 'string' ? message : '';
  return (
    /Failed to fetch dynamically imported module/i.test(text) ||
    /error loading dynamically imported module/i.test(text) ||
    /Importing a module script failed/i.test(text) ||
    /dynamically imported module/i.test(text) ||
    /Loading chunk [\d]+ failed/i.test(text) ||
    /Loading CSS chunk/i.test(text)
  );
}

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Changing this value resets the boundary (used to clear errors on route change). */
  resetKey?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    // Clear the error when the route (resetKey) changes so navigating away from
    // a broken page restores a working view automatically.
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // A stale lazy-chunk after a deploy is not a code bug — recover by reloading
    // once (guarded so we never get stuck in a reload loop).
    if (isChunkLoadError(error)) {
      let last = 0;
      try {
        last = Number(sessionStorage.getItem(CHUNK_RELOAD_FLAG) ?? '0');
      } catch {
        last = 0;
      }
      const now = Date.now();
      if (!last || now - last > CHUNK_RELOAD_COOLDOWN_MS) {
        try {
          sessionStorage.setItem(CHUNK_RELOAD_FLAG, String(now));
        } catch {
          /* ignore storage errors (private mode) */
        }
        window.location.reload();
        return;
      }
      // A recent reload already happened and we're still failing — fall through
      // to the visible fallback instead of looping.
    }
    // Surface for diagnostics; never throw from here.
    // eslint-disable-next-line no-console
    console.error('ErrorBoundary caught an error:', error, info?.componentStack);
  }

  private handleRetry = (): void => {
    this.setState({ error: null });
  };

  private handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const chunk = isChunkLoadError(error);
    return (
      <div className="content">
        <div className="error-box" role="alert" style={{ maxWidth: 640, margin: '2rem auto' }}>
          <span className="state__line">
            <Icon name="alert-triangle" size={18} />
            <span>
              <strong>{chunk ? 'Phiên bản ứng dụng đã được cập nhật' : 'Đã xảy ra lỗi hiển thị'}</strong>
              {' — '}
              {chunk
                ? 'Trang cần được tải lại để dùng phiên bản mới nhất.'
                : 'Trang gặp sự cố khi hiển thị. Bạn có thể thử lại hoặc tải lại trang.'}
            </span>
          </span>
          <div className="state__detail">
            <code>{error.message}</code>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
            {!chunk && (
              <button className="btn btn--secondary btn-sm" onClick={this.handleRetry}>
                <Icon name="refresh-cw" size={16} />
                <span>Thử lại</span>
              </button>
            )}
            <button className="btn btn-sm" onClick={this.handleReload}>
              <Icon name="refresh-cw" size={16} />
              <span>Tải lại trang</span>
            </button>
          </div>
        </div>
      </div>
    );
  }
}
