/**
 * Dashboard — approval queue counts, upcoming posts, failed-post alerts, lead
 * KPIs, and a data-sync freshness badge. Calls GET /api/dashboard/overview.
 * Live-refreshes via react-query invalidation driven by the realtime stream.
 */
import { useQuery } from '@tanstack/react-query';
import { getOverview } from '../api/dashboard';
import {
  ErrorMessage,
  Loading,
  StatCard,
  StatusBadge,
  formatDate,
} from '../components/ui';

export function Dashboard() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['dashboard', 'overview'],
    queryFn: getOverview,
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorMessage error={error} />;
  if (!data) return null;

  const leadStatusEntries = Object.entries(data.kpis.leadsByStatus);

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Dashboard</h1>
        <span className={`badge ${data.dataSync.stale ? 'badge-yellow' : 'badge-green'}`}>
          Data sync: {data.dataSync.status}
          {data.dataSync.lastSync ? ` · ${formatDate(data.dataSync.lastSync)}` : ' · never'}
        </span>
      </div>

      <div className="grid grid-4" style={{ marginBottom: 18 }}>
        <StatCard
          label="Approval Queue"
          count={data.approvalQueue.total}
          hint={`${data.approvalQueue.draftCount} drafts · ${data.approvalQueue.pendingInsightCount} insights`}
        />
        <StatCard label="Total Leads" count={data.kpis.totalLeads} />
        <StatCard label="Upcoming Posts" count={data.upcomingPosts.length} />
        <StatCard
          label="Failed Posts"
          count={data.alerts.failedPosts.length}
          valueColor={data.alerts.failedPosts.length ? 'var(--danger)' : undefined}
        />
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h2 className="card-title">Upcoming Posts</h2>
          {data.upcomingPosts.length === 0 ? (
            <div className="muted">No upcoming posts in the next 7 days.</div>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Platform</th>
                    <th>Scheduled</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.upcomingPosts.map((p) => (
                    <tr key={p.id}>
                      <td>{p.platform}</td>
                      <td>{formatDate(p.scheduledAt)}</td>
                      <td>
                        <StatusBadge status={p.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <h2 className="card-title">Failed Post Alerts</h2>
          {data.alerts.failedPosts.length === 0 ? (
            <div className="muted">No failures.</div>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Platform</th>
                    <th>Reason</th>
                    <th>Retries</th>
                  </tr>
                </thead>
                <tbody>
                  {data.alerts.failedPosts.map((p) => (
                    <tr key={p.id}>
                      <td>{p.platform}</td>
                      <td>{p.failureReason ?? p.errorCode ?? 'unknown'}</td>
                      <td>{p.retryCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <h2 className="card-title">Leads by Status</h2>
          {leadStatusEntries.length === 0 ? (
            <div className="muted">No leads recorded yet.</div>
          ) : (
            <div className="inline-list">
              {leadStatusEntries.map(([status, count]) => (
                <span key={status} className="badge badge-blue">
                  {status}: {count}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
