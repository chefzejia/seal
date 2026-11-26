import type { KbEntry, HealthReport } from '../kb/types.js';

export interface FactRecord extends KbEntry {
  validity: HealthReport['records'][number]['validity'];
  subject: HealthReport['records'][number]['subject'];
}

export interface FactContext {
  deadline: string;
  subject?: KbEntry;
  records: ReadonlyMap<string, FactRecord>;
  materials?: ReadonlyMap<string, KbEntry>;
  quotes?: ReadonlyMap<string, string>;
}

export interface FactSource {
  reference: string;
  resolvedValue: string;
  verified: boolean;
  recordId?: string;
  materialId?: string;
  validity?: FactRecord['validity'];
  subject?: FactRecord['subject'];
  thirdPartyHolder?: string;
  media?: boolean;
  imageIndex?: number;
  cell?: { row: number; col: number; start: number; end: number };
}

export interface FactResolution {
  value: string;
  sources: FactSource[];
  spans: Array<{ start: number; end: number; source: FactSource }>;
  verified: boolean;
  markdownLiterals?: ReadonlyMap<string, string>;
}

export function displayedFactValue(source: FactSource): string {
  return source.thirdPartyHolder
    ? source.resolvedValue + '（持证方：' + source.thirdPartyHolder + '）'
    : source.resolvedValue;
}

function scalar(value: unknown, reference: string): string {
  if (typeof value !== 'string') throw new Error(`事实引用字段不存在或不是文本：${reference}`);
  if (!value.trim()) throw new Error(`事实引用字段为空：${reference}`);
  return value;
}

export function recordFactSource(record: FactRecord, reference: string, thirdPartyHolder?: string, resolvedValue = ''): FactSource {
  const value = resolvedValue;
  if (record.validity === 'expired') throw new Error(`证据已过期，拒绝引用：${record.id}`);
  if (record.subject === 'forbidden') throw new Error(`证据持证主体已禁用，拒绝引用：${record.id}`);
  if (record.subject === 'mismatch') throw new Error(`证据持证主体与本企业或允许的第三方不符：${record.id}`);
  const holderField = record.fields.type === '人员证书' ? 'employer' : 'holder';
  const holder = record.fields[holderField];
  if (record.subject === 'third_party' && thirdPartyHolder !== holder) throw new Error(`第三方证据必须声明实际持证方「${holder}」：${record.id}`);
  if (thirdPartyHolder && (record.subject !== 'third_party' || thirdPartyHolder !== holder)) throw new Error(`声明的第三方持证方与证据记录不符：${record.id}`);
  return { reference, resolvedValue: value, verified: record.verified && record.validity !== 'unknown' && record.subject !== 'unknown', recordId: record.id, validity: record.validity, subject: record.subject, ...(record.subject === 'third_party' && typeof holder === 'string' ? { thirdPartyHolder: holder } : {}) };
}

function resolveReference(reference: string, context: FactContext, thirdPartyHolder?: string): FactSource {
  const subject = /^\{\{subject\.([\p{L}\p{N}_-]+)\}\}$/u.exec(reference);
  if (subject) {
    if (!context.subject) throw new Error('当前投标未关联知识库，不能解析主体事实引用');
    const value = scalar(context.subject.fields[subject[1]], reference);
    return { reference, resolvedValue: value, verified: context.subject.verifiedFields.includes(subject[1]) };
  }
  const recordMatch = /^\{\{record:([\p{L}\p{N}-]+)\.([\p{L}\p{N}_-]+)\}\}$/u.exec(reference);
  if (recordMatch) {
    const [, id, field] = recordMatch;
    const record = context.records.get(id);
    if (!record) throw new Error(`证据记录不存在：${id}`);
    return recordFactSource(record, reference, thirdPartyHolder, scalar(record.fields[field], reference));
  }
  const quote = /^\{\{quote:([^|{}]+)\|([\s\S]*)\}\}$/.exec(reference);
  if (quote) {
    const [, file, text] = quote;
    if (!file || !text) throw new Error('原文引用的路径和片段均不能为空');
    const source = context.quotes?.get(file);
    if (source === undefined || !source.includes(text)) throw new Error(`原文引用片段不存在或不匹配：${file}`);
    return { reference, resolvedValue: text, verified: true };
  }
  throw new Error(`事实引用格式无效或不支持：${reference}`);
}

export function resolveFactReferences(value: string, context: FactContext, thirdPartyHolder?: string, markdown = false): FactResolution {
  const sources: FactSource[] = [], spans: FactResolution['spans'] = [];
  const markdownLiterals = new Map<string, string>();
  let output = '', cursor = 0;
  for (const match of value.matchAll(/\{\{[^{}]*\}\}/g)) {
    const index = match.index!;
    output += value.slice(cursor, index);
    const source = resolveReference(match[0], context, thirdPartyHolder), start = output.length;
    const display = displayedFactValue(source);
    if (markdown && source.thirdPartyHolder) {
      let token = `SEALMDFACT${sources.length}END`;
      while (value.includes(token) || [...markdownLiterals.values()].some(text => text.includes(token))) token += 'X';
      markdownLiterals.set(token, display);
      output += token;
    } else output += display;
    sources.push(source);
    spans.push({ start, end: output.length, source });
    cursor = index + match[0].length;
  }
  output += value.slice(cursor);
  if (output.includes('{{') || output.includes('}}')) throw new Error('事实引用未完整闭合');
  return { value: output, sources, spans, verified: sources.length > 0 && sources.every(source => source.verified), ...(markdownLiterals.size ? { markdownLiterals } : {}) };
}
