/**
 * Candidates (Ứng viên) — filterable, paginated table of recruitment candidates
 * with a create form and a stage badge. Each row opens the candidate detail
 * (/candidates/:id). ADMIN sees all; SALES is auto-scoped to its assigned
 * candidates server-side. Listens to realtime notification events to live-
 * refresh the list when a candidate's stage changes.
 *
 * Endpoints: GET /api/v1/candidates, GET /api/v1/candidates/stats,
 * POST /api/v1/candidates.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createCandidate,
  getCandidateStats,
  listCandidates,
} from '../api/recruitment';
import type { CandidateFilters, CreateCandidateInput } from '../api/recruitment';
import { useRealtime } from '../realtime/RealtimeContext';
import { Empty, ErrorMessage, Loading, Modal, Pagination, formatDate } from '../components/ui';
import { Icon } from '../components/Icon';
import { StageBadge } from '../components/StageBadge';
import {
  CANDIDATE_STAGES,
  CANDIDATE_STAGE_LABELS,
  GENDER_OPTIONS,
  JAPANESE_LEVELS,
  MARKETS,
  MARKET_LABELS,
  VISA_TYPES,
  VISA_TYPE_LABELS,
  candidateStageLabel,
  marketLabel,
} from '../lib/recruitment';

const PAGE_LIMIT = 20;

export function Candidates() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { subscribe } = useRealtime();

  const [filters, setFilters] = useState<CandidateFilters>({ page: 1, limit: PAGE_LIMIT });
  const [pendingFilters, setPendingFilters] = useState<CandidateFilters>({});
  const [showCreate, setShowCreate] = useState(false);

  const candidatesQuery = useQuery({
    queryKey: ['candidates', filters],
    queryFn: () => listCandidates(filters),
  });

  const statsQuery = useQuery({
    queryKey: ['candidateStats', 'stage'],
    queryFn: () => getCandidateStats('stage'),
  });

  // Live-refresh the candidate list when a stage-change notification arrives.
  useEffect(() => {
    return subscribe((event) => {
      if (event.topic === 'notification' && event.type === 'candidate_stage_changed') {
        void queryClient.invalidateQueries({ queryKey: ['candidates'] });
        void queryClient.invalidateQueries({ queryKey: ['candidateStats'] });
      }
    });
  }, [subscribe, queryClient]);

  function applyFilters() {
    setFilters({ ...pendingFilters, page: 1, limit: PAGE_LIMIT });
  }

  function resetFilters() {
    setPendingFilters({});
    setFilters({ page: 1, limit: PAGE_LIMIT });
  }

  return (
    <div className="reveal">
      <div className="page-header">
        <div>
          <div className="eyebrow">CRM tuyển dụng</div>
          <h1 className="page-title">Ứng viên</h1>
        </div>
        <div className="row-actions">
          <button className="btn btn-primary btn-sm" onClick={() => setShowCreate(true)}>
            <Icon name="plus" size={16} />
            Ứng viên mới
          </button>
        </div>
      </div>

      {/* Stats by stage */}
      <div className="card">
        <h2 className="card-title">Ứng viên theo giai đoạn</h2>
        {statsQuery.isLoading ? (
          <Loading variant="kpi" cols={4} />
        ) : statsQuery.error ? (
          <ErrorMessage error={statsQuery.error} />
        ) : statsQuery.data && statsQuery.data.buckets.length > 0 ? (
          <div className="inline-list">
            {statsQuery.data.buckets.map((b) => (
              <span key={b.key} className="badge badge-blue">
                {b.key ? candidateStageLabel(b.key) : '(trống)'}: {b.count}
              </span>
            ))}
          </div>
        ) : (
          <div className="muted">Chưa có dữ liệu.</div>
        )}
      </div>

      {/* Filters */}
      <div className="toolbar">
        <div className="field">
          <label>Giai đoạn</label>
          <select
            value={pendingFilters.stage ?? ''}
            onChange={(e) => setPendingFilters((f) => ({ ...f, stage: e.target.value }))}
          >
            <option value="">Tất cả</option>
            {CANDIDATE_STAGES.map((s) => (
              <option key={s} value={s}>
                {CANDIDATE_STAGE_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Thị trường mong muốn</label>
          <select
            value={pendingFilters.desiredMarket ?? ''}
            onChange={(e) => setPendingFilters((f) => ({ ...f, desiredMarket: e.target.value }))}
          >
            <option value="">Tất cả</option>
            {MARKETS.map((m) => (
              <option key={m} value={m}>
                {MARKET_LABELS[m]}
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
        {candidatesQuery.isLoading ? (
          <Loading variant="table" rows={8} />
        ) : candidatesQuery.error ? (
          <ErrorMessage error={candidatesQuery.error} />
        ) : candidatesQuery.data && candidatesQuery.data.items.length > 0 ? (
          <>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Họ tên</th>
                    <th>Liên hệ</th>
                    <th>Thị trường</th>
                    <th>Ngành mong muốn</th>
                    <th>Giai đoạn</th>
                    <th>Ngày tạo</th>
                    <th>Thao tác</th>
                  </tr>
                </thead>
                <tbody>
                  {candidatesQuery.data.items.map((c) => (
                    <tr key={c.id}>
                      <td>{c.fullName}</td>
                      <td>
                        {c.phone ?? '—'}
                        {c.email ? <div className="muted">{c.email}</div> : null}
                      </td>
                      <td>{marketLabel(c.desiredMarket)}</td>
                      <td>{c.desiredIndustry || '—'}</td>
                      <td>
                        <StageBadge stage={c.stage} />
                      </td>
                      <td>{formatDate(c.createdAt)}</td>
                      <td>
                        <div className="row-actions">
                          <button
                            className="btn btn-sm"
                            onClick={() => navigate(`/candidates/${c.id}`)}
                          >
                            Chi tiết
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={candidatesQuery.data.page}
              limit={candidatesQuery.data.limit}
              total={candidatesQuery.data.total}
              onPage={(p) => setFilters((f) => ({ ...f, page: p }))}
            />
          </>
        ) : (
          <Empty
            icon="users"
            label="Không có ứng viên nào khớp bộ lọc."
            action={
              <button className="btn btn-primary btn-sm" onClick={() => setShowCreate(true)}>
                <Icon name="plus" size={16} />
                Ứng viên mới
              </button>
            }
          />
        )}
      </div>

      {showCreate && (
        <CreateCandidateModal
          onClose={() => setShowCreate(false)}
          onCreated={(id) => {
            setShowCreate(false);
            void queryClient.invalidateQueries({ queryKey: ['candidates'] });
            void queryClient.invalidateQueries({ queryKey: ['candidateStats'] });
            navigate(`/candidates/${id}`);
          }}
        />
      )}
    </div>
  );
}

function CreateCandidateModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [form, setForm] = useState<CreateCandidateInput>({
    fullName: '',
    phone: '',
    email: '',
    gender: '',
    desiredMarket: '',
    desiredIndustry: '',
    desiredVisaType: '',
    japaneseLevel: 'NONE',
    source: '',
  });

  const mutation = useMutation({
    mutationFn: () => {
      const payload: CreateCandidateInput = {
        ...form,
        // Send empty strings as undefined so backend defaults / optional enums apply.
        desiredMarket: form.desiredMarket ? form.desiredMarket : null,
        desiredVisaType: form.desiredVisaType ? form.desiredVisaType : null,
        phone: form.phone || null,
        email: form.email || null,
      };
      return createCandidate(payload);
    },
    onSuccess: (candidate) => onCreated(candidate.id),
  });

  function set<K extends keyof CreateCandidateInput>(key: K, value: CreateCandidateInput[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  return (
    <Modal title="Ứng viên mới" onClose={onClose}>
      {mutation.error != null && <ErrorMessage error={mutation.error} />}
      <div className="muted" style={{ marginBottom: 'var(--space-sm)' }}>
        Cần họ tên và ít nhất một thông tin liên hệ (điện thoại hoặc email).
      </div>
      <div className="grid grid-2">
        <div className="field">
          <label>Họ tên *</label>
          <input value={form.fullName ?? ''} onChange={(e) => set('fullName', e.target.value)} />
        </div>
        <div className="field">
          <label>Điện thoại</label>
          <input value={form.phone ?? ''} onChange={(e) => set('phone', e.target.value)} />
        </div>
        <div className="field">
          <label>Email</label>
          <input value={form.email ?? ''} onChange={(e) => set('email', e.target.value)} />
        </div>
        <div className="field">
          <label>Giới tính</label>
          <select value={form.gender ?? ''} onChange={(e) => set('gender', e.target.value)}>
            {GENDER_OPTIONS.map((g) => (
              <option key={g.value} value={g.value}>
                {g.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Ngày sinh</label>
          <input
            type="date"
            value={form.dob ?? ''}
            onChange={(e) => set('dob', e.target.value)}
          />
        </div>
        <div className="field">
          <label>Quê quán</label>
          <input value={form.hometown ?? ''} onChange={(e) => set('hometown', e.target.value)} />
        </div>
        <div className="field">
          <label>Học vấn</label>
          <input value={form.education ?? ''} onChange={(e) => set('education', e.target.value)} />
        </div>
        <div className="field">
          <label>Công việc hiện tại</label>
          <input
            value={form.currentJob ?? ''}
            onChange={(e) => set('currentJob', e.target.value)}
          />
        </div>
        <div className="field">
          <label>Thị trường mong muốn</label>
          <select
            value={form.desiredMarket ?? ''}
            onChange={(e) => set('desiredMarket', e.target.value)}
          >
            <option value="">— Chưa rõ —</option>
            {MARKETS.map((m) => (
              <option key={m} value={m}>
                {MARKET_LABELS[m]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Diện visa mong muốn</label>
          <select
            value={form.desiredVisaType ?? ''}
            onChange={(e) => set('desiredVisaType', e.target.value)}
          >
            <option value="">— Chưa rõ —</option>
            {VISA_TYPES.map((v) => (
              <option key={v} value={v}>
                {VISA_TYPE_LABELS[v]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Ngành mong muốn</label>
          <input
            value={form.desiredIndustry ?? ''}
            onChange={(e) => set('desiredIndustry', e.target.value)}
          />
        </div>
        <div className="field">
          <label>Trình độ tiếng Nhật</label>
          <select
            value={form.japaneseLevel ?? 'NONE'}
            onChange={(e) => set('japaneseLevel', e.target.value)}
          >
            {JAPANESE_LEVELS.map((l) => (
              <option key={l} value={l}>
                {l === 'NONE' ? 'Chưa có' : l}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Ngoại ngữ khác</label>
          <input
            value={form.otherLanguage ?? ''}
            onChange={(e) => set('otherLanguage', e.target.value)}
          />
        </div>
        <div className="field">
          <label>Nguồn</label>
          <input
            value={form.source ?? ''}
            onChange={(e) => set('source', e.target.value)}
            placeholder="facebook, giới thiệu…"
          />
        </div>
        <div className="field">
          <label>Người phụ trách (user id)</label>
          <input
            value={form.assignedTo ?? ''}
            onChange={(e) => set('assignedTo', e.target.value)}
          />
        </div>
      </div>
      <div className="field">
        <label>Ghi chú</label>
        <textarea value={form.note ?? ''} onChange={(e) => set('note', e.target.value)} />
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
          {mutation.isPending ? 'Đang tạo…' : 'Tạo'}
        </button>
      </div>
    </Modal>
  );
}
