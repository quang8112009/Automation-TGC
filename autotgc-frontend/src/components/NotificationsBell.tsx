/**
 * Notifications bell fed by the realtime stream. Shows an unread badge and a
 * dropdown panel of recent realtime notifications (lead/insight/token/notification
 * frames). Marks all read when opened.
 */
import { useEffect, useRef, useState } from 'react';
import { useRealtime } from '../realtime/RealtimeContext';
import { formatDate } from './ui';
import { Icon } from './Icon';

export function NotificationsBell() {
  const { notifications, unreadCount, markAllRead, clearNotifications } = useRealtime();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && unreadCount > 0) markAllRead();
  }

  return (
    <div className="bell" ref={ref}>
      <button className="bell-btn" onClick={toggle} aria-label="Notifications" title="Thông báo">
        <Icon name="bell" size={18} />
        {unreadCount > 0 && <span className="bell-badge">{unreadCount}</span>}
      </button>
      {open && (
        <div className="bell-panel">
          <div className="bell-panel-header">
            <span>Notifications</span>
            <button className="btn btn-sm" onClick={clearNotifications}>
              Clear
            </button>
          </div>
          {notifications.length === 0 ? (
            <div className="state">No notifications yet.</div>
          ) : (
            notifications.map((n) => (
              <div key={n.id} className={`bell-item ${n.read ? '' : 'unread'}`}>
                <div>{n.message}</div>
                <div className="bell-item-meta">
                  {n.topic} · {n.type} · {formatDate(n.at)}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
