import { sha256Hex } from '../docx/zip.js';
import { isCurrentAuthorization, type AuthorizationPayload } from './authorization.js';

export interface IntegrityIssue { code: 'C15'; item: string; reason: string; }

/** Compare current draft bytes and authorization records to Seal's ledger. */
export async function checkIntegrity(input: {
  secret: Uint8Array;
  drafts: Readonly<Record<string, Uint8Array>>;
  expectedDrafts: Readonly<Record<string, string>>;
  authorizations: ReadonlyArray<{ expected: AuthorizationPayload; record: unknown }>;
}): Promise<IntegrityIssue[]> {
  const issues: IntegrityIssue[] = [];
  for (const name of new Set([...Object.keys(input.drafts), ...Object.keys(input.expectedDrafts)])) {
    const draft = input.drafts[name], expected = input.expectedDrafts[name];
    if (!draft || !expected || sha256Hex(draft) !== expected) issues.push({ code: 'C15', item: name, reason: '草稿缺失或与 Seal 最近写入的摘要不一致' });
  }
  for (const authorization of input.authorizations) {
    if (!await isCurrentAuthorization(input.secret, authorization.record, authorization.expected)) {
      issues.push({ code: 'C15', item: authorization.expected.item, reason: '授权签名无效或与当前内容不一致' });
    }
  }
  return issues;
}
