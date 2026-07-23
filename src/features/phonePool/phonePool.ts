export const PHONE_POOL_MAX_IMPORT_BYTES = 256 * 1024;

export interface PhonePoolPhone {
  id: string;
  number: string;
  enabled: boolean;
  baselineBindings: number;
  recordedBindings: number;
  bindingCount: number;
  currentBindings: number;
}

export interface PhonePoolBinding {
  accountEmail: string;
  phoneId: string;
  boundAt: string;
}

export interface PhonePoolSnapshot {
  version: 1;
  updatedAt: string;
  count: number;
  enabledCount: number;
  phones: PhonePoolPhone[];
  bindings: PhonePoolBinding[];
}

export interface PhonePoolSmsResponse {
  phoneId: string;
  number: string;
  providerStatus: number;
  contentType: string;
  body: string;
  truncated: boolean;
  fetchedAt: string;
}

export class PhonePoolPayloadError extends Error {
  constructor() {
    super('phone_pool_payload_invalid');
    this.name = 'PhonePoolPayloadError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const hasForbiddenSecretField = (value: Record<string, unknown>): boolean =>
  Object.keys(value).some((key) =>
    ['provider_url', 'sms_url', 'token'].includes(key.toLowerCase())
  );

export function normalizePhonePoolSnapshot(value: unknown): PhonePoolSnapshot {
  if (
    !isRecord(value) ||
    hasForbiddenSecretField(value) ||
    value.version !== 1 ||
    !Array.isArray(value.phones) ||
    !Array.isArray(value.bindings)
  ) {
    throw new PhonePoolPayloadError();
  }

  const phones: PhonePoolPhone[] = [];
  const phoneIds = new Set<string>();
  const phoneNumbers = new Set<string>();
  value.phones.forEach((item) => {
    if (
      !isRecord(item) ||
      hasForbiddenSecretField(item) ||
      typeof item.id !== 'string' ||
      typeof item.number !== 'string' ||
      typeof item.enabled !== 'boolean' ||
      !isNonNegativeInteger(item.baseline_bindings) ||
      !isNonNegativeInteger(item.recorded_bindings) ||
      !isNonNegativeInteger(item.binding_count) ||
      !isNonNegativeInteger(item.current_bindings) ||
      item.binding_count !== item.baseline_bindings + item.recorded_bindings ||
      !/^\+\d{8,15}$/.test(item.number) ||
      phoneIds.has(item.id) ||
      phoneNumbers.has(item.number)
    ) {
      throw new PhonePoolPayloadError();
    }
    phoneIds.add(item.id);
    phoneNumbers.add(item.number);
    phones.push({
      id: item.id,
      number: item.number,
      enabled: item.enabled,
      baselineBindings: item.baseline_bindings,
      recordedBindings: item.recorded_bindings,
      bindingCount: item.binding_count,
      currentBindings: item.current_bindings,
    });
  });

  const bindings: PhonePoolBinding[] = value.bindings.map((item) => {
    if (
      !isRecord(item) ||
      hasForbiddenSecretField(item) ||
      typeof item.account_email !== 'string' ||
      typeof item.phone_id !== 'string' ||
      typeof item.bound_at !== 'string' ||
      !item.account_email.trim() ||
      !phoneIds.has(item.phone_id)
    ) {
      throw new PhonePoolPayloadError();
    }
    return {
      accountEmail: item.account_email,
      phoneId: item.phone_id,
      boundAt: item.bound_at,
    };
  });

  const declaredCount = value.count;
  const declaredEnabledCount = value.enabled_count;
  if (
    !isNonNegativeInteger(declaredCount) ||
    !isNonNegativeInteger(declaredEnabledCount) ||
    declaredCount !== phones.length ||
    declaredEnabledCount !== phones.filter((phone) => phone.enabled).length
  ) {
    throw new PhonePoolPayloadError();
  }

  return {
    version: 1,
    updatedAt: typeof value.updated_at === 'string' ? value.updated_at : '',
    count: declaredCount,
    enabledCount: declaredEnabledCount,
    phones,
    bindings,
  };
}

export function normalizePhonePoolSmsResponse(value: unknown): PhonePoolSmsResponse {
  if (
    !isRecord(value) ||
    hasForbiddenSecretField(value) ||
    typeof value.phone_id !== 'string' ||
    typeof value.number !== 'string' ||
    !/^\+\d{8,15}$/.test(value.number) ||
    typeof value.provider_status !== 'number' ||
    !Number.isInteger(value.provider_status) ||
    typeof value.content_type !== 'string' ||
    typeof value.body !== 'string' ||
    typeof value.truncated !== 'boolean' ||
    typeof value.fetched_at !== 'string'
  ) {
    throw new PhonePoolPayloadError();
  }
  return {
    phoneId: value.phone_id,
    number: value.number,
    providerStatus: value.provider_status,
    contentType: value.content_type,
    body: value.body,
    truncated: value.truncated,
    fetchedAt: value.fetched_at,
  };
}

export function findPhoneBinding(
  snapshot: PhonePoolSnapshot | null,
  accountEmail: string
): PhonePoolBinding | null {
  const normalized = accountEmail.trim().toLocaleLowerCase();
  return (
    snapshot?.bindings.find(
      (binding) => binding.accountEmail.trim().toLocaleLowerCase() === normalized
    ) ?? null
  );
}
