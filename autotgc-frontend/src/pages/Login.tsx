import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { ErrorMessage } from '../components/ui';
import { Icon } from '../components/Icon';

interface LocationState {
  from?: { pathname: string };
}

export function Login() {
  const { login, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  if (isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(username, password);
      const state = location.state as LocationState | null;
      const dest = state?.from?.pathname ?? '/';
      navigate(dest, { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <aside className="auth-crest" aria-hidden="true">
        <span className="auth-crest__mark">
          <Icon name="graduation-cap" size={28} />
        </span>
        <div className="auth-crest__eyebrow">Thanh Giang · XKLĐ</div>
        <h2 className="auth-crest__wordmark">AutoTGC</h2>
        <hr className="auth-crest__rule" />
        <p className="auth-crest__deck">
          Nền tảng vận hành marketing &amp; tuyển dụng bằng dữ liệu và AI — nghiên cứu xu
          hướng, sản xuất nội dung, đo hiệu quả và quản lý ứng viên xuất khẩu lao động.
        </p>
      </aside>
      <form className="auth-card" onSubmit={onSubmit}>
        <h1>AutoTGC</h1>
        <p className="auth-sub">Đăng nhập vào tài khoản của bạn</p>
        {error != null && <ErrorMessage error={error} />}
        <div className="field">
          <label htmlFor="username">Tên đăng nhập</label>
          <input
            id="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
          />
        </div>
        <div className="field">
          <label htmlFor="password">Mật khẩu</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </div>
        <button className="btn btn-primary" type="submit" disabled={busy} style={{ width: '100%' }}>
          {busy ? 'Đang đăng nhập…' : 'Đăng nhập'}
        </button>
        <div className="auth-switch">
          Chưa có tài khoản? <Link to="/register">Đăng ký ADMIN</Link>
        </div>
      </form>
    </div>
  );
}
