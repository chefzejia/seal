import { validatePackageStructure, resolveRelationshipTarget } from "../docx/package-structure.js";
import { sealRanges, type SealRange } from "../docx/seal-ranges.js";
import { visibleTextPositions } from "../docx/visible-surgery.js";
import { styleChain, wordStyles, xmlAttributes, type WordStyle, type WordStyles } from "../docx/outline.js";
import { elementChildren, unescapeXml, xmlElements } from "../docx/xml.js";
import { sha256Hex } from "../docx/zip.js";
import {
  isCurrentAuthorization,
  signAuthorization,
  type SignedAuthorization,
} from "./authorization.js";
import { displayedFactValue, type FactSource } from "./facts.js";
import type { BidLedger, WorkflowMode } from "./project.js";

export type OutlineNodeKind = "template" | "authored" | "attachment";

export interface OutlineRange {
  from: string;
  to: string;
}

export interface OutlineVolume {
  name: string;
  tender?: string;
  ranges?: OutlineRange[];
  note?: string;
}

export interface OutlineTenderSource {
  file: string;
  ranges: OutlineRange[];
}

export interface OutlineEvidenceBinding {
  source: "kb" | "material";
  ref: string;
  label?: string;
  thirdPartyHolder?: string;
  renderedPages?: string[];
}

export interface OutlineNode {
  id: string;
  volume: string;
  parentId: string | null;
  level: number;
  number?: string;
  title: string;
  kind: OutlineNodeKind;
  included: boolean;
  optional?: boolean;
  lockedTemplate?: boolean;
  tenderSource?: OutlineTenderSource;
  requirementIds?: string[];
  evidence?: OutlineEvidenceBinding[];
  materialMissing?: boolean;
  materialNote?: string;
  note?: string;
  expectedHeading?: string;
}

export interface OutlineDocument {
  format: "seal-outline-1";
  volumes: OutlineVolume[];
  nodes: OutlineNode[];
  updatedAt?: string;
  updatedBy?: "agent" | "human";
}

export type OutlineState =
  | { kind: "missing" }
  | { kind: "error"; reason: string }
  | { kind: "value"; outline: OutlineDocument };

export interface OutlineValidationError {
  id?: string;
  field: string;
  reason: string;
  action: string;
}

export interface OutlineConfirmation {
  digest: string;
  confirmedAt: string;
  vaultId: string | null;
  deadline: string;
  authorization: SignedAuthorization;
}

export type OutlineConfirmationStatus =
  | "missing"
  | "unconfirmed"
  | "confirmed"
  | "stale"
  | "invalid_signature";

export interface OutlineConfirmationEvaluation {
  status: OutlineConfirmationStatus;
  valid: boolean;
  digest?: string;
  confirmedDigest?: string;
  invalidAuthorization?: { item: string; reason: string };
}

export interface OutlinePatch {
  upsertNodes?: OutlineNode[];
  removeNodeIds?: string[];
  updateVolumes?: OutlineVolume[];
  updatedAt?: string;
  updatedBy?: "agent" | "human";
}

export interface OutlineMaterialState {
  exists: boolean;
  readable: boolean;
  kind: "image" | "pdf" | "text" | "docx" | "other";
  expectedImageHashes?: string[];
  missingPages?: string[];
  error?: string;
}

export type OutlineKbMediaState =
  | { kind: "ok"; hashes: readonly string[] }
  | { kind: "no_images" }
  | { kind: "error"; reason: string };

export type OutlineConsistencyIssueKind =
  | "corrupt_outline"
  | "outline_unconfirmed"
  | "missing_volume"
  | "corrupt_draft"
  | "missing_section"
  | "missing_evidence"
  | "missing_material_file";

export interface OutlineConsistencyIssue {
  kind: OutlineConsistencyIssueKind;
  draft?: string;
  nodeId?: string;
  title?: string;
  expectedHeading?: string;
  source?: "kb" | "material";
  ref?: string;
  reason: string;
  suggestion?: string;
}

const VOLUME_NAME_RE = /^[\p{L}\p{N}_ -]{1,100}$/u;
const NODE_ID_RE = /^[\p{L}\p{N}_-]{1,80}$/u;
const KB_ID_RE = /^[\p{L}\p{N}-]+$/u;
const ALLOWED_NODE_KINDS = new Set<OutlineNodeKind>([
  "template",
  "authored",
  "attachment",
]);
const ALLOWED_ROOT_KEYS = new Set([
  "format",
  "volumes",
  "nodes",
  "updatedAt",
  "updatedBy",
]);
const ALLOWED_VOLUME_KEYS = new Set(["name", "tender", "ranges", "note"]);
const ALLOWED_NODE_KEYS = new Set([
  "id",
  "volume",
  "parentId",
  "level",
  "number",
  "title",
  "kind",
  "included",
  "optional",
  "lockedTemplate",
  "tenderSource",
  "requirementIds",
  "evidence",
  "materialMissing",
  "materialNote",
  "note",
  "expectedHeading",
]);
const ALLOWED_EVIDENCE_KEYS = new Set([
  "source",
  "ref",
  "label",
  "thirdPartyHolder",
  "renderedPages",
]);
const FORBIDDEN_CONFIRM_KEYS = new Set([
  "confirmed",
  "confirmedAt",
  "authorization",
  "approved",
  "lockedBy",
  "verified",
  "verifiedAt",
  "verifiedFields",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_CONFIRM_KEYS.has(key) || key.startsWith("__seal");
}

function checkAllowedKeys(
  raw: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  prefix: string,
  errors: OutlineValidationError[],
  nodeId?: string,
): void {
  for (const key of Object.keys(raw)) {
    if (isForbiddenKey(key)) {
      errors.push({
        ...(nodeId ? { id: nodeId } : {}),
        field: prefix ? `${prefix}.${key}` : key,
        reason: `大纲禁止设置确认或核实字段：${key}`,
        action: `请移除 ${key}；大纲确认与资料核实只能由人在工作台界面操作。`,
      });
    } else if (!allowed.has(key)) {
      errors.push({
        ...(nodeId ? { id: nodeId } : {}),
        field: prefix ? `${prefix}.${key}` : key,
        reason: `大纲包含不支持的字段：${key}`,
        action: `允许字段：${[...allowed].join("、")}。`,
      });
    }
  }
}

function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  if (
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    return false;
  }
  const segments = value.split("/");
  return (
    segments.length > 0 &&
    segments.every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

export function isSafeMaterialPath(value: unknown): value is string {
  if (!isSafeRelativePath(value)) return false;
  const segments = value.split("/");
  return segments[0] === "materials" && segments.length >= 2;
}

function validateRanges(
  rawRanges: unknown,
  fieldPrefix: string,
  errors: OutlineValidationError[],
  nodeId?: string,
): OutlineRange[] | undefined {
  if (rawRanges === undefined) return undefined;
  if (!Array.isArray(rawRanges)) {
    errors.push({
      ...(nodeId ? { id: nodeId } : {}),
      field: fieldPrefix,
      reason: `${fieldPrefix} 必须是区间数组`,
      action: "请传入 [{ from, to }] 区间数组。",
    });
    return undefined;
  }
  const ranges: OutlineRange[] = [];
  for (const [index, entry] of rawRanges.entries()) {
    if (!isPlainObject(entry)) {
      errors.push({
        ...(nodeId ? { id: nodeId } : {}),
        field: `${fieldPrefix}[${index}]`,
        reason: "区间项必须是对象",
        action: "请传入 { from, to } 对象。",
      });
      continue;
    }
    checkAllowedKeys(
      entry,
      new Set(["from", "to"]),
      `${fieldPrefix}[${index}]`,
      errors,
      nodeId,
    );
    if (
      typeof entry.from !== "string" ||
      !entry.from.trim() ||
      typeof entry.to !== "string" ||
      !entry.to.trim()
    ) {
      errors.push({
        ...(nodeId ? { id: nodeId } : {}),
        field: `${fieldPrefix}[${index}]`,
        reason: "区间项必须包含非空 from 与 to",
        action: "请填写有效的起始与结束块地址。",
      });
      continue;
    }
    ranges.push({ from: entry.from, to: entry.to });
  }
  return ranges;
}

function validateEvidenceBinding(
  raw: unknown,
  fieldPrefix: string,
  errors: OutlineValidationError[],
  nodeId: string,
): OutlineEvidenceBinding | null {
  if (!isPlainObject(raw)) {
    errors.push({
      id: nodeId,
      field: fieldPrefix,
      reason: "证据绑定项必须是对象",
      action: "请传入 { source: 'kb' | 'material', ref }。",
    });
    return null;
  }
  const beforeCount = errors.length;
  checkAllowedKeys(raw, ALLOWED_EVIDENCE_KEYS, fieldPrefix, errors, nodeId);
  if (raw.source !== "kb" && raw.source !== "material") {
    errors.push({
      id: nodeId,
      field: `${fieldPrefix}.source`,
      reason: "证据来源 source 必须为 kb 或 material",
      action: "请将 source 设为 kb 或 material。",
    });
  }
  if (typeof raw.ref !== "string" || !raw.ref.trim()) {
    errors.push({
      id: nodeId,
      field: `${fieldPrefix}.ref`,
      reason: "证据引用 ref 不能为空",
      action: "请提供知识库记录 ID 或 materials/ 相对路径。",
    });
  } else if (raw.source === "kb" && !KB_ID_RE.test(raw.ref)) {
    errors.push({
      id: nodeId,
      field: `${fieldPrefix}.ref`,
      reason: `知识库证据 ID 格式无效：${raw.ref}`,
      action: "请使用合法的知识库记录 ID。",
    });
  } else if (raw.source === "material" && !isSafeMaterialPath(raw.ref)) {
    errors.push({
      id: nodeId,
      field: `${fieldPrefix}.ref`,
      reason: `项目材料路径必须严格位于 materials/ 下：${raw.ref}`,
      action: "请使用 materials/... 相对路径，禁止包含 ..、反斜杠或绝对路径。",
    });
  }
  if (raw.label !== undefined && typeof raw.label !== "string") {
    errors.push({
      id: nodeId,
      field: `${fieldPrefix}.label`,
      reason: "证据标签 label 必须为字符串",
      action: "请提供字符串 label 或省略该字段。",
    });
  }
  if (
    raw.thirdPartyHolder !== undefined &&
    (typeof raw.thirdPartyHolder !== "string" || !raw.thirdPartyHolder.trim())
  ) {
    errors.push({
      id: nodeId,
      field: `${fieldPrefix}.thirdPartyHolder`,
      reason: "thirdPartyHolder 必须是非空字符串",
      action: "请提供持证方名称或省略该字段。",
    });
  }
  if (raw.renderedPages !== undefined) {
    if (raw.source === "kb") {
      errors.push({
        id: nodeId,
        field: `${fieldPrefix}.renderedPages`,
        reason: "kb 类型证据不支持 renderedPages",
        action: "请移除 renderedPages。",
      });
    } else if (
      !Array.isArray(raw.renderedPages) ||
      raw.renderedPages.some((page) => !isSafeMaterialPath(page))
    ) {
      errors.push({
        id: nodeId,
        field: `${fieldPrefix}.renderedPages`,
        reason: "renderedPages 每项必须严格位于 materials/ 下",
        action: "请提供合法的 materials/... 图片相对路径数组。",
      });
    }
  }
  if (errors.length > beforeCount) return null;
  return {
    source: raw.source as "kb" | "material",
    ref: raw.ref as string,
    ...(raw.label !== undefined ? { label: raw.label as string } : {}),
    ...(raw.thirdPartyHolder !== undefined
      ? { thirdPartyHolder: raw.thirdPartyHolder as string }
      : {}),
    ...(raw.renderedPages !== undefined
      ? { renderedPages: [...(raw.renderedPages as string[])] }
      : {}),
  };
}

function validateVolume(
  raw: unknown,
  index: number,
  seenNames: Set<string>,
  errors: OutlineValidationError[],
): OutlineVolume | null {
  const prefix = `volumes[${index}]`;
  if (!isPlainObject(raw)) {
    errors.push({
      field: prefix,
      reason: "分册定义必须是对象",
      action: "请提供包含 name 的分册对象。",
    });
    return null;
  }
  const beforeCount = errors.length;
  checkAllowedKeys(raw, ALLOWED_VOLUME_KEYS, prefix, errors);
  if (typeof raw.name !== "string" || !VOLUME_NAME_RE.test(raw.name)) {
    errors.push({
      field: `${prefix}.name`,
      reason: "分册名称无效；请使用 1–100 位字母、数字、空格、下划线或连字符",
      action: "请修正分册名称。",
    });
  } else if (seenNames.has(raw.name)) {
    errors.push({
      field: `${prefix}.name`,
      reason: `分册名称重复：${raw.name}`,
      action: "请确保每个分册名称唯一。",
    });
  } else {
    seenNames.add(raw.name);
  }
  if (raw.tender !== undefined && !isSafeRelativePath(raw.tender)) {
    errors.push({
      field: `${prefix}.tender`,
      reason: "分册 tender 必须为项目内安全相对路径",
      action: "请提供如 tender/1.docx 的项目内相对路径。",
    });
  }
  const ranges = validateRanges(raw.ranges, `${prefix}.ranges`, errors);
  if (raw.note !== undefined && typeof raw.note !== "string") {
    errors.push({
      field: `${prefix}.note`,
      reason: "分册 note 必须为字符串",
      action: "请提供字符串 note 或省略。",
    });
  }
  if (errors.length > beforeCount) return null;
  return {
    name: raw.name as string,
    ...(raw.tender !== undefined ? { tender: raw.tender as string } : {}),
    ...(ranges !== undefined ? { ranges } : {}),
    ...(raw.note !== undefined ? { note: raw.note as string } : {}),
  };
}

function validateNode(
  raw: unknown,
  index: number,
  seenIds: Set<string>,
  volumeNames: ReadonlySet<string>,
  errors: OutlineValidationError[],
): OutlineNode | null {
  const prefix = `nodes[${index}]`;
  if (!isPlainObject(raw)) {
    errors.push({
      field: prefix,
      reason: "大纲节点必须是对象",
      action: "请提供合法的大纲节点对象。",
    });
    return null;
  }
  const beforeCount = errors.length;
  const idHint =
    typeof raw.id === "string" && raw.id.trim() ? raw.id : `#${index}`;
  checkAllowedKeys(raw, ALLOWED_NODE_KEYS, prefix, errors, idHint);

  if (typeof raw.id !== "string" || !NODE_ID_RE.test(raw.id)) {
    errors.push({
      id: idHint,
      field: `${prefix}.id`,
      reason: "节点 id 无效；须为 1–80 位字母、数字、下划线或连字符",
      action: "请提供合法且唯一的节点 id。",
    });
  } else if (seenIds.has(raw.id)) {
    errors.push({
      id: raw.id,
      field: `${prefix}.id`,
      reason: `节点 id 重复：${raw.id}`,
      action: "请确保所有大纲节点 id 唯一。",
    });
  } else {
    seenIds.add(raw.id);
  }

  if (typeof raw.volume !== "string" || !volumeNames.has(raw.volume)) {
    errors.push({
      id: idHint,
      field: `${prefix}.volume`,
      reason: `节点所属分册不存在：${String(raw.volume ?? "")}`,
      action: "请确保节点 volume 属于 volumes 列表中的分册名称。",
    });
  }

  if (
    raw.parentId !== null &&
    (typeof raw.parentId !== "string" || !raw.parentId.trim())
  ) {
    errors.push({
      id: idHint,
      field: `${prefix}.parentId`,
      reason: "parentId 必须为 null 或非空父节点 id",
      action: "顶层节点请传 null，子节点请传同分册已有父节点的 id。",
    });
  }

  if (
    typeof raw.level !== "number" ||
    !Number.isInteger(raw.level) ||
    raw.level < 1 ||
    raw.level > 6
  ) {
    errors.push({
      id: idHint,
      field: `${prefix}.level`,
      reason: "节点层级 level 必须为 1–6 的整数",
      action: "请将 level 设为 1 到 6 之间的整数。",
    });
  }

  if (typeof raw.title !== "string" || !raw.title.trim()) {
    errors.push({
      id: idHint,
      field: `${prefix}.title`,
      reason: "节点标题 title 不能为空",
      action: "请填写非空章节标题 title。",
    });
  }

  if (
    typeof raw.kind !== "string" ||
    !ALLOWED_NODE_KINDS.has(raw.kind as OutlineNodeKind)
  ) {
    errors.push({
      id: idHint,
      field: `${prefix}.kind`,
      reason: "节点类型 kind 必须为 template、authored 或 attachment",
      action: "请将 kind 设为 template、authored 或 attachment。",
    });
  }

  if (typeof raw.included !== "boolean") {
    errors.push({
      id: idHint,
      field: `${prefix}.included`,
      reason: "节点 included 必须为布尔值",
      action: "请将 included 设为 true 或 false。",
    });
  }

  for (const flagName of [
    "optional",
    "lockedTemplate",
    "materialMissing",
  ] as const) {
    if (raw[flagName] !== undefined && typeof raw[flagName] !== "boolean") {
      errors.push({
        id: idHint,
        field: `${prefix}.${flagName}`,
        reason: `${flagName} 必须为布尔值`,
        action: `请将 ${flagName} 设为布尔值或省略。`,
      });
    }
  }

  for (const textName of [
    "number",
    "materialNote",
    "note",
  ] as const) {
    if (raw[textName] !== undefined && typeof raw[textName] !== "string") {
      errors.push({
        id: idHint,
        field: `${prefix}.${textName}`,
        reason: `${textName} 必须为字符串`,
        action: `请将 ${textName} 设为字符串或省略。`,
      });
    }
  }

  if (
    raw.expectedHeading !== undefined &&
    (typeof raw.expectedHeading !== "string" || !raw.expectedHeading.trim())
  ) {
    errors.push({
      id: idHint,
      field: `${prefix}.expectedHeading`,
      reason: "expectedHeading 必须为非空字符串",
      action: "请提供非空 expectedHeading 或省略该字段。",
    });
  }

  let tenderSource: OutlineTenderSource | undefined;
  if (raw.tenderSource !== undefined) {
    if (!isPlainObject(raw.tenderSource)) {
      errors.push({
        id: idHint,
        field: `${prefix}.tenderSource`,
        reason: "tenderSource 必须是对象",
        action: "请提供 { file, ranges }。",
      });
    } else {
      checkAllowedKeys(
        raw.tenderSource,
        new Set(["file", "ranges"]),
        `${prefix}.tenderSource`,
        errors,
        idHint,
      );
      if (!isSafeRelativePath(raw.tenderSource.file)) {
        errors.push({
          id: idHint,
          field: `${prefix}.tenderSource.file`,
          reason: "tenderSource.file 必须为项目内安全相对路径",
          action: "请填写项目登记的招标副本相对路径。",
        });
      }
      const ranges = validateRanges(
        raw.tenderSource.ranges,
        `${prefix}.tenderSource.ranges`,
        errors,
        idHint,
      );
      if (ranges !== undefined && isSafeRelativePath(raw.tenderSource.file)) {
        tenderSource = { file: raw.tenderSource.file, ranges };
      }
    }
  }

  let requirementIds: string[] | undefined;
  if (raw.requirementIds !== undefined) {
    if (
      !Array.isArray(raw.requirementIds) ||
      raw.requirementIds.some(
        (reqId) => typeof reqId !== "string" || !reqId.trim(),
      )
    ) {
      errors.push({
        id: idHint,
        field: `${prefix}.requirementIds`,
        reason: "requirementIds 必须为非空字符串数组",
        action: "请传入关联招标要求 ID 数组或省略。",
      });
    } else {
      requirementIds = [...(raw.requirementIds as string[])];
    }
  }

  let evidence: OutlineEvidenceBinding[] | undefined;
  if (raw.evidence !== undefined) {
    if (!Array.isArray(raw.evidence)) {
      errors.push({
        id: idHint,
        field: `${prefix}.evidence`,
        reason: "evidence 必须为数组",
        action: "请提供证据绑定数组或省略。",
      });
    } else {
      evidence = [];
      for (const [evIndex, item] of raw.evidence.entries()) {
        const parsed = validateEvidenceBinding(
          item,
          `${prefix}.evidence[${evIndex}]`,
          errors,
          idHint,
        );
        if (parsed) evidence.push(parsed);
      }
    }
  }

  if (errors.length > beforeCount) return null;
  return {
    id: raw.id as string,
    volume: raw.volume as string,
    parentId: raw.parentId as string | null,
    level: raw.level as number,
    ...(raw.number !== undefined ? { number: raw.number as string } : {}),
    title: raw.title as string,
    kind: raw.kind as OutlineNodeKind,
    included: raw.included as boolean,
    ...(raw.optional !== undefined ? { optional: raw.optional as boolean } : {}),
    ...(raw.lockedTemplate !== undefined
      ? { lockedTemplate: raw.lockedTemplate as boolean }
      : {}),
    ...(tenderSource !== undefined ? { tenderSource } : {}),
    ...(requirementIds !== undefined ? { requirementIds } : {}),
    ...(evidence !== undefined ? { evidence } : {}),
    ...(raw.materialMissing !== undefined
      ? { materialMissing: raw.materialMissing as boolean }
      : {}),
    ...(raw.materialNote !== undefined
      ? { materialNote: raw.materialNote as string }
      : {}),
    ...(raw.note !== undefined ? { note: raw.note as string } : {}),
    ...(raw.expectedHeading !== undefined
      ? { expectedHeading: raw.expectedHeading as string }
      : {}),
  };
}

/** Validate an arbitrary value against the strict seal-outline-1 schema and tree invariants. */
export function validateOutlineInput(raw: unknown): {
  outline: OutlineDocument | null;
  errors: OutlineValidationError[];
} {
  const errors: OutlineValidationError[] = [];
  if (!isPlainObject(raw)) {
    return {
      outline: null,
      errors: [
        {
          field: "outline",
          reason: "大纲必须为 JSON 对象",
          action: "请传入包含 format、volumes 与 nodes 的大纲对象。",
        },
      ],
    };
  }
  checkAllowedKeys(raw, ALLOWED_ROOT_KEYS, "", errors);
  if (raw.format !== "seal-outline-1") {
    errors.push({
      field: "format",
      reason: "大纲格式标识必须为 seal-outline-1",
      action: "请将 format 设为 seal-outline-1。",
    });
  }
  if (raw.updatedAt !== undefined && typeof raw.updatedAt !== "string") {
    errors.push({
      field: "updatedAt",
      reason: "updatedAt 必须为字符串",
      action: "请传入 ISO 时间字符串或省略。",
    });
  }
  if (
    raw.updatedBy !== undefined &&
    raw.updatedBy !== "agent" &&
    raw.updatedBy !== "human"
  ) {
    errors.push({
      field: "updatedBy",
      reason: "updatedBy 必须为 agent 或 human",
      action: "请将 updatedBy 设为 agent 或 human，或省略。",
    });
  }

  const volumes: OutlineVolume[] = [];
  const seenVolumes = new Set<string>();
  if (!Array.isArray(raw.volumes)) {
    errors.push({
      field: "volumes",
      reason: "volumes 必须为分册数组",
      action: "请传入分册数组。",
    });
  } else {
    for (const [index, entry] of raw.volumes.entries()) {
      const parsed = validateVolume(entry, index, seenVolumes, errors);
      if (parsed) volumes.push(parsed);
    }
  }

  const nodes: OutlineNode[] = [];
  const seenIds = new Set<string>();
  if (!Array.isArray(raw.nodes)) {
    errors.push({
      field: "nodes",
      reason: "nodes 必须为节点数组",
      action: "请传入大纲节点数组。",
    });
  } else {
    for (const [index, entry] of raw.nodes.entries()) {
      const parsed = validateNode(entry, index, seenIds, seenVolumes, errors);
      if (parsed) nodes.push(parsed);
    }
  }

  if (errors.length === 0) {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    for (const node of nodes) {
      if (node.parentId === null) continue;
      const parent = nodeById.get(node.parentId);
      if (!parent) {
        errors.push({
          id: node.id,
          field: "parentId",
          reason: `父节点不存在：${node.parentId}`,
          action: "请将 parentId 指向同分册已有节点 id 或 null。",
        });
      } else if (parent.volume !== node.volume) {
        errors.push({
          id: node.id,
          field: "parentId",
          reason: `父节点 ${node.parentId} 不在分册「${node.volume}」内`,
          action: "父子节点必须属于同一分册。",
        });
      }
    }
    const state = new Map<string, "visiting" | "done">();
    for (const node of nodes) {
      if (state.get(node.id) === "done") continue;
      const pathIds = new Set<string>();
      let current: OutlineNode | undefined = node;
      while (current && state.get(current.id) !== "done") {
        if (pathIds.has(current.id)) {
          errors.push({
            id: current.id,
            field: "parentId",
            reason: `节点存在循环父子引用：${current.id}`,
            action: "请修复大纲树 parentId 循环引用。",
          });
          break;
        }
        pathIds.add(current.id);
        state.set(current.id, "visiting");
        current =
          current.parentId !== null ? nodeById.get(current.parentId) : undefined;
      }
      for (const visitedId of pathIds) state.set(visitedId, "done");
    }
  }

  if (errors.length > 0) return { outline: null, errors };
  return {
    outline: {
      format: "seal-outline-1",
      volumes,
      nodes,
      ...(raw.updatedAt !== undefined
        ? { updatedAt: raw.updatedAt as string }
        : {}),
      ...(raw.updatedBy !== undefined
        ? { updatedBy: raw.updatedBy as "agent" | "human" }
        : {}),
    },
    errors: [],
  };
}

function assertValidOutline(raw: unknown): OutlineDocument {
  const validated = validateOutlineInput(raw);
  if (!validated.outline) {
    throw new Error(validated.errors[0]?.reason ?? "大纲校验失败");
  }
  return validated.outline;
}

/** Shared read schema; outline save and patch validate through the same rules. */
export function parseOutline(text: string): OutlineState {
  try {
    const parsed: unknown = JSON.parse(text);
    const validated = validateOutlineInput(parsed);
    if (!validated.outline) {
      return {
        kind: "error",
        reason: validated.errors[0]?.reason ?? "大纲格式无效",
      };
    }
    return { kind: "value", outline: validated.outline };
  } catch (error) {
    return {
      kind: "error",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function canonicalNormalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalNormalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonicalNormalize(child)]),
    );
  }
  return value;
}

/** Canonical SHA256 digest of outline structure and content, ignoring updatedAt/updatedBy. */
export function canonicalOutlineDigest(
  outline: Pick<OutlineDocument, "volumes" | "nodes"> &
    Partial<Pick<OutlineDocument, "updatedAt" | "updatedBy">>,
): string {
  return sha256Hex(
    JSON.stringify(
      canonicalNormalize({ volumes: outline.volumes, nodes: outline.nodes }),
    ),
  );
}

export function outlineConfirmationFingerprint(
  digest: string,
  context: { vaultId: string | null; deadline: string },
): string {
  return sha256Hex(JSON.stringify([digest, context.vaultId, context.deadline]));
}

/** Sign human confirmation for the current outline blueprint and store it in the ledger. */
export async function confirmOutline(
  ledger: BidLedger,
  outline: OutlineDocument,
  context: { root: string; vaultId: string | null; deadline: string },
  secret: Uint8Array,
  confirmedAt: string,
): Promise<OutlineConfirmation> {
  const validated = assertValidOutline(outline);
  const digest = canonicalOutlineDigest(validated);
  const fingerprint = outlineConfirmationFingerprint(digest, {
    vaultId: context.vaultId,
    deadline: context.deadline,
  });
  const authorization = await signAuthorization(secret, {
    kind: "outline_confirm",
    project: context.root,
    item: "outline",
    fingerprint,
  });
  const confirmation: OutlineConfirmation = {
    digest,
    confirmedAt,
    vaultId: context.vaultId,
    deadline: context.deadline,
    authorization,
  };
  ledger.outlineConfirmation = confirmation;
  return confirmation;
}

/** Verify outline confirmation signature and freshness against outline, vaultId and deadline. */
export async function evaluateOutlineConfirmation(input: {
  outlineState: OutlineState;
  confirmation: unknown;
  root: string;
  secret: Uint8Array | null;
  context: { vaultId: string | null; deadline: string };
}): Promise<OutlineConfirmationEvaluation> {
  const { outlineState, confirmation, root, secret, context } = input;
  const hasConfirmation = confirmation !== undefined && confirmation !== null;
  let signatureValid = false;
  let confirmedDigest: string | undefined;
  let confirmedVaultId: string | null | undefined;
  let confirmedDeadline: string | undefined;

  if (hasConfirmation) {
    if (isPlainObject(confirmation)) {
      const digest = confirmation.digest;
      const confirmedAt = confirmation.confirmedAt;
      const vaultId = confirmation.vaultId;
      const deadline = confirmation.deadline;
      if (
        typeof digest === "string" &&
        digest.length > 0 &&
        typeof confirmedAt === "string" &&
        confirmedAt.length > 0 &&
        (vaultId === null || typeof vaultId === "string") &&
        typeof deadline === "string" &&
        deadline.length > 0 &&
        !!secret
      ) {
        const expectedFingerprint = outlineConfirmationFingerprint(digest, {
          vaultId,
          deadline,
        });
        signatureValid = await isCurrentAuthorization(
          secret,
          confirmation.authorization,
          {
            kind: "outline_confirm",
            project: root,
            item: "outline",
            fingerprint: expectedFingerprint,
          },
        );
        if (signatureValid) {
          confirmedDigest = digest;
          confirmedVaultId = vaultId;
          confirmedDeadline = deadline;
        }
      }
    }
    if (!signatureValid) {
      return {
        status: "invalid_signature",
        valid: false,
        invalidAuthorization: {
          item: "outline",
          reason: "大纲确认授权签名无效",
        },
      };
    }
  }

  if (outlineState.kind === "missing") {
    return { status: "missing", valid: false };
  }
  if (outlineState.kind === "error") {
    return { status: "unconfirmed", valid: false };
  }

  const currentDigest = canonicalOutlineDigest(outlineState.outline);
  if (!hasConfirmation) {
    return { status: "unconfirmed", valid: false, digest: currentDigest };
  }

  if (
    confirmedDigest === currentDigest &&
    confirmedVaultId === context.vaultId &&
    confirmedDeadline === context.deadline
  ) {
    return {
      status: "confirmed",
      valid: true,
      digest: currentDigest,
      confirmedDigest,
    };
  }

  return {
    status: "stale",
    valid: false,
    digest: currentDigest,
    ...(confirmedDigest ? { confirmedDigest } : {}),
  };
}

function collectSubtreeIds(nodes: readonly OutlineNode[], rootId: string): Set<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.parentId !== null) {
      const list = childrenByParent.get(node.parentId) ?? [];
      list.push(node.id);
      childrenByParent.set(node.parentId, list);
    }
  }
  const result = new Set<string>();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (result.has(id)) continue;
    result.add(id);
    const children = childrenByParent.get(id) ?? [];
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push(children[i]);
    }
  }
  return result;
}

function insertNodeAtPreorderSlot(
  nodes: readonly OutlineNode[],
  newNode: OutlineNode,
  afterNodeId?: string,
): OutlineNode[] {
  const next = [...nodes];
  if (afterNodeId !== undefined) {
    const anchorIndex = next.findIndex((item) => item.id === afterNodeId);
    if (anchorIndex < 0) throw new Error(`指定锚点节点不存在：${afterNodeId}`);
    if (newNode.parentId === afterNodeId) {
      next.splice(anchorIndex + 1, 0, newNode);
      return next;
    }
    const anchorSubtree = collectSubtreeIds(next, afterNodeId);
    let insertAt = anchorIndex + 1;
    while (insertAt < next.length && anchorSubtree.has(next[insertAt].id)) {
      insertAt++;
    }
    next.splice(insertAt, 0, newNode);
    return next;
  }
  if (newNode.parentId !== null) {
    const parentIndex = next.findIndex((item) => item.id === newNode.parentId);
    if (parentIndex < 0) {
      throw new Error(`父节点不存在：${newNode.parentId}`);
    }
    const parentSubtree = collectSubtreeIds(next, newNode.parentId);
    let insertAt = parentIndex + 1;
    while (insertAt < next.length && parentSubtree.has(next[insertAt].id)) {
      insertAt++;
    }
    next.splice(insertAt, 0, newNode);
    return next;
  }
  let lastVolumeIndex = -1;
  for (let i = 0; i < next.length; i++) {
    if (next[i].volume === newNode.volume) lastVolumeIndex = i;
  }
  if (lastVolumeIndex >= 0) {
    next.splice(lastVolumeIndex + 1, 0, newNode);
  } else {
    next.push(newNode);
  }
  return next;
}

function withTimestamp(
  outline: OutlineDocument,
  meta?: { updatedAt?: string; updatedBy?: "agent" | "human" },
): OutlineDocument {
  return {
    format: "seal-outline-1",
    volumes: outline.volumes.map((vol) => ({
      ...vol,
      ...(vol.ranges ? { ranges: vol.ranges.map((r) => ({ ...r })) } : {}),
    })),
    nodes: outline.nodes.map((node) => ({
      ...node,
      ...(node.tenderSource
        ? {
            tenderSource: {
              file: node.tenderSource.file,
              ranges: node.tenderSource.ranges.map((r) => ({ ...r })),
            },
          }
        : {}),
      ...(node.requirementIds ? { requirementIds: [...node.requirementIds] } : {}),
      ...(node.evidence
        ? {
            evidence: node.evidence.map((item) => ({
              ...item,
              ...(item.renderedPages
                ? { renderedPages: [...item.renderedPages] }
                : {}),
            })),
          }
        : {}),
    })),
    ...(meta?.updatedAt !== undefined
      ? { updatedAt: meta.updatedAt }
      : outline.updatedAt !== undefined
        ? { updatedAt: outline.updatedAt }
        : {}),
    ...(meta?.updatedBy !== undefined
      ? { updatedBy: meta.updatedBy }
      : outline.updatedBy !== undefined
        ? { updatedBy: outline.updatedBy }
        : {}),
  };
}

/** Add a new node after an optional sibling/parent slot without mutating the input outline. */
export function addOutlineNode(
  outline: OutlineDocument,
  nodeInput: OutlineNode,
  options?: {
    afterNodeId?: string;
    parentId?: string | null;
    updatedAt?: string;
    updatedBy?: "agent" | "human";
  },
): OutlineDocument {
  const base = withTimestamp(outline, options);
  if (base.nodes.some((item) => item.id === nodeInput.id)) {
    throw new Error(`节点 id 已存在：${nodeInput.id}`);
  }
  const candidateNode: OutlineNode = {
    ...nodeInput,
    parentId:
      options?.parentId !== undefined ? options.parentId : nodeInput.parentId,
  };
  const nextNodes = insertNodeAtPreorderSlot(
    base.nodes,
    candidateNode,
    options?.afterNodeId,
  );
  return assertValidOutline({ ...base, nodes: nextNodes });
}

/**
 * Enforce that every non-optional lockedTemplate node in `previous` remains present in `next`
 * with lockedTemplate === true, !optional, included === true, and unchanged title, volume, and kind.
 */
export function assertLockedTemplateTransitions(
  previous: OutlineDocument | null | undefined,
  next: OutlineDocument,
): void {
  if (!previous) return;
  const nextById = new Map(next.nodes.map((node) => [node.id, node]));
  for (const prev of previous.nodes) {
    if (prev.lockedTemplate !== true || prev.optional) continue;
    const nextNode = nextById.get(prev.id);
    if (!nextNode) {
      throw new Error(`已锁定的固定格式节点「${prev.title}」不能删除`);
    }
    if (nextNode.lockedTemplate !== true) {
      throw new Error(
        `已锁定的固定格式节点「${prev.title}」不能解除或省略 lockedTemplate 锁定`,
      );
    }
    if (nextNode.optional) {
      throw new Error(
        `已锁定的固定格式节点「${prev.title}」不能设为可选（optional）`,
      );
    }
    if (nextNode.included !== true) {
      throw new Error(
        `非可选的已锁定固定格式节点「${prev.title}」不能取消启用`,
      );
    }
    if (nextNode.title !== prev.title) {
      throw new Error(`已锁定的固定格式节点「${prev.title}」不能修改标题`);
    }
    if (nextNode.volume !== prev.volume) {
      throw new Error(`已锁定的固定格式节点「${prev.title}」不能修改所属分册`);
    }
    if (nextNode.kind !== prev.kind) {
      throw new Error(`已锁定的固定格式节点「${prev.title}」不能修改节点类型`);
    }
  }
}

/** Update fields of an existing node while enforcing non-optional lockedTemplate guards. */
export function updateOutlineNode(
  outline: OutlineDocument,
  id: string,
  patch: Partial<OutlineNode>,
  meta?: { updatedAt?: string; updatedBy?: "agent" | "human" },
): OutlineDocument {
  if (!isPlainObject(patch)) throw new Error("节点更新参数必须是对象");
  for (const key of Object.keys(patch)) {
    if (isForbiddenKey(key)) {
      throw new Error(`大纲禁止设置确认或核实字段：${key}`);
    }
  }
  const base = withTimestamp(outline, meta);
  const index = base.nodes.findIndex((item) => item.id === id);
  if (index < 0) throw new Error(`节点不存在：${id}`);
  const existing = base.nodes[index];
  if (patch.id !== undefined && patch.id !== existing.id) {
    throw new Error("不支持通过 updateOutlineNode 修改节点 id");
  }

  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }
  base.nodes[index] = merged as unknown as OutlineNode;
  const validated = assertValidOutline(base);
  assertLockedTemplateTransitions(outline, validated);
  return validated;
}

/** Delete a node and its entire subtree; rejects if any node in the subtree is lockedTemplate && !optional. */
export function deleteOutlineNode(
  outline: OutlineDocument,
  id: string,
  meta?: { updatedAt?: string; updatedBy?: "agent" | "human" },
): OutlineDocument {
  const base = withTimestamp(outline, meta);
  if (!base.nodes.some((item) => item.id === id)) {
    throw new Error(`节点不存在：${id}`);
  }
  const subtreeIds = collectSubtreeIds(base.nodes, id);
  const validated = assertValidOutline({
    ...base,
    nodes: base.nodes.filter((item) => !subtreeIds.has(item.id)),
  });
  assertLockedTemplateTransitions(outline, validated);
  return validated;
}

/** Move a node together with its subtree up or down among siblings sharing the same volume and parentId. */
export function moveOutlineNode(
  outline: OutlineDocument,
  id: string,
  direction: "up" | "down",
  meta?: { updatedAt?: string; updatedBy?: "agent" | "human" },
): OutlineDocument {
  const base = withTimestamp(outline, meta);
  const target = base.nodes.find((item) => item.id === id);
  if (!target) throw new Error(`节点不存在：${id}`);
  const siblings = base.nodes.filter(
    (item) => item.volume === target.volume && item.parentId === target.parentId,
  );
  const siblingIdx = siblings.findIndex((item) => item.id === id);
  const swapIdx = direction === "up" ? siblingIdx - 1 : siblingIdx + 1;
  if (swapIdx < 0 || swapIdx >= siblings.length) {
    return assertValidOutline(base);
  }
  const firstId = direction === "up" ? siblings[swapIdx].id : target.id;
  const secondId = direction === "up" ? target.id : siblings[swapIdx].id;
  const firstSet = collectSubtreeIds(base.nodes, firstId);
  const secondSet = collectSubtreeIds(base.nodes, secondId);
  const firstSubtree = base.nodes.filter((item) => firstSet.has(item.id));
  const secondSubtree = base.nodes.filter((item) => secondSet.has(item.id));
  const firstStart = base.nodes.findIndex((item) => item.id === firstId);

  const rebuilt: OutlineNode[] = [];
  let insertedSwapped = false;
  for (let i = 0; i < base.nodes.length; i++) {
    const current = base.nodes[i];
    if (i === firstStart) {
      rebuilt.push(...secondSubtree, ...firstSubtree);
      insertedSwapped = true;
    }
    if (!firstSet.has(current.id) && !secondSet.has(current.id)) {
      rebuilt.push(current);
    }
  }
  if (!insertedSwapped) {
    rebuilt.push(...secondSubtree, ...firstSubtree);
  }
  return assertValidOutline({ ...base, nodes: rebuilt });
}

/** Indent a node under its previous sibling, shifting subtree levels by +1 (clamped to 6). */
export function indentOutlineNode(
  outline: OutlineDocument,
  id: string,
  meta?: { updatedAt?: string; updatedBy?: "agent" | "human" },
): OutlineDocument {
  const base = withTimestamp(outline, meta);
  const target = base.nodes.find((item) => item.id === id);
  if (!target) throw new Error(`节点不存在：${id}`);
  const siblings = base.nodes.filter(
    (item) => item.volume === target.volume && item.parentId === target.parentId,
  );
  const siblingIdx = siblings.findIndex((item) => item.id === id);
  if (siblingIdx <= 0) {
    return assertValidOutline(base);
  }
  const prevSibling = siblings[siblingIdx - 1];
  const subtreeIds = collectSubtreeIds(base.nodes, id);
  const subtreeNodes = base.nodes
    .filter((item) => subtreeIds.has(item.id))
    .map((item) => ({
      ...item,
      ...(item.id === id ? { parentId: prevSibling.id } : {}),
      level: Math.min(6, item.level + 1),
    }));
  const remaining = base.nodes.filter((item) => !subtreeIds.has(item.id));
  const prevSubtreeIds = collectSubtreeIds(remaining, prevSibling.id);
  const prevIndex = remaining.findIndex((item) => item.id === prevSibling.id);
  let insertAt = prevIndex + 1;
  while (
    insertAt < remaining.length &&
    prevSubtreeIds.has(remaining[insertAt].id)
  ) {
    insertAt++;
  }
  remaining.splice(insertAt, 0, ...subtreeNodes);
  return assertValidOutline({ ...base, nodes: remaining });
}

/** Outdent a node to become the next sibling of its current parent, shifting subtree levels by -1 (min 1). */
export function outdentOutlineNode(
  outline: OutlineDocument,
  id: string,
  meta?: { updatedAt?: string; updatedBy?: "agent" | "human" },
): OutlineDocument {
  const base = withTimestamp(outline, meta);
  const target = base.nodes.find((item) => item.id === id);
  if (!target) throw new Error(`节点不存在：${id}`);
  if (target.parentId === null) {
    return assertValidOutline(base);
  }
  const parent = base.nodes.find((item) => item.id === target.parentId);
  if (!parent) throw new Error(`父节点不存在：${target.parentId}`);
  const subtreeIds = collectSubtreeIds(base.nodes, id);
  const subtreeNodes = base.nodes
    .filter((item) => subtreeIds.has(item.id))
    .map((item) => ({
      ...item,
      ...(item.id === id ? { parentId: parent.parentId } : {}),
      level: Math.max(1, item.level - 1),
    }));
  const remaining = base.nodes.filter((item) => !subtreeIds.has(item.id));
  const parentSubtreeIds = collectSubtreeIds(remaining, parent.id);
  const parentIndex = remaining.findIndex((item) => item.id === parent.id);
  let insertAt = parentIndex + 1;
  while (
    insertAt < remaining.length &&
    parentSubtreeIds.has(remaining[insertAt].id)
  ) {
    insertAt++;
  }
  remaining.splice(insertAt, 0, ...subtreeNodes);
  return assertValidOutline({ ...base, nodes: remaining });
}

/** Apply an atomic Agent/Workbench outline patch while preserving lockedTemplate invariants. */
export function patchOutline(
  outline: OutlineDocument,
  rawPatch: OutlinePatch,
): OutlineDocument {
  if (!isPlainObject(rawPatch)) throw new Error("patch 参数必须是对象");
  const allowedPatchKeys = new Set([
    "upsertNodes",
    "removeNodeIds",
    "updateVolumes",
    "updatedAt",
    "updatedBy",
  ]);
  for (const key of Object.keys(rawPatch)) {
    if (isForbiddenKey(key)) {
      throw new Error(`大纲 patch 禁止设置确认或核实字段：${key}`);
    }
    if (!allowedPatchKeys.has(key)) {
      throw new Error(`大纲 patch 包含不支持的字段：${key}`);
    }
  }

  let next = withTimestamp(outline, {
    ...(typeof rawPatch.updatedAt === "string"
      ? { updatedAt: rawPatch.updatedAt }
      : {}),
    ...(rawPatch.updatedBy === "agent" || rawPatch.updatedBy === "human"
      ? { updatedBy: rawPatch.updatedBy }
      : {}),
  });

  if (rawPatch.updateVolumes !== undefined) {
    if (!Array.isArray(rawPatch.updateVolumes)) {
      throw new Error("updateVolumes 必须是分册对象数组");
    }
    for (const vol of rawPatch.updateVolumes) {
      if (!isPlainObject(vol) || typeof vol.name !== "string") {
        throw new Error("updateVolumes 每项必须包含有效分册 name");
      }
      for (const key of Object.keys(vol)) {
        if (isForbiddenKey(key)) {
          throw new Error(`分册禁止设置确认或核实字段：${key}`);
        }
      }
      const typedVol = { ...vol } as unknown as OutlineVolume;
      const existingIndex = next.volumes.findIndex((item) => item.name === typedVol.name);
      if (existingIndex >= 0) {
        next.volumes[existingIndex] = typedVol;
      } else {
        next.volumes.push(typedVol);
      }
    }
  }

  if (rawPatch.removeNodeIds !== undefined) {
    if (
      !Array.isArray(rawPatch.removeNodeIds) ||
      rawPatch.removeNodeIds.some((id) => typeof id !== "string" || !id.trim())
    ) {
      throw new Error("removeNodeIds 必须是非空字符串数组");
    }
    const existingIds = new Set(next.nodes.map((node) => node.id));
    for (const id of rawPatch.removeNodeIds) {
      if (!existingIds.has(id)) {
        throw new Error(`待删除节点不存在：${id}`);
      }
    }
    const toRemove = new Set<string>();
    for (const id of rawPatch.removeNodeIds) {
      for (const subId of collectSubtreeIds(next.nodes, id)) {
        toRemove.add(subId);
      }
    }
    next = {
      ...next,
      nodes: next.nodes.filter((item) => !toRemove.has(item.id)),
    };
  }

  if (rawPatch.upsertNodes !== undefined) {
    if (!Array.isArray(rawPatch.upsertNodes)) {
      throw new Error("upsertNodes 必须是节点对象数组");
    }
    for (const rawNode of rawPatch.upsertNodes) {
      if (!isPlainObject(rawNode) || typeof rawNode.id !== "string") {
        throw new Error("upsertNodes 每项必须是包含 id 的节点对象");
      }
      for (const key of Object.keys(rawNode)) {
        if (isForbiddenKey(key)) {
          throw new Error(`节点禁止设置确认或核实字段：${key}`);
        }
      }
      const incoming = rawNode as unknown as OutlineNode;
      const existingIndex = next.nodes.findIndex(
        (item) => item.id === incoming.id,
      );
      if (existingIndex >= 0) {
        next.nodes[existingIndex] = { ...incoming };
      } else {
        next = {
          ...next,
          nodes: insertNodeAtPreorderSlot(next.nodes, { ...incoming }),
        };
      }
    }
  }

  const validated = assertValidOutline(next);
  assertLockedTemplateTransitions(outline, validated);
  return validated;
}

const NUMBER_PREFIX_PATTERNS = [
  /^第[一二三四五六七八九十百千0-9]+[章节部分篇条款项]/u,
  /^\([0-9一二三四五六七八九十]+\)/u,
  /^[0-9]+(?:\.[0-9]+)+[、.．:：)）]?/u,
  /^[0-9一二三四五六七八九十]+[、.．:：)）]/u,
  /^[a-z][.．、)]/u,
];

function normalizeHeadingRaw(text: string): string {
  return text.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
}

function stripNumberPrefix(normalized: string): string {
  let current = normalized;
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const pattern of NUMBER_PREFIX_PATTERNS) {
      const stripped = current.replace(pattern, "");
      if (stripped !== current && stripped.length > 0) {
        current = stripped;
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }
  return current;
}

const LABEL_PREFIX_PATTERN =
  /^(?:附件|格式|附表|表)(?:[0-9a-z一二三四五六七八九十]+(?:\.[0-9]+)*[:、.\-]?|[:、.\-])/u;
const HEADING_STYLE_LEVEL_PATTERN = /^(?:heading|标题)\s*([1-9])$/i;

function headingVariants(rawHeading: string): string[] {
  const full = normalizeHeadingRaw(rawHeading);
  if (!full) return [];
  const stripped = stripNumberPrefix(full);
  return stripped && stripped !== full ? [full, stripped] : [full];
}

interface VisibleBodyParagraphInfo {
  text: string;
  start: number;
  end: number;
  headingLevel: number;
  inTable: boolean;
}

function styleResolvedHeadingLevel(
  chain: readonly WordStyle[],
  defaults?: number,
): number {
  for (let i = chain.length - 1; i >= 0; i--) {
    const level = chain[i].outlineLevel;
    if (level !== undefined) return level === 9 ? 0 : level + 1;
  }
  for (let i = chain.length - 1; i >= 0; i--) {
    const match = HEADING_STYLE_LEVEL_PATTERN.exec(chain[i].name ?? chain[i].id);
    if (match) return Number(match[1]);
  }
  return defaults !== undefined && defaults !== 9 ? defaults + 1 : 0;
}

function paragraphHeadingLevel(
  docXml: string,
  elements: readonly ReturnType<typeof xmlElements>[number][],
  children: readonly number[][],
  paraIdx: number,
  styles: WordStyles | null,
  excludedSpans: readonly XmlSpan[] = [],
): number {
  const pPrIdx = activeChildrenOf(elements, children, paraIdx, excludedSpans).find(
    (childIdx) => elements[childIdx].name === "w:pPr",
  );
  let styleId: string | undefined;
  if (pPrIdx !== undefined) {
    const pPrChildren = activeChildrenOf(elements, children, pPrIdx, excludedSpans);
    const explicitIdx = pPrChildren.find(
      (childIdx) => elements[childIdx].name === "w:outlineLvl",
    );
    if (explicitIdx !== undefined) {
      const val = xmlAttributes(docXml, elements[explicitIdx]).get("w:val");
      return val !== undefined && /^[0-8]$/.test(val) ? Number(val) + 1 : 0;
    }
    const styleIdx = pPrChildren.find(
      (childIdx) => elements[childIdx].name === "w:pStyle",
    );
    if (styleIdx !== undefined) {
      styleId = xmlAttributes(docXml, elements[styleIdx]).get("w:val");
    }
  }
  if (!styles) {
    const match = styleId ? HEADING_STYLE_LEVEL_PATTERN.exec(styleId) : null;
    return match ? Number(match[1]) : 0;
  }
  const effectiveStyleId = styleId ?? styles.defaultParagraph;
  const level = styleResolvedHeadingLevel(
    styleChain(styles, effectiveStyleId, "paragraph"),
    styles.defaultOutline,
  );
  if (level > 0) return level;
  if (effectiveStyleId && !styles.styles.has(effectiveStyleId)) {
    const match = HEADING_STYLE_LEVEL_PATTERN.exec(effectiveStyleId);
    if (match) return Number(match[1]);
  }
  return 0;
}

function headingMatchesParagraph(
  para: VisibleBodyParagraphInfo,
  variants: readonly string[],
): boolean {
  if (variants.length === 0) return false;
  const pNorm = normalizeHeadingRaw(para.text);
  if (!pNorm) return false;
  const pStripped = stripNumberPrefix(pNorm);
  const pLabelStripped = pStripped.replace(LABEL_PREFIX_PATTERN, "");

  for (const variant of variants) {
    if (!variant) continue;
    if (pNorm === variant || pStripped === variant) {
      return true;
    }
    // Allow deterministic numbering-like form prefixes (e.g. "格式一：投标函" matching "投标函")
    // ONLY when the expected variant itself does not carry an explicit form/attachment label.
    if (
      pLabelStripped.length > 0 &&
      !LABEL_PREFIX_PATTERN.test(variant) &&
      pLabelStripped === variant
    ) {
      return true;
    }
  }
  return false;
}

function countMissingExpectedHashes(
  expectedHashes: readonly string[],
  presentHashes: readonly string[],
): number {
  const available = new Map<string, number>();
  for (const hash of presentHashes) {
    available.set(hash, (available.get(hash) ?? 0) + 1);
  }
  let missing = 0;
  for (const hash of expectedHashes) {
    const count = available.get(hash) ?? 0;
    if (count > 0) {
      available.set(hash, count - 1);
    } else {
      missing++;
    }
  }
  return missing;
}

interface XmlSpan {
  start: number;
  end: number;
}

interface AlternateContentProfile {
  excludedSpans: readonly XmlSpan[];
  projectedStylesXml: string;
}

function isSpanExcluded(
  start: number,
  end: number,
  excludedSpans: readonly XmlSpan[],
): boolean {
  for (const span of excludedSpans) {
    if (start >= span.start && end <= span.end) return true;
    if (span.start > start) break;
  }
  return false;
}

function isOffsetExcluded(
  pos: number,
  excludedSpans: readonly XmlSpan[],
): boolean {
  for (const span of excludedSpans) {
    if (pos >= span.start && pos < span.end) return true;
    if (span.start > pos) break;
  }
  return false;
}

function mergeSortedSpans(spans: XmlSpan[]): XmlSpan[] {
  if (spans.length <= 1) return spans;
  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: XmlSpan[] = [spans[0]];
  for (let i = 1; i < spans.length; i++) {
    const prev = merged[merged.length - 1];
    const cur = spans[i];
    if (cur.start <= prev.end) {
      if (cur.end > prev.end) prev.end = cur.end;
    } else {
      merged.push(cur);
    }
  }
  return merged;
}

const MC_NAMESPACE_URI =
  "http://schemas.openxmlformats.org/markup-compatibility/2006";
const MAX_ALTERNATE_CONTENT_URI_CLASSES = 8;
const MAX_ALTERNATE_CONTENT_PROFILES = 64;

type AlternateContentProfilesResult =
  | { kind: "ok"; profiles: AlternateContentProfile[] }
  | { kind: "error"; reason: string };

interface ParsedAltNode {
  altIdx: number;
  choices: Array<{ idx: number; requiredUris: string[] }>;
  fallbackIdx: number | null;
  allBranchIndices: number[];
}

type ParsedAltPartResult =
  | {
      kind: "ok";
      elements: ReturnType<typeof xmlElements>;
      altNodes: ParsedAltNode[];
    }
  | { kind: "error"; reason: string };

function parseAlternateContentPart(xml: string): ParsedAltPartResult {
  if (!xml) return { kind: "ok", elements: [], altNodes: [] };
  const elements = xmlElements(xml);
  const children = elementChildren(elements);
  const nsByElement = new Array<ReadonlyMap<string, string>>(elements.length);
  const rootNs = new Map<string, string>([
    ["xml", "http://www.w3.org/XML/1998/namespace"],
  ]);
  const buildScopes = (idx: number, parentNs: ReadonlyMap<string, string>): void => {
    const el = elements[idx];
    const attrs = xmlAttributes(xml, el);
    let ns: Map<string, string> | null = null;
    for (const [k, v] of attrs) {
      if (k === "xmlns") {
        if (!ns) ns = new Map(parentNs);
        if (v) ns.set("", v);
        else ns.delete("");
      } else if (k.startsWith("xmlns:")) {
        if (!ns) ns = new Map(parentNs);
        const prefix = k.slice(6);
        if (v) ns.set(prefix, v);
        else ns.delete(prefix);
      }
    }
    const effective = ns ?? parentNs;
    nsByElement[idx] = effective;
    for (const childIdx of children[idx]) {
      buildScopes(childIdx, effective);
    }
  };
  for (let i = 0; i < elements.length; i++) {
    if (elements[i].parent === null) {
      buildScopes(i, rootNs);
    }
  }

  const isMcElement = (idx: number, localName: string): boolean => {
    const name = elements[idx].name;
    const colon = name.indexOf(":");
    const prefix = colon < 0 ? "" : name.slice(0, colon);
    const local = colon < 0 ? name : name.slice(colon + 1);
    if (local !== localName) return false;
    const uri = nsByElement[idx]?.get(prefix);
    return uri === MC_NAMESPACE_URI || (uri === undefined && prefix === "mc");
  };

  const altNodes: ParsedAltNode[] = [];
  for (let i = 0; i < elements.length; i++) {
    if (!isMcElement(i, "AlternateContent")) continue;
    const choices: Array<{ idx: number; requiredUris: string[] }> = [];
    let fallbackIdx: number | null = null;
    const allBranchIndices: number[] = [];
    for (const childIdx of children[i]) {
      if (isMcElement(childIdx, "Choice")) {
        const reqAttr = xmlAttributes(xml, elements[childIdx]).get("Requires");
        const prefixes = (reqAttr ?? "").trim().split(/\s+/).filter(Boolean);
        if (prefixes.length === 0) {
          return {
            kind: "error",
            reason: "文档包含缺少有效 Requires 属性的 mc:Choice 分支，无法确定兼容渲染行为",
          };
        }
        const scope = nsByElement[childIdx];
        const resolvedSet = new Set<string>();
        for (const prefix of prefixes) {
          const uri = scope?.get(prefix);
          if (!uri) {
            return {
              kind: "error",
              reason: `mc:Choice 的 Requires 引用了未声明的命名空间前缀「${prefix}」，无法确定兼容渲染行为`,
            };
          }
          resolvedSet.add(uri);
        }
        choices.push({ idx: childIdx, requiredUris: [...resolvedSet] });
        allBranchIndices.push(childIdx);
      } else if (isMcElement(childIdx, "Fallback")) {
        if (fallbackIdx === null) fallbackIdx = childIdx;
        allBranchIndices.push(childIdx);
      }
    }
    if (allBranchIndices.length > 0) {
      altNodes.push({ altIdx: i, choices, fallbackIdx, allBranchIndices });
    }
  }
  return { kind: "ok", elements, altNodes };
}

function projectXmlByAlternateChoices(
  xml: string,
  elements: readonly ReturnType<typeof xmlElements>[number][],
  sortedAltIndices: readonly number[],
  chosenBranchByAltIdx: ReadonlyMap<number, number | null>,
): string {
  if (sortedAltIndices.length === 0) return xml;
  const renderRange = (rangeStart: number, rangeEnd: number): string => {
    if (rangeEnd <= rangeStart) return "";
    const out: string[] = [];
    let cursor = rangeStart;
    for (const altIdx of sortedAltIndices) {
      const altEl = elements[altIdx];
      if (altEl.end <= rangeStart) continue;
      if (altEl.start >= rangeEnd) break;
      if (altEl.start < cursor) continue;
      out.push(xml.slice(cursor, altEl.start));
      const chosenIdx = chosenBranchByAltIdx.get(altIdx) ?? null;
      if (chosenIdx !== null) {
        const chosenEl = elements[chosenIdx];
        out.push(renderRange(chosenEl.openEnd, chosenEl.closeStart));
      }
      cursor = altEl.end;
    }
    out.push(xml.slice(cursor, rangeEnd));
    return out.join("");
  };
  return renderRange(0, xml.length);
}

/**
 * Resolve ALL reachable OOXML Markup Compatibility (ECMA-376 Part 3 §10.2.1) consumer profiles
 * jointly across word/document.xml and word/styles.xml.
 * - Resolves every Choice/@Requires prefix against the Choice element's in-scope XML namespace URI.
 * - Shares a single consumer capability mask across both parts so incompatible cross-part branch
 *   combinations are never synthesized while every reachable consumer view is verified.
 * - Fails closed on missing/unbound Requires prefixes or when reachable profile combinations exceed
 *   the deterministic verification budget (never silently samples or truncates).
 */
function alternateContentProfiles(
  docXml: string,
  stylesXml = "",
): AlternateContentProfilesResult {
  const docPart = parseAlternateContentPart(docXml);
  if (docPart.kind === "error") return docPart;
  const stylesPart = parseAlternateContentPart(stylesXml);
  if (stylesPart.kind === "error") return stylesPart;

  if (docPart.altNodes.length === 0 && stylesPart.altNodes.length === 0) {
    return {
      kind: "ok",
      profiles: [{ excludedSpans: [], projectedStylesXml: stylesXml }],
    };
  }

  const uriIncidence = new Map<string, number[]>();
  let globalChoiceSeq = 0;
  for (const part of [docPart, stylesPart]) {
    for (const alt of part.altNodes) {
      for (const choice of alt.choices) {
        const seq = globalChoiceSeq++;
        for (const uri of choice.requiredUris) {
          const list = uriIncidence.get(uri) ?? [];
          list.push(seq);
          uriIncidence.set(uri, list);
        }
      }
    }
  }

  // Exact algebraic compression: URIs that appear in the exact same set of Choice
  // elements are logically equivalent (every Choice requires ALL of its listed URIs).
  const classIdByUri = new Map<string, number>();
  const classSigToId = new Map<string, number>();
  for (const [uri, seqs] of uriIncidence) {
    const sig = seqs.join(",");
    let cid = classSigToId.get(sig);
    if (cid === undefined) {
      cid = classSigToId.size;
      classSigToId.set(sig, cid);
    }
    classIdByUri.set(uri, cid);
  }
  const classCount = classSigToId.size;
  if (classCount > MAX_ALTERNATE_CONTENT_URI_CLASSES) {
    return {
      kind: "error",
      reason: `文档包含 ${classCount} 组相互独立的 mc:AlternateContent 兼容命名空间能力（超过精确核验上限 ${MAX_ALTERNATE_CONTENT_URI_CLASSES}），无法保证所有 Word 版本下大纲与证据一致`,
    };
  }

  const compileAltNodes = (nodes: readonly ParsedAltNode[]) =>
    nodes.map((alt) => ({
      altIdx: alt.altIdx,
      choices: alt.choices.map((c) => {
        let reqMask = 0;
        for (const uri of c.requiredUris) {
          reqMask |= 1 << classIdByUri.get(uri)!;
        }
        return { idx: c.idx, reqMask };
      }),
      fallbackIdx: alt.fallbackIdx,
      allBranchIndices: alt.allBranchIndices,
    }));

  const docAltMasks = compileAltNodes(docPart.altNodes);
  const stylesAltMasks = compileAltNodes(stylesPart.altNodes);
  const sortedStylesAltIndices = stylesPart.altNodes
    .map((alt) => alt.altIdx)
    .sort((a, b) => stylesPart.elements[a].start - stylesPart.elements[b].start);

  const profiles: AlternateContentProfile[] = [];
  const seenProfileSigs = new Set<string>();
  const projectedStylesCache = new Map<string, string>();
  const totalMasks = 1 << classCount;
  for (let mask = 0; mask < totalMasks; mask++) {
    const excluded: XmlSpan[] = [];
    for (const alt of docAltMasks) {
      let chosen: number | null = null;
      for (const choice of alt.choices) {
        if ((mask & choice.reqMask) === choice.reqMask) {
          chosen = choice.idx;
          break;
        }
      }
      if (chosen === null) chosen = alt.fallbackIdx;
      for (const bIdx of alt.allBranchIndices) {
        if (bIdx !== chosen) {
          excluded.push({
            start: docPart.elements[bIdx].start,
            end: docPart.elements[bIdx].end,
          });
        }
      }
    }
    const merged = mergeSortedSpans(excluded);
    const docSig = merged.map((s) => `${s.start}:${s.end}`).join(",");

    const chosenStylesBranchByAltIdx = new Map<number, number | null>();
    const stylesSigParts: string[] = [];
    for (const alt of stylesAltMasks) {
      let chosen: number | null = null;
      for (const choice of alt.choices) {
        if ((mask & choice.reqMask) === choice.reqMask) {
          chosen = choice.idx;
          break;
        }
      }
      if (chosen === null) chosen = alt.fallbackIdx;
      chosenStylesBranchByAltIdx.set(alt.altIdx, chosen);
      stylesSigParts.push(`${alt.altIdx}:${chosen ?? -1}`);
    }
    const stylesSig = stylesSigParts.join(",");
    const profileSig = `${docSig}|${stylesSig}`;
    if (seenProfileSigs.has(profileSig)) continue;
    seenProfileSigs.add(profileSig);
    if (profiles.length >= MAX_ALTERNATE_CONTENT_PROFILES) {
      return {
        kind: "error",
        reason: `文档包含超过 ${MAX_ALTERNATE_CONTENT_PROFILES} 种可达的 mc:AlternateContent 兼容分支组合，无法完成全覆盖核验`,
      };
    }
    let projectedStylesXml = projectedStylesCache.get(stylesSig);
    if (projectedStylesXml === undefined) {
      projectedStylesXml = projectXmlByAlternateChoices(
        stylesXml,
        stylesPart.elements,
        sortedStylesAltIndices,
        chosenStylesBranchByAltIdx,
      );
      projectedStylesCache.set(stylesSig, projectedStylesXml);
    }
    profiles.push({ excludedSpans: merged, projectedStylesXml });
  }
  return { kind: "ok", profiles };
}

type TableStyleConditionType =
  | "wholeTable"
  | "band1Vert"
  | "band2Vert"
  | "band1Horz"
  | "band2Horz"
  | "firstRow"
  | "lastRow"
  | "firstCol"
  | "lastCol"
  | "nwCell"
  | "neCell"
  | "swCell"
  | "seCell";

const TABLE_CELL_CONDITION_ORDER: readonly Exclude<TableStyleConditionType, "wholeTable">[] = [
  "band1Vert",
  "band2Vert",
  "band1Horz",
  "band2Horz",
  "firstRow",
  "lastRow",
  "firstCol",
  "lastCol",
  "nwCell",
  "neCell",
  "swCell",
  "seCell",
];

const TABLE_CONDITION_SET = new Set<string>(["wholeTable", ...TABLE_CELL_CONDITION_ORDER]);

interface RunVisibilityProps {
  vanish?: boolean;
  webHidden?: boolean;
}

interface TableLookFlags {
  firstRow: boolean;
  lastRow: boolean;
  firstCol: boolean;
  lastCol: boolean;
  noHBand: boolean;
  noVBand: boolean;
}

interface TableStyleExtra {
  rowBandSize?: number;
  colBandSize?: number;
  tblLook?: TableLookFlags;
  conditions: ReadonlyMap<TableStyleConditionType, RunVisibilityProps>;
}

interface StyleVisibilityInfo {
  styles: WordStyles | null;
  defaultTable?: string;
  defaultVanish: boolean;
  defaultWebHidden: boolean;
  vanishByStyleId: ReadonlyMap<string, boolean>;
  webHiddenByStyleId: ReadonlyMap<string, boolean>;
  tableExtrasByStyleId: ReadonlyMap<string, TableStyleExtra>;
  hasAnyTableVisibility: boolean;
}

const isOffXmlVal = (val: string | undefined): boolean =>
  val !== undefined && ["0", "false", "off"].includes(val.toLowerCase());

const isTrueXmlAttr = (val: string | undefined): boolean =>
  val !== undefined && ["1", "true", "on"].includes(val.toLowerCase());

function parsePositiveIntVal(val: string | undefined): number | undefined {
  if (!val || !/^\d+$/.test(val)) return undefined;
  const n = Number(val);
  return Number.isSafeInteger(n) && n >= 1 ? n : undefined;
}

function parseTblLookElement(
  xml: string,
  el: ReturnType<typeof xmlElements>[number],
): TableLookFlags {
  const attrs = xmlAttributes(xml, el);
  const rawHex = attrs.get("w:val");
  const mask = rawHex ? Number.parseInt(rawHex, 16) : 0;
  const safeMask = Number.isFinite(mask) ? mask : 0;
  const readFlag = (attrName: string, bit: number): boolean => {
    const attrVal = attrs.get(attrName);
    return attrVal !== undefined ? !isOffXmlVal(attrVal) : (safeMask & bit) !== 0;
  };
  return {
    firstRow: readFlag("w:firstRow", 0x0020),
    lastRow: readFlag("w:lastRow", 0x0040),
    firstCol: readFlag("w:firstColumn", 0x0080),
    lastCol: readFlag("w:lastColumn", 0x0100),
    noHBand: readFlag("w:noHBand", 0x0200),
    noVBand: readFlag("w:noVBand", 0x0400),
  };
}

const CNF_BIT_ORDER: readonly TableStyleConditionType[] = [
  "firstRow",
  "lastRow",
  "firstCol",
  "lastCol",
  "band1Vert",
  "band2Vert",
  "band1Horz",
  "band2Horz",
  "neCell",
  "nwCell",
  "seCell",
  "swCell",
];

const CNF_ATTR_MAP: ReadonlyArray<readonly [string, TableStyleConditionType]> = [
  ["w:firstRow", "firstRow"],
  ["w:lastRow", "lastRow"],
  ["w:firstColumn", "firstCol"],
  ["w:lastColumn", "lastCol"],
  ["w:oddVBand", "band1Vert"],
  ["w:evenVBand", "band2Vert"],
  ["w:oddHBand", "band1Horz"],
  ["w:evenHBand", "band2Horz"],
  ["w:firstRowLastColumn", "neCell"],
  ["w:firstRowFirstColumn", "nwCell"],
  ["w:lastRowLastColumn", "seCell"],
  ["w:lastRowFirstColumn", "swCell"],
];

function parseCnfStyleElement(
  xml: string,
  el: ReturnType<typeof xmlElements>[number],
): Set<TableStyleConditionType> {
  const attrs = xmlAttributes(xml, el);
  const active = new Set<TableStyleConditionType>();
  const bits = attrs.get("w:val");
  if (bits) {
    for (let i = 0; i < CNF_BIT_ORDER.length && i < bits.length; i++) {
      if (bits[i] === "1") active.add(CNF_BIT_ORDER[i]);
    }
  }
  for (const [attrName, cond] of CNF_ATTR_MAP) {
    const val = attrs.get(attrName);
    if (val === undefined) continue;
    if (!isOffXmlVal(val)) active.add(cond);
    else active.delete(cond);
  }
  return active;
}

type StyleVisibilityResult =
  | { kind: "ok"; visibility: StyleVisibilityInfo }
  | { kind: "error"; reason: string };

function parseStyleVisibility(stylesXml: string): StyleVisibilityResult {
  if (!stylesXml) {
    return {
      kind: "ok",
      visibility: {
        styles: null,
        defaultVanish: false,
        defaultWebHidden: false,
        vanishByStyleId: new Map(),
        webHiddenByStyleId: new Map(),
        tableExtrasByStyleId: new Map(),
        hasAnyTableVisibility: false,
      },
    };
  }
  try {
    const styles = wordStyles(stylesXml);
    for (const style of styles.styles.values()) {
      styleChain(styles, style.id, style.type);
    }
    let defaultTable: string | undefined;
    let defaultVanish = false;
    let defaultWebHidden = false;
    let hasAnyTableVisibility = false;
    const vanishByStyleId = new Map<string, boolean>();
    const webHiddenByStyleId = new Map<string, boolean>();
    const tableExtrasByStyleId = new Map<string, TableStyleExtra>();
    const sElements = xmlElements(stylesXml);
    const sChildren = elementChildren(sElements);
    const root = sElements.findIndex((el) => el.name === "w:styles");
    const findChild = (parent: number, name: string): number =>
      parent < 0
        ? -1
        : (sChildren[parent].find((idx) => sElements[idx].name === name) ?? -1);
    const getVal = (idx: number): string | undefined =>
      idx < 0 ? undefined : xmlAttributes(stylesXml, sElements[idx]).get("w:val");
    const readRPrVisibility = (rPrIdx: number): RunVisibilityProps => {
      if (rPrIdx < 0) return {};
      const props: RunVisibilityProps = {};
      const vIdx = findChild(rPrIdx, "w:vanish");
      if (vIdx >= 0) props.vanish = !isOffXmlVal(getVal(vIdx));
      const whIdx = findChild(rPrIdx, "w:webHidden");
      if (whIdx >= 0) props.webHidden = !isOffXmlVal(getVal(whIdx));
      return props;
    };
    if (root >= 0) {
      for (const idx of sChildren[root]) {
        const el = sElements[idx];
        if (el.name === "w:style") {
          const attrs = xmlAttributes(stylesXml, el);
          const styleId = attrs.get("w:styleId");
          if (!styleId) continue;
          const styleType = attrs.get("w:type") ?? "paragraph";
          if (styleType === "table" && isTrueXmlAttr(attrs.get("w:default"))) {
            defaultTable = styleId;
          }
          const rProps = readRPrVisibility(findChild(idx, "w:rPr"));
          if (rProps.vanish !== undefined) vanishByStyleId.set(styleId, rProps.vanish);
          if (rProps.webHidden !== undefined) webHiddenByStyleId.set(styleId, rProps.webHidden);
          if (styleType === "table") {
            if (rProps.vanish !== undefined || rProps.webHidden !== undefined) {
              hasAnyTableVisibility = true;
            }
            const tblPrIdx = findChild(idx, "w:tblPr");
            const rowBandSize = parsePositiveIntVal(
              getVal(findChild(tblPrIdx, "w:tblStyleRowBandSize")),
            );
            const colBandSize = parsePositiveIntVal(
              getVal(findChild(tblPrIdx, "w:tblStyleColBandSize")),
            );
            const tblLookIdx = findChild(tblPrIdx, "w:tblLook");
            const tblLook =
              tblLookIdx >= 0 ? parseTblLookElement(stylesXml, sElements[tblLookIdx]) : undefined;
            const conditions = new Map<TableStyleConditionType, RunVisibilityProps>();
            for (const childIdx of sChildren[idx]) {
              if (sElements[childIdx].name !== "w:tblStylePr") continue;
              const condType = xmlAttributes(stylesXml, sElements[childIdx]).get("w:type");
              if (!condType || !TABLE_CONDITION_SET.has(condType)) continue;
              const condProps = readRPrVisibility(findChild(childIdx, "w:rPr"));
              if (condProps.vanish !== undefined || condProps.webHidden !== undefined) {
                conditions.set(condType as TableStyleConditionType, condProps);
                hasAnyTableVisibility = true;
              }
            }
            if (
              rowBandSize !== undefined ||
              colBandSize !== undefined ||
              tblLook !== undefined ||
              conditions.size > 0
            ) {
              tableExtrasByStyleId.set(styleId, {
                rowBandSize,
                colBandSize,
                tblLook,
                conditions,
              });
            }
          }
        } else if (el.name === "w:docDefaults") {
          const dProps = readRPrVisibility(findChild(findChild(idx, "w:rPrDefault"), "w:rPr"));
          if (dProps.vanish !== undefined) defaultVanish = dProps.vanish;
          if (dProps.webHidden !== undefined) defaultWebHidden = dProps.webHidden;
        }
      }
    }
    return {
      kind: "ok",
      visibility: {
        styles,
        defaultTable,
        defaultVanish,
        defaultWebHidden,
        vanishByStyleId,
        webHiddenByStyleId,
        tableExtrasByStyleId,
        hasAnyTableVisibility,
      },
    };
  } catch (error) {
    return {
      kind: "error",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

interface CachedTableMeta {
  tblStyleId?: string;
  tblLook?: TableLookFlags;
  rowBandSize?: number;
  colBandSize?: number;
  rowIndexByTr: Map<number, number>;
  rowCount: number;
}

interface CachedRowMeta {
  colIndexByTc: Map<number, number>;
  colCount: number;
  gridBefore: number;
  gridAfter: number;
  trCnf?: Set<TableStyleConditionType>;
}

interface TableLayoutCache {
  tables: Map<number, CachedTableMeta>;
  rows: Map<number, CachedRowMeta>;
}

function isCompatWrapperName(name: string): boolean {
  const local = name.split(":").pop();
  return local === "AlternateContent" || local === "Choice" || local === "Fallback";
}

function activeChildrenOf(
  elements: readonly ReturnType<typeof xmlElements>[number][],
  children: readonly number[][],
  parentIdx: number,
  excludedSpans: readonly XmlSpan[],
): number[] {
  const result: number[] = [];
  const collect = (idx: number) => {
    for (const childIdx of children[idx]) {
      const child = elements[childIdx];
      if (isSpanExcluded(child.start, child.end, excludedSpans)) continue;
      if (isCompatWrapperName(child.name)) {
        collect(childIdx);
      } else {
        result.push(childIdx);
      }
    }
  };
  collect(parentIdx);
  return result;
}

function getCachedTableMeta(
  docXml: string,
  elements: readonly ReturnType<typeof xmlElements>[number][],
  children: readonly number[][],
  tblIdx: number,
  excludedSpans: readonly XmlSpan[],
  cache: TableLayoutCache,
): CachedTableMeta {
  const existing = cache.tables.get(tblIdx);
  if (existing) return existing;
  let tblStyleId: string | undefined;
  let tblLook: TableLookFlags | undefined;
  let rowBandSize: number | undefined;
  let colBandSize: number | undefined;
  const tblPrIdx = activeChildrenOf(elements, children, tblIdx, excludedSpans).find(
    (c) => elements[c].name === "w:tblPr",
  );
  if (tblPrIdx !== undefined) {
    for (const propIdx of activeChildrenOf(elements, children, tblPrIdx, excludedSpans)) {
      const prop = elements[propIdx];
      if (prop.name === "w:tblStyle") {
        tblStyleId = xmlAttributes(docXml, prop).get("w:val");
      } else if (prop.name === "w:tblLook") {
        tblLook = parseTblLookElement(docXml, prop);
      } else if (prop.name === "w:tblStyleRowBandSize") {
        rowBandSize = parsePositiveIntVal(xmlAttributes(docXml, prop).get("w:val"));
      } else if (prop.name === "w:tblStyleColBandSize") {
        colBandSize = parsePositiveIntVal(xmlAttributes(docXml, prop).get("w:val"));
      }
    }
  }
  const rows: number[] = [];
  const collectRows = (parentIdx: number) => {
    for (const childIdx of children[parentIdx]) {
      const child = elements[childIdx];
      if (isSpanExcluded(child.start, child.end, excludedSpans)) continue;
      const name = child.name;
      if (name === "w:del" || name === "w:moveFrom" || name.endsWith("PrChange")) continue;
      if (name === "w:tr") {
        if (!isDeletedTableRow(elements, children, childIdx, excludedSpans)) {
          rows.push(childIdx);
        }
      } else if (
        name === "w:sdt" ||
        name === "w:sdtContent" ||
        name === "w:customXml" ||
        name === "w:ins" ||
        name === "w:moveTo" ||
        isCompatWrapperName(name)
      ) {
        collectRows(childIdx);
      }
    }
  };
  collectRows(tblIdx);
  const rowIndexByTr = new Map<number, number>();
  rows.forEach((tr, i) => rowIndexByTr.set(tr, i));
  const meta: CachedTableMeta = {
    tblStyleId,
    tblLook,
    rowBandSize,
    colBandSize,
    rowIndexByTr,
    rowCount: rows.length,
  };
  cache.tables.set(tblIdx, meta);
  return meta;
}

function getCachedRowMeta(
  docXml: string,
  elements: readonly ReturnType<typeof xmlElements>[number][],
  children: readonly number[][],
  trIdx: number,
  excludedSpans: readonly XmlSpan[],
  cache: TableLayoutCache,
): CachedRowMeta {
  const existing = cache.rows.get(trIdx);
  if (existing) return existing;
  let gridBefore = 0;
  let gridAfter = 0;
  let trCnf: Set<TableStyleConditionType> | undefined;
  const trPrIdx = activeChildrenOf(elements, children, trIdx, excludedSpans).find(
    (c) => elements[c].name === "w:trPr",
  );
  if (trPrIdx !== undefined) {
    for (const propIdx of activeChildrenOf(elements, children, trPrIdx, excludedSpans)) {
      const prop = elements[propIdx];
      if (prop.name === "w:gridBefore") {
        gridBefore = parsePositiveIntVal(xmlAttributes(docXml, prop).get("w:val")) ?? 0;
      } else if (prop.name === "w:gridAfter") {
        gridAfter = parsePositiveIntVal(xmlAttributes(docXml, prop).get("w:val")) ?? 0;
      } else if (prop.name === "w:cnfStyle") {
        trCnf = parseCnfStyleElement(docXml, prop);
      }
    }
  }
  const cells: number[] = [];
  const collectCells = (parentIdx: number) => {
    for (const childIdx of children[parentIdx]) {
      const child = elements[childIdx];
      if (isSpanExcluded(child.start, child.end, excludedSpans)) continue;
      const name = child.name;
      if (name === "w:del" || name === "w:moveFrom" || name.endsWith("PrChange")) continue;
      if (name === "w:tc") {
        cells.push(childIdx);
      } else if (
        name === "w:sdt" ||
        name === "w:sdtContent" ||
        name === "w:customXml" ||
        name === "w:ins" ||
        name === "w:moveTo" ||
        isCompatWrapperName(name)
      ) {
        collectCells(childIdx);
      }
    }
  };
  collectCells(trIdx);
  const colIndexByTc = new Map<number, number>();
  cells.forEach((tc, i) => colIndexByTc.set(tc, i));
  const meta: CachedRowMeta = {
    colIndexByTc,
    colCount: cells.length,
    gridBefore,
    gridAfter,
    trCnf,
  };
  cache.rows.set(trIdx, meta);
  return meta;
}

function activeTableConditionsForCell(
  docXml: string,
  elements: readonly ReturnType<typeof xmlElements>[number][],
  children: readonly number[][],
  pPrIdx: number | undefined,
  tcIdx: number,
  trIdx: number,
  tblIdx: number,
  tableChain: readonly WordStyle[],
  visibility: StyleVisibilityInfo,
  excludedSpans: readonly XmlSpan[],
  cache: TableLayoutCache,
): Set<TableStyleConditionType> {
  if (pPrIdx !== undefined) {
    const pCnfIdx = activeChildrenOf(elements, children, pPrIdx, excludedSpans).find(
      (c) => elements[c].name === "w:cnfStyle",
    );
    if (pCnfIdx !== undefined) return parseCnfStyleElement(docXml, elements[pCnfIdx]);
  }
  const tcPrIdx = activeChildrenOf(elements, children, tcIdx, excludedSpans).find(
    (c) => elements[c].name === "w:tcPr",
  );
  if (tcPrIdx !== undefined) {
    const tcCnfIdx = activeChildrenOf(elements, children, tcPrIdx, excludedSpans).find(
      (c) => elements[c].name === "w:cnfStyle",
    );
    if (tcCnfIdx !== undefined) return parseCnfStyleElement(docXml, elements[tcCnfIdx]);
  }

  const tblMeta = getCachedTableMeta(docXml, elements, children, tblIdx, excludedSpans, cache);
  const rowMeta = getCachedRowMeta(docXml, elements, children, trIdx, excludedSpans, cache);
  let look: TableLookFlags = {
    firstRow: false,
    lastRow: false,
    firstCol: false,
    lastCol: false,
    noHBand: false,
    noVBand: false,
  };
  let rowBandSize = 1;
  let colBandSize = 1;
  for (const style of tableChain) {
    const extra = visibility.tableExtrasByStyleId.get(style.id);
    if (!extra) continue;
    if (extra.tblLook) look = extra.tblLook;
    if (extra.rowBandSize !== undefined) rowBandSize = extra.rowBandSize;
    if (extra.colBandSize !== undefined) colBandSize = extra.colBandSize;
  }
  if (tblMeta.tblLook) look = tblMeta.tblLook;
  if (tblMeta.rowBandSize !== undefined) rowBandSize = tblMeta.rowBandSize;
  if (tblMeta.colBandSize !== undefined) colBandSize = tblMeta.colBandSize;

  const rowIdx = tblMeta.rowIndexByTr.get(trIdx) ?? -1;
  const colIdx = rowMeta.colIndexByTc.get(tcIdx) ?? -1;
  const active = new Set<TableStyleConditionType>();
  if (rowIdx < 0 || colIdx < 0) return active;

  const trCnf = rowMeta.trCnf;
  const isFirstRow = (trCnf?.has("firstRow") ?? false) || (look.firstRow && rowIdx === 0);
  const isLastRow =
    (trCnf?.has("lastRow") ?? false) || (look.lastRow && rowIdx === tblMeta.rowCount - 1);
  const isFirstCol = look.firstCol && colIdx === 0 && rowMeta.gridBefore === 0;
  const isLastCol =
    look.lastCol && colIdx === rowMeta.colCount - 1 && rowMeta.gridAfter === 0;

  if (trCnf?.has("band1Horz")) {
    active.add("band1Horz");
  } else if (trCnf?.has("band2Horz")) {
    active.add("band2Horz");
  } else if (!look.noHBand && !isFirstRow && !isLastRow) {
    const hIdx = rowIdx - (look.firstRow ? 1 : 0);
    if (hIdx >= 0) {
      active.add(Math.floor(hIdx / rowBandSize) % 2 === 0 ? "band1Horz" : "band2Horz");
    }
  }

  if (!look.noVBand && !isFirstCol && !isLastCol) {
    const vIdx = colIdx - (look.firstCol ? 1 : 0);
    if (vIdx >= 0) {
      active.add(Math.floor(vIdx / colBandSize) % 2 === 0 ? "band1Vert" : "band2Vert");
    }
  }

  if (isFirstRow) active.add("firstRow");
  if (isLastRow) active.add("lastRow");
  if (isFirstCol) active.add("firstCol");
  if (isLastCol) active.add("lastCol");
  if (isFirstRow && isFirstCol) active.add("nwCell");
  if (isFirstRow && isLastCol) active.add("neCell");
  if (isLastRow && isFirstCol) active.add("swCell");
  if (isLastRow && isLastCol) active.add("seCell");
  return active;
}

function isEffectiveHiddenRun(
  docXml: string,
  elements: readonly ReturnType<typeof xmlElements>[number][],
  children: readonly number[][],
  runIdx: number,
  visibility: StyleVisibilityInfo,
  excludedSpans: readonly XmlSpan[] = [],
  tableCache?: TableLayoutCache,
): boolean {
  let pIdx: number | null = null;
  let tcIdx: number | null = null;
  let trIdx: number | null = null;
  let tblIdx: number | null = null;
  let cur = elements[runIdx].parent;
  while (cur !== null) {
    const name = elements[cur].name;
    if (name === "w:txbxContent") break;
    if (pIdx === null && name === "w:p") {
      pIdx = cur;
    } else if (tcIdx === null && name === "w:tc") {
      tcIdx = cur;
    } else if (tcIdx !== null && trIdx === null && name === "w:tr") {
      trIdx = cur;
    } else if (trIdx !== null && tblIdx === null && name === "w:tbl") {
      tblIdx = cur;
      break;
    }
    cur = elements[cur].parent;
  }

  let pPrIdx: number | undefined;
  let pStyleId: string | undefined;
  if (pIdx !== null) {
    pPrIdx = activeChildrenOf(elements, children, pIdx, excludedSpans).find(
      (c) => elements[c].name === "w:pPr",
    );
    if (pPrIdx !== undefined) {
      const pStyleIdx = activeChildrenOf(elements, children, pPrIdx, excludedSpans).find(
        (c) => elements[c].name === "w:pStyle",
      );
      if (pStyleIdx !== undefined) {
        pStyleId = xmlAttributes(docXml, elements[pStyleIdx]).get("w:val");
      }
    }
  }
  let rStyleId: string | undefined;
  let directVanish: boolean | undefined;
  let directWebHidden: boolean | undefined;
  for (const childIdx of activeChildrenOf(elements, children, runIdx, excludedSpans)) {
    if (elements[childIdx].name !== "w:rPr") continue;
    for (const propIdx of activeChildrenOf(elements, children, childIdx, excludedSpans)) {
      const prop = elements[propIdx];
      if (prop.name === "w:rStyle") {
        rStyleId = xmlAttributes(docXml, prop).get("w:val");
      } else if (prop.name === "w:vanish") {
        directVanish = !isOffXmlVal(xmlAttributes(docXml, prop).get("w:val"));
      } else if (prop.name === "w:webHidden") {
        directWebHidden = !isOffXmlVal(xmlAttributes(docXml, prop).get("w:val"));
      }
    }
  }

  let vanish = visibility.defaultVanish;
  let webHidden = visibility.defaultWebHidden;
  if (visibility.styles) {
    if (
      visibility.hasAnyTableVisibility &&
      tblIdx !== null &&
      trIdx !== null &&
      tcIdx !== null
    ) {
      const cache = tableCache ?? { tables: new Map(), rows: new Map() };
      const tblMeta = getCachedTableMeta(
        docXml,
        elements,
        children,
        tblIdx,
        excludedSpans,
        cache,
      );
      const tblChain = styleChain(
        visibility.styles,
        tblMeta.tblStyleId ?? visibility.defaultTable,
        "table",
      );
      if (tblChain.length > 0) {
        let tableVanish: boolean | undefined;
        let tableWebHidden: boolean | undefined;
        for (const style of tblChain) {
          const v = visibility.vanishByStyleId.get(style.id);
          if (v !== undefined) tableVanish = v;
          const wh = visibility.webHiddenByStyleId.get(style.id);
          if (wh !== undefined) tableWebHidden = wh;
          const wholeProps = visibility.tableExtrasByStyleId
            .get(style.id)
            ?.conditions.get("wholeTable");
          if (wholeProps) {
            if (wholeProps.vanish !== undefined) tableVanish = wholeProps.vanish;
            if (wholeProps.webHidden !== undefined) tableWebHidden = wholeProps.webHidden;
          }
        }
        const hasCellConds = tblChain.some((style) => {
          const conds = visibility.tableExtrasByStyleId.get(style.id)?.conditions;
          if (!conds || conds.size === 0) return false;
          return conds.size > 1 || !conds.has("wholeTable");
        });
        if (hasCellConds) {
          const activeConds = activeTableConditionsForCell(
            docXml,
            elements,
            children,
            pPrIdx,
            tcIdx,
            trIdx,
            tblIdx,
            tblChain,
            visibility,
            excludedSpans,
            cache,
          );
          for (const cond of TABLE_CELL_CONDITION_ORDER) {
            if (!activeConds.has(cond)) continue;
            let condVanish: boolean | undefined;
            let condWebHidden: boolean | undefined;
            for (const style of tblChain) {
              const condProps = visibility.tableExtrasByStyleId
                .get(style.id)
                ?.conditions.get(cond);
              if (!condProps) continue;
              if (condProps.vanish !== undefined) condVanish = condProps.vanish;
              if (condProps.webHidden !== undefined) condWebHidden = condProps.webHidden;
            }
            if (condVanish !== undefined) tableVanish = condVanish;
            if (condWebHidden !== undefined) tableWebHidden = condWebHidden;
          }
        }
        if (tableVanish !== undefined) vanish = tableVanish;
        if (tableWebHidden !== undefined) webHidden = tableWebHidden;
      }
    }

    // Per MS-OI29500 (Word paragraph/table style assignment semantics) and conservative
    // cross-consumer C17 visibility: any style layer setting <w:vanish/> keeps the run
    // hidden unless a higher-precedence style layer or direct <w:rPr> explicitly turns it
    // off with <w:vanish w:val="0|false|off"/> (never XOR-unhiding stacked <w:vanish/>).
    const chain = [
      ...styleChain(
        visibility.styles,
        pStyleId ?? visibility.styles.defaultParagraph,
        "paragraph",
      ),
      ...styleChain(
        visibility.styles,
        rStyleId ?? visibility.styles.defaultCharacter,
        "character",
      ),
    ];
    for (const style of chain) {
      const v = visibility.vanishByStyleId.get(style.id);
      if (v !== undefined) vanish = v;
      const wh = visibility.webHiddenByStyleId.get(style.id);
      if (wh !== undefined) webHidden = wh;
    }
  }
  if (directVanish !== undefined) vanish = directVanish;
  if (directWebHidden !== undefined) webHidden = directWebHidden;
  return vanish || webHidden;
}

function isHiddenMediaContainer(
  docXml: string,
  elements: readonly ReturnType<typeof xmlElements>[number][],
  children: readonly number[][],
  idx: number,
  excludedSpans: readonly XmlSpan[] = [],
): boolean {
  const el = elements[idx];
  const attrs = xmlAttributes(docXml, el);
  const cssStyle = attrs.get("style");
  if (
    cssStyle &&
    /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:;|$)/i.test(
      cssStyle,
    )
  ) {
    return true;
  }
  for (const childIdx of activeChildrenOf(elements, children, idx, excludedSpans)) {
    const childLocal = elements[childIdx].name.split(":").pop() ?? "";
    if (childLocal === "docPr" || childLocal === "cNvPr") {
      if (isTrueXmlAttr(xmlAttributes(docXml, elements[childIdx]).get("hidden"))) {
        return true;
      }
    } else if (childLocal.startsWith("nv") && childLocal.endsWith("Pr")) {
      for (const grandIdx of activeChildrenOf(elements, children, childIdx, excludedSpans)) {
        const grandLocal = elements[grandIdx].name.split(":").pop() ?? "";
        if (
          grandLocal === "cNvPr" &&
          isTrueXmlAttr(xmlAttributes(docXml, elements[grandIdx]).get("hidden"))
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

interface ActiveTextFragment {
  start: number;
  end: number;
  text: string;
}

function isDeletedTableRow(
  elements: readonly ReturnType<typeof xmlElements>[number][],
  children: readonly number[][],
  trIdx: number,
  excludedSpans: readonly XmlSpan[],
): boolean {
  for (const childIdx of activeChildrenOf(elements, children, trIdx, excludedSpans)) {
    const child = elements[childIdx];
    if (child.name !== "w:trPr") continue;
    for (const propIdx of activeChildrenOf(elements, children, childIdx, excludedSpans)) {
      const prop = elements[propIdx];
      if (prop.name === "w:del" || prop.name === "w:moveFrom") return true;
    }
  }
  return false;
}

function paragraphMarkState(
  docXml: string,
  elements: readonly ReturnType<typeof xmlElements>[number][],
  children: readonly number[][],
  pIdx: number,
  excludedSpans: readonly XmlSpan[],
): "normal" | "deleted" | "hidden" {
  let hidden = false;
  for (const childIdx of activeChildrenOf(elements, children, pIdx, excludedSpans)) {
    const child = elements[childIdx];
    if (child.name !== "w:pPr") continue;
    for (const pPrChildIdx of activeChildrenOf(elements, children, childIdx, excludedSpans)) {
      const pPrChild = elements[pPrChildIdx];
      if (pPrChild.name !== "w:rPr") continue;
      for (const rPrChildIdx of activeChildrenOf(elements, children, pPrChildIdx, excludedSpans)) {
        const rPrChild = elements[rPrChildIdx];
        if (rPrChild.name === "w:del" || rPrChild.name === "w:moveFrom") {
          return "deleted";
        }
        if (
          (rPrChild.name === "w:vanish" || rPrChild.name === "w:webHidden") &&
          !isOffXmlVal(xmlAttributes(docXml, rPrChild).get("w:val"))
        ) {
          hidden = true;
        }
      }
    }
  }
  return hidden ? "hidden" : "normal";
}

function visibleBodyNonTocParagraphInfos(
  docXml: string,
  visibility: StyleVisibilityInfo,
  excludedSpans: readonly XmlSpan[] = [],
  outActiveTextFragments?: ActiveTextFragment[],
  outProjectionErrors?: string[],
): VisibleBodyParagraphInfo[] {
  const elements = xmlElements(docXml);
  const children = elementChildren(elements);
  const bodyIndex = elements.findIndex((el) => el.name === "w:body");
  if (bodyIndex < 0) return [];
  const styles = visibility.styles;

  const isSkippedContainer = (name: string): boolean =>
    name === "w:del" ||
    name === "w:moveFrom" ||
    name === "w:txbxContent" ||
    name === "w:drawing" ||
    name === "w:pict" ||
    name === "w:object" ||
    name.endsWith("PrChange");

  const tableCache: TableLayoutCache = { tables: new Map(), rows: new Map() };
  const isHiddenRun = (runIdx: number): boolean =>
    isEffectiveHiddenRun(
      docXml,
      elements,
      children,
      runIdx,
      visibility,
      excludedSpans,
      tableCache,
    );

  const paragraphs: VisibleBodyParagraphInfo[] = [];
  const fieldStack: Array<{ instr: string; separated: boolean; isToc: boolean }> =
    [];
  const insideTocField = (): boolean => fieldStack.some((frame) => frame.isToc);
  let currentParaParts: string[] | null = null;
  let fldSimpleTocDepth = 0;
  let tableDepth = 0;

  interface PendingMergedPara {
    text: string;
    start: number;
    end: number;
    headingLevel: number;
    inTable: boolean;
    strictDeleted: boolean;
  }
  const mergeStack: Array<PendingMergedPara | null> = [null];
  const flushDanglingMerge = (reason: string): void => {
    const topIdx = mergeStack.length - 1;
    const pending = mergeStack[topIdx];
    if (!pending) return;
    mergeStack[topIdx] = null;
    if (pending.strictDeleted) {
      outProjectionErrors?.push(reason);
      return;
    }
    if (pending.text.length > 0) {
      paragraphs.push({
        text: pending.text,
        start: pending.start,
        end: pending.end,
        headingLevel: pending.headingLevel,
        inTable: pending.inTable,
      });
    }
  };

  const visit = (idx: number, inRun: boolean, runHidden: boolean): void => {
    const el = elements[idx];
    if (isSkippedContainer(el.name)) return;
    if (isSpanExcluded(el.start, el.end, excludedSpans)) return;

    if (el.name === "w:tbl") {
      flushDanglingMerge("存在跨表格的段落标记修订删除（w:pPr/w:rPr/w:del），无法可靠投影章节边界");
      tableDepth++;
      for (const childIdx of children[idx]) {
        visit(childIdx, false, false);
      }
      tableDepth--;
      return;
    }

    if (el.name === "w:tr") {
      if (isDeletedTableRow(elements, children, idx, excludedSpans)) return;
      for (const childIdx of children[idx]) {
        visit(childIdx, false, false);
      }
      return;
    }

    if (el.name === "w:tc") {
      mergeStack.push(null);
      for (const childIdx of children[idx]) {
        visit(childIdx, false, false);
      }
      flushDanglingMerge("单元格末尾存在悬空的段落标记修订删除（w:pPr/w:rPr/w:del），无法可靠投影章节边界");
      mergeStack.pop();
      return;
    }

    if (el.name === "w:p") {
      const prevParts = currentParaParts;
      currentParaParts = [];
      for (const childIdx of children[idx]) {
        visit(childIdx, false, false);
      }
      const text = currentParaParts.join("");
      const markState = paragraphMarkState(docXml, elements, children, idx, excludedSpans);
      const headingLevel = paragraphHeadingLevel(
        docXml,
        elements,
        children,
        idx,
        styles,
        excludedSpans,
      );
      const topIdx = mergeStack.length - 1;
      const pending = mergeStack[topIdx];
      const mergedText = (pending ? pending.text : "") + text;
      const mergedStart = pending ? pending.start : el.start;
      const mergedInTable = pending ? pending.inTable : tableDepth > 0;
      const mergedStrictDeleted =
        (pending?.strictDeleted ?? false) || markState === "deleted";
      if (markState === "deleted" || markState === "hidden") {
        mergeStack[topIdx] = {
          text: mergedText,
          start: mergedStart,
          end: el.end,
          headingLevel,
          inTable: mergedInTable,
          strictDeleted: mergedStrictDeleted,
        };
      } else {
        mergeStack[topIdx] = null;
        if (mergedText.length > 0) {
          paragraphs.push({
            text: mergedText,
            start: mergedStart,
            end: el.end,
            headingLevel,
            inTable: mergedInTable,
          });
        }
      }
      currentParaParts = prevParts;
      return;
    }

    if (el.name === "w:fldSimple") {
      const instr = xmlAttributes(docXml, el).get("w:instr") ?? "";
      const isToc = /\bTOC\b/i.test(instr);
      if (isToc) fldSimpleTocDepth++;
      for (const childIdx of children[idx]) {
        visit(childIdx, inRun, runHidden);
      }
      if (isToc) fldSimpleTocDepth--;
      return;
    }

    if (el.name === "w:r") {
      const hidden = isHiddenRun(idx);
      for (const childIdx of children[idx]) {
        visit(childIdx, true, hidden);
      }
      return;
    }

    if (el.name === "w:fldChar" && inRun) {
      const charType = xmlAttributes(docXml, el).get("w:fldCharType");
      if (charType === "begin") {
        fieldStack.push({ instr: "", separated: false, isToc: false });
      } else if (charType === "separate") {
        if (fieldStack.length > 0) {
          fieldStack[fieldStack.length - 1].separated = true;
        }
      } else if (charType === "end") {
        fieldStack.pop();
      }
      return;
    }

    if (el.name === "w:instrText" && inRun) {
      if (fieldStack.length > 0) {
        const top = fieldStack[fieldStack.length - 1];
        if (!top.separated) {
          top.instr += unescapeXml(docXml.slice(el.openEnd, el.closeStart));
          if (/\bTOC\b/i.test(top.instr)) {
            top.isToc = true;
          }
        }
      }
      return;
    }

    if (
      currentParaParts !== null &&
      inRun &&
      !runHidden &&
      !insideTocField() &&
      fldSimpleTocDepth === 0
    ) {
      if (el.name === "w:t") {
        const text = unescapeXml(docXml.slice(el.openEnd, el.closeStart));
        currentParaParts.push(text);
        if (outActiveTextFragments && text.length > 0) {
          outActiveTextFragments.push({ start: el.start, end: el.end, text });
        }
        return;
      }
      if (el.name === "w:tab") {
        currentParaParts.push("\t");
        if (outActiveTextFragments) {
          outActiveTextFragments.push({ start: el.start, end: el.end, text: "\t" });
        }
        return;
      }
      if (el.name === "w:br" || el.name === "w:cr") {
        currentParaParts.push("\n");
        if (outActiveTextFragments) {
          outActiveTextFragments.push({ start: el.start, end: el.end, text: "\n" });
        }
        return;
      }
    }

    for (const childIdx of children[idx]) {
      visit(childIdx, inRun, runHidden);
    }
  };

  for (const childIdx of children[bodyIndex]) {
    visit(childIdx, false, false);
  }
  flushDanglingMerge("文档末尾存在悬空的段落标记修订删除（w:pPr/w:rPr/w:del），无法可靠投影章节边界");
  return paragraphs;
}

/**
 * Extract visible body and table-cell paragraph texts from word/document.xml,
 * excluding TOC field caches (begin..end whose instruction matches /\bTOC\b/i, and w:fldSimple),
 * tracked deletions/moves (w:del, w:moveFrom, *PrChange), textboxes (w:txbxContent),
 * and runs with active w:vanish or w:webHidden.
 */
export function visibleBodyNonTocParagraphs(docXml: string): string[] {
  const result = alternateContentProfiles(docXml);
  const excludedSpans =
    result.kind === "ok" ? result.profiles[0].excludedSpans : [];
  const emptyVisibility: StyleVisibilityInfo = {
    styles: null,
    defaultVanish: false,
    defaultWebHidden: false,
    vanishByStyleId: new Map(),
    webHiddenByStyleId: new Map(),
    tableExtrasByStyleId: new Map(),
    hasAnyTableVisibility: false,
  };
  return visibleBodyNonTocParagraphInfos(
    docXml,
    emptyVisibility,
    excludedSpans,
  ).map((item) => item.text);
}

interface ActiveMediaItem {
  start: number;
  end: number;
  hash: string;
}

function resolveStylesXml(parts: ReadonlyMap<string, Uint8Array>): string {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const relsBytes = parts.get("word/_rels/document.xml.rels");
  if (relsBytes) {
    const relsXml = decoder.decode(relsBytes);
    for (const el of xmlElements(relsXml)) {
      if (el.name.split(":").pop() !== "Relationship") continue;
      const attrs = xmlAttributes(relsXml, el);
      if (attrs.get("TargetMode") === "External") continue;
      const type = attrs.get("Type") ?? "";
      const target = attrs.get("Target");
      if (type.endsWith("/relationships/styles") && target) {
        const resolved = resolveRelationshipTarget("word/", target);
        const bytes = parts.get(resolved);
        if (!bytes) {
          throw new Error(`缺失样式部件：${resolved}`);
        }
        return decoder.decode(bytes);
      }
    }
  }
  const fallback = parts.get("word/styles.xml");
  return fallback ? decoder.decode(fallback) : "";
}

function activeDocumentMediaItems(
  parts: ReadonlyMap<string, Uint8Array>,
  visibility: StyleVisibilityInfo,
  excludedSpans: readonly XmlSpan[] = [],
): ActiveMediaItem[] {
  const items: ActiveMediaItem[] = [];
  const docBytes = parts.get("word/document.xml");
  if (!docBytes) return items;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const docXml = decoder.decode(docBytes);
  const relsBytes = parts.get("word/_rels/document.xml.rels");
  if (!relsBytes) return items;
  const relsXml = decoder.decode(relsBytes);
  const relTargets = new Map<string, string>();
  for (const element of xmlElements(relsXml)) {
    if (element.name.split(":").pop() !== "Relationship") continue;
    const attrs = xmlAttributes(relsXml, element);
    if (attrs.get("TargetMode") === "External") continue;
    const id = attrs.get("Id");
    const target = attrs.get("Target");
    if (!id || !target) continue;
    try {
      relTargets.set(id, resolveRelationshipTarget("word/", target));
    } catch {
      /* Invalid relationship targets are already caught by validatePackageStructure. */
    }
  }

  const elements = xmlElements(docXml);
  const children = elementChildren(elements);
  const hashByTargetPath = new Map<string, string>();
  const resolveMediaHash = (relId: string | undefined): string | undefined => {
    if (!relId) return undefined;
    const targetPath = relTargets.get(relId);
    if (!targetPath) return undefined;
    const cached = hashByTargetPath.get(targetPath);
    if (cached !== undefined) return cached;
    const mediaBytes = parts.get(targetPath);
    if (!mediaBytes || mediaBytes.length === 0) return undefined;
    const hash = sha256Hex(mediaBytes);
    hashByTargetPath.set(targetPath, hash);
    return hash;
  };

  const mediaTableCache: TableLayoutCache = { tables: new Map(), rows: new Map() };
  const collectMedia = (idx: number): void => {
    const el = elements[idx];
    if (
      el.name === "w:del" ||
      el.name === "w:moveFrom" ||
      el.name.endsWith("PrChange")
    ) {
      return;
    }
    if (isSpanExcluded(el.start, el.end, excludedSpans)) return;
    if (el.name === "w:tr" && isDeletedTableRow(elements, children, idx, excludedSpans)) {
      return;
    }
    if (
      el.name === "w:r" &&
      isEffectiveHiddenRun(
        docXml,
        elements,
        children,
        idx,
        visibility,
        excludedSpans,
        mediaTableCache,
      )
    ) {
      return;
    }
    if (isHiddenMediaContainer(docXml, elements, children, idx, excludedSpans)) return;

    const local = el.name.split(":").pop();
    if (local === "blip") {
      const hash = resolveMediaHash(xmlAttributes(docXml, el).get("r:embed"));
      if (hash) items.push({ start: el.start, end: el.end, hash });
    } else if (local === "imagedata") {
      const attrs = xmlAttributes(docXml, el);
      const hash = resolveMediaHash(attrs.get("r:id") ?? attrs.get("o:relid"));
      if (hash) items.push({ start: el.start, end: el.end, hash });
    }
    for (const childIdx of children[idx]) {
      collectMedia(childIdx);
    }
  };

  for (let i = 0; i < elements.length; i++) {
    if (elements[i].parent === null) {
      collectMedia(i);
    }
  }
  return items;
}

/** Deterministic C17 consistency check against outline.json, active fills/bookmarks and active embedded media. */
export async function checkOutlineConsistency(input: {
  outlineState: OutlineState;
  confirmationStatus: OutlineConfirmationStatus;
  workflowMode?: WorkflowMode;
  drafts: ReadonlyMap<string, Uint8Array>;
  ledger: BidLedger;
  kbRecordHasFiles?: ReadonlyMap<string, boolean>;
  kbMaterialIds?: ReadonlySet<string>;
  kbRecordImageHashes?: ReadonlyMap<string, readonly string[]>;
  kbRecordMediaStates?: ReadonlyMap<string, OutlineKbMediaState>;
  materialStates?: ReadonlyMap<string, OutlineMaterialState>;
}): Promise<OutlineConsistencyIssue[]> {
  const { outlineState, confirmationStatus, workflowMode, drafts, ledger } = input;
  if (outlineState.kind === "missing") return [];
  if (outlineState.kind === "error") {
    return [
      {
        kind: "corrupt_outline",
        reason: `编制大纲 outline.json 损坏或格式无效：${outlineState.reason}`,
        suggestion: "请在工作台大纲编辑器修复或由 AI 重新保存有效的编制大纲。",
      },
    ];
  }

  const issues: OutlineConsistencyIssue[] = [];
  const outline = outlineState.outline;
  const needsConfirmation =
    confirmationStatus === "stale" ||
    (workflowMode === "outline_first" && confirmationStatus !== "confirmed");
  if (needsConfirmation) {
    issues.push({
      kind: "outline_unconfirmed",
      reason:
        confirmationStatus === "stale"
          ? "编制大纲、知识库或截标日在确认后发生变更，需要重新人工确认"
          : "当前为先审大纲模式，编制大纲尚未经人工确认",
      suggestion: "请在右侧栏或全宽大纲编辑器核对大纲并点击确认。",
    });
  }

  const nodesByVolume = new Map<string, OutlineNode[]>();
  const excludedNodesByVolume = new Map<string, OutlineNode[]>();
  const allNodesByVolume = new Map<string, OutlineNode[]>();
  for (const node of outline.nodes) {
    const allList = allNodesByVolume.get(node.volume) ?? [];
    allList.push(node);
    allNodesByVolume.set(node.volume, allList);
    if (!node.included) {
      const exList = excludedNodesByVolume.get(node.volume) ?? [];
      exList.push(node);
      excludedNodesByVolume.set(node.volume, exList);
      continue;
    }
    const list = nodesByVolume.get(node.volume) ?? [];
    list.push(node);
    nodesByVolume.set(node.volume, list);
  }

  for (const [volumeName, nodes] of nodesByVolume) {
    const draftBytes = drafts.get(volumeName);
    if (!draftBytes) {
      issues.push({
        kind: "missing_volume",
        draft: volumeName,
        title: volumeName,
        reason: `已规划分册「${volumeName}」尚未创建草稿`,
        suggestion: `请按确认大纲调用 seal_doc_extract 创建分册「${volumeName}」。`,
      });
      continue;
    }

    let parts: Map<string, Uint8Array>;
    try {
      parts = await validatePackageStructure(draftBytes);
    } catch (error) {
      issues.push({
        kind: "corrupt_draft",
        draft: volumeName,
        title: volumeName,
        reason: `分册「${volumeName}」结构损坏，无法核对大纲一致性：${error instanceof Error ? error.message : String(error)}`,
        suggestion: "请修复分册文档结构后重新检查。",
      });
      continue;
    }

    const decoder = new TextDecoder("utf-8", { fatal: true });
    const docXml = decoder.decode(parts.get("word/document.xml")!);
    let stylesXml: string;
    try {
      stylesXml = resolveStylesXml(parts);
    } catch (error) {
      issues.push({
        kind: "corrupt_draft",
        draft: volumeName,
        title: volumeName,
        reason: `分册「${volumeName}」样式部件不可读，无法核验大纲与证据可见性：${error instanceof Error ? error.message : String(error)}`,
        suggestion: "请修复分册样式定义后重新检查。",
      });
      continue;
    }
    const activeRangeByName = new Map<string, SealRange>();
    try {
      for (const range of sealRanges(docXml)) {
        activeRangeByName.set(range.name, range);
      }
    } catch {
      /* Malformed bookmarks are also flagged by C10; leave activeRangeByName empty so missing evidence is caught conservatively. */
    }

    // Precompute parent->children adjacency (in outline preorder) and transitive descendants.
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const childrenByParentId = new Map<string | null, OutlineNode[]>();
    const descendantsByNodeId = new Map<string, Set<string>>();
    for (const node of nodes) {
      descendantsByNodeId.set(node.id, new Set([node.id]));
      const parentKey =
        node.parentId && nodeById.has(node.parentId) ? node.parentId : null;
      const siblings = childrenByParentId.get(parentKey) ?? [];
      siblings.push(node);
      childrenByParentId.set(parentKey, siblings);
    }
    for (const node of nodes) {
      const seenAncestors = new Set<string>([node.id]);
      let parentId = node.parentId;
      while (parentId && nodeById.has(parentId) && !seenAncestors.has(parentId)) {
        seenAncestors.add(parentId);
        descendantsByNodeId.get(parentId)!.add(node.id);
        parentId = nodeById.get(parentId)!.parentId;
      }
    }
    const excludedVolumeNodes = excludedNodesByVolume.get(volumeName) ?? [];
    const allVolumeNodeById = new Map(
      (allNodesByVolume.get(volumeName) ?? []).map((n) => [n.id, n]),
    );
    const excludedAncestorsById = new Map<string, Set<string>>();
    for (const exNode of excludedVolumeNodes) {
      const ancestors = new Set<string>();
      const seen = new Set<string>([exNode.id]);
      let parentId = exNode.parentId;
      while (
        parentId &&
        allVolumeNodeById.has(parentId) &&
        !seen.has(parentId)
      ) {
        seen.add(parentId);
        ancestors.add(parentId);
        parentId = allVolumeNodeById.get(parentId)!.parentId;
      }
      excludedAncestorsById.set(exNode.id, ancestors);
    }

    const profilesResult = alternateContentProfiles(docXml, stylesXml);
    if (profilesResult.kind === "error") {
      issues.push({
        kind: "corrupt_draft",
        draft: volumeName,
        title: volumeName,
        reason: `分册「${volumeName}」无法完成大纲一致性核验：${profilesResult.reason}`,
        suggestion:
          "请清理或扁平化分册中复杂的 mc:AlternateContent 兼容分支后重新检查。",
      });
      continue;
    }
    const profiles = profilesResult.profiles;
    const seenVolumeIssueKeys = new Set<string>();
    const pushVolumeIssue = (issue: OutlineConsistencyIssue): void => {
      const key = `${issue.kind}|${issue.draft ?? ""}|${issue.nodeId ?? ""}|${issue.source ?? ""}|${issue.ref ?? ""}`;
      if (seenVolumeIssueKeys.has(key)) return;
      seenVolumeIssueKeys.add(key);
      issues.push(issue);
    };

    const docVisibleTokens = visibleTextPositions(docXml);
    const visibilityByProjectedStyles = new Map<string, StyleVisibilityResult>();
    for (const profile of profiles) {
      let visibilityResult = visibilityByProjectedStyles.get(profile.projectedStylesXml);
      if (!visibilityResult) {
        visibilityResult = parseStyleVisibility(profile.projectedStylesXml);
        visibilityByProjectedStyles.set(profile.projectedStylesXml, visibilityResult);
      }
      if (visibilityResult.kind === "error") {
        pushVolumeIssue({
          kind: "corrupt_draft",
          draft: volumeName,
          title: volumeName,
          reason: `分册「${volumeName}」样式表损坏或存在继承循环，无法可靠核验大纲与证据可见性：${visibilityResult.reason}`,
          suggestion: "请修复分册样式定义后重新检查。",
        });
        continue;
      }
      const styleVisibility = visibilityResult.visibility;
      const excludedSpans = profile.excludedSpans;
      const activeTextFragments: ActiveTextFragment[] = [];
      const projectionErrors: string[] = [];
      const paragraphInfos = visibleBodyNonTocParagraphInfos(
        docXml,
        styleVisibility,
        excludedSpans,
        activeTextFragments,
        projectionErrors,
      );
      if (projectionErrors.length > 0) {
        pushVolumeIssue({
          kind: "corrupt_draft",
          draft: volumeName,
          title: volumeName,
          reason: `分册「${volumeName}」无法可靠投影大纲章节结构：${projectionErrors[0]}`,
          suggestion: "请先接受或清理文档中的段落标记修订后再重新检查。",
        });
        continue;
      }
      const activeFragmentByStart = new Map<number, ActiveTextFragment>();
      for (const frag of activeTextFragments) {
        activeFragmentByStart.set(frag.start, frag);
      }
      const sourceTextSatisfiedInRange = (
        range: SealRange,
        src: FactSource,
        inSection?: (pos: number) => boolean,
      ): boolean => {
        const expected = displayedFactValue(src).replace(/\r\n/g, "\n");
        if (!expected.trim()) return false;
        if (src.rangeSpan) {
          const { start: relStart, end: relEnd } = src.rangeSpan;
          if (
            relStart < 0 ||
            relEnd <= relStart ||
            range.start + relEnd > range.end
          ) {
            return false;
          }
          const absStart = range.start + relStart;
          const absEnd = range.start + relEnd;
          let collected = "";
          for (const tok of docVisibleTokens) {
            if (tok.end <= absStart) continue;
            if (tok.start >= absEnd) break;
            if (
              tok.element.start < range.startXml ||
              tok.element.end > range.endXml
            ) {
              return false;
            }
            if (inSection && !inSection(tok.element.start)) return false;
            if (!activeFragmentByStart.has(tok.element.start)) return false;
            const sliceStart = Math.max(0, absStart - tok.start);
            const sliceEnd = Math.min(tok.text.length, absEnd - tok.start);
            collected += tok.text.slice(sliceStart, sliceEnd);
          }
          return collected.replace(/\r\n/g, "\n") === expected;
        }
        // Legacy / unspanned bookmark: must stay wholly within the target section
        // (cannot claim an aggregate cross-section bookmark without an exact sub-span).
        if (
          inSection &&
          (!inSection(range.startXml) ||
            !inSection(Math.max(range.startXml, range.endXml - 1)))
        ) {
          return false;
        }
        let visibleText = "";
        for (const frag of activeTextFragments) {
          if (frag.start < range.startXml || frag.end > range.endXml) continue;
          if (inSection && !inSection(frag.start)) continue;
          visibleText += frag.text;
        }
        return visibleText.replace(/\r\n/g, "\n").includes(expected);
      };
      const activeMediaItems = activeDocumentMediaItems(
        parts,
        styleVisibility,
        excludedSpans,
      );
      const activeVolumeFills = ledger.fills.filter((fill) => {
        if (
          !fill ||
          typeof fill !== "object" ||
          fill.draft !== volumeName ||
          fill.status === "removed"
        ) {
          return false;
        }
        const range = activeRangeByName.get(
          fill.sealKind === "pending" ? `_Seal_P_${fill.id}` : `_Seal_F_${fill.id}`,
        );
        return (
          range !== undefined &&
          !isOffsetExcluded(range.startXml, excludedSpans) &&
          !isOffsetExcluded(range.endXml, excludedSpans)
        );
      });

    // Top-down parent-scoped tree-consistent anchor assignment:
    // 1) Each sibling group matches strictly inside its nearest matched ancestor's XML span
    //    (preventing cross-parent stealing or swapping among same-titled descendants).
    // 2) Fast O(N) path uses rank-ordered maximum bipartite matching + rank-preserving monotonic
    //    order restoration; when any matchable subtree node is missed or rank/order is suboptimal
    //    among contested siblings, a bounded subtree-aware solver maximizes the lexicographic
    //    objective (totalMatched DESC, totalRank ASC, totalInversions ASC, pIdxSum ASC) while
    //    enforcing the maximality invariant (no unmatched sibling may leave a candidate unused).
    const nativeHeadings: Array<{ para: VisibleBodyParagraphInfo; pIdx: number }> =
      [];
    for (let pIdx = 0; pIdx < paragraphInfos.length; pIdx++) {
      if (paragraphInfos[pIdx].headingLevel > 0) {
        nativeHeadings.push({ para: paragraphInfos[pIdx], pIdx });
      }
    }
    interface CandidateParagraph {
      pIdx: number;
      rank: number;
    }
    const nodeCandidatesById = new Map<string, readonly CandidateParagraph[]>();
    for (const node of nodes) {
      const expected = node.expectedHeading?.trim()
        ? node.expectedHeading
        : node.title;
      const fullNormalized = normalizeHeadingRaw(expected);
      const variants = headingVariants(expected);
      const scored: CandidateParagraph[] = [];
      if (variants.length > 0) {
        for (let pIdx = 0; pIdx < paragraphInfos.length; pIdx++) {
          const para = paragraphInfos[pIdx];
          if (!headingMatchesParagraph(para, variants)) continue;
          const levelTier =
            para.headingLevel === node.level
              ? 0
              : para.headingLevel > 0
                ? 1
                : 2;
          const exactPenalty =
            normalizeHeadingRaw(para.text) === fullNormalized ? 0 : 1;
          scored.push({ pIdx, rank: levelTier * 2 + exactPenalty });
        }
      }
      scored.sort((a, b) => a.rank - b.rank || a.pIdx - b.pIdx);
      nodeCandidatesById.set(node.id, scored);
    }
    const strictDescendantParasByNodeId = new Map<string, Set<number>>();
    for (const node of nodes) {
      const set = new Set<number>();
      for (const descId of descendantsByNodeId.get(node.id) ?? []) {
        if (descId === node.id) continue;
        for (const cand of nodeCandidatesById.get(descId) ?? []) {
          set.add(cand.pIdx);
        }
      }
      strictDescendantParasByNodeId.set(node.id, set);
    }

    const excludedBoundaryVariants = excludedVolumeNodes.map((exNode) => ({
      nodeId: exNode.id,
      variants: headingVariants(
        exNode.expectedHeading?.trim() ? exNode.expectedHeading : exNode.title,
      ),
    }));
    const excludedBoundaryParas: Array<{ nodeId: string; pIdx: number; start: number }> = [];
    for (let pIdx = 0; pIdx < paragraphInfos.length; pIdx++) {
      const para = paragraphInfos[pIdx];
      for (const ex of excludedBoundaryVariants) {
        if (ex.variants.length > 0 && headingMatchesParagraph(para, ex.variants)) {
          excludedBoundaryParas.push({ nodeId: ex.nodeId, pIdx, start: para.start });
        }
      }
    }

    const computeSpanEnd = (
      node: OutlineNode,
      anchor: VisibleBodyParagraphInfo,
      upperBound: number,
      siblingStarts: readonly { nodeId: string; start: number }[],
      claimedNodeByStart: ReadonlyMap<number, string>,
      allowUnclaimedDescendantCandidates: boolean,
    ): number => {
      const descendants = descendantsByNodeId.get(node.id) ?? new Set([node.id]);
      const isDescendantOrSelf = (candidateId: string): boolean =>
        descendants.has(candidateId) ||
        excludedAncestorsById.get(candidateId)?.has(node.id) === true;
      const descendantCandParas = strictDescendantParasByNodeId.get(node.id);
      const nextSiblingBoundary = siblingStarts.find(
        (candidate) =>
          candidate.start > anchor.start && !isDescendantOrSelf(candidate.nodeId),
      );
      const effectiveLevel =
        anchor.headingLevel > 0 ? anchor.headingLevel : Math.max(1, node.level);
      const nextNativeBoundary = nativeHeadings.find(({ para: heading, pIdx }) => {
        if (heading.start <= anchor.start || heading.start >= upperBound) {
          return false;
        }
        if (heading.headingLevel > effectiveLevel) return false;
        const ownerId = claimedNodeByStart.get(heading.start);
        if (ownerId !== undefined) {
          return !isDescendantOrSelf(ownerId);
        }
        if (
          allowUnclaimedDescendantCandidates &&
          descendantCandParas?.has(pIdx)
        ) {
          return false;
        }
        return true;
      });
      const nextExcludedBoundary = excludedBoundaryParas.find(({ nodeId: exNodeId, pIdx, start }) => {
        if (start <= anchor.start || start >= upperBound) return false;
        if (isDescendantOrSelf(exNodeId)) return false;
        const ownerId = claimedNodeByStart.get(start);
        if (ownerId !== undefined) {
          return !isDescendantOrSelf(ownerId);
        }
        if (
          allowUnclaimedDescendantCandidates &&
          descendantCandParas?.has(pIdx)
        ) {
          return false;
        }
        return true;
      });
      return Math.min(
        upperBound,
        nextSiblingBoundary ? nextSiblingBoundary.start : Number.POSITIVE_INFINITY,
        nextNativeBoundary
          ? nextNativeBoundary.para.start
          : Number.POSITIVE_INFINITY,
        nextExcludedBoundary ? nextExcludedBoundary.start : Number.POSITIVE_INFINITY,
      );
    };

    interface GroupSolution {
      totalMatched: number;
      totalRank: number;
      totalInversions: number;
      pIdxSum: number;
      searchUncertain: boolean;
      assignedParaByNodeId: Map<string, number>;
      sectionSpanByNodeId: Map<string, { start: number; end: number }>;
    }
    const isBetterSolution = (a: GroupSolution, b: GroupSolution): boolean => {
      if (a.totalMatched !== b.totalMatched) return a.totalMatched > b.totalMatched;
      if (a.totalRank !== b.totalRank) return a.totalRank < b.totalRank;
      if (a.totalInversions !== b.totalInversions) {
        return a.totalInversions < b.totalInversions;
      }
      return a.pIdxSum < b.pIdxSum;
    };

    const solveSiblingGroup = (
      group: readonly OutlineNode[],
      scope: { start: number; end: number },
      usedParas: ReadonlySet<number>,
      claimedNodeByStart: ReadonlyMap<number, string>,
      searchBudget: { remaining: number },
    ): GroupSolution => {
      if (group.length === 0) {
        return {
          totalMatched: 0,
          totalRank: 0,
          totalInversions: 0,
          pIdxSum: 0,
          searchUncertain: false,
          assignedParaByNodeId: new Map(),
          sectionSpanByNodeId: new Map(),
        };
      }
      const candidatesByMember = group.map((node) =>
        (nodeCandidatesById.get(node.id) ?? []).filter((cand) => {
          if (usedParas.has(cand.pIdx)) return false;
          const start = paragraphInfos[cand.pIdx].start;
          return start > scope.start && start < scope.end;
        }),
      );
      const rankByMemberAndPara = candidatesByMember.map(
        (list) => new Map(list.map((c) => [c.pIdx, c.rank])),
      );
      const candidateSetByMember = candidatesByMember.map(
        (list) => new Set(list.map((c) => c.pIdx)),
      );

      // Step 1: Fast baseline via unoccupied-first maximum bipartite matching + monotonic swap.
      const matchedMemberByPara = new Map<number, number>();
      const tryAssignMember = (
        memberIdx: number,
        visitedParas: Set<number>,
      ): boolean => {
        for (const cand of candidatesByMember[memberIdx]) {
          if (visitedParas.has(cand.pIdx)) continue;
          if (!matchedMemberByPara.has(cand.pIdx)) {
            visitedParas.add(cand.pIdx);
            matchedMemberByPara.set(cand.pIdx, memberIdx);
            return true;
          }
        }
        for (const cand of candidatesByMember[memberIdx]) {
          if (visitedParas.has(cand.pIdx)) continue;
          visitedParas.add(cand.pIdx);
          const ownerIdx = matchedMemberByPara.get(cand.pIdx);
          if (ownerIdx === undefined || tryAssignMember(ownerIdx, visitedParas)) {
            matchedMemberByPara.set(cand.pIdx, memberIdx);
            return true;
          }
        }
        return false;
      };
      for (let memberIdx = 0; memberIdx < group.length; memberIdx++) {
        tryAssignMember(memberIdx, new Set<number>());
      }
      const baselineAssigned = new Map<number, number>();
      for (const [pIdx, memberIdx] of matchedMemberByPara) {
        baselineAssigned.set(memberIdx, pIdx);
      }

      let swapped = true;
      while (swapped) {
        swapped = false;
        for (let i = 0; i < group.length; i++) {
          let pI = baselineAssigned.get(i);
          if (pI === undefined) continue;
          for (let j = i + 1; j < group.length; j++) {
            const pJ = baselineAssigned.get(j);
            if (pJ === undefined) continue;
            if (paragraphInfos[pI].start <= paragraphInfos[pJ].start) continue;
            if (
              !candidateSetByMember[i].has(pJ) ||
              !candidateSetByMember[j].has(pI)
            ) {
              continue;
            }
            const beforeRank =
              (rankByMemberAndPara[i].get(pI) ?? 99) +
              (rankByMemberAndPara[j].get(pJ) ?? 99);
            const afterRank =
              (rankByMemberAndPara[i].get(pJ) ?? 99) +
              (rankByMemberAndPara[j].get(pI) ?? 99);
            if (afterRank <= beforeRank) {
              baselineAssigned.set(i, pJ);
              baselineAssigned.set(j, pI);
              pI = pJ;
              swapped = true;
            }
          }
        }
      }

      const evaluateGroupAssignment = (
        assignedParaByMember: ReadonlyMap<number, number>,
        enforceMaximality: boolean,
      ): GroupSolution | null => {
        const localUsed = new Set<number>(usedParas);
        const localClaimedByStart = new Map<number, string>(claimedNodeByStart);
        const assignedParaByNodeId = new Map<string, number>();
        const sectionSpanByNodeId = new Map<string, { start: number; end: number }>();
        const groupClaimedStarts: Array<{ nodeId: string; start: number }> = [];
        let totalMatched = 0;
        let totalRank = 0;
        let totalInversions = 0;
        let pIdxSum = 0;
        let childUncertain = false;

        for (let i = 0; i < group.length; i++) {
          const pIdx = assignedParaByMember.get(i);
          if (pIdx === undefined) continue;
          const node = group[i];
          const anchor = paragraphInfos[pIdx];
          localUsed.add(pIdx);
          localClaimedByStart.set(anchor.start, node.id);
          assignedParaByNodeId.set(node.id, pIdx);
          groupClaimedStarts.push({ nodeId: node.id, start: anchor.start });
          totalMatched++;
          totalRank += rankByMemberAndPara[i].get(pIdx) ?? 99;
          pIdxSum += pIdx;
          for (let j = i + 1; j < group.length; j++) {
            const pJ = assignedParaByMember.get(j);
            if (pJ !== undefined && pIdx > pJ) totalInversions++;
          }
        }
        groupClaimedStarts.sort((a, b) => a.start - b.start);

        const memberOrder = [
          ...group.map((_, i) => i).filter((i) => assignedParaByMember.has(i)),
          ...group.map((_, i) => i).filter((i) => !assignedParaByMember.has(i)),
        ];
        for (const i of memberOrder) {
          const node = group[i];
          const pIdx = assignedParaByMember.get(i);
          const children = childrenByParentId.get(node.id) ?? [];
          if (pIdx === undefined) {
            if (children.length > 0) {
              const childSol = solveSiblingGroup(
                children,
                scope,
                localUsed,
                localClaimedByStart,
                searchBudget,
              );
              totalMatched += childSol.totalMatched;
              totalRank += childSol.totalRank;
              totalInversions += childSol.totalInversions;
              pIdxSum += childSol.pIdxSum;
              if (childSol.searchUncertain) childUncertain = true;
              for (const [cid, cpIdx] of childSol.assignedParaByNodeId) {
                assignedParaByNodeId.set(cid, cpIdx);
                localUsed.add(cpIdx);
                localClaimedByStart.set(paragraphInfos[cpIdx].start, cid);
              }
              for (const [cid, cspan] of childSol.sectionSpanByNodeId) {
                sectionSpanByNodeId.set(cid, cspan);
              }
            }
            continue;
          }

          const anchor = paragraphInfos[pIdx];
          let childScope = {
            start: anchor.start,
            end: computeSpanEnd(
              node,
              anchor,
              scope.end,
              groupClaimedStarts,
              localClaimedByStart,
              true,
            ),
          };
          let childSol =
            children.length > 0
              ? solveSiblingGroup(
                  children,
                  childScope,
                  localUsed,
                  localClaimedByStart,
                  searchBudget,
                )
              : null;

          // Enforce parent-child span consistency: once children are placed, re-check
          // native heading boundaries against actual claimed owners. If an unclaimed
          // peer/higher heading cuts the parent's real span before a matched descendant,
          // tighten childScope and re-solve until all matched descendants lie strictly inside.
          while (childSol) {
            const postClaimed = new Map(localClaimedByStart);
            for (const [cid, cpIdx] of childSol.assignedParaByNodeId) {
              postClaimed.set(paragraphInfos[cpIdx].start, cid);
            }
            const actualParentEnd = computeSpanEnd(
              node,
              anchor,
              childScope.end,
              groupClaimedStarts,
              postClaimed,
              false,
            );
            const hasOutOfBoundsDescendant = [
              ...childSol.assignedParaByNodeId.values(),
            ].some((cpIdx) => paragraphInfos[cpIdx].start >= actualParentEnd);
            if (!hasOutOfBoundsDescendant) {
              childScope = { start: anchor.start, end: actualParentEnd };
              for (const [cid, cspan] of childSol.sectionSpanByNodeId) {
                if (cspan.end > actualParentEnd) {
                  childSol.sectionSpanByNodeId.set(cid, {
                    start: cspan.start,
                    end: actualParentEnd,
                  });
                }
              }
              break;
            }
            childScope = { start: anchor.start, end: actualParentEnd };
            childSol = solveSiblingGroup(
              children,
              childScope,
              localUsed,
              localClaimedByStart,
              searchBudget,
            );
          }

          if (!childSol) {
            childScope = {
              start: anchor.start,
              end: computeSpanEnd(
                node,
                anchor,
                scope.end,
                groupClaimedStarts,
                localClaimedByStart,
                false,
              ),
            };
          }
          sectionSpanByNodeId.set(node.id, childScope);
          if (childSol) {
            totalMatched += childSol.totalMatched;
            totalRank += childSol.totalRank;
            totalInversions += childSol.totalInversions;
            pIdxSum += childSol.pIdxSum;
            if (childSol.searchUncertain) childUncertain = true;
            for (const [cid, cpIdx] of childSol.assignedParaByNodeId) {
              assignedParaByNodeId.set(cid, cpIdx);
              localUsed.add(cpIdx);
              localClaimedByStart.set(paragraphInfos[cpIdx].start, cid);
            }
            for (const [cid, cspan] of childSol.sectionSpanByNodeId) {
              sectionSpanByNodeId.set(cid, cspan);
            }
          }
        }

        if (enforceMaximality) {
          for (let i = 0; i < group.length; i++) {
            if (assignedParaByMember.has(i)) continue;
            for (const cand of candidatesByMember[i]) {
              if (!localUsed.has(cand.pIdx)) return null;
            }
          }
        }

        return {
          totalMatched,
          totalRank,
          totalInversions,
          pIdxSum,
          searchUncertain: childUncertain,
          assignedParaByNodeId,
          sectionSpanByNodeId,
        };
      };

      let bestSol = evaluateGroupAssignment(baselineAssigned, false)!;
      let bestAssigned: ReadonlyMap<number, number> = baselineAssigned;

      // Step 2: Compute exact pigeonhole coverage upper bound and lower-bound rank.
      let maxMatchableNodes = 0;
      let minPossibleSubtreeRank = 0;
      const distinctSubtreeParas = new Set<number>();
      for (const rootNode of group) {
        for (const descId of descendantsByNodeId.get(rootNode.id) ?? []) {
          let bestRank = Number.POSITIVE_INFINITY;
          for (const cand of nodeCandidatesById.get(descId) ?? []) {
            if (usedParas.has(cand.pIdx)) continue;
            const start = paragraphInfos[cand.pIdx].start;
            if (start <= scope.start || start >= scope.end) continue;
            distinctSubtreeParas.add(cand.pIdx);
            if (cand.rank < bestRank) bestRank = cand.rank;
          }
          if (bestRank < Number.POSITIVE_INFINITY) {
            maxMatchableNodes++;
            minPossibleSubtreeRank += bestRank;
          }
        }
      }
      const maxPossibleMatched = Math.min(
        maxMatchableNodes,
        distinctSubtreeParas.size,
      );
      const isPerfectSolution = (sol: GroupSolution): boolean =>
        sol.totalMatched === maxPossibleMatched &&
        sol.totalMatched === maxMatchableNodes &&
        sol.totalRank <= minPossibleSubtreeRank &&
        sol.totalInversions === 0;

      const sameAssignment = (
        a: ReadonlyMap<number, number>,
        b: ReadonlyMap<number, number>,
      ): boolean => {
        if (a.size !== b.size) return false;
        for (const [k, v] of a) {
          if (b.get(k) !== v) return false;
        }
        return true;
      };

      // Step 2b: Exact O(M * P) preorder tree-DP seed solves arbitrarily large preorder
      // identical-title outlines (e.g. 3x3 or 20x5 same-titled subtrees) in polynomial time.
      if (!isPerfectSolution(bestSol)) {
        const preorderNodes: OutlineNode[] = [];
        const collectPreorder = (list: readonly OutlineNode[]): void => {
          for (const n of list) {
            preorderNodes.push(n);
            const ch = childrenByParentId.get(n.id);
            if (ch && ch.length > 0) collectPreorder(ch);
          }
        };
        collectPreorder(group);
        const inScopeParas = [...distinctSubtreeParas].sort((a, b) => a - b);
        const M = preorderNodes.length;
        const P = inScopeParas.length;
        if (M > 0 && P > 0 && M * P <= 200_000) {
          const paraPosByIdx = new Map<number, number>();
          for (let pos = 0; pos < P; pos++) {
            paraPosByIdx.set(inScopeParas[pos], pos);
          }
          const rankByNodeAndPos = preorderNodes.map((n) => {
            const map = new Map<number, number>();
            for (const cand of nodeCandidatesById.get(n.id) ?? []) {
              const pos = paraPosByIdx.get(cand.pIdx);
              if (pos !== undefined) map.set(pos, cand.rank);
            }
            return map;
          });
          const stride = P + 1;
          const dpMatch = new Int32Array((M + 1) * stride);
          const dpRank = new Int32Array((M + 1) * stride);
          const dpPIdxSum = new Int32Array((M + 1) * stride);
          const dpChoice = new Uint8Array((M + 1) * stride);
          const isBetterDp = (
            m1: number,
            r1: number,
            s1: number,
            m2: number,
            r2: number,
            s2: number,
          ): boolean =>
            m1 !== m2 ? m1 > m2 : r1 !== r2 ? r1 < r2 : s1 < s2;

          for (let k = M - 1; k >= 0; k--) {
            const nodeRanks = rankByNodeAndPos[k];
            for (let pos = P - 1; pos >= 0; pos--) {
              const idx = k * stride + pos;
              const skipNodeIdx = (k + 1) * stride + pos;
              let bestM = dpMatch[skipNodeIdx];
              let bestR = dpRank[skipNodeIdx];
              let bestS = dpPIdxSum[skipNodeIdx];
              let bestC = 0;

              const skipParaIdx = k * stride + (pos + 1);
              if (
                isBetterDp(
                  dpMatch[skipParaIdx],
                  dpRank[skipParaIdx],
                  dpPIdxSum[skipParaIdx],
                  bestM,
                  bestR,
                  bestS,
                )
              ) {
                bestM = dpMatch[skipParaIdx];
                bestR = dpRank[skipParaIdx];
                bestS = dpPIdxSum[skipParaIdx];
                bestC = 1;
              }

              const candRank = nodeRanks.get(pos);
              if (candRank !== undefined) {
                const diagIdx = (k + 1) * stride + (pos + 1);
                const m = 1 + dpMatch[diagIdx];
                const r = candRank + dpRank[diagIdx];
                const s = inScopeParas[pos] + dpPIdxSum[diagIdx];
                if (isBetterDp(m, r, s, bestM, bestR, bestS)) {
                  bestM = m;
                  bestR = r;
                  bestS = s;
                  bestC = 2;
                }
              }

              dpMatch[idx] = bestM;
              dpRank[idx] = bestR;
              dpPIdxSum[idx] = bestS;
              dpChoice[idx] = bestC;
            }
          }

          const rootMemberIdxByNodeId = new Map(group.map((n, i) => [n.id, i]));
          const preorderAssigned = new Map<number, number>();
          let k = 0;
          let pos = 0;
          while (k < M && pos < P) {
            const choice = dpChoice[k * stride + pos];
            if (choice === 2) {
              const memberIdx = rootMemberIdxByNodeId.get(preorderNodes[k].id);
              if (memberIdx !== undefined) {
                preorderAssigned.set(memberIdx, inScopeParas[pos]);
              }
              k++;
              pos++;
            } else if (choice === 1) {
              pos++;
            } else {
              k++;
            }
          }
          if (!sameAssignment(preorderAssigned, baselineAssigned)) {
            const preorderSol = evaluateGroupAssignment(preorderAssigned, true);
            if (preorderSol && isBetterSolution(preorderSol, bestSol)) {
              bestSol = preorderSol;
              bestAssigned = preorderAssigned;
            }
          }
        }
      }

      if (isPerfectSolution(bestSol)) {
        return bestSol;
      }

      // Partition members into fixed (uncontested single candidate or no candidate) vs variable.
      interface VariableMember {
        memberIdx: number;
        domain: Array<number | null>;
        domainSet: Set<number | null>;
      }
      const fixedAssigned = new Map<number, number>();
      const variableMembers: VariableMember[] = [];
      for (let i = 0; i < group.length; i++) {
        const cands = candidatesByMember[i];
        if (cands.length === 0) continue;
        const contested = new Set<number>();
        for (let j = 0; j < group.length; j++) {
          if (j === i) continue;
          for (const other of candidatesByMember[j]) contested.add(other.pIdx);
          for (const descP of strictDescendantParasByNodeId.get(group[j].id) ?? []) {
            contested.add(descP);
          }
        }
        if (cands.length === 1 && !contested.has(cands[0].pIdx)) {
          fixedAssigned.set(i, cands[0].pIdx);
          continue;
        }
        const domain: Array<number | null> = cands.map((c) => c.pIdx);
        if (cands.every((c) => contested.has(c.pIdx))) {
          domain.push(null);
        }
        variableMembers.push({
          memberIdx: i,
          domain,
          domainSet: new Set(domain),
        });
      }
      if (variableMembers.length === 0) return bestSol;

      variableMembers.sort(
        (a, b) => a.domain.length - b.domain.length || a.memberIdx - b.memberIdx,
      );
      let searchSpaceSize = 1;
      for (const v of variableMembers) {
        searchSpaceSize *= v.domain.length;
        if (searchSpaceSize > 256) break;
      }

      let searchTruncated = false;
      if (searchSpaceSize <= 256 && searchBudget.remaining > 0) {
        const currentAssigned = new Map<number, number>(fixedAssigned);
        const usedInGroup = new Set<number>(fixedAssigned.values());
        let foundPerfect = false;
        const dfs = (vIdx: number): void => {
          if (foundPerfect) return;
          if (searchBudget.remaining <= 0) {
            searchTruncated = true;
            return;
          }
          if (vIdx === variableMembers.length) {
            if (
              sameAssignment(currentAssigned, baselineAssigned) ||
              sameAssignment(currentAssigned, bestAssigned)
            ) {
              return;
            }
            searchBudget.remaining--;
            const sol = evaluateGroupAssignment(currentAssigned, true);
            if (sol && isBetterSolution(sol, bestSol)) {
              bestSol = sol;
              bestAssigned = new Map(currentAssigned);
              if (isPerfectSolution(bestSol)) foundPerfect = true;
            }
            return;
          }
          const v = variableMembers[vIdx];
          for (const cand of v.domain) {
            if (cand !== null && usedInGroup.has(cand)) continue;
            if (cand !== null) {
              usedInGroup.add(cand);
              currentAssigned.set(v.memberIdx, cand);
            }
            dfs(vIdx + 1);
            if (cand !== null) {
              usedInGroup.delete(cand);
              currentAssigned.delete(v.memberIdx);
            }
            if (foundPerfect || searchTruncated) return;
          }
        };
        dfs(0);
      } else {
        searchTruncated = true;
        // Bounded multi-pass coordinate descent + pairwise swap for pathological large conflict sets.
        const currentAssigned = new Map<number, number>(bestAssigned);
        const currentUsedInGroup = new Set<number>(bestAssigned.values());
        let improved = true;
        while (improved && searchBudget.remaining > 0 && !isPerfectSolution(bestSol)) {
          improved = false;
          for (const v of variableMembers) {
            if (searchBudget.remaining <= 0 || isPerfectSolution(bestSol)) break;
            let prev: number | null = currentAssigned.get(v.memberIdx) ?? null;
            for (const cand of v.domain) {
              if (cand === prev) continue;
              if (cand !== null && currentUsedInGroup.has(cand)) continue;
              if (searchBudget.remaining <= 0) break;
              if (prev !== null) currentUsedInGroup.delete(prev);
              if (cand !== null) {
                currentUsedInGroup.add(cand);
                currentAssigned.set(v.memberIdx, cand);
              } else {
                currentAssigned.delete(v.memberIdx);
              }
              searchBudget.remaining--;
              const sol = evaluateGroupAssignment(currentAssigned, true);
              if (sol && isBetterSolution(sol, bestSol)) {
                bestSol = sol;
                prev = cand;
                improved = true;
                if (isPerfectSolution(bestSol)) break;
              } else {
                if (cand !== null) currentUsedInGroup.delete(cand);
                if (prev !== null) {
                  currentUsedInGroup.add(prev);
                  currentAssigned.set(v.memberIdx, prev);
                } else {
                  currentAssigned.delete(v.memberIdx);
                }
              }
            }
          }
          for (let a = 0; a < variableMembers.length; a++) {
            if (searchBudget.remaining <= 0 || isPerfectSolution(bestSol)) break;
            const vA = variableMembers[a];
            for (let b = a + 1; b < variableMembers.length; b++) {
              if (searchBudget.remaining <= 0 || isPerfectSolution(bestSol)) break;
              const vB = variableMembers[b];
              const pA: number | null = currentAssigned.get(vA.memberIdx) ?? null;
              const pB: number | null = currentAssigned.get(vB.memberIdx) ?? null;
              if (pA === pB) continue;
              if (!vA.domainSet.has(pB) || !vB.domainSet.has(pA)) continue;
              if (pB !== null) currentAssigned.set(vA.memberIdx, pB);
              else currentAssigned.delete(vA.memberIdx);
              if (pA !== null) currentAssigned.set(vB.memberIdx, pA);
              else currentAssigned.delete(vB.memberIdx);
              searchBudget.remaining--;
              const sol = evaluateGroupAssignment(currentAssigned, true);
              if (sol && isBetterSolution(sol, bestSol)) {
                bestSol = sol;
                improved = true;
              } else {
                if (pA !== null) currentAssigned.set(vA.memberIdx, pA);
                else currentAssigned.delete(vA.memberIdx);
                if (pB !== null) currentAssigned.set(vB.memberIdx, pB);
                else currentAssigned.delete(vB.memberIdx);
              }
            }
          }
        }
      }

      if (searchTruncated && bestSol.totalMatched < maxPossibleMatched) {
        return { ...bestSol, searchUncertain: true };
      }
      return bestSol;
    };

    const rootSolution = solveSiblingGroup(
      childrenByParentId.get(null) ?? [],
      { start: -1, end: Number.POSITIVE_INFINITY },
      new Set<number>(),
      new Map<number, string>(),
      { remaining: 1024 },
    );
    if (rootSolution.searchUncertain) {
      pushVolumeIssue({
        kind: "corrupt_draft",
        draft: volumeName,
        title: volumeName,
        reason: `分册「${volumeName}」存在过多同名冲突标题，大纲章节归属搜索超出精确核验上限，无法可靠确认章节完整性`,
        suggestion: "请为同名章节补充唯一编号或规范 Word 标题层级后重新检查。",
      });
      continue;
    }

    const claimedNodeIdByStart = new Map<number, string>();
    const claimedAnchorByNodeId = new Map<string, VisibleBodyParagraphInfo>();
    for (const [nodeId, pIdx] of rootSolution.assignedParaByNodeId) {
      const anchor = paragraphInfos[pIdx];
      claimedAnchorByNodeId.set(nodeId, anchor);
      claimedNodeIdByStart.set(anchor.start, nodeId);
    }
    const sectionSpanByNodeId = new Map(rootSolution.sectionSpanByNodeId);

    // Reconcile final section spans top-down against all claimed anchors (and excluded
    // outline boundaries via computeSpanEnd) so parent-child containment always holds.
    let containmentChanged = true;
    while (containmentChanged) {
      containmentChanged = false;
      const allClaimedAnchors = [...claimedAnchorByNodeId.entries()]
        .map(([nodeId, anchor]) => ({
          nodeId,
          start: anchor.start,
        }))
        .sort((a, b) => a.start - b.start);
      const enforceContainment = (
        group: readonly OutlineNode[],
        parentSpan: { start: number; end: number } | null,
      ): void => {
        for (const node of group) {
          const anchor = claimedAnchorByNodeId.get(node.id);
          let nextParentSpan = parentSpan;
          if (anchor) {
            if (
              parentSpan &&
              (anchor.start <= parentSpan.start || anchor.start >= parentSpan.end)
            ) {
              claimedAnchorByNodeId.delete(node.id);
              claimedNodeIdByStart.delete(anchor.start);
              sectionSpanByNodeId.delete(node.id);
              containmentChanged = true;
            } else {
              const existing = sectionSpanByNodeId.get(node.id)!;
              const upperBound = parentSpan
                ? Math.min(existing.end, parentSpan.end)
                : existing.end;
              const refinedEnd = computeSpanEnd(
                node,
                anchor,
                upperBound,
                allClaimedAnchors,
                claimedNodeIdByStart,
                false,
              );
              const updatedSpan = { start: anchor.start, end: refinedEnd };
              sectionSpanByNodeId.set(node.id, updatedSpan);
              nextParentSpan = updatedSpan;
            }
          }
          const children = childrenByParentId.get(node.id) ?? [];
          if (children.length > 0) {
            enforceContainment(children, nextParentSpan);
          }
        }
      };
      enforceContainment(childrenByParentId.get(null) ?? [], null);
    }

    for (const node of nodes) {
      const expected = node.expectedHeading?.trim()
        ? node.expectedHeading
        : node.title;
      const sectionSpan = sectionSpanByNodeId.get(node.id);
      const hasSection = sectionSpan !== undefined;
      if (!hasSection) {
        pushVolumeIssue({
          kind: "missing_section",
          draft: volumeName,
          nodeId: node.id,
          title: node.title,
          expectedHeading: expected,
          reason: `启用章节「${node.title}」未出现在分册「${volumeName}」中`,
          suggestion: `请在分册「${volumeName}」补齐章节「${expected}」。`,
        });
      }
      const inNodeSection = (pos: number): boolean =>
        sectionSpan ? pos >= sectionSpan.start && pos < sectionSpan.end : true;

      for (const binding of node.evidence ?? []) {
        if (binding.source === "kb") {
          const isKbMaterial = input.kbMaterialIds?.has(binding.ref) === true;
          let requireMedia = input.kbRecordHasFiles?.get(binding.ref) === true;
          let expectedKbHashes: readonly string[] | undefined;
          let kbMediaError: string | undefined;
          let kbMediaIsNoImages = false;
          if (input.kbRecordMediaStates) {
            const mediaState = input.kbRecordMediaStates.get(binding.ref);
            if (!mediaState) {
              kbMediaError = "缺少可核验的知识库记录元数据";
            } else if (mediaState.kind === "error") {
              kbMediaError = mediaState.reason;
            } else if (mediaState.kind === "ok") {
              requireMedia = true;
              if (mediaState.hashes.length === 0) {
                kbMediaError = "知识库记录图片哈希为空";
              } else {
                expectedKbHashes = mediaState.hashes;
              }
            } else if (mediaState.kind === "no_images") {
              kbMediaIsNoImages = true;
              if (requireMedia && node.kind === "attachment") {
                kbMediaError = "知识库记录未包含可核验的图片附件";
              } else {
                requireMedia = false;
              }
            }
          } else if (input.kbRecordImageHashes?.has(binding.ref)) {
            const provided = input.kbRecordImageHashes.get(binding.ref)!;
            requireMedia = true;
            if (provided.length === 0) {
              kbMediaError = "知识库记录图片哈希为空";
            } else {
              expectedKbHashes = provided;
            }
          }
          if (kbMediaError) {
            pushVolumeIssue({
              kind: "missing_evidence",
              draft: volumeName,
              nodeId: node.id,
              title: node.title,
              source: "kb",
              ref: binding.ref,
              reason: `章节「${node.title}」绑定的知识库证照「${binding.label ?? binding.ref}」无法核验原图：${kbMediaError}`,
              suggestion: `请检查知识库记录 ${binding.ref} 的附件图片完整性并重新挂载。`,
            });
            continue;
          }
          const isProseOnlyKbMaterial =
            isKbMaterial &&
            !requireMedia &&
            (input.kbRecordMediaStates
              ? kbMediaIsNoImages
              : input.kbRecordHasFiles?.get(binding.ref) !== true);
          if (isProseOnlyKbMaterial) {
            // Text-only prose reference KB materials (kind="material" with zero images)
            // have no {{record:...}} structured fact citation syntax; their readability is
            // verified above and section presence is enforced by missing_section.
            continue;
          }
          const matchingFills = activeVolumeFills.filter((fill) =>
            (fill.sources ?? []).some(
              (src) =>
                (src.recordId === binding.ref ||
                  src.materialId === binding.ref) &&
                (!requireMedia || src.media === true),
            ),
          );
          const collectKbMediaHashes = (
            fills: readonly (typeof activeVolumeFills)[number][],
          ): { volume: string[]; section: string[] } => {
            const volumeByIdx = new Map<number, string>();
            const sectionByIdx = new Map<number, string>();
            for (const fill of fills) {
              const bookmarkName =
                fill.sealKind === "pending"
                  ? `_Seal_P_${fill.id}`
                  : `_Seal_F_${fill.id}`;
              const range = activeRangeByName.get(bookmarkName);
              if (!range) continue;
              for (let idx = 0; idx < activeMediaItems.length; idx++) {
                const item = activeMediaItems[idx];
                if (item.start >= range.startXml && item.end <= range.endXml) {
                  volumeByIdx.set(idx, item.hash);
                  if (inNodeSection(item.start)) {
                    sectionByIdx.set(idx, item.hash);
                  }
                }
              }
            }
            return {
              volume: [...volumeByIdx.values()],
              section: [...sectionByIdx.values()],
            };
          };

          if (!requireMedia) {
            const isMatchingKbTextSource = (src: FactSource): boolean =>
              (src.recordId === binding.ref ||
                src.materialId === binding.ref) &&
              src.media !== true;
            const inSectionTextFill = matchingFills.some((fill) => {
              const bookmarkName =
                fill.sealKind === "pending"
                  ? `_Seal_P_${fill.id}`
                  : `_Seal_F_${fill.id}`;
              const range = activeRangeByName.get(bookmarkName);
              if (!range) return false;
              return (fill.sources ?? []).some(
                (src) =>
                  isMatchingKbTextSource(src) &&
                  sourceTextSatisfiedInRange(range, src, inNodeSection),
              );
            });
            if (!inSectionTextFill) {
              const elsewhere =
                sectionSpan !== undefined &&
                matchingFills.some((fill) => {
                  const bookmarkName =
                    fill.sealKind === "pending"
                      ? `_Seal_P_${fill.id}`
                      : `_Seal_F_${fill.id}`;
                  const range = activeRangeByName.get(bookmarkName);
                  if (!range) return false;
                  return (fill.sources ?? []).some(
                    (src) =>
                      isMatchingKbTextSource(src) &&
                      sourceTextSatisfiedInRange(range, src),
                  );
                });
              pushVolumeIssue({
                kind: "missing_evidence",
                draft: volumeName,
                nodeId: node.id,
                title: node.title,
                source: "kb",
                ref: binding.ref,
                reason: elsewhere
                  ? `章节「${node.title}」绑定的知识库记录「${binding.label ?? binding.ref}」未引用到该章节范围内（仅出现在其他章节）`
                  : `章节「${node.title}」绑定的知识库记录「${binding.label ?? binding.ref}」未引用到分册「${volumeName}」`,
                suggestion: `请在章节「${node.title}」写入或挂载知识库记录 ${binding.ref}。`,
              });
            }
            continue;
          }

          const { volume: volumeKbHashes, section: sectionKbHashes } =
            collectKbMediaHashes(matchingFills);
          if (expectedKbHashes !== undefined) {
            const missingInSection = countMissingExpectedHashes(
              expectedKbHashes,
              sectionKbHashes,
            );
            if (missingInSection > 0) {
              const missingInVolume = countMissingExpectedHashes(
                expectedKbHashes,
                volumeKbHashes,
              );
              const wrongSectionOnly =
                sectionSpan !== undefined && missingInVolume === 0;
              pushVolumeIssue({
                kind: "missing_evidence",
                draft: volumeName,
                nodeId: node.id,
                title: node.title,
                source: "kb",
                ref: binding.ref,
                reason: wrongSectionOnly
                  ? `章节「${node.title}」绑定的知识库证照「${binding.label ?? binding.ref}」图片未挂载到该章节范围内（已出现在其他章节）`
                  : expectedKbHashes.length > 1
                    ? `章节「${node.title}」绑定的知识库证照「${binding.label ?? binding.ref}」尚有 ${missingInSection}/${expectedKbHashes.length} 张原图未挂载到该章节`
                    : `章节「${node.title}」绑定的知识库证照「${binding.label ?? binding.ref}」图片未挂载到分册「${volumeName}」`,
                suggestion: `请在章节「${node.title}」挂载知识库记录 ${binding.ref} 的全部原图。`,
              });
            }
          } else if (sectionKbHashes.length === 0) {
            const wrongSectionOnly =
              sectionSpan !== undefined && volumeKbHashes.length > 0;
            pushVolumeIssue({
              kind: "missing_evidence",
              draft: volumeName,
              nodeId: node.id,
              title: node.title,
              source: "kb",
              ref: binding.ref,
              reason: wrongSectionOnly
                ? `章节「${node.title}」绑定的知识库证照「${binding.label ?? binding.ref}」图片未挂载到该章节范围内（已出现在其他章节）`
                : `章节「${node.title}」绑定的知识库证照「${binding.label ?? binding.ref}」图片未挂载到分册「${volumeName}」`,
              suggestion: `请在章节「${node.title}」挂载知识库记录 ${binding.ref}。`,
            });
          }
          continue;
        }

        const state = input.materialStates?.get(binding.ref);
        if (!state || !state.exists || !state.readable) {
          pushVolumeIssue({
            kind: "missing_material_file",
            draft: volumeName,
            nodeId: node.id,
            title: node.title,
            source: "material",
            ref: binding.ref,
            reason:
              state?.error ??
              `章节「${node.title}」绑定的上传材料文件缺失或不可读：${binding.ref}`,
            suggestion: "请在大纲编辑器重新上传该材料或更换绑定记录。",
          });
          continue;
        }
        if (state.missingPages && state.missingPages.length > 0) {
          pushVolumeIssue({
            kind: "missing_material_file",
            draft: volumeName,
            nodeId: node.id,
            title: node.title,
            source: "material",
            ref: binding.ref,
            reason: `章节「${node.title}」绑定的渲染页缺失或不可读：${state.missingPages.join("、")}`,
            suggestion: "请重新上传材料以重新生成渲染页。",
          });
          continue;
        }

        const expectedHashes = state.expectedImageHashes ?? [];
        if (expectedHashes.length > 0) {
          const sectionMediaHashes = activeMediaItems
            .filter((item) => inNodeSection(item.start))
            .map((item) => item.hash);
          const missingCount = countMissingExpectedHashes(
            expectedHashes,
            sectionMediaHashes,
          );
          if (missingCount > 0) {
            const volumeMissing = countMissingExpectedHashes(
              expectedHashes,
              activeMediaItems.map((item) => item.hash),
            );
            const wrongSectionOnly =
              sectionSpan !== undefined && volumeMissing === 0;
            pushVolumeIssue({
              kind: "missing_evidence",
              draft: volumeName,
              nodeId: node.id,
              title: node.title,
              source: "material",
              ref: binding.ref,
              reason: wrongSectionOnly
                ? `章节「${node.title}」绑定的上传材料「${binding.label ?? binding.ref}」图片未挂载到该章节范围内（已出现在其他章节）`
                : expectedHashes.length > 1
                  ? `章节「${node.title}」绑定的上传材料「${binding.label ?? binding.ref}」尚有 ${missingCount}/${expectedHashes.length} 页未挂载到分册「${volumeName}」`
                  : `章节「${node.title}」绑定的上传材料「${binding.label ?? binding.ref}」尚未挂载到分册「${volumeName}」`,
              suggestion: `请将该材料${binding.renderedPages?.length ? "全部渲染页" : "图片"}插入章节「${node.title}」。`,
            });
          }
        } else if (state.kind === "pdf") {
          pushVolumeIssue({
            kind: "missing_evidence",
            draft: volumeName,
            nodeId: node.id,
            title: node.title,
            source: "material",
            ref: binding.ref,
            reason: `章节「${node.title}」绑定的 PDF 材料「${binding.label ?? binding.ref}」缺少已渲染图片页`,
            suggestion: "请在大纲编辑器重新上传该 PDF 生成渲染页后挂载。",
          });
        } else {
          const quotePrefix = `{{quote:${binding.ref}|`;
          const matchingQuoteFills = activeVolumeFills.filter((fill) =>
            (fill.sources ?? []).some((src) =>
              src.reference.startsWith(quotePrefix),
            ),
          );
          const quotedInSection = matchingQuoteFills.some((fill) => {
            const bookmarkName =
              fill.sealKind === "pending"
                ? `_Seal_P_${fill.id}`
                : `_Seal_F_${fill.id}`;
            const range = activeRangeByName.get(bookmarkName);
            if (!range) return false;
            return (fill.sources ?? []).some(
              (src) =>
                src.reference.startsWith(quotePrefix) &&
                sourceTextSatisfiedInRange(range, src, inNodeSection),
            );
          });
          if (!quotedInSection) {
            const wrongSectionOnly =
              sectionSpan !== undefined &&
              matchingQuoteFills.some((fill) => {
                const bookmarkName =
                  fill.sealKind === "pending"
                    ? `_Seal_P_${fill.id}`
                    : `_Seal_F_${fill.id}`;
                const range = activeRangeByName.get(bookmarkName);
                if (!range) return false;
                return (fill.sources ?? []).some(
                  (src) =>
                    src.reference.startsWith(quotePrefix) &&
                    sourceTextSatisfiedInRange(range, src),
                );
              });
            pushVolumeIssue({
              kind: "missing_evidence",
              draft: volumeName,
              nodeId: node.id,
              title: node.title,
              source: "material",
              ref: binding.ref,
              reason: wrongSectionOnly
                ? `章节「${node.title}」绑定的材料「${binding.label ?? binding.ref}」原文引用未落在该章节范围内（仅出现在其他章节）`
                : `章节「${node.title}」绑定的材料「${binding.label ?? binding.ref}」尚未通过原文引用写入分册「${volumeName}」`,
              suggestion: `请使用 {{quote:${binding.ref}|<原文片段>}} 将该材料内容写入章节「${node.title}」。`,
            });
          }
        }
      }
    }
    }
  }

  return issues;
}
