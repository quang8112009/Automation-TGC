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
import {
  ErrorMessage,
  Loading,
  StatCard,
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

  if (isLoading) return <Loading />;
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
    <div className="page-header">
      <div>
        <div className="eyebrow">Tổng quan</div>
        <h1 className="page-title">Dashboard</h1>
      </div>
      <span className={`badge ${dataSync.stale ? 'badge-yellow' : 'badge-green'}`}>
        Data sync: {dataSync.status}
        {dataSync.lastSync ? ` · ${formatDate(dataSync.lastSync)}` : ' · never'}
      </span>
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
  const funnelEntries = Object.entries(kpis.candidateFunnel);

  return (
    <>
      <div className="grid grid-4" style={{ marginBottom: 18 }}>
        <StatCard label="Tổng số Lead" count={kpis.totalLeads} />
        <StatCard
          label="Chờ duyệt"
          count={kpis.pendingApprovals}
          hint={
            approvalQueue
              ? `${approvalQueue.draftCount} bản nháp · ${approvalQueue.pendingInsightCount} insight`
              : undefined
          }
        />
        <StatCard label="Tỷ lệ chuyển đổi" value={renderConversionRate(kpis.conversionRate)} />
        <StatCard label="Bài đăng lỗi" count={failedPosts.length} valueColor={failedPosts.length ? 'var(--danger)' : undefined} />
      </div>

      <div className="card" style={{ marginBottom: 18 }}>
        <h2 className="card-title">Phễu ứng viên</h2>
        {funnelEntries.length === 0 ? (
          <div className="muted">Chưa có ứng viên nào.</div>
        ) : (
          <div className="inline-list">
            {funnelEntries.map(([stage, count]) => (
              <span key={stage} className="badge badge-blue">
                {stage}: {count}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 18 }}>
        <h2 className="card-title">Hoạt động gần đây</h2>
        <RecentActivityList items={data.recentActivity} />
      </div>

      <div className="card" style={{ marginBottom: 18 }}>
        <h2 className="card-title">Hàng chờ duyệt</h2>
        {queueItems.length === 0 ? (
          <div className="muted">Không có mục nào đang chờ duyệt.</div>
        ) : (
          <>
            {isAdmin ? (
              <div className="muted" style={{ fontSize: 'var(--fs-xs)', marginBottom: 8 }}>
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
          <div style={{ marginTop: 10 }}>
            <ErrorMessage error={reorderError} />
          </div>
        ) : null}
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h2 className="card-title">Bài sắp đăng</h2>
          {upcomingPosts.length === 0 ? (
            <div className="muted">Không có bài đăng nào trong 7 ngày tới.</div>
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
            <div className="muted">Không có lỗi.</div>
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

/** The Recent_Activity_Feed list (ADMIN only) — newest first, full context (Req 6.6). */
function RecentActivityList({ items }: { items: ActivityFeedItem[] }) {
  if (items.length === 0) {
    return <div className="muted">Chưa có hoạt động nào.</div>;
  }
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>Người thực hiện</th>
            <th>Hành động</th>
            <th>Đối tượng</th>
            <th>Thời gian</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
            <tr key={`${item.targetType}-${item.targetId}-${item.createdAt}-${index}`}>
              <td>{item.actorUserId}</td>
              <td>{activityActionLabel(item.action)}</td>
              <td>
                {activityTargetLabel(item.targetType)} #{item.targetId}
              </td>
              <td>{formatDate(item.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** SALES (personal scope): personal KPIs only — no company stats, no activity feed. */
function SalesDashboard({ data }: { data: PersonalDashboardOverview }) {
  const { kpis } = data;
  const leadStatusEntries = Object.entries(kpis.leadsByStatus);

  return (
    <>
      <div className="grid grid-4" style={{ marginBottom: 18 }}>
        <StatCard label="Lead của tôi" count={kpis.totalLeads} />
      </div>

      <div className="card">
        <h2 className="card-title">Lead theo trạng thái</h2>
        {leadStatusEntries.length === 0 ? (
          <div className="muted">Chưa có Lead nào được phân công.</div>
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
