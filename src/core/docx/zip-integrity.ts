import { crc32 } from './zip.js';

/** Verify the ZIP directory against local headers and uncompressed entry bytes. */
export function validateZipIntegrity(bytes: Uint8Array, entries: ReadonlyMap<string, Uint8Array>): void {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fail = (): never => { throw new Error('无效 ZIP 结构或内容校验失败'); };
  const range = (offset: number, size: number) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || size < 0 || offset + size > bytes.length) fail();
  };
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (data.getUint32(i, true) === 0x06054b50 && i + 22 + data.getUint16(i + 20, true) === bytes.length) { end = i; break; }
  }
  if (end < 0) fail();
  if (data.getUint16(end + 4, true) !== 0 || data.getUint16(end + 6, true) !== 0 || data.getUint16(end + 8, true) !== data.getUint16(end + 10, true)) fail();
  const count = data.getUint16(end + 10, true);
  const directorySize = data.getUint32(end + 12, true);
  const directoryOffset = data.getUint32(end + 16, true);
  if (directoryOffset + directorySize !== end) fail();
  range(directoryOffset, directorySize);
  let offset = directoryOffset;
  const seen = new Set<string>();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let i = 0; i < count; i++) {
    range(offset, 46);
    if (data.getUint32(offset, true) !== 0x02014b50) fail();
    const flags = data.getUint16(offset + 8, true), method = data.getUint16(offset + 10, true);
    const checksum = data.getUint32(offset + 16, true), compressedSize = data.getUint32(offset + 20, true), size = data.getUint32(offset + 24, true);
    const nameLength = data.getUint16(offset + 28, true), extraLength = data.getUint16(offset + 30, true), commentLength = data.getUint16(offset + 32, true);
    const local = data.getUint32(offset + 42, true);
    range(offset + 46, nameLength + extraLength + commentLength);
    if ((flags & 1) !== 0 || (method !== 0 && method !== 8)) fail();
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = decoder.decode(nameBytes);
    if (seen.has(name)) fail();
    seen.add(name);
    range(local, 30);
    if (data.getUint32(local, true) !== 0x04034b50 || data.getUint16(local + 6, true) !== flags || data.getUint16(local + 8, true) !== method) fail();
    const localNameLength = data.getUint16(local + 26, true), localExtraLength = data.getUint16(local + 28, true);
    range(local + 30, localNameLength + localExtraLength + compressedSize);
    if (localNameLength !== nameLength || nameBytes.some((value, index) => bytes[local + 30 + index] !== value)) fail();
    if (local + 30 + localNameLength + localExtraLength + compressedSize > directoryOffset) fail();
    if (!(flags & 8) && (data.getUint32(local + 14, true) !== checksum || data.getUint32(local + 18, true) !== compressedSize || data.getUint32(local + 22, true) !== size)) fail();
    if (!name.endsWith('/')) {
      const content = entries.get(name);
      if (!content || content.length !== size || crc32(content) !== checksum) fail();
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (offset !== end || [...entries.keys()].some(name => !seen.has(name))) fail();
}
