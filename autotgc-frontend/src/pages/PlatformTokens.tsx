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
          Reload
        </button>
      </div>

      <p className="muted" style={{ marginBottom: 12 }}>
        Token values are stored in the server-side secret store and never exposed by the
        API. This view shows metadata and validity only.
      </p>

      {refreshMutation.error != null && <ErrorMessage error={refreshMutation.error} />}

      <div className="card">
        {tokensQuery.isLoading ? (
          <Loading />
        ) : tokensQuery.error ? (
          <ErrorMessage error={tokensQuery.error} />
        ) : tokensQuery.data && tokensQuery.data.tokens.length > 0 ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Platform</th>
                  <th>Type</th>
                  <th>Expires</th>
                  <th>Validity</th>
                  <th>Actions</th>
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
                        Refresh
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty label="No platform tokens registered." />
        )}
      </div>
    </div>
  );
}
