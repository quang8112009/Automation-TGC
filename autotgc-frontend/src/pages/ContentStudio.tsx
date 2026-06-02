/**
 * ContentStudio (/content-studio, ADMIN) — a free-form multi-format content
 * generator. Choose a format (from GET /api/v1/generation/formats), a domain,
 * personas, objective, market, topic / keyword → generate → see the resulting
 * draft (title, body, CTAs). Optionally turn the produced draft into a brand
 * asset (render-ready SPEC) without leaving the page.
 *
 * Generation requires Gemini: a 502 surfaces cleanly as "Chưa cấu hình AI
 * (Gemini)" via the shared ErrorMessage (which special-cases 502).
 *
 * Endpoints: GET /api/v1/generation/formats, POST /api/v1/generation/multi-format,
 * POST /api/v1/assets/from-draft.
 */
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { createAssetFromDraft, generateMultiFormat, getFormats } from '../api/marketing';
import { AiGroundingBadge } from '../components/AiGroundingBadge';
import { Empty, ErrorMessage, Loading, SuccessMessage } from '../components/ui';
import { AssetSpecView } from '../components/AssetSpecView';
import {
  ASSET_KINDS,
  ASSET_KIND_LABELS,
  MARKETING_MARKETS,
  MARKETING_MARKET_LABELS,
  MARKETING_OBJECTIVES,
  MARKETING_OBJECTIVE_LABELS,
  contentFormatLabel,
} from '../lib/marketing';
import type { GeneratedAsset, MultiFormatResult } from '../lib/types';

export function ContentStudio() {
  const formatsQuery = useQuery({ queryKey: ['generationFormats'], queryFn: getFormats });

  const [format, setFormat] = useState('SEO_ARTICLE');
  const [domainName, setDomainName] = useState('');
  const [personaIds, setPersonaIds] = useState('');
  const [objective, setObjective] = useState('Lead');
  const [market, setMarket] = useState('JAPAN');
  const [topic, setTopic] = useState('');
  const [keyword, setKeyword] = useState('');
  const [seoKeywords, setSeoKeywords] = useState('');
  const [result, setResult] = useState<MultiFormatResult | null>(null);

  const formats = formatsQuery.data?.formats ?? [];
  const meta = formatsQuery.data?.meta ?? {};

  const generateMutation = useMutation({
    mutationFn: () =>
      generateMultiFormat({
        format,
        domainName: domainName.trim(),
        personaIds: personaIds
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        objective,
        market: market || undefined,
        topic: topic.trim() || undefined,
        keyword: keyword.trim() || undefined,
        seoKeywords: seoKeywords
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      }),
    onSuccess: (data) => setResult(data),
  });

  const canSubmit =
    domainName.trim().length > 0 && personaIds.trim().length > 0 && !generateMutation.isPending;

  function submit() {
    setResult(null);
    generateMutation.mutate();
  }

  return (
    <div className="reveal">
      <div className="page-header">
        <div>
          <div className="eyebrow">Nội dung</div>
          <h1 className="page-title">Xưởng nội dung</h1>
        </div>
      </div>

      <div className="card">
        <h2 className="card-title">Tạo nội dung đa định dạng</h2>
        <div className="muted" style={{ marginBottom: 12 }}>
          Chọn định dạng, nhập domain + persona, mục tiêu và thị trường, rồi để AI (Gemini) tạo nội
          dung. Nếu máy chủ chưa cấu hình AI, hệ thống sẽ báo “Chưa cấu hình AI (Gemini)”.
        </div>

        {formatsQuery.isLoading ? (
          <Loading label="Đang tải danh sách định dạng…" />
        ) : formatsQuery.error ? (
          <ErrorMessage error={formatsQuery.error} />
        ) : (
          <>
            <div className="grid grid-2">
              <div className="field">
                <label>Định dạng *</label>
                <select value={format} onChange={(e) => setFormat(e.target.value)}>
                  {formats.map((f) => (
                    <option key={f} value={f}>
                      {meta[f]?.label ?? contentFormatLabel(f)}
                    </option>
                  ))}
                </select>
                {meta[format]?.lengthHint && (
                  <div className="muted" style={{ marginTop: 4 }}>
                    {meta[format]?.lengthHint}
                  </div>
                )}
              </div>
              <div className="field">
                <label>Mục tiêu *</label>
                <select value={objective} onChange={(e) => setObjective(e.target.value)}>
                  {MARKETING_OBJECTIVES.map((o) => (
                    <option key={o} value={o}>
                      {MARKETING_OBJECTIVE_LABELS[o]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Domain *</label>
                <input
                  value={domainName}
                  onChange={(e) => setDomainName(e.target.value)}
                  placeholder="VD: thanhgiang.com.vn"
                />
              </div>
              <div className="field">
                <label>Persona IDs (phân tách bằng dấu phẩy) *</label>
                <input
                  value={personaIds}
                  onChange={(e) => setPersonaIds(e.target.value)}
                  placeholder="persona-id-1, persona-id-2"
                />
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
              <div className="field">
                <label>Từ khóa chính</label>
                <input value={keyword} onChange={(e) => setKeyword(e.target.value)} />
              </div>
            </div>
            <div className="field">
              <label>Chủ đề</label>
              <input
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="VD: Mức lương thực lãnh khi đi Nhật Bản"
              />
            </div>
            <div className="field">
              <label>Từ khóa SEO (phân tách bằng dấu phẩy)</label>
              <input
                value={seoKeywords}
                onChange={(e) => setSeoKeywords(e.target.value)}
                placeholder="xkld nhật, lương đi nhật"
              />
            </div>
            <button className="btn btn-primary" disabled={!canSubmit} onClick={submit}>
              {generateMutation.isPending ? 'Đang tạo nội dung…' : 'Tạo nội dung'}
            </button>
          </>
        )}
      </div>

      {generateMutation.error != null && <ErrorMessage error={generateMutation.error} />}

      {result != null && <DraftResult result={result} />}
    </div>
  );
}

function DraftResult({ result }: { result: MultiFormatResult }) {
  const draft = result.draft;
  const [assetKind, setAssetKind] = useState('infographic');
  const [asset, setAsset] = useState<GeneratedAsset | null>(null);

  const assetMutation = useMutation({
    mutationFn: () => createAssetFromDraft({ draftId: draft.id, kind: assetKind }),
    onSuccess: (data) => setAsset(data),
  });

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <h2 className="card-title" style={{ margin: 0 }}>
          {draft.title}
        </h2>
        <AiGroundingBadge aiGenerated={result.aiGenerated} />
        <span className="badge badge-gray">{contentFormatLabel(draft.format)}</span>
        {draft.generatedWithoutFeedback && (
          <span className="badge badge-yellow" title="Tạo khi chưa có đủ dữ liệu phân tích hiệu suất">
            Chưa có dữ liệu hiệu suất
          </span>
        )}
      </div>

      <pre className="code" style={{ whiteSpace: 'pre-wrap' }}>
        {draft.body}
      </pre>

      <h3 style={{ marginTop: 16 }}>Lời kêu gọi hành động (CTA)</h3>
      {draft.ctas.length === 0 ? (
        <Empty label="Không có CTA." />
      ) : (
        <ul>
          {draft.ctas.map((c) => (
            <li key={c.id}>{c.ctaText}</li>
          ))}
        </ul>
      )}

      <h3 style={{ marginTop: 16 }}>Tạo tài sản thương hiệu từ nháp này</h3>
      <div className="muted" style={{ marginBottom: 8 }}>
        Tài sản được trả về dưới dạng <strong>bản thiết kế (SPEC_READY)</strong> — chưa render thành
        ảnh/video khi máy chủ chưa cấu hình nhà cung cấp render.
      </div>
      <div className="toolbar">
        <div className="field">
          <label>Loại tài sản</label>
          <select value={assetKind} onChange={(e) => setAssetKind(e.target.value)}>
            {ASSET_KINDS.map((k) => (
              <option key={k} value={k}>
                {ASSET_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </div>
        <button
          className="btn btn--secondary"
          disabled={assetMutation.isPending}
          onClick={() => assetMutation.mutate()}
        >
          {assetMutation.isPending ? 'Đang tạo bản thiết kế…' : 'Tạo tài sản'}
        </button>
      </div>
      {assetMutation.error != null && <ErrorMessage error={assetMutation.error} />}
      {asset != null && (
        <>
          <SuccessMessage>Đã tạo bản thiết kế tài sản (trạng thái {asset.status}).</SuccessMessage>
          <AssetSpecView asset={asset} />
        </>
      )}
    </div>
  );
}
