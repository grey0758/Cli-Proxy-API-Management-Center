import { describe, expect, test } from 'bun:test';
import {
  PhonePoolPayloadError,
  findPhoneBinding,
  normalizePhonePoolSmsResponse,
  normalizePhonePoolSnapshot,
} from '../src/features/phonePool/phonePool';

const snapshotPayload = {
  version: 1,
  updated_at: '2026-07-23T00:00:00Z',
  count: 2,
  enabled_count: 1,
  phones: [
    {
      id: 'phone_one',
      number: '+14438575076',
      enabled: true,
      baseline_bindings: 3,
      recorded_bindings: 1,
      binding_count: 4,
      current_bindings: 1,
    },
    {
      id: 'phone_two',
      number: '+17209875645',
      enabled: false,
      baseline_bindings: 3,
      recorded_bindings: 0,
      binding_count: 3,
      current_bindings: 0,
    },
  ],
  bindings: [
    {
      account_email: 'First@Example.com',
      phone_id: 'phone_one',
      bound_at: '2026-07-23T00:00:00Z',
    },
  ],
};

describe('phone pool API payloads', () => {
  test('normalizes a sanitized snapshot and resolves account bindings case-insensitively', () => {
    const snapshot = normalizePhonePoolSnapshot(snapshotPayload);
    expect(snapshot.count).toBe(2);
    expect(snapshot.phones[0].bindingCount).toBe(4);
    expect(findPhoneBinding(snapshot, 'first@example.com')?.phoneId).toBe('phone_one');
  });

  test('rejects inconsistent binding totals and unknown binding phone IDs', () => {
    expect(() =>
      normalizePhonePoolSnapshot({
        ...snapshotPayload,
        phones: [{ ...snapshotPayload.phones[0], binding_count: 99 }],
        count: 1,
        enabled_count: 1,
        bindings: [],
      })
    ).toThrow(PhonePoolPayloadError);
    expect(() =>
      normalizePhonePoolSnapshot({
        ...snapshotPayload,
        bindings: [{ ...snapshotPayload.bindings[0], phone_id: 'missing' }],
      })
    ).toThrow(PhonePoolPayloadError);
  });

  test('rejects any accidental provider URL or token field', () => {
    expect(() =>
      normalizePhonePoolSnapshot({
        ...snapshotPayload,
        phones: [{ ...snapshotPayload.phones[0], sms_url: 'https://secret.invalid' }],
        count: 1,
        enabled_count: 1,
        bindings: [],
      })
    ).toThrow(PhonePoolPayloadError);
    expect(() =>
      normalizePhonePoolSmsResponse({
        phone_id: 'phone_one',
        number: '+14438575076',
        provider_status: 200,
        content_type: 'application/json',
        body: '{}',
        truncated: false,
        fetched_at: '2026-07-23T00:00:00Z',
        token: 'must-not-pass',
      })
    ).toThrow(PhonePoolPayloadError);
  });

  test('normalizes an escaped text response without interpreting HTML', () => {
    const response = normalizePhonePoolSmsResponse({
      phone_id: 'phone_one',
      number: '+14438575076',
      provider_status: 200,
      content_type: 'text/plain',
      body: '<script>alert(1)</script>',
      truncated: false,
      fetched_at: '2026-07-23T00:00:00Z',
    });
    expect(response.body).toBe('<script>alert(1)</script>');
  });
});
