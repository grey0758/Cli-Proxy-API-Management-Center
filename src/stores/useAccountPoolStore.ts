import { create } from 'zustand';
import type { AccountPoolAccountInput } from '@/features/accountPool/accountPool';
import { generateId } from '@/utils/helpers';

export interface AccountPoolAccount extends AccountPoolAccountInput {
  id: string;
}

interface AccountPoolState {
  accounts: AccountPoolAccount[];
  sourceName: string;
  loadedAt: number | null;
  replaceAccounts: (accounts: AccountPoolAccountInput[], sourceName?: string) => void;
  removeAccount: (id: string) => void;
  clearAccounts: () => void;
}

const emptyState = {
  accounts: [] as AccountPoolAccount[],
  sourceName: '',
  loadedAt: null as number | null,
};

/**
 * Deliberately volatile in the browser: rows may come from the authenticated
 * private server snapshot or a local file, but are never written to browser
 * storage or embedded in the generated management.html.
 */
export const useAccountPoolStore = create<AccountPoolState>((set) => ({
  ...emptyState,
  replaceAccounts: (accounts, sourceName = '') =>
    set({
      accounts: accounts.map((account) => ({ ...account, id: generateId() })),
      sourceName,
      loadedAt: Date.now(),
    }),
  removeAccount: (id) =>
    set((state) => ({
      accounts: state.accounts.filter((account) => account.id !== id),
    })),
  clearAccounts: () => set(emptyState),
}));
