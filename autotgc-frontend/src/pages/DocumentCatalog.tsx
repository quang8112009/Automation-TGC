/**
 * DocumentCatalog (/document-catalog, ADMIN) — quản trị bộ giấy tờ mặc định
 * theo từng thị trường (Document_Type_Catalog).
 *
 * ADMIN chọn một thị trường (Nhật/Hàn/Đức/Đài Loan/Trong nước/Khác), xem và
 * chỉnh sửa danh sách loại giấy tờ mặc định: mã loại (type), nhãn tiếng Việt
 * (label) và cờ bắt buộc (required). Hỗ trợ thêm/xóa dòng và lưu lại qua
 * PUT /api/v1/document-catalog/:market.
 *
 * Lưu ý nghiệp vụ (Req 12.5): cập nhật catalog KHÔNG ảnh hưởng tới checklist
 * giấy tờ của các ứng viên đã được khởi tạo trước đó — chỉ áp dụng cho lần khởi
 * tạo checklist về sau.
 *
 * Endpoints: GET /api/v1/document-catalog/:market, PUT /api/v1/document-catalog/:market.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getDocumentCatalog, updateDocumentCatalog } from '../api/recruitment';
import type { DocTypeDef } from '../api/recruitment';
import { Empty, ErrorMessage, Loading, SuccessMessage } from '../components/ui';
import { Icon } from '../components/Icon';
import { MARKETS, MARKET_LABELS } from '../lib/recruitment';
import type { RecruitmentMarket } from '../lib/types';

/** A working-copy row: the editable DocTypeDef plus a stable client key. */
interface DraftRow extends DocTypeDef {
  /** Local-only key so React can track rows across edits/removals. */
  _key: string;
}

let rowKeySeq = 0;
function nextRowKey(): string {
  rowKeySeq += 1;
  return `row-${rowKeySeq}`;
}

function toDraft(docs: DocTypeDef[]): DraftRow[] {
  return docs.map((d) => ({ ...d, _key: nextRowKey() }));
}

export function DocumentCatalog() {
  const queryClient = useQueryClient();

  const [market, setMarket] = useState<RecruitmentMarket>('JAPAN');
  const [rows, setRows] = useState<DraftRow[]>([]);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  const catalogQuery = useQuery({
    queryKey: ['document-catalog', market],
    queryFn: () => getDocumentCatalog(market),
  });

  // Reset the working copy whenever a fresh catalog loads (market change / refetch).
  useEffect(() => {
    if (catalogQuery.data) {
      setRows(toDraft(catalogQuery.data.docs));
      setValidationError(null);
      setSavedMsg(null);
    }
  }, [catalogQuery.data]);

  const saveMutation = useMutation({
    mutationFn: (docs: DocTypeDef[]) => updateDocumentCatalog(market, docs),
    onSuccess: (result) => {
      setRows(toDraft(result.docs));
      setValidationError(null);
      setSavedMsg(`Đã lưu bộ giấy tờ cho thị trường ${MARKET_LABELS[market]}.`);
      queryClient.setQueryData(['document-catalog', market], result);
    },
  });

  function setRow(key: string, patch: Partial<DocTypeDef>) {
    setSavedMsg(null);
    setRows((prev) => prev.map((r) => (r._key === key ? { ...r, ...patch } : r)));
  }

  function addRow() {
    setSavedMsg(null);
    setRows((prev) => [...prev, { type: '', label: '', required: true, _key: nextRowKey() }]);
  }

  function removeRow(key: string) {
    setSavedMsg(null);
    setRows((prev) => prev.filter((r) => r._key !== key));
  }

  function handleSave() {
    // Validate: every row must have a non-blank type and label.
    for (const r of rows) {
      if (r.type.trim().length === 0 || r.label.trim().length === 0) {
        setValidationError('Mã loại và nhãn không được để trống.');
        return;
      }
    }
    setValidationError(null);
    const docs: DocTypeDef[] = rows.map((r) => ({
      type: r.type.trim(),
      label: r.label.trim(),
      required: r.required,
    }));
    saveMutation.mutate(docs);
  }

  return (
    <div className="reveal">
      <div className="page-header">
        <div>
          <div className="eyebrow">Hệ thống</div>
          <h1 className="page-title">Bộ giấy tờ theo thị trường</h1>
        </div>
        <div className="row-actions">
          <button
            className="btn btn-primary btn-sm"
            disabled={saveMutation.isPending || catalogQuery.isLoading}
            onClick={handleSave}
          >
            <Icon name="check" size={16} />
            {saveMutation.isPending ? 'Đang lưu…' : 'Lưu'}
          </button>
        </div>
      </div>

      <div className="notice" style={{ marginBottom: 'var(--space-md)' }}>
        Đây là bộ giấy tờ mặc định dùng khi khởi tạo checklist cho ứng viên mới. Việc
        thay đổi tại đây <strong>không</strong> ảnh hưởng tới checklist của những ứng viên
        đã được khởi tạo trước đó.
      </div>

      <div className="toolbar">
        <div className="field">
          <label htmlFor="dc-market">Thị trường</label>
          <select
            id="dc-market"
            value={market}
            onChange={(e) => setMarket(e.target.value as RecruitmentMarket)}
          >
            {MARKETS.map((m) => (
              <option key={m} value={m}>
                {MARKET_LABELS[m]}
              </option>
            ))}
          </select>
        </div>
        <button className="btn" onClick={addRow}>
          <Icon name="plus" size={16} />
          Thêm dòng
        </button>
      </div>

      {savedMsg && <SuccessMessage>{savedMsg}</SuccessMessage>}
      {validationError && <div className="error-box">{validationError}</div>}
      {saveMutation.error != null && <ErrorMessage error={saveMutation.error} />}

      <div className="card">
        {catalogQuery.isLoading ? (
          <Loading variant="table" rows={5} label="Đang tải bộ giấy tờ…" />
        ) : catalogQuery.error ? (
          <ErrorMessage error={catalogQuery.error} />
        ) : rows.length === 0 ? (
          <Empty
            label="Chưa có loại giấy tờ nào. Nhấn “Thêm dòng” để bắt đầu."
            action={
              <button className="btn btn-sm" onClick={addRow}>
                <Icon name="plus" size={16} />
                Thêm dòng
              </button>
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th style={{ width: '30%' }}>Mã loại</th>
                  <th style={{ width: '45%' }}>Nhãn (tiếng Việt)</th>
                  <th style={{ width: '15%' }}>Bắt buộc</th>
                  <th style={{ width: '10%' }}>Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row._key}>
                    <td>
                      <input
                        value={row.type}
                        placeholder="VD: PASSPORT"
                        aria-label="Mã loại giấy tờ"
                        onChange={(e) => setRow(row._key, { type: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        value={row.label}
                        placeholder="VD: Hộ chiếu"
                        aria-label="Nhãn giấy tờ (tiếng Việt)"
                        onChange={(e) => setRow(row._key, { label: e.target.value })}
                      />
                    </td>
                    <td>
                      <select
                        value={row.required ? 'yes' : 'no'}
                        aria-label="Bắt buộc"
                        onChange={(e) => setRow(row._key, { required: e.target.value === 'yes' })}
                      >
                        <option value="yes">Bắt buộc</option>
                        <option value="no">Tùy chọn</option>
                      </select>
                    </td>
                    <td>
                      <button
                        className="btn btn-sm btn-danger"
                        title="Xóa dòng"
                        aria-label="Xóa dòng"
                        onClick={() => removeRow(row._key)}
                      >
                        <Icon name="x" size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
