import { resolveAddress } from './addresses.js';
import { bodyLocations } from './body-structure.js';
import { bodyViewNodes, isEmptyViewCell, viewBlankHints, type BodyViewNode, type ViewHint } from './document-view.js';
import { outline, styleChain, wordStyles, xmlAttributes, type WordStyles } from './outline.js';
import { resolveRelationshipTarget, validatePackageStructure } from './package-structure.js';
import { assertXmlCharacters, unescapeXml, xmlElements } from './xml.js';
import { sha256Hex } from './zip.js';

export type ReadDocumentMode = 'outline' | 'blocks' | 'search';
/** The caller supplies only current, unconfirmed anchors. Existing yellow is not a Seal marker. */
export interface PendingReadMark { address: string; find: string; category: string; offset?: number; }
/** Host-supplied current display context; never expose this field in Agent tool parameters. */
export interface ReadDocumentContext { pending?: readonly PendingReadMark[]; }
export interface ReadDocumentCursor { document: string; request: string; item: number; character: number; }
export interface ReadDocumentOptions {
  mode: ReadDocumentMode;
  from?: string;
  to?: string;
  onlyHints?: boolean;
  query?: string;
  limit?: number;
  /** Budget for rendered UTF-16 characters, excluding bounded metadata. Range: 2..50000. */
  maxChars?: number;
  /** Search context on each side of the first literal match. Range: 0..200. */
  context?: number;
  cursor?: ReadDocumentCursor;
}
export interface ReadDocumentItem {
  kind: 'paragraph' | 'table' | 'row' | 'cell' | 'section';
  address: string | null;
  location: string;
  editable: boolean;
  label?: string;
  text: string;
  /** Display-string offsets are for continuation, never for editing. */
  fragment: { offset: number; totalCharacters: number; complete: boolean };
  level?: number;
  parent?: string | null;
  range?: { from: string; to: string };
  counts?: { paragraphs: number; tables: number; hints: number };
}
export interface ReadDocumentResult {
  mode: ReadDocumentMode;
  items: ReadDocumentItem[];
  characters: number;
  truncated: boolean;
  /** Replay these options; the host must resupply the current display context separately. */
  next: ReadDocumentOptions | null;
  notice: string | null;
  warnings: string[];
  warningCount: number;
  warningsTruncated: boolean;
}
interface Segment { text: string; xmlStart: number; plain: number | null; search: number; hidden: boolean; object: boolean; }
interface Projection { segments: Segment[]; plain: string; search: string; }
interface PendingRange { start: number; end: number; category: string; key: string; }
interface Entry extends Omit<ReadDocumentItem, 'fragment'> { source: Projection; hints: ViewHint[]; storyId: string; xmlStart: number; xmlEnd: number; }
interface Relationship { id: string; type: string; target: string; external: boolean; }
const media = new Set(['w:drawing', 'w:pict', 'w:object']);
const visibleNames = new Set(['w:t', 'w:tab', 'w:br', 'w:cr']);
const enabled = (value: string | undefined) => value === undefined || ['1', 'true', 'on'].includes(value);
const emptyProjection = (): Projection => ({ segments: [], plain: '', search: '' });

function project(xml: string, styles: WordStyles): Projection {
  const elements = xmlElements(xml), children = elements.map(() => [] as number[]);
  for (const [index, element] of elements.entries()) if (element.parent !== null) children[element.parent].push(index);
  const child = (parent: number, name: string) => children[parent]?.find(index => elements[index].name === name);
  const value = (index: number | undefined) => index === undefined ? undefined : xmlAttributes(xml, elements[index]).get('w:val');
  const states = new Map<number, { hidden: boolean; directHidden: boolean }>();
  const runState = (run: number): { hidden: boolean; directHidden: boolean } => {
    const cached = states.get(run);
    if (cached) return cached;
    let paragraph = elements[run].parent;
    while (paragraph !== null && elements[paragraph].name !== 'w:p') paragraph = elements[paragraph].parent;
    const pPr = paragraph === null ? undefined : child(paragraph, 'w:pPr');
    const pStyle = pPr === undefined ? undefined : value(child(pPr, 'w:pStyle'));
    const rPr = child(run, 'w:rPr'), rStyle = rPr === undefined ? undefined : value(child(rPr, 'w:rStyle'));
    let hidden = styles.defaultHidden;
    for (const style of [...styleChain(styles, pStyle ?? styles.defaultParagraph, 'paragraph'), ...styleChain(styles, rStyle ?? styles.defaultCharacter, 'character')]) if (style.hidden === true) hidden = !hidden;
    const vanish = rPr === undefined ? undefined : child(rPr, 'w:vanish');
    const directHidden = vanish !== undefined && enabled(value(vanish));
    if (vanish !== undefined) hidden = enabled(value(vanish));
    const state = { hidden, directHidden }; states.set(run, state); return state;
  };
  const result: Projection = emptyProjection();
  for (const element of elements) {
    if (!visibleNames.has(element.name) && !media.has(element.name)) continue;
    if (element.parent === null || elements[element.parent].name !== 'w:r') continue;
    let ancestor: number | null = element.parent, excluded = false;
    while (ancestor !== null) {
      if (['w:txbxContent', 'w:del', 'w:moveFrom'].includes(elements[ancestor].name) || media.has(elements[ancestor].name)) excluded = true;
      ancestor = elements[ancestor].parent;
    }
    if (excluded) continue;
    const state = runState(element.parent), object = media.has(element.name);
    const text = object ? element.name === 'w:object' ? '[对象]' : '[图片]' : element.name === 'w:t' ? unescapeXml(xml.slice(element.openEnd, element.closeStart)) : element.name === 'w:tab' ? '\t' : '\n';
    result.segments.push({ text, xmlStart: element.start, plain: state.directHidden || object ? null : result.plain.length, search: result.search.length, hidden: state.hidden, object });
    if (!object) { result.search += text; if (!state.directHidden) result.plain += text; }
  }
  return result;
}

interface ReadWarnings { messages: string[]; count: number; }
function pendingRanges(xml: string, projection: Projection, marks: readonly PendingReadMark[], warnings: ReadWarnings): PendingRange[] {
  const result: PendingRange[] = [], targets = new Map<string, { start: number; end: number }>();
  const visit = (nodes: readonly BodyViewNode[]) => { for (const node of nodes) { targets.set(node.address, { start: node.start, end: node.end }); visit(node.children); } };
  visit(bodyViewNodes(xml));
  const visible = projection.segments.filter(segment => segment.plain !== null);
  const lowerBound = (position: number): number => {
    let low = 0, high = visible.length;
    while (low < high) { const middle = (low + high) >>> 1; if (visible[middle].xmlStart < position) low = middle + 1; else high = middle; }
    return low;
  };
  const warn = (message: string, address: string) => {
    warnings.count++;
    if (warnings.messages.length < 20) {
      let detail = address.slice(0, 160);
      if (/[\uD800-\uDBFF]/.test(detail[detail.length - 1] ?? '')) detail = detail.slice(0, -1);
      warnings.messages.push(`${message}：${detail}${address.length > detail.length ? '…' : ''}`);
    }
  };
  for (const [index, mark] of marks.entries()) {
    const target = targets.get(mark.address);
    if (!target) { warn('待定锚点地址不存在', mark.address); continue; }
    const startIndex = lowerBound(target.start), endIndex = lowerBound(target.end);
    const segments = visible.slice(startIndex, endIndex);
    const text = segments.map(segment => segment.text).join(''), first = text.indexOf(mark.find);
    const start = mark.offset ?? first;
    if (start < 0 || text.slice(start, start + mark.find.length) !== mark.find || mark.offset === undefined && text.indexOf(mark.find, start + 1) >= 0 || !segments.length) { warn('待定锚点无法唯一定位', mark.address); continue; }
    result.push({ start: segments[0].plain! + start, end: segments[0].plain! + start + mark.find.length, category: mark.category, key: `pending:${index}` });
  }
  return result;
}

interface Wrapper { key: string; open: string; close: string; }
function render(entry: Entry, pending: readonly PendingRange[], globalPlain: ReadonlyMap<number, number>, bounds?: { start: number; end: number }): string {
  if (!entry.source.segments.length) return entry.text;
  const output: string[] = [], stack: Wrapper[] = [];
  const append = (text: string, wrappers: Wrapper[]) => {
    let common = 0;
    while (common < Math.min(stack.length, wrappers.length) && stack[common].key === wrappers[common].key) common++;
    while (stack.length > common) output.push(stack.pop()!.close);
    for (const wrapper of wrappers.slice(common)) { output.push(wrapper.open); stack.push(wrapper); }
    output.push(text);
  };
  for (const segment of entry.source.segments) {
    const hidden = segment.hidden ? [{ key: 'hidden', open: '‹隐藏›', close: '‹/隐藏›' }] : [];
    if (segment.object) {
      if (!bounds || segment.search >= bounds.start && segment.search <= bounds.end) append(segment.text, hidden);
      continue;
    }
    const from = bounds ? Math.max(0, bounds.start - segment.search) : 0, to = bounds ? Math.min(segment.text.length, bounds.end - segment.search) : segment.text.length;
    if (from >= to) continue;
    const position = segment.plain === null ? undefined : globalPlain.get(entry.xmlStart + segment.xmlStart);
    const cuts = new Set<number>([from, to]);
    if (segment.plain !== null) for (const hint of entry.hints) for (const offset of [hint.start, hint.end]) {
      const local = offset - segment.plain;
      if (local > from && local < to) cuts.add(local);
    }
    if (position !== undefined && entry.editable) for (const mark of pending) for (const offset of [mark.start, mark.end]) {
      const local = offset - position;
      if (local > from && local < to) cuts.add(local);
    }
    const points = [...cuts].sort((a, b) => a - b);
    for (let i = 0; i < points.length - 1; i++) {
      const offset = points[i], wrappers: Wrapper[] = [...hidden];
      if (!segment.hidden && position !== undefined && entry.editable) for (const mark of pending) if (position + offset >= mark.start && position + offset < mark.end) wrappers.push({ key: mark.key, open: `«待定:${mark.category}»`, close: '«/待定»' });
      if (!segment.hidden && segment.plain !== null) for (const [index, hint] of entry.hints.entries()) if (hint.kind !== 'checkbox' && segment.plain + offset >= hint.start && segment.plain + offset < hint.end) wrappers.push({ key: hint.id, open: `⟦${index}:`, close: '⟧' });
      append(segment.text.slice(offset, points[i + 1]).replace(/[☐■√]/g, symbol => symbol === '☐' ? '□' : '☑'), wrappers);
    }
  }
  append('', []);
  return output.join('');
}

function bodyEntries(xml: string, styles: WordStyles, part: string, editable: boolean, label?: string): Entry[] {
  const nodes = bodyViewNodes(xml), entries: Entry[] = [];
  const visit = (selected: readonly BodyViewNode[]) => {
    for (const node of selected) {
      const source = node.kind === 'paragraph' ? project(node.xml, styles) : emptyProjection();
      const emptyCell = isEmptyViewCell(node);
      const hints = node.kind === 'paragraph' ? viewBlankHints(node.address, source.plain, node.xml) : emptyCell ? viewBlankHints(node.address, '', '', true) : [];
      entries.push({ address: editable ? node.address : null, location: `${part}#${node.address}`, editable, label, kind: node.kind, text: node.continuation ? '〃' : emptyCell ? '⟦0:⟧' : '', source, hints, storyId: part, xmlStart: node.start, xmlEnd: node.end });
      if (!node.continuation) visit(node.children);
    }
  };
  visit(nodes);
  const elements = xmlElements(xml), locations = bodyLocations(xml);
  for (const element of elements) {
    const address = locations.get(element.start);
    if (element.name !== 'w:p' || !address?.startsWith('word/document.xml#readonly:p:')) continue;
    let parent = element.parent, textbox = false;
    while (parent !== null) { if (elements[parent].name === 'w:txbxContent') textbox = true; parent = elements[parent].parent; }
    const fragment = xml.slice(element.start, element.end), source = project(fragment, styles);
    const location = `${part}#${address.slice('word/document.xml#'.length)}`;
    entries.push({ address: null, location, editable: false, label: textbox ? '文本框（不可编辑）' : label ?? '正文容器（不可编辑）', kind: 'paragraph', text: '', source, hints: viewBlankHints(location, source.plain, fragment), storyId: part, xmlStart: element.start, xmlEnd: element.end });
  }
  return entries.sort((a, b) => a.xmlStart - b.xmlStart);
}

function relationships(xml: string): Relationship[] {
  return xmlElements(xml).filter(element => element.name.split(':').pop() === 'Relationship').map(element => {
    const attrs = xmlAttributes(xml, element);
    return { id: attrs.get('Id') ?? '', type: attrs.get('Type')?.split('/').pop() ?? '', target: attrs.get('Target') ?? '', external: attrs.get('TargetMode') === 'External' };
  });
}

function relatedEntries(parts: ReadonlyMap<string, Uint8Array>, xml: string, rels: readonly Relationship[], styles: WordStyles): Entry[] {
  const decoder = new TextDecoder('utf-8', { fatal: true }), main = xmlElements(xml), result: Entry[] = [], seen = new Set<string>();
  const active = (index: number): boolean => {
    let parent = main[index].parent;
    while (parent !== null) {
      if (['w:del', 'w:moveFrom'].includes(main[parent].name) || main[parent].name.endsWith('PrChange')) return false;
      parent = main[parent].parent;
    }
    return true;
  };
  const attributeValues = (name: string, attribute: string): Set<string> => {
    const result = new Set<string>();
    for (const [index, element] of main.entries()) if (element.name === name && active(index)) {
      const value = xmlAttributes(xml, element).get(attribute);
      if (!value) throw new Error(`只读部件引用缺少标识：${name}`);
      result.add(value);
    }
    return result;
  };
  const headers = attributeValues('w:headerReference', 'r:id'), footers = attributeValues('w:footerReference', 'r:id');
  for (const [ids, type] of [[headers, 'header'], [footers, 'footer']] as const) for (const id of ids) if (id && !rels.some(relation => relation.id === id && relation.type === type)) throw new Error(`只读部件引用缺少关系：${id}`);
  const noteIds = { footnotes: attributeValues('w:footnoteReference', 'w:id'), endnotes: attributeValues('w:endnoteReference', 'w:id'), comments: new Set([...attributeValues('w:commentReference', 'w:id'), ...attributeValues('w:commentRangeStart', 'w:id'), ...attributeValues('w:commentRangeEnd', 'w:id')]) };
  for (const [type, ids] of Object.entries(noteIds)) if ([...ids].some(id => id !== undefined) && !rels.some(relation => relation.type === type)) throw new Error(`只读部件引用缺少关系：${type}`);
  for (const relation of rels) {
    const type = relation.type;
    if (type === 'header' ? !headers.has(relation.id) : type === 'footer' ? !footers.has(relation.id) : !['footnotes', 'endnotes', 'comments'].includes(type)) continue;
    if (relation.external) throw new Error(`不能读取外部只读部件：${relation.id}`);
    const path = resolveRelationshipTarget('word/', relation.target);
    if (seen.has(path)) continue;
    seen.add(path);
    const bytes = parts.get(path);
    if (!bytes) throw new Error(`只读部件不存在：${path}`);
    const story = decoder.decode(bytes), elements = xmlElements(story);
    const add = (inner: string, location: string, label: string) => result.push(...bodyEntries(`<w:document><w:body>${inner}</w:body></w:document>`, styles, location, false, `${label}（不可编辑）`));
    if (type === 'header' || type === 'footer') {
      const root = elements.find(element => element.name === (type === 'header' ? 'w:hdr' : 'w:ftr'));
      if (!root) throw new Error(`只读部件根节点无效：${path}`);
      add(story.slice(root.openEnd, root.closeStart), path, type === 'header' ? '页眉' : '页脚');
    } else {
      const root = elements.findIndex(element => element.name === `w:${type}`);
      if (root < 0) throw new Error(`只读部件根节点无效：${path}`);
      const tag = type === 'footnotes' ? 'w:footnote' : type === 'endnotes' ? 'w:endnote' : 'w:comment';
      const found = new Set<string>();
      for (const element of elements.filter(element => element.name === tag && element.parent === root)) {
        const attrs = xmlAttributes(story, element), id = attrs.get('w:id');
        if (!id || !noteIds[type as keyof typeof noteIds].has(id) || attrs.has('w:type') && attrs.get('w:type') !== 'normal') continue;
        found.add(id);
        add(story.slice(element.openEnd, element.closeStart), `${path}#${tag.slice(2)}:${id}`, type === 'comments' ? '批注' : type === 'endnotes' ? '尾注' : '脚注');
      }
      for (const id of noteIds[type as keyof typeof noteIds]) if (id && !found.has(id)) throw new Error(`只读注释记录不存在：${path} ${id}`);
    }
  }
  return result;
}

function readableEntries(parts: ReadonlyMap<string, Uint8Array>): Entry[] {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const xml = decoder.decode(parts.get('word/document.xml')!);
  const rels = relationships(parts.has('word/_rels/document.xml.rels') ? decoder.decode(parts.get('word/_rels/document.xml.rels')!) : '');
  const styleRelationship = rels.find(relation => relation.type === 'styles' && !relation.external);
  const stylesXml = styleRelationship ? decoder.decode(parts.get(resolveRelationshipTarget('word/', styleRelationship.target))!) : '';
  const styles = wordStyles(stylesXml);
  return [...bodyEntries(xml, styles, 'word/document.xml', true), ...relatedEntries(parts, xml, rels, styles)];
}

/** Full paragraph text from the same body and referenced stories available to read. */
export function readableParagraphs(parts: ReadonlyMap<string, Uint8Array>): Array<{ address: string; text: string }> {
  return readableEntries(parts)
    .filter(entry => entry.kind === 'paragraph')
    .map(entry => ({ address: entry.address ?? entry.location, text: entry.source.search }));
}

/** Read-only hints use the same structural projection and hint detection as the reading view. */
export function readOnlyHints(parts: ReadonlyMap<string, Uint8Array>) {
  return readableEntries(parts).filter(entry => !entry.editable).flatMap(entry => entry.hints.map((hint, index) => ({
    id: `${entry.location}#${index}`, address: null, location: entry.location, editable: false as const,
    label: entry.label, kind: hint.kind, text: hint.text.slice(0, 200),
    reason: '只读区域存在疑似空白', suggestion: '请由人检查并处理此只读区域。',
  })));
}

function normalized(options: ReadDocumentOptions): ReadDocumentOptions & { limit: number; maxChars: number; context: number } {
  if (!options || !['outline', 'blocks', 'search'].includes(options.mode)) throw new Error('mode 必须为 outline、blocks 或 search');
  if (Object.prototype.hasOwnProperty.call(options, 'pending')) throw new Error('待定显示上下文必须由宿主通过第三个参数提供');
  const limit = options.limit ?? (options.mode === 'search' ? 30 : 60), maxChars = options.maxChars ?? 12000, context = options.context ?? 40;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(maxChars) || maxChars < 2 || maxChars > 50000 || !Number.isSafeInteger(context) || context < 0 || context > 200) throw new Error('读取长度或分页参数无效');
  if (options.query !== undefined && (typeof options.query !== 'string' || options.query.length > 4096) || options.mode === 'search' && !options.query) throw new Error('搜索内容不能为空且不得超过 4096 字符');
  if (options.query !== undefined) assertXmlCharacters(options.query);
  if (options.from !== undefined && (typeof options.from !== 'string' || options.from.length > 2048)) throw new Error('起始地址无效');
  if (options.to !== undefined) {
    if (typeof options.to !== 'string' || !options.to || options.to.length > 2048) throw new Error('结束地址无效');
    if (options.mode !== 'blocks' && options.mode !== 'outline') throw new Error('to 参数仅适用于 blocks 与 outline 模式');
  }
  if (options.onlyHints !== undefined) {
    if (typeof options.onlyHints !== 'boolean') throw new Error('onlyHints 参数必须为布尔值');
    if (options.mode !== 'blocks') throw new Error('onlyHints 参数仅适用于 blocks 模式');
  }
  return {
    mode: options.mode,
    ...(options.from === undefined ? {} : { from: options.from }),
    ...(options.to === undefined ? {} : { to: options.to }),
    ...(options.onlyHints === undefined ? {} : { onlyHints: options.onlyHints }),
    ...(options.query === undefined ? {} : { query: options.query }),
    limit,
    maxChars,
    context,
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
  };
}

function trustedPending(context: ReadDocumentContext): readonly PendingReadMark[] {
  const pending = context.pending ?? [];
  if (!Array.isArray(pending) || pending.some(mark => !mark || typeof mark.address !== 'string' || !mark.address || typeof mark.find !== 'string' || !mark.find || typeof mark.category !== 'string' || !mark.category || /[«»\r\n]/.test(mark.category) || mark.offset !== undefined && (!Number.isSafeInteger(mark.offset) || mark.offset < 0))) throw new Error('待定显示上下文无效');
  for (const mark of pending) { assertXmlCharacters(mark.find); assertXmlCharacters(mark.category); }
  return pending;
}

/** Read a package without host services, ledger access, or writes. Display offsets never enter editing APIs. */
export async function readDocument(bytes: Uint8Array, options: ReadDocumentOptions, context: ReadDocumentContext = {}): Promise<ReadDocumentResult> {
  const request = normalized(options), marks = trustedPending(context), parts = await validatePackageStructure(bytes), decoder = new TextDecoder('utf-8', { fatal: true });
  const xml = decoder.decode(parts.get('word/document.xml')!), rels = relationships(parts.has('word/_rels/document.xml.rels') ? decoder.decode(parts.get('word/_rels/document.xml.rels')!) : '');
  const styleRelationship = rels.find(relation => relation.type === 'styles' && !relation.external);
  const stylesXml = styleRelationship ? decoder.decode(parts.get(resolveRelationshipTarget('word/', styleRelationship.target))!) : '';
  if (styleRelationship && !xmlElements(stylesXml).some(element => element.name === 'w:styles' && element.parent === null)) throw new Error('样式部件根节点无效');
  const styles = wordStyles(stylesXml), warnings: ReadWarnings = { messages: [], count: 0 }, main = project(xml, styles);
  const pending = pendingRanges(xml, main, marks, warnings), globalPlain = new Map(main.segments.filter(segment => segment.plain !== null).map(segment => [segment.xmlStart, segment.plain!]));
  let entries: Entry[];
  if (request.mode === 'outline') {
    const parents: Array<{ level: number; address: string }> = [];
    entries = outline(xml, stylesXml).map(section => {
      while (parents.length && parents[parents.length - 1].level >= section.level) parents.pop();
      const parent = parents.length ? parents[parents.length - 1].address : null;
      parents.push({ level: section.level, address: section.from });
      const target = resolveAddress(xml, section.from), source = project(target.xml, styles);
      const title: Entry = { kind: 'paragraph', address: section.from, location: '', editable: true, text: section.title, source, hints: [], storyId: 'word/document.xml', xmlStart: target.start, xmlEnd: target.end };
      return { kind: 'section', address: section.from, location: `word/document.xml#${section.from}`, editable: true, text: render(title, pending, globalPlain), level: section.level, parent, range: { from: section.from, to: section.to }, counts: { paragraphs: section.paragraphs, tables: section.tables, hints: section.hints }, source: emptyProjection(), hints: [], storyId: 'word/document.xml', xmlStart: 0, xmlEnd: 0 };
    });
  } else {
    entries = [...bodyEntries(xml, styles, 'word/document.xml', true), ...relatedEntries(parts, xml, rels, styles)];
    if (request.mode === 'search') entries = entries.flatMap(entry => {
      const index = entry.source.search.indexOf(request.query!);
      if (index < 0) return [];
      let start = Math.max(0, index - request.context), end = Math.min(entry.source.search.length, index + request.query!.length + request.context);
      if (/[\uDC00-\uDFFF]/.test(entry.source.search[start] ?? '')) start--;
      if (/[\uD800-\uDBFF]/.test(entry.source.search[end - 1] ?? '')) end++;
      return [{ ...entry, text: render(entry, pending, globalPlain, { start, end }), source: emptyProjection() }];
    });
    else entries = entries.map(entry => ({ ...entry, text: render(entry, pending, globalPlain), source: emptyProjection() }));
  }
  let startIndex = 0;
  if (request.from !== undefined) {
    const index = entries.findIndex(entry => entry.address === request.from || entry.location === request.from);
    if (index < 0) throw new Error(`起始地址不存在于当前视图：${request.from}`);
    startIndex = index;
  }
  let endIndex = entries.length;
  if (request.to !== undefined) {
    const toIndex = entries.findIndex(entry => entry.address === request.to || entry.location === request.to);
    if (toIndex < 0) throw new Error(`结束地址不存在于当前视图：${request.to}`);
    if (toIndex < startIndex) throw new Error(`结束地址位于起始地址之前：${request.to}`);
    let last = toIndex;
    if (request.mode === 'blocks') {
      const toEntry = entries[toIndex];
      while (last + 1 < entries.length && entries[last + 1].storyId === toEntry.storyId && entries[last + 1].xmlStart < toEntry.xmlEnd) {
        last++;
      }
    }
    endIndex = last + 1;
  }
  entries = entries.slice(startIndex, endIndex);
  if (request.onlyHints) {
    entries = entries.filter(entry => entry.hints.length > 0);
  }
  if (entries.some(entry => entry.location.length > 4096 || (entry.address?.length ?? 0) > 2048)) throw new Error('文档位置超过视图支持的长度');
  const displayFingerprint = sha256Hex(JSON.stringify(marks.map(mark => [mark.address, mark.find, mark.category, mark.offset])));
  const document = sha256Hex(bytes), fingerprint = sha256Hex(JSON.stringify([request.mode, request.from, request.to, Boolean(request.onlyHints), request.query, request.context, displayFingerprint]));
  const cursor = request.cursor;
  if (cursor && (cursor.document !== document || cursor.request !== fingerprint || !Number.isSafeInteger(cursor.item) || cursor.item < 0 || cursor.item >= entries.length || !Number.isSafeInteger(cursor.character) || cursor.character < 0 || cursor.character > entries[cursor.item].text.length || cursor.character > 0 && /[\uDC00-\uDFFF]/.test(entries[cursor.item].text[cursor.character] ?? ''))) throw new Error('续读参数无效或文档、读取条件、待定状态已改变');
  let index = cursor?.item ?? 0, offset = cursor?.character ?? 0, characters = 0;
  const items: ReadDocumentItem[] = [];
  while (index < entries.length && items.length < request.limit) {
    const entry = entries[index], remaining = request.maxChars - characters;
    if (remaining === 0 && entry.text.length > offset) break;
    let end = Math.min(entry.text.length, offset + remaining);
    if (end < entry.text.length && /[\uD800-\uDBFF]/.test(entry.text[end - 1] ?? '')) end--;
    if (end === offset && entry.text.length > offset) break;
    const { source: _source, hints: _hints, xmlStart: _xmlStart, xmlEnd: _xmlEnd, storyId: _storyId, ...item } = entry;
    items.push({ ...item, text: entry.text.slice(offset, end), fragment: { offset, totalCharacters: entry.text.length, complete: end === entry.text.length } });
    characters += end - offset;
    if (end < entry.text.length) { offset = end; break; }
    index++; offset = 0;
  }
  const truncated = index < entries.length;
  const next = truncated ? { ...request, cursor: { document, request: fingerprint, item: index, character: offset } } : null;
  return { mode: request.mode, items, characters, truncated, next, notice: truncated ? '输出已截断；将 next 原样作为下次 options 继续读取。同一块的 text 片段按 fragment.offset 连接还原展示。' : null, warnings: warnings.messages, warningCount: warnings.count, warningsTruncated: warnings.count > warnings.messages.length };
}
