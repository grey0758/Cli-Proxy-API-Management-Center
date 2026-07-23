export const ACCOUNT_POOL_MAX_ACCOUNTS = 1000;

export interface PendingAccountInput {
  email: string;
  password: string;
  secret: string;
}

export type AccountPoolParseIssueReason = 'format' | 'empty_field';

export interface AccountPoolParseIssue {
  line: number;
  reason: AccountPoolParseIssueReason;
}

export interface AccountPoolParseResult {
  accounts: PendingAccountInput[];
  issues: AccountPoolParseIssue[];
  duplicateCount: number;
}

export interface AccountPoolNamedSource {
  name: string;
  source: string;
}

export interface AccountPoolNamedParseIssue extends AccountPoolParseIssue {
  sourceName: string;
}

export interface AccountPoolMultiParseResult {
  accounts: PendingAccountInput[];
  issues: AccountPoolNamedParseIssue[];
  duplicateCount: number;
}

export interface AccountPoolServerSnapshot {
  version: 1;
  source: string;
  updatedAt: string;
  accounts: PendingAccountInput[];
  duplicateCount: number;
}

export type AccountPoolSourceErrorCode =
  'embedded_list_missing' | 'embedded_list_invalid' | 'json_list_invalid' | 'too_many_accounts';

export class AccountPoolSourceError extends Error {
  constructor(public readonly code: AccountPoolSourceErrorCode) {
    super(code);
    this.name = 'AccountPoolSourceError';
  }
}

export class AccountPoolSnapshotError extends Error {
  constructor() {
    super('server_snapshot_invalid');
    this.name = 'AccountPoolSnapshotError';
  }
}

const RAW_LINES_PATTERN = /(?:const|let|var)\s+rawLines\s*=\s*(\[[\s\S]*?\])\s*;/;

const parseStringArray = (value: string, errorCode: AccountPoolSourceErrorCode): string[] => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
      throw new AccountPoolSourceError(errorCode);
    }
    return parsed;
  } catch (error) {
    if (error instanceof AccountPoolSourceError) throw error;
    throw new AccountPoolSourceError(errorCode);
  }
};

/**
 * Extract account rows without evaluating uploaded HTML or JavaScript.
 * The cami-list prototype stores rows in a JSON-compatible `rawLines` array.
 */
export function extractAccountPoolLines(source: string): string[] {
  const trimmed = source.trim();
  const looksLikeHTML = /<!doctype\s+html|<html[\s>]/i.test(trimmed);
  const rawLinesMatch = source.match(RAW_LINES_PATTERN);

  if (rawLinesMatch) {
    return parseStringArray(rawLinesMatch[1], 'embedded_list_invalid');
  }

  if (looksLikeHTML) {
    throw new AccountPoolSourceError('embedded_list_missing');
  }

  if (trimmed.startsWith('[')) {
    return parseStringArray(trimmed, 'json_list_invalid');
  }

  return source.split(/\r?\n/);
}

const isHeaderRow = (line: string): boolean => {
  const normalized = line.toLowerCase().replace(/\s+/g, '');
  return (
    normalized === 'email|password|secret' ||
    normalized === '账号|密码|2fa密钥' ||
    normalized === '邮箱|密码|2fa密钥'
  );
};

export function parseAccountPoolSource(source: string): AccountPoolParseResult {
  const rows = extractAccountPoolLines(source);
  const accounts: PendingAccountInput[] = [];
  const issues: AccountPoolParseIssue[] = [];
  const seen = new Set<string>();
  let duplicateCount = 0;

  rows.forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//') || isHeaderRow(line)) return;

    const firstSeparator = line.indexOf('|');
    const lastSeparator = line.lastIndexOf('|');
    if (firstSeparator < 1 || lastSeparator <= firstSeparator) {
      issues.push({ line: lineNumber, reason: 'format' });
      return;
    }

    const email = line.slice(0, firstSeparator).trim();
    const password = line.slice(firstSeparator + 1, lastSeparator).trim();
    const secret = line.slice(lastSeparator + 1).trim();
    if (!email || !password || !secret) {
      issues.push({ line: lineNumber, reason: 'empty_field' });
      return;
    }

    const identity = `${email}\u0000${password}\u0000${secret}`;
    if (seen.has(identity)) {
      duplicateCount += 1;
      return;
    }

    seen.add(identity);
    accounts.push({ email, password, secret });
  });

  if (accounts.length > ACCOUNT_POOL_MAX_ACCOUNTS) {
    throw new AccountPoolSourceError('too_many_accounts');
  }

  return { accounts, issues, duplicateCount };
}

export function parseAccountPoolSources(
  sources: AccountPoolNamedSource[]
): AccountPoolMultiParseResult {
  const accounts: PendingAccountInput[] = [];
  const issues: AccountPoolNamedParseIssue[] = [];
  const seen = new Set<string>();
  let duplicateCount = 0;

  sources.forEach(({ name, source }) => {
    const result = parseAccountPoolSource(source);
    duplicateCount += result.duplicateCount;
    issues.push(
      ...result.issues.map((issue) => ({
        ...issue,
        sourceName: name,
      }))
    );

    result.accounts.forEach((account) => {
      const identity = `${account.email}\u0000${account.password}\u0000${account.secret}`;
      if (seen.has(identity)) {
        duplicateCount += 1;
        return;
      }

      seen.add(identity);
      accounts.push(account);
    });
  });

  if (accounts.length > ACCOUNT_POOL_MAX_ACCOUNTS) {
    throw new AccountPoolSourceError('too_many_accounts');
  }

  return { accounts, issues, duplicateCount };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Validate the private server snapshot without trusting its JSON shape.
 * Exact duplicates are removed defensively before the rows reach page state.
 */
export function normalizeAccountPoolServerSnapshot(value: unknown): AccountPoolServerSnapshot {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.accounts)) {
    throw new AccountPoolSnapshotError();
  }

  const accounts: PendingAccountInput[] = [];
  const seen = new Set<string>();
  let duplicateCount = 0;

  value.accounts.forEach((item) => {
    if (
      !isRecord(item) ||
      typeof item.email !== 'string' ||
      typeof item.password !== 'string' ||
      typeof item.secret !== 'string'
    ) {
      throw new AccountPoolSnapshotError();
    }

    const email = item.email.trim();
    const password = item.password;
    const secret = item.secret.trim();
    if (!email || !password || !secret) {
      throw new AccountPoolSnapshotError();
    }

    const identity = `${email}\u0000${password}\u0000${secret}`;
    if (seen.has(identity)) {
      duplicateCount += 1;
      return;
    }

    seen.add(identity);
    accounts.push({ email, password, secret });
  });

  if (accounts.length === 0 || accounts.length > ACCOUNT_POOL_MAX_ACCOUNTS) {
    throw new AccountPoolSnapshotError();
  }

  const declaredCount = value.count;
  if (
    declaredCount !== undefined &&
    (typeof declaredCount !== 'number' || declaredCount !== value.accounts.length)
  ) {
    throw new AccountPoolSnapshotError();
  }

  return {
    version: 1,
    source: typeof value.source === 'string' ? value.source.trim() : '',
    updatedAt: typeof value.updated_at === 'string' ? value.updated_at : '',
    accounts,
    duplicateCount,
  };
}
