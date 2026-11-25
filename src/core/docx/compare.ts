import { bodyLocations } from './body-structure.js';
import { unescapeXml, xmlElements, type XmlElement } from './xml.js';
import { sha256Hex } from './zip.js';

export type DifferenceKind = 'filled' | 'inserted' | 'modified' | 'deleted' | 'objectLost' | 'formatChanged';
export interface Difference { id: string; kind: DifferenceKind; address: string; before: string; after: string; subtype?: 'bracketText'; }
interface ProtectedObject { identity: string; start: number; end: number; }
interface Unit {
  address: string;
  kind: 'p' | 'table' | 'row' | 'cell';
  text: string;
  objectText: string;
  shape: string;
  children: Unit[];
  objects: ProtectedObject[];
  properties: string[];
}
type Pair = [number | undefined, number | undefined];
const mediaNames = new Set(['w:drawing', 'w:pict', 'w:object']);
const objectNames = new Set([...mediaNames, 'w:fldSimple', 'w:fldChar', 'w:instrText', 'w:bookmarkStart', 'w:bookmarkEnd']);

function attributes(xml: string, element: XmlElement): Map<string, string> {
  return new Map([...xml.slice(element.start, element.openEnd).matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(["'])([\s\S]*?)\2/g)]
    .map(match => [match[1], unescapeXml(match[3])]));
}

/** This reader uses XML structure only; it does not reuse the editing engine's text projection. */
function content(xml: string, bookmarkNames: ReadonlyMap<string, string>, refs?: ReadonlyMap<string, string>): { text: string; objects: ProtectedObject[]; properties: string[] } {
  const elements = xmlElements(xml), hiddenRuns = new Set<number>();
  for (const element of elements) {
    if (element.name !== 'w:vanish' || ['0', 'false', 'off'].includes(attributes(xml, element).get('w:val') ?? '')) continue;
    const property = element.parent;
    if (property !== null && elements[property].name === 'w:rPr' && elements[property].parent !== null) hiddenRuns.add(elements[property].parent!);
  }
  const excluded = elements.map(() => false), tokens: Array<{ start: number; end: number; text: string }> = [];
  for (const [index, element] of elements.entries()) {
    excluded[index] = (element.parent !== null && excluded[element.parent]) || hiddenRuns.has(index) ||
      ['w:txbxContent', 'w:del', 'w:moveFrom', ...mediaNames].includes(element.name);
    if (excluded[index] || !['w:t', 'w:tab', 'w:br', 'w:cr'].includes(element.name) || element.parent === null || elements[element.parent].name !== 'w:r') continue;
    tokens.push({ start: element.start, end: element.end, text: element.name === 'w:t' ? unescapeXml(xml.slice(element.openEnd, element.closeStart)) : element.name === 'w:tab' ? '\t' : '\n' });
  }
  const instructions = new Map<number, string>();
  let instruction: { start: number; value: string } | undefined;
  const flushInstruction = () => { if (instruction) instructions.set(instruction.start, instruction.value); instruction = undefined; };
  for (const element of elements) {
    if (element.name === 'w:instrText') {
      instruction ??= { start: element.start, value: '' };
      instruction.value += unescapeXml(xml.slice(element.openEnd, element.closeStart));
    } else if (element.name === 'w:fldChar' || ['w:t', 'w:tab', 'w:br', 'w:cr'].includes(element.name)) flushInstruction();
  }
  flushInstruction();
  const objects: ProtectedObject[] = [];
  for (const element of elements) {
    if (!objectNames.has(element.name) || element.name === 'w:instrText' && !instructions.has(element.start)) continue;
    let parent = element.parent, nested = false;
    while (parent !== null) {
      if (mediaNames.has(elements[parent].name)) { nested = true; break; }
      parent = elements[parent].parent;
    }
    if (nested) continue;
    const body = xml.slice(element.start, element.end), attrs = attributes(xml, element);
    let identity: string;
    if (element.name === 'w:bookmarkStart' || element.name === 'w:bookmarkEnd') {
      const id = attrs.get('w:id') ?? '';
      if (bookmarkNames.get(id)?.startsWith('_Seal_')) continue;
      identity = `${element.name}:${bookmarkNames.get(id) ?? `id:${id}`}`;
    } else if (element.name === 'w:fldSimple') identity = `${element.name}:${attrs.get('w:instr') ?? ''}`;
    else if (element.name === 'w:fldChar') identity = `${element.name}:${attrs.get('w:fldCharType') ?? ''}`;
    else if (element.name === 'w:instrText') identity = `${element.name}:${instructions.get(element.start)!}`;
    else {
      const targets = [...body.matchAll(/\br:(?:embed|link|id)\s*=\s*(["'])([\s\S]*?)\1/g)]
        .map(match => refs?.get(unescapeXml(match[2])) ?? `relationship:${unescapeXml(match[2])}`).sort();
      identity = `${element.name}:${targets.length ? JSON.stringify(targets) : sha256Hex(body.replace(/\b(?:id|name|descr|title)\s*=\s*["'][^"']*["']/g, ''))}`;
    }
    objects.push({ identity, start: tokens.filter(token => token.end <= element.start).reduce((sum, token) => sum + token.text.length, 0), end: tokens.filter(token => token.start < element.end).reduce((sum, token) => sum + token.text.length, 0) });
  }
  const properties = elements.filter(element => ['w:pPr', 'w:rPr', 'w:tcPr', 'w:trPr', 'w:tblPr'].includes(element.name)).map(element => xml.slice(element.start, element.end));
  return { text: tokens.map(token => token.text).join(''), objects, properties };
}

function units(xml: string, refs?: ReadonlyMap<string, string>): Unit[] {
  const elements = xmlElements(xml), childIndices = elements.map(() => [] as number[]), bookmarks = new Map<string, string>();
  for (const [index, element] of elements.entries()) {
    if (element.parent !== null) childIndices[element.parent].push(index);
    if (element.name === 'w:bookmarkStart') {
      const attrs = attributes(xml, element);
      if (attrs.has('w:id') && attrs.has('w:name')) bookmarks.set(attrs.get('w:id')!, attrs.get('w:name')!);
    }
  }
  const locations = bodyLocations(xml), firstReadable: Array<string | undefined> = elements.map(element => locations.get(element.start));
  for (let index = elements.length - 1; index >= 0; index--) {
    const parent = elements[index].parent;
    if (parent !== null && firstReadable[index]) firstReadable[parent] = firstReadable[index];
  }
  const body = elements.findIndex(element => element.name === 'w:body');
  if (body < 0) throw new Error('Word 正文不存在');
  const kinds = new Map<string, Unit['kind']>([['w:p', 'p'], ['w:tbl', 'table'], ['w:tr', 'row'], ['w:tc', 'cell']]);
  const codes = { p: 'p', table: 't', row: 'r', cell: 'c' };
  const transparent = new Set(['w:sdt', 'w:sdtContent', 'w:customXml']);
  const collectChildren = (parent: number, allowed: readonly string[]): number[] => childIndices[parent].flatMap(index =>
    allowed.includes(elements[index].name) ? [index] : transparent.has(elements[index].name) ? collectChildren(index, allowed) : []);
  const buildChildren = (parent: number, prefix: string, allowed: readonly string[]): Unit[] => {
    const counts = new Map<string, number>();
    return collectChildren(parent, allowed).map(index => {
      const element = elements[index], kind = kinds.get(element.name)!;
      const ordinal = counts.get(kind) ?? 0;
      counts.set(kind, ordinal + 1);
      let ancestor = element.parent, fallback: string | undefined;
      while (ancestor !== null && !fallback) { fallback = locations.get(elements[ancestor].start); ancestor = elements[ancestor].parent; }
      const address = locations.get(element.start) ?? firstReadable[index] ?? fallback ?? `${prefix}${codes[kind]}:${ordinal}`;
      const childAllowed = kind === 'table' ? ['w:tr'] : kind === 'row' ? ['w:tc'] : kind === 'cell' ? ['w:p', 'w:tbl'] : [];
      const children = buildChildren(index, `${address}/`, childAllowed);
      let ownXml = '', cursor = element.start;
      const addressedChildren = collectChildren(index, childAllowed);
      for (const child of addressedChildren) { ownXml += xml.slice(cursor, elements[child].start); cursor = elements[child].end; }
      ownXml += xml.slice(cursor, element.end);
      const own = content(ownXml, bookmarks, refs);
      return { address, kind, objectText: own.text, text: children.length ? [...(own.text ? [own.text] : []), ...children.map(child => child.text)].join('\n') : own.text, shape: `${kind}[${children.map(child => child.shape).join(',')}]`, children, objects: own.objects, properties: own.properties };
    });
  };
  return buildChildren(body, '', ['w:p', 'w:tbl']);
}

/** Linear-space alignment has no lookahead limit; ties are deterministic. */
function linearAlignment<T>(before: readonly T[], after: readonly T[], pairCost: (a: T, b: T) => number, gap: number): Pair[] {
  const row = (a0: number, a1: number, b0: number, b1: number, reverse: boolean): Float64Array => {
    const width = b1 - b0, costs = Float64Array.from({ length: width + 1 }, (_, index) => index * gap);
    for (let i = 0; i < a1 - a0; i++) {
      let diagonal = costs[0]; costs[0] = (i + 1) * gap;
      for (let j = 0; j < width; j++) {
        const previous = costs[j + 1];
        costs[j + 1] = Math.min(diagonal + pairCost(before[reverse ? a1 - 1 - i : a0 + i], after[reverse ? b1 - 1 - j : b0 + j]), previous + gap, costs[j] + gap);
        diagonal = previous;
      }
    }
    return costs;
  };
  const splitAt = (a0: number, middle: number, a1: number, b0: number, b1: number): number => {
    const left = row(a0, middle, b0, b1, false), right = row(middle, a1, b0, b1, true);
    let split = 0, best = Infinity;
    for (let j = 0; j <= b1 - b0; j++) {
      const cost = left[j] + right[b1 - b0 - j];
      if (cost < best) { best = cost; split = j; }
    }
    return b0 + split;
  };
  const result: Pair[] = [];
  const visit = (a0: number, a1: number, b0: number, b1: number): void => {
    if (a0 === a1) { for (let j = b0; j < b1; j++) result.push([undefined, j]); return; }
    if (b0 === b1) { for (let i = a0; i < a1; i++) result.push([i, undefined]); return; }
    if (a1 - a0 === 1 || b1 - b0 === 1) {
      const width = b1 - b0 + 1, costs = new Float64Array((a1 - a0 + 1) * width);
      for (let i = a1 - a0; i >= 0; i--) for (let j = b1 - b0; j >= 0; j--) {
        costs[i * width + j] = i === a1 - a0 ? (b1 - b0 - j) * gap : j === b1 - b0 ? (a1 - a0 - i) * gap :
          Math.min(pairCost(before[a0 + i], after[b0 + j]) + costs[(i + 1) * width + j + 1], gap + costs[(i + 1) * width + j], gap + costs[i * width + j + 1]);
      }
      let i = 0, j = 0;
      while (i < a1 - a0 || j < b1 - b0) {
        if (i < a1 - a0 && j < b1 - b0 && costs[i * width + j] === pairCost(before[a0 + i], after[b0 + j]) + costs[(i + 1) * width + j + 1]) result.push([a0 + i++, b0 + j++]);
        else if (i < a1 - a0 && costs[i * width + j] === gap + costs[(i + 1) * width + j]) result.push([a0 + i++, undefined]);
        else result.push([undefined, b0 + j++]);
      }
      return;
    }
    const middle = Math.floor((a0 + a1) / 2), split = splitAt(a0, middle, a1, b0, b1);
    visit(a0, middle, b0, split);
    visit(middle, a1, split, b1);
  };
  let prefix = 0, suffix = 0;
  while (prefix < Math.min(before.length, after.length) && pairCost(before[prefix], after[prefix]) === 0) {
    result.push([prefix, prefix]); prefix++;
  }
  while (suffix < Math.min(before.length, after.length) - prefix && pairCost(before[before.length - 1 - suffix], after[after.length - 1 - suffix]) === 0) suffix++;
  visit(prefix, before.length - suffix, prefix, after.length - suffix);
  for (let k = suffix; k > 0; k--) result.push([before.length - k, after.length - k]);
  return result;
}

function aligned(before: Unit[], after: Unit[]): Array<[Unit | undefined, Unit | undefined]> {
  const same = (a: Unit, b: Unit) => a.kind === b.kind && a.text === b.text && a.shape === b.shape &&
    (a.text !== '' || JSON.stringify([a.properties, a.objects.map(object => object.identity)]) === JSON.stringify([b.properties, b.objects.map(object => object.identity)]));
  let prefix = 0, suffix = 0;
  while (prefix < Math.min(before.length, after.length) && same(before[prefix], after[prefix])) prefix++;
  while (suffix < Math.min(before.length, after.length) - prefix && same(before[before.length - 1 - suffix], after[after.length - 1 - suffix])) suffix++;
  const a = before.slice(prefix, before.length - suffix), b = after.slice(prefix, after.length - suffix);
  const anchors = linearAlignment(a, b, (left, right) => same(left, right) ? 0 : 3, 1).filter(([i, j]) => i !== undefined && j !== undefined);
  const grams = (text: string) => new Set(Array.from({ length: Math.max(text.length - 1, 1) }, (_, i) => text.slice(i, i + 2)));
  const beforeGrams = new Map(a.map(unit => [unit, grams(unit.text)])), afterGrams = new Map(b.map(unit => [unit, grams(unit.text)]));
  const replacementCost = (left: Unit, right: Unit): number => {
    if (left.kind !== right.kind) return Infinity;
    const x = beforeGrams.get(left)!, y = afterGrams.get(right)!;
    const overlap = [...x].filter(gram => y.has(gram)).length;
    return 9 - Math.round(6 * overlap / (x.size + y.size));
  };
  const result: Array<[Unit | undefined, Unit | undefined]> = before.slice(0, prefix).map((unit, i) => [unit, after[i]]);
  let i = 0, j = 0;
  for (const [ai, bj] of [...anchors, [a.length, b.length] as Pair]) {
    const endA = ai!, endB = bj!;
    for (const [x, y] of linearAlignment(a.slice(i, endA), b.slice(j, endB), replacementCost, 5)) result.push([x === undefined ? undefined : a[i + x], y === undefined ? undefined : b[j + y]]);
    if (endA < a.length && endB < b.length) result.push([a[endA], b[endB]]);
    i = endA + 1; j = endB + 1;
  }
  for (let k = suffix; k > 0; k--) result.push([before[before.length - k], after[after.length - k]]);
  return result;
}

function filled(before: string, after: string): boolean {
  if (!before.trim()) return !!after.trim();
  const escaped = (part: string) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let pattern = '^', cursor = 0, hasBlank = false;
  const tokens = /(?:\s*\d{0,4}\s*年\s*\d{0,2}\s*月\s*\d{0,2}\s*日)|(?:（\s*）|\(\s*\)|\[\s*\]|【\s*】)|[_＿]+|\s+|[□☐☑■√]/gu;
  for (const match of before.matchAll(tokens)) {
    pattern += escaped(before.slice(cursor, match.index));
    const token = match[0];
    const date = /^\s*(\d{0,4})\s*年\s*(\d{0,2})\s*月\s*(\d{0,2})\s*日$/.exec(token);
    if (date) {
      pattern += `\\s*${date[1] || '\\d+'}\\s*年\\s*${date[2] || '\\d+'}\\s*月\\s*${date[3] || '\\d+'}\\s*日`;
      hasBlank ||= !date[1] || !date[2] || !date[3];
    } else if (/^[□☐☑■√]$/u.test(token)) { pattern += `[${token}${'□☐'.includes(token) ? '☑■√' : '□☐'}]`; hasBlank = true; }
    else { pattern += '[\\s\\S]*?'; hasBlank = true; }
    cursor = match.index + token.length;
  }
  return hasBlank && new RegExp(pattern + escaped(before.slice(cursor)) + '$', 'u').test(after);
}

function bracketText(before: string, after: string): boolean {
  let start = 0, end = before.length, otherEnd = after.length;
  while (start < end && start < otherEnd && before[start] === after[start]) start++;
  while (end > start && otherEnd > start && before[end - 1] === after[otherEnd - 1]) { end--; otherEnd--; }
  const pairs = new Map([['（', '）'], ['(', ')'], ['[', ']'], ['【', '】']]);
  const stack: Array<{ open: string; start: number }> = [];
  for (let index = 0; index < before.length; index++) {
    const char = before[index];
    if (pairs.has(char)) stack.push({ open: char, start: index });
    else if (stack.length && pairs.get(stack[stack.length - 1].open) === char) {
      const range = stack.pop()!;
      if (start >= range.start && end <= index + 1) return true;
    }
  }
  return false;
}

function difference(kind: DifferenceKind, address: string, before: string, after: string, details?: unknown, reportAddress = address): Difference {
  return { id: sha256Hex(JSON.stringify([kind, address, before, after, ...(details === undefined ? [] : [details])])), kind, address: reportAddress, before, after, ...(kind === 'modified' && bracketText(before, after) ? { subtype: 'bracketText' as const } : {}) };
}

/** Map every surviving addressed descendant, using the same structural correspondence as comparison. */
export function mapBodyAddresses(beforeXml: string, afterXml: string): Map<string, string> {
  const result = new Map<string, string>();
  const visit = (before: Unit[], after: Unit[]) => {
    for (const [a, b] of aligned(before, after)) {
      if (!a || !b) continue;
      result.set(a.address, b.address);
      visit(a.children, b.children);
    }
  };
  visit(units(beforeXml), units(afterXml));
  return result;
}

function objectPlacement(before: string, after: string): (a: ProtectedObject, b: ProtectedObject) => boolean {
  if (before === after) return (a, b) => a.start === b.start && a.end === b.end;
  const boundaries = new Map<number, Set<number>>();
  let i = 0, j = 0;
  const record = () => { const values = boundaries.get(i) ?? new Set<number>(); values.add(j); boundaries.set(i, values); };
  record();
  for (const [a, b] of linearAlignment(before.split(''), after.split(''), (left, right) => left === right ? 0 : 1, 1)) {
    if (a !== undefined) i++;
    if (b !== undefined) j++;
    record();
  }
  return (a, b) => (boundaries.get(a.start)?.has(b.start) === true && boundaries.get(a.end)?.has(b.end) === true) ||
    ((before.slice(0, a.start) === after.slice(0, b.start) || filled(before.slice(0, a.start), after.slice(0, b.start))) &&
     (before.slice(a.end) === after.slice(b.end) || filled(before.slice(a.end), after.slice(b.end))));
}

/** Compare only the two documents; no edit operations or ledger are consulted. */
export function compareBodyXml(beforeXml: string, afterXml: string, relationships?: { before: ReadonlyMap<string, string>; after: ReadonlyMap<string, string> }): Difference[] {
  const differences: Difference[] = [];
  const lostObjects = (a: Unit, b?: Unit) => {
    if (!a.objects.length) return;
    const remaining = [...(b?.objects ?? [])], placement = b && remaining.length ? objectPlacement(a.objectText, b.objectText) : undefined;
    for (const [index, object] of a.objects.entries()) {
      const match = remaining.findIndex(candidate => candidate.identity === object.identity && placement!(object, candidate));
      if (match >= 0) remaining.splice(match, 1);
      else differences.push(difference('objectLost', a.address, object.identity, '', [index, b?.objectText ?? '', b?.objects ?? []], b?.address ?? a.address));
    }
  };
  const lostTree = (unit: Unit) => { lostObjects(unit); unit.children.forEach(lostTree); };
  const compare = (before: Unit[], after: Unit[]) => {
    for (const [a, b] of aligned(before, after)) {
      if (!a && b) differences.push(difference('inserted', b.address, '', b.text));
      else if (a && !b) { differences.push(difference('deleted', a.address, a.text, '')); lostTree(a); }
      else if (a && b) {
        lostObjects(a, b);
        if (a.children.length || b.children.length) {
          compare(a.children, b.children);
          if (a.objectText !== b.objectText) differences.push(difference(filled(a.objectText, b.objectText) ? 'filled' : 'modified', a.address, a.objectText, b.objectText, undefined, b.address));
        } else if (a.text !== b.text) differences.push(difference(filled(a.text, b.text) ? 'filled' : 'modified', a.address, a.text, b.text, undefined, b.address));
        if (a.text === b.text && JSON.stringify(a.properties) !== JSON.stringify(b.properties)) differences.push(difference('formatChanged', a.address, a.text, b.text, [a.properties, b.properties], b.address));
      }
    }
  };
  compare(units(beforeXml, relationships?.before), units(afterXml, relationships?.after));
  return differences;
}
