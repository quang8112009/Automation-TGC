/**
 * ContentPlans (/content-plans, ADMIN) — market content planning (kế hoạch nội
 * dung). Create a plan (market, objective, period, channel multi-select), list
 * plans, open one to see its items (channel / format / topic / target date /
 * status), activate / archive it, and generate content per item via the
 * multi-format generator (then mark the item GENERATED).
 *
 * Planning is deterministic on the backend (Gemini-optional), so creating a
 * plan always works. Per-item generation needs Gemini: a 502 surfaces as
 * "Chưa cấu hình AI (Gemini)" through the shared ErrorMessage.
 *
 * Endpoints: POST /api/v1/content-plans, GET /api/v1/content-plans,
 * GET /api/v1/content-plans/:id, POST .../activate, POST .../archive,
 * GET .../items, POST /api/v1/content-plans/items/:itemId/mark,
 * POST /api/v1/generation/multi-format.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  activateContentPlan,
  archiveContentPlan,
  createContentPlan,
  generateMultiFormat,
  getContentPlan,
  listContentPlans,
  markPlanItem,
} from '../api/marketing';
import type { CreateContentPlanInput } from '../api/marketing';
import {
  Empty,
  ErrorMessage,
  Loading,
  Modal,
  SuccessMessage,
  formatDate,
} from '../components/ui';
import { Icon } from '../components/Icon';
import {
  MARKETING_CHANNELS,
  MARKETING_CHANNEL_LABELS,
  MARKETING_MARKETS,
  MARKETING_MARKET_LABELS,
  MARKETING_OBJECTIVES,
  MARKETING_OBJECTIVE_LABELS,
  PLAN_ITEM_STATUS_BADGE,
  PLAN_STATUSES,
  PLAN_STATUS_BADGE,
  PLAN_STATUS_LABELS,
  channelLabel,
  contentFormatLabel,
  marketingMarketLabel,
  objectiveLabel,
  planItemStatusLabel,
  planStatusLabel,
} from '../lib/marketing';
import type { ContentPlanItem, PlanItemStatus, PlanStatus } from '../lib/types';

function PlanStatusBadge({ status }: { status: string }) {
  const cls = PLAN_STATUS_BADGE[status as PlanStatus] ?? 'badge-gray';
  return <span className={`badge ${cls}`}>{planStatusLabel(status)}</span>;
}

function PlanItemStatusBadge({ status }: { status: string }) {
  const cls = PLAN_ITEM_STATUS_BADGE[status as PlanItemStatus] ?? 'badge-gray';
  return <span className={`badge ${cls}`}>{planItemStatusLabel(status)}</span>;
}

export function ContentPlans() {
  const queryClient = useQueryClient();
  const [marketFilter, setMarketFilter] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [showCreate, setShowCreate] = useState(false);
  const [openPlanId, setOpenPlanId] = useState<string | null>(null);

  const plansQuery = useQuery({
    queryKey: ['contentPlans', marketFilter, statusFilter],
    queryFn: () => listContentPlans(marketFilter || undefined, statusFilter || undefined),
  });

  const plans = plansQuery.data?.plans ?? [];

  return (
    <div className="reveal">
      <div className="page-header">
        <div>
          <div className="eyebrow">Nội dung</div>
          <h1 className="page-title">Kế hoạch nội dung</h1>
        </div>
        <div className="row-actions">
          <button className="btn btn-primary btn-sm" onClick={() => setShowCreate(true)}>
            <Icon name="plus" size={16} />
            Kế hoạch mới
          </button>
        </div>
      </div>

      <div className="toolbar">
        <div className="field">
          <label>Thị trường</label>
          <select value={marketFilter} onChange={(e) => setMarketFilter(e.target.value)}>
            <option value="">Tất cả</option>
            {MARKETING_MARKETS.map((m) => (
              <option key={m} value={m}>
                {MARKETING_MARKET_LABELS[m]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Trạng thái</label>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">Tất cả</option>
            {PLAN_STATUSES.map((s) => (
              <option key={s} value={s}>
                {PLAN_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="card">
        {plansQuery.isLoading ? (
          <Loading label="Đang tải…" />
        ) : plansQuery.error ? (
          <ErrorMessage error={plansQuery.error} />
        ) : plans.length > 0 ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Tiêu đề</th>
                  <th>Thị trường</th>
                  <th>Mục tiêu</th>
                  <th>Giai đoạn</th>
                  <th>Trạng thái</th>
                  <th>Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {plans.map((p) => (
                  <tr key={p.id}>
                    <td style={{ whiteSpace: 'normal', maxWidth: 300 }}>{p.title}</td>
                    <td>{marketingMarketLabel(p.market)}</td>
                    <td>{objectiveLabel(p.objective)}</td>
                    <td>
                      {formatDate(p.periodFrom)} → {formatDate(p.periodTo)}
                    </td>
                    <td>
                      <PlanStatusBadge status={p.status} />
                    </td>
                    <td>
                      <button className="btn btn-sm" onClick={() => setOpenPlanId(p.id)}>
                        Mở
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty label="Chưa có kế hoạch nội dung nào. Hãy tạo kế hoạch mới." />
        )}
      </div>

      {showCreate && (
        <CreatePlanModal
          onClose={() => setShowCreate(false)}
          onCreated={(planId) => {
            setShowCreate(false);
            void queryClient.invalidateQueries({ queryKey: ['contentPlans'] });
            setOpenPlanId(planId);
          }}
        />
      )}

      {openPlanId && <PlanDetail planId={openPlanId} onClose={() => setOpenPlanId(null)} />}
    </div>
  );
}

function CreatePlanModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (planId: string) => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [market, setMarket] = useState('JAPAN');
  const [objective, setObjective] = useState('Lead');
  const [periodFrom, setPeriodFrom] = useState(today);
  const [periodTo, setPeriodTo] = useState(today);
  const [channels, setChannels] = useState<Record<string, boolean>>({});

  const mutation = useMutation({
    mutationFn: () => {
      const selected = MARKETING_CHANNELS.filter((c) => channels[c]);
      const input: CreateContentPlanInput = {
        market,
        objective,
        periodFrom: new Date(periodFrom).toISOString(),
        periodTo: new Date(periodTo).toISOString(),
        channels: selected.length > 0 ? selected : undefined,
      };
      return createContentPlan(input);
    },
    onSuccess: (plan) => onCreated(plan.id),
  });

  return (
    <Modal title="Tạo kế hoạch nội dung" onClose={onClose}>
      {mutation.error != null && <ErrorMessage error={mutation.error} />}
      <div className="grid grid-2">
        <div className="field">
          <label>Thị trường *</label>
          <select value={market} onChange={(e) => setMarket(e.target.value)}>
            {MARKETING_MARKETS.map((m) => (
              <option key={m} value={m}>
                {MARKETING_MARKET_LABELS[m]}
              </option>
            ))}
          </select>
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
          <label>Từ ngày *</label>
          <input type="date" value={periodFrom} onChange={(e) => setPeriodFrom(e.target.value)} />
        </div>
        <div className="field">
          <label>Đến ngày *</label>
          <input type="date" value={periodTo} onChange={(e) => setPeriodTo(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label>Kênh phân phối (bỏ trống = tất cả kênh)</label>
        <div className="inline-list">
          {MARKETING_CHANNELS.map((c) => (
            <label
              key={c}
              style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0, minWidth: 120 }}
            >
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                checked={!!channels[c]}
                onChange={(e) => setChannels((s) => ({ ...s, [c]: e.target.checked }))}
              />
              {MARKETING_CHANNEL_LABELS[c]}
            </label>
          ))}
        </div>
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
          {mutation.isPending ? 'Đang tạo…' : 'Tạo kế hoạch'}
        </button>
      </div>
    </Modal>
  );
}

function PlanDetail({ planId, onClose }: { planId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<unknown>(null);

  const planQuery = useQuery({
    queryKey: ['contentPlan', planId],
    queryFn: () => getContentPlan(planId),
  });

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ['contentPlan', planId] });
    void queryClient.invalidateQueries({ queryKey: ['contentPlans'] });
  }

  const activateMutation = useMutation({
    mutationFn: () => activateContentPlan(planId),
    onSuccess: () => {
      setActionError(null);
      invalidate();
    },
    onError: (err) => setActionError(err),
  });

  const archiveMutation = useMutation({
    mutationFn: () => archiveContentPlan(planId),
    onSuccess: () => {
      setActionError(null);
      invalidate();
    },
    onError: (err) => setActionError(err),
  });

  const plan = planQuery.data;

  return (
    <Modal title={plan ? plan.title : 'Kế hoạch nội dung'} onClose={onClose}>
      {planQuery.isLoading ? (
        <Loading label="Đang tải…" />
      ) : planQuery.error ? (
        <ErrorMessage error={planQuery.error} />
      ) : plan ? (
        <>
          {actionError != null && <ErrorMessage error={actionError} />}
          <dl className="kv">
            <dt>Thị trường</dt>
            <dd>{marketingMarketLabel(plan.market)}</dd>
            <dt>Mục tiêu</dt>
            <dd>{objectiveLabel(plan.objective)}</dd>
            <dt>Giai đoạn</dt>
            <dd>
              {formatDate(plan.periodFrom)} → {formatDate(plan.periodTo)}
            </dd>
            <dt>Trạng thái</dt>
            <dd>
              <span className={`badge ${PLAN_STATUS_BADGE[plan.status] ?? 'badge-gray'}`}>
                {planStatusLabel(plan.status)}
              </span>
            </dd>
          </dl>

          <div className="row-actions" style={{ margin: '12px 0' }}>
            <button
              className="btn btn-primary btn-sm"
              disabled={plan.status !== 'DRAFT' || activateMutation.isPending}
              onClick={() => activateMutation.mutate()}
            >
              Kích hoạt
            </button>
            <button
              className="btn btn-sm"
              disabled={plan.status === 'ARCHIVED' || archiveMutation.isPending}
              onClick={() => archiveMutation.mutate()}
            >
              Lưu trữ
            </button>
          </div>

          <h3>Mục nội dung ({plan.items.length})</h3>
          {plan.items.length === 0 ? (
            <Empty label="Kế hoạch này chưa có mục nội dung." />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Kênh</th>
                    <th>Định dạng</th>
                    <th>Chủ đề</th>
                    <th>Ngày mục tiêu</th>
                    <th>Trạng thái</th>
                    <th>Thao tác</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.items.map((item) => (
                    <PlanItemRow
                      key={item.id}
                      item={item}
                      market={plan.market}
                      onChanged={invalidate}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Đóng
        </button>
      </div>
    </Modal>
  );
}

function PlanItemRow({
  item,
  market,
  onChanged,
}: {
  item: ContentPlanItem;
  market: string;
  onChanged: () => void;
}) {
  const [showGen, setShowGen] = useState(false);
  return (
    <>
      <tr>
        <td>{item.orderIndex + 1}</td>
        <td>{channelLabel(item.channel)}</td>
        <td>{contentFormatLabel(item.format)}</td>
        <td style={{ whiteSpace: 'normal', maxWidth: 260 }}>{item.topic || item.keyword || '—'}</td>
        <td>{item.targetDate ? formatDate(item.targetDate) : '—'}</td>
        <td>
          <PlanItemStatusBadge status={item.status} />
        </td>
        <td>
          <button className="btn btn-sm btn--secondary" onClick={() => setShowGen(true)}>
            Tạo nội dung
          </button>
        </td>
      </tr>
      {showGen && (
        <tr>
          <td colSpan={7} style={{ background: 'var(--surface-sunken)' }}>
            <GenerateForItem
              item={item}
              market={market}
              onClose={() => setShowGen(false)}
              onGenerated={onChanged}
            />
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * Inline per-item generator: calls multi-format gen with the item's format /
 * topic / keyword, then marks the item GENERATED with the produced draftId.
 * Domain + persona are required by the generator, so we collect them here.
 */
function GenerateForItem({
  item,
  market,
  onClose,
  onGenerated,
}: {
  item: ContentPlanItem;
  market: string;
  onClose: () => void;
  onGenerated: () => void;
}) {
  const [domainName, setDomainName] = useState('');
  const [personaIds, setPersonaIds] = useState('');

  const mutation = useMutation({
    mutationFn: async () => {
      const draft = await generateMultiFormat({
        format: item.format,
        domainName: domainName.trim(),
        personaIds: personaIds
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        objective: item.objective,
        market: market || item.market || undefined,
        topic: item.topic || undefined,
        keyword: item.keyword || undefined,
        planItemId: item.id,
      });
      await markPlanItem(item.id, { status: 'GENERATED', draftId: draft.draft.id });
      return draft;
    },
    onSuccess: () => onGenerated(),
  });

  return (
    <div style={{ padding: '6px 2px' }}>
      <div className="muted" style={{ marginBottom: 8 }}>
        Tạo <strong>{contentFormatLabel(item.format)}</strong> cho chủ đề “
        {item.topic || item.keyword || '—'}”. Cần nhập domain và persona để AI tạo nội dung.
      </div>
      {mutation.error != null && <ErrorMessage error={mutation.error} />}
      {mutation.data && (
        <SuccessMessage>
          Đã tạo nháp “{mutation.data.draft.title}” và đánh dấu mục là “Đã tạo nội dung”.
        </SuccessMessage>
      )}
      <div className="grid grid-2">
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
      </div>
      <div className="modal-actions">
        <button className="btn btn-sm" onClick={onClose}>
          Đóng
        </button>
        <button
          className="btn btn-primary btn-sm"
          disabled={
            mutation.isPending || domainName.trim().length === 0 || personaIds.trim().length === 0
          }
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? 'Đang tạo…' : 'Tạo & đánh dấu'}
        </button>
      </div>
    </div>
  );
}
