/**
 * UserManagement (/users, ADMIN-only) — quản lý tài khoản nhân viên.
 *
 * ADMIN xem danh sách tài khoản (username, email, vai trò, trạng thái khóa) và
 * thực hiện các thao tác quản trị:
 *   - Tạo tài khoản SALES (username/email/mật khẩu, có kiểm tra phía client và
 *     thông báo lỗi tiếng Việt; xử lý 409 "Tên đăng nhập đã tồn tại").
 *   - Khóa/Mở khóa tài khoản.
 *   - Đổi vai trò (ADMIN ↔ SALES).
 *   - Đặt lại mật khẩu.
 *
 * Tất cả thao tác đi qua @tanstack/react-query; sau mỗi mutation thành công,
 * danh sách được refetch (invalidate) để giao diện phản ánh trạng thái mới.
 * Backend tự enforce RBAC (SALES → 403); route + menu cũng ẩn cho non-ADMIN.
 *
 * Endpoints: GET/POST /api/v1/users,
 *   POST /api/v1/users/:id/lock|unlock|role|reset-password.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  changeUserRole,
  createSalesUser,
  listUsers,
  lockUser,
  resetUserPassword,
  unlockUser,
} from '../api/users';
import type { CreateSalesUserInput, ManagedUser } from '../api/users';
import { ApiError } from '../lib/apiClient';
import { useAuth } from '../auth/AuthContext';
import { Empty, ErrorMessage, Loading, Modal, SuccessMessage } from '../components/ui';
import { Icon } from '../components/Icon';
import type { Role } from '../lib/types';

const USERS_KEY = ['users'] as const;

export function UserManagement() {
  const { user: currentUser } = useAuth();
  const queryClient = useQueryClient();

  const [showCreate, setShowCreate] = useState(false);
  const [resetTarget, setResetTarget] = useState<ManagedUser | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const usersQuery = useQuery({
    queryKey: USERS_KEY,
    queryFn: () => listUsers(),
  });

  function refetchUsers() {
    void queryClient.invalidateQueries({ queryKey: USERS_KEY });
  }

  const lockMutation = useMutation({
    mutationFn: ({ id, locked }: { id: string; locked: boolean }) =>
      locked ? unlockUser(id) : lockUser(id),
    onSuccess: (updated) => {
      setSuccessMsg(
        updated.locked
          ? `Đã khóa tài khoản "${updated.username}".`
          : `Đã mở khóa tài khoản "${updated.username}".`,
      );
      refetchUsers();
    },
    onError: (err) => setActionError(err),
  });

  const roleMutation = useMutation({
    mutationFn: ({ id, role }: { id: string; role: Role }) => changeUserRole(id, role),
    onSuccess: (updated) => {
      setSuccessMsg(`Đã đổi vai trò của "${updated.username}" thành ${updated.role}.`);
      refetchUsers();
    },
    onError: (err) => setActionError(err),
  });

  function toggleLock(target: ManagedUser) {
    setActionError(null);
    setSuccessMsg(null);
    const verb = target.locked ? 'mở khóa' : 'khóa';
    if (window.confirm(`Bạn có chắc muốn ${verb} tài khoản "${target.username}"?`)) {
      lockMutation.mutate({ id: target.id, locked: target.locked });
    }
  }

  function changeRole(target: ManagedUser, role: Role) {
    if (role === target.role) return;
    setActionError(null);
    setSuccessMsg(null);
    roleMutation.mutate({ id: target.id, role });
  }

  const busy = lockMutation.isPending || roleMutation.isPending;

  return (
    <div className="reveal">
      <div className="page-header">
        <div>
          <div className="eyebrow">Hệ thống</div>
          <h1 className="page-title">Quản lý tài khoản</h1>
        </div>
        <div className="row-actions">
          <button
            className="btn btn-primary btn-sm"
            onClick={() => {
              setActionError(null);
              setSuccessMsg(null);
              setShowCreate(true);
            }}
          >
            <Icon name="user-plus" size={16} />
            Tạo tài khoản SALES
          </button>
        </div>
      </div>

      <div className="notice" style={{ marginBottom: 'var(--space-md)' }}>
        Quản trị viên có thể tạo tài khoản SALES, khóa/mở khóa truy cập, đổi vai trò và
        đặt lại mật khẩu cho nhân viên. Tài khoản bị khóa sẽ không thể đăng nhập.
      </div>

      {successMsg && <SuccessMessage>{successMsg}</SuccessMessage>}
      {actionError != null && <ErrorMessage error={actionError} />}

      <div className="card">
        {usersQuery.isLoading ? (
          <Loading variant="table" rows={6} label="Đang tải danh sách tài khoản…" />
        ) : usersQuery.error ? (
          <ErrorMessage error={usersQuery.error} />
        ) : usersQuery.data && usersQuery.data.users.length > 0 ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Tên đăng nhập</th>
                  <th>Email</th>
                  <th>Vai trò</th>
                  <th>Trạng thái</th>
                  <th>Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {usersQuery.data.users.map((u) => {
                  const isSelf = currentUser?.id === u.id;
                  return (
                    <tr key={u.id}>
                      <td>
                        {u.username}
                        {isSelf ? <span className="muted"> (bạn)</span> : null}
                      </td>
                      <td>{u.email}</td>
                      <td>
                        <select
                          value={u.role}
                          disabled={busy || isSelf}
                          title={isSelf ? 'Không thể tự đổi vai trò của chính mình' : undefined}
                          onChange={(e) => changeRole(u, e.target.value as Role)}
                        >
                          <option value="ADMIN">ADMIN</option>
                          <option value="SALES">SALES</option>
                        </select>
                      </td>
                      <td>
                        <span className={`badge ${u.locked ? 'badge-red' : 'badge-green'}`}>
                          {u.locked ? 'Đã khóa' : 'Hoạt động'}
                        </span>
                      </td>
                      <td>
                        <div className="row-actions">
                          <button
                            className={`btn btn-sm ${u.locked ? '' : 'btn-danger'}`}
                            disabled={busy || isSelf}
                            title={
                              isSelf ? 'Không thể tự khóa tài khoản của chính mình' : undefined
                            }
                            onClick={() => toggleLock(u)}
                          >
                            <Icon name={u.locked ? 'check' : 'x'} size={16} />
                            {u.locked ? 'Mở khóa' : 'Khóa'}
                          </button>
                          <button
                            className="btn btn-sm"
                            disabled={busy}
                            onClick={() => {
                              setActionError(null);
                              setSuccessMsg(null);
                              setResetTarget(u);
                            }}
                          >
                            <Icon name="key" size={16} />
                            Đặt lại mật khẩu
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            icon="users"
            label="Chưa có tài khoản nào."
            action={
              <button className="btn btn-sm" onClick={() => setShowCreate(true)}>
                <Icon name="user-plus" size={16} />
                Tạo tài khoản SALES
              </button>
            }
          />
        )}
      </div>

      {showCreate && (
        <CreateSalesUserModal
          onClose={() => setShowCreate(false)}
          onCreated={(created) => {
            setShowCreate(false);
            setSuccessMsg(`Đã tạo tài khoản SALES "${created.username}".`);
            refetchUsers();
          }}
        />
      )}

      {resetTarget && (
        <ResetPasswordModal
          target={resetTarget}
          onClose={() => setResetTarget(null)}
          onDone={(username) => {
            setResetTarget(null);
            setSuccessMsg(`Đã đặt lại mật khẩu cho "${username}".`);
          }}
        />
      )}
    </div>
  );
}

/** Client-side email check (lenient; the server is the source of truth). */
function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function CreateSalesUserModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (user: ManagedUser) => void;
}) {
  const [form, setForm] = useState<CreateSalesUserInput>({
    username: '',
    email: '',
    password: '',
  });
  const [fieldError, setFieldError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      createSalesUser({
        username: form.username.trim(),
        email: form.email.trim(),
        password: form.password,
      }),
    onSuccess: onCreated,
  });

  function set<K extends keyof CreateSalesUserInput>(key: K, value: CreateSalesUserInput[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function validate(): string | null {
    if (form.username.trim().length === 0) return 'Tên đăng nhập không được để trống.';
    if (form.username.trim().length < 3) return 'Tên đăng nhập phải có ít nhất 3 ký tự.';
    if (form.email.trim().length === 0) return 'Email không được để trống.';
    if (!isValidEmail(form.email.trim())) return 'Email không hợp lệ.';
    if (form.password.length < 8) return 'Mật khẩu phải có ít nhất 8 ký tự.';
    return null;
  }

  function handleSubmit() {
    const err = validate();
    if (err) {
      setFieldError(err);
      return;
    }
    setFieldError(null);
    mutation.mutate();
  }

  // Surface a friendly Vietnamese message for the duplicate-username conflict (409).
  const conflictMessage =
    mutation.error instanceof ApiError && mutation.error.status === 409
      ? 'Tên đăng nhập đã tồn tại.'
      : null;

  return (
    <Modal title="Tạo tài khoản SALES" onClose={onClose}>
      {fieldError && <div className="error-box">{fieldError}</div>}
      {conflictMessage ? (
        <div className="error-box">{conflictMessage}</div>
      ) : (
        mutation.error != null && <ErrorMessage error={mutation.error} />
      )}

      <div className="field">
        <label>Tên đăng nhập *</label>
        <input
          value={form.username}
          autoFocus
          onChange={(e) => set('username', e.target.value)}
          placeholder="vd: nv.nguyenvana"
        />
      </div>
      <div className="field">
        <label>Email *</label>
        <input
          type="email"
          value={form.email}
          onChange={(e) => set('email', e.target.value)}
          placeholder="vd: a.nguyen@tgc.vn"
        />
      </div>
      <div className="field">
        <label>Mật khẩu *</label>
        <input
          type="password"
          value={form.password}
          onChange={(e) => set('password', e.target.value)}
          placeholder="Tối thiểu 8 ký tự"
        />
        <div className="muted" style={{ marginTop: 'var(--space-xs)' }}>
          Mật khẩu được lưu ở dạng băm (hash) trên máy chủ; tài khoản mới luôn có vai trò SALES.
        </div>
      </div>

      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Hủy
        </button>
        <button className="btn btn-primary" disabled={mutation.isPending} onClick={handleSubmit}>
          {mutation.isPending ? 'Đang tạo…' : 'Tạo tài khoản'}
        </button>
      </div>
    </Modal>
  );
}

function ResetPasswordModal({
  target,
  onClose,
  onDone,
}: {
  target: ManagedUser;
  onClose: () => void;
  onDone: (username: string) => void;
}) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => resetUserPassword(target.id, password),
    onSuccess: () => onDone(target.username),
  });

  function handleSubmit() {
    if (password.length < 8) {
      setFieldError('Mật khẩu phải có ít nhất 8 ký tự.');
      return;
    }
    if (password !== confirm) {
      setFieldError('Mật khẩu xác nhận không khớp.');
      return;
    }
    setFieldError(null);
    mutation.mutate();
  }

  return (
    <Modal title={`Đặt lại mật khẩu — ${target.username}`} onClose={onClose}>
      {fieldError && <div className="error-box">{fieldError}</div>}
      {mutation.error != null && <ErrorMessage error={mutation.error} />}

      <div className="field">
        <label>Mật khẩu mới *</label>
        <input
          type="password"
          value={password}
          autoFocus
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Tối thiểu 8 ký tự"
        />
      </div>
      <div className="field">
        <label>Xác nhận mật khẩu *</label>
        <input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </div>

      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Hủy
        </button>
        <button className="btn btn-primary" disabled={mutation.isPending} onClick={handleSubmit}>
          {mutation.isPending ? 'Đang lưu…' : 'Đặt lại mật khẩu'}
        </button>
      </div>
    </Modal>
  );
}
