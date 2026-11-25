import { sha256Hex } from '../docx/zip.js';
import type { PendingRecord } from './project.js';

export function pendingFingerprint(item: PendingRecord, text: string, context: { vaultId: string | null; deadline: string }): string {
  return sha256Hex(JSON.stringify([item.draft, item.id, text, item.category, context.vaultId, context.deadline]));
}
