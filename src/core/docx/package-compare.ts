import { SaxesParser } from 'saxes';
import { compareBodyXml, type Difference } from './compare.js';
import { resolveRelationshipTarget, validatePackageStructure } from './package-structure.js';
import { sha256Hex } from './zip.js';

function relationshipIdentities(parts: ReadonlyMap<string, Uint8Array>): Map<string, string> {
  const result = new Map<string, string>(), cache = new Map<string, string>();
  const rels = parts.get('word/_rels/document.xml.rels');
  if (!rels) return result;
  const parser = new SaxesParser();
  parser.on('opentag', tag => {
    if (tag.name.split(':').pop() !== 'Relationship') return;
    const attributes = tag.attributes as Record<string, string>;
    if (!attributes.Id || !attributes.Target) return;
    if (attributes.TargetMode === 'External') { result.set(attributes.Id, `external:${JSON.stringify([attributes.Type ?? "", attributes.Target])}`); return; }
    const target = resolveRelationshipTarget('word/', attributes.Target);
    const bytes = parts.get(target);
    if (!bytes) return;
    let digest = cache.get(target);
    if (!digest) { digest = sha256Hex(bytes); cache.set(target, digest); }
    result.set(attributes.Id, `part:${JSON.stringify([attributes.Type ?? "", digest])}`);
  });
  parser.write(new TextDecoder('utf-8', { fatal: true }).decode(rels)).close();
  return result;
}

/** Compare package content independently of the operations that produced either file. */
export async function compareDocuments(beforeBytes: Uint8Array, afterBytes: Uint8Array): Promise<Difference[]> {
  const before = await validatePackageStructure(beforeBytes), after = await validatePackageStructure(afterBytes);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  return compareBodyXml(decoder.decode(before.get('word/document.xml')!), decoder.decode(after.get('word/document.xml')!), {
    before: relationshipIdentities(before), after: relationshipIdentities(after),
  });
}
