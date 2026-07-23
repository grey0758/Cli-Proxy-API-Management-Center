import { createHash } from 'node:crypto';
import { chmod, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { parseAccountPoolSources } from '../src/features/accountPool/accountPool';
import { generateTotp } from '../src/features/accountPool/totp';

const args = process.argv.slice(2);
const outputFlag = args.indexOf('--output');
const labelFlag = args.indexOf('--label');

if (outputFlag < 0 || !args[outputFlag + 1]) {
  throw new Error('usage: --output <private-json-path> [--label <name>] <source...>');
}

const outputPath = resolve(args[outputFlag + 1]);
const label =
  labelFlag >= 0 && args[labelFlag + 1] ? args[labelFlag + 1] : 'primary private account pool';
const consumed = new Set([outputFlag, outputFlag + 1]);
if (labelFlag >= 0) {
  consumed.add(labelFlag);
  consumed.add(labelFlag + 1);
}
const sourcePaths = args.filter((_, index) => !consumed.has(index)).map((path) => resolve(path));

if (sourcePaths.length === 0) {
  throw new Error('at least one account-list source is required');
}

const sources = await Promise.all(
  sourcePaths.map(async (path) => ({
    name: basename(path),
    source: await Bun.file(path).text(),
  }))
);
const result = parseAccountPoolSources(sources);

if (result.issues.length > 0) {
  const locations = result.issues
    .slice(0, 20)
    .map((issue) => `${issue.sourceName}:${issue.line}`)
    .join(',');
  throw new Error(`invalid account rows at ${locations}`);
}

let invalidTotpCount = 0;
result.accounts.forEach((account) => {
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
  count: result.accounts.length,
  accounts: result.accounts,
};
const serialized = `${JSON.stringify(payload, null, 2)}\n`;

await writeFile(outputPath, serialized, { encoding: 'utf8', mode: 0o600 });
await chmod(outputPath, 0o600);

const summary = {
  sources: sourcePaths.length,
  accounts: result.accounts.length,
  duplicates: result.duplicateCount,
  invalidRows: result.issues.length,
  invalidTotp: invalidTotpCount,
  bytes: Buffer.byteLength(serialized),
  sha256: createHash('sha256').update(serialized).digest('hex'),
  mode: '0600',
};
process.stdout.write(`${JSON.stringify(summary)}\n`);
