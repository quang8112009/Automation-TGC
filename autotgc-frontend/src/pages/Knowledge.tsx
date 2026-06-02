/**
 * Knowledge (/knowledge, ADMIN) — manage the curated knowledge base that grounds
 * the AI recruitment consultant. Lists entries (optionally filtered by category
 * / market) and supports create + edit via a modal.
 *
 * Endpoints: GET /api/v1/knowledge, POST /api/v1/knowledge,
 * PUT /api/v1/knowledge/:id.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createKnowledge, listKnowledge, updateKnowledge } from '../api/aiConsultant';
import type { KnowledgeInput } from '../api/aiConsultant';
import { Empty, ErrorMessage, Loading, Modal } from '../components/ui';
import { Icon } from '../components/Icon';
import { MARKETS, MARKET_LABELS, marketLabel } from '../lib/recruitment';
import type { KnowledgeEntry } from '../lib/types';

/** Known knowledge categories (free text on the backend; these are the seeds). */
const CATEGORIES = ['company', 'market', 'visa', 'industry', 'faq', 'process', 'branch'];

const CATEGORY_LABELS: Record<string, string> = {
  company: 'Công ty',
  market: 'Thị trường',
  visa: 'Diện visa',
  industry: 'Ngành nghề',
  faq: 'Hỏi đáp',
  process: 'Quy trình',
  branch: 'Chi nhánh',
};

function categoryLabel(value: string): string {
  return CATEGORY_LABELS[value] ?? value;
}

export function Knowledge() {
  const queryClient = useQueryClient();

  const [filters, setFilters] = useState<{ category?: string; market?: string }>({});
  const [pending, setPending] = useState<{ category?: string; market?: string }>({});
  const [showCreate, setShowCreate] = useState(false);
  const [editEntry, setEditEntry] = useState<KnowledgeEntry | null>(null);

  const knowledgeQuery = useQuery({
    queryKey: ['knowledge', filters],
    queryFn: () => listKnowledge(filters.category, filters.market),
  });

  function applyFilters() {
    setFilters({ ...pending });
  }

  function resetFilters() {
    setPending({});
    setFilters({});
  }

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ['knowledge'] });
  }

  return (
    <div className="reveal">
      <div className="page-header">
        <div>
          <div className="eyebrow">Nội dung</div>
          <h1 className="page-title">Cơ sở tri thức</h1>
        </div>
        <div className="row-actions">
          <button className="btn btn-primary btn-sm" onClick={() => setShowCreate(true)}>
            <Icon name="plus" size={16} />
            Nội dung mới
          </button>
        </div>
      </div>

      <div className="toolbar">
        <div className="field">
          <label>Danh mục</label>
          <select
            value={pending.category ?? ''}
            onChange={(e) => setPending((f) => ({ ...f, category: e.target.value }))}
          >
            <option value="">Tất cả</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {categoryLabel(c)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Thị trường</label>
          <select
            value={pending.market ?? ''}
            onChange={(e) => setPending((f) => ({ ...f, market: e.target.value }))}
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

      <div className="card">
        {knowledgeQuery.isLoading ? (
          <Loading label="Đang tải…" />
        ) : knowledgeQuery.error ? (
          <ErrorMessage error={knowledgeQuery.error} />
        ) : knowledgeQuery.data && knowledgeQuery.data.entries.length > 0 ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Danh mục</th>
                  <th>Tiêu đề</th>
                  <th>Nội dung</th>
                  <th>Thị trường</th>
                  <th>Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {knowledgeQuery.data.entries.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      <span className="badge badge-gray">{categoryLabel(entry.category)}</span>
                    </td>
                    <td>{entry.title}</td>
                    <td style={{ whiteSpace: 'normal', maxWidth: 360 }}>{entry.content}</td>
                    <td>{entry.market ? marketLabel(entry.market) : '—'}</td>
                    <td>
                      <button className="btn btn-sm" onClick={() => setEditEntry(entry)}>
                        Sửa
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty label="Chưa có nội dung tri thức nào." />
        )}
      </div>

      {showCreate && (
        <KnowledgeFormModal
          mode="create"
          onClose={() => setShowCreate(false)}
          onSaved={() => {
            setShowCreate(false);
            invalidate();
          }}
        />
      )}

      {editEntry && (
        <KnowledgeFormModal
          mode="edit"
          entry={editEntry}
          onClose={() => setEditEntry(null)}
          onSaved={() => {
            setEditEntry(null);
            invalidate();
          }}
        />
      )}
    </div>
  );
}

function KnowledgeFormModal({
  mode,
  entry,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit';
  entry?: KnowledgeEntry;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<KnowledgeInput>({
    category: entry?.category ?? 'faq',
    title: entry?.title ?? '',
    content: entry?.content ?? '',
    market: entry?.market ?? '',
    tags: entry?.tags ?? [],
  });
  const [tagsText, setTagsText] = useState((entry?.tags ?? []).join(', '));

  const mutation = useMutation({
    mutationFn: () => {
      const tags = tagsText
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      const payload: KnowledgeInput = {
        ...form,
        market: form.market ? form.market : null,
        tags,
      };
      return mode === 'create' ? createKnowledge(payload) : updateKnowledge(entry!.id, payload);
    },
    onSuccess: onSaved,
  });

  function set<K extends keyof KnowledgeInput>(key: K, value: KnowledgeInput[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  return (
    <Modal
      title={mode === 'create' ? 'Nội dung tri thức mới' : `Sửa — ${entry?.title}`}
      onClose={onClose}
    >
      {mutation.error != null && <ErrorMessage error={mutation.error} />}
      <div className="grid grid-2">
        <div className="field">
          <label>Danh mục *</label>
          <select value={form.category ?? 'faq'} onChange={(e) => set('category', e.target.value)}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {categoryLabel(c)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Thị trường (tùy chọn)</label>
          <select value={form.market ?? ''} onChange={(e) => set('market', e.target.value)}>
            <option value="">— Không gắn thị trường —</option>
            {MARKETS.map((m) => (
              <option key={m} value={m}>
                {MARKET_LABELS[m]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="field">
        <label>Tiêu đề *</label>
        <input value={form.title ?? ''} onChange={(e) => set('title', e.target.value)} />
      </div>
      <div className="field">
        <label>Nội dung *</label>
        <textarea value={form.content ?? ''} onChange={(e) => set('content', e.target.value)} />
      </div>
      <div className="field">
        <label>Thẻ (phân tách bằng dấu phẩy)</label>
        <input
          value={tagsText}
          onChange={(e) => setTagsText(e.target.value)}
          placeholder="visa, tokutei, điều dưỡng"
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
