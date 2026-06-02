/**
 * FollowUps (Nuôi dưỡng 1-1) — behavior-based follow-up queue. Staff can scan
 * for drop-off conversations (im lặng >= 3 ngày), review the personalized
 * messages the AI queued, send the due ones, and cancel any that are no longer
 * relevant. Reachable by ADMIN + SALES (read); scan/send/cancel are writes.
 *
 * Endpoints: /api/v1/follow-ups*, /scan, /send-due, /:id/cancel.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  cancelFollowUp,
  listFollowUps,
  scanFollowUps,
  sendDueFollowUps,
} from '../api/studyAbroad';
import { Empty, ErrorMessage, Loading, SuccessMessage, formatDate } from '../components/ui';
import { Icon } from '../components/Icon';
import type { FollowUpStatus } from '../lib/types';

const STATUS_LABEL: Record<FollowUpStatus, string> = {
  PENDING: 'Chờ gửi',
  SENT: 'Đã gửi',
  SKIPPED: 'Bỏ qua',
  CANCELLED: 'Đã hủy',
};
const STATUS_BADGE: Record<FollowUpStatus, string> = {
  PENDING: 'badge-yellow',
  SENT: 'badge-green',
  SKIPPED: 'badge-gray',
  CANCELLED: 'badge-gray',
};
const CHANNEL_LABEL: Record<string, string> = {
  FACEBOOK: 'Facebook',
  ZALO: 'Zalo',
  WEBSITE: 'Website',
};

export function FollowUps() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ['followUps', statusFilter],
    queryFn: () => listFollowUps(statusFilter || undefined, 1, 100),
  });

  const scanMutation = useMutation({
    mutationFn: () => scanFollowUps(),
    onSuccess: (r) => {
      setMsg(`Đã quét: ${r.scanned} hội thoại, tạo mới ${r.queued} lời nhắc.`);
      void queryClient.invalidateQueries({ queryKey: ['followUps'] });
    },
  });

  const sendMutation = useMutation({
    mutationFn: () => sendDueFollowUps(),
    onSuccess: (r) => {
      setMsg(`Đã gửi: ${r.sent} · Lỗi: ${r.failed}.`);
      void queryClient.invalidateQueries({ queryKey: ['followUps'] });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: (id: string) => cancelFollowUp(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['followUps'] }),
  });

  return (
    <div className="reveal">
      <div className="page-header">
        <div>
          <div className="eyebrow">Tự động hóa</div>
          <h1 className="page-title">Nuôi dưỡng &amp; Theo dõi 1-1</h1>
        </div>
        <div className="row-actions">
          <button className="btn btn--secondary btn-sm" disabled={scanMutation.isPending} onClick={() => { setMsg(null); scanMutation.mutate(); }}>
            <Icon name="search" size={16} /> {scanMutation.isPending ? 'Đang quét…' : 'Quét drop-off'}
          </button>
          <button className="btn btn-primary btn-sm" disabled={sendMutation.isPending} onClick={() => { setMsg(null); sendMutation.mutate(); }}>
            <Icon name="send" size={16} /> {sendMutation.isPending ? 'Đang gửi…' : 'Gửi các lời nhắc đến hạn'}
          </button>
        </div>
      </div>

      <p className="muted" style={{ marginTop: -8 }}>
        Hệ thống tự phát hiện học sinh đã hỏi rồi im lặng (≥ 3 ngày) và soạn sẵn tin nhắn cá nhân
        hóa để nhắc khéo, tăng tỷ lệ chuyển đổi.
      </p>

      {msg && <SuccessMessage>{msg}</SuccessMessage>}
      {(scanMutation.error || sendMutation.error || cancelMutation.error) != null && (
        <ErrorMessage error={scanMutation.error ?? sendMutation.error ?? cancelMutation.error} />
      )}

      <div className="card">
        <div className="toolbar">
          <div className="field">
            <label>Trạng thái</label>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">Tất cả</option>
              {Object.keys(STATUS_LABEL).map((s) => (
                <option key={s} value={s}>{STATUS_LABEL[s as FollowUpStatus]}</option>
              ))}
            </select>
          </div>
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
                  <th>Kênh</th>
                  <th>Chủ đề</th>
                  <th>Tin nhắn</th>
                  <th>Trạng thái</th>
                  <th>Đến hạn</th>
                  <th>Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {q.data.items.map((t) => (
                  <tr key={t.id}>
                    <td>{CHANNEL_LABEL[t.channel] ?? t.channel}</td>
                    <td>{t.topic || '—'}</td>
                    <td style={{ whiteSpace: 'normal', maxWidth: 360 }}>{t.message}</td>
                    <td>
                      <span className={`badge ${STATUS_BADGE[t.status]}`}>{STATUS_LABEL[t.status]}</span>
                    </td>
                    <td>{formatDate(t.dueAt)}</td>
                    <td>
                      {t.status === 'PENDING' ? (
                        <button
                          className="btn btn-sm"
                          disabled={cancelMutation.isPending}
                          onClick={() => cancelMutation.mutate(t.id)}
                        >
                          Hủy
                        </button>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty label="Chưa có lời nhắc nào. Bấm 'Quét drop-off' để hệ thống tạo." icon="bell" />
        )}
      </div>
    </div>
  );
}
