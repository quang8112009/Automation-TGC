/**
 * Intake (Chatbot thu thập hồ sơ) — view conversations collected by the
 * omni-channel chatbot (Facebook Messenger + Zalo OA + website), inspect the
 * collected dossier + message thread, and a "Dùng thử" panel that drives the
 * SAME flow via the simulate endpoint so staff can preview the bot.
 *
 * Endpoints: /api/v1/intake/conversations*, /api/v1/intake/simulate.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getConversation, listConversations, simulateIntake } from '../api/intake';
import { Empty, ErrorMessage, Loading, formatDate } from '../components/ui';
import { Icon } from '../components/Icon';
import type { IntakeConversation, IntakeStatus } from '../lib/types';

const STATUS_LABEL: Record<IntakeStatus, string> = {
  ACTIVE: 'Đang thu thập',
  COMPLETED: 'Hoàn tất',
  HANDED_OFF: 'Đã chuyển NV',
  ABANDONED: 'Bỏ dở',
};
const STATUS_BADGE: Record<IntakeStatus, string> = {
  ACTIVE: 'badge-blue',
  COMPLETED: 'badge-green',
  HANDED_OFF: 'badge-yellow',
  ABANDONED: 'badge-gray',
};
const CHANNEL_LABEL: Record<string, string> = {
  FACEBOOK: 'Facebook',
  ZALO: 'Zalo',
  WEBSITE: 'Website',
};

export function Intake() {
  const [statusFilter, setStatusFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: ['intake', 'conversations', statusFilter],
    queryFn: () => listConversations(statusFilter || undefined, 1, 50),
  });

  return (
    <div className="reveal">
      <div className="page-header">
        <div>
          <div className="eyebrow">Tự động hóa</div>
          <h1 className="page-title">Chatbot thu thập hồ sơ</h1>
        </div>
      </div>

      <p className="muted" style={{ marginTop: 'calc(-1 * var(--space-sm))' }}>
        Chatbot tự hỏi khách trên Facebook / Zalo theo kịch bản hồ sơ, lưu câu trả lời về hệ thống
        và tạo Lead. Dưới đây là các hội thoại đã/đang thu thập.
      </p>

      <div className="grid grid-2">
        {/* Left: conversation list + simulate */}
        <div>
          <div className="card">
            <div className="toolbar">
              <div className="field" style={{ flex: 1 }}>
                <label>Trạng thái</label>
                <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                  <option value="">Tất cả</option>
                  {Object.keys(STATUS_LABEL).map((s) => (
                    <option key={s} value={s}>
                      {STATUS_LABEL[s as IntakeStatus]}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {listQuery.isLoading ? (
              <Loading variant="table" rows={6} />
            ) : listQuery.error ? (
              <ErrorMessage error={listQuery.error} />
            ) : listQuery.data && listQuery.data.items.length > 0 ? (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Kênh</th>
                      <th>Khách</th>
                      <th>Trạng thái</th>
                      <th>Cập nhật</th>
                    </tr>
                  </thead>
                  <tbody>
                    {listQuery.data.items.map((c) => (
                      <tr
                        key={c.id}
                        onClick={() => setSelectedId(c.id)}
                        aria-selected={selectedId === c.id}
                        style={{
                          cursor: 'pointer',
                          background: selectedId === c.id ? 'var(--surface-active)' : undefined,
                        }}
                      >
                        <td>{CHANNEL_LABEL[c.channel] ?? c.channel}</td>
                        <td>{c.displayName || c.externalUserId}</td>
                        <td>
                          <span className={`badge ${STATUS_BADGE[c.status]}`}>{STATUS_LABEL[c.status]}</span>
                        </td>
                        <td>{formatDate(c.updatedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty label="Chưa có hội thoại nào." icon="bot" />
            )}
          </div>

          <SimulatePanel onCompleted={() => listQuery.refetch()} />
        </div>

        {/* Right: conversation detail */}
        <div>
          {selectedId ? (
            <ConversationDetail id={selectedId} />
          ) : (
            <div className="card">
              <Empty label="Chọn một hội thoại để xem chi tiết hồ sơ + tin nhắn." icon="bot" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ConversationDetail({ id }: { id: string }) {
  const q = useQuery({
    queryKey: ['intake', 'conversation', id],
    queryFn: () => getConversation(id),
  });

  if (q.isLoading) return <div className="card"><Loading label="Đang tải hội thoại…" /></div>;
  if (q.error) return <div className="card"><ErrorMessage error={q.error} /></div>;
  const convo = q.data as IntakeConversation | null;
  if (!convo) return <div className="card"><Empty label="Không tìm thấy hội thoại." icon="bot" /></div>;

  const collected = convo.collected ?? {};
  const entries = Object.entries(collected);

  return (
    <div className="card">
      <h2 className="card-title">
        {convo.displayName || convo.externalUserId}{' '}
        <span className={`badge ${STATUS_BADGE[convo.status]}`}>{STATUS_LABEL[convo.status]}</span>
      </h2>

      <h3 style={{ fontSize: 'var(--fs-h3)', margin: 'var(--space-sm) 0' }}>Hồ sơ đã thu thập</h3>
      {entries.length === 0 ? (
        <div className="muted">Chưa có dữ liệu.</div>
      ) : (
        <dl className="kv">
          {entries.map(([k, v]) => (
            <div key={k} style={{ display: 'contents' }}>
              <dt>{k}</dt>
              <dd>{String(v)}</dd>
            </div>
          ))}
        </dl>
      )}
      {convo.leadId && (
        <div className="success-box" style={{ marginTop: 'var(--space-sm)' }}>
          Đã tạo Lead: <code>{convo.leadId}</code>
        </div>
      )}

      <h3 style={{ fontSize: 'var(--fs-h3)', margin: 'var(--space-md) 0 var(--space-sm)' }}>Tin nhắn</h3>
      <div className="steps-list">
        {(convo.messages ?? []).map((m) => (
          <div
            key={m.id}
            className="step-row"
            style={{
              flexDirection: 'column',
              alignItems: m.direction === 'OUTBOUND' ? 'flex-start' : 'flex-end',
            }}
          >
            <div className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
              {m.direction === 'OUTBOUND' ? 'Bot' : 'Khách'} · {formatDate(m.createdAt)}
            </div>
            <div
              style={{
                background:
                  m.direction === 'OUTBOUND' ? 'var(--surface-sunken)' : 'var(--color-gold-soft)',
                color: 'var(--text-body)',
                borderRadius: 'var(--radius-lg)',
                padding: 'var(--space-xs) var(--space-sm)',
                maxWidth: '85%',
                whiteSpace: 'pre-wrap',
              }}
            >
              {m.text}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SimulatePanel({ onCompleted }: { onCompleted: () => void }) {
  const queryClient = useQueryClient();
  const [userId] = useState(() => `demo-${Math.random().toString(36).slice(2, 8)}`);
  const [text, setText] = useState('');
  const [thread, setThread] = useState<Array<{ who: 'Khách' | 'Bot'; text: string }>>([]);

  const mutation = useMutation({
    mutationFn: (msg: string) => simulateIntake(userId, msg),
    onSuccess: (res, msg) => {
      setThread((prev) => [
        ...prev,
        { who: 'Khách', text: msg },
        ...(res.reply ? [{ who: 'Bot' as const, text: res.reply }] : []),
      ]);
      setText('');
      if (res.completed) {
        onCompleted();
        void queryClient.invalidateQueries({ queryKey: ['intake', 'conversations'] });
      }
    },
  });

  function send() {
    const t = text.trim();
    if (t.length === 0 || mutation.isPending) return;
    mutation.mutate(t);
  }

  return (
    <div className="card">
      <h2 className="card-title">Dùng thử chatbot</h2>
      <p className="muted">
        Mô phỏng một khách nhắn tin để xem bot hỏi gì và thu thập ra sao (dùng cùng luồng với kênh
        thật). Gõ "xin chào" để bắt đầu.
      </p>
      {mutation.error != null && <ErrorMessage error={mutation.error} />}
      <div className="steps-list" style={{ marginBottom: 'var(--space-sm)' }}>
        {thread.map((m, i) => (
          <div key={i} className="step-row" style={{ flexDirection: 'column', alignItems: m.who === 'Bot' ? 'flex-start' : 'flex-end' }}>
            <div className="muted" style={{ fontSize: 'var(--fs-xs)' }}>{m.who}</div>
            <div style={{ background: m.who === 'Bot' ? 'var(--surface-sunken)' : 'var(--color-gold-soft)', color: 'var(--text-body)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-xs) var(--space-sm)', maxWidth: '85%', whiteSpace: 'pre-wrap' }}>
              {m.text}
            </div>
          </div>
        ))}
      </div>
      <div className="toolbar">
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor="intake-simulate-input">Tin nhắn thử</label>
          <input
            id="intake-simulate-input"
            value={text}
            placeholder='VD: "xin chào" rồi trả lời từng câu hỏi'
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
          />
        </div>
        <button className="btn btn-primary" disabled={mutation.isPending || text.trim().length === 0} onClick={send}>
          <Icon name="send" size={16} /> {mutation.isPending ? 'Đang gửi…' : 'Gửi'}
        </button>
      </div>
    </div>
  );
}
