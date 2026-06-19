/**
 * Drafts (Content Generation) — list drafts, generate new, view/edit, approve/
 * reject, and attach media.
 *
 * Endpoints: GET /api/generation/drafts, POST /api/generation/generate,
 * GET/PUT /api/generation/drafts/:id, DELETE (two-step),
 * POST /api/generation/drafts/:id/approve|reject, POST /api/media.
 *
 * Generation may return 502 when Gemini is not configured — handled cleanly.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  approveDraft,
  attachMedia,
  confirmDeleteDraft,
  editDraft,
  generateDraft,
  getDraft,
  listDrafts,
  rejectDraft,
} from '../api/generation';
import {
  Empty,
  ErrorMessage,
  Loading,
  Modal,
  Pagination,
  StatusBadge,
  SuccessMessage,
} from '../components/ui';
import { Icon } from '../components/Icon';
import { PersonaPicker } from '../components/PersonaPicker';

export function Drafts() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [showGenerate, setShowGenerate] = useState(false);
  const [openDraftId, setOpenDraftId] = useState<string | null>(null);

  const draftsQuery = useQuery({
    queryKey: ['drafts', page],
    queryFn: () => listDrafts(page, 20),
  });

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ['drafts'] });
  }

  return (
    <div className="reveal">
      <div className="page-header">
        <div>
          <div className="eyebrow">Nội dung</div>
          <h1 className="page-title">Bản nháp</h1>
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => setShowGenerate(true)}>
          <Icon name="plus" size={16} />
          Tạo bản nháp
        </button>
      </div>

      <div className="card">
        {draftsQuery.isLoading ? (
          <Loading variant="table" rows={6} />
        ) : draftsQuery.error ? (
          <ErrorMessage error={draftsQuery.error} />
        ) : draftsQuery.data && draftsQuery.data.items.length > 0 ? (
          <>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Tiêu đề</th>
                    <th>Trạng thái</th>
                    <th>Thao tác</th>
                  </tr>
                </thead>
                <tbody>
                  {draftsQuery.data.items.map((d) => (
                    <tr key={d.id}>
                      <td>{d.title || '(chưa có tiêu đề)'}</td>
                      <td>
                        <StatusBadge status={d.status} />
                      </td>
                      <td>
                        <button className="btn btn-sm" onClick={() => setOpenDraftId(d.id)}>
                          Mở
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={draftsQuery.data.page}
              limit={draftsQuery.data.limit}
              total={draftsQuery.data.total}
              onPage={setPage}
            />
          </>
        ) : (
          <Empty
            label="Chưa có bản nháp nào. Tạo một bản để bắt đầu."
            icon="file-text"
            action={
              <button className="btn btn-primary btn-sm" onClick={() => setShowGenerate(true)}>
                <Icon name="plus" size={16} />
                Tạo bản nháp
              </button>
            }
          />
        )}
      </div>

      {showGenerate && (
        <GenerateModal
          onClose={() => setShowGenerate(false)}
          onDone={() => {
            setShowGenerate(false);
            refresh();
          }}
        />
      )}

      {openDraftId && (
        <DraftDetailModal
          id={openDraftId}
          onClose={() => setOpenDraftId(null)}
          onChanged={refresh}
        />
      )}
    </div>
  );
}

function GenerateModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [domainName, setDomainName] = useState('');
  const [personaIds, setPersonaIds] = useState('');
  const [objective, setObjective] = useState('');

  const mutation = useMutation({
    mutationFn: () =>
      generateDraft({
        domainName,
        personaIds: personaIds
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        objective: objective || undefined,
      }),
    onSuccess: onDone,
  });

  return (
    <Modal title="Tạo bản nháp" onClose={onClose}>
      {mutation.error != null && <ErrorMessage error={mutation.error} />}
      <div className="field">
        <label>Lĩnh vực / ngành (bắt buộc)</label>
        <input value={domainName} onChange={(e) => setDomainName(e.target.value)} />
      </div>
      <div className="field">
        <label>Persona (đối tượng mục tiêu)</label>
        <input value={personaIds} onChange={(e) => setPersonaIds(e.target.value)} />
        <PersonaPicker value={personaIds} onChange={setPersonaIds} />
      </div>
      <div className="field">
        <label>Mục tiêu</label>
        <input value={objective} onChange={(e) => setObjective(e.target.value)} />
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Huỷ
        </button>
        <button
          className="btn btn-primary"
          disabled={!domainName || mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? 'Đang tạo…' : 'Tạo'}
        </button>
      </div>
    </Modal>
  );
}

function DraftDetailModal({
  id,
  onClose,
  onChanged,
}: {
  id: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['drafts', 'detail', id],
    queryFn: () => getDraft(id),
  });

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [ctas, setCtas] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [hydrated, setHydrated] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Hydrate edit fields once data arrives.
  if (data && !hydrated) {
    setTitle(data.title);
    setBody(data.body);
    setCtas(data.ctas.join(', '));
    setHydrated(true);
  }

  function invalidateDetail() {
    void queryClient.invalidateQueries({ queryKey: ['drafts', 'detail', id] });
    onChanged();
  }

  const editMutation = useMutation({
    mutationFn: () =>
      editDraft(id, {
        title,
        body,
        ctas: ctas
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      }),
    onSuccess: () => {
      setMessage('Đã lưu bản nháp.');
      invalidateDetail();
    },
  });

  const approveMutation = useMutation({
    mutationFn: () => approveDraft(id),
    onSuccess: () => {
      setMessage('Đã duyệt bản nháp.');
      invalidateDetail();
    },
  });

  const rejectMutation = useMutation({
    mutationFn: () => rejectDraft(id, rejectReason),
    onSuccess: () => {
      setMessage('Đã từ chối bản nháp.');
      invalidateDetail();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => confirmDeleteDraft(id),
    onSuccess: () => {
      onChanged();
      onClose();
    },
  });

  const mediaMutation = useMutation({
    mutationFn: (input: { filename: string; mimeType: string; contentBase64: string }) =>
      attachMedia({ draftId: id, ...input }),
    onSuccess: () => setMessage('Đã đính kèm media.'),
  });

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') return;
      const base64 = result.split(',')[1] ?? '';
      mediaMutation.mutate({ filename: file.name, mimeType: file.type, contentBase64: base64 });
    };
    reader.readAsDataURL(file);
  }

  const anyError =
    editMutation.error ??
    approveMutation.error ??
    rejectMutation.error ??
    deleteMutation.error ??
    mediaMutation.error;

  const editable = data?.status === 'DRAFT';

  return (
    <Modal title="Chi tiết bản nháp" onClose={onClose}>
      {isLoading ? (
        <Loading />
      ) : error ? (
        <ErrorMessage error={error} />
      ) : data ? (
        <>
          {message && <SuccessMessage>{message}</SuccessMessage>}
          {anyError != null && <ErrorMessage error={anyError} />}
          <div style={{ marginBottom: 'var(--space-sm)' }}>
            Trạng thái: <StatusBadge status={data.status} />
            {!editable && (
              <span className="muted"> · chỉ sửa được khi ở trạng thái nháp (DRAFT)</span>
            )}
          </div>
          <div className="field">
            <label>Tiêu đề</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} disabled={!editable} />
          </div>
          <div className="field">
            <label>Nội dung</label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              disabled={!editable}
              style={{ minHeight: 160 }}
            />
          </div>
          <div className="field">
            <label>Lời kêu gọi hành động (cách nhau bởi dấu phẩy)</label>
            <input value={ctas} onChange={(e) => setCtas(e.target.value)} disabled={!editable} />
          </div>

          <div className="field">
            <label>Đính kèm media</label>
            <input type="file" onChange={onFileChange} />
          </div>

          <div className="field">
            <label>Lý do từ chối</label>
            <input value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
          </div>

          <div className="modal-actions" style={{ flexWrap: 'wrap' }}>
            <button
              className="btn btn-danger btn-sm"
              disabled={deleteMutation.isPending}
              onClick={() => {
                if (window.confirm('Xoá vĩnh viễn bản nháp này?')) deleteMutation.mutate();
              }}
            >
              Xoá
            </button>
            <div className="topbar-spacer" />
            <button
              className="btn"
              disabled={!editable || editMutation.isPending}
              onClick={() => editMutation.mutate()}
            >
              {editMutation.isPending ? 'Đang lưu…' : 'Lưu'}
            </button>
            <button
              className="btn"
              disabled={!rejectReason || rejectMutation.isPending}
              onClick={() => rejectMutation.mutate()}
            >
              Từ chối
            </button>
            <button
              className="btn btn-primary"
              disabled={approveMutation.isPending}
              onClick={() => approveMutation.mutate()}
            >
              {approveMutation.isPending ? 'Đang duyệt…' : 'Duyệt'}
            </button>
          </div>
        </>
      ) : null}
    </Modal>
  );
}
