/**
 * AssetSpecView — render a GeneratedAsset's render-ready blueprint.
 *
 * HONESTY NOTE (mirrors the backend): when no render provider is configured,
 * assets are persisted with status SPEC_READY and provider 'none' — they are
 * NOT produced image/video files. We therefore display the SPEC (dimensions,
 * palette swatches, fonts, logo placement, and the resolved slot texts) clearly
 * and label it "Bản thiết kế (chưa render)" rather than expecting an image URL.
 * If a provider DID render it (status RENDERED with a storageKey), we surface
 * that instead.
 */
import { formatDate } from './ui';
import { assetKindLabel } from '../lib/marketing';
import type { GeneratedAsset, ResolvedRenderSpec, ResolvedSlot } from '../lib/types';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Tolerantly narrow the persisted Json `spec` into a ResolvedRenderSpec view. */
function parseSpec(spec: unknown): Partial<ResolvedRenderSpec> | null {
  if (!isRecord(spec)) return null;
  return spec as Partial<ResolvedRenderSpec>;
}

function Swatch({ label, color }: { label: string; color: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span
        style={{
          width: 20,
          height: 20,
          borderRadius: 4,
          border: '1px solid var(--border)',
          background: color,
          display: 'inline-block',
        }}
        title={color}
      />
      <span className="muted">
        {label}: <code>{color}</code>
      </span>
    </div>
  );
}

export function AssetSpecView({ asset }: { asset: GeneratedAsset }) {
  const rendered = asset.status === 'RENDERED' && asset.storageKey;
  const spec = parseSpec(asset.spec);
  const slots: ResolvedSlot[] = Array.isArray(spec?.slots)
    ? (spec?.slots as ResolvedSlot[]).filter((s) => isRecord(s))
    : [];
  const palette = spec?.palette;
  const fonts = spec?.fonts;
  const logo = spec?.logo;
  const dimensions = spec?.dimensions;

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        padding: 14,
        marginTop: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <strong>{assetKindLabel(asset.kind)}</strong>
        {rendered ? (
          <span className="badge badge-green">Đã render</span>
        ) : (
          <span className="badge badge-yellow" title="Bản thiết kế render-ready; chưa tạo file ảnh/video">
            Bản thiết kế (chưa render)
          </span>
        )}
        <span className="badge badge-gray">provider: {asset.provider}</span>
      </div>

      {rendered ? (
        <dl className="kv">
          <dt>Storage key</dt>
          <dd>
            <code>{asset.storageKey}</code>
          </dd>
          <dt>MIME</dt>
          <dd>{asset.mimeType ?? '—'}</dd>
        </dl>
      ) : (
        <>
          <dl className="kv">
            <dt>Kích thước</dt>
            <dd>
              {dimensions ? `${dimensions.width} × ${dimensions.height} px` : '—'}
            </dd>
            <dt>Font</dt>
            <dd>
              {fonts ? `Tiêu đề: ${fonts.heading} · Nội dung: ${fonts.body}` : '—'}
            </dd>
            <dt>Logo</dt>
            <dd>{logo ? `Vị trí: ${logo.position}${logo.url ? ` (${logo.url})` : ''}` : '—'}</dd>
            <dt>Tạo lúc</dt>
            <dd>{formatDate(asset.createdAt)}</dd>
          </dl>

          {palette && (
            <>
              <h4 style={{ margin: '12px 0 6px' }}>Bảng màu</h4>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                <Swatch label="Chính" color={palette.primary} />
                <Swatch label="Phụ" color={palette.secondary} />
                <Swatch label="Nền" color={palette.bg} />
                <Swatch label="Chữ" color={palette.text} />
              </div>
            </>
          )}

          <h4 style={{ margin: '12px 0 6px' }}>Khối nội dung (slots)</h4>
          {slots.length === 0 ? (
            <div className="muted">Không có slot nào trong bản thiết kế.</div>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Slot</th>
                    <th>Nội dung</th>
                  </tr>
                </thead>
                <tbody>
                  {slots.map((s, i) => (
                    <tr key={`${s.name}-${i}`}>
                      <td>{s.name}</td>
                      <td style={{ whiteSpace: 'normal' }}>{s.text || <span className="muted">(trống / chỉ hình)</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {asset.prompt && (
        <>
          <h4 style={{ margin: '12px 0 6px' }}>Mô tả (brief)</h4>
          <pre className="code" style={{ whiteSpace: 'pre-wrap' }}>
            {asset.prompt}
          </pre>
        </>
      )}
    </div>
  );
}
