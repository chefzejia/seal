import type { Difference } from '../docx/compare.js';
import { sealRanges, type SealRange } from '../docx/seal-ranges.js';
import { auditSealPending } from '../docx/pending-audit.js';
import { sha256Hex } from '../docx/zip.js';
import { signAuthorization } from './authorization.js';
import { currentHints, dismissalFingerprint, dismissalId, sameHint, type DismissalRecord } from './dismissals.js';
import { pendingFingerprint } from './pending-fingerprint.js';
import type { BidLedger } from './project.js';
export { confirmOutline, type OutlineConfirmation } from './outline.js';

export interface ReviewContext { root: string; vaultId: string | null; deadline: string }
export interface AcceptedChange { draft: string; id: string; authorization: unknown }
export interface CoverageMark { id: string; draft: string; address: string; requirement: string; response: string; authorization: unknown }
export interface DraftReviewCache {
  hints?: Map<string, ReturnType<typeof currentHints>[number]>;
  ranges?: Map<string, SealRange>;
  pendingAuditFailed?: Set<string>;
}

export function changeFingerprint(draft: string, change: Difference, context: ReviewContext): string {
  return sha256Hex(JSON.stringify([draft, change.id, change.kind, change.address, change.before, change.after, context.vaultId, context.deadline]));
}

export function coverageFingerprint(mark: Omit<CoverageMark, 'authorization'>, context: ReviewContext): string {
  return sha256Hex(JSON.stringify([mark.id, mark.draft, mark.address, mark.requirement, mark.response, context.vaultId, context.deadline]));
}

export async function reviewHint(ledger: BidLedger, draft: string, id: string, documentXml: string, context: ReviewContext, secret: Uint8Array, reason = '人工跳过', cache?: DraftReviewCache): Promise<void> {
  if (cache && !cache.hints) {
    cache.hints = new Map(currentHints(documentXml, draft).map(item => [item.id, item]));
  }
  const hint = cache ? cache.hints!.get(id) : currentHints(documentXml, draft).find(item => item.id === id);
  if (!hint) throw new Error('提示不存在，请重新读取');
  const existing = ledger.dismissals.find(item => sameHint(item, hint));
  let record = existing;
  if (!record) {
    if (!reason.trim()) throw new Error('跳过空白必须填写理由');
    record = { draft, address: hint.address, blockFingerprint: hint.blockFingerprint, hintText: hint.hintText, hintIndex: hint.hintIndex, reason, actor: 'human' } satisfies DismissalRecord;
  }
  const kind = record.actor === 'agent' ? 'acknowledge' : 'dismiss';
  const authorization = await signAuthorization(secret, { kind, project: context.root, item: dismissalId(record), fingerprint: dismissalFingerprint(record, context) });
  record.authorization = authorization;
  if (!existing) ledger.dismissals.push(record);
}

export async function confirmPending(ledger: BidLedger, draft: string, id: string, documentXml: string, context: ReviewContext, secret: Uint8Array, cache?: DraftReviewCache): Promise<void> {
  const found = ledger.pending.filter(item => item.draft === draft && item.id === id && item.status !== 'removed');
  if (found.length !== 1) throw new Error('待定项不存在或不唯一');
  const item = found[0], name = `_Seal_P_${id}`;
  let range: SealRange | undefined;
  let auditFailed: boolean;
  if (cache) {
    if (!cache.ranges) {
      cache.ranges = new Map(sealRanges(documentXml).map(candidate => [candidate.name, candidate]));
    }
    if (!cache.pendingAuditFailed) {
      const names = [...cache.ranges.keys()].filter(candidate => candidate.startsWith('_Seal_P_'));
      cache.pendingAuditFailed = new Set(auditSealPending(documentXml, names).map(issue => issue.id));
    }
    range = cache.ranges.get(name);
    auditFailed = cache.pendingAuditFailed.has(name);
  } else {
    range = sealRanges(documentXml).find(candidate => candidate.name === name);
    auditFailed = auditSealPending(documentXml, [name]).length > 0;
  }
  if (!range || auditFailed) throw new Error('待定范围缺失或黄标不完整，请重新核对');
  item.confirmation = await signAuthorization(secret, { kind: 'confirm', project: context.root, item: id, fingerprint: pendingFingerprint(item, range.text, context) });
  item.status = 'confirmed';
}

export async function acceptChange(ledger: BidLedger, draft: string, change: Difference, context: ReviewContext, secret: Uint8Array): Promise<void> {
  if (!['modified', 'deleted', 'formatChanged', 'objectLost'].includes(change.kind)) throw new Error('该差异无需接受');
  const record: AcceptedChange = { draft, id: change.id, authorization: await signAuthorization(secret, { kind: 'accept', project: context.root, item: change.id, fingerprint: changeFingerprint(draft, change, context) }) };
  ledger.acceptedChanges = ledger.acceptedChanges.filter(item => !(item && typeof item === 'object' && (item as AcceptedChange).draft === draft && (item as AcceptedChange).id === change.id));
  ledger.acceptedChanges.push(record);
}

export async function markCoverage(ledger: BidLedger, mark: Omit<CoverageMark, 'authorization'>, context: ReviewContext, secret: Uint8Array): Promise<void> {
  if (![mark.id, mark.draft, mark.address, mark.requirement, mark.response].every(value => typeof value === 'string' && value.trim())) throw new Error('覆盖标记缺少要求或响应位置');
  const authorization = await signAuthorization(secret, { kind: 'coverage', project: context.root, item: mark.id, fingerprint: coverageFingerprint(mark, context) });
  ledger.requirements = ledger.requirements.filter(item => !(item && typeof item === 'object' && (item as CoverageMark).id === mark.id));
  ledger.requirements.push({ ...mark, authorization });
}
