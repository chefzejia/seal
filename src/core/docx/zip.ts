// Pure TypeScript ZIP reader/writer, SHA-256, CRC32, and PNG/JPEG dimension parser
// Zero node:* imports to strictly satisfy Layer 1 (src/core) boundary guard.

import jpeg from 'jpeg-js';

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c >>> 0;
}

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// Pure TS synchronous SHA-256
const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(n: number, x: number): number {
  return (x >>> n) | (x << (32 - n));
}

export function sha256Hex(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const bitLen = bytes.length * 8;
  const padLen = ((bytes.length + 9 + 63) & ~63);
  const padded = new Uint8Array(padLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(padLen - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let i = 0; i < padLen; i += 64) {
    for (let t = 0; t < 16; t++) {
      w[t] = view.getUint32(i + t * 4, false);
    }
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(7, w[t - 15]) ^ rotr(18, w[t - 15]) ^ (w[t - 15] >>> 3);
      const s1 = rotr(17, w[t - 2]) ^ rotr(19, w[t - 2]) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }

    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K256[t] + w[t]) >>> 0;
      const S0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((v) => v.toString(16).padStart(8, "0"))
    .join("");
}

async function inflateRaw(compressed: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  writer.write(compressed as unknown as BufferSource);
  writer.close();
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

async function deflateRaw(raw: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate-raw");
  const writer = cs.writable.getWriter();
  writer.write(raw as unknown as BufferSource);
  writer.close();
  const reader = cs.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export async function readZip(zipBytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  let eocdOffset = -1;
  for (let i = zipBytes.byteLength - 22; i >= Math.max(0, zipBytes.byteLength - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error("Invalid ZIP archive: End of Central Directory not found");
  }

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);
  const entries = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();

  let pos = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) {
      throw new Error(`Invalid Central Directory header at ${pos}`);
    }
    const method = view.getUint16(pos + 10, true);
    const compSize = view.getUint32(pos + 20, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localHeaderOffset = view.getUint32(pos + 42, true);

    const name = decoder.decode(zipBytes.subarray(pos + 46, pos + 46 + nameLen));
    pos += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) continue;

    if (view.getUint32(localHeaderOffset, true) !== 0x04034b50) {
      throw new Error(`Invalid Local File header for ${name}`);
    }
    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const compData = zipBytes.subarray(dataStart, dataStart + compSize);

    if (method === 0) {
      entries.set(name, new Uint8Array(compData));
    } else if (method === 8) {
      entries.set(name, await inflateRaw(compData));
    } else {
      throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
    }
  }

  return entries;
}

export async function writeZip(entries: Map<string, Uint8Array>): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const cdParts: Uint8Array[] = [];
  let localOffset = 0;
  let count = 0;

  for (const [name, rawData] of entries.entries()) {
    const nameBytes = encoder.encode(name);
    const crc = crc32(rawData);
    const compData = await deflateRaw(rawData);
    const method = 8;

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 flag
    lv.setUint16(8, method, true);
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0x21, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, compData.length, true);
    lv.setUint32(22, rawData.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    localParts.push(localHeader, compData);

    const cdHeader = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cdHeader.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, compData.length, true);
    cv.setUint32(24, rawData.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, localOffset, true);
    cdHeader.set(nameBytes, 46);

    cdParts.push(cdHeader);
    localOffset += localHeader.length + compData.length;
    count++;
  }

  let cdSize = 0;
  for (const p of cdParts) cdSize += p.length;

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, count, true);
  ev.setUint16(10, count, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, localOffset, true);
  ev.setUint16(20, 0, true);

  const totalSize = localOffset + cdSize + 22;
  const out = new Uint8Array(totalSize);
  let pos = 0;
  for (const p of localParts) {
    out.set(p, pos);
    pos += p.length;
  }
  for (const p of cdParts) {
    out.set(p, pos);
    pos += p.length;
  }
  out.set(eocd, pos);
  return out;
}

interface ParsedImage {
  widthPx: number; heightPx: number; mime: "image/png" | "image/jpeg";
  png?: { depth: number; channels: number; interlaced: boolean; data: Uint8Array[] };
}

function imageStructure(bytes: Uint8Array): ParsedImage {
  const invalid = (): never => { throw new Error("Invalid or truncated PNG/JPEG image"); };
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (signature.every((value, index) => bytes[index] === value)) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let pos = 8, widthPx = 0, heightPx = 0, depth = 0, channels = 0, interlaced = false, palette = false, indexed = false;
    const data: Uint8Array[] = [];
    while (pos < bytes.length) {
      if (pos + 12 > bytes.length) invalid();
      const length = view.getUint32(pos), end = pos + 12 + length;
      if (end > bytes.length) invalid();
      const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
      if (crc32(bytes.subarray(pos + 4, end - 4)) !== view.getUint32(end - 4)) invalid();
      if (pos === 8 && type !== "IHDR") invalid();
      if (type === "IHDR") {
        if (pos !== 8 || length !== 13) invalid();
        widthPx = view.getUint32(pos + 8); heightPx = view.getUint32(pos + 12); depth = bytes[pos + 16];
        const color = bytes[pos + 17], depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
        if (!widthPx || !heightPx || widthPx > 0x7fffffff || heightPx > 0x7fffffff || !depths[color] || !depths[color].includes(depth) || bytes[pos + 18] !== 0 || bytes[pos + 19] !== 0 || bytes[pos + 20] > 1) invalid();
        channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color];
        indexed = color === 3; interlaced = bytes[pos + 20] === 1;
      } else if (type === "PLTE") {
        if (data.length || !length || length > 768 || length % 3 !== 0) invalid(); palette = true;
      } else if (type === "IDAT") {
        if (indexed && !palette) invalid(); data.push(bytes.subarray(pos + 8, end - 4));
      } else if (type === "IEND") {
        if (length !== 0 || end !== bytes.length || !data.some(chunk => chunk.length > 0)) invalid();
        return { widthPx, heightPx, mime: "image/png", png: { depth, channels, interlaced, data } };
      } else if ((type.charCodeAt(0) & 32) === 0) invalid();
      pos = end;
    }
    return invalid();
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let pos = 2, widthPx = 0, heightPx = 0, scanned = false, progressive = false;
    const quantizers = new Set<number>(), huffman = new Set<number>(), components = new Map<number, number>();
    const scannedComponents = new Set<number>();
    while (pos < bytes.length) {
      if (bytes[pos++] !== 0xff) invalid();
      while (bytes[pos] === 0xff) pos++;
      const marker = bytes[pos++];
      if (marker === 0xd9) {
        if (!widthPx || !heightPx || !scanned || scannedComponents.size !== components.size) invalid();
        return { widthPx, heightPx, mime: "image/jpeg" };
      }
      if (marker === 0xd8 || marker === 0 || marker >= 0xd0 && marker <= 0xd7 || pos + 2 > bytes.length) invalid();
      const length = (bytes[pos] << 8) | bytes[pos + 1], end = pos + length;
      if (length < 2 || end > bytes.length) invalid();
      if (marker === 0xc0 || marker === 0xc2) {
        const count = bytes[pos + 7];
        if (components.size || length !== 8 + 3 * count || ![1, 3, 4].includes(count) || bytes[pos + 2] !== 8) invalid();
        heightPx = (bytes[pos + 3] << 8) | bytes[pos + 4]; widthPx = (bytes[pos + 5] << 8) | bytes[pos + 6];
        if (!widthPx || !heightPx) invalid();
        progressive = marker === 0xc2;
        for (let i = pos + 8; i < end; i += 3) {
          const id = bytes[i], sampling = bytes[i + 1], table = bytes[i + 2];
          if (components.has(id) || (sampling >> 4) < 1 || (sampling >> 4) > 4 || (sampling & 15) < 1 || (sampling & 15) > 4 || table > 3) invalid();
          components.set(id, table);
        }
      } else if (marker === 0xdb) {
        let cursor = pos + 2;
        if (cursor === end) invalid();
        while (cursor < end) {
          const spec = bytes[cursor++], precision = spec >> 4, id = spec & 15;
          if (precision > 1 || id > 3 || cursor + 64 * (precision + 1) > end) invalid();
          for (let i = 0; i < 64; i++) {
            const value = precision === 0 ? bytes[cursor++] : (bytes[cursor++] << 8) | bytes[cursor++];
            if (value === 0) invalid();
          }
          quantizers.add(id);
        }
      } else if (marker === 0xc4) {
        let cursor = pos + 2;
        if (cursor === end) invalid();
        while (cursor < end) {
          const spec = bytes[cursor++];
          if ((spec >> 4) > 1 || (spec & 15) > 3 || cursor + 16 > end) invalid();
          let symbols = 0, remainingCodes = 1;
          for (let i = 0; i < 16; i++) {
            const count = bytes[cursor++]; symbols += count; remainingCodes = remainingCodes * 2 - count;
            if (remainingCodes <= 0) invalid();
          }
          if (!symbols || symbols > 256 || cursor + symbols > end) invalid();
          const values = bytes.subarray(cursor, cursor + symbols);
          if (new Set(values).size !== symbols || ((spec >> 4) === 0 && values.some(value => value > 11)) || ((spec >> 4) === 1 && values.some(value => (value & 15) > 10))) invalid();
          cursor += symbols; huffman.add(spec);
        }
      } else if (marker === 0xda) {
        const count = bytes[pos + 2], spectralStart = bytes[end - 3], spectralEnd = bytes[end - 2], approximation = bytes[end - 1];
        if (!components.size || count < 1 || count > components.size || length !== 6 + 2 * count) invalid();
        if (progressive ? spectralStart > spectralEnd || spectralEnd > 63 || (spectralStart === 0 && spectralEnd !== 0) || (spectralStart > 0 && count !== 1) || (approximation >> 4) > 13 || (approximation & 15) > 13 || ((approximation >> 4) !== 0 && (approximation >> 4) !== (approximation & 15) + 1) : spectralStart !== 0 || spectralEnd !== 63 || approximation !== 0) invalid();
        const selected = new Set<number>();
        for (let i = pos + 3; i < end - 3; i += 2) {
          const id = bytes[i], tables = bytes[i + 1], quantizer = components.get(id);
          if (quantizer === undefined || selected.has(id) || !quantizers.has(quantizer) || (tables >> 4) > 3 || (tables & 15) > 3) invalid();
          if ((spectralStart === 0 && (approximation >> 4) === 0 && !huffman.has(tables >> 4)) || (spectralEnd > 0 && !huffman.has(0x10 | (tables & 15)))) invalid();
          selected.add(id); scannedComponents.add(id);
        }
      } else if (marker === 0xdd) {
        if (length !== 4) invalid();
      } else if (!(marker >= 0xe0 && marker <= 0xef) && marker !== 0xfe) {
        // Supported JPEG is 8-bit Huffman baseline or progressive DCT.
        invalid();
      }
      pos = end;
      if (marker === 0xda) {
        const start = pos;
        while (pos < bytes.length) {
          if (bytes[pos] !== 0xff) { pos++; continue; }
          const next = bytes[pos + 1];
          if (next === 0 || next >= 0xd0 && next <= 0xd7) { pos += 2; continue; }
          if (next === 0xff) { pos++; continue; }
          break;
        }
        if (pos === start) invalid(); scanned = true;
      }
    }
  }
  return invalid();
}

export function parseImageDimensions(bytes: Uint8Array): { widthPx: number; heightPx: number } {
  const { widthPx, heightPx } = imageStructure(bytes);
  return { widthPx, heightPx };
}

/** Validate PNG scanlines or decode JPEG pixels before mounting. */
export async function validateImageBytes(bytes: Uint8Array, declaredMime: string): Promise<{ widthPx: number; heightPx: number }> {
  const image = imageStructure(bytes);
  if (image.mime !== declaredMime) throw new Error(`Image format mismatch: declared ${declaredMime}, actual ${image.mime}`);
  if (image.png !== undefined) {
    const { data, depth, channels, interlaced } = image.png;
    const compressed = new Uint8Array(data.reduce((length, part) => length + part.length, 0));
    let offset = 0; for (const part of data) { compressed.set(part, offset); offset += part.length; }
    const decoded = new Uint8Array(await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer());
    const passes = interlaced ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
    let cursor = 0;
    for (const [x, y, dx, dy] of passes) {
      const width = Math.max(0, Math.ceil((image.widthPx - x) / dx)), height = Math.max(0, Math.ceil((image.heightPx - y) / dy));
      if (!width || !height) continue;
      const rowBytes = Math.ceil(width * depth * channels / 8);
      for (let row = 0; row < height; row++) {
        if (cursor >= decoded.length || decoded[cursor] > 4) throw new Error("Invalid PNG scanline data");
        cursor += rowBytes + 1;
      }
    }
    if (cursor !== decoded.length) throw new Error("Invalid PNG decoded image length");
  } else {
    const decoded = jpeg.decode(bytes, { useTArray: true, tolerantDecoding: false });
    if (decoded.width !== image.widthPx || decoded.height !== image.heightPx || decoded.data.length !== image.widthPx * image.heightPx * 4) {
      throw new Error('Invalid JPEG decoded image dimensions');
    }
  }
  return { widthPx: image.widthPx, heightPx: image.heightPx };
}
