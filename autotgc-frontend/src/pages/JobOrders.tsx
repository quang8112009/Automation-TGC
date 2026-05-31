/**
 * JobOrders (Đơn hàng tuyển dụng) — filterable, paginated table of recruitment
 * job orders with create/edit (modal) and a close action. ADMIN may create/edit/
 * close; SALES is read-only (controls hidden — the backend also enforces this).
 *
 * Endpoints: GET /api/v1/job-orders, GET /api/v1/job-orders/:id,
 * POST /api/v1/job-orders, PUT /api/v1/job-orders/:id,
 * POST /api/v1/job-orders/:id/close.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  closeJobOrder,
  createJobOrder,
  listJobOrders,
  updateJobOrder,
} from '../api/recruitment';
import type {
  CreateJobOrderInput,
  JobOrderFilters,
  UpdateJobOrderInput,
} from '../api/recruitment';
import { useAuth } from '../auth/AuthContext';
import { Empty, ErrorMessage, Loading, Modal, Pagination, formatDate } from '../components/ui';
import { Icon } from '../components/Icon';
import type { JobOrder } from '../lib/types';
import {
  JOB_GENDER_OPTIONS,
  JOB_ORDER_STATUSES,
  JOB_ORDER_STATUS_BADGE,
  JOB_ORDER_STATUS_LABELS,
  MARKETS,
  MARKET_LABELS,
  VISA_TYPES,
  VISA_TYPE_LABELS,
  jobOrderStatusLabel,
  marketLabel,
  visaTypeLabel,
} from '../lib/recruitment';
import type { JobOrderStatus } from '../lib/types';

const PAGE_LIMIT = 20;

function JobOrderStatusBadge({ status }: { status: string }) {
  const cls = JOB_ORDER_STATUS_BADGE[status as JobOrderStatus] ?? 'badge-gray';
  return <span className={`badge ${cls}`}>{jobOrderStatusLabel(status)}</span>;
}

export function JobOrders() {
  const { role } = useAuth();
  const isAdmin = role === 'ADMIN';
  const queryClient = useQueryClient();

  const [filters, setFilters] = useState<JobOrderFilters>({ page: 1, limit: PAGE_LIMIT });
  const [pendingFilters, setPendingFilters] = useState<JobOrderFilters>({});
  const [showCreate, setShowCreate] = useState(false);
  const [editOrder, setEditOrder] = useState<JobOrder | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);

  const ordersQuery = useQuery({
    queryKey: ['jobOrders', filters],
    queryFn: () => listJobOrders(filters),
  });

  const closeMutation = useMutation({
    mutationFn: (id: string) => closeJobOrder(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['jobOrders'] });
    },
    onError: (err) => setActionError(err),
  });

  function applyFilters() {
    setFilters({ ...pendingFilters, page: 1, limit: PAGE_LIMIT });
  }

  function resetFilters() {
    setPendingFilters({});
    setFilters({ page: 1, limit: PAGE_LIMIT });
  }

  function confirmClose(order: JobOrder) {
    if (window.confirm(`Đóng đơn hàng ${order.code} — ${order.title}?`)) {
      setActionError(null);
      closeMutation.mutate(order.id);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Đơn hàng tuyển dụng</h1>
        <div className="row-actions">
          {isAdmin && (
            <button className="btn btn-primary btn-sm" onClick={() => setShowCreate(true)}>
              <Icon name="plus" size={16} />
              Đơn hàng mới
            </button>
          )}
        </div>
      </div>

      {actionError != null && <ErrorMessage error={actionError} />}

      {/* Filters */}
      <div className="toolbar">
        <div className="field">
          <label>Thị trường</label>
          <select
            value={pendingFilters.market ?? ''}
            onChange={(e) => setPendingFilters((f) => ({ ...f, market: e.target.value }))}
          >
            <option value="">Tất cả</option>
            {MARKETS.map((m) => (
              <option key={m} value={m}>
                {MARKET_LABELS[m]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Diện visa</label>
          <select
            value={pendingFilters.visaType ?? ''}
            onChange={(e) => setPendingFilters((f) => ({ ...f, visaType: e.target.value }))}
          >
            <option value="">Tất cả</option>
            {VISA_TYPES.map((v) => (
              <option key={v} value={v}>
                {VISA_TYPE_LABELS[v]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Trạng thái</label>
          <select
            value={pendingFilters.status ?? ''}
            onChange={(e) => setPendingFilters((f) => ({ ...f, status: e.target.value }))}
          >
            <option value="">Tất cả</option>
            {JOB_ORDER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {JOB_ORDER_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <button className="btn btn--secondary" onClick={applyFilters}>
          Lọc
        </button>
        <button className="btn" onClick={resetFilters}>
          Đặt lại
        </button>
      </div>

      {/* Table */}
      <div className="card">
        {ordersQuery.isLoading ? (
          <Loading label="Đang tải…" />
        ) : ordersQuery.error ? (
          <ErrorMessage error={ordersQuery.error} />
        ) : ordersQuery.data && ordersQuery.data.items.length > 0 ? (
          <>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Mã</th>
                    <th>Tiêu đề</th>
                    <th>Ngành</th>
                    <th>Thị trường</th>
                    <th>Diện visa</th>
                    <th>SL</th>
                    <th>Lương</th>
                    <th>Trạng thái</th>
                    <th>Hạn</th>
                    <th>Thao tác</th>
                  </tr>
                </thead>
                <tbody>
                  {ordersQuery.data.items.map((order) => (
                    <tr key={order.id}>
                      <td>{order.code}</td>
                      <td>{order.title}</td>
                      <td>{order.industry || '—'}</td>
                      <td>{marketLabel(order.market)}</td>
                      <td>{visaTypeLabel(order.visaType)}</td>
                      <td>{order.quantity}</td>
                      <td>{order.salaryText || '—'}</td>
                      <td>
                        <JobOrderStatusBadge status={order.status} />
                      </td>
                      <td>{order.deadline ? formatDate(order.deadline) : '—'}</td>
                      <td>
                        <div className="row-actions">
                          {isAdmin && (
                            <>
                              <button className="btn btn-sm" onClick={() => setEditOrder(order)}>
                                Sửa
                              </button>
                              {order.status !== 'CLOSED' && (
                                <button
                                  className="btn btn-danger btn-sm"
                                  disabled={closeMutation.isPending}
                                  onClick={() => confirmClose(order)}
                                >
                                  Đóng
                                </button>
                              )}
                            </>
                          )}
                          {!isAdmin && <span className="muted">—</span>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={ordersQuery.data.page}
              limit={ordersQuery.data.limit}
              total={ordersQuery.data.total}
              onPage={(p) => setFilters((f) => ({ ...f, page: p }))}
            />
          </>
        ) : (
          <Empty label="Không có đơn hàng nào khớp bộ lọc." />
        )}
      </div>

      {showCreate && isAdmin && (
        <JobOrderFormModal
          mode="create"
          onClose={() => setShowCreate(false)}
          onSaved={() => {
            setShowCreate(false);
            void queryClient.invalidateQueries({ queryKey: ['jobOrders'] });
          }}
        />
      )}

      {editOrder && isAdmin && (
        <JobOrderFormModal
          mode="edit"
          order={editOrder}
          onClose={() => setEditOrder(null)}
          onSaved={() => {
            setEditOrder(null);
            void queryClient.invalidateQueries({ queryKey: ['jobOrders'] });
          }}
        />
      )}
    </div>
  );
}

function JobOrderFormModal({
  mode,
  order,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit';
  order?: JobOrder;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<CreateJobOrderInput>({
    code: order?.code ?? '',
    title: order?.title ?? '',
    industry: order?.industry ?? '',
    visaType: order?.visaType ?? 'TOKUTEI',
    market: order?.market ?? 'JAPAN',
    workLocation: order?.workLocation ?? '',
    salaryText: order?.salaryText ?? '',
    quantity: order?.quantity ?? 1,
    gender: order?.gender ?? 'ANY',
    nationalityReq: order?.nationalityReq ?? '',
    status: order?.status ?? 'OPEN',
    deadline: order?.deadline ? order.deadline.slice(0, 10) : '',
    description: order?.description ?? '',
  });

  const mutation = useMutation({
    mutationFn: () => {
      const payload: CreateJobOrderInput | UpdateJobOrderInput = {
        ...form,
        deadline: form.deadline ? form.deadline : null,
      };
      return mode === 'create'
        ? createJobOrder(payload)
        : updateJobOrder(order!.id, payload as UpdateJobOrderInput);
    },
    onSuccess: onSaved,
  });

  function set<K extends keyof CreateJobOrderInput>(key: K, value: CreateJobOrderInput[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  return (
    <Modal title={mode === 'create' ? 'Đơn hàng mới' : `Sửa đơn hàng — ${order?.code}`} onClose={onClose}>
      {mutation.error != null && <ErrorMessage error={mutation.error} />}
      <div className="grid grid-2">
        <div className="field">
          <label>Mã đơn hàng *</label>
          <input
            value={form.code ?? ''}
            onChange={(e) => set('code', e.target.value)}
            placeholder="VD: KN6131"
          />
        </div>
        <div className="field">
          <label>Tiêu đề *</label>
          <input value={form.title ?? ''} onChange={(e) => set('title', e.target.value)} />
        </div>
        <div className="field">
          <label>Ngành nghề</label>
          <input
            value={form.industry ?? ''}
            onChange={(e) => set('industry', e.target.value)}
            placeholder="Xây dựng, Điều dưỡng…"
          />
        </div>
        <div className="field">
          <label>Thị trường</label>
          <select value={form.market ?? 'JAPAN'} onChange={(e) => set('market', e.target.value)}>
            {MARKETS.map((m) => (
              <option key={m} value={m}>
                {MARKET_LABELS[m]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Diện visa</label>
          <select value={form.visaType ?? 'TOKUTEI'} onChange={(e) => set('visaType', e.target.value)}>
            {VISA_TYPES.map((v) => (
              <option key={v} value={v}>
                {VISA_TYPE_LABELS[v]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Nơi làm việc</label>
          <input
            value={form.workLocation ?? ''}
            onChange={(e) => set('workLocation', e.target.value)}
          />
        </div>
        <div className="field">
          <label>Mức lương (hiển thị)</label>
          <input
            value={form.salaryText ?? ''}
            onChange={(e) => set('salaryText', e.target.value)}
            placeholder="VD: 42-57tr"
          />
        </div>
        <div className="field">
          <label>Số lượng</label>
          <input
            type="number"
            min={1}
            value={form.quantity ?? 1}
            onChange={(e) => set('quantity', Number(e.target.value) || 1)}
          />
        </div>
        <div className="field">
          <label>Yêu cầu giới tính</label>
          <select value={form.gender ?? 'ANY'} onChange={(e) => set('gender', e.target.value)}>
            {JOB_GENDER_OPTIONS.map((g) => (
              <option key={g.value} value={g.value}>
                {g.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Yêu cầu quốc tịch</label>
          <input
            value={form.nationalityReq ?? ''}
            onChange={(e) => set('nationalityReq', e.target.value)}
          />
        </div>
        <div className="field">
          <label>Trạng thái</label>
          <select value={form.status ?? 'OPEN'} onChange={(e) => set('status', e.target.value)}>
            {JOB_ORDER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {JOB_ORDER_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Hạn nộp</label>
          <input
            type="date"
            value={form.deadline ?? ''}
            onChange={(e) => set('deadline', e.target.value)}
          />
        </div>
      </div>
      <div className="field">
        <label>Mô tả</label>
        <textarea
          value={form.description ?? ''}
          onChange={(e) => set('description', e.target.value)}
        />
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Hủy
        </button>
        <button
          className="btn btn-primary"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? 'Đang lưu…' : mode === 'create' ? 'Tạo' : 'Lưu'}
        </button>
      </div>
    </Modal>
  );
}
