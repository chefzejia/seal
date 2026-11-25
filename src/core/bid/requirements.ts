import { validatePackageStructure } from "../docx/package-structure.js";
import { readableParagraphs } from "../docx/read-document.js";
import { resolveAddress } from "../docx/addresses.js";
import { sha256Hex } from "../docx/zip.js";

export const REQUIREMENT_KINDS = [
  "资格要求",
  "评分项",
  "实质性条款",
  "废标条款",
  "格式要求",
  "递交要求",
] as const;

export const REQUIREMENTS_PAGE_MAX_CHARS = 45000;
export const REQUIREMENTS_ITEM_MAX_CHARS = 16000;

export interface Requirement {
  id: string;
  kind: string;
  text: string;
  quote: string;
  source: { file: string; address: string };
  mustRespond: boolean;
  points?: number;
  responses: Array<{ draft: string; address: string }>;
  evidence?: string[];
}

export type RequirementsState =
  | { kind: "missing" }
  | { kind: "error"; reason: string }
  | { kind: "value"; items: Requirement[] };

export interface RequirementValidationError {
  id: string;
  field: string;
  source: { file?: string; address?: string } | null;
  reason: string;
  action: string;
  excerpt?: string;
}

export interface RequirementsPage {
  total: number;
  offset: number;
  limit: number;
  items: Requirement[];
  truncated: boolean;
  nextOffset: number | null;
}

const ALLOWED_ITEM_KEYS = new Set([
  "id",
  "kind",
  "text",
  "quote",
  "source",
  "mustRespond",
  "points",
  "responses",
  "evidence",
]);

const ALLOWED_PATCH_KEYS = new Set(["id", "responses", "evidence"]);

const FORBIDDEN_AUTHORIZATION_KEYS = new Set([
  "verified",
  "verifiedAt",
  "verifiedFields",
  "covered",
  "authorization",
  "coverage",
  "status",
]);

function validateResponsesField(
  rawResponses: unknown,
  id: string,
  source: { file?: string; address?: string } | null,
  errors: RequirementValidationError[],
): Array<{ draft: string; address: string }> | null {
  if (!Array.isArray(rawResponses)) {
    errors.push({
      id,
      field: "responses",
      source,
      reason: "要求响应列表 responses 必须是数组",
      action: "请提供 responses 数组（尚无响应分册时传空数组 []）。",
    });
    return null;
  }
  const initialErrors = errors.length;
  for (const [responseIndex, response] of rawResponses.entries()) {
    if (
      !object(response) ||
      !nonempty(response.draft) ||
      !nonempty(response.address) ||
      Object.keys(response).some((key) => key !== "draft" && key !== "address")
    ) {
      errors.push({
        id,
        field: `responses[${responseIndex}]`,
        source,
        reason: "要求响应位置无效；每项须仅含非空 draft 与 address",
        action: "请将 responses 每项写成 { draft, address }。",
      });
    }
  }
  if (errors.length > initialErrors) return null;
  return (rawResponses as Array<{ draft: string; address: string }>).map(
    (response) => ({ draft: response.draft, address: response.address }),
  );
}

function validateEvidenceField(
  rawEvidence: unknown,
  id: string,
  source: { file?: string; address?: string } | null,
  errors: RequirementValidationError[],
): string[] | undefined {
  if (rawEvidence === undefined) return undefined;
  if (
    !Array.isArray(rawEvidence) ||
    rawEvidence.some((entry) => !nonempty(entry))
  ) {
    errors.push({
      id,
      field: "evidence",
      source,
      reason: "要求证据列表 evidence 必须是非空字符串数组",
      action: "请传知识库证据记录 ID 字符串数组或省略 evidence。",
    });
    return undefined;
  }
  return [...(rawEvidence as string[])];
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const nonempty = (value: unknown): value is string =>
  typeof value === "string" && !!value.trim();

// Compatibility characters such as ① are literal content, not width variants.
const normalized = (text: string) =>
  text
    .replace(/[\uFF01-\uFFEE]+/gu, (width) => width.normalize("NFKC"))
    .replace(/\s/gu, "");

function sourceRefOf(item: Record<string, unknown>): {
  file?: string;
  address?: string;
} | null {
  if (!object(item.source)) return null;
  return {
    ...(typeof item.source.file === "string" ? { file: item.source.file } : {}),
    ...(typeof item.source.address === "string"
      ? { address: item.source.address }
      : {}),
  };
}

function validateRequirementItem(
  raw: unknown,
  index: number,
  seen: Set<string>,
): { item: Requirement | null; errors: RequirementValidationError[] } {
  const errors: RequirementValidationError[] = [];
  if (!object(raw)) {
    errors.push({
      id: `#${index}`,
      field: "item",
      source: null,
      reason: "要求条目必须是 JSON 对象",
      action: "请提供包含 id、kind、text、quote、source、mustRespond 与 responses 的对象。",
    });
    return { item: null, errors };
  }

  const id = nonempty(raw.id) ? raw.id : `#${index}`;
  const source = sourceRefOf(raw);

  if (!nonempty(raw.id)) {
    errors.push({
      id,
      field: "id",
      source,
      reason: "要求条目缺少非空 id",
      action: "请为每条要求提供唯一的非空字符串 id。",
    });
  } else if (seen.has(raw.id)) {
    errors.push({
      id: raw.id,
      field: "id",
      source,
      reason: `要求条目 id 重复：${raw.id}`,
      action: "请确保整批要求中每条 id 唯一。",
    });
  } else {
    seen.add(raw.id);
  }

  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_AUTHORIZATION_KEYS.has(key) || key.startsWith("__seal")) {
      errors.push({
        id,
        field: key,
        source,
        reason: `要求条目禁止设置人工覆盖或核实字段：${key}`,
        action: `请移除 ${key}；人工覆盖标记与核实只能由人在工作台界面操作。`,
      });
    } else if (!ALLOWED_ITEM_KEYS.has(key)) {
      errors.push({
        id,
        field: key,
        source,
        reason: `要求条目包含不支持的字段：${key}`,
        action: `允许字段：${[...ALLOWED_ITEM_KEYS].join("、")}。`,
      });
    }
  }

  if (
    !nonempty(raw.kind) ||
    !(REQUIREMENT_KINDS as readonly string[]).includes(raw.kind)
  ) {
    errors.push({
      id,
      field: "kind",
      source,
      reason: "要求类型无效",
      action: `请将 kind 设为以下之一：${REQUIREMENT_KINDS.join("、")}。`,
    });
  }

  if (!nonempty(raw.text)) {
    errors.push({
      id,
      field: "text",
      source,
      reason: "要求概括 text 不能为空",
      action: "请填写简明的要求概括 text。",
    });
  }

  if (!nonempty(raw.quote) || !normalized(raw.quote)) {
    errors.push({
      id,
      field: "quote",
      source,
      reason: "要求引文 quote 不能为空",
      action: "请填写来自招标副本来源块或前后五块的逐字原文片段 quote。",
    });
  }

  if (typeof raw.mustRespond !== "boolean") {
    errors.push({
      id,
      field: "mustRespond",
      source,
      reason: "mustRespond 必须为布尔值（true 或 false）",
      action: "请将 mustRespond 设为 true 或 false。",
    });
  }

  if (!object(raw.source)) {
    errors.push({
      id,
      field: "source",
      source: null,
      reason: "要求来源 source 必须是包含 file 与 address 的对象",
      action: "请设置 source: { file, address }，file 为项目登记招标副本路径，address 为块地址。",
    });
  } else {
    for (const key of Object.keys(raw.source)) {
      if (key !== "file" && key !== "address") {
        errors.push({
          id,
          field: `source.${key}`,
          source,
          reason: `source 包含不支持的字段：${key}`,
          action: "source 仅允许 file 与 address 两个字段。",
        });
      }
    }
    if (!nonempty(raw.source.file)) {
      errors.push({
        id,
        field: "source.file",
        source,
        reason: "要求来源 source.file 不能为空",
        action: "请将 source.file 设为项目登记的招标文件副本路径。",
      });
    }
    if (!nonempty(raw.source.address)) {
      errors.push({
        id,
        field: "source.address",
        source,
        reason: "要求来源 source.address 不能为空",
        action: "请用 seal_doc_read 读取招标副本并填写有效块地址。",
      });
    }
  }

  if (
    raw.points !== undefined &&
    (typeof raw.points !== "number" ||
      !Number.isFinite(raw.points) ||
      raw.points < 0)
  ) {
    errors.push({
      id,
      field: "points",
      source,
      reason: "要求分值 points 必须为非负有限数字",
      action: "请提供非负数字 points 或省略该字段。",
    });
  }

  const validatedResponses = validateResponsesField(
    raw.responses,
    id,
    source,
    errors,
  );
  const validatedEvidence = validateEvidenceField(
    raw.evidence,
    id,
    source,
    errors,
  );

  if (errors.length > 0 || !validatedResponses) return { item: null, errors };

  const validatedSource = raw.source as { file: string; address: string };
  const item: Requirement = {
    id: raw.id as string,
    kind: raw.kind as string,
    text: raw.text as string,
    quote: raw.quote as string,
    source: { file: validatedSource.file, address: validatedSource.address },
    mustRespond: raw.mustRespond as boolean,
    ...(raw.points !== undefined ? { points: raw.points as number } : {}),
    responses: validatedResponses,
    ...(validatedEvidence !== undefined ? { evidence: validatedEvidence } : {}),
  };
  if (JSON.stringify(item).length > REQUIREMENTS_ITEM_MAX_CHARS) {
    errors.push({
      id,
      field: "item",
      source,
      reason: `单条要求长度超过上限（${REQUIREMENTS_ITEM_MAX_CHARS} 字符）`,
      action: "请精简概括 text 或 quote，或拆分为多条要求后重新保存。",
    });
    return { item: null, errors };
  }
  return { item, errors: [] };
}

/** Validate an array of items against the single seal-requirements-1 item schema. */
export function validateRequirementItems(rawItems: unknown): {
  items: Requirement[];
  errors: RequirementValidationError[];
} {
  if (!Array.isArray(rawItems)) {
    return {
      items: [],
      errors: [
        {
          id: "",
          field: "items",
          source: null,
          reason: "要求清单 items 必须是数组",
          action: "请传入包含要求对象的 items 数组。",
        },
      ],
    };
  }
  const seen = new Set<string>();
  const items: Requirement[] = [];
  const errors: RequirementValidationError[] = [];
  for (const [index, raw] of rawItems.entries()) {
    const validated = validateRequirementItem(raw, index, seen);
    if (validated.item) items.push(validated.item);
    errors.push(...validated.errors);
  }
  return { items, errors };
}

/** Shared read schema; requirements save uses the exact same validator. */
export function parseRequirements(text: string): RequirementsState {
  try {
    const value: unknown = JSON.parse(text);
    if (
      !object(value) ||
      value.format !== "seal-requirements-1" ||
      !Array.isArray(value.items) ||
      Object.keys(value).some((key) => key !== "format" && key !== "items")
    )
      throw new Error("要求清单格式应为 seal-requirements-1 与 items 列表");
    const validated = validateRequirementItems(value.items);
    if (validated.errors.length > 0) throw new Error(validated.errors[0].reason);
    return { kind: "value", items: validated.items };
  } catch (error) {
    return {
      kind: "error",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function requirementCoverageDigest(
  item: Pick<
    Requirement,
    "id" | "kind" | "text" | "quote" | "source" | "mustRespond" | "responses"
  >,
): string {
  return sha256Hex(
    JSON.stringify([
      item.id,
      item.kind,
      item.text,
      item.quote,
      item.source.file,
      item.source.address,
      item.mustRespond,
      item.responses.map((response) => [response.draft, response.address]),
    ]),
  );
}

interface CachedPackage {
  parts: Map<string, Uint8Array>;
  paragraphs: Array<{ address: string; text: string }>;
  addressSet: Set<string>;
  documentXml: string;
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

async function loadCachedPackage(bytes: Uint8Array): Promise<CachedPackage> {
  const parts = await validatePackageStructure(bytes);
  const paragraphs = readableParagraphs(parts);
  const addressSet = new Set(paragraphs.map((block) => block.address));
  const documentXml = utf8Decoder.decode(parts.get("word/document.xml")!);
  return { parts, paragraphs, addressSet, documentXml };
}

function sourceWindow(pkg: CachedPackage, address: string) {
  const { paragraphs, documentXml } = pkg;
  let first = -1;
  let last = -1;
  for (let index = 0; index < paragraphs.length; index++) {
    const blockAddress = paragraphs[index].address;
    if (blockAddress === address || blockAddress.startsWith(`${address}/`)) {
      if (first < 0) first = index;
      last = index;
    }
  }
  if (first < 0) {
    // An empty body container is a real address, but has no matching quote text.
    resolveAddress(documentXml, address);
    return "";
  }
  return paragraphs
    .slice(Math.max(0, first - 5), last + 6)
    .map((block) => block.text)
    .join("\n");
}

async function verifyRequirementQuote(
  id: string,
  quote: string,
  source: { file: string; address: string },
  sources: ReadonlyMap<string, Uint8Array>,
  sourceCache: Map<string, CachedPackage>,
): Promise<RequirementValidationError | null> {
  const available = [...sources.keys()];
  const bytes = sources.get(source.file);
  if (!bytes) {
    return {
      id,
      field: "source.file",
      source,
      reason: "要求来源不是可信的登记招标副本或无法读取",
      action: available.length
        ? `请将 source.file 设为项目登记的招标副本（可用值：${available.join("、")}），并用 seal_doc_read 读取块地址。`
        : "项目暂无可用的登记招标副本，请核对招标文件状态。",
    };
  }
  let pkg = sourceCache.get(source.file);
  if (!pkg) {
    try {
      pkg = await loadCachedPackage(bytes);
      sourceCache.set(source.file, pkg);
    } catch (error) {
      return {
        id,
        field: "source.file",
        source,
        reason: error instanceof Error ? error.message : String(error),
        action: "项目登记的招标副本结构损坏或无法读取，请检查项目招标文件。",
      };
    }
  }
  let windowText: string;
  try {
    windowText = sourceWindow(pkg, source.address);
  } catch (error) {
    return {
      id,
      field: "source.address",
      source,
      reason: error instanceof Error ? error.message : String(error),
      action: `请调用 seal_doc_read(file="${source.file}", mode="blocks") 查看有效块地址并修正 source.address。`,
    };
  }
  if (!normalized(windowText).includes(normalized(quote))) {
    const excerpt = windowText.slice(0, 240);
    return {
      id,
      field: "quote",
      source,
      reason: "要求引文未出现在来源块或前后五块",
      action: `请调用 seal_doc_read(file="${source.file}", mode="blocks", from="${source.address}") 或 mode="search" 核对原文并修正 quote 或 source.address（仅允许空白与全半角等价）。`,
      ...(excerpt ? { excerpt } : {}),
    };
  }
  return null;
}

/** Validate a full save batch against both schema and C14 source quote rules. */
export async function validateRequirementsBatch(
  rawItems: unknown,
  sources: ReadonlyMap<string, Uint8Array>,
): Promise<{ items: Requirement[]; errors: RequirementValidationError[] }> {
  const schema = validateRequirementItems(rawItems);
  const errors = [...schema.errors];
  if (Array.isArray(rawItems)) {
    const sourceCache = new Map<string, CachedPackage>();
    for (const [index, raw] of rawItems.entries()) {
      if (!object(raw)) continue;
      const source = sourceRefOf(raw);
      if (
        !source ||
        !nonempty(source.file) ||
        !nonempty(source.address) ||
        !nonempty(raw.quote) ||
        !normalized(raw.quote)
      )
        continue;
      const id = nonempty(raw.id) ? raw.id : `#${index}`;
      const quoteError = await verifyRequirementQuote(
        id,
        raw.quote,
        { file: source.file, address: source.address },
        sources,
        sourceCache,
      );
      if (quoteError) errors.push(quoteError);
    }
  }
  return { items: errors.length === 0 ? schema.items : [], errors };
}

/** Incrementally patch only `responses` and/or `evidence` on existing requirement items. */
export function patchRequirements(
  existingItems: readonly Requirement[],
  rawPatches: unknown,
): {
  items: Requirement[];
  errors: RequirementValidationError[];
  updatedCount: number;
} {
  if (!Array.isArray(rawPatches) || rawPatches.length === 0) {
    return {
      items: [],
      errors: [
        {
          id: "",
          field: "items",
          source: null,
          reason: "patch 的 items 必须是非空数组",
          action: "请传入至少一条包含 id 与 responses 或 evidence 的更新项。",
        },
      ],
      updatedCount: 0,
    };
  }
  const existingById = new Map(existingItems.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const errors: RequirementValidationError[] = [];
  const patches = new Map<
    string,
    { responses?: Array<{ draft: string; address: string }>; evidence?: string[] }
  >();

  for (const [index, raw] of rawPatches.entries()) {
    if (!object(raw)) {
      errors.push({
        id: `#${index}`,
        field: "item",
        source: null,
        reason: "patch 条目必须是 JSON 对象",
        action: "请传入包含 id 与 responses/evidence 的对象。",
      });
      continue;
    }
    const id = nonempty(raw.id) ? raw.id : `#${index}`;
    let validId = true;
    if (!nonempty(raw.id)) {
      validId = false;
      errors.push({
        id,
        field: "id",
        source: null,
        reason: "patch 条目缺少非空 id",
        action: "请提供要更新的现有要求 id。",
      });
    } else if (seen.has(raw.id)) {
      validId = false;
      errors.push({
        id: raw.id,
        field: "id",
        source: null,
        reason: `patch 条目 id 重复：${raw.id}`,
        action: "同一批 patch 中每个 id 只能出现一次。",
      });
    } else {
      seen.add(raw.id);
    }

    for (const key of Object.keys(raw)) {
      if (FORBIDDEN_AUTHORIZATION_KEYS.has(key) || key.startsWith("__seal")) {
        errors.push({
          id,
          field: key,
          source: null,
          reason: `要求条目禁止设置人工覆盖或核实字段：${key}`,
          action: `请移除 ${key}；人工覆盖标记与核实只能由人在工作台界面操作。`,
        });
      } else if (!ALLOWED_PATCH_KEYS.has(key)) {
        errors.push({
          id,
          field: key,
          source: null,
          reason: ALLOWED_ITEM_KEYS.has(key)
            ? `patch 仅允许更新 responses 与 evidence；修改 ${key} 请改用 action="save"`
            : `patch 条目包含不支持的字段：${key}`,
          action: "patch 仅允许 id、responses 与 evidence。",
        });
      }
    }

    const existing = validId ? existingById.get(id) : undefined;
    if (validId && !existing) {
      errors.push({
        id,
        field: "id",
        source: null,
        reason: `要求条目不存在：${id}`,
        action: "请用 action=list 查看现有要求 id，或使用 action=save 新增要求。",
      });
    }

    if (raw.responses === undefined && raw.evidence === undefined) {
      errors.push({
        id,
        field: "item",
        source: null,
        reason: "patch 条目至少需提供 responses 或 evidence 之一",
        action: "请传入 responses 或 evidence 字段。",
      });
    }

    const responses =
      raw.responses === undefined
        ? undefined
        : validateResponsesField(raw.responses, id, null, errors);
    const evidence = validateEvidenceField(raw.evidence, id, null, errors);

    if (existing && (raw.responses === undefined || responses !== null)) {
      const candidate: Requirement = {
        ...existing,
        responses: responses ?? existing.responses,
        ...(evidence !== undefined
          ? { evidence }
          : existing.evidence !== undefined
            ? { evidence: existing.evidence }
            : {}),
      };
      if (JSON.stringify(candidate).length > REQUIREMENTS_ITEM_MAX_CHARS) {
        errors.push({
          id,
          field: "item",
          source: null,
          reason: `单条要求长度超过上限（${REQUIREMENTS_ITEM_MAX_CHARS} 字符）`,
          action: "请精简 responses 或 evidence 列表。",
        });
      } else {
        patches.set(id, {
          ...(responses !== undefined && responses !== null ? { responses } : {}),
          ...(evidence !== undefined ? { evidence } : {}),
        });
      }
    }
  }

  if (errors.length > 0) {
    return { items: [], errors, updatedCount: 0 };
  }

  const items = existingItems.map((item) => {
    const patch = patches.get(item.id);
    if (!patch) return item;
    return {
      ...item,
      responses: patch.responses ?? item.responses,
      ...(patch.evidence !== undefined
        ? { evidence: patch.evidence }
        : item.evidence !== undefined
          ? { evidence: item.evidence }
          : {}),
    };
  });
  return { items, errors: [], updatedCount: patches.size };
}

/** Return a size-bounded slice without ever truncating JSON strings. */
export function paginateRequirements(
  items: readonly Requirement[],
  offset = 0,
  limit = 50,
  maxChars = REQUIREMENTS_PAGE_MAX_CHARS,
): RequirementsPage {
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new Error("requirements offset 必须为 >= 0 的整数");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    throw new Error("requirements limit 必须为 1–200 的整数");
  const window = items.slice(offset, offset + limit);
  const pageItems: Requirement[] = [];
  for (const item of window) {
    const candidate = [...pageItems, item];
    const nextOffsetCandidate =
      offset + candidate.length < items.length
        ? offset + candidate.length
        : null;
    const serializedLength = JSON.stringify({
      kind: "value",
      total: items.length,
      offset,
      limit,
      items: candidate,
      truncated: nextOffsetCandidate !== null,
      nextOffset: nextOffsetCandidate,
    }).length;
    if (serializedLength > maxChars) {
      if (pageItems.length === 0) {
        throw new Error(
          `单条要求超过分页输出上限（${maxChars} 字符）；请缩减超长条目或提高输出上限。`,
        );
      }
      break;
    }
    pageItems.push(item);
  }
  const nextOffset =
    offset + pageItems.length < items.length ? offset + pageItems.length : null;
  return {
    total: items.length,
    offset,
    limit,
    items: pageItems,
    truncated: nextOffset !== null,
    nextOffset,
  };
}

export async function checkRequirements(
  state: RequirementsState,
  sources: ReadonlyMap<string, Uint8Array>,
  drafts: ReadonlyMap<string, Uint8Array>,
  coveredIds: ReadonlySet<string> = new Set(),
) {
  const C12: Array<{
      id?: string;
      draft?: string;
      address?: string;
      reason: string;
    }> = [],
    C14: typeof C12 = [];
  if (state.kind === "missing") return { C12, C14 };
  if (state.kind === "error") {
    C12.push({ reason: `要求清单无法读取：${state.reason}` });
    C14.push({ reason: `要求清单无法读取：${state.reason}` });
    return { C12, C14 };
  }
  const sourceCache = new Map<string, CachedPackage>();
  const draftCache = new Map<string, CachedPackage>();
  for (const item of state.items) {
    if (item.mustRespond && !coveredIds.has(item.id)) {
      if (!item.responses.length) {
        C12.push({ id: item.id, reason: "必须响应的要求没有响应位置" });
      }
      for (const response of item.responses) {
        try {
          const bytes = drafts.get(response.draft);
          if (!bytes) throw new Error("响应分册不存在");
          let pkg = draftCache.get(response.draft);
          if (!pkg) {
            pkg = await loadCachedPackage(bytes);
            draftCache.set(response.draft, pkg);
          }
          if (!pkg.addressSet.has(response.address))
            resolveAddress(pkg.documentXml, response.address);
        } catch (error) {
          C12.push({
            id: item.id,
            ...response,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    const quoteError = await verifyRequirementQuote(
      item.id,
      item.quote,
      item.source,
      sources,
      sourceCache,
    );
    if (quoteError) {
      C14.push({
        id: item.id,
        address: item.source.address,
        reason: quoteError.reason,
      });
    }
  }
  return { C12, C14 };
}
