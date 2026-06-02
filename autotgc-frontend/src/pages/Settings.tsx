/**
 * Settings / Profile — shows the logged-in user and a logout action, plus the
 * realtime connection status.
 */
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useRealtime } from '../realtime/RealtimeContext';
import { StatusBadge } from '../components/ui';

export function Settings() {
  const { user, logout } = useAuth();
  const { status } = useRealtime();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <div className="reveal">
      <div className="page-header">
        <div>
          <div className="eyebrow">Hệ thống</div>
          <h1 className="page-title">Settings</h1>
        </div>
      </div>

      <div className="card" style={{ maxWidth: 520 }}>
        <h2 className="card-title">Profile</h2>
        <dl className="kv">
          <dt>User ID</dt>
          <dd>{user?.id}</dd>
          <dt>Username</dt>
          <dd>{user?.username}</dd>
          <dt>Email</dt>
          <dd>{user?.email}</dd>
          <dt>Role</dt>
          <dd>
            <span className="role-pill">{user?.role}</span>
          </dd>
          <dt>Realtime</dt>
          <dd>
            <StatusBadge status={status === 'open' ? 'CURRENT' : 'STALE'} />{' '}
            <span className="muted">{status}</span>
          </dd>
        </dl>
        <div className="modal-actions">
          <button className="btn btn-danger" onClick={handleLogout}>
            Logout
          </button>
        </div>
      </div>
    </div>
  );
}
