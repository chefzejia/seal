export interface AuthorizationPayload {
  kind: 'confirm' | 'accept' | 'acknowledge' | 'dismiss' | 'coverage' | 'recover' | 'pending_removed' | 'outline_confirm';
  project: string;
  item: string;
  fingerprint: string;
}

export interface SignedAuthorization { payload: AuthorizationPayload; signature: string; }

function bytes(payload: AuthorizationPayload): Uint8Array {
  return new TextEncoder().encode(JSON.stringify([payload.kind, payload.project, payload.item, payload.fingerprint]));
}

async function hmacKey(secret: Uint8Array): Promise<CryptoKey> {
  if (secret.length < 32) throw new Error('授权密钥长度不足');
  return crypto.subtle.importKey('raw', secret as unknown as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signAuthorization(secret: Uint8Array, payload: AuthorizationPayload): Promise<SignedAuthorization> {
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), bytes(payload) as unknown as BufferSource));
  return { payload: { ...payload }, signature: [...signature].map(value => value.toString(16).padStart(2, '0')).join('') };
}

export async function verifyAuthorization(secret: Uint8Array, value: unknown): Promise<boolean> {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<SignedAuthorization>;
  if (typeof record.signature !== 'string' || !/^[0-9a-f]{64}$/.test(record.signature) || !record.payload || typeof record.payload !== 'object') return false;
  const payload = record.payload;
  if (!['confirm', 'accept', 'acknowledge', 'dismiss', 'coverage', 'recover', 'pending_removed', 'outline_confirm'].includes(payload.kind) ||
      [payload.project, payload.item, payload.fingerprint].some(field => typeof field !== 'string' || field.length === 0)) return false;
  const signature = Uint8Array.from(record.signature.match(/../g)!, byte => Number.parseInt(byte, 16));
  return crypto.subtle.verify('HMAC', await hmacKey(secret), signature as unknown as BufferSource, bytes(payload) as unknown as BufferSource);
}

/** A valid signature from another item or an earlier value is not current authority. */
export async function isCurrentAuthorization(secret: Uint8Array, value: unknown, expected: AuthorizationPayload): Promise<boolean> {
  if (!await verifyAuthorization(secret, value)) return false;
  const payload = (value as SignedAuthorization).payload;
  return payload.kind === expected.kind && payload.project === expected.project &&
    payload.item === expected.item && payload.fingerprint === expected.fingerprint;
}
