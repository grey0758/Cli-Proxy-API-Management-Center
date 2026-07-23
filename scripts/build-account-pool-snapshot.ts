import { createHash } from 'node:crypto';
import { chmod, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import {
  ACCOUNT_POOL_MAX_ACCOUNTS,
  parseAccountPoolSource,
  type AccountPoolAccountInput,
  type AccountPoolNamedParseIssue,
  type AccountPoolStatus,
} from '../src/features/accountPool/accountPool';
import { generateTotp } from '../src/features/accountPool/totp';

const args = process.argv.slice(2);
let outputPath = '';
let label = 'primary private account pool';
const sourceSpecs: Array<{ path: string; status: AccountPoolStatus }> = [];

for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === '--output' || argument === '--label') {
    const value = args[index + 1];
    if (!value) throw new Error(`missing value for ${argument}`);
    if (argument === '--output') outputPath = resolve(value);
    if (argument === '--label') label = value;
    index += 1;
    continue;
  }

  if (argument === '--pending-source' || argument === '--imported-source') {
    const value = args[index + 1];
    if (!value) throw new Error(`missing value for ${argument}`);
    sourceSpecs.push({
      path: resolve(value),
      status: argument === '--imported-source' ? 'imported' : 'pending',
    });
    index += 1;
    continue;
  }

  if (argument.startsWith('--')) {
    throw new Error(`unknown option: ${argument}`);
  }

  sourceSpecs.push({ path: resolve(argument), status: 'pending' });
}

if (!outputPath) {
  throw new Error(
    'usage: --output <private-json-path> [--label <name>] ' +
      '[--imported-source <path>] [--pending-source <path>] [source...]'
  );
}

if (sourceSpecs.length === 0) {
  throw new Error('at least one account-list source is required');
}

const sources = await Promise.all(
  sourceSpecs.map(async ({ path, status }) => ({
    name: basename(path),
    source: await Bun.file(path).text(),
    status,
  }))
);

const accounts: AccountPoolAccountInput[] = [];
const issues: AccountPoolNamedParseIssue[] = [];
const seen = new Map<string, number>();
let duplicateCount = 0;

sources.forEach(({ name, source, status }) => {
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
    const existingIndex = seen.get(identity);
    if (existingIndex !== undefined) {
      duplicateCount += 1;
      if (status === 'imported') {
        accounts[existingIndex].status = 'imported';
      }
      return;
    }

    seen.set(identity, accounts.length);
    accounts.push({ ...account, status });
  });
});

if (accounts.length > ACCOUNT_POOL_MAX_ACCOUNTS) {
  throw new Error(`too many accounts: ${accounts.length}`);
}

if (issues.length > 0) {
  const locations = issues
    .slice(0, 20)
    .map((issue) => `${issue.sourceName}:${issue.line}`)
    .join(',');
  throw new Error(`invalid account rows at ${locations}`);
}

let invalidTotpCount = 0;
accounts.forEach((account) => {
  try {
    generateTotp(account.secret);
  } catch {
    invalidTotpCount += 1;
  }
});
if (invalidTotpCount > 0) {
  throw new Error(`invalid TOTP secrets: ${invalidTotpCount}`);
}

const payload = {
  version: 1,
  source: label,
  updated_at: new Date().toISOString(),
  count: accounts.length,
  accounts,
};
const serialized = `${JSON.stringify(payload, null, 2)}\n`;

await writeFile(outputPath, serialized, { encoding: 'utf8', mode: 0o600 });
await chmod(outputPath, 0o600);

const summary = {
  sources: sourceSpecs.length,
  accounts: accounts.length,
  pending: accounts.filter((account) => account.status === 'pending').length,
  imported: accounts.filter((account) => account.status === 'imported').length,
  duplicates: duplicateCount,
  invalidRows: issues.length,
  invalidTotp: invalidTotpCount,
  bytes: Buffer.byteLength(serialized),
  sha256: createHash('sha256').update(serialized).digest('hex'),
  mode: '0600',
};
process.stdout.write(`${JSON.stringify(summary)}\n`);
