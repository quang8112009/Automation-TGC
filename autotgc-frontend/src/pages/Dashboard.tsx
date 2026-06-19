/**
 * Dashboard — role-branched on the backend's discriminated overview payload
 * (GET /api/dashboard/overview). Live-refreshes via react-query invalidation
 * driven by the realtime stream.
 *
 * ADMIN (scope === 'company') sees company-wide KPIs (total leads, candidate
 * funnel breakdown, pending approvals, conversion rate), a "Hoạt động gần đây"
 * (Recent Activity) feed sourced from the append-only ActivityLog, plus the
 * existing operational sections: the Approval_Queue (with drag-and-drop
 * prioritisation), the upcoming publishing schedule and failed-post alerts.
 *
 * SALES (scope === 'personal') sees only personal, assigned-only KPIs — no
 * company stats and no activity feed (the backend omits them entirely).
 *
 * The Approval_Queue drag-and-drop uses the native HTML5 Drag and Drop API
 * (no extra dependency). Dropping an item computes the new orderedIds and
 * persists it via POST /api/v1/approval-queue/reorder with an optimistic cache
 * update + rollback on error (Req 6.1, 6.2, 6.3, 6.4).
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getOverview, reorderApprovalQueue } from '../api/dashboard';
import { useAuth } from '../auth/AuthContext';
import type {
  ActivityFeedItem,
  ApprovalQueueItem,
  CompanyDashboardOverview,
  DashboardDataSync,
  DashboardOverview,
  PersonalDashboardOverview,
  ScopedNumber,
} from '../lib/types';
import { Icon } from '../components/Icon';
import type { IconName } from '../components/Icon';
import {
  Empty,
  ErrorMessage,
  Loading,
  StatusBadge,
  formatDate,
} from '../components/ui';

const OVERVIEW_KEY = ['dashboard', 'overview'] as const;

/** Human-readable Vietnamese labels for ActivityLog action codes (Req 6.6). */
const ACTIVITY_ACTION_LABELS: Record<string, string> = {
  DOCUMENT_VERIFIED: 'Đã xác minh giấy tờ',
  CANDIDATE_STAGE_CHANGED: 'Đổi giai đoạn ứng viên',
  LEAD_STATUS_CHANGED: 'Đổi trạng thái lead',
};

/** Vietnamese labels for the activity target entity type. */
const ACTIVITY_TARGET_LABELS: Record<string, string> = {
  document: 'giấy tờ',
  candidate: 'ứng viên',
  lead: 'lead',
};

function activityActionLabel(action: string): string {
  return ACTIVITY_ACTION_LABELS[action] ?? action;
}

function activityTargetLabel(targetType: string): string {
  return ACTIVITY_TARGET_LABELS[targetType] ?? targetType;
}

/** Render a divide-by-zero-safe rate as a percentage, or the insufficient-data note. */
function renderConversionRate(rate: ScopedNumber): string {
  if (rate === 'INSUFFICIENT_DATA') return 'Chưa đủ dữ liệu';
  return `${(rate * 100).toFixed(1)}%`;
}

/** Move the item at `from` to `to`, returning a new array (pure). */
function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) {
    return items;
  }
  const next = items.slice();
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return items;
  next.splice(to, 0, moved);
  return next;
}

export function Dashboard() {
  const { role } = useAuth();
  const isAdmin = role === 'ADMIN';
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: OVERVIEW_KEY,
    queryFn: getOverview,
  });

  // Index of the row currently being dragged (for visual feedback).
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  // Persist a new Approval_Queue order. Optimistically reorders the cached
  // overview and rolls back to the snapshot if the server rejects (e.g. 403 for
  // SALES, or 400 on a stale id set). Only the ADMIN (company) payload carries
  // an approvalQueue, so the optimistic update is guarded on scope.
  const reorderMutation = useMutation({
    mutationFn: (orderedIds: string[]) => reorderApprovalQueue(orderedIds),
    onMutate: async (orderedIds: string[]) => {
      await queryClient.cancelQueries({ queryKey: OVERVIEW_KEY });
      const previous = queryClient.getQueryData<DashboardOverview>(OVERVIEW_KEY);
      if (previous && previous.scope === 'company' && previous.approvalQueue) {
        const queue = previous.approvalQueue;
        const byId = new Map(queue.items.map((it) => [it.id, it]));
        const items = orderedIds
          .map((id, index) => {
            const item = byId.get(id);
            return item ? { ...item, priorityIndex: index } : undefined;
          })
          .filter((it): it is ApprovalQueueItem => it !== undefined);
        queryClient.setQueryData<DashboardOverview>(OVERVIEW_KEY, {
          ...previous,
          approvalQueue: { ...queue, items },
        });
      }
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(OVERVIEW_KEY, context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: OVERVIEW_KEY });
    },
  });

  if (isLoading) {
    // State-shaped loading: a KPI row skeleton over a table-row skeleton, so the
    // placeholder matches the dashboard's final shape (Req 8.1) instead of a
    // generic spinner.
    return (
      <div className="reveal">
        <Loading variant="kpi" cols={4} />
        <div style={{ marginTop: 'var(--space-lg)' }}>
          <Loading variant="table" rows={5} />
        </div>
      </div>
    );
  }
  if (error) return <ErrorMessage error={error} />;
  if (!data) return null;

  const queueItems = data.scope === 'company' ? data.approvalQueue?.items ?? [] : [];

  function commitReorder(from: number, to: number) {
    const reordered = moveItem(queueItems, from, to);
    if (reordered === queueItems) return;
    reorderMutation.mutate(reordered.map((it) => it.id));
  }

  function handleDrop(targetIndex: number) {
    if (dragIndex === null) return;
    commitReorder(dragIndex, targetIndex);
    setDragIndex(null);
  }

  return (
    <div className="reveal">
      <DashboardHeader dataSync={data.dataSync} />

      {data.scope === 'company' ? (
        <AdminDashboard
          data={data}
          isAdmin={isAdmin}
          dragIndex={dragIndex}
          setDragIndex={setDragIndex}
          handleDrop={handleDrop}
          reorderError={reorderMutation.isError ? reorderMutation.error : null}
        />
      ) : (
        <SalesDashboard data={data} />
      )}
    </div>
  );
}

function DashboardHeader({ dataSync }: { dataSync: DashboardDataSync }) {
  return (
    <div className="page-head">
      <div className="page-head__titles">
        <h1 className="page-head__title">
          Tổng quan <em>hoạt động</em>
        </h1>
        <p className="page-head__subtitle">
          Theo dõi hiệu suất chiến dịch, KPI tuyển dụng và AI sinh nội dung.
        </p>
      </div>
      <div className="page-head__actions">
        <span className={`badge ${dataSync.stale ? 'badge-yellow' : 'badge-green'}`}>
          <span className="badge__dot" aria-hidden="true" />
          Đồng bộ: {dataSync.status}
          {dataSync.lastSync ? ` · ${formatDate(dataSync.lastSync)}` : ' · chưa có'}
        </span>
      </div>
    </div>
  );
}

/** KPI tile in the reference style: label + icon box, big mono value, delta row. */
function KpiCard({
  label,
  value,
  icon,
  delta,
  danger = false,
}: {
  label: string;
  value: React.ReactNode;
  icon: IconName;
  delta?: { text: string; dir: 'up' | 'down' | 'flat' };
  danger?: boolean;
}) {
  const deltaIcon: IconName =
    delta?.dir === 'up' ? 'trending-up' : delta?.dir === 'down' ? 'trending-down' : 'minus';
  return (
    <div className={`kpi-card${danger ? ' kpi-card--danger' : ''}`}>
      <div className="kpi-card__top">
        <div>
          <div className="kpi-card__label">{label}</div>
          <div className="kpi-card__value">{value}</div>
        </div>
        <span className="kpi-card__icon" aria-hidden="true">
          <Icon name={icon} size={20} />
        </span>
      </div>
      {delta ? (
        <div className="kpi-card__delta">
          <span
            className={`badge ${danger ? 'badge-red' : delta.dir === 'down' ? 'badge-gray' : 'badge-green'}`}
          >
            <Icon name={deltaIcon} size={12} />
            {delta.text}
          </span>
          <span>so với tháng trước</span>
        </div>
      ) : null}
    </div>
  );
}

/** ADMIN (company scope): company KPIs + Recent Activity + operational sections. */
function AdminDashboard({
  data,
  isAdmin,
  dragIndex,
  setDragIndex,
  handleDrop,
  reorderError,
}: {
  data: CompanyDashboardOverview;
  isAdmin: boolean;
  dragIndex: number | null;
  setDragIndex: (index: number | null) => void;
  handleDrop: (targetIndex: number) => void;
  reorderError: unknown;
}) {
  const { kpis } = data;
  const approvalQueue = data.approvalQueue;
  const upcomingPosts = data.upcomingPosts ?? [];
  const failedPosts = data.alerts?.failedPosts ?? [];
  const queueItems = approvalQueue?.items ?? [];
  const funnelEntries = Object.entries(kpis.candidateFunnel ?? {});
  const funnelMax = funnelEntries.reduce((m, [, c]) => Math.max(m, c), 0);

  return (
    <>
      <div className="kpi-grid">
        <KpiCard label="Tổng số Lead" value={kpis.totalLeads.toLocaleString('vi-VN')} icon="user-plus" />
        <KpiCard
          label="Hồ sơ chờ duyệt"
          value={kpis.pendingApprovals.toLocaleString('vi-VN')}
          icon="clipboard-list"
          delta={
            approvalQueue
              ? { text: `${approvalQueue.draftCount} nháp`, dir: 'flat' }
              : undefined
          }
        />
        <KpiCard
          label="Tỷ lệ chuyển đổi"
          value={renderConversionRate(kpis.conversionRate)}
          icon="trending-up"
        />
        <KpiCard
          label="Bài đăng lỗi"
          value={failedPosts.length}
          icon="alert-triangle"
          danger={failedPosts.length > 0}
        />
      </div>

      <div className="bento-3 section">
        <div className="card bento-3__feature">
          <h2 className="card-title">Phễu chuyển đổi ứng viên</h2>
          {funnelEntries.length === 0 ? (
            <Empty icon="users" label="Chưa có ứng viên nào." />
          ) : (
            <div className="funnel-bars">
              {funnelEntries.map(([stage, count]) => (
                <div className="funnel-bars__col" key={stage}>
                  <div className="funnel-bars__track">
                    <span className="funnel-bars__value">{count.toLocaleString('vi-VN')}</span>
                    <div
                      className="funnel-bars__fill"
                      style={{ height: `${funnelMax > 0 ? Math.max((count / funnelMax) * 100, 4) : 4}%` }}
                    />
                  </div>
                  <div className="funnel-bars__label">{stage}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bento-3__side">
          <div className="card" style={{ marginBottom: 0 }}>
            <h2 className="card-title">Hoạt động gần đây</h2>
            <RecentActivityFeed items={data.recentActivity} />
          </div>
        </div>
      </div>

      <div className="card">
        <h2 className="card-title">Hàng chờ duyệt</h2>
        {queueItems.length === 0 ? (
          <Empty icon="clipboard-list" label="Không có mục nào đang chờ duyệt." />
        ) : (
          <>
            {isAdmin ? (
              <div className="muted" style={{ fontSize: 'var(--fs-xs)', marginBottom: 'var(--space-sm)' }}>
                Kéo–thả để sắp xếp thứ tự ưu tiên.
              </div>
            ) : null}
            <ul className="dnd-list" role="list">
              {queueItems.map((item, index) => (
                <li
                  key={item.id}
                  role="listitem"
                  className={`dnd-row${dragIndex === index ? ' dnd-row--dragging' : ''}`}
                  draggable={isAdmin}
                  aria-grabbed={isAdmin ? dragIndex === index : undefined}
                  onDragStart={
                    isAdmin
                      ? (e) => {
                          setDragIndex(index);
                          e.dataTransfer.effectAllowed = 'move';
                          // Some browsers require data to be set to start a drag.
                          e.dataTransfer.setData('text/plain', item.id);
                        }
                      : undefined
                  }
                  onDragOver={
                    isAdmin
                      ? (e) => {
                          e.preventDefault();
                          e.dataTransfer.dropEffect = 'move';
                        }
                      : undefined
                  }
                  onDrop={
                    isAdmin
                      ? (e) => {
                          e.preventDefault();
                          handleDrop(index);
                        }
                      : undefined
                  }
                  onDragEnd={isAdmin ? () => setDragIndex(null) : undefined}
                >
                  {isAdmin ? (
                    <span className="dnd-handle" aria-hidden="true" title="Kéo để sắp xếp">
                      <Icon name="menu" size={16} />
                    </span>
                  ) : null}
                  <span className="dnd-row__title">{item.title || '(Không có tiêu đề)'}</span>
                  <span
                    className={`badge ${item.kind === 'DRAFT' ? 'badge-gray' : 'badge-yellow'}`}
                  >
                    {item.kind === 'DRAFT' ? 'Bản nháp' : 'Insight'}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
        {reorderError ? (
          <div style={{ marginTop: 'var(--space-sm)' }}>
            <ErrorMessage error={reorderError} />
          </div>
        ) : null}
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h2 className="card-title">Bài sắp đăng</h2>
          {upcomingPosts.length === 0 ? (
            <Empty icon="send" label="Không có bài đăng nào trong 7 ngày tới." />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Nền tảng</th>
                    <th>Thời gian</th>
                    <th>Trạng thái</th>
                  </tr>
                </thead>
                <tbody>
                  {upcomingPosts.map((p) => (
                    <tr key={p.id}>
                      <td>{p.platform}</td>
                      <td>{formatDate(p.scheduledAt)}</td>
                      <td>
                        <StatusBadge status={p.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <h2 className="card-title">Cảnh báo bài đăng lỗi</h2>
          {failedPosts.length === 0 ? (
            <Empty icon="check" label="Không có lỗi." />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Nền tảng</th>
                    <th>Lý do</th>
                    <th>Số lần thử lại</th>
                  </tr>
                </thead>
                <tbody>
                  {failedPosts.map((p) => (
                    <tr key={p.id}>
                      <td>{p.platform}</td>
                      <td>{p.failureReason ?? p.errorCode ?? 'không rõ'}</td>
                      <td>{p.retryCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/** The Recent_Activity_Feed (ADMIN only) — newest first, bullet + mono meta. */
function RecentActivityFeed({ items }: { items: ActivityFeedItem[] }) {
  const list = items ?? [];
  if (list.length === 0) {
    return <Empty icon="file-text" label="Chưa có hoạt động nào." />;
  }
  return (
    <div className="steps-list">
      {list.slice(0, 6).map((item, index) => (
        <div className="feed-item" key={`${item.targetType}-${item.targetId}-${item.createdAt}-${index}`}>
          <span className="feed-item__dot" aria-hidden="true" />
          <div style={{ minWidth: 0 }}>
            <div className="feed-item__title">
              {activityActionLabel(item.action)} · {activityTargetLabel(item.targetType)} #{item.targetId}
            </div>
            <div className="feed-item__meta">
              {item.actorUserId} • {formatDate(item.createdAt)}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** SALES (personal scope): personal KPIs only — no company stats, no activity feed. */
function SalesDashboard({ data }: { data: PersonalDashboardOverview }) {
  const { kpis } = data;
  const leadStatusEntries = Object.entries(kpis.leadsByStatus ?? {});

  return (
    <>
      <div className="kpi-grid">
        <KpiCard label="Lead của tôi" value={kpis.totalLeads.toLocaleString('vi-VN')} icon="user-plus" />
      </div>

      <div className="card">
        <h2 className="card-title">Lead theo trạng thái</h2>
        {leadStatusEntries.length === 0 ? (
          <Empty icon="users" label="Chưa có Lead nào được phân công." />
        ) : (
          <div className="inline-list">
            {leadStatusEntries.map(([status, count]) => (
              <span key={status} className="badge badge-blue">
                {status}: {count}
              </span>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
