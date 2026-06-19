/**
 * Strategy & Personas — create/edit personas, fetch AI recommendations, and a
 * simple calendar (month/week/day list) with reschedule.
 *
 * Endpoints: POST /api/strategy/persona, PUT /api/strategy/persona/:id,
 * GET /api/strategy/persona/:id/recommendations, GET /api/strategy/calendar,
 * PUT /api/strategy/calendar/:id/reschedule, GET /api/strategy/ai-context.
 *
 * Note: there is no "list personas" backend endpoint, so personas created in
 * this session are tracked locally to allow editing right after creation. AI
 * recommendations may return 502 when Gemini is not configured — surfaced
 * cleanly.
 */
import { useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createPersona,
  getAiContext,
  getCalendar,
  getRecommendations,
  listPersonas,
  reorderContentPlanItems,
  rescheduleCalendarItem,
  rescheduleContentPlanItem,
  updatePersona,
} from '../api/strategy';
import type { PersonaInput } from '../api/strategy';
import { getContentPlan, listContentPlans } from '../api/marketing';
import { ApiError } from '../lib/apiClient';
import {
  Empty,
  ErrorMessage,
  Loading,
  Modal,
  StatusBadge,
  SuccessMessage,
  formatDate,
} from '../components/ui';
import { Icon } from '../components/Icon';
import {
  PLAN_ITEM_STATUS_BADGE,
  channelLabel,
  contentFormatLabel,
  planItemStatusLabel,
} from '../lib/marketing';
import type {
  ContentPersona,
  ContentPlanItem,
  ContentPlanWithItems,
  PlanItemStatus,
} from '../lib/types';

type CalendarView = 'month' | 'week' | 'day';

const EMPTY_PERSONA: PersonaInput = {
  domainName: '',
  personaName: '',
  age: '',
  interests: '',
  targetNeeds: '',
  painPoints: '',
  toneOfVoice: '',
};

export function Strategy() {
  const queryClient = useQueryClient();
  const [sessionPersonas, setSessionPersonas] = useState<ContentPersona[]>([]);
  const [editing, setEditing] = useState<ContentPersona | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [recoDomain, setRecoDomain] = useState('');
  const [reco, setReco] = useState<PersonaInput | null>(null);

  const recommendMutation = useMutation({
    mutationFn: (domain: string) => getRecommendations(domain),
    onSuccess: (data) => {
      setReco({ ...EMPTY_PERSONA, domainName: recoDomain, ...data });
    },
  });

  const aiContextQuery = useQuery({
    queryKey: ['strategy', 'aiContext'],
    queryFn: getAiContext,
  });

  const personasQuery = useQuery({
    queryKey: ['strategy', 'personas'],
    queryFn: () => listPersonas(),
  });

  function onPersonaSaved(p: ContentPersona) {
    setSessionPersonas((prev) => {
      const idx = prev.findIndex((x) => x.id === p.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = p;
        return next;
      }
      return [p, ...prev];
    });
    setShowForm(false);
    setEditing(null);
    setReco(null);
    void queryClient.invalidateQueries({ queryKey: ['calendar'] });
    void queryClient.invalidateQueries({ queryKey: ['strategy', 'personas'] });
  }

  return (
    <div className="reveal">
      <div className="page-header">
        <div>
          <div className="eyebrow">Marketing AI</div>
          <h1 className="page-title">Chiến lược &amp; Persona</h1>
        </div>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => {
            setEditing(null);
            setReco(null);
            setShowForm(true);
          }}
        >
          <Icon name="plus" size={16} />
          Persona mới
        </button>
      </div>

      <div className="grid grid-2">
        {/* AI Recommendation */}
        <div className="card">
          <h2 className="card-title">Gợi ý Persona bằng AI</h2>
          <p className="muted">
            Yêu cầu AI đề xuất một persona cho lĩnh vực của bạn. Kết quả là một bản nháp có thể
            chỉnh sửa và lưu lại.
          </p>
          <div className="toolbar">
            <div className="field" style={{ flex: 1 }}>
              <label>Lĩnh vực / ngành</label>
              <input
                value={recoDomain}
                onChange={(e) => setRecoDomain(e.target.value)}
                placeholder="VD: mỹ phẩm hữu cơ"
              />
            </div>
            <button
              className="btn btn--secondary"
              disabled={!recoDomain || recommendMutation.isPending}
              onClick={() => recommendMutation.mutate(recoDomain)}
            >
              {recommendMutation.isPending ? 'Đang hỏi…' : 'Lấy gợi ý'}
            </button>
          </div>
          {recommendMutation.error != null && <ErrorMessage error={recommendMutation.error} />}
          {reco && (
            <div className="success-box">
              Đã có gợi ý.{' '}
              <button
                className="btn btn-sm"
                onClick={() => {
                  setEditing(null);
                  setShowForm(true);
                }}
              >
                Xem &amp; lưu
              </button>
            </div>
          )}
        </div>

        {/* AI Context read model */}
        <div className="card">
          <h2 className="card-title">Ngữ cảnh nhắc AI</h2>
          {aiContextQuery.isLoading ? (
            <Loading />
          ) : aiContextQuery.error ? (
            <ErrorMessage error={aiContextQuery.error} />
          ) : (
            <pre className="code">{JSON.stringify(aiContextQuery.data ?? {}, null, 2)}</pre>
          )}
        </div>
      </div>

      {/* Saved personas (from the backend list endpoint, merged with any created
          this session so a just-created persona shows immediately). */}
      <div className="card">
        <h2 className="card-title">Persona</h2>
        <p className="muted">
          Tất cả persona đã lưu trên mọi lĩnh vực. Persona vừa tạo hoặc sửa sẽ xuất hiện ngay tại
          đây. Sao chép <strong>Persona ID</strong> để dán vào Xưởng nội dung / Kế hoạch nội
          dung khi tạo nội dung.
        </p>
        {personasQuery.isLoading ? (
          <Loading variant="table" rows={4} />
        ) : personasQuery.error ? (
          <ErrorMessage error={personasQuery.error} />
        ) : (
          (() => {
            const saved = personasQuery.data?.items ?? [];
            // Merge saved + session personas, session entries win on id (freshest
            // edit), newest first by createdAt.
            const byId = new Map<string, ContentPersona>();
            for (const p of saved) byId.set(p.id, p);
            for (const p of sessionPersonas) byId.set(p.id, p);
            const personas = [...byId.values()].sort(
              (a, b) =>
                new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime(),
            );
            if (personas.length === 0) {
              return (
                <Empty
                  label="Chưa có persona nào. Tạo một persona để bắt đầu."
                  icon="users"
                  action={
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => {
                        setEditing(null);
                        setReco(null);
                        setShowForm(true);
                      }}
                    >
                      <Icon name="plus" size={16} />
                      Persona mới
                    </button>
                  }
                />
              );
            }
            return (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Persona ID</th>
                      <th>Tên</th>
                      <th>Tuổi</th>
                      <th>Giọng điệu</th>
                      <th>Nhu cầu</th>
                      <th>Thao tác</th>
                    </tr>
                  </thead>
                  <tbody>
                    {personas.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <PersonaIdCell id={p.id} />
                        </td>
                        <td>{p.personaName}</td>
                        <td>{p.age}</td>
                        <td>{p.toneOfVoice}</td>
                        <td>{p.targetNeeds}</td>
                        <td>
                          <button
                            className="btn btn-sm"
                            onClick={() => {
                              setEditing(p);
                              setReco(null);
                              setShowForm(true);
                            }}
                          >
                            Sửa
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })()
        )}
      </div>

      <CalendarSection />

      <ScheduleBoardSection />

      {showForm && (
        <PersonaFormModal
          existing={editing}
          initial={reco}
          onClose={() => {
            setShowForm(false);
            setEditing(null);
          }}
          onSaved={onPersonaSaved}
        />
      )}
    </div>
  );
}

/**
 * Persona ID cell: shows a shortened, monospaced id with a copy button so the
 * value can be pasted into the Content Studio / Content Plans "Persona IDs"
 * field. Copies the FULL id (not the truncated display) to the clipboard.
 */
function PersonaIdCell({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const short = id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;

  async function copy() {
    try {
      await navigator.clipboard.writeText(id);
    } catch {
      // Fallback for non-secure contexts where the Clipboard API is unavailable.
      const ta = document.createElement('textarea');
      ta.value = id;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } catch {
        /* ignore */
      }
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-xs)' }}>
      <code style={{ fontSize: 'var(--fs-xs)' }} title={id}>
        {short}
      </code>
      <button
        type="button"
        className="btn btn-sm"
        onClick={copy}
        title="Sao chép Persona ID"
        aria-label="Sao chép Persona ID"
      >
        <Icon name={copied ? 'check' : 'clipboard-list'} size={14} />
        {copied ? ' Đã chép' : ''}
      </button>
    </span>
  );
}

function PersonaFormModal({
  existing,
  initial,
  onClose,
  onSaved,
}: {
  existing: ContentPersona | null;
  initial: PersonaInput | null;
  onClose: () => void;
  onSaved: (p: ContentPersona) => void;
}) {
  const [form, setForm] = useState<PersonaInput>(() => {
    if (existing) {
      return {
        domainName: '',
        personaName: existing.personaName,
        age: existing.age,
        interests: existing.interests,
        targetNeeds: existing.targetNeeds,
        painPoints: existing.painPoints,
        toneOfVoice: existing.toneOfVoice,
      };
    }
    return initial ?? EMPTY_PERSONA;
  });

  const mutation = useMutation({
    mutationFn: () => {
      if (existing) {
        const { domainName: _ignored, ...rest } = form;
        void _ignored;
        return updatePersona(existing.id, rest);
      }
      return createPersona(form);
    },
    onSuccess: (p) => onSaved(p),
  });

  function set<K extends keyof PersonaInput>(key: K, value: PersonaInput[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  return (
    <Modal title={existing ? 'Sửa Persona' : 'Persona mới'} onClose={onClose}>
      {mutation.error != null && <ErrorMessage error={mutation.error} />}
      {!existing && (
        <div className="field">
          <label>Lĩnh vực / ngành (bắt buộc)</label>
          <input value={form.domainName ?? ''} onChange={(e) => set('domainName', e.target.value)} />
        </div>
      )}
      <div className="field">
        <label>Tên persona</label>
        <input value={form.personaName ?? ''} onChange={(e) => set('personaName', e.target.value)} />
      </div>
      <div className="grid grid-2">
        <div className="field">
          <label>Độ tuổi (bắt buộc)</label>
          <input value={form.age ?? ''} onChange={(e) => set('age', e.target.value)} />
        </div>
        <div className="field">
          <label>Giọng điệu (bắt buộc)</label>
          <input value={form.toneOfVoice ?? ''} onChange={(e) => set('toneOfVoice', e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label>Sở thích</label>
        <input value={form.interests ?? ''} onChange={(e) => set('interests', e.target.value)} />
      </div>
      <div className="field">
        <label>Nhu cầu mục tiêu (bắt buộc)</label>
        <textarea value={form.targetNeeds ?? ''} onChange={(e) => set('targetNeeds', e.target.value)} />
      </div>
      <div className="field">
        <label>Nỗi đau / vướng mắc (bắt buộc)</label>
        <textarea value={form.painPoints ?? ''} onChange={(e) => set('painPoints', e.target.value)} />
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
          {mutation.isPending ? 'Đang lưu…' : existing ? 'Lưu' : 'Tạo'}
        </button>
      </div>
    </Modal>
  );
}

function CalendarSection() {
  const queryClient = useQueryClient();
  const [view, setView] = useState<CalendarView>('month');
  const [date, setDate] = useState('');
  const [rescheduleId, setRescheduleId] = useState<string | null>(null);
  const [rescheduleAt, setRescheduleAt] = useState('');
  const [rescheduleMsg, setRescheduleMsg] = useState<string | null>(null);

  const calendarQuery = useQuery({
    queryKey: ['calendar', view, date],
    queryFn: () => getCalendar(view, date || undefined),
  });

  const rescheduleMutation = useMutation({
    mutationFn: (args: { id: string; at: string }) =>
      rescheduleCalendarItem(args.id, new Date(args.at).toISOString()),
    onSuccess: () => {
      setRescheduleMsg('Đã đổi lịch thành công.');
      setRescheduleId(null);
      setRescheduleAt('');
      void queryClient.invalidateQueries({ queryKey: ['calendar'] });
    },
  });

  return (
    <div className="card">
      <h2 className="card-title">Lịch nội dung</h2>
      <div className="toolbar">
        <div className="field">
          <label>Chế độ xem</label>
          <select value={view} onChange={(e) => setView(e.target.value as CalendarView)}>
            <option value="month">Tháng</option>
            <option value="week">Tuần</option>
            <option value="day">Ngày</option>
          </select>
        </div>
        <div className="field">
          <label>Ngày mốc</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
      </div>

      {rescheduleMsg && <SuccessMessage>{rescheduleMsg}</SuccessMessage>}

      {calendarQuery.isLoading ? (
        <Loading />
      ) : calendarQuery.error ? (
        <ErrorMessage error={calendarQuery.error} />
      ) : calendarQuery.data ? (
        <>
          {(calendarQuery.data.unavailable ?? []).length > 0 && (
            <div className="notice">
              Một số nguồn không khả dụng: {(calendarQuery.data.unavailable ?? []).join(', ')}
            </div>
          )}
          <div className="grid grid-2">
            <div>
              <h3>Bản nháp ({(calendarQuery.data.drafts ?? []).length})</h3>
              {(calendarQuery.data.drafts ?? []).length === 0 ? (
                <div className="muted">Không có bản nháp trong khoảng này.</div>
              ) : (
                <ul>
                  {(calendarQuery.data.drafts ?? []).map((d) => (
                    <li key={d.id}>
                      <span
                        className="conn-dot"
                        style={{ background: d.color, display: 'inline-block', marginRight: 'var(--space-xs)' }}
                      />
                      {d.title} <StatusBadge status={d.status} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h3>Bài đã lên lịch ({(calendarQuery.data.scheduledPosts ?? []).length})</h3>
              {(calendarQuery.data.scheduledPosts ?? []).length === 0 ? (
                <div className="muted">Không có bài đã lên lịch trong khoảng này.</div>
              ) : (
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Nền tảng</th>
                        <th>Thời gian</th>
                        <th>Trạng thái</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {(calendarQuery.data.scheduledPosts ?? []).map((p) => (
                        <tr key={p.id}>
                          <td>{p.platformLabel}</td>
                          <td>{formatDate(p.scheduledAt)}</td>
                          <td>
                            <StatusBadge status={p.status} />
                          </td>
                          <td>
                            {p.status === 'SCHEDULED' && (
                              <button
                                className="btn btn-sm"
                                onClick={() => {
                                  setRescheduleId(p.id);
                                  setRescheduleMsg(null);
                                }}
                              >
                                Đổi lịch
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </>
      ) : null}

      {rescheduleId && (
        <Modal title="Đổi lịch bài đăng" onClose={() => setRescheduleId(null)}>
          {rescheduleMutation.error != null && <ErrorMessage error={rescheduleMutation.error} />}
          <div className="field">
            <label>Thời gian mới (phải ở tương lai)</label>
            <input
              type="datetime-local"
              value={rescheduleAt}
              onChange={(e) => setRescheduleAt(e.target.value)}
            />
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={() => setRescheduleId(null)}>
              Huỷ
            </button>
            <button
              className="btn btn-primary"
              disabled={!rescheduleAt || rescheduleMutation.isPending}
              onClick={() => rescheduleMutation.mutate({ id: rescheduleId, at: rescheduleAt })}
            >
              {rescheduleMutation.isPending ? 'Đang lưu…' : 'Đổi lịch'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---- Schedule_Board (kéo–thả) ----------------------------------------------

/** Local YYYY-MM-DD key (calendar day, no timezone shift for display). */
function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function itemDayKey(item: ContentPlanItem): string | null {
  if (!item.targetDate) return null;
  const d = new Date(item.targetDate);
  return Number.isNaN(d.getTime()) ? null : dayKey(d);
}

/** Human label for a YYYY-MM-DD day key. */
function dayLabel(key: string): string {
  const d = new Date(`${key}T00:00:00`);
  if (Number.isNaN(d.getTime())) return key;
  return d.toLocaleDateString('vi-VN', { weekday: 'short', day: '2-digit', month: '2-digit' });
}

/** Vietnamese inline message for a drag-and-drop failure (400/409/403/404). */
function boardErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 409) {
      return 'Không thể đổi lịch: mục không ở trạng thái cho phép hoặc đã thay đổi (409).';
    }
    if (err.status === 400) return `Yêu cầu không hợp lệ (400): ${err.message}`;
    if (err.status === 403) return 'Bạn không có quyền kéo–thả lịch nội dung (403).';
    if (err.status === 404) return 'Không tìm thấy mục cần cập nhật (404).';
    return `${err.code}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Schedule_Board — kéo–thả các `ContentPlanItem` của một kế hoạch: thả sang cột
 * ngày khác để đổi `targetDate` (PUT /content-plan-items/:id/reschedule), thả
 * lên một mục khác để sắp lại thứ tự (POST /content-plans/:planId/reorder với
 * `orderedIds`). Dùng HTML5 Drag and Drop gốc (draggable/onDragStart/onDragOver/
 * onDrop) — không thêm thư viện DnD. Mọi cập nhật là lạc quan (optimistic) và tự
 * hoàn tác (rollback) khi backend trả lỗi.
 */
function ScheduleBoardSection() {
  const queryClient = useQueryClient();
  const [planId, setPlanId] = useState<string>('');
  const [boardError, setBoardError] = useState<string | null>(null);
  const [boardMsg, setBoardMsg] = useState<string | null>(null);
  const draggedId = useRef<string | null>(null);

  const plansQuery = useQuery({
    queryKey: ['scheduleBoard', 'plans'],
    queryFn: () => listContentPlans(),
  });

  const planKey = ['scheduleBoard', 'plan', planId] as const;
  const planQuery = useQuery({
    queryKey: planKey,
    queryFn: () => getContentPlan(planId),
    enabled: planId.length > 0,
  });

  function setCacheItems(updater: (items: ContentPlanItem[]) => ContentPlanItem[]) {
    queryClient.setQueryData<ContentPlanWithItems>(planKey, (old) =>
      old ? { ...old, items: updater(old.items) } : old,
    );
  }

  // Reschedule a single item to a new day (optimistic + rollback). (Req 9.1)
  const rescheduleMutation = useMutation({
    mutationFn: (vars: { id: string; targetDate: string }) =>
      rescheduleContentPlanItem(vars.id, vars.targetDate),
    onMutate: async (vars) => {
      setBoardError(null);
      setBoardMsg(null);
      await queryClient.cancelQueries({ queryKey: planKey });
      const previous = queryClient.getQueryData<ContentPlanWithItems>(planKey);
      setCacheItems((items) =>
        items.map((it) => (it.id === vars.id ? { ...it, targetDate: vars.targetDate } : it)),
      );
      return { previous };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(planKey, ctx.previous);
      setBoardError(boardErrorMessage(err));
    },
    onSuccess: () => setBoardMsg('Đã đổi ngày đăng cho mục nội dung.'),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: planKey }),
  });

  // Reorder the plan's items (optimistic + rollback). (Req 9.2)
  const reorderMutation = useMutation({
    mutationFn: (vars: { orderedIds: string[] }) =>
      reorderContentPlanItems(planId, vars.orderedIds),
    onMutate: async (vars) => {
      setBoardError(null);
      setBoardMsg(null);
      await queryClient.cancelQueries({ queryKey: planKey });
      const previous = queryClient.getQueryData<ContentPlanWithItems>(planKey);
      const rank = new Map(vars.orderedIds.map((id, i) => [id, i] as const));
      setCacheItems((items) =>
        items
          .map((it) => ({ ...it, orderIndex: rank.get(it.id) ?? it.orderIndex }))
          .sort((a, b) => a.orderIndex - b.orderIndex),
      );
      return { previous };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(planKey, ctx.previous);
      setBoardError(boardErrorMessage(err));
    },
    onSuccess: () => setBoardMsg('Đã lưu thứ tự mới của các mục nội dung.'),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: planKey }),
  });

  const plan = planQuery.data;
  const items = plan ? [...plan.items].sort((a, b) => a.orderIndex - b.orderIndex) : [];

  // Build the day columns spanning the plan period, unioned with any day a item
  // already sits on (capped so an over-wide period can't blow up the layout).
  const dayKeys: string[] = [];
  if (plan) {
    const seen = new Set<string>();
    const start = new Date(plan.periodFrom);
    const end = new Date(plan.periodTo);
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
      const cursor = new Date(start);
      cursor.setHours(0, 0, 0, 0);
      while (cursor <= end && dayKeys.length < 92) {
        const k = dayKey(cursor);
        if (!seen.has(k)) {
          seen.add(k);
          dayKeys.push(k);
        }
        cursor.setDate(cursor.getDate() + 1);
      }
    }
    for (const it of items) {
      const k = itemDayKey(it);
      if (k && !seen.has(k)) {
        seen.add(k);
        dayKeys.push(k);
      }
    }
    dayKeys.sort();
  }

  const unscheduled = items.filter((it) => itemDayKey(it) === null);

  function onItemDragStart(e: DragEvent, id: string) {
    draggedId.current = id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  }

  function onItemDragEnd() {
    draggedId.current = null;
  }

  // Drop on a day column (not on an item) → reschedule to that day. (Req 9.1)
  function onDayDrop(e: DragEvent, key: string) {
    e.preventDefault();
    const id = draggedId.current ?? e.dataTransfer.getData('text/plain');
    draggedId.current = null;
    if (!id) return;
    const item = items.find((it) => it.id === id);
    if (!item) return;
    if (itemDayKey(item) === key) return; // already on this day
    const targetDate = new Date(`${key}T00:00:00`).toISOString();
    rescheduleMutation.mutate({ id, targetDate });
  }

  // Drop on another item → reorder, placing the dragged item before the target.
  // (Req 9.2 — bảo toàn tập hợp, chỉ đổi thứ tự.)
  function onItemDrop(e: DragEvent, targetId: string) {
    e.preventDefault();
    e.stopPropagation();
    const id = draggedId.current ?? e.dataTransfer.getData('text/plain');
    draggedId.current = null;
    if (!id || id === targetId) return;
    const ids = items.map((it) => it.id).filter((x) => x !== id);
    const targetIdx = ids.indexOf(targetId);
    if (targetIdx === -1) ids.push(id);
    else ids.splice(targetIdx, 0, id);
    reorderMutation.mutate({ orderedIds: ids });
  }

  function allowDrop(e: DragEvent) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }

  function renderCard(item: ContentPlanItem) {
    const badge = PLAN_ITEM_STATUS_BADGE[item.status as PlanItemStatus] ?? 'badge-gray';
    return (
      <div
        key={item.id}
        draggable
        onDragStart={(e) => onItemDragStart(e, item.id)}
        onDragEnd={onItemDragEnd}
        onDragOver={allowDrop}
        onDrop={(e) => onItemDrop(e, item.id)}
        className="sb-card"
        style={{
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          padding: 'var(--space-sm)',
          marginBottom: 'var(--space-sm)',
          background: 'var(--surface)',
          cursor: 'grab',
        }}
        title="Kéo sang ngày khác để đổi lịch, hoặc thả lên một mục khác để sắp thứ tự"
      >
        <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 'var(--fw-semibold)' }}>
          {item.topic || item.keyword || '—'}
        </div>
        <div className="muted" style={{ fontSize: 'var(--fs-xs)', margin: 'var(--space-xs) 0' }}>
          {channelLabel(item.channel)} · {contentFormatLabel(item.format)}
        </div>
        <span className={`badge ${badge}`}>{planItemStatusLabel(item.status)}</span>
      </div>
    );
  }

  return (
    <div className="card">
      <h2 className="card-title">Bảng lịch nội dung (kéo–thả)</h2>
      <p className="muted">
        Chọn một kế hoạch nội dung, rồi kéo các mục sang cột ngày khác để đổi ngày đăng, hoặc thả
        lên một mục khác để sắp lại thứ tự. Thay đổi được lưu ngay; nếu lỗi sẽ tự hoàn tác.
      </p>

      <div className="toolbar">
        <div className="field" style={{ minWidth: 280 }}>
          <label>Kế hoạch nội dung</label>
          {plansQuery.isLoading ? (
            <Loading inline label="Đang tải kế hoạch…" />
          ) : plansQuery.error ? (
            <ErrorMessage error={plansQuery.error} />
          ) : (
            <select value={planId} onChange={(e) => setPlanId(e.target.value)}>
              <option value="">— Chọn kế hoạch —</option>
              {(plansQuery.data?.plans ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {boardError && <div className="error-box">{boardError}</div>}
      {boardMsg && !boardError && <SuccessMessage>{boardMsg}</SuccessMessage>}

      {planId === '' ? (
        <Empty label="Hãy chọn một kế hoạch để xem bảng lịch kéo–thả." icon="calendar-days" />
      ) : planQuery.isLoading ? (
        <Loading label="Đang tải mục nội dung…" />
      ) : planQuery.error ? (
        <ErrorMessage error={planQuery.error} />
      ) : plan && items.length === 0 ? (
        <Empty label="Kế hoạch này chưa có mục nội dung." />
      ) : plan ? (
        <div style={{ display: 'flex', gap: 'var(--space-md)', overflowX: 'auto', paddingBottom: 'var(--space-sm)' }}>
          {/* Cột "Chưa xếp ngày" cho các mục không có targetDate. */}
          <div
            onDragOver={allowDrop}
            className="sb-col"
            style={{ minWidth: 200, flex: '0 0 200px' }}
          >
            <h3 style={{ fontSize: 'var(--fs-sm)', margin: '0 0 var(--space-sm)' }}>Chưa xếp ngày</h3>
            <div
              onDragOver={allowDrop}
              style={{ minHeight: 60, padding: 'var(--space-xs)', borderRadius: 'var(--radius-lg)', background: 'var(--surface-sunken)' }}
            >
              {unscheduled.length === 0 ? (
                <div className="muted" style={{ fontSize: 'var(--fs-xs)', padding: 'var(--space-xs)' }}>
                  Không có mục.
                </div>
              ) : (
                unscheduled.map(renderCard)
              )}
            </div>
          </div>

          {dayKeys.map((key) => {
            const dayItems = items.filter((it) => itemDayKey(it) === key);
            return (
              <div key={key} className="sb-col" style={{ minWidth: 200, flex: '0 0 200px' }}>
                <h3 style={{ fontSize: 'var(--fs-sm)', margin: '0 0 var(--space-sm)' }}>{dayLabel(key)}</h3>
                <div
                  onDragOver={allowDrop}
                  onDrop={(e) => onDayDrop(e, key)}
                  style={{
                    minHeight: 60,
                    padding: 'var(--space-xs)',
                    borderRadius: 'var(--radius-lg)',
                    background: 'var(--surface-sunken)',
                  }}
                >
                  {dayItems.length === 0 ? (
                    <div className="muted" style={{ fontSize: 'var(--fs-xs)', padding: 'var(--space-xs)' }}>
                      Thả vào đây để xếp ngày {dayLabel(key)}.
                    </div>
                  ) : (
                    dayItems.map(renderCard)
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
