/**
 * BrandAssets (/brand-assets, ADMIN) — manage brand templates (list / create by
 * kind) and a standalone asset generator (kind + copy) that displays the
 * returned render SPEC.
 *
 * HONESTY NOTE (mirrors the backend): a brand template only describes HOW an
 * asset should look (palette / fonts / logo / layout slots). The standalone
 * generator returns a GeneratedAsset with status SPEC_READY — a render-ready
 * blueprint, not a produced image/video — displayed via AssetSpecView and
 * labeled "Bản thiết kế (chưa render)".
 *
 * Endpoints: GET /api/v1/brand-templates, POST /api/v1/brand-templates,
 * POST /api/v1/brand-templates/:id/deactivate, POST /api/v1/assets/standalone.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createBrandTemplate,
  createStandaloneAsset,
  deactivateBrandTemplate,
  listBrandTemplates,
} from '../api/marketing';
import { AssetSpecView } from '../components/AssetSpecView';
import { Empty, ErrorMessage, Loading, Modal, SuccessMessage, formatDate } from '../components/ui';
import { Icon } from '../components/Icon';
import {
  ASSET_KINDS,
  ASSET_KIND_LABELS,
  MARKETING_MARKETS,
  MARKETING_MARKET_LABELS,
  TEMPLATE_KINDS,
  assetKindLabel,
} from '../lib/marketing';
import type { GeneratedAsset } from '../lib/types';

export function BrandAssets() {
  const [kindFilter, setKindFilter] = useState<string>('');

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Tài sản thương hiệu</h1>
      </div>

      <div className="grid grid-2">
        <BrandTemplatesPanel kindFilter={kindFilter} onKindFilter={setKindFilter} />
        <StandaloneAssetPanel />
      </div>
    </div>
  );
}

function BrandTemplatesPanel({
  kindFilter,
  onKindFilter,
}: {
  kindFilter: string;
  onKindFilter: (k: string) => void;
}) {
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);

  const templatesQuery = useQuery({
    queryKey: ['brandTemplates', kindFilter],
    queryFn: () => listBrandTemplates(kindFilter || undefined),
  });

  const deactivateMutation = useMutation({
    mutationFn: (id: string) => deactivateBrandTemplate(id),
    onSuccess: () => {
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: ['brandTemplates'] });
    },
    onError: (err) => setActionError(err),
  });

  const templates = templatesQuery.data?.items ?? [];

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 className="card-title" style={{ margin: 0 }}>
          Mẫu thương hiệu (brand templates)
        </h2>
          <button className="btn btn-primary btn-sm" onClick={() => setShowCreate(true)}>
            <Icon name="plus" size={16} />
            Mẫu mới
          </button>
      </div>

      <div className="field" style={{ marginTop: 12 }}>
        <label>Lọc theo loại</label>
        <select value={kindFilter} onChange={(e) => onKindFilter(e.target.value)}>
          <option value="">Tất cả</option>
          {TEMPLATE_KINDS.map((k) => (
            <option key={k} value={k}>
              {ASSET_KIND_LABELS[k]}
            </option>
          ))}
        </select>
      </div>

      {actionError != null && <ErrorMessage error={actionError} />}

      {templatesQuery.isLoading ? (
        <Loading label="Đang tải…" />
      ) : templatesQuery.error ? (
        <ErrorMessage error={templatesQuery.error} />
      ) : templates.length > 0 ? (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Tên</th>
                <th>Loại</th>
                <th>Hoạt động</th>
                <th>Tạo lúc</th>
                <th>Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {templates.map((tpl) => (
                <tr key={tpl.id}>
                  <td>{tpl.name}</td>
                  <td>{assetKindLabel(tpl.kind)}</td>
                  <td>
                    {tpl.active ? (
                      <span className="badge badge-green">Đang dùng</span>
                    ) : (
                      <span className="badge badge-gray">Đã tắt</span>
                    )}
                  </td>
                  <td>{formatDate(tpl.createdAt)}</td>
                  <td>
                    {tpl.active ? (
                      <button
                        className="btn btn-sm btn-danger"
                        disabled={deactivateMutation.isPending}
                        onClick={() => deactivateMutation.mutate(tpl.id)}
                      >
                        Tắt
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
        <Empty label="Chưa có mẫu thương hiệu nào." />
      )}

      {showCreate && (
        <CreateTemplateModal
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            void queryClient.invalidateQueries({ queryKey: ['brandTemplates'] });
          }}
        />
      )}
    </div>
  );
}

function CreateTemplateModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('poster');
  const [primary, setPrimary] = useState('#0B3D91');
  const [secondary, setSecondary] = useState('#F2A900');
  const [bg, setBg] = useState('#FFFFFF');
  const [text, setText] = useState('#1A1A1A');

  const mutation = useMutation({
    mutationFn: () =>
      createBrandTemplate({
        name: name.trim(),
        kind,
        // Send a partial spec; the backend normalizes/fills defaults.
        spec: { palette: { primary, secondary, bg, text } },
      }),
    onSuccess: () => onCreated(),
  });

  return (
    <Modal title="Tạo mẫu thương hiệu" onClose={onClose}>
      {mutation.error != null && <ErrorMessage error={mutation.error} />}
      <div className="grid grid-2">
        <div className="field">
          <label>Tên mẫu *</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="VD: poster-nhat-ban" />
        </div>
        <div className="field">
          <label>Loại *</label>
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {TEMPLATE_KINDS.map((k) => (
              <option key={k} value={k}>
                {ASSET_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Màu chính</label>
          <input type="color" value={primary} onChange={(e) => setPrimary(e.target.value)} />
        </div>
        <div className="field">
          <label>Màu phụ</label>
          <input type="color" value={secondary} onChange={(e) => setSecondary(e.target.value)} />
        </div>
        <div className="field">
          <label>Màu nền</label>
          <input type="color" value={bg} onChange={(e) => setBg(e.target.value)} />
        </div>
        <div className="field">
          <label>Màu chữ</label>
          <input type="color" value={text} onChange={(e) => setText(e.target.value)} />
        </div>
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Hủy
        </button>
        <button
          className="btn btn-primary"
          disabled={mutation.isPending || name.trim().length === 0}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? 'Đang tạo…' : 'Tạo mẫu'}
        </button>
      </div>
    </Modal>
  );
}

function StandaloneAssetPanel() {
  const [kind, setKind] = useState('poster');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [ctas, setCtas] = useState('');
  const [market, setMarket] = useState('JAPAN');
  const [asset, setAsset] = useState<GeneratedAsset | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      createStandaloneAsset({
        kind,
        title: title.trim(),
        body: body.trim(),
        ctas: ctas
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
        market: market || undefined,
      }),
    onSuccess: (data) => setAsset(data),
  });

  function submit() {
    setAsset(null);
    mutation.mutate();
  }

  return (
    <div className="card">
      <h2 className="card-title">Tạo tài sản độc lập</h2>
      <div className="muted" style={{ marginBottom: 12 }}>
        Nhập loại tài sản + nội dung; hệ thống trả về <strong>bản thiết kế render-ready</strong>{' '}
        (chưa render thành ảnh/video).
      </div>
      <div className="grid grid-2">
        <div className="field">
          <label>Loại tài sản *</label>
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {ASSET_KINDS.map((k) => (
              <option key={k} value={k}>
                {ASSET_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Thị trường</label>
          <select value={market} onChange={(e) => setMarket(e.target.value)}>
            {MARKETING_MARKETS.map((m) => (
              <option key={m} value={m}>
                {MARKETING_MARKET_LABELS[m]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="field">
        <label>Tiêu đề (headline) *</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="field">
        <label>Nội dung (body)</label>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} />
      </div>
      <div className="field">
        <label>CTA (mỗi dòng một CTA)</label>
        <textarea value={ctas} onChange={(e) => setCtas(e.target.value)} placeholder="Liên hệ Thanh Giang để được tư vấn" />
      </div>
      <button
        className="btn btn-primary"
        disabled={mutation.isPending || title.trim().length === 0}
        onClick={submit}
      >
        {mutation.isPending ? 'Đang tạo bản thiết kế…' : 'Tạo tài sản'}
      </button>

      {mutation.error != null && <ErrorMessage error={mutation.error} />}
      {asset != null && (
        <>
          <SuccessMessage>Đã tạo bản thiết kế tài sản (trạng thái {asset.status}).</SuccessMessage>
          <AssetSpecView asset={asset} />
        </>
      )}
    </div>
  );
}
