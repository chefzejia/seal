import { marked, type Token, type Tokens } from 'marked';
import type { HostPort, FileWrite } from '../host.js';
import { sha256Hex } from '../docx/zip.js';
import { isValidCreditCode } from './credit-code.js';
import { parseEntry, serializeEntry } from './markdown.js';
import {
  ingestMasterDocuments,
  ingestMaterials,
  type IngestMaterialItem,
  type IngestMaterialsReport,
  type IngestSkippedItem,
} from './ingest.js';
import type {
  CandidateListItem,
  DeleteBatchResult,
  HealthIssue,
  HealthReport,
  IngestSourceType,
  KbEntry,
  KbFields,
  KbKind,
  KbValue,
  PendingBatchSummary,
  SaveInput,
  VaultMetadata,
} from './types.js';

const privateFields = new Set(['verified', 'verifiedAt', 'verifiedFields', '__sealVerification']);
const dateFields = new Set(['validUntil', 'issuedOn', 'establishedOn', 'signedOn']);
const internalPrefix = '__seal';
const encoder = new TextEncoder();
const definedFields: Record<KbKind, ReadonlySet<string>> = {
  subject: new Set(['legalName', 'creditCode', 'legalRepresentative', 'registeredCapital', 'establishedOn', 'address', 'phone', 'email', 'bankName', 'bankAccount', 'forbiddenAffiliates', 'thirdPartyHolders', 'verifiedFields']),
  record: new Set(['type', 'title', 'number', 'issuedOn', 'holder', 'employer', 'validUntil', 'client', 'projectName', 'amount', 'signedOn', 'files', 'source', 'tags', 'verified', 'verifiedAt']),
  material: new Set(['title', 'tags', 'source', 'files']),
};
const certificateTypes = new Set(['营业执照', '资质证书', '认证证书', '许可证', '人员证书']);
const performanceTypes = new Set(['业绩合同', '验收证明']);
const kbFieldLabelsZh: Readonly<Record<string, string>> = {
  legalName: '法定名称',
  creditCode: '统一社会信用代码',
  legalRepresentative: '法定代表人',
  registeredCapital: '注册资本',
  establishedOn: '成立日期',
  address: '住所/地址',
  phone: '联系电话',
  email: '电子邮箱',
  bankName: '开户银行',
  bankAccount: '银行账号',
  forbiddenAffiliates: '禁止混用关联企业',
  thirdPartyHolders: '允许第三方持证方',
  type: '资料类型',
  title: '标题',
  number: '编号',
  issuedOn: '签发日期',
  holder: '持证方',
  employer: '任职单位',
  validUntil: '有效期至',
  client: '客户',
  projectName: '项目名称',
  amount: '金额',
  signedOn: '签约日期',
  source: '来源',
  tags: '标签',
  files: '原件与图片',
};

function fieldLabel(field: string): string {
  return kbFieldLabelsZh[field] ?? field;
}
const imageMimeTypes: Readonly<Record<string, string>> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp',
  tif: 'image/tiff', tiff: 'image/tiff', svg: 'image/svg+xml', wmf: 'image/x-wmf', emf: 'image/x-emf',
  webp: 'image/webp', avif: 'image/avif', heic: 'image/heic',
};

const validSourceTypes = new Set<IngestSourceType>(['docx', 'pdf', 'image', 'spreadsheet', 'text']);

function candidateImageCount(fields: KbFields): number {
  if (Array.isArray(fields.imageFiles)) {
    return fields.imageFiles.filter((file): file is string => typeof file === 'string').length;
  }
  if (typeof fields.imageCount === 'string' && /^\d+$/.test(fields.imageCount)) {
    return Number(fields.imageCount);
  }
  if (Array.isArray(fields.files)) {
    return fields.files.filter(
      (file): file is string => typeof file === 'string' && /\.(png|jpe?g|gif|bmp|webp|svg|tiff?)$/i.test(file),
    ).length;
  }
  return 0;
}

function imageMime(file: string): string | undefined {
  const extension = /\.([A-Za-z0-9]+)$/.exec(file)?.[1]?.toLowerCase();
  return extension === undefined ? undefined : imageMimeTypes[extension];
}

function nonempty(value: KbValue | undefined): boolean {
  return Array.isArray(value) ? value.some(item => item.trim() !== '') : typeof value === 'string' ? value.trim() !== '' : value !== undefined;
}

function safeId(id: string): string {
  if (!/^[\p{L}\p{N}-]+$/u.test(id)) throw new Error('知识库 ID 只能包含字母、数字、连字符与中文');
  return id;
}

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return year > 0 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function assertHealthReferenceDate(value: string): void {
  if (!validDate(value)) throw new Error('体检参考日必须为合法 YYYY-MM-DD');
}

function recordValidity(entry: KbEntry, referenceDate: string): HealthReport['records'][number]['validity'] {
  const expiry = entry.fields.validUntil;
  if (expiry === '不适用') return 'not_applicable';
  if (expiry === '长期') return 'valid';
  if (typeof expiry !== 'string' || !validDate(expiry)) return 'unknown';
  const days = (Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${referenceDate}T00:00:00Z`)) / 86400000;
  return days < 0 ? 'expired' : days <= 60 ? 'expiring_soon' : 'valid';
}

function stringList(value: KbValue | undefined): string[] {
  if (Array.isArray(value)) return value;
  return typeof value === 'string' && value ? [value] : [];
}

function verificationSignatures(value: KbValue | undefined): Record<string, string> {
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const entries = Object.entries(parsed);
    if (entries.some(([, signature]) => typeof signature !== 'string')) return {};
    return Object.fromEntries(entries) as Record<string, string>;
  } catch {
    return {};
  }
}

function json(value: unknown): string { return JSON.stringify(value); }

function randomId(): string { return `kb-${crypto.randomUUID()}`; }

const namedHtmlEntities = new Map<string, string>([
  ['amp', '&'],
  ['AMP', '&'],
  ['lt', '<'],
  ['LT', '<'],
  ['gt', '>'],
  ['GT', '>'],
  ['quot', '"'],
  ['QUOT', '"'],
  ['apos', "'"],
  ['sol', '/'],
  ['bsol', '\\'],
  ['period', '.'],
  ['colon', ':'],
  ['percnt', '%'],
  ['num', '#'],
  ['quest', '?'],
  ['equals', '='],
  ['lowbar', '_'],
  ['hyphen', '\u2010'],
  ['dash', '\u2010'],
  ['plus', '+'],
  ['comma', ','],
  ['semi', ';'],
  ['lpar', '('],
  ['rpar', ')'],
  ['lsqb', '['],
  ['rsqb', ']'],
  ['lbrace', '{'],
  ['rbrace', '}'],
  ['tilde', '\u02dc'],
  ['commat', '@'],
  ['dollar', '$'],
  ['excl', '!'],
  ['ast', '*'],
  ['nbsp', '\u00a0'],
  ['Tab', '\t'],
  ['NewLine', '\n'],
]);

function decodeHtmlEntities(value: string): { decoded: string; hasUnknownPathEntity: boolean } {
  const decoded = value.replace(
    /&(?:#[xX]([0-9a-fA-F]+);?|#([0-9]+);?|([a-zA-Z][a-zA-Z0-9]+);)/g,
    (match, hex: string | undefined, dec: string | undefined, named: string | undefined) => {
      if (hex !== undefined) {
        const code = Number.parseInt(hex, 16);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
          ? String.fromCodePoint(code)
          : match;
      }
      if (dec !== undefined) {
        const code = Number.parseInt(dec, 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
          ? String.fromCodePoint(code)
          : match;
      }
      if (named !== undefined) {
        const mapped = namedHtmlEntities.get(named);
        return mapped !== undefined ? mapped : match;
      }
      return match;
    },
  );
  const pathPart = decoded.trim().replace(/^<|>$/g, '').trim().split(/[?#]/, 1)[0] ?? '';
  const isExternalScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(pathPart);
  const hasUnknownPathEntity = !isExternalScheme && /&(?:[a-zA-Z][a-zA-Z0-9]+;|#[xX][0-9a-fA-F]+;?|#[0-9]+;?)/.test(pathPart);
  return { decoded, hasUnknownPathEntity };
}

function extractHtmlAttributeUrls(html: string): { urls: string[]; hasAmbiguousRef: boolean } {
  const urls: string[] = [];
  let hasAmbiguousRef = false;
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    let pos = lt + 1;
    const tagMatch = /^[A-Za-z][A-Za-z0-9:-]*/.exec(html.slice(pos));
    if (!tagMatch) {
      i = pos;
      continue;
    }
    pos += tagMatch[0].length;
    if (pos >= html.length || !/[\s/>]/.test(html[pos])) {
      i = pos;
      continue;
    }
    while (pos < html.length) {
      while (pos < html.length && /\s/.test(html[pos])) pos++;
      if (pos >= html.length) break;
      if (html[pos] === '>') {
        pos++;
        break;
      }
      if (html[pos] === '/' && html[pos + 1] === '>') {
        pos += 2;
        break;
      }
      const nameStart = pos;
      while (pos < html.length && !/[\s=/>]/.test(html[pos])) pos++;
      if (pos === nameStart) {
        pos++;
        continue;
      }
      const attrName = html.slice(nameStart, pos).toLowerCase();
      while (pos < html.length && /\s/.test(html[pos])) pos++;
      if (html[pos] !== '=') continue;
      pos++;
      while (pos < html.length && /\s/.test(html[pos])) pos++;
      if (pos >= html.length) break;
      let rawValue = '';
      const quote = html[pos];
      if (quote === '"' || quote === "'") {
        pos++;
        const valStart = pos;
        while (pos < html.length && html[pos] !== quote) pos++;
        rawValue = html.slice(valStart, pos);
        if (pos < html.length && html[pos] === quote) pos++;
      } else {
        const valStart = pos;
        while (pos < html.length && !/[\s>]/.test(html[pos])) {
          if (html[pos] === '/' && html[pos + 1] === '>') break;
          pos++;
        }
        rawValue = html.slice(valStart, pos);
      }
      if (attrName === 'src' || attrName === 'href') {
        const parsed = decodeHtmlEntities(rawValue);
        if (parsed.hasUnknownPathEntity) hasAmbiguousRef = true;
        if (parsed.decoded) urls.push(parsed.decoded);
      }
    }
    i = pos;
  }
  return { urls, hasAmbiguousRef };
}

function extractMarkdownLinkTargets(markdown: string): { targets: string[]; hasAmbiguousRef: boolean } {
  const targets: string[] = [];
  let hasAmbiguousRef = false;
  const pushTarget = (rawHref: string | null | undefined) => {
    if (!rawHref) return;
    const parsed = decodeHtmlEntities(rawHref);
    if (parsed.hasUnknownPathEntity) hasAmbiguousRef = true;
    if (parsed.decoded) targets.push(parsed.decoded);
  };
  const tokens = marked.lexer(markdown);
  for (const def of Object.values(tokens.links ?? {})) {
    pushTarget(def?.href);
  }
  const visit = (token: Token): void => {
    if (token.type === 'image' || token.type === 'link') {
      pushTarget((token as Tokens.Image | Tokens.Link).href);
    } else if (token.type === 'html') {
      const extracted = extractHtmlAttributeUrls((token as Tokens.HTML).text ?? token.raw);
      if (extracted.hasAmbiguousRef) hasAmbiguousRef = true;
      targets.push(...extracted.urls);
    }
    if ('tokens' in token && Array.isArray(token.tokens)) {
      for (const child of token.tokens) visit(child);
    }
    if (token.type === 'list') {
      for (const item of (token as Tokens.List).items) {
        if (Array.isArray(item.tokens)) {
          for (const child of item.tokens) visit(child);
        }
      }
    }
    if (token.type === 'table') {
      const table = token as Tokens.Table;
      for (const cell of table.header) {
        for (const child of cell.tokens) visit(child);
      }
      for (const row of table.rows) {
        for (const cell of row) {
          for (const child of cell.tokens) visit(child);
        }
      }
    }
  };
  for (const token of tokens) visit(token);
  return { targets, hasAmbiguousRef };
}

function normalizeBatchFileRefs(raw: string, batchId: string): string[] {
  const unwrapped = raw.trim().replace(/^<|>$/g, '').trim();
  if (!unwrapped || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(unwrapped)) return [];
  const withoutQueryHash = unwrapped.replace(/[?#].*$/, '');
  const unescaped = withoutQueryHash
    .replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~])/g, '$1')
    .replace(/\\/g, '/');
  if (!unescaped) return [];
  const candidates = [unescaped];
  try {
    const decoded = decodeURIComponent(unescaped);
    if (decoded !== unescaped) candidates.push(decoded);
  } catch {
    const segmentDecoded = unescaped
      .split('/')
      .map(segment => {
        try { return decodeURIComponent(segment); }
        catch { return segment; }
      })
      .join('/');
    if (segmentDecoded !== unescaped) candidates.push(segmentDecoded);
  }
  const refs: string[] = [];
  const expectedPrefix = `files/${batchId}/`;
  for (const candidate of candidates) {
    const normalizedSlashes = candidate.replace(/\\/g, '/');
    const stripped = normalizedSlashes.replace(/^(?:\.\.?\/|\/)+/, '');
    const segments: string[] = [];
    let escapedRoot = false;
    for (const segment of stripped.split('/')) {
      if (!segment || segment === '.') continue;
      if (segment === '..') {
        if (segments.length === 0) { escapedRoot = true; break; }
        segments.pop();
        continue;
      }
      segments.push(segment);
    }
    if (escapedRoot) continue;
    const normalized = segments.join('/').normalize('NFC');
    if (normalized.startsWith(expectedPrefix)) refs.push(normalized);
  }
  return refs;
}

export function candidatePage(batchId: string, ids: readonly string[], limit: number, after?: string) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('候选 limit 范围为 1 到 100');
  const sorted = [...ids].sort();
  const start = after === undefined ? 0 : sorted.indexOf(after) + 1;
  if (after !== undefined && !start) throw new Error('候选续读位置不在该批次，请从批次首页重新读取');
  const page = sorted.slice(start, start + limit);
  return { batchId, candidateCount: ids.length, candidates: page.map(id => ({ id })), nextAfter: start + page.length < ids.length ? page.at(-1)! : null };
}

function entryPath(host: HostPort, root: string, kind: KbKind, id: string): string {
  safeId(id);
  if (kind === 'subject') return host.joinPath(root, 'subject.md');
  return host.joinPath(root, kind === 'record' ? 'records' : 'materials', `${id}.md`);
}

function payloadFingerprint(vaultId: string, kind: KbKind, id: string, fields: KbFields, body: string): string {
  const publicFields = Object.fromEntries(Object.entries(fields).filter(([key]) => !key.startsWith(internalPrefix) && !privateFields.has(key)));
  return sha256Hex(json([vaultId, kind, id, publicFields, body]));
}

async function sign(key: Uint8Array, value: string): Promise<string> {
  if (key.length < 32) throw new Error('核实密钥长度不足');
  const imported = await crypto.subtle.importKey('raw', key as unknown as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signed = new Uint8Array(await crypto.subtle.sign('HMAC', imported, encoder.encode(value) as unknown as BufferSource));
  return [...signed].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function verifySignature(key: Uint8Array, value: string, signature: string): Promise<boolean> {
  if (key.length < 32 || !/^[0-9a-f]{64}$/.test(signature)) return false;
  const imported = await crypto.subtle.importKey('raw', key as unknown as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const bytes = Uint8Array.from(signature.match(/../g)!, part => Number.parseInt(part, 16));
  return crypto.subtle.verify('HMAC', imported, bytes as unknown as BufferSource, encoder.encode(value) as unknown as BufferSource);
}

export class KnowledgeBase {
  constructor(private readonly host: HostPort, private readonly vaultsRoot: string) {}

  vaultRoot(vaultId: string): string { return this.host.joinPath(this.vaultsRoot, safeId(vaultId)); }

  async createVault(input: { name: string; vaultId?: string }): Promise<VaultMetadata> {
    if (typeof input.name !== 'string' || !input.name.trim()) throw new Error('知识库名称不能为空');
    const vaultId = safeId(input.vaultId ?? randomId());
    const root = this.vaultRoot(vaultId);
    if ((await this.host.stat(this.host.joinPath(root, 'vault.json'))).exists) throw new Error('知识库已存在');
    if (!this.host.makeDirectory || !this.host.writeFiles) throw new Error('宿主不支持安全的知识库初始化');
    const createdAt = new Date().toISOString();
    const metadata: VaultMetadata = { format: 'seal-kb-2', vaultId, name: input.name.trim(), createdAt };
    await this.host.makeDirectory(root);
    for (const directory of ['records', 'materials', 'files', 'inbox']) await this.host.makeDirectory(this.host.joinPath(root, directory));
    await this.host.writeFiles([
      { path: this.host.joinPath(root, 'vault.json'), data: encoder.encode(`${JSON.stringify(metadata, null, 2)}\n`), createOnly: true },
      { path: this.host.joinPath(root, 'subject.md'), data: encoder.encode(serializeEntry({}, '')), createOnly: true },
      { path: this.host.joinPath(root, 'log.jsonl'), data: new Uint8Array(), createOnly: true },
    ]);
    return metadata;
  }

  async metadata(vaultId: string): Promise<VaultMetadata> {
    const value = JSON.parse(await this.host.readText(this.host.joinPath(this.vaultRoot(vaultId), 'vault.json'))) as Partial<VaultMetadata>;
    if (value.format !== 'seal-kb-2' || value.vaultId !== vaultId || typeof value.name !== 'string' || typeof value.createdAt !== 'string') {
      throw new Error('知识库格式无效；seal-vault-1 不支持迁移');
    }
    return value as VaultMetadata;
  }

  async listVaults(): Promise<VaultMetadata[]> {
    if (!this.host.listFiles) throw new Error('HostPort.listFiles 不可用');
    if (!(await this.host.stat(this.vaultsRoot)).exists) return [];
    const files = await this.host.listFiles(this.vaultsRoot);
    const ids = [...new Set(files.filter(file => file.endsWith('/vault.json')).map(file => file.slice(0, -'/vault.json'.length)))];
    const values: VaultMetadata[] = [];
    for (const id of ids) {
      try { values.push(await this.metadata(id)); } catch { /* A malformed vault is isolated from healthy vaults. */ }
    }
    return values.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  }

  private async readRaw(vaultId: string, kind: KbKind, id: string): Promise<{ fields: KbFields; body: string }> {
    await this.metadata(vaultId);
    return parseEntry(await this.host.readText(entryPath(this.host, this.vaultRoot(vaultId), kind, id)));
  }

  private async effectiveEntry(vaultId: string, kind: KbKind, id: string, raw: { fields: KbFields; body: string }): Promise<KbEntry> {
    const fields = { ...raw.fields };
    const issues: string[] = [];
    let verified = false;
    let verifiedFields: string[] = [];
    const encoded = fields.__sealVerification;
    const key = await this.host.authorizationKey?.(false) ?? null;
    if (kind === 'record' && ((fields.verified !== undefined && typeof fields.verified !== 'boolean') || (encoded !== undefined && fields.verified !== true))) {
      issues.push('核实标记缺失或格式无效');
    }
    if (kind === 'record' && fields.verified === true) {
      const fingerprint = payloadFingerprint(vaultId, kind, id, fields, raw.body);
      const packed = typeof encoded === 'string' ? encoded.split(':') : [];
      verified = !!key && packed.length === 2 && packed[0] === fingerprint && await verifySignature(key, `${fingerprint}`, packed[1]);
      if (!verified) issues.push('核实签名无效或记录内容已变化');
    }
    if (kind === 'subject') {
      const declared = Array.isArray(fields.verifiedFields) ? fields.verifiedFields : [];
      if ((fields.verifiedFields !== undefined && !Array.isArray(fields.verifiedFields)) || (encoded !== undefined && declared.length === 0)) {
        issues.push('主体核实字段列表缺失或格式无效');
      }
      const signatures = verificationSignatures(encoded);
      for (const field of declared) {
        const fingerprint = sha256Hex(json([vaultId, kind, id, field, fields[field] ?? null]));
        if (key && signatures[field] && await verifySignature(key, fingerprint, signatures[field])) verifiedFields.push(field);
        else issues.push(`字段「${fieldLabel(field)}」核实签名无效或内容已变化`);
      }
      verified = verifiedFields.length > 0;
      fields.verifiedFields = verifiedFields;
    }
    delete fields.__sealVerification;
    return { id, kind, fields, body: raw.body, verified, verifiedFields, issues };
  }

  async get(vaultId: string, kind: KbKind, id = 'subject'): Promise<KbEntry> {
    const entryId = kind === 'subject' ? 'subject' : safeId(id);
    return this.effectiveEntry(vaultId, kind, entryId, await this.readRaw(vaultId, kind, entryId));
  }

  private validateFields(kind: KbKind, fields: Record<string, unknown>): KbFields {
    const output: KbFields = {};
    for (const [key, value] of Object.entries(fields)) {
      if (privateFields.has(key) || key.startsWith(internalPrefix)) throw new Error('Agent 不能设置核实字段');
      if (typeof value === 'string') output[key] = value;
      else if (Array.isArray(value) && value.every(item => typeof item === 'string')) output[key] = [...value];
      else if (typeof value === 'boolean') output[key] = value;
      else throw new Error(`字段「${key}」必须是字符串或字符串列表`);
    }
    if (kind === 'subject' && typeof output.creditCode === 'string' && output.creditCode && !isValidCreditCode(output.creditCode)) {
      throw new Error('统一社会信用代码格式或校验位无效');
    }
    for (const field of dateFields) {
      const value = output[field];
      if (typeof value !== 'string' || value === '' || field === 'validUntil' && ['长期', '不适用'].includes(value)) continue;
      if (!validDate(value)) throw new Error(`日期字段「${field}」必须为合法 YYYY-MM-DD`);
    }
    return output;
  }

  private async appendLogs(
    vaultId: string,
    entries: ReadonlyArray<{ actor: 'agent' | 'human'; object: string; action: string; summary: string }>,
    writes: FileWrite[],
  ): Promise<void> {
    const root = this.vaultRoot(vaultId), logPath = this.host.joinPath(root, 'log.jsonl');
    const prior = entries.length > 0 && (await this.host.stat(logPath)).exists ? await this.host.readText(logPath) : '';
    const lines = entries.map(entry => JSON.stringify({ at: new Date().toISOString(), ...entry }));
    const allWrites = [...writes];
    if (lines.length > 0) {
      const prefix = prior && !prior.endsWith('\n') ? '\n' : '';
      allWrites.push({ path: logPath, data: encoder.encode(`${prior}${prefix}${lines.join('\n')}\n`) });
    }
    if (this.host.writeFiles) await this.host.writeFiles(allWrites);
    else {
      for (const write of allWrites) {
        if (write.path === logPath) await this.host.writeText(write.path, new TextDecoder().decode(write.data));
        else await this.host.writeBytes(write.path, write.data);
      }
    }
  }

  private async appendLog(vaultId: string, actor: 'agent' | 'human', object: string, action: string, summary: string, writes: FileWrite[]): Promise<void> {
    return this.appendLogs(vaultId, [{ actor, object, action, summary }], writes);
  }

  private async resolveCandidateDismissalWrites(
    vaultId: string,
    rawIds: unknown,
    options: { allowEmpty: boolean },
  ): Promise<{
    ids: string[];
    writes: FileWrite[];
    logEntries: Array<{ actor: 'agent'; object: string; action: string; summary: string }>;
  }> {
    if (!Array.isArray(rawIds) || rawIds.some(id => typeof id !== 'string' || !id)) {
      throw new Error('候选 ID 列表必须为非空字符串数组');
    }
    if (!options.allowEmpty && rawIds.length === 0) {
      throw new Error('dismiss_candidates 需要至少一个候选 ID');
    }
    if (rawIds.length === 0) return { ids: [], writes: [], logEntries: [] };
    if (!this.host.writeFiles) {
      throw new Error('批量清理候选需要宿主提供原子多文件写入能力（HostPort.writeFiles）');
    }
    const ids = rawIds.map(id => safeId(id));
    if (new Set(ids).size !== ids.length) throw new Error('候选 ID 列表包含重复项');
    if (!this.host.listFiles) throw new Error('HostPort.listFiles 不可用');
    const root = this.vaultRoot(vaultId);
    const inboxFiles = await this.host.listFiles(this.host.joinPath(root, 'inbox'));
    const writes: FileWrite[] = [];
    const logEntries: Array<{ actor: 'agent'; object: string; action: string; summary: string }> = [];
    for (const id of ids) {
      const matches = inboxFiles.filter(file => file === `${id}.md` || file.endsWith(`/${id}.md`));
      if (matches.length !== 1) throw new Error(`入库候选不存在或编号不唯一：${id}`);
      const candidatePath = this.host.joinPath(root, 'inbox', matches[0]);
      const raw = parseEntry(await this.host.readText(candidatePath));
      if (raw.fields.processed === true) throw new Error(`候选已处理：${id}`);
      raw.fields.processed = true;
      raw.fields.status = 'dismissed';
      writes.push({ path: candidatePath, data: encoder.encode(serializeEntry(raw.fields, raw.body)) });
      logEntries.push({ actor: 'agent', object: `candidate:${id}`, action: 'dismiss_candidate', summary: '候选已标记为已处理' });
    }
    return { ids, writes, logEntries };
  }

  async save(vaultId: string, input: SaveInput): Promise<KbEntry & { dismissedCount?: number; dismissedIds?: string[]; dismissedCandidateIds?: string[] }> {
    for (const key of Object.keys(input)) {
      if (privateFields.has(key) || key.startsWith(internalPrefix)) throw new Error('Agent 不能设置核实字段');
    }
    const fieldsInput = this.validateFields(input.kind, input.fields ?? {});
    if (input.dismissCandidateIds !== undefined && input.action !== 'create' && input.action !== 'update') {
      throw new Error('dismissCandidateIds 仅支持 create 与 update 动作');
    }
    await this.metadata(vaultId);
    const root = this.vaultRoot(vaultId);
    if (input.action === 'dismiss_candidate') return this.dismissCandidate(vaultId, input.id ?? '');
    if (input.action === 'dismiss_candidates') {
      const batch = await this.resolveCandidateDismissalWrites(vaultId, input.ids, { allowEmpty: false });
      await this.appendLogs(vaultId, batch.logEntries, batch.writes);
      return {
        id: batch.ids[0],
        kind: 'material',
        fields: {},
        body: '',
        verified: false,
        verifiedFields: [],
        issues: [],
        dismissedCount: batch.ids.length,
        dismissedIds: batch.ids,
      };
    }
    if (input.action === 'attach_file') return this.attachFile(vaultId, input);
    if (input.kind === 'subject' && input.action !== 'update') throw new Error('主体档案只能更新');
    if (input.action === 'delete') {
      if (!input.id || input.kind === 'subject') throw new Error('只能删除指定证据记录或写作素材');
      return this.deleteEntry(vaultId, input.kind, input.id, 'agent');
    }

    const id = input.kind === 'subject' ? 'subject' : input.action === 'create' ? randomId() : safeId(input.id ?? '');
    const path = entryPath(this.host, root, input.kind, id);
    const exists = (await this.host.stat(path)).exists;
    if (input.action === 'create' && exists) throw new Error('记录已存在');
    if (input.action === 'update' && !exists) throw new Error('记录不存在');
    const dismissalBatch = input.dismissCandidateIds === undefined
      ? { ids: [], writes: [], logEntries: [] }
      : await this.resolveCandidateDismissalWrites(vaultId, input.dismissCandidateIds, { allowEmpty: true });
    const current = exists ? parseEntry(await this.host.readText(path)) : { fields: {} as KbFields, body: '' };
    const merged: KbFields = { ...current.fields, ...fieldsInput };
    const body = input.body === undefined ? current.body : input.body;
    const changed = json(current.fields) !== json(merged) || current.body !== body;
    if (input.kind === 'record' && changed) {
      delete merged.verified; delete merged.verifiedAt; delete merged.__sealVerification;
    } else if (input.kind === 'subject') {
      const verifiedFields = stringList(current.fields.verifiedFields);
      const signatures = verificationSignatures(current.fields.__sealVerification);
      const changedFields = new Set(Object.keys(fieldsInput).filter(key => json(current.fields[key]) !== json(fieldsInput[key])));
      for (const field of changedFields) delete signatures[field];
      merged.verifiedFields = verifiedFields.filter(field => !changedFields.has(field));
      if (Object.keys(signatures).length) merged.__sealVerification = JSON.stringify(signatures);
      else delete merged.__sealVerification;
    }
    const text = serializeEntry(merged, body);
    await this.appendLogs(
      vaultId,
      [{ actor: 'agent', object: `${input.kind}:${id}`, action: input.action, summary: `${input.action} 完成` }, ...dismissalBatch.logEntries],
      [{ path, data: encoder.encode(text), ...(input.action === 'create' ? { createOnly: true } : {}) }, ...dismissalBatch.writes],
    );
    const entry = await this.effectiveEntry(vaultId, input.kind, id, { fields: merged, body });
    return dismissalBatch.ids.length ? { ...entry, dismissedCandidateIds: dismissalBatch.ids } : entry;
  }

  async deleteEntry(
    vaultId: string,
    kind: 'record' | 'material',
    id: string,
    actor: 'human' | 'agent' = 'human',
  ): Promise<KbEntry> {
    if (kind !== 'record' && kind !== 'material') {
      throw new Error('只能删除指定证据记录或写作素材');
    }
    if (typeof id !== 'string' || !id) {
      throw new Error('只能删除指定证据记录或写作素材');
    }
    const entryId = safeId(id);
    await this.metadata(vaultId);
    const root = this.vaultRoot(vaultId);
    const path = entryPath(this.host, root, kind, entryId);
    const stat = await this.host.stat(path);
    if (!stat.exists || stat.isDirectory) {
      throw new Error('记录不存在');
    }
    const old = await this.host.readText(path);
    if (!this.host.removeFile) throw new Error('HostPort.removeFile 不可用');
    await this.host.removeFile(path);
    try {
      await this.appendLog(vaultId, actor, `${kind}:${entryId}`, 'delete', '记录已删除', []);
    } catch (error) {
      await this.host.writeText(path, old).catch(() => {});
      throw error;
    }
    return { id: entryId, kind, fields: {}, body: '', verified: false, verifiedFields: [], issues: [] };
  }

  async deleteBatch(vaultId: string, batchId: string): Promise<DeleteBatchResult> {
    await this.metadata(vaultId);
    if (typeof batchId !== 'string' || !/^batch-[a-z0-9-]+$/.test(batchId)) {
      throw new Error('无效的入库批次编号');
    }
    if (!this.host.listFiles) throw new Error('HostPort.listFiles 不可用');
    if (!this.host.removeDirectory) throw new Error('HostPort.removeDirectory 不可用');
    const root = this.vaultRoot(vaultId);
    const inboxBatchDir = this.host.joinPath(root, 'inbox', batchId);
    const inboxStat = await this.host.stat(inboxBatchDir);
    if (!inboxStat.exists || !inboxStat.isDirectory) {
      throw new Error('入库批次不存在');
    }
    const inboxFiles = await this.host.listFiles(inboxBatchDir);
    const removedCandidates = inboxFiles.filter(file => /^candidate-[a-z0-9-]+\.md$/.test(file)).length;

    const vaultFiles = await this.host.listFiles(root);
    const entryFiles = new Set(vaultFiles.filter(file => /^(records|materials)\/[^/]+\.md$/.test(file)));
    if ((await this.host.stat(this.host.joinPath(root, 'subject.md'))).exists || vaultFiles.includes('subject.md')) {
      entryFiles.add('subject.md');
    }

    const referenced = new Set<string>();
    let preserveAllBatchFiles = false;
    for (const rel of entryFiles) {
      try {
        const parsed = parseEntry(await this.host.readText(this.host.joinPath(root, rel)));
        for (const fileRef of stringList(parsed.fields.files)) {
          for (const normalized of normalizeBatchFileRefs(fileRef, batchId)) {
            referenced.add(normalized);
          }
        }
        const extracted = extractMarkdownLinkTargets(parsed.body);
        if (extracted.hasAmbiguousRef) {
          preserveAllBatchFiles = true;
        }
        for (const target of extracted.targets) {
          for (const normalized of normalizeBatchFileRefs(target, batchId)) {
            referenced.add(normalized);
          }
        }
      } catch {
        preserveAllBatchFiles = true;
      }
    }

    const filesBatchDir = this.host.joinPath(root, 'files', batchId);
    const filesStat = await this.host.stat(filesBatchDir);
    const batchFiles = filesStat.exists && filesStat.isDirectory ? await this.host.listFiles(filesBatchDir) : [];
    const unreferencedFiles: string[] = [];
    let preservedFiles = 0;

    if (preserveAllBatchFiles) {
      preservedFiles = batchFiles.length;
    } else if (batchFiles.length > 0) {
      for (const rel of batchFiles) {
        const vaultRel = `files/${batchId}/${rel}`.normalize('NFC');
        if (referenced.has(vaultRel)) preservedFiles++;
        else unreferencedFiles.push(rel);
      }
      if (preservedFiles > 0 && unreferencedFiles.length > 0 && !this.host.removeFile) {
        throw new Error('HostPort.removeFile 不可用');
      }
    }

    await this.host.removeDirectory(inboxBatchDir);

    let removedFiles = 0;
    if (!preserveAllBatchFiles && filesStat.exists && filesStat.isDirectory) {
      if (preservedFiles === 0) {
        await this.host.removeDirectory(filesBatchDir);
        removedFiles = unreferencedFiles.length;
      } else {
        for (const rel of unreferencedFiles) {
          await this.host.removeFile!(this.host.joinPath(filesBatchDir, rel));
          removedFiles++;
        }
      }
    }

    await this.appendLog(
      vaultId,
      'human',
      `batch:${batchId}`,
      'delete_batch',
      json({ removedCandidates, removedFiles, preservedFiles }),
      [],
    );

    return {
      batchId,
      removedCandidates,
      removedFiles,
      preservedFiles,
    };
  }

  async verify(vaultId: string, kind: KbKind, id: string, fields: readonly string[] = []): Promise<KbEntry> {
    await this.metadata(vaultId);
    if (kind === 'material') throw new Error('写作素材没有核实状态');
    const entryId = kind === 'subject' ? 'subject' : safeId(id);
    const path = entryPath(this.host, this.vaultRoot(vaultId), kind, entryId);
    const current = parseEntry(await this.host.readText(path));
    const key = await this.host.authorizationKey?.(true);
    if (!key) throw new Error('宿主不支持核实密钥');
    const next: KbFields = { ...current.fields };
    if (kind === 'record') {
      const fingerprint = payloadFingerprint(vaultId, kind, entryId, next, current.body);
      next.verified = true;
      next.verifiedAt = new Date().toISOString();
      next.__sealVerification = `${fingerprint}:${await sign(key, fingerprint)}`;
    } else {
      const selected = [...new Set(fields)];
      if (!selected.length) throw new Error('至少选择一个主体字段核实');
      const signatures = verificationSignatures(next.__sealVerification);
      const verified = new Set(stringList(next.verifiedFields));
      for (const field of selected) {
        if (privateFields.has(field) || field.startsWith(internalPrefix) || next[field] === undefined || next[field] === '') throw new Error(`主体字段「${field}」不存在或不可核实`);
        const fingerprint = sha256Hex(json([vaultId, kind, entryId, field, next[field]]));
        signatures[field] = await sign(key, fingerprint);
        verified.add(field);
      }
      next.verifiedFields = [...verified].sort();
      next.__sealVerification = JSON.stringify(signatures);
    }
    await this.appendLog(vaultId, 'human', `${kind}:${entryId}`, 'verify', '人工核实状态已更新', [{ path, data: encoder.encode(serializeEntry(next, current.body)) }]);
    return this.effectiveEntry(vaultId, kind, entryId, { fields: next, body: current.body });
  }

  private async attachFile(vaultId: string, input: SaveInput): Promise<KbEntry> {
    if (!input.id || !input.file || input.kind === 'subject') throw new Error('附件必须关联一条记录或素材');
    const id = safeId(input.id), current = await this.get(vaultId, input.kind, id);
    const fileName = input.file.fileName.split(/[\\/]/).at(-1) ?? '';
    if (!fileName || fileName === '.' || fileName === '..' || fileName.startsWith('.')) throw new Error('附件文件名无效');
    const mime = imageMime(fileName);
    if (mime !== undefined) {
      if (!this.host.validateImage) throw new Error('HostPort.validateImage 不可用');
      await this.host.validateImage(input.file.bytes, mime);
    }
    const relative = `files/${id}/${fileName}`;
    const absolute = this.host.joinPath(this.vaultRoot(vaultId), relative);
    if ((await this.host.stat(absolute)).exists) throw new Error('同名附件已存在，不会覆盖');
    if (!this.host.makeDirectory) throw new Error('宿主不支持创建附件目录');
    await this.host.makeDirectory(this.host.dirname(absolute));
    const files = stringList(current.fields.files);
    const nextFields: KbFields = { ...current.fields, files: [...files, relative] };
    if (input.kind === 'record') {
      delete nextFields.verified;
      delete nextFields.verifiedAt;
    }
    await this.appendLog(vaultId, 'agent', `${input.kind}:${id}`, 'attach_file', '已附加文件', [
      { path: absolute, data: input.file.bytes, createOnly: true },
      { path: entryPath(this.host, this.vaultRoot(vaultId), input.kind, id), data: encoder.encode(serializeEntry(nextFields, current.body)) },
    ]);
    return this.effectiveEntry(vaultId, input.kind, id, { fields: nextFields, body: current.body });
  }

  private async dismissCandidate(vaultId: string, id: string): Promise<KbEntry> {
    safeId(id);
    if (!this.host.listFiles) throw new Error('HostPort.listFiles 不可用');
    const root = this.vaultRoot(vaultId), candidates = (await this.host.listFiles(this.host.joinPath(root, 'inbox'))).filter(file => file.endsWith(`/${id}.md`));
    if (candidates.length !== 1) throw new Error('入库候选不存在或编号不唯一');
    const path = this.host.joinPath(root, 'inbox', candidates[0]), raw = parseEntry(await this.host.readText(path));
    if (raw.fields.processed === true) throw new Error('候选已处理');
    raw.fields.processed = true;
    raw.fields.status = 'dismissed';
    await this.appendLog(vaultId, 'agent', `candidate:${id}`, 'dismiss_candidate', '候选已标记为已处理', [{ path, data: encoder.encode(serializeEntry(raw.fields, raw.body)) }]);
    return { id, kind: 'material', fields: raw.fields, body: raw.body, verified: false, verifiedFields: [], issues: [] };
  }

  async getCandidate(vaultId: string, id: string): Promise<KbEntry> {
    await this.metadata(vaultId);
    safeId(id);
    if (!this.host.listFiles) throw new Error('HostPort.listFiles 不可用');
    const candidates = (await this.host.listFiles(this.host.joinPath(this.vaultRoot(vaultId), 'inbox'))).filter(file => file.endsWith(`/${id}.md`));
    if (candidates.length !== 1) throw new Error('入库候选不存在或编号不唯一');
    const raw = parseEntry(await this.host.readText(this.host.joinPath(this.vaultRoot(vaultId), 'inbox', candidates[0])));
    return { id, kind: 'material', fields: raw.fields, body: raw.body, verified: false, verifiedFields: [], issues: [] };
  }

  async ingest(vaultId: string, sourcePaths: readonly string[], originalSourcePaths: readonly string[], stagingRoot: string) {
    await this.metadata(vaultId);
    if (!this.host.writeFiles) throw new Error('宿主不支持原子写入知识库入库日志');
    return ingestMasterDocuments({
      host: this.host, vaultRoot: this.vaultRoot(vaultId), sourcePaths, originalSourcePaths, stagingRoot,
      commit: async report => {
        const { batchId, sourceCount, candidateCount, imageCount } = report;
        await this.appendLog(vaultId, 'agent', `batch:${batchId}`, 'ingest', json({ sourceCount, candidateCount, imageCount }), []);
      },
    });
  }

  async ingestMaterials(
    vaultId: string,
    items: readonly IngestMaterialItem[],
    stagingRoot: string,
    skipped: readonly IngestSkippedItem[] = [],
  ): Promise<IngestMaterialsReport> {
    await this.metadata(vaultId);
    if (!this.host.writeFiles) throw new Error('宿主不支持原子写入知识库入库日志');
    return ingestMaterials({
      host: this.host,
      vaultRoot: this.vaultRoot(vaultId),
      items,
      skipped,
      stagingRoot,
      commit: async report => {
        const { batchId, sourceCount, candidateCount, imageCount } = report;
        await this.appendLog(
          vaultId,
          'agent',
          `batch:${batchId}`,
          'ingest',
          json({ sourceCount, candidateCount, imageCount, skippedCount: report.skipped.length }),
          [],
        );
      },
    });
  }

  async listPendingBatches(vaultId: string): Promise<PendingBatchSummary[]> {
    await this.metadata(vaultId);
    if (!this.host.listFiles) throw new Error('HostPort.listFiles 不可用');
    const inboxDir = this.host.joinPath(this.vaultRoot(vaultId), 'inbox');
    if (!(await this.host.stat(inboxDir)).isDirectory) return [];
    const files = (await this.host.listFiles(inboxDir)).sort();
    const byBatch = new Map<string, { total: number; pending: string[]; sources: Set<string> }>();
    for (const rel of files) {
      const match = /^(batch-[a-z0-9-]+)\/(candidate-[a-z0-9-]+)\.md$/.exec(rel);
      if (!match) continue;
      const [, batchId, candidateId] = match;
      let group = byBatch.get(batchId);
      if (!group) {
        group = { total: 0, pending: [], sources: new Set<string>() };
        byBatch.set(batchId, group);
      }
      group.total++;
      try {
        const parsed = parseEntry(await this.host.readText(this.host.joinPath(inboxDir, rel)));
        if (typeof parsed.fields.source === 'string' && parsed.fields.source.trim()) {
          group.sources.add(parsed.fields.source.trim());
        }
        if (parsed.fields.processed !== true) {
          group.pending.push(candidateId);
        }
      } catch {
        group.pending.push(candidateId);
      }
    }
    const batches: PendingBatchSummary[] = [];
    for (const [batchId, group] of byBatch.entries()) {
      if (group.pending.length > 0) {
        batches.push({
          batchId,
          totalCandidates: group.total,
          pendingCount: group.pending.length,
          sampleIds: group.pending.slice(0, 10),
          sources: [...group.sources],
        });
      }
    }
    return batches;
  }

  async listCandidates(vaultId: string, batchId: string, limit: number, after?: string) {
    if (!/^batch-[a-z0-9-]+$/.test(batchId)) throw new Error('无效的入库批次编号');
    if (!this.host.listFiles) throw new Error('HostPort.listFiles 不可用');
    const directory = this.host.joinPath(this.vaultRoot(vaultId), 'inbox', batchId);
    if (!(await this.host.stat(directory)).isDirectory) throw new Error('入库批次不存在');
    const ids = (await this.host.listFiles(directory)).filter(file => /^candidate-[a-z0-9-]+\.md$/.test(file)).map(file => file.slice(0, -3));
    const page = candidatePage(batchId, ids, limit, after);
    const candidates = await Promise.all(
      page.candidates.map(async ({ id }): Promise<CandidateListItem> => {
        try {
          const parsed = parseEntry(await this.host.readText(this.host.joinPath(directory, `${id}.md`)));
          const fields = parsed.fields;
          const title = typeof fields.title === 'string' && fields.title.trim() ? fields.title.trim() : id;
          const source = typeof fields.source === 'string' ? fields.source : '';
          const location = typeof fields.location === 'string' ? fields.location : '';
          const rawSourceType = typeof fields.sourceType === 'string' ? (fields.sourceType as IngestSourceType) : undefined;
          const sourceType = rawSourceType && validSourceTypes.has(rawSourceType) ? rawSourceType : undefined;
          return {
            id,
            title,
            source,
            location,
            ...(sourceType ? { sourceType } : {}),
            imageCount: candidateImageCount(fields),
            processed: fields.processed === true,
          };
        } catch {
          return {
            id,
            title: id,
            source: '',
            location: '',
            imageCount: 0,
            processed: false,
          };
        }
      }),
    );
    return {
      batchId: page.batchId,
      candidateCount: page.candidateCount,
      candidates,
      nextAfter: page.nextAfter,
    };
  }

  private metadataIssues(entry: KbEntry): HealthIssue[] {
    const issues: HealthIssue[] = entry.issues.map(message => ({ code: 'verification_invalid', kind: entry.kind, id: entry.id, message }));
    for (const field of Object.keys(entry.fields)) {
      if (!definedFields[entry.kind].has(field) && !field.startsWith(internalPrefix)) {
        issues.push({ code: 'field_unknown', kind: entry.kind, id: entry.id, field, message: `未定义字段「${field}」已保留` });
      }
      const value = entry.fields[field];
      if (dateFields.has(field) && nonempty(value) && !(field === 'validUntil' && (value === '长期' || value === '不适用')) && (typeof value !== 'string' || !validDate(value))) {
        issues.push({ code: 'date_invalid', kind: entry.kind, id: entry.id, field, message: `日期字段「${fieldLabel(field)}」不是合法日历日期` });
      }
    }
    return issues;
  }

  private subjectIssues(subject: KbEntry): HealthIssue[] {
    const issues = this.metadataIssues(subject);
    if (typeof subject.fields.legalName !== 'string' || !subject.fields.legalName) issues.push({ code: 'subject_missing', kind: 'subject', id: 'subject', field: 'legalName', message: '主体法定名称缺失' });
    if (typeof subject.fields.creditCode === 'string' && subject.fields.creditCode && !isValidCreditCode(subject.fields.creditCode)) issues.push({ code: 'credit_code_invalid', kind: 'subject', id: 'subject', field: 'creditCode', message: '统一社会信用代码格式或校验位无效' });
    for (const [field, value] of Object.entries(subject.fields)) {
      if (!privateFields.has(field) && !field.startsWith(internalPrefix) && nonempty(value) && !subject.verifiedFields.includes(field)) {
        issues.push({ code: 'subject_unverified', kind: 'subject', id: 'subject', field, message: `主体字段「${fieldLabel(field)}」尚未核实` });
      }
    }
    return issues;
  }

  private async fileIssues(vaultId: string, entry: KbEntry): Promise<HealthIssue[]> {
    const issues: HealthIssue[] = [];
    for (const file of stringList(entry.fields.files)) {
      const stored = this.host.joinPath(this.vaultRoot(vaultId), file);
      const stat = await this.host.stat(stored);
      if (!stat.exists || stat.isDirectory || stat.size === 0) {
        issues.push({ code: 'file_missing', kind: entry.kind, id: entry.id, field: 'files', message: `引用的原件或附件缺失：${file}` });
        continue;
      }
      const mime = imageMime(file);
      if (mime !== undefined) {
        try {
          if (!this.host.validateImage) throw new Error('HostPort.validateImage 不可用');
          await this.host.validateImage(await this.host.readBytes(stored), mime);
        } catch {
          issues.push({ code: 'image_invalid', kind: entry.kind, id: entry.id, field: 'files', message: `图片无法解码：${file}` });
        }
      }
    }
    return issues;
  }

  private async recordHealth(vaultId: string, entry: KbEntry, subject: KbEntry, referenceDate: string) {
    const issues = [...this.metadataIssues(entry), ...await this.fileIssues(vaultId, entry)];
    const add = (code: string, message: string, field?: string) => issues.push({ code, kind: 'record', id: entry.id, message, field });
    const validity = recordValidity(entry, referenceDate);
    if (validity === 'unknown' && !nonempty(entry.fields.validUntil)) add('validity_unknown', '证据效期未知', 'validUntil');
    const holderField = entry.fields.type === '人员证书' ? 'employer' : 'holder';
    const holder = entry.fields[holderField];
    const forbidden = stringList(subject.fields.forbiddenAffiliates);
    const thirdParty = stringList(subject.fields.thirdPartyHolders);
    const attribution: HealthReport['records'][number]['subject'] = typeof holder !== 'string' || !holder ? 'unknown' : holder === subject.fields.legalName ? 'self' : forbidden.includes(holder) ? 'forbidden' : thirdParty.includes(holder) ? 'third_party' : 'mismatch';
    if (!nonempty(entry.fields.type)) add('record_type_missing', '资料类型缺失', 'type');
    const type = entry.fields.type;
    const required = typeof type === 'string' && certificateTypes.has(type) ? ['holder', 'number', 'validUntil'] : typeof type === 'string' && performanceTypes.has(type) ? ['client', 'amount', 'signedOn'] : [];
    for (const field of required) {
      if (!nonempty(entry.fields[field])) add('field_missing', `关键字段「${fieldLabel(field)}」缺失`, field);
    }
    if (validity === 'expired') add('expired', '证据在参考日已过期', 'validUntil');
    else if (validity === 'expiring_soon') add('expiring_soon', '证据将在 60 天内到期', 'validUntil');
    if (attribution === 'forbidden') add('forbidden_subject', '证据持证方属于禁用主体', holderField);
    else if (attribution === 'mismatch') add('subject_mismatch', '证据持证方与本企业或允许的第三方不符', holderField);
    else if (attribution === 'unknown') add('subject_unknown', '证据持证方未知', holderField);
    if (!entry.verified) add('record_unverified', '证据记录尚未核实');
    return { referenceDate, validity, subject: attribution, issues };
  }

  async entryHealth(vaultId: string, entry: KbEntry, referenceDate: string) {
    assertHealthReferenceDate(referenceDate);
    if (entry.kind === 'record') return this.recordHealth(vaultId, entry, await this.get(vaultId, 'subject'), referenceDate);
    return { referenceDate, issues: entry.kind === 'subject' ? this.subjectIssues(entry) : [...this.metadataIssues(entry), ...await this.fileIssues(vaultId, entry)] };
  }

  async health(vaultId: string, referenceDate: string): Promise<HealthReport> {
    assertHealthReferenceDate(referenceDate);
    const subject = await this.get(vaultId, 'subject');
    const issues = this.subjectIssues(subject), records: HealthReport['records'] = [];
    if (!this.host.listFiles) throw new Error('HostPort.listFiles 不可用');
    const files = await this.host.listFiles(this.vaultRoot(vaultId));
    for (const relative of files.filter(file => /^(records|materials)\/[^/]+\.md$/.test(file))) {
      const kind = relative.startsWith('records/') ? 'record' : 'material';
      const id = relative.slice(relative.indexOf('/') + 1, -3);
      let entry: KbEntry;
      try { entry = await this.get(vaultId, kind, id); }
      catch { issues.push({ code: 'entry_malformed', kind, id, message: '资料记录无法解析' }); continue; }
      if (kind !== 'record') {
        issues.push(...this.metadataIssues(entry), ...await this.fileIssues(vaultId, entry));
        continue;
      }
      const result = await this.recordHealth(vaultId, entry, subject, referenceDate);
      records.push({ ...entry, validity: result.validity, subject: result.subject });
      issues.push(...result.issues);
    }
    const duplicates = new Map<string, string[]>();
    for (const record of records) {
      const { type, number } = record.fields;
      if (typeof type !== 'string' || typeof number !== 'string' || !type.trim() || !number.trim()) continue;
      const key = json([type, number]);
      const ids = duplicates.get(key) ?? [];
      ids.push(record.id);
      duplicates.set(key, ids);
    }
    for (const ids of duplicates.values()) {
      if (ids.length < 2) continue;
      for (const id of ids) issues.push({ code: 'record_duplicate', kind: 'record', id, field: 'number', message: `同类型同编号的重复记录：${ids.join('、')}` });
    }
    return { vaultId, referenceDate, records, issues };
  }

  async search(vaultId: string, input: { query?: string; type?: string; tags?: string[]; validity?: string; referenceDate?: string; limit?: number }): Promise<Array<{ id: string; kind: KbKind; title: string; fields: KbFields; snippet: string; validity?: string }>> {
    await this.metadata(vaultId);
    if (!this.host.listFiles) throw new Error('HostPort.listFiles 不可用');
    const query = input.query?.trim().toLocaleLowerCase('zh-CN') ?? '';
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('检索 limit 范围为 1 到 100');
    if (input.validity !== undefined && !['valid', 'expiring_soon', 'expired', 'unknown', 'not_applicable'].includes(input.validity)) throw new Error('效期筛选值无效');
    if (input.validity !== undefined && input.referenceDate === undefined) throw new Error('效期筛选需要截标日，请提供 --project 或 --reference-date YYYY-MM-DD');
    if (input.referenceDate !== undefined) assertHealthReferenceDate(input.referenceDate);
    const paths = (await this.host.listFiles(this.vaultRoot(vaultId))).filter(file => /^(records|materials)\/.+\.md$/.test(file));
    const results: Array<{ id: string; kind: KbKind; title: string; fields: KbFields; snippet: string; validity?: string }> = [];
    for (const relative of paths) {
      const kind = relative.startsWith('records/') ? 'record' : 'material';
      const id = relative.slice(relative.indexOf('/') + 1, -3);
      const entry = await this.get(vaultId, kind, id);
      if (input.type && entry.fields.type !== input.type) continue;
      const tags = stringList(entry.fields.tags);
      if (input.tags?.some(tag => !tags.includes(tag))) continue;
      const text = `${Object.entries(entry.fields).flatMap(([key, value]) => [key, ...(Array.isArray(value) ? value : [String(value)])]).join(' ')} ${entry.body}`;
      const lower = text.toLocaleLowerCase('zh-CN');
      if (query && !lower.includes(query) && ![...query].some(character => lower.includes(character))) continue;
      const validity = kind === 'record' && input.referenceDate ? recordValidity(entry, input.referenceDate) : undefined;
      if (input.validity !== undefined && validity !== input.validity) continue;
      const at = query ? lower.indexOf(query) : -1;
      const snippet = at < 0 ? text.slice(0, 180) : text.slice(Math.max(0, at - 60), at + query.length + 100);
      results.push({ id, kind, title: String(entry.fields.title ?? entry.fields.legalName ?? id), fields: entry.fields, snippet, ...(validity ? { validity } : {}) });
      if (results.length >= limit) break;
    }
    return results;
  }
}
