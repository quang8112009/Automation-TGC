/**
 * Platform Tokens — lists the secret-free public view of platform tokens and
 * allows triggering a refresh per platform.
 *
 * Endpoints: GET /api/platform-tokens, POST /api/platform-tokens/:platform/refresh.
 * Token values are never returned by the backend (only metadata + validity).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listPlatformTokens, refreshPlatformToken } from '../api/tokens';
import {
  Empty,
  ErrorMessage,
  Loading,
  StatusBadge,
  formatDate,
} from '../components/ui';

export function PlatformTokens() {
  const queryClient = useQueryClient();
  const tokensQuery = useQuery({
    queryKey: ['platformTokens'],
    queryFn: listPlatformTokens,
  });

  const refreshMutation = useMutation({
    mutationFn: (platform: string) => refreshPlatformToken(platform),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['platformTokens'] }),
  });

  return (
    <div className="reveal">
      <div className="page-header">
        <div>
          <div className="eyebrow">Hệ thống</div>
          <h1 className="page-title">Platform Tokens</h1>
        </div>
        <button
          className="btn btn-sm"
          onClick={() => void queryClient.invalidateQueries({ queryKey: ['platformTokens'] })}
        >
          Tải lại
        </button>
      </div>

      <p className="muted" style={{ marginBottom: 'var(--space-md)' }}>
        Giá trị token được lưu trong kho bí mật phía máy chủ và không bao giờ lộ qua API.
        Màn hình này chỉ hiển thị thông tin mô tả và tình trạng hiệu lực.
      </p>

      {refreshMutation.error != null && <ErrorMessage error={refreshMutation.error} />}

      <div className="card">
        {tokensQuery.isLoading ? (
          <Loading variant="table" rows={4} label="Đang tải platform tokens…" />
        ) : tokensQuery.error ? (
          <ErrorMessage error={tokensQuery.error} />
        ) : tokensQuery.data && tokensQuery.data.tokens.length > 0 ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Nền tảng</th>
                  <th>Loại</th>
                  <th>Hết hạn</th>
                  <th>Hiệu lực</th>
                  <th>Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {tokensQuery.data.tokens.map((t) => (
                  <tr key={t.platform}>
                    <td>{t.platform}</td>
                    <td>{t.type}</td>
                    <td>{formatDate(t.expiresAt)}</td>
                    <td>
                      <StatusBadge status={t.valid ? 'VALID' : 'MISSING'} />
                    </td>
                    <td>
                      <button
                        className="btn btn-sm"
                        disabled={refreshMutation.isPending}
                        onClick={() => refreshMutation.mutate(t.platform)}
                      >
                        {refreshMutation.isPending ? 'Đang làm mới…' : 'Làm mới'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon="key" label="Chưa có platform token nào được đăng ký." />
        )}
      </div>
    </div>
  );
}
