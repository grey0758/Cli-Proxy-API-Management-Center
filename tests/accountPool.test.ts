import { describe, expect, test } from 'bun:test';
import {
  AccountPoolSourceError,
  extractAccountPoolLines,
  parseAccountPoolSource,
} from '../src/features/accountPool/accountPool';
import { generateTotp, normalizeTotpSecret } from '../src/features/accountPool/totp';

describe('pending account pool source parsing', () => {
  test('parses the cami-list rawLines array without evaluating its HTML', () => {
    const html = `<!doctype html><script>const rawLines = [
      "first@example.com|pass-1|JBSWY3DPEHPK3PXP",
      "second@example.com|pass|with|pipes|JBSWY3DPEHPK3PXP"
    ];</script>`;

    expect(extractAccountPoolLines(html)).toHaveLength(2);
    const result = parseAccountPoolSource(html);
    expect(result.issues).toEqual([]);
    expect(result.accounts).toEqual([
      {
        email: 'first@example.com',
        password: 'pass-1',
        secret: 'JBSWY3DPEHPK3PXP',
      },
      {
        email: 'second@example.com',
        password: 'pass|with|pipes',
        secret: 'JBSWY3DPEHPK3PXP',
      },
    ]);
  });

  test('supports plain rows, comments, a header, and exact duplicate removal', () => {
    const result = parseAccountPoolSource(`
      # local staging data
      email|password|secret
      first@example.com|pass-1|JBSWY3DPEHPK3PXP
      first@example.com|pass-1|JBSWY3DPEHPK3PXP
      second@example.com|pass-2|JBSWY3DPEHPK3PXP
    `);

    expect(result.accounts).toHaveLength(2);
    expect(result.duplicateCount).toBe(1);
    expect(result.issues).toEqual([]);
  });

  test('reports only line numbers and reason codes for malformed input', () => {
    const result = parseAccountPoolSource('good@example.com|pass|SECRET\nnot-a-row\n|pass|SECRET');
    expect(result.accounts).toHaveLength(1);
    expect(result.issues).toEqual([
      { line: 2, reason: 'format' },
      { line: 3, reason: 'format' },
    ]);
    expect(JSON.stringify(result.issues)).not.toContain('not-a-row');
  });

  test('rejects HTML that does not contain a rawLines array', () => {
    expect(() => parseAccountPoolSource('<!doctype html><p>no account data</p>')).toThrow(
      AccountPoolSourceError
    );
  });

  test('never executes JavaScript surrounding an embedded account list', () => {
    const marker = globalThis as typeof globalThis & { __accountPoolExecuted?: boolean };
    delete marker.__accountPoolExecuted;

    const result = parseAccountPoolSource(`<!doctype html><script>
      globalThis.__accountPoolExecuted = true;
      const rawLines = ["safe@example.com|pass|JBSWY3DPEHPK3PXP"];
    </script>`);

    expect(result.accounts).toHaveLength(1);
    expect(marker.__accountPoolExecuted).toBeUndefined();
  });

  test('enforces the unique account safety limit', () => {
    const source = Array.from(
      { length: 1001 },
      (_, index) => `account-${index}@example.com|pass-${index}|JBSWY3DPEHPK3PXP`
    ).join('\n');

    expect(() => parseAccountPoolSource(source)).toThrow('too_many_accounts');
  });
});

describe('pending account pool TOTP', () => {
  test('matches RFC 6238 SHA-1 vectors when reduced to six digits', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    expect(generateTotp(secret, 59_000)).toBe('287082');
    expect(generateTotp(secret, 1_111_111_109_000)).toBe('081804');
    expect(generateTotp(secret, 1_234_567_890_000)).toBe('005924');
  });

  test('normalizes spacing, hyphens, casing, and padding', () => {
    expect(normalizeTotpSecret('jbsw y3dp-ehpk3pxp===')).toBe('JBSWY3DPEHPK3PXP');
  });

  test('rejects invalid Base32 secrets', () => {
    expect(() => generateTotp('invalid-0189', 59_000)).toThrow('invalid_base32');
  });
});
