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
      <div className="page-header">
        <div>
          <div className="eyebrow">CRM tuyển dụng</div>
          <h1 className="page-title">Leads</h1>
        </div>
        <div className="row-actions">
          <button className="btn btn-sm" disabled={exportBusy} onClick={() => handleExport('csv')}>
            Export CSV
          </button>
          <button className="btn btn-sm" disabled={exportBusy} onClick={() => handleExport('json')}>
            Export JSON
          </button>
          {isAdmin && (
            <button className="btn btn-primary btn-sm" onClick={() => setShowCreate(true)}>
              <Icon name="plus" size={16} />
              New Lead
            </button>
          )}
        </div>
      </div>

      {actionError != null && <ErrorMessage error={actionError} />}

      {/* Stats summary */}
      <div className="card">
        <h2 className="card-title">Leads by Source</h2>
        {statsQuery.isLoading ? (
          <Loading />
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
          <div className="muted">No stats available.</div>
        )}
      </div>

      {/* Filters */}
      <div className="toolbar">
        <div className="field">
          <label>Source</label>
          <input
            value={pendingFilters.source ?? ''}
            onChange={(e) => setPendingFilters((f) => ({ ...f, source: e.target.value }))}
            placeholder="facebook, website…"
          />
        </div>
        <div className="field">
          <label>Platform</label>
          <input
            value={pendingFilters.platform ?? ''}
            onChange={(e) => setPendingFilters((f) => ({ ...f, platform: e.target.value }))}
          />
        </div>
        <div className="field">
          <label>Status</label>
          <select
            value={pendingFilters.status ?? ''}
            onChange={(e) => setPendingFilters((f) => ({ ...f, status: e.target.value }))}
          >
            <option value="">All</option>
            {LEAD_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>From</label>
          <input
            type="date"
            value={pendingFilters.from ?? ''}
            onChange={(e) => setPendingFilters((f) => ({ ...f, from: e.target.value }))}
          />
        </div>
        <div className="field">
          <label>To</label>
          <input
            type="date"
            value={pendingFilters.to ?? ''}
            onChange={(e) => setPendingFilters((f) => ({ ...f, to: e.target.value }))}
          />
        </div>
        <button className="btn btn--secondary" onClick={applyFilters}>
          Filter
        </button>
        <button className="btn" onClick={resetFilters}>
          Reset
        </button>
      </div>

      {/* Table */}
      <div className="card">
        {leadsQuery.isLoading ? (
          <Loading />
        ) : leadsQuery.error ? (
          <ErrorMessage error={leadsQuery.error} />
        ) : leadsQuery.data && leadsQuery.data.items.length > 0 ? (
          <>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Contact</th>
                    <th>Source</th>
                    <th>Platform</th>
                    <th>Status</th>
                    <th>Created</th>
                    <th>Actions</th>
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
                        <div className="row-actions">
                          <button className="btn btn-sm" onClick={() => setViewLeadId(lead.leadId)}>
                            View
                          </button>
                          {isAdmin && (
                            <>
                              <button className="btn btn-sm" onClick={() => setEditLead(lead)}>
                                Edit
                              </button>
                              <button
                                className="btn btn-sm"
                                disabled={promoteMutation.isPending}
                                onClick={() => confirmPromote(lead)}
                                title="Tạo hồ sơ ứng viên từ lead này"
                              >
                                Chuyển thành ứng viên
                              </button>
                              <button
                                className="btn btn-danger btn-sm"
                                onClick={() => confirmDelete(lead)}
                              >
                                Delete
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
            <Pagination
              page={leadsQuery.data.page}
              limit={leadsQuery.data.limit}
              total={leadsQuery.data.total}
              onPage={(p) => setFilters((f) => ({ ...f, page: p }))}
            />
          </>
        ) : (
          <Empty label="No leads match your filters." />
        )}
      </div>

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
    <Modal title="New Lead" onClose={onClose}>
      {mutation.error != null && <ErrorMessage error={mutation.error} />}
      <div className="grid grid-2">
        <div className="field">
          <label>Name</label>
          <input value={form.name ?? ''} onChange={(e) => set('name', e.target.value)} />
        </div>
        <div className="field">
          <label>Email</label>
          <input value={form.email ?? ''} onChange={(e) => set('email', e.target.value)} />
        </div>
        <div className="field">
          <label>Phone</label>
          <input value={form.phone ?? ''} onChange={(e) => set('phone', e.target.value)} />
        </div>
        <div className="field">
          <label>Source *</label>
          <input value={form.source ?? ''} onChange={(e) => set('source', e.target.value)} />
        </div>
        <div className="field">
          <label>Platform *</label>
          <input value={form.platform ?? ''} onChange={(e) => set('platform', e.target.value)} />
        </div>
        <div className="field">
          <label>Content Post ID</label>
          <input
            value={form.contentPostId ?? ''}
            onChange={(e) => set('contentPostId', e.target.value)}
            placeholder="attribution post id"
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
          <label>Domain Category</label>
          <input
            value={form.domainCategory ?? ''}
            onChange={(e) => set('domainCategory', e.target.value)}
          />
        </div>
        <div className="field">
          <label>Content Topic</label>
          <input
            value={form.contentTopic ?? ''}
            onChange={(e) => set('contentTopic', e.target.value)}
          />
        </div>
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn btn-primary"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? 'Creating…' : 'Create'}
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
    <Modal title={`Edit Lead — ${lead.name ?? lead.leadId}`} onClose={onClose}>
      {mutation.error != null && <ErrorMessage error={mutation.error} />}
      <div className="field">
        <label>Status</label>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          {LEAD_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <div className="muted" style={{ marginTop: 4 }}>
          Illegal transitions are rejected by the server (409).
        </div>
      </div>
      <div className="field">
        <label>Assigned To (user id)</label>
        <input value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)} />
      </div>
      <div className="field">
        <label>Note</label>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn btn-primary"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? 'Saving…' : 'Save'}
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
    <Modal title="Lead Detail" onClose={onClose}>
      {isLoading ? (
        <Loading />
      ) : error ? (
        <ErrorMessage error={error} />
      ) : data ? (
        <>
          <dl className="kv">
            <dt>Lead ID</dt>
            <dd>{data.leadId}</dd>
            <dt>Name</dt>
            <dd>{data.name ?? '—'}</dd>
            <dt>Email</dt>
            <dd>{data.email ?? '—'}</dd>
            <dt>Phone</dt>
            <dd>{data.phone ?? '—'}</dd>
            <dt>Status</dt>
            <dd>
              <StatusBadge status={data.status} />
            </dd>
            <dt>Source / Platform</dt>
            <dd>
              {data.source} / {data.platform}
            </dd>
            <dt>UTM</dt>
            <dd>
              {[data.utmSource, data.utmMedium, data.utmCampaign].filter(Boolean).join(' · ') || '—'}
            </dd>
            <dt>Content Post</dt>
            <dd>{data.contentPostId}</dd>
            <dt>Assigned To</dt>
            <dd>{data.assignedTo ?? '—'}</dd>
            <dt>Created</dt>
            <dd>{formatDate(data.createdAt)}</dd>
          </dl>

          <h3 style={{ marginTop: 18 }}>History</h3>
          {data.history.length === 0 ? (
            <div className="muted">No history entries.</div>
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
                  {data.history.map((h) => (
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
