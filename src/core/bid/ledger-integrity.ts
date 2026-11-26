import { sha256Hex } from '../docx/zip.js';
import type { BidLedger } from './project.js';
import { isCurrentAuthorization, signAuthorization } from './authorization.js';

function canonical(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, normalize(child)]));
    return item;
  };
  return JSON.stringify(normalize(value)) ?? 'null';
}

async function signature(secret: Uint8Array, root: string, snapshot: string): Promise<string> {
  if (secret.length < 32) throw new Error('台账密钥长度不足');
  const key = await crypto.subtle.importKey('raw', secret as unknown as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const data = new TextEncoder().encode(JSON.stringify(['seal-ledger-v1', root, snapshot]));
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, data as unknown as BufferSource));
  return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
}

async function verifiedSnapshot(value: unknown, root: string, secret: Uint8Array | null): Promise<{ snapshot: string; ledger: BidLedger } | null> {
  if (!secret || !value || typeof value !== 'object') return null;
  const seal = value as { snapshot?: unknown; signature?: unknown };
  if (typeof seal.snapshot !== 'string' || typeof seal.signature !== 'string' || !/^[0-9a-f]{64}$/.test(seal.signature) || secret.length < 32) return null;
  const key = await crypto.subtle.importKey('raw', secret as unknown as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const data = new TextEncoder().encode(JSON.stringify(['seal-ledger-v1', root, seal.snapshot]));
  const bytes = Uint8Array.from(seal.signature.match(/../g)!, byte => Number.parseInt(byte, 16));
  if (!await crypto.subtle.verify('HMAC', key, bytes as unknown as BufferSource, data as unknown as BufferSource)) return null;
  try {
    const parsed: unknown = JSON.parse(seal.snapshot);
    return validLedger(parsed) ? { snapshot: seal.snapshot, ledger: parsed } : null;
  } catch { return null; }
}

function validLedger(value: unknown): value is BidLedger {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<BidLedger>;
  return item.format === 'seal-ledger-1' && !Object.hasOwn(item, 'hints') && Array.isArray(item.pending) && Array.isArray(item.dismissals) && Array.isArray(item.fills) && Array.isArray(item.acceptedChanges) && Array.isArray(item.requirements) && !!item.drafts && typeof item.drafts === 'object' && !Array.isArray(item.drafts);
}

export async function sealLedger(ledger: BidLedger, root: string, secret: Uint8Array): Promise<void> {
  const { integrity: _integrity, ...contents } = ledger;
  const snapshot = canonical(contents);
  ledger.integrity = { snapshot, signature: await signature(secret, root, snapshot) };
}

export async function resolveLedger(value: unknown, root: string, secret: Uint8Array | null, anchor?: unknown): Promise<BidLedger> {
  const untrusted = canonical(value), candidate = value && typeof value === 'object' && !Array.isArray(value) ? value as Partial<BidLedger> : {};
  if (Object.hasOwn(candidate, 'hints')) throw new Error('不支持旧版提示身份台账，请新建项目；不会自动迁移');
  const local = await verifiedSnapshot(candidate.integrity, root, secret);
  const external = anchor === undefined ? undefined : await verifiedSnapshot(anchor, root, secret);
  const trusted = external === undefined ? local : external;
  const original = trusted?.ledger ?? null;
  const { integrity: _integrity, ...contents } = candidate;
  if (local && trusted && canonical(contents) === trusted.snapshot && local.snapshot === trusted.snapshot && validLedger(candidate) && (external === undefined || external !== null)) return candidate;
  const recovered: BidLedger = original ?? { format: 'seal-ledger-1', fills: [], pending: [], dismissals: [], acceptedChanges: [], requirements: [], drafts: {} };
  recovered.integrityIncident = { reason: external === null ? '项目外台账锚点缺失或无效' : original ? '台账与已签名快照不一致' : '台账封印缺失或无效', untrustedHash: sha256Hex(untrusted), untrusted, recoveryNeeded: !original };
  delete recovered.integrity;
  return recovered;
}

export function incidentFingerprint(incident: NonNullable<BidLedger['integrityIncident']>, note: string): string {
  return sha256Hex(JSON.stringify([incident.reason, incident.untrustedHash, incident.recoveryNeeded, note]));
}

export async function acknowledgeLedgerRecovery(ledger: BidLedger, root: string, secret: Uint8Array, note: string): Promise<void> {
  const incident = ledger.integrityIncident;
  if (!incident || !note.trim()) throw new Error('恢复台账时必须填写核对说明');
  incident.resolution = { note, authorization: await signAuthorization(secret, { kind: 'recover', project: root, item: 'ledger', fingerprint: incidentFingerprint(incident, note) }) };
}

/** Return true when ledger.integrityIncident exists and lacks a valid current recovery authorization. */
export async function hasUnresolvedLedgerIncident(
  ledger: BidLedger,
  root: string,
  secret: Uint8Array | null,
): Promise<boolean> {
  const incident = ledger.integrityIncident;
  if (!incident) return false;
  const resolution = incident.resolution as
    | { note?: unknown; authorization?: unknown }
    | undefined;
  const note = typeof resolution?.note === 'string' ? resolution.note : '';
  const valid =
    !!secret &&
    !!note.trim() &&
    (await isCurrentAuthorization(secret, resolution?.authorization, {
      kind: 'recover',
      project: root,
      item: 'ledger',
      fingerprint: incidentFingerprint(incident, note),
    }));
  return !valid;
}
