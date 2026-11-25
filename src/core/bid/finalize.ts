import type { HostPort } from '../host.js';
import { finalizeDocument, type FinalizeMark } from '../docx/finalize-document.js';
import { sha256Hex } from '../docx/zip.js';
import { checkDraft } from './check.js';
import { resolveLedger } from './ledger-integrity.js';
import type { ProjectMetadata } from './project.js';

/** Human-only caller must apply the complete finalization gate before exporting. */
export async function finalizeDraftMarkers(host: HostPort, input: {
  name: string; root: string; draft: Uint8Array; base: Uint8Array;
  ledger: unknown; anchor: unknown; project: ProjectMetadata; secret: Uint8Array;
}): Promise<Uint8Array> {
  const { name, root, draft, base, project, secret, anchor } = input;
  if (!anchor || secret.length < 32) throw new Error('定稿需要可信台账锚点与授权密钥');
  const report = await checkDraft(host, input) as { results: Record<string, unknown[]> };
  for (const group of ['C01', 'C04', 'C15', 'C16']) if (!Array.isArray(report.results[group]) || report.results[group].length) throw new Error(`定稿标记无法核验：${group}`);
  const ledger = await resolveLedger(input.ledger, root, secret, anchor);
  if (ledger.bases?.[name] !== sha256Hex(base) || ledger.drafts[name] !== sha256Hex(draft)) throw new Error('定稿基准或草稿摘要无法核验');
  const marks: FinalizeMark[] = ledger.pending.filter(item => item.draft === name && item.status !== 'removed').map(item => {
    if (item.status !== 'confirmed') throw new Error('定稿标记缺少人审确认');
    return { id: item.id, state: 'confirmed', originalHighlights: item.originalHighlights };
  });
  return finalizeDocument(draft, base, { draftSha256: ledger.drafts[name], baseSha256: ledger.bases[name], marks }, host);
}
