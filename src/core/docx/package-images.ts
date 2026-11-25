import { SaxesParser } from 'saxes';
import type { HostPort } from '../host.js';
import { validateImageBytes } from './zip.js';

export interface ImageIssue { part: string; reason: string }

/** Check image parts one at a time so decoded pixel buffers are not retained. */
export async function validatePackageImages(entries: Map<string, Uint8Array>, host: Pick<HostPort, 'validateImage'> = {}): Promise<ImageIssue[]> {
  const defaults = new Map<string, string>(), overrides = new Map<string, string>();
  const parser = new SaxesParser();
  parser.on('opentag', tag => {
    const attributes = tag.attributes as Record<string, string>;
    const name = tag.name.split(':').pop();
    if (name === 'Default' && attributes.Extension && attributes.ContentType) defaults.set(attributes.Extension.toLowerCase(), attributes.ContentType.toLowerCase());
    if (name === 'Override' && attributes.PartName && attributes.ContentType) overrides.set(attributes.PartName.replace(/^\//, ''), attributes.ContentType.toLowerCase());
  });
  parser.write(new TextDecoder('utf-8', { fatal: true }).decode(entries.get('[Content_Types].xml')!)).close();
  const issues: ImageIssue[] = [];
  for (const [part, bytes] of entries) {
    const extension = part.slice(part.lastIndexOf('.') + 1).toLowerCase();
    const mime = overrides.get(part) ?? defaults.get(extension);
    if (!mime?.startsWith('image/')) continue;
    try {
      if (mime === 'image/png' || mime === 'image/jpeg') await validateImageBytes(bytes, mime);
      else if (host.validateImage) await host.validateImage(bytes, mime);
      else throw new Error(`宿主不支持解码 ${mime}`);
    } catch (error) {
      issues.push({ part, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return issues;
}
