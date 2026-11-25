import { SaxesParser } from 'saxes';

/** Decode and parse every XML part without replacing invalid UTF-8 bytes. */
export function validateXmlParts(entries: ReadonlyMap<string, Uint8Array>): void {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (const [name, bytes] of entries) {
    if (!/\.(?:xml|rels)$/i.test(name)) continue;
    try {
      const parser = new SaxesParser({ xmlns: true });
      parser.on('doctype', () => { throw new Error('DOCTYPE is not allowed'); });
      parser.write(decoder.decode(bytes)).close();
    } catch (error) {
      throw new Error(`无效 XML 部件 ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
