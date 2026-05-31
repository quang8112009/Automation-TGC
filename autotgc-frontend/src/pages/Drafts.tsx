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
    <div>
      <div className="page-header">
        <h1 className="page-title">Drafts</h1>
        <button className="btn btn-primary btn-sm" onClick={() => setShowGenerate(true)}>
          <Icon name="plus" size={16} />
          Generate Draft
        </button>
      </div>

      <div className="card">
        {draftsQuery.isLoading ? (
          <Loading />
        ) : draftsQuery.error ? (
          <ErrorMessage error={draftsQuery.error} />
        ) : draftsQuery.data && draftsQuery.data.items.length > 0 ? (
          <>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {draftsQuery.data.items.map((d) => (
                    <tr key={d.id}>
                      <td>{d.title || '(untitled)'}</td>
                      <td>
                        <StatusBadge status={d.status} />
                      </td>
                      <td>
                        <button className="btn btn-sm" onClick={() => setOpenDraftId(d.id)}>
                          Open
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
          <Empty label="No drafts yet. Generate one to get started." />
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
    <Modal title="Generate Draft" onClose={onClose}>
      {mutation.error != null && <ErrorMessage error={mutation.error} />}
      <div className="field">
        <label>Domain name *</label>
        <input value={domainName} onChange={(e) => setDomainName(e.target.value)} />
      </div>
      <div className="field">
        <label>Persona IDs (comma-separated)</label>
        <input value={personaIds} onChange={(e) => setPersonaIds(e.target.value)} />
      </div>
      <div className="field">
        <label>Objective</label>
        <input value={objective} onChange={(e) => setObjective(e.target.value)} />
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn btn-primary"
          disabled={!domainName || mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? 'Generating…' : 'Generate'}
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
      setMessage('Draft saved.');
      invalidateDetail();
    },
  });

  const approveMutation = useMutation({
    mutationFn: () => approveDraft(id),
    onSuccess: () => {
      setMessage('Draft approved.');
      invalidateDetail();
    },
  });

  const rejectMutation = useMutation({
    mutationFn: () => rejectDraft(id, rejectReason),
    onSuccess: () => {
      setMessage('Draft rejected.');
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
    onSuccess: () => setMessage('Media attached.'),
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
    <Modal title="Draft Detail" onClose={onClose}>
      {isLoading ? (
        <Loading />
      ) : error ? (
        <ErrorMessage error={error} />
      ) : data ? (
        <>
          {message && <SuccessMessage>{message}</SuccessMessage>}
          {anyError != null && <ErrorMessage error={anyError} />}
          <div style={{ marginBottom: 10 }}>
            Status: <StatusBadge status={data.status} />
            {!editable && (
              <span className="muted"> · only DRAFT status is editable</span>
            )}
          </div>
          <div className="field">
            <label>Title</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} disabled={!editable} />
          </div>
          <div className="field">
            <label>Body</label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              disabled={!editable}
              style={{ minHeight: 160 }}
            />
          </div>
          <div className="field">
            <label>CTAs (comma-separated)</label>
            <input value={ctas} onChange={(e) => setCtas(e.target.value)} disabled={!editable} />
          </div>

          <div className="field">
            <label>Attach media</label>
            <input type="file" onChange={onFileChange} />
          </div>

          <div className="field">
            <label>Reject reason</label>
            <input value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
          </div>

          <div className="modal-actions" style={{ flexWrap: 'wrap' }}>
            <button
              className="btn btn-danger btn-sm"
              disabled={deleteMutation.isPending}
              onClick={() => {
                if (window.confirm('Delete this draft permanently?')) deleteMutation.mutate();
              }}
            >
              Delete
            </button>
            <div className="topbar-spacer" />
            <button
              className="btn"
              disabled={!editable || editMutation.isPending}
              onClick={() => editMutation.mutate()}
            >
              {editMutation.isPending ? 'Saving…' : 'Save'}
            </button>
            <button
              className="btn"
              disabled={!rejectReason || rejectMutation.isPending}
              onClick={() => rejectMutation.mutate()}
            >
              Reject
            </button>
            <button
              className="btn btn-primary"
              disabled={approveMutation.isPending}
              onClick={() => approveMutation.mutate()}
            >
              {approveMutation.isPending ? 'Approving…' : 'Approve'}
            </button>
          </div>
        </>
      ) : null}
    </Modal>
  );
}
