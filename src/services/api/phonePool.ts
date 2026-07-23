import {
  normalizePhonePoolSmsResponse,
  normalizePhonePoolSnapshot,
  type PhonePoolSmsResponse,
  type PhonePoolSnapshot,
} from '@/features/phonePool/phonePool';
import { apiClient } from './client';

const noStoreHeaders = {
  Accept: 'application/json',
  'Cache-Control': 'no-cache',
};

export const phonePoolApi = {
  getSnapshot: async (): Promise<PhonePoolSnapshot> =>
    normalizePhonePoolSnapshot(
      await apiClient.get<unknown>('/phone-pool', {
        headers: noStoreHeaders,
      })
    ),

  importPhones: async (source: string, baselineBindings: number): Promise<PhonePoolSnapshot> =>
    normalizePhonePoolSnapshot(
      await apiClient.post<unknown>(
        '/phone-pool/import',
        {
          source,
          baseline_bindings: baselineBindings,
        },
        { headers: noStoreHeaders }
      )
    ),

  bind: async (accountEmail: string, phoneId: string): Promise<PhonePoolSnapshot> =>
    normalizePhonePoolSnapshot(
      await apiClient.post<unknown>(
        '/phone-pool/bind',
        {
          account_email: accountEmail,
          phone_id: phoneId,
        },
        { headers: noStoreHeaders }
      )
    ),

  unbind: async (accountEmail: string): Promise<PhonePoolSnapshot> =>
    normalizePhonePoolSnapshot(
      await apiClient.post<unknown>(
        '/phone-pool/unbind',
        { account_email: accountEmail },
        { headers: noStoreHeaders }
      )
    ),

  setEnabled: async (phoneId: string, enabled: boolean): Promise<PhonePoolSnapshot> =>
    normalizePhonePoolSnapshot(
      await apiClient.post<unknown>(
        '/phone-pool/enabled',
        { phone_id: phoneId, enabled },
        { headers: noStoreHeaders }
      )
    ),

  requestCode: async ({
    accountEmail,
    phoneId,
  }: {
    accountEmail?: string;
    phoneId?: string;
  }): Promise<PhonePoolSmsResponse> =>
    normalizePhonePoolSmsResponse(
      await apiClient.post<unknown>(
        '/phone-pool/request-code',
        {
          ...(accountEmail ? { account_email: accountEmail } : {}),
          ...(phoneId ? { phone_id: phoneId } : {}),
        },
        { headers: noStoreHeaders }
      )
    ),
};
