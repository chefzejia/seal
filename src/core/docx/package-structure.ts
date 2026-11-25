import { SaxesParser } from 'saxes';
import { readZip } from './zip.js';
import { validateZipIntegrity } from './zip-integrity.js';
import { validateXmlParts } from './xml-validation.js';

function tags(xml: string, visit: (name: string, attributes: Record<string, string>) => void): void {
  const parser = new SaxesParser();
  parser.on('opentag', tag => visit(tag.name.split(':').pop()!, tag.attributes as Record<string, string>));
  parser.write(xml).close();
}

export function resolveRelationshipTarget(base: string, target: string): string {
  let decoded: string;
  try { decoded = decodeURIComponent(target.split('#')[0]); } catch { throw new Error(`无效关系目标：${target}`); }
  if (!decoded || decoded.includes('\\') || decoded.includes('?')) throw new Error(`无效关系目标：${target}`);
  const segments = (decoded.startsWith('/') ? decoded.slice(1) : `${base}${decoded}`).split('/');
  const result: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (!result.length) throw new Error(`关系目标越界：${target}`);
      result.pop();
    } else result.push(segment);
  }
  return result.join('/');
}

/** Verify ZIP, XML, OPC content-type registrations and internal relationship targets. */
export async function validatePackageStructure(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const entries = await readZip(bytes);
  validateZipIntegrity(bytes, entries);
  validateXmlParts(entries);
  const contentTypes = entries.get('[Content_Types].xml');
  if (!contentTypes || !entries.has('word/document.xml')) throw new Error('缺少 Word 文档或内容类型清单');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const defaults = new Set<string>(), overrides = new Set<string>();
  tags(decoder.decode(contentTypes), (name, attributes) => {
    if (name === 'Default' && attributes.Extension && attributes.ContentType) defaults.add(attributes.Extension.toLowerCase());
    if (name === 'Override' && attributes.PartName && attributes.ContentType) overrides.add(attributes.PartName.replace(/^\//, ''));
  });
  for (const name of entries.keys()) {
    if (name === '[Content_Types].xml') continue;
    const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
    if (!defaults.has(extension) && !overrides.has(name)) throw new Error(`部件缺少内容类型：${name}`);
  }
  for (const [name, content] of entries) {
    if (!name.endsWith('.rels')) continue;
    const match = /^(?:(.*)\/)?_rels\/([^/]*)\.rels$/.exec(name);
    if (!match) throw new Error(`关系部件路径无效：${name}`);
    const base = match[1] ? `${match[1]}/` : '';
    if (match[2] && !entries.has(`${base}${match[2]}`)) throw new Error(`关系源部件不存在：${name}`);
    tags(decoder.decode(content), (tag, attributes) => {
      if (tag !== 'Relationship' || attributes.TargetMode === 'External') return;
      if (!attributes.Target || !entries.has(resolveRelationshipTarget(base, attributes.Target))) throw new Error(`关系目标不存在：${name} ${attributes.Target ?? ''}`);
    });
  }
  return entries;
}
