import { apiRequest } from '../lib/apiClient';
import type { AuthResult } from '../lib/types';

export function login(username: string, password: string): Promise<AuthResult> {
  return apiRequest<AuthResult>('/api/auth/login', {
    method: 'POST',
    auth: false,
    body: { username, password },
  });
}

export function register(
  username: string,
  email: string,
  password: string,
): Promise<AuthResult> {
  return apiRequest<AuthResult>('/api/auth/register', {
    method: 'POST',
    auth: false,
    body: { username, email, password },
  });
}

export function logout(): Promise<{ status: string }> {
  return apiRequest<{ status: string }>('/api/auth/logout', { method: 'POST' });
}
