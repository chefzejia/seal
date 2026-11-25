import { bodyHintBlocks, type ViewHint } from '../docx/document-view.js';
import { sha256Hex } from '../docx/zip.js';
import type { ReviewContext } from './human-review.js';

export interface DismissalRecord {
  draft: string;
  address: string;
  blockFingerprint: string;
  hintText: string;
  hintIndex: number;
  reason: string;
  actor: 'agent' | 'human';
  authorization?: unknown;
}
export interface CurrentHint { id: string; draft: string; address: string; blockFingerprint: string; hintText: string; hintIndex: number; kind: ViewHint['kind']; }

export function currentHints(xml: string, draft: string): CurrentHint[] {
  return [...bodyHintBlocks(xml)].flatMap(([address, block]) => block.hints.map((hint, hintIndex) => ({
    id: `${address}#${hintIndex}`, draft, address, blockFingerprint: sha256Hex(block.text), hintText: hint.text, hintIndex, kind: hint.kind,
  })));
}

export function sameHint(record: DismissalRecord, hint: CurrentHint): boolean {
  return record.draft === hint.draft && record.address === hint.address && record.blockFingerprint === hint.blockFingerprint && record.hintText === hint.hintText && record.hintIndex === hint.hintIndex;
}

export function dismissalId(record: DismissalRecord): string {
  return sha256Hex(JSON.stringify([record.draft, record.address, record.blockFingerprint, record.hintText, record.hintIndex]));
}

export function dismissalFingerprint(record: DismissalRecord, context: ReviewContext): string {
  return sha256Hex(JSON.stringify([dismissalId(record), record.actor, record.reason, context.vaultId, context.deadline]));
}
