/**
 * Typed wrappers for the ADMIN-only staff-account endpoints (Requirement 5):
 * list staff, create a SALES account, lock/unlock, change role, and reset a
 * password. Built on the shared `api` helper; all paths use the /api/v1
 * gateway prefix and inherit Bearer auth + the { error: { code, message } }
 * envelope handling. SALES callers are rejected with 403 by the backend RBAC
 * guard (the route + menu item are also hidden client-side for non-ADMIN).
 */
import { api } from '../lib/apiClient';
import type { Role } from '../lib/types';

/** A managed staff account as returned by the user-management endpoints. */
export interface ManagedUser {
  id: string;
  username: string;
  email: string;
  role: Role;
  locked: boolean;
}

/** GET /api/v1/users result envelope. */
export interface ListUsersResult {
  users: ManagedUser[];
}

/** GET /api/v1/users — list every staff account (ADMIN-only). */
export function listUsers(): Promise<ListUsersResult> {
  return api.get<ListUsersResult>('/api/v1/users');
}

export interface CreateSalesUserInput {
  username: string;
  email: string;
  password: string;
}

/**
 * POST /api/v1/users — create a SALES account. The backend returns 201 with the
 * created user, 409 when the username already exists, and 400 for invalid input.
 */
export function createSalesUser(input: CreateSalesUserInput): Promise<ManagedUser> {
  return api.post<ManagedUser>('/api/v1/users', input);
}

/** POST /api/v1/users/:id/lock — lock an account. */
export function lockUser(id: string): Promise<ManagedUser> {
  return api.post<ManagedUser>(`/api/v1/users/${encodeURIComponent(id)}/lock`);
}

/** POST /api/v1/users/:id/unlock — unlock an account and reset its failed-login counter. */
export function unlockUser(id: string): Promise<ManagedUser> {
  return api.post<ManagedUser>(`/api/v1/users/${encodeURIComponent(id)}/unlock`);
}

/** POST /api/v1/users/:id/role — change an account's role (ADMIN | SALES). */
export function changeUserRole(id: string, role: Role): Promise<ManagedUser> {
  return api.post<ManagedUser>(`/api/v1/users/${encodeURIComponent(id)}/role`, { role });
}

/** POST /api/v1/users/:id/reset-password — set a new password (hashed server-side). */
export function resetUserPassword(id: string, password: string): Promise<ManagedUser> {
  return api.post<ManagedUser>(
    `/api/v1/users/${encodeURIComponent(id)}/reset-password`,
    { password },
  );
}
