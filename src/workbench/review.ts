import type { DraftCheckReport, CheckCode } from "../core/bid/report.js";

export interface ReviewItem {
  key: string;
  draft: string;
  code: CheckCode;
  group: string;
  id: string;
  address: string;
  sectionKey: string;
  sectionLabel: string;
  value: string;
  before: string;
  reason: string;
  pendingIds: string[];
  differenceIds: string[];
  hintIds: string[];
  actions: Array<"confirm" | "accept" | "review" | "modify">;
  nodeId?: string;
  title?: string;
}

export interface OutlineSectionHint {
  address: string;
  title: string;
  from?: string;
  to?: string;
  level?: number;
  startBlockIndex?: number;
}

export interface DraftOutlineHint {
  draft: string;
  blockOrder?: readonly string[];
  sections: readonly OutlineSectionHint[];
}

export interface ReviewSectionSummary {
  key: string;
  label: string;
  count: number;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");
const normalizeTitle = (value: string) => value.replace(/\s+/g, " ").trim();

interface PreparedOutline {
  blockIndex: Map<string, number>;
  headings: Array<{
    address: string;
    to?: string;
    title: string;
    blockPos?: number;
    paragraphIndex?: number;
  }>;
}

function prepareOutlines(
  outlines: readonly DraftOutlineHint[],
): Map<string, PreparedOutline> {
  const prepared = new Map<string, PreparedOutline>();
  for (const outline of outlines) {
    const blockIndex = new Map<string, number>();
    if (outline.blockOrder) {
      for (const [index, address] of outline.blockOrder.entries()) {
        blockIndex.set(address, index);
      }
    }
    const headings = outline.sections
      .map((section) => {
        const title = normalizeTitle(section.title);
        if (!title) return null;
        const address = section.from ?? section.address;
        const blockPos = section.startBlockIndex ?? blockIndex.get(address);
        const pMatch = /^p:(\d+)$/.exec(address);
        return {
          address,
          to: section.to,
          title,
          blockPos,
          paragraphIndex: pMatch ? Number(pMatch[1]) : undefined,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
    if (headings.some((item) => item.blockPos !== undefined)) {
      headings.sort((a, b) => (a.blockPos ?? 0) - (b.blockPos ?? 0));
    }
    prepared.set(outline.draft, { blockIndex, headings });
  }
  return prepared;
}

function resolveSection(
  draft: string,
  address: string,
  outlines: ReadonlyMap<string, PreparedOutline>,
): { sectionKey: string; sectionLabel: string } {
  const tableMatch = /^(t:\d+)(?:\/|$)/.exec(address);
  const tableAddress = tableMatch ? tableMatch[1] : null;
  const topMatch = /^((?:p|t):\d+)(?:\/|$)/.exec(address);
  const topAddress = topMatch ? topMatch[1] : null;
  const outline = outlines.get(draft);
  let heading: { address: string; title: string } | undefined;
  if (outline && topAddress) {
    const targetPos = outline.blockIndex.get(topAddress);
    if (targetPos !== undefined) {
      for (const candidate of outline.headings) {
        if (candidate.blockPos !== undefined && candidate.blockPos <= targetPos) {
          heading = candidate;
        }
      }
    } else {
      const pMatch = /^p:(\d+)$/.exec(topAddress);
      if (pMatch) {
        const targetParagraph = Number(pMatch[1]);
        for (const candidate of outline.headings) {
          if (
            candidate.paragraphIndex !== undefined &&
            candidate.paragraphIndex <= targetParagraph
          ) {
            heading = candidate;
          }
        }
      } else {
        for (const candidate of outline.headings) {
          if (candidate.address === topAddress || candidate.to === topAddress) {
            heading = candidate;
          }
        }
      }
    }
  }
  if (tableAddress) {
    return heading
      ? {
          sectionKey: `${draft}::${heading.address}::${tableAddress}`,
          sectionLabel: `${draft} · ${heading.title} · 表格 ${tableAddress}`,
        }
      : {
          sectionKey: `${draft}::body::${tableAddress}`,
          sectionLabel: `${draft} · 表格 ${tableAddress}`,
        };
  }
  return heading
    ? {
        sectionKey: `${draft}::${heading.address}`,
        sectionLabel: `${draft} · ${heading.title}`,
      }
    : {
        sectionKey: `${draft}::body`,
        sectionLabel: `${draft} · 正文`,
      };
}

/** Merge only a uniquely located changed fragment and its exact pending range. */
export function reviewItems(
  reports: readonly DraftCheckReport[],
  blocks: ReadonlyMap<string, string> = new Map(),
  outlines: readonly DraftOutlineHint[] = [],
): ReviewItem[] {
  const preparedOutlines = prepareOutlines(outlines);
  const items: ReviewItem[] = [];
  for (const report of reports)
    for (const [code, issues] of Object.entries(report.results))
      for (const [index, raw] of issues.entries()) {
        const issue = record(raw),
          nodeId = text(issue.nodeId),
          title = text(issue.title),
          id =
            text(issue.id) ||
            text(issue.name) ||
            (code === "C17" && nodeId
              ? `${nodeId}:${text(issue.kind)}:${text(issue.ref) || index}`
              : String(index));
        if (
          code === "C05" &&
          items.some(
            (item) =>
              item.draft === report.draft &&
              item.code === "C04" &&
              item.id === id,
          )
        ) {
          const pending = items.find(
            (item) =>
              item.draft === report.draft &&
              item.code === "C04" &&
              item.id === id,
          )!;
          pending.reason += `；${text(issue.reason)}`;
          continue;
        }
        const address = text(issue.address),
          { sectionKey, sectionLabel } = resolveSection(
            report.draft,
            address,
            preparedOutlines,
          ),
          value =
            text(issue.value) ||
            text(issue.after) ||
            text(issue.text) ||
            text(issue.hintText) ||
            title;
        const item: ReviewItem = {
          key: `${report.draft}:${code}:${id}`,
          draft: report.draft,
          code: code as CheckCode,
          group:
            code === "C06" && issue.subtype === "bracketText"
              ? "bracketText"
              : code === "C04"
                ? `pending:${text(issue.category)}`
                : code,
          id,
          address,
          sectionKey,
          sectionLabel,
          value,
          before: text(issue.before),
          reason:
            text(issue.reason) || text(issue.note) || text(issue.suggestion),
          pendingIds: code === "C04" ? [id] : [],
          differenceIds: ["C06", "C07"].includes(code) ? [id] : [],
          hintIds: ["C02", "C03"].includes(code) && address ? [id] : [],
          actions: [],
          ...(nodeId ? { nodeId } : {}),
          ...(title ? { title } : {}),
        };
        if (code === "C04" && id !== "ledger") item.actions.push("confirm");
        if (["C06", "C07"].includes(code)) item.actions.push("accept");
        if (["C02", "C03"].includes(code) && address)
          item.actions.push("review");
        if (address && value && ["C04", "C06"].includes(code))
          item.actions.push("modify");
        if (code === "C06" && value && issue.kind === "modified") {
          const block = blocks.get(`${report.draft}:${address}`),
            start = block?.indexOf(value) ?? -1;
          const candidates = items.filter(
            (pending) =>
              pending.draft === report.draft &&
              pending.code === "C04" &&
              pending.address === address &&
              pending.value === value,
          );
          const source = report.results.C04.map(record).find(
            (pending) => pending.id === candidates[0]?.id,
          );
          if (
            candidates.length === 1 &&
            start >= 0 &&
            block!.indexOf(value, start + 1) < 0 &&
            source?.offset === start
          ) {
            candidates[0].differenceIds.push(id);
            candidates[0].before = item.before;
            candidates[0].actions.push("accept");
            if (item.group === "bracketText")
              candidates[0].group = "bracketText";
            continue;
          }
        }
        items.push(item);
      }
  return items;
}

export function reviewPage(
  items: readonly ReviewItem[],
  pages: Readonly<Record<string, number>> = {},
  size = 25,
  sectionFilters: Readonly<Record<string, string>> = {},
) {
  if (
    !pages ||
    typeof pages !== "object" ||
    Array.isArray(pages) ||
    Object.values(pages).some((page) => !Number.isSafeInteger(page) || page < 0)
  )
    throw new Error("审阅分页位置无效");
  if (
    !sectionFilters ||
    typeof sectionFilters !== "object" ||
    Array.isArray(sectionFilters) ||
    Object.values(sectionFilters).some(
      (value) => value !== undefined && typeof value !== "string",
    )
  )
    throw new Error("审阅分节筛选无效");
  const groups = new Map<string, ReviewItem[]>();
  for (const item of items) {
    const group = groups.get(item.group) ?? [];
    group.push(item);
    groups.set(item.group, group);
  }
  return [...groups].map(([id, values]) => {
    const sectionMap = new Map<string, ReviewSectionSummary>();
    for (const item of values) {
      const key = item.sectionKey || `${item.draft}::body`;
      const label = item.sectionLabel || `${item.draft} · 正文`;
      const existing = sectionMap.get(key);
      if (existing) existing.count++;
      else sectionMap.set(key, { key, label, count: 1 });
    }
    const sections = [...sectionMap.values()];
    const requested = sectionFilters[id];
    const activeSection =
      typeof requested === "string" &&
      requested !== "" &&
      sectionMap.has(requested)
        ? requested
        : null;
    const filtered = activeSection
      ? values.filter(
          (item) =>
            (item.sectionKey || `${item.draft}::body`) === activeSection,
        )
      : values;
    const page = pages[id] ?? 0,
      offset = Math.max(0, Math.floor(page)) * size;
    return {
      id,
      count: filtered.length,
      totalCount: values.length,
      page,
      items: filtered.slice(offset, offset + size),
      nextPage: offset + size < filtered.length ? page + 1 : null,
      sections,
      activeSection,
    };
  });
}

export interface EditBuffer {
  baseRevision: string;
  original: string;
  value: string;
}
export function editBuffer(
  previous: EditBuffer | undefined,
  revision: string,
  value: string,
): EditBuffer {
  return previous && previous.value !== previous.original
    ? previous
    : { baseRevision: revision, original: value, value };
}
export function dirtyBuffers(
  buffers: Readonly<Record<string, EditBuffer>>,
): boolean {
  return Object.values(buffers).some(
    (buffer) => buffer.original !== buffer.value,
  );
}
