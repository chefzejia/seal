import { inflateRawSync } from 'node:zlib';
import { SaxesParser } from 'saxes';
import { crc32 } from '../../core/docx/zip.js';
import { parseDocumentBody } from '../../core/docx/xml.js';

export function probeDocx(bytes: Buffer): void {
  try {
    let end = -1;
    for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
      if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break; }
    }
    if (end < 0) throw new Error('Invalid ZIP end record');
    const count = bytes.readUInt16LE(end + 10), directorySize = bytes.readUInt32LE(end + 12), directoryOffset = bytes.readUInt32LE(end + 16);
    if (bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0 || bytes.readUInt16LE(end + 8) !== count || directoryOffset + directorySize !== end) throw new Error('Invalid ZIP directory');
    let offset = directoryOffset, document: Buffer | undefined, totalSize = 0;
    const names = new Set<string>();
    for (let i = 0; i < count; i++) {
      if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid ZIP directory entry');
      const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10), checksum = bytes.readUInt32LE(offset + 16);
      const compressedSize = bytes.readUInt32LE(offset + 20), size = bytes.readUInt32LE(offset + 24);
      const nameLength = bytes.readUInt16LE(offset + 28), extraLength = bytes.readUInt16LE(offset + 30), commentLength = bytes.readUInt16LE(offset + 32);
      const local = bytes.readUInt32LE(offset + 42), next = offset + 46 + nameLength + extraLength + commentLength;
      if (next > end || (flags & 1) !== 0 || ![0, 8].includes(method) || local + 30 > directoryOffset || bytes.readUInt32LE(local) !== 0x04034b50) throw new Error('Invalid ZIP local entry');
      const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength), name = new TextDecoder('utf-8', {fatal:true}).decode(nameBytes);
      const localNameLength = bytes.readUInt16LE(local + 26), localExtraLength = bytes.readUInt16LE(local + 28), data = local + 30 + localNameLength + localExtraLength;
      if (names.has(name) || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method || localNameLength !== nameLength || !bytes.subarray(local + 30, local + 30 + localNameLength).equals(nameBytes) || data + compressedSize > directoryOffset) throw new Error('Invalid ZIP entry bounds');
      if ((flags & 8) === 0 && (bytes.readUInt32LE(local + 14) !== checksum || bytes.readUInt32LE(local + 18) !== compressedSize || bytes.readUInt32LE(local + 22) !== size)) throw new Error('Invalid ZIP entry size');
      names.add(name); totalSize += size;
      if (size > 256 * 1024 * 1024 || totalSize > 512 * 1024 * 1024) throw new Error('Word archive exceeds decompression limit');
      const compressed = bytes.subarray(data, data + compressedSize);
      const content = method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.max(1, size + 1) });
      if (content.length !== size || crc32(content) !== checksum) throw new Error('Invalid ZIP entry content');
      if (/\.(?:xml|rels)$/i.test(name)) {
        const xml = new TextDecoder('utf-8', { fatal: true }).decode(content);
        const parser = new SaxesParser({ xmlns: true });
        parser.on('doctype', () => { throw new Error('Document type declarations are not supported'); });
        parser.write(xml).close();
      }
      if (name === 'word/document.xml') document = content;
      offset = next;
    }
    if (offset !== end || document === undefined) throw new Error('Missing Word document');
    const xml = new TextDecoder('utf-8', {fatal:true}).decode(document);
    parseDocumentBody(xml);
  } catch {
    throw new Error('Word 文件损坏或无法读取，请重新选择有效的 Word 文件。');
  }
}
