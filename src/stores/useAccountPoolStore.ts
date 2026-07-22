import { create } from 'zustand';
import type { PendingAccountInput } from '@/features/accountPool/accountPool';
import { generateId } from '@/utils/helpers';

export interface PendingAccount extends PendingAccountInput {
  id: string;
}

interface AccountPoolState {
  accounts: PendingAccount[];
  sourceName: string;
  loadedAt: number | null;
  replaceAccounts: (accounts: PendingAccountInput[], sourceName?: string) => void;
  removeAccount: (id: string) => void;
  clearAccounts: () => void;
}

const emptyState = {
  accounts: [] as PendingAccount[],
  sourceName: '',
  loadedAt: null as number | null,
};

/**
 * Deliberately volatile: pending credentials must never be persisted in
 * localStorage, sessionStorage, backend APIs, or the generated management.html.
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
