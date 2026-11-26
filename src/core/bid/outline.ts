import { validatePackageStructure, resolveRelationshipTarget } from "../docx/package-structure.js";
import { sealRanges, type SealRange } from "../docx/seal-ranges.js";
import { xmlAttributes } from "../docx/outline.js";
import { elementChildren, unescapeXml, xmlElements } from "../docx/xml.js";
import { sha256Hex } from "../docx/zip.js";
import {
  isCurrentAuthorization,
  signAuthorization,
  type SignedAuthorization,
} from "./authorization.js";
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

function headingVariants(rawHeading: string): string[] {
  const full = normalizeHeadingRaw(rawHeading);
  if (!full) return [];
  const stripped = stripNumberPrefix(full);
  return stripped && stripped !== full ? [full, stripped] : [full];
}

/**
 * Extract visible body and table-cell paragraph texts from word/document.xml,
 * excluding TOC field caches (begin..end whose instruction matches /\bTOC\b/i, and w:fldSimple),
 * tracked deletions/moves (w:del, w:moveFrom, *PrChange), textboxes (w:txbxContent),
 * and runs with active w:vanish or w:webHidden.
 */
export function visibleBodyNonTocParagraphs(docXml: string): string[] {
  const elements = xmlElements(docXml);
  const children = elementChildren(elements);
  const bodyIndex = elements.findIndex((el) => el.name === "w:body");
  if (bodyIndex < 0) return [];

  const isOffVal = (val: string | undefined): boolean =>
    val !== undefined && ["0", "false", "off"].includes(val.toLowerCase());

  const isSkippedContainer = (name: string): boolean =>
    name === "w:del" ||
    name === "w:moveFrom" ||
    name === "w:txbxContent" ||
    name === "w:drawing" ||
    name === "w:pict" ||
    name === "w:object" ||
    name.endsWith("PrChange");

  const isHiddenRun = (runIdx: number): boolean => {
    for (const childIdx of children[runIdx]) {
      const child = elements[childIdx];
      if (child.name !== "w:rPr") continue;
      for (const propIdx of children[childIdx]) {
        const prop = elements[propIdx];
        if (prop.name === "w:vanish" || prop.name === "w:webHidden") {
          const val = xmlAttributes(docXml, prop).get("w:val");
          if (!isOffVal(val)) return true;
        }
      }
    }
    return false;
  };

  const paragraphs: string[] = [];
  const fieldStack: Array<{ instr: string; separated: boolean; isToc: boolean }> =
    [];
  const insideTocField = (): boolean => fieldStack.some((frame) => frame.isToc);
  let currentParaParts: string[] | null = null;
  let fldSimpleTocDepth = 0;

  const visit = (idx: number, inRun: boolean, runHidden: boolean): void => {
    const el = elements[idx];
    if (isSkippedContainer(el.name)) return;

    if (el.name === "w:p") {
      const prevParts = currentParaParts;
      currentParaParts = [];
      for (const childIdx of children[idx]) {
        visit(childIdx, false, false);
      }
      const text = currentParaParts.join("");
      if (text.length > 0) {
        paragraphs.push(text);
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
        currentParaParts.push(
          unescapeXml(docXml.slice(el.openEnd, el.closeStart)),
        );
        return;
      }
      if (el.name === "w:tab") {
        currentParaParts.push("\t");
        return;
      }
      if (el.name === "w:br" || el.name === "w:cr") {
        currentParaParts.push("\n");
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
  return paragraphs;
}

interface ActiveMediaItem {
  start: number;
  end: number;
  hash: string;
}

function activeDocumentMediaItems(
  parts: ReadonlyMap<string, Uint8Array>,
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
  const deletedMask = new Array<boolean>(elements.length).fill(false);
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    const parentDeleted = el.parent !== null && deletedMask[el.parent];
    deletedMask[i] =
      parentDeleted ||
      el.name === "w:del" ||
      el.name === "w:moveFrom" ||
      el.name.endsWith("PrChange");
    if (deletedMask[i]) continue;
    const local = el.name.split(":").pop();
    let relId: string | undefined;
    if (local === "blip") {
      relId = xmlAttributes(docXml, el).get("r:embed");
    } else if (local === "imagedata") {
      relId = xmlAttributes(docXml, el).get("r:id");
    }
    if (!relId) continue;
    const targetPath = relTargets.get(relId);
    if (!targetPath) continue;
    const mediaBytes = parts.get(targetPath);
    if (mediaBytes && mediaBytes.length > 0) {
      items.push({
        start: el.start,
        end: el.end,
        hash: sha256Hex(mediaBytes),
      });
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
  for (const node of outline.nodes) {
    if (!node.included) continue;
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

    const docXml = new TextDecoder("utf-8", { fatal: true }).decode(
      parts.get("word/document.xml")!,
    );
    const normalizedParagraphs = visibleBodyNonTocParagraphs(docXml).map((text) =>
      normalizeHeadingRaw(text),
    );
    const activeMediaItems = activeDocumentMediaItems(parts);
    const activeMedia = new Set(activeMediaItems.map((item) => item.hash));
    const activeRangeByName = new Map<string, SealRange>();
    try {
      for (const range of sealRanges(docXml)) {
        activeRangeByName.set(range.name, range);
      }
    } catch {
      /* Malformed bookmarks are also flagged by C10; leave activeRangeByName empty so missing evidence is caught conservatively. */
    }

    const activeVolumeFills = ledger.fills.filter(
      (fill) =>
        fill &&
        typeof fill === "object" &&
        fill.draft === volumeName &&
        fill.status !== "removed" &&
        activeRangeByName.has(
          fill.sealKind === "pending" ? `_Seal_P_${fill.id}` : `_Seal_F_${fill.id}`,
        ),
    );

    for (const node of nodes) {
      const expected = node.expectedHeading?.trim()
        ? node.expectedHeading
        : node.title;
      const variants = headingVariants(expected);
      const hasSection =
        variants.length > 0 &&
        normalizedParagraphs.some((paragraphText) =>
          variants.some((variant) => paragraphText.includes(variant)),
        );
      if (!hasSection) {
        issues.push({
          kind: "missing_section",
          draft: volumeName,
          nodeId: node.id,
          title: node.title,
          expectedHeading: expected,
          reason: `启用章节「${node.title}」未出现在分册「${volumeName}」中`,
          suggestion: `请在分册「${volumeName}」补齐章节「${expected}」。`,
        });
      }

      for (const binding of node.evidence ?? []) {
        if (binding.source === "kb") {
          const isKbMaterial = input.kbMaterialIds?.has(binding.ref) === true;
          let requireMedia =
            (node.kind === "attachment" || isKbMaterial) &&
            input.kbRecordHasFiles?.get(binding.ref) === true;
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
              if (node.kind === "attachment" || isKbMaterial) {
                requireMedia = true;
                if (mediaState.hashes.length === 0) {
                  kbMediaError = "知识库记录图片哈希为空";
                } else {
                  expectedKbHashes = mediaState.hashes;
                }
              }
            } else if (mediaState.kind === "no_images") {
              kbMediaIsNoImages = true;
              if (requireMedia && node.kind === "attachment") {
                kbMediaError = "知识库记录未包含可核验的图片附件";
              } else if (isKbMaterial) {
                requireMedia = false;
              }
            }
          } else if (requireMedia && input.kbRecordImageHashes?.has(binding.ref)) {
            const provided = input.kbRecordImageHashes.get(binding.ref)!;
            if (provided.length === 0) {
              kbMediaError = "知识库记录图片哈希为空";
            } else {
              expectedKbHashes = provided;
            }
          }
          if (kbMediaError) {
            issues.push({
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
          const mounted = activeVolumeFills.some((fill) => {
            const hasMatchingSource = (fill.sources ?? []).some(
              (src) =>
                (src.recordId === binding.ref ||
                  src.materialId === binding.ref) &&
                (!requireMedia || src.media === true),
            );
            if (!hasMatchingSource) return false;
            if (!requireMedia) return true;
            const bookmarkName =
              fill.sealKind === "pending"
                ? `_Seal_P_${fill.id}`
                : `_Seal_F_${fill.id}`;
            const range = activeRangeByName.get(bookmarkName);
            if (!range) return false;
            const rangeMediaHashes = new Set(
              activeMediaItems
                .filter(
                  (item) =>
                    item.start >= range.startXml && item.end <= range.endXml,
                )
                .map((item) => item.hash),
            );
            if (rangeMediaHashes.size === 0) return false;
            if (expectedKbHashes !== undefined) {
              return expectedKbHashes.some((hash) => rangeMediaHashes.has(hash));
            }
            return true;
          });
          if (!mounted) {
            issues.push({
              kind: "missing_evidence",
              draft: volumeName,
              nodeId: node.id,
              title: node.title,
              source: "kb",
              ref: binding.ref,
              reason: requireMedia
                ? `章节「${node.title}」绑定的知识库证照「${binding.label ?? binding.ref}」图片未挂载到分册「${volumeName}」`
                : `章节「${node.title}」绑定的知识库记录「${binding.label ?? binding.ref}」未引用到分册「${volumeName}」`,
              suggestion: `请在该章节写入或挂载知识库记录 ${binding.ref}。`,
            });
          }
          continue;
        }

        const state = input.materialStates?.get(binding.ref);
        if (!state || !state.exists || !state.readable) {
          issues.push({
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
          issues.push({
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
          const missingCount = expectedHashes.filter(
            (hash) => !activeMedia.has(hash),
          ).length;
          if (missingCount > 0) {
            issues.push({
              kind: "missing_evidence",
              draft: volumeName,
              nodeId: node.id,
              title: node.title,
              source: "material",
              ref: binding.ref,
              reason:
                expectedHashes.length > 1
                  ? `章节「${node.title}」绑定的上传材料「${binding.label ?? binding.ref}」尚有 ${missingCount}/${expectedHashes.length} 页未挂载到分册「${volumeName}」`
                  : `章节「${node.title}」绑定的上传材料「${binding.label ?? binding.ref}」尚未挂载到分册「${volumeName}」`,
              suggestion: `请将该材料${binding.renderedPages?.length ? "全部渲染页" : "图片"}插入分册「${volumeName}」。`,
            });
          }
        } else if (state.kind === "pdf") {
          issues.push({
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
          const quoted = activeVolumeFills.some((fill) =>
            (fill.sources ?? []).some((src) =>
              src.reference.startsWith(quotePrefix),
            ),
          );
          if (!quoted) {
            issues.push({
              kind: "missing_evidence",
              draft: volumeName,
              nodeId: node.id,
              title: node.title,
              source: "material",
              ref: binding.ref,
              reason: `章节「${node.title}」绑定的材料「${binding.label ?? binding.ref}」尚未通过原文引用写入分册「${volumeName}」`,
              suggestion: `请使用 {{quote:${binding.ref}|<原文片段>}} 将该材料内容写入目标分册「${volumeName}」。`,
            });
          }
        }
      }
    }
  }

  return issues;
}
