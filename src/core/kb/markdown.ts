import type { KbFields, KbValue } from './types.js';

const keyPattern = /^[\p{L}\p{N}_-]+$/u;

function scalar(value: string): KbValue {
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === 'string' || typeof parsed === 'boolean') return parsed;
      throw new Error('unsupported value');
    } catch { throw new Error('Frontmatter 字符串格式无效'); }
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) return parsed;
    } catch { /* Preserve the field as a scalar below. */ }
  }
  return value;
}

export function parseEntry(markdown: string): { fields: KbFields; body: string } {
  const normalized = markdown.replace(/\r\n?/g, '\n');
  if (!normalized.startsWith('---\n')) throw new Error('知识库记录缺少 frontmatter');
  const close = normalized.indexOf('\n---\n', 4);
  if (close < 0) throw new Error('知识库 frontmatter 未闭合');
  const lines = normalized.slice(4, close).split('\n');
  const fields: KbFields = {};
  let listKey: string | undefined;
  for (const line of lines) {
    if (line === '') continue;
    const item = /^  - (.*)$/.exec(line);
    if (item && listKey) {
      const current = fields[listKey];
      const value = scalar(item[1]);
      if (typeof value !== 'string') throw new Error(`Frontmatter 列表字段无效：${listKey}`);
      fields[listKey] = [...(Array.isArray(current) ? current : []), value];
      continue;
    }
    const match = /^([\p{L}\p{N}_-]+):(?: (.*))?$/u.exec(line);
    if (!match || !keyPattern.test(match[1]) || Object.hasOwn(fields, match[1])) throw new Error('知识库 frontmatter 字段无效');
    const [, key, raw = ''] = match;
    if (raw === '') { fields[key] = []; listKey = key; }
    else { fields[key] = scalar(raw); listKey = undefined; }
  }
  return { fields, body: normalized.slice(close + 5) };
}

export function serializeEntry(fields: KbFields, body: string): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (!keyPattern.test(key)) throw new Error(`Frontmatter 字段名无效：${key}`);
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${JSON.stringify(item)}`);
    } else if (typeof value === 'string') lines.push(`${key}: ${JSON.stringify(value)}`);
    else if (typeof value === 'boolean') lines.push(`${key}: ${value}`);
    else throw new Error(`Frontmatter 字段类型无效：${key}`);
  }
  return `---\n${lines.join('\n')}\n---\n${body}`;
}
