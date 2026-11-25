import type { HostPort } from '../host.js';
import { validatePackageStructure } from '../docx/package-structure.js';
import { extractRanges, type ExtractionRange } from '../docx/range-extraction.js';
import { bodyHintBlocks } from '../docx/document-view.js';
import { sha256Hex } from '../docx/zip.js';
import { isValidDate } from './dates.js';
import { sealLedger } from './ledger-integrity.js';
import type { DismissalRecord } from './dismissals.js';
import type { PendingReason, PendingCategory } from './policy.js';
import type { FactSource } from './facts.js';

export interface ProjectDocument { original: string; copy: string; sha256: string; sourceSha256: string; sourceCopy?: string; }
export interface ProjectMetadata {
  format: 'seal-project-1';
  name: string;
  deadline: string;
  vaultId: string | null;
  tenders: ProjectDocument[];
  drafts: string[];
  createdAt: string;
}
export interface ProjectLedger {
  format: 'seal-ledger-1';
  fills: FactFill[];
  pending: PendingRecord[];
  dismissals: DismissalRecord[];
  acceptedChanges: unknown[];
  requirements: unknown[];
  drafts: Record<string, string>;
  bases?: Record<string, string>;
  tenders?: Record<string, string>;
  integrity?: { snapshot: string; signature: string };
  integrityIncident?: { reason: string; untrustedHash: string; untrusted: string; recoveryNeeded: boolean; resolution?: unknown };
}

export interface FactFill { id: string; draft: string; operation: string; reference: string; sources?: FactSource[]; resolvedValue: string; verified: boolean; sealKind?: 'fact' | 'pending'; thirdPartyHolder?: string; status?: 'active' | 'removed'; }
export type PendingRecord = { id: string; draft: string; category: PendingCategory; note: string; reasons: PendingReason[]; status: 'open' | 'confirmed' | 'removed'; originalHighlights: Array<string | null>; confirmation?: unknown };
export type BidLedger = ProjectLedger;

function validDate(date: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return false;
  return isValidDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

/** Initialize a new project directory with copies, never writes to a source path. */
export async function initializeProject(host: HostPort, root: string, options: {
  name: string; deadline: string; vaultId?: string | null; tenders: readonly string[]; createdAt: string;
}): Promise<ProjectMetadata> {
  if (!options.name.trim() || !validDate(options.deadline) || !options.tenders.length) throw new Error('项目名称、有效截标日和招标文件均为必填');
  if (!host.makeDirectory) throw new Error('宿主不支持创建项目目录');
  if (!host.authorizationKey || !host.ledgerAnchorPath) throw new Error('宿主不支持台账密钥与锚点');
  if ((await host.stat(root)).exists) throw new Error('项目目录已存在，请选择新目录');
  const sourceBytes: Uint8Array[] = [];
  for (const source of options.tenders) {
    if (/\.docx$/i.test(source)) {
      const data = await host.readBytes(source);
      await validatePackageStructure(data);
      sourceBytes.push(data);
    } else if (/\.doc$/i.test(source)) {
      if (!host.convertDocToDocx) throw new Error('宿主不支持转换 DOC 文件');
      sourceBytes.push(await host.readBytes(source));
    } else throw new Error('招标文件必须为 DOC 或 DOCX');
  }
  await host.makeDirectory(root);
  for (const directory of ['tender', 'materials', 'draft', 'review', 'final']) await host.makeDirectory(host.joinPath(root, directory));
  const tenderPaths: ProjectDocument[] = [];
  for (let index = 0; index < options.tenders.length; index++) {
    let data = sourceBytes[index];
    let sourceCopy: string | undefined;
    if (/\.doc$/i.test(options.tenders[index])) {
      sourceCopy = `tender/source-${index + 1}.doc`;
      const sourcePath = host.joinPath(root, sourceCopy);
      await host.writeBytes(sourcePath, data);
      const outDir = host.joinPath(root, 'tender', `conversion-${index + 1}`);
      await host.makeDirectory(outDir);
      const converted = await host.convertDocToDocx!(sourcePath, outDir);
      if (host.dirname(converted) !== outDir) throw new Error('转换结果不在项目转换目录中');
      data = await host.readBytes(converted);
      await validatePackageStructure(data);
    }
    const copy = `tender/${index + 1}.docx`;
    await host.writeBytes(host.joinPath(root, copy), data);
    tenderPaths.push({ original: options.tenders[index], copy, sha256: sha256Hex(data), sourceSha256: sha256Hex(sourceBytes[index]), ...(sourceCopy ? { sourceCopy } : {}) });
  }
  const project: ProjectMetadata = { format: 'seal-project-1', name: options.name, deadline: options.deadline, vaultId: options.vaultId ?? null, tenders: tenderPaths, drafts: [], createdAt: options.createdAt };
  const ledger: ProjectLedger = { format: 'seal-ledger-1', fills: [], pending: [], dismissals: [], acceptedChanges: [], requirements: [], drafts: {}, bases: {}, tenders: Object.fromEntries(tenderPaths.map(item => [item.copy, item.sha256])) };
  const key = await host.authorizationKey(true);
  if (!key) throw new Error('无法创建台账密钥');
  await sealLedger(ledger as BidLedger, root, key);
  await host.writeText(host.joinPath(root, 'seal-project.json'), JSON.stringify(project, null, 2));
  await host.writeText(host.joinPath(root, 'ledger.json'), JSON.stringify(ledger, null, 2));
  await host.writeText(await host.ledgerAnchorPath(root, true), JSON.stringify(ledger.integrity));
  return project;
}

export async function readProject(host: HostPort, root: string): Promise<ProjectMetadata> {
  const project: unknown = JSON.parse(await host.readText(host.joinPath(root, 'seal-project.json')));
  if (!project || typeof project !== 'object') throw new Error('项目信息无效');
  const value = project as Partial<ProjectMetadata>;
  if (value.format !== 'seal-project-1' || typeof value.name !== 'string' || typeof value.deadline !== 'string' || !validDate(value.deadline) || !Array.isArray(value.tenders) || !Array.isArray(value.drafts)) throw new Error('项目信息无效');
  return value as ProjectMetadata;
}

export async function prepareExtractedDraft(project: ProjectMetadata, ledger: BidLedger, name: string, source: Uint8Array, ranges: ExtractionRange[], host: Pick<HostPort, 'validateImage'> = {}) {
  if (project.drafts.includes(name)) throw new Error('分册已存在');
  const result = await extractRanges(source, ranges, host);
  const parts = await validatePackageStructure(result.draft);
  const xml = new TextDecoder('utf-8', { fatal: true }).decode(parts.get('word/document.xml')!);
  ledger.drafts[name] = sha256Hex(result.draft);
  (ledger.bases ??= {})[name] = sha256Hex(result.base);
  const hints = [...bodyHintBlocks(xml).values()].reduce((count, block) => count + block.hints.length, 0);
  project.drafts.push(name);
  return { ...result, hints };
}

export async function persistExtractedDraft(host: HostPort, input: {
  basePath: string; draftPath: string; projectPath: string; ledgerPath: string; anchorPath: string;
  base: Uint8Array; draft: Uint8Array; project: ProjectMetadata; ledger: BidLedger;
}): Promise<void> {
  if (!host.writeFiles) throw new Error('宿主不支持原子文件批次');
  if (!input.ledger.integrity) throw new Error('台账尚未封印');
  const encoder = new TextEncoder();
  await host.writeFiles([
    { path: input.basePath, data: input.base, createOnly: true },
    { path: input.draftPath, data: input.draft, createOnly: true },
    { path: input.projectPath, data: encoder.encode(JSON.stringify(input.project, null, 2)) },
    { path: input.ledgerPath, data: encoder.encode(JSON.stringify(input.ledger, null, 2)) },
    { path: input.anchorPath, data: encoder.encode(JSON.stringify(input.ledger.integrity)) },
  ]);
}
