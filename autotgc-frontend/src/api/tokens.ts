import { api } from '../lib/apiClient';
import type { PublicTokenView } from '../lib/types';

export function listPlatformTokens(): Promise<{ tokens: PublicTokenView[] }> {
  return api.get<{ tokens: PublicTokenView[] }>('/api/platform-tokens');
}

export function refreshPlatformToken(platform: string): Promise<PublicTokenView> {
  return api.post<PublicTokenView>(
    `/api/platform-tokens/${encodeURIComponent(platform)}/refresh`,
  );
}
