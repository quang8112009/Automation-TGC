/**
 * Leads — filterable, paginated table with view/create/edit/delete and CSV/JSON
 * export plus a stats summary. SALES is read-only and assigned-only: create,
 * edit, and delete controls are hidden (the backend also enforces this).
 *
 * Endpoints: GET /api/leads, GET /api/leads/stats, GET /api/leads/export,
 * POST /api/leads, GET/PUT/DELETE /api/leads/:id.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createLead,
  deleteLead,
  exportLeads,
  getLead,
  getLeadStats,
  listLeads,
  updateLead,
} from '../api/leads';
import type { CreateLeadInput, LeadFilters } from '../api/leads';
import { promoteLeadToCandidate } from '../api/recruitment';
import { useAuth } from '../auth/AuthContext';
import {
  Empty,
  ErrorMessage,
  Loading,
  Modal,
  Pagination,
  StatusBadge,
  formatDate,
} from '../components/ui';
import { Icon } from '../components/Icon';
import type { Lead } from '../lib/types';

const LEAD_STATUSES = ['NEW', 'CONTACTED', 'QUALIFIED', 'CONVERTED', 'LOST'];
const PAGE_LIMIT = 20;

export function Leads() {
  const { role } = useAuth();
  const isAdmin = role === 'ADMIN';
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [filters, setFilters] = useState<LeadFilters>({ page: 1, limit: PAGE_LIMIT });
  const [pendingFilters, setPendingFilters] = useState<LeadFilters>({});
  const [showCreate, setShowCreate] = useState(false);
  const [editLead, setEditLead] = useState<Lead | null>(null);
  const [viewLeadId, setViewLeadId] = useState<string | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);

  const leadsQuery = useQuery({
    queryKey: ['leads', filters],
    queryFn: () => listLeads(filters),
  });

  const statsQuery = useQuery({
    queryKey: ['leadStats', 'source'],
    queryFn: () => getLeadStats('source'),
  });

  function applyFilters() {
    setFilters({ ...pendingFilters, page: 1, limit: PAGE_LIMIT });
  }

  function resetFilters() {
    setPendingFilters({});
    setFilters({ page: 1, limit: PAGE_LIMIT });
  }

  async function handleExport(format: 'csv' | 'json') {
    setActionError(null);
    setExportBusy(true);
    try {
      const { blob, filename } = await exportLeads(format, filters.from, filters.to);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || `leads.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setActionError(err);
    } finally {
      setExportBusy(false);
    }
  }

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteLead(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['leads'] });
    },
    onError: (err) => setActionError(err),
  });

  function confirmDelete(lead: Lead) {
    if (window.confirm(`Delete lead ${lead.name ?? lead.leadId}? This cannot be undone.`)) {
      deleteMutation.mutate(lead.leadId);
    }
  }

  // Promote a lead into a recruitment candidate (ứng viên) and open it.
  const promoteMutation = useMutation({
    mutationFn: (leadId: string) => promoteLeadToCandidate(leadId),
    onSuccess: (candidate) => {
      void queryClient.invalidateQueries({ queryKey: ['candidates'] });
      navigate(`/candidates/${candidate.id}`);
    },
    onError: (err) => setActionError(err),
  });

  function confirmPromote(lead: Lead) {
    if (
      window.confirm(
        `Chuyển lead ${lead.name ?? lead.leadId} thành ứng viên? Bạn sẽ được chuyển tới hồ sơ ứng viên.`,
      )
    ) {
      setActionError(null);
      promoteMutation.mutate(lead.leadId);
    }
  }

  return (
    <div className="reveal">
      <div className="page-head">
        <div className="page-head__titles">
          <h1 className="page-head__title">
            Quản lý <em>Leads</em>
          </h1>
          <p className="page-head__subtitle">Danh sách khách hàng tiềm năng cần tư vấn.</p>
        </div>
        <div className="page-head__actions">
          <button className="btn btn-sm" disabled={exportBusy} onClick={() => handleExport('csv')}>
            <Icon name="file-text" size={16} /> Xuất CSV
          </button>
          <button className="btn btn-sm" disabled={exportBusy} onClick={() => handleExport('json')}>
            Xuất JSON
          </button>
          {isAdmin && (
            <button className="btn btn-primary btn-sm" onClick={() => setShowCreate(true)}>
              <Icon name="plus" size={16} />
              Thêm mới
            </button>
          )}
        </div>
      </div>

      {actionError != null && <ErrorMessage error={actionError} />}

      {/* Stats summary */}
      <div className="card">
        <h2 className="card-title">Leads theo nguồn</h2>
        {statsQuery.isLoading ? (
          <Loading variant="kpi" cols={4} />
        ) : statsQuery.error ? (
          <ErrorMessage error={statsQuery.error} />
        ) : statsQuery.data && statsQuery.data.buckets.length > 0 ? (
          <div className="inline-list">
            {statsQuery.data.buckets.map((b) => (
              <span key={b.key} className="badge badge-blue">
                {b.key || '(none)'}: {b.count}
              </span>
            ))}
          </div>
        ) : (
          <Empty icon="bar-chart-3" label="Chưa có dữ liệu thống kê." />
        )}
      </div>

      {/* Filters */}
      <div className="toolbar">
        <div className="field">
          <label>Nguồn</label>
          <input
            value={pendingFilters.source ?? ''}
            onChange={(e) => setPendingFilters((f) => ({ ...f, source: e.target.value }))}
            placeholder="facebook, website…"
          />
        </div>
        <div className="field">
          <label>Nền tảng</label>
          <input
            value={pendingFilters.platform ?? ''}
            onChange={(e) => setPendingFilters((f) => ({ ...f, platform: e.target.value }))}
          />
        </div>
        <div className="field">
          <label>Trạng thái</label>
          <select
            value={pendingFilters.status ?? ''}
            onChange={(e) => setPendingFilters((f) => ({ ...f, status: e.target.value }))}
          >
            <option value="">Tất cả</option>
            {LEAD_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Từ ngày</label>
          <input
            type="date"
            value={pendingFilters.from ?? ''}
            onChange={(e) => setPendingFilters((f) => ({ ...f, from: e.target.value }))}
          />
        </div>
        <div className="field">
          <label>Đến ngày</label>
          <input
            type="date"
            value={pendingFilters.to ?? ''}
            onChange={(e) => setPendingFilters((f) => ({ ...f, to: e.target.value }))}
          />
        </div>
        <button className="btn btn--secondary" onClick={applyFilters}>
          Lọc
        </button>
        <button className="btn" onClick={resetFilters}>
          Đặt lại
        </button>
      </div>

      {/* Table */}
      {leadsQuery.isLoading ? (
        <div className="card">
          <Loading variant="table" rows={8} />
        </div>
      ) : leadsQuery.error ? (
        <ErrorMessage error={leadsQuery.error} />
      ) : leadsQuery.data && leadsQuery.data.items.length > 0 ? (
        <div className="table-card">
          <div className="table-card__toolbar">
            <span className="muted">Danh sách Lead</span>
            <span className="table-card__count">
              Hiển thị <strong>{leadsQuery.data.items.length}</strong> / <strong>{leadsQuery.data.total.toLocaleString('vi-VN')}</strong>
            </span>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Tên Lead</th>
                  <th>Liên hệ</th>
                  <th>Nguồn</th>
                  <th>Nền tảng</th>
                  <th>Trạng thái</th>
                  <th>Ngày tạo</th>
                  <th style={{ textAlign: 'right' }}>Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {leadsQuery.data.items.map((lead) => (
                  <tr key={lead.leadId}>
                    <td>{lead.name ?? '—'}</td>
                    <td>
                      {lead.email ?? '—'}
                      {lead.phone ? <div className="muted">{lead.phone}</div> : null}
                    </td>
                    <td>{lead.source}</td>
                    <td>{lead.platform}</td>
                    <td>
                      <StatusBadge status={lead.status} />
                    </td>
                    <td>{formatDate(lead.createdAt)}</td>
                    <td>
                      <div className="row-actions row-reveal" style={{ justifyContent: 'flex-end' }}>
                        <button className="btn btn-sm" onClick={() => setViewLeadId(lead.leadId)}>
                          Xem
                        </button>
                        {isAdmin && (
                          <>
                            <button className="btn btn-sm" onClick={() => setEditLead(lead)}>
                              Sửa
                            </button>
                            <button
                              className="btn btn-sm"
                              disabled={promoteMutation.isPending}
                              onClick={() => confirmPromote(lead)}
                              title="Tạo hồ sơ ứng viên từ lead này"
                            >
                              <Icon name="user-plus" size={14} /> Chuyển ứng viên
                            </button>
                            <button
                              className="btn btn-danger btn-sm"
                              onClick={() => confirmDelete(lead)}
                            >
                              Xóa
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="table-card__footer">
            <Pagination
              page={leadsQuery.data.page}
              limit={leadsQuery.data.limit}
              total={leadsQuery.data.total}
              onPage={(p) => setFilters((f) => ({ ...f, page: p }))}
            />
          </div>
        </div>
      ) : (
        <div className="card">
          <Empty
            icon="users"
            label="Không có Lead nào khớp bộ lọc."
            action={
              isAdmin ? (
                <button className="btn btn-primary btn-sm" onClick={() => setShowCreate(true)}>
                  <Icon name="plus" size={16} />
                  Thêm mới
                </button>
              ) : undefined
            }
          />
        </div>
      )}

      {showCreate && isAdmin && (
        <CreateLeadModal
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            void queryClient.invalidateQueries({ queryKey: ['leads'] });
            void queryClient.invalidateQueries({ queryKey: ['leadStats'] });
          }}
        />
      )}

      {editLead && isAdmin && (
        <EditLeadModal
          lead={editLead}
          onClose={() => setEditLead(null)}
          onSaved={() => {
            setEditLead(null);
            void queryClient.invalidateQueries({ queryKey: ['leads'] });
          }}
        />
      )}

      {viewLeadId && <ViewLeadModal id={viewLeadId} onClose={() => setViewLeadId(null)} />}
    </div>
  );
}

function CreateLeadModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [form, setForm] = useState<CreateLeadInput>({
    source: 'website',
    platform: 'website',
    contentPostId: '',
  });
  const mutation = useMutation({
    mutationFn: () => createLead(form),
    onSuccess: onCreated,
  });

  function set<K extends keyof CreateLeadInput>(key: K, value: CreateLeadInput[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  return (
    <Modal title="Lead mới" onClose={onClose}>
      {mutation.error != null && <ErrorMessage error={mutation.error} />}
      <div className="grid grid-2">
        <div className="field">
          <label>Tên</label>
          <input value={form.name ?? ''} onChange={(e) => set('name', e.target.value)} />
        </div>
        <div className="field">
          <label>Email</label>
          <input value={form.email ?? ''} onChange={(e) => set('email', e.target.value)} />
        </div>
        <div className="field">
          <label>Số điện thoại</label>
          <input value={form.phone ?? ''} onChange={(e) => set('phone', e.target.value)} />
        </div>
        <div className="field">
          <label>Nguồn (bắt buộc)</label>
          <input value={form.source ?? ''} onChange={(e) => set('source', e.target.value)} />
        </div>
        <div className="field">
          <label>Nền tảng (bắt buộc)</label>
          <input value={form.platform ?? ''} onChange={(e) => set('platform', e.target.value)} />
        </div>
        <div className="field">
          <label>Mã bài thu hút (Content Post ID)</label>
          <input
            value={form.contentPostId ?? ''}
            onChange={(e) => set('contentPostId', e.target.value)}
            placeholder="mã bài gắn nguồn lead"
          />
        </div>
        <div className="field">
          <label>UTM Source</label>
          <input value={form.utmSource ?? ''} onChange={(e) => set('utmSource', e.target.value)} />
        </div>
        <div className="field">
          <label>UTM Medium</label>
          <input value={form.utmMedium ?? ''} onChange={(e) => set('utmMedium', e.target.value)} />
        </div>
        <div className="field">
          <label>UTM Campaign</label>
          <input
            value={form.utmCampaign ?? ''}
            onChange={(e) => set('utmCampaign', e.target.value)}
          />
        </div>
        <div className="field">
          <label>Danh mục lĩnh vực</label>
          <input
            value={form.domainCategory ?? ''}
            onChange={(e) => set('domainCategory', e.target.value)}
          />
        </div>
        <div className="field">
          <label>Chủ đề nội dung</label>
          <input
            value={form.contentTopic ?? ''}
            onChange={(e) => set('contentTopic', e.target.value)}
          />
        </div>
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Huỷ
        </button>
        <button
          className="btn btn-primary"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? 'Đang tạo…' : 'Tạo'}
        </button>
      </div>
    </Modal>
  );
}

function EditLeadModal({
  lead,
  onClose,
  onSaved,
}: {
  lead: Lead;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [status, setStatus] = useState(lead.status);
  const [note, setNote] = useState(lead.note ?? '');
  const [assignedTo, setAssignedTo] = useState(lead.assignedTo ?? '');

  const mutation = useMutation({
    mutationFn: () =>
      updateLead(lead.leadId, {
        status,
        note: note || null,
        assignedTo: assignedTo || null,
      }),
    onSuccess: onSaved,
  });

  return (
    <Modal title={`Sửa Lead — ${lead.name ?? lead.leadId}`} onClose={onClose}>
      {mutation.error != null && <ErrorMessage error={mutation.error} />}
      <div className="field">
        <label>Trạng thái</label>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          {LEAD_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <div className="muted" style={{ marginTop: 'var(--space-xs)' }}>
          Chuyển trạng thái không hợp lệ sẽ bị máy chủ từ chối (409).
        </div>
      </div>
      <div className="field">
        <label>Giao cho (mã người dùng)</label>
        <input value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)} />
      </div>
      <div className="field">
        <label>Ghi chú</label>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Huỷ
        </button>
        <button
          className="btn btn-primary"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? 'Đang lưu…' : 'Lưu'}
        </button>
      </div>
    </Modal>
  );
}

function ViewLeadModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['leads', 'detail', id],
    queryFn: () => getLead(id),
  });

  return (
    <Modal title="Chi tiết Lead" onClose={onClose}>
      {isLoading ? (
        <Loading />
      ) : error ? (
        <ErrorMessage error={error} />
      ) : data ? (
        <>
          <dl className="kv">
            <dt>Mã Lead</dt>
            <dd>{data.leadId}</dd>
            <dt>Tên</dt>
            <dd>{data.name ?? '—'}</dd>
            <dt>Email</dt>
            <dd>{data.email ?? '—'}</dd>
            <dt>Số điện thoại</dt>
            <dd>{data.phone ?? '—'}</dd>
            <dt>Trạng thái</dt>
            <dd>
              <StatusBadge status={data.status} />
            </dd>
            <dt>Nguồn / Nền tảng</dt>
            <dd>
              {data.source} / {data.platform}
            </dd>
            <dt>UTM</dt>
            <dd>
              {[data.utmSource, data.utmMedium, data.utmCampaign].filter(Boolean).join(' · ') || '—'}
            </dd>
            <dt>Bài thu hút</dt>
            <dd>{data.contentPostId}</dd>
            <dt>Giao cho</dt>
            <dd>{data.assignedTo ?? '—'}</dd>
            <dt>Tạo lúc</dt>
            <dd>{formatDate(data.createdAt)}</dd>
          </dl>

          <h3 style={{ marginTop: 'var(--space-md)' }}>Lịch sử</h3>
          {(data.history ?? []).length === 0 ? (
            <Empty icon="clipboard-list" label="Chưa có lịch sử." />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>From → To</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.history ?? []).map((h) => (
                    <tr key={h.id}>
                      <td>{formatDate(h.changedAt)}</td>
                      <td>
                        {h.previousStatus} → {h.newStatus}
                      </td>
                      <td>{h.note ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}
    </Modal>
  );
}
