/**
 * Protected app layout: a dark-slate collapsible sidebar with grouped nav
 * (ADMIN-only items hidden for SALES), a topbar showing the live connection
 * indicator, the notifications bell, the logged-in user, and a logout action.
 * The page content renders in the <Outlet />.
 *
 * The sidebar collapses 256px <-> 64px (icon rail); the collapsed flag persists
 * to localStorage. On narrow viewports (<=768px) the sidebar becomes an
 * off-canvas drawer toggled from the topbar menu button.
 */
import { Suspense, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useRealtime } from '../realtime/RealtimeContext';
import type { ConnectionStatus } from '../realtime/RealtimeContext';
import { NotificationsBell } from './NotificationsBell';
import { Icon } from './Icon';
import { filterNavGroups } from '../lib/nav';
import type { NavGroup } from '../lib/nav';

/**
 * Grouped navigation. The flat route list is unchanged (same `to`/`label`/role
 * filtering as before) — only reorganized into the 5 brief groups with a Lucide
 * icon per item.
 */
const NAV_GROUPS: NavGroup[] = [
  {
    title: 'Tổng quan',
    items: [
      { to: '/', label: 'Dashboard', icon: 'layout-dashboard' },
      { to: '/assistant', label: 'Trợ lý hội thoại', icon: 'sparkles' },
      { to: '/reports', label: 'Báo cáo', icon: 'file-text' },
    ],
  },
  {
    title: 'CRM tuyển dụng',
    items: [
      { to: '/leads', label: 'Leads', icon: 'user-plus' },
      { to: '/intake', label: 'Chatbot hồ sơ', icon: 'bot' },
      { to: '/follow-ups', label: 'Nuôi dưỡng 1-1', icon: 'bell' },
      { to: '/job-orders', label: 'Đơn hàng', icon: 'clipboard-list' },
      { to: '/candidates', label: 'Ứng viên', icon: 'users' },
      { to: '/interview-prep', label: 'Luyện phỏng vấn', icon: 'graduation-cap' },
      { to: '/partners', label: 'Đối tác & Điểm đến', icon: 'compass', roles: ['ADMIN'] },
      { to: '/analytics', label: 'Phân tích tuyển dụng', icon: 'bar-chart-3' },
    ],
  },
  {
    title: 'Marketing AI',
    items: [
      { to: '/strategy', label: 'Strategy & Personas', icon: 'compass', roles: ['ADMIN'] },
      { to: '/trends', label: 'Xu hướng', icon: 'trending-up', roles: ['ADMIN'] },
      { to: '/insights', label: 'Insights', icon: 'lightbulb', roles: ['ADMIN'] },
      { to: '/ai-consultant', label: 'Trợ lý Công việc TGC', icon: 'bot', roles: ['ADMIN'] },
      { to: '/autopilot', label: 'Autopilot', icon: 'plane', roles: ['ADMIN'] },
      { to: '/workflows', label: 'Workflows', icon: 'workflow', roles: ['ADMIN'] },
    ],
  },
  {
    title: 'Nội dung',
    items: [
      { to: '/content-plans', label: 'Kế hoạch nội dung', icon: 'calendar-days', roles: ['ADMIN'] },
      { to: '/content-studio', label: 'Xưởng nội dung', icon: 'pen-tool', roles: ['ADMIN'] },
      { to: '/drafts', label: 'Drafts', icon: 'file-text', roles: ['ADMIN'] },
      { to: '/publishing', label: 'Publishing', icon: 'send', roles: ['ADMIN'] },
      { to: '/brand-assets', label: 'Tài sản thương hiệu', icon: 'palette', roles: ['ADMIN'] },
      { to: '/knowledge', label: 'Cơ sở tri thức', icon: 'book-open', roles: ['ADMIN'] },
    ],
  },
  {
    title: 'Hệ thống',
    items: [
      { to: '/users', label: 'Quản lý tài khoản', icon: 'users', roles: ['ADMIN'] },
      { to: '/platform-tokens', label: 'Platform Tokens', icon: 'key', roles: ['ADMIN'] },
      { to: '/document-catalog', label: 'Bộ giấy tờ', icon: 'clipboard-list', roles: ['ADMIN'] },
      { to: '/settings', label: 'Settings', icon: 'settings' },
    ],
  },
];

const COLLAPSE_KEY = 'autotgc.sidebar.collapsed';

function ConnectionIndicator({ status }: { status: ConnectionStatus }) {
  const label =
    status === 'open' ? 'Live' : status === 'connecting' ? 'Connecting…' : 'Offline';
  return (
    <span className={`conn conn-${status}`} title={`Realtime: ${label}`}>
      <span className="conn-dot" />
      <span className="conn-text">{label}</span>
    </span>
  );
}

export function Layout() {
  const { user, role, logout } = useAuth();
  const { status } = useRealtime();
  const navigate = useNavigate();
  const location = useLocation();

  // Persisted collapse state (desktop icon-rail).
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });
  // Mobile off-canvas drawer open state.
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
    } catch {
      /* ignore storage errors (private mode, etc.) */
    }
  }, [collapsed]);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  async function handleLogout() {
    await logout();
    navigate('/login', { replace: true });
  }

  const visibleGroups = filterNavGroups(NAV_GROUPS, role);

  const sidebarClass = [
    'sidebar',
    collapsed ? 'sidebar--collapsed' : '',
    mobileOpen ? 'sidebar--open' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="app-shell">
      <aside className={sidebarClass}>
        <div className="sidebar-brand">
          <span className="brand-mark" aria-hidden="true">
            <Icon name="graduation-cap" size={18} />
          </span>
          <span className="brand-wordmark">AutoTGC</span>
        </div>

        <nav className="sidebar-nav" aria-label="Điều hướng chính">
          {visibleGroups.map((group) => (
            <div className="sidebar__group" key={group.title}>
              <div className="sidebar__label">{group.title}</div>
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === '/'}
                  title={collapsed ? item.label : undefined}
                  className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
                >
                  <Icon name={item.icon} size={18} className="nav-icon" />
                  <span className="nav-label">{item.label}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar__footer">
          <ConnectionIndicator status={status} />
          <button
            className="sidebar__toggle"
            onClick={() => setCollapsed((c) => !c)}
            title={collapsed ? 'Mở rộng thanh bên' : 'Thu gọn thanh bên'}
            aria-label={collapsed ? 'Mở rộng thanh bên' : 'Thu gọn thanh bên'}
          >
            <Icon name={collapsed ? 'chevron-right' : 'chevrons-left'} size={18} className="nav-icon" />
            <span className="nav-label">Thu gọn</span>
          </button>
        </div>
      </aside>

      {mobileOpen && (
        <div
          className="sidebar-scrim"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      <div className="main">
        <header className="topbar">
          <button
            className="topbar__icon-btn"
            onClick={() => setMobileOpen((o) => !o)}
            aria-label="Mở menu điều hướng"
            title="Menu"
          >
            <Icon name="menu" size={20} />
          </button>

          <label className="topbar__search">
            <Icon name="search" size={16} className="nav-icon" />
            <input type="search" placeholder="Tìm kiếm…" aria-label="Tìm kiếm" />
          </label>

          <ConnectionIndicator status={status} />
          <NotificationsBell />
          <div className="user-chip">
            <strong>{user?.username}</strong>
            <span className="role-pill">{user?.role}</span>
          </div>
          <button
            className="btn btn-sm"
            onClick={handleLogout}
            title="Đăng xuất"
          >
            <Icon name="log-out" size={16} />
            <span>Logout</span>
          </button>
        </header>
        <main className="content">
          <Suspense fallback={<div className="skeleton-stack" role="status" aria-label="Đang tải trang…"><span className="skeleton skeleton--title" /><span className="skeleton skeleton--row" /><span className="skeleton skeleton--row" /><span className="skeleton skeleton--row" /></div>}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
