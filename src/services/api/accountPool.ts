import {
  normalizeAccountPoolServerSnapshot,
  type AccountPoolServerSnapshot,
} from '@/features/accountPool/accountPool';
import { apiClient } from './client';

export const accountPoolApi = {
  getServerSnapshot: async (): Promise<AccountPoolServerSnapshot> => {
    const payload = await apiClient.get<unknown>('/account-pool', {
      headers: {
        Accept: 'application/json',
        'Cache-Control': 'no-cache',
      },
    });
    return normalizeAccountPoolServerSnapshot(payload);
  },
};
