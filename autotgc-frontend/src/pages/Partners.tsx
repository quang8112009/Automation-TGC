/**
 * Partners (Đối tác & Điểm đến) — ADMIN management of cooperating partners
 * (đối tác đã hợp tác) and destination programs (nơi đưa đi XKLĐ + điều kiện cụ
 * thể). Two tabs share the page; each is a filterable list with a create/edit
 * modal. SALES is read-only (the backend also enforces this).
 *
 * Endpoints: /api/v1/partners*, /api/v1/destinations*.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createDestination,
  createPartner,
  listDestinations,
  listPartners,
  setDestinationActive,
  setPartnerStatus,
  updateDestination,
  updatePartner,
} from '../api/partners';
import type { DestinationInput, PartnerInput } from '../api/partners';
import { useAuth } from '../auth/AuthContext';
import { Empty, ErrorMessage, Loading, Modal } from '../components/ui';
import { Icon } from '../components/Icon';
import type { DestinationProgram, PartnerOrg } from '../lib/types';

const MARKETS = ['JAPAN', 'KOREA', 'GERMANY', 'TAIWAN', 'AUSTRALIA', 'USA', 'CANADA', 'UK', 'OTHER'];
const MARKET_LABEL: Record<string, string> = {
  JAPAN: 'Nhật Bản',
  KOREA: 'Hàn Quốc',
  GERMANY: 'Đức',
  TAIWAN: 'Đài Loan',
  AUSTRALIA: 'Úc',
  USA: 'Mỹ',
  CANADA: 'Canada',
  UK: 'Anh',
  OTHER: 'Khác',
};
const PARTNER_TYPES = ['EMPLOYER', 'SCHOOL', 'BROKER', 'SERVICE'];
const PARTNER_TYPE_LABEL: Record<string, string> = {
  EMPLOYER: 'Chủ sử dụng LĐ',
  SCHOOL: 'Trường / Đào tạo',
  BROKER: 'Môi giới',
  SERVICE: 'Dịch vụ',
};
const PARTNER_STATUSES = ['ACTIVE', 'PAUSED', 'ENDED'];
const DEST_STATUSES = ['OPEN', 'PAUSED', 'CLOSED'];

function marketLabel(c: string): string {
  return MARKET_LABEL[c] ?? (c || '—');
}

export function Partners() {
  const { role } = useAuth();
  const isAdmin = role === 'ADMIN';
  const [tab, setTab] = useState<'partners' | 'destinations'>('partners');

  return (
    <div className="reveal">
      <div className="page-header">
        <div>
          <div className="eyebrow">Mạng lưới hợp tác</div>
          <h1 className="page-title">Đối tác &amp; Điểm đến</h1>
        </div>
      </div>

      <div className="toolbar" role="tablist" aria-label="Phân loại">
        <button
          className={`btn btn-sm ${tab === 'partners' ? 'btn-primary' : ''}`}
          onClick={() => setTab('partners')}
        >
          <Icon name="users" size={16} /> Đối tác đã hợp tác
        </button>
        <button
          className={`btn btn-sm ${tab === 'destinations' ? 'btn-primary' : ''}`}
          onClick={() => setTab('destinations')}
        >
          <Icon name="compass" size={16} /> Điểm đến / Chương trình
        </button>
      </div>

      {tab === 'partners' ? (
        <PartnersTab isAdmin={isAdmin} />
      ) : (
        <DestinationsTab isAdmin={isAdmin} />
      )}
    </div>
  );
}

function PartnersTab({ isAdmin }: { isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const [typeFilter, setTypeFilter] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<PartnerOrg | null>(null);

  const q = useQuery({
    queryKey: ['partners', typeFilter],
    queryFn: () => listPartners({ type: typeFilter || undefined, limit: 100 }),
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => setPartnerStatus(id, status),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['partners'] }),
  });

  return (
    <div className="card">
      <div className="toolbar">
        <div className="field">
          <label>Loại đối tác</label>
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="">Tất cả</option>
            {PARTNER_TYPES.map((t) => (
              <option key={t} value={t}>
                {PARTNER_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </div>
        {isAdmin && (
          <button
            className="btn btn-primary btn-sm"
            style={{ marginLeft: 'auto' }}
            onClick={() => {
              setEditing(null);
              setShowForm(true);
            }}
          >
            <Icon name="plus" size={16} /> Đối tác mới
          </button>
        )}
      </div>

      {q.isLoading ? (
        <Loading label="Đang tải…" />
      ) : q.error ? (
        <ErrorMessage error={q.error} />
      ) : q.data && q.data.items.length > 0 ? (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Tên</th>
                <th>Loại</th>
                <th>Quốc gia</th>
                <th>Liên hệ</th>
                <th>Trạng thái</th>
                {isAdmin && <th>Thao tác</th>}
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td>{PARTNER_TYPE_LABEL[p.type] ?? p.type}</td>
                  <td>{marketLabel(p.country)}</td>
                  <td>{[p.contactName, p.phone].filter(Boolean).join(' · ') || '—'}</td>
                  <td>
                    <span className={`badge ${p.status === 'ACTIVE' ? 'badge-green' : 'badge-gray'}`}>
                      {p.status}
                    </span>
                  </td>
                  {isAdmin && (
                    <td>
                      <div className="row-actions">
                        <button className="btn btn-sm" onClick={() => { setEditing(p); setShowForm(true); }}>
                          Sửa
                        </button>
                        {p.status === 'ACTIVE' ? (
                          <button
                            className="btn btn-sm"
                            disabled={statusMutation.isPending}
                            onClick={() => statusMutation.mutate({ id: p.id, status: 'PAUSED' })}
                          >
                            Tạm dừng
                          </button>
                        ) : (
                          <button
                            className="btn btn-sm"
                            disabled={statusMutation.isPending}
                            onClick={() => statusMutation.mutate({ id: p.id, status: 'ACTIVE' })}
                          >
                            Kích hoạt
                          </button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty label="Chưa có đối tác nào." />
      )}

      {showForm && isAdmin && (
        <PartnerFormModal
          existing={editing}
          onClose={() => setShowForm(false)}
          onSaved={() => {
            setShowForm(false);
            void queryClient.invalidateQueries({ queryKey: ['partners'] });
          }}
        />
      )}
    </div>
  );
}

function PartnerFormModal({
  existing,
  onClose,
  onSaved,
}: {
  existing: PartnerOrg | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<PartnerInput>({
    name: existing?.name ?? '',
    type: existing?.type ?? 'EMPLOYER',
    country: existing?.country ?? 'JAPAN',
    contactName: existing?.contactName ?? '',
    phone: existing?.phone ?? '',
    email: existing?.email ?? '',
    status: existing?.status ?? 'ACTIVE',
    notes: existing?.notes ?? '',
  });
  const mutation = useMutation({
    mutationFn: () => (existing ? updatePartner(existing.id, form) : createPartner(form)),
    onSuccess: onSaved,
  });
  function set<K extends keyof PartnerInput>(k: K, v: PartnerInput[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }
  return (
    <Modal title={existing ? 'Sửa đối tác' : 'Đối tác mới'} onClose={onClose}>
      {mutation.error != null && <ErrorMessage error={mutation.error} />}
      <div className="field">
        <label>Tên đối tác *</label>
        <input value={form.name ?? ''} onChange={(e) => set('name', e.target.value)} />
      </div>
      <div className="grid grid-2">
        <div className="field">
          <label>Loại</label>
          <select value={form.type} onChange={(e) => set('type', e.target.value)}>
            {PARTNER_TYPES.map((t) => (
              <option key={t} value={t}>{PARTNER_TYPE_LABEL[t]}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Quốc gia</label>
          <select value={form.country} onChange={(e) => set('country', e.target.value)}>
            {MARKETS.map((m) => (
              <option key={m} value={m}>{MARKET_LABEL[m]}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Người liên hệ</label>
          <input value={form.contactName ?? ''} onChange={(e) => set('contactName', e.target.value)} />
        </div>
        <div className="field">
          <label>Điện thoại</label>
          <input value={form.phone ?? ''} onChange={(e) => set('phone', e.target.value)} />
        </div>
        <div className="field">
          <label>Email</label>
          <input value={form.email ?? ''} onChange={(e) => set('email', e.target.value)} />
        </div>
        {existing && (
          <div className="field">
            <label>Trạng thái</label>
            <select value={form.status} onChange={(e) => set('status', e.target.value)}>
              {PARTNER_STATUSES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
        )}
      </div>
      <div className="field">
        <label>Ghi chú</label>
        <textarea value={form.notes ?? ''} onChange={(e) => set('notes', e.target.value)} />
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Hủy</button>
        <button className="btn btn-primary" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
          {mutation.isPending ? 'Đang lưu…' : existing ? 'Lưu' : 'Tạo'}
        </button>
      </div>
    </Modal>
  );
}

function DestinationsTab({ isAdmin }: { isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const [countryFilter, setCountryFilter] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<DestinationProgram | null>(null);

  const q = useQuery({
    queryKey: ['destinations', countryFilter],
    queryFn: () => listDestinations({ country: countryFilter || undefined, limit: 100 }),
  });

  const activeMutation = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => setDestinationActive(id, active),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['destinations'] }),
  });

  function condList(v: unknown): string[] {
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  }

  return (
    <div className="card">
      <div className="toolbar">
        <div className="field">
          <label>Quốc gia</label>
          <select value={countryFilter} onChange={(e) => setCountryFilter(e.target.value)}>
            <option value="">Tất cả</option>
            {MARKETS.map((m) => (
              <option key={m} value={m}>{MARKET_LABEL[m]}</option>
            ))}
          </select>
        </div>
        {isAdmin && (
          <button
            className="btn btn-primary btn-sm"
            style={{ marginLeft: 'auto' }}
            onClick={() => { setEditing(null); setShowForm(true); }}
          >
            <Icon name="plus" size={16} /> Chương trình mới
          </button>
        )}
      </div>

      {q.isLoading ? (
        <Loading label="Đang tải…" />
      ) : q.error ? (
        <ErrorMessage error={q.error} />
      ) : q.data && q.data.items.length > 0 ? (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Chương trình</th>
                <th>Quốc gia</th>
                <th>Điều kiện</th>
                <th>Ngân sách (tr)</th>
                <th>Trạng thái</th>
                {isAdmin && <th>Thao tác</th>}
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((d) => (
                <tr key={d.id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{d.name}</div>
                    <div className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
                      {d.visaType || '—'} · {condList(d.industries).join(', ') || 'mọi ngành'}
                    </div>
                  </td>
                  <td>{marketLabel(d.country)}</td>
                  <td style={{ whiteSpace: 'normal', maxWidth: 280 }}>
                    {[
                      d.minAge || d.maxAge ? `Tuổi ${d.minAge ?? '?'}–${d.maxAge ?? '?'}` : null,
                      d.gender && d.gender !== 'ANY' ? d.gender : null,
                      d.requiredLanguage ? `${d.requiredLanguage} ${d.minLanguageLevel}`.trim() : null,
                      ...condList(d.conditions),
                    ]
                      .filter(Boolean)
                      .join(' · ') || '—'}
                  </td>
                  <td>
                    {d.budgetMinVndM != null || d.budgetMaxVndM != null
                      ? `${d.budgetMinVndM ?? '?'}–${d.budgetMaxVndM ?? '?'}`
                      : '—'}
                  </td>
                  <td>
                    <span className={`badge ${d.active && d.status === 'OPEN' ? 'badge-green' : 'badge-gray'}`}>
                      {d.active ? d.status : 'TẮT'}
                    </span>
                  </td>
                  {isAdmin && (
                    <td>
                      <div className="row-actions">
                        <button className="btn btn-sm" onClick={() => { setEditing(d); setShowForm(true); }}>
                          Sửa
                        </button>
                        <button
                          className="btn btn-sm"
                          disabled={activeMutation.isPending}
                          onClick={() => activeMutation.mutate({ id: d.id, active: !d.active })}
                        >
                          {d.active ? 'Tắt' : 'Bật'}
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty label="Chưa có chương trình điểm đến nào." />
      )}

      {showForm && isAdmin && (
        <DestinationFormModal
          existing={editing}
          onClose={() => setShowForm(false)}
          onSaved={() => {
            setShowForm(false);
            void queryClient.invalidateQueries({ queryKey: ['destinations'] });
          }}
        />
      )}
    </div>
  );
}

function DestinationFormModal({
  existing,
  onClose,
  onSaved,
}: {
  existing: DestinationProgram | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const condList = (v: unknown): string =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').join(', ') : '';

  const [form, setForm] = useState({
    name: existing?.name ?? '',
    country: existing?.country ?? 'JAPAN',
    visaType: existing?.visaType ?? '',
    gender: existing?.gender ?? 'ANY',
    minAge: existing?.minAge != null ? String(existing.minAge) : '',
    maxAge: existing?.maxAge != null ? String(existing.maxAge) : '',
    requiredLanguage: existing?.requiredLanguage ?? '',
    minLanguageLevel: existing?.minLanguageLevel ?? '',
    budgetMinVndM: existing?.budgetMinVndM != null ? String(existing.budgetMinVndM) : '',
    budgetMaxVndM: existing?.budgetMaxVndM != null ? String(existing.budgetMaxVndM) : '',
    industries: condList(existing?.industries),
    conditions: condList(existing?.conditions),
    status: existing?.status ?? 'OPEN',
  });

  const mutation = useMutation({
    mutationFn: () => {
      const num = (s: string): number | null => (s.trim() === '' ? null : Number(s));
      const csv = (s: string): string[] =>
        s.split(',').map((x) => x.trim()).filter((x) => x.length > 0);
      const payload: DestinationInput = {
        name: form.name,
        country: form.country,
        visaType: form.visaType,
        gender: form.gender,
        minAge: num(form.minAge),
        maxAge: num(form.maxAge),
        requiredLanguage: form.requiredLanguage,
        minLanguageLevel: form.minLanguageLevel,
        budgetMinVndM: num(form.budgetMinVndM),
        budgetMaxVndM: num(form.budgetMaxVndM),
        industries: csv(form.industries),
        conditions: csv(form.conditions),
        status: form.status,
      };
      return existing ? updateDestination(existing.id, payload) : createDestination(payload);
    },
    onSuccess: onSaved,
  });

  function set<K extends keyof typeof form>(k: K, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  return (
    <Modal title={existing ? 'Sửa chương trình' : 'Chương trình mới'} onClose={onClose}>
      {mutation.error != null && <ErrorMessage error={mutation.error} />}
      <div className="field">
        <label>Tên chương trình *</label>
        <input value={form.name} onChange={(e) => set('name', e.target.value)} />
      </div>
      <div className="grid grid-2">
        <div className="field">
          <label>Quốc gia *</label>
          <select value={form.country} onChange={(e) => set('country', e.target.value)}>
            {MARKETS.map((m) => (
              <option key={m} value={m}>{MARKET_LABEL[m]}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Diện visa / loại</label>
          <input value={form.visaType} onChange={(e) => set('visaType', e.target.value)} />
        </div>
        <div className="field">
          <label>Giới tính</label>
          <select value={form.gender} onChange={(e) => set('gender', e.target.value)}>
            <option value="ANY">Mọi giới tính</option>
            <option value="MALE">Nam</option>
            <option value="FEMALE">Nữ</option>
          </select>
        </div>
        <div className="field">
          <label>Trạng thái</label>
          <select value={form.status} onChange={(e) => set('status', e.target.value)}>
            {DEST_STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Tuổi tối thiểu</label>
          <input type="number" value={form.minAge} onChange={(e) => set('minAge', e.target.value)} />
        </div>
        <div className="field">
          <label>Tuổi tối đa</label>
          <input type="number" value={form.maxAge} onChange={(e) => set('maxAge', e.target.value)} />
        </div>
        <div className="field">
          <label>Ngôn ngữ yêu cầu</label>
          <input
            value={form.requiredLanguage}
            placeholder="japanese / english / german"
            onChange={(e) => set('requiredLanguage', e.target.value)}
          />
        </div>
        <div className="field">
          <label>Trình độ tối thiểu</label>
          <input
            value={form.minLanguageLevel}
            placeholder="N4 / IELTS5.5 / B1"
            onChange={(e) => set('minLanguageLevel', e.target.value)}
          />
        </div>
        <div className="field">
          <label>Ngân sách tối thiểu (triệu)</label>
          <input type="number" value={form.budgetMinVndM} onChange={(e) => set('budgetMinVndM', e.target.value)} />
        </div>
        <div className="field">
          <label>Ngân sách tối đa (triệu)</label>
          <input type="number" value={form.budgetMaxVndM} onChange={(e) => set('budgetMaxVndM', e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label>Ngành nghề (phân tách bằng dấu phẩy)</label>
        <input value={form.industries} placeholder="Cơ khí, Điều dưỡng" onChange={(e) => set('industries', e.target.value)} />
      </div>
      <div className="field">
        <label>Điều kiện khác (phân tách bằng dấu phẩy)</label>
        <textarea value={form.conditions} placeholder="Tốt nghiệp THPT, Sức khỏe loại 1-2" onChange={(e) => set('conditions', e.target.value)} />
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Hủy</button>
        <button className="btn btn-primary" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
          {mutation.isPending ? 'Đang lưu…' : existing ? 'Lưu' : 'Tạo'}
        </button>
      </div>
    </Modal>
  );
}
