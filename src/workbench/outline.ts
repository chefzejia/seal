import {
  canonicalOutlineDigest,
  updateOutlineNode,
  type OutlineConfirmationStatus,
  type OutlineConsistencyIssue,
  type OutlineDocument,
  type OutlineEvidenceBinding,
  type OutlineNode,
  type OutlineState,
  type OutlineVolume,
} from "../core/bid/outline.js";
import type { Requirement, RequirementsState } from "../core/bid/requirements.js";

export type OutlineMaterialStatus =
  | "ready"
  | "missing"
  | "needs_review"
  | "not_applicable";

export interface OutlineKbRecordSummary {
  id: string;
  kbKind?: "record" | "material";
  title?: string;
  type?: string;
  verified: boolean;
  validity?: "valid" | "expiring_soon" | "expired" | "unknown" | "not_applicable";
  subject?: "self" | "third_party" | "forbidden" | "mismatch" | "unknown";
  hasFiles?: boolean;
  files?: string[];
  holder?: string;
  validUntil?: string;
  number?: string;
  revision?: string;
}

export interface ResolvedOutlineEvidence extends OutlineEvidenceBinding {
  status: "ready" | "unverified" | "missing" | "invalid";
  kbKind?: "record" | "material";
  title?: string;
  type?: string;
  hasFiles?: boolean;
  kbFiles?: string[];
  kbHolder?: string;
  kbValidUntil?: string;
  kbNumber?: string;
  kbRevision?: string;
  kbVerified?: boolean;
  kbValidity?: OutlineKbRecordSummary["validity"];
  kbSubject?: OutlineKbRecordSummary["subject"];
}

export interface OutlineRowView extends OutlineNode {
  depth: number;
  hasChildren: boolean;
  childCount: number;
  resolvedMaterialStatus: OutlineMaterialStatus;
  resolvedEvidence: ResolvedOutlineEvidence[];
  resolvedRequirements: Requirement[];
  c17Issues: OutlineConsistencyIssue[];
}

export interface OutlineSummary {
  totalNodes: number;
  includedNodes: number;
  excludedNodes: number;
  missingMaterials: number;
  needsReviewMaterials: number;
  uncoveredRequirements: number;
  c17Gaps: number;
  volumeCount: number;
  changesCount: number;
}

export type OutlineViewModel =
  | {
      kind: "missing";
      confirmationStatus: OutlineConfirmationStatus;
      confirmedAt: string | null;
      summary: OutlineSummary;
      volumes: OutlineVolume[];
      rows: OutlineRowView[];
      uncoveredRequirementList: Requirement[];
      c17Issues: OutlineConsistencyIssue[];
    }
  | {
      kind: "error";
      reason: string;
      confirmationStatus: OutlineConfirmationStatus;
      confirmedAt: string | null;
      summary: OutlineSummary;
      volumes: OutlineVolume[];
      rows: OutlineRowView[];
      uncoveredRequirementList: Requirement[];
      c17Issues: OutlineConsistencyIssue[];
    }
  | {
      kind: "value";
      confirmationStatus: OutlineConfirmationStatus;
      confirmedAt: string | null;
      summary: OutlineSummary;
      volumes: OutlineVolume[];
      rows: OutlineRowView[];
      uncoveredRequirementList: Requirement[];
      c17Issues: OutlineConsistencyIssue[];
    };

export type OutlineRowFilter =
  | "all"
  | "missing_material"
  | "needs_review"
  | "uncovered_req"
  | "template"
  | "authored"
  | "attachment"
  | "excluded"
  | "c17";

function emptySummary(c17Gaps = 0): OutlineSummary {
  return {
    totalNodes: 0,
    includedNodes: 0,
    excludedNodes: 0,
    missingMaterials: 0,
    needsReviewMaterials: 0,
    uncoveredRequirements: 0,
    c17Gaps,
    volumeCount: 0,
    changesCount: 0,
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Count structural and content adjustments between a baseline outline and the current outline. */
export function countOutlineChanges(
  baseline: OutlineDocument | null | undefined,
  current: OutlineDocument | null | undefined,
): number {
  if (!baseline || !current) return 0;
  if (canonicalOutlineDigest(baseline) === canonicalOutlineDigest(current)) {
    return 0;
  }

  let changes = 0;
  const baseVols = new Map(baseline.volumes.map((v, i) => [v.name, { v, i }]));
  const currVols = new Map(current.volumes.map((v, i) => [v.name, { v, i }]));
  for (const [name, entry] of currVols) {
    const prev = baseVols.get(name);
    if (!prev || stableStringify(prev.v) !== stableStringify(entry.v) || prev.i !== entry.i) {
      changes++;
    }
  }
  for (const name of baseVols.keys()) {
    if (!currVols.has(name)) changes++;
  }

  const baseNodes = new Map(baseline.nodes.map((n, i) => [n.id, { n, i }]));
  const currNodes = new Map(current.nodes.map((n, i) => [n.id, { n, i }]));
  for (const [id, entry] of currNodes) {
    const prev = baseNodes.get(id);
    if (!prev || stableStringify(prev.n) !== stableStringify(entry.n) || prev.i !== entry.i) {
      changes++;
    }
  }
  for (const id of baseNodes.keys()) {
    if (!currNodes.has(id)) changes++;
  }
  return changes;
}

/** Build the pure UI projection for both the right-pane outline summary and full-width editor. */
export function buildOutlineView(input: {
  outlineState: OutlineState;
  confirmationStatus: OutlineConfirmationStatus;
  confirmedAt?: string | null;
  baselineOutline?: OutlineDocument | null;
  requirements?: RequirementsState;
  kbRecords?: readonly OutlineKbRecordSummary[];
  materials?: readonly string[];
  c17Issues?: readonly OutlineConsistencyIssue[];
}): OutlineViewModel {
  const c17Issues = [...(input.c17Issues ?? [])];
  const confirmedAt = input.confirmedAt ?? null;
  const requirementItems =
    input.requirements?.kind === "value" ? input.requirements.items : [];

  if (input.outlineState.kind === "missing") {
    const uncovered = requirementItems.filter((item) => item.mustRespond);
    return {
      kind: "missing",
      confirmationStatus: input.confirmationStatus,
      confirmedAt,
      summary: {
        ...emptySummary(c17Issues.length),
        uncoveredRequirements: uncovered.length,
      },
      volumes: [],
      rows: [],
      uncoveredRequirementList: uncovered,
      c17Issues,
    };
  }

  if (input.outlineState.kind === "error") {
    const uncovered = requirementItems.filter((item) => item.mustRespond);
    return {
      kind: "error",
      reason: input.outlineState.reason,
      confirmationStatus: input.confirmationStatus,
      confirmedAt,
      summary: {
        ...emptySummary(c17Issues.length),
        uncoveredRequirements: uncovered.length,
      },
      volumes: [],
      rows: [],
      uncoveredRequirementList: uncovered,
      c17Issues,
    };
  }

  const outline = input.outlineState.outline;
  const nodeById = new Map(outline.nodes.map((node) => [node.id, node]));
  const childCountById = new Map<string, number>();
  for (const node of outline.nodes) {
    if (node.parentId !== null) {
      childCountById.set(node.parentId, (childCountById.get(node.parentId) ?? 0) + 1);
    }
  }

  const depthOf = (node: OutlineNode): number => {
    let depth = 0;
    let current: OutlineNode | undefined = node;
    const seen = new Set<string>();
    while (current && current.parentId !== null && !seen.has(current.id)) {
      seen.add(current.id);
      depth++;
      current = nodeById.get(current.parentId);
    }
    return depth;
  };

  const kbMap = new Map((input.kbRecords ?? []).map((record) => [record.id, record]));
  const materialSet = new Set(input.materials ?? []);
  const reqMap = new Map(requirementItems.map((item) => [item.id, item]));
  const c17ByNode = new Map<string, OutlineConsistencyIssue[]>();
  for (const issue of c17Issues) {
    if (issue.nodeId) {
      const list = c17ByNode.get(issue.nodeId) ?? [];
      list.push(issue);
      c17ByNode.set(issue.nodeId, list);
    }
  }

  const coveredReqIds = new Set<string>();
  for (const node of outline.nodes) {
    if (!node.included) continue;
    for (const reqId of node.requirementIds ?? []) {
      coveredReqIds.add(reqId);
    }
  }
  const uncoveredRequirementList = requirementItems.filter(
    (item) => item.mustRespond && !coveredReqIds.has(item.id),
  );

  const rows: OutlineRowView[] = outline.nodes.map((node) => {
    const resolvedEvidence: ResolvedOutlineEvidence[] = (node.evidence ?? []).map(
      (binding) => {
        if (binding.source === "kb") {
          const rec = kbMap.get(binding.ref);
          if (!rec) {
            return { ...binding, status: "missing" };
          }
          const kbMeta = {
            kbKind: rec.kbKind ?? ("record" as const),
            title: rec.title,
            type: rec.type,
            hasFiles: rec.hasFiles,
            ...(rec.files ? { kbFiles: rec.files } : {}),
            ...(rec.holder ? { kbHolder: rec.holder } : {}),
            ...(rec.validUntil ? { kbValidUntil: rec.validUntil } : {}),
            ...(rec.number ? { kbNumber: rec.number } : {}),
            ...(rec.revision ? { kbRevision: rec.revision } : {}),
            kbVerified: rec.verified,
            kbValidity: rec.validity,
            kbSubject: rec.subject,
          };
          if (rec.kbKind === "material") {
            return {
              ...binding,
              status: "ready",
              ...kbMeta,
            };
          }
          if (
            rec.validity === "expired" ||
            rec.subject === "forbidden" ||
            rec.subject === "mismatch"
          ) {
            return {
              ...binding,
              status: "invalid",
              ...kbMeta,
            };
          }
          if (
            !rec.verified ||
            rec.validity === "unknown" ||
            rec.subject === "unknown"
          ) {
            return {
              ...binding,
              status: "unverified",
              ...kbMeta,
            };
          }
          return {
            ...binding,
            status: "ready",
            ...kbMeta,
          };
        }

        const hasRef = materialSet.has(binding.ref);
        const hasPages =
          !binding.renderedPages?.length ||
          binding.renderedPages.every((page) => materialSet.has(page));
        return {
          ...binding,
          status: hasRef && hasPages ? "ready" : "missing",
        };
      },
    );

    const childCount = childCountById.get(node.id) ?? 0;
    const hasChildren = childCount > 0;
    let resolvedMaterialStatus: OutlineMaterialStatus = "not_applicable";
    if (node.materialMissing) {
      resolvedMaterialStatus = "missing";
    } else if (resolvedEvidence.some((item) => item.status === "missing")) {
      resolvedMaterialStatus = "missing";
    } else if (
      resolvedEvidence.some(
        (item) => item.status === "unverified" || item.status === "invalid",
      )
    ) {
      resolvedMaterialStatus = "needs_review";
    } else if (resolvedEvidence.length > 0) {
      resolvedMaterialStatus = "ready";
    } else if (
      node.kind === "attachment" &&
      !hasChildren &&
      node.materialMissing !== false
    ) {
      resolvedMaterialStatus = "missing";
    }

    const resolvedRequirements = (node.requirementIds ?? [])
      .map((id) => reqMap.get(id))
      .filter((item): item is Requirement => item !== undefined);

    return {
      ...node,
      depth: depthOf(node),
      hasChildren,
      childCount,
      resolvedMaterialStatus,
      resolvedEvidence,
      resolvedRequirements,
      c17Issues: c17ByNode.get(node.id) ?? [],
    };
  });

  const includedRows = rows.filter((row) => row.included);
  return {
    kind: "value",
    confirmationStatus: input.confirmationStatus,
    confirmedAt,
    volumes: outline.volumes,
    summary: {
      totalNodes: rows.length,
      includedNodes: includedRows.length,
      excludedNodes: rows.length - includedRows.length,
      missingMaterials: includedRows.filter(
        (row) => row.resolvedMaterialStatus === "missing",
      ).length,
      needsReviewMaterials: includedRows.filter(
        (row) => row.resolvedMaterialStatus === "needs_review",
      ).length,
      uncoveredRequirements: uncoveredRequirementList.length,
      c17Gaps: c17Issues.length,
      volumeCount: outline.volumes.length,
      changesCount: countOutlineChanges(input.baselineOutline, outline),
    },
    rows,
    uncoveredRequirementList,
    c17Issues,
  };
}

/** Search and filter outline rows while preserving every ancestor of matched child nodes. */
export function filterOutlineRows(
  rows: readonly OutlineRowView[],
  criteria: {
    query?: string;
    filter?: OutlineRowFilter;
    volume?: string;
  },
): OutlineRowView[] {
  const query = criteria.query?.trim().toLowerCase() ?? "";
  const filter = criteria.filter ?? "all";
  const volume = criteria.volume?.trim() ?? "";

  if (!query && filter === "all" && !volume) {
    return [...rows];
  }

  const rowById = new Map(rows.map((row) => [row.id, row]));
  const visibleIds = new Set<string>();

  for (const row of rows) {
    if (volume && row.volume !== volume) continue;

    let filterMatch = true;
    switch (filter) {
      case "all":
        filterMatch = true;
        break;
      case "missing_material":
        filterMatch = row.included && row.resolvedMaterialStatus === "missing";
        break;
      case "needs_review":
        filterMatch = row.included && row.resolvedMaterialStatus === "needs_review";
        break;
      case "uncovered_req":
        filterMatch =
          row.included &&
          (row.resolvedRequirements.some(
            (req) => req.mustRespond && req.responses.length === 0,
          ) ||
            (row.kind === "authored" &&
              (!row.requirementIds || row.requirementIds.length === 0)));
        break;
      case "template":
        filterMatch = row.kind === "template";
        break;
      case "authored":
        filterMatch = row.kind === "authored";
        break;
      case "attachment":
        filterMatch = row.kind === "attachment";
        break;
      case "excluded":
        filterMatch = !row.included;
        break;
      case "c17":
        filterMatch = row.c17Issues.length > 0;
        break;
    }
    if (!filterMatch) continue;

    if (query) {
      const haystack = [
        row.number ?? "",
        row.title,
        row.expectedHeading ?? "",
        row.note ?? "",
        row.materialNote ?? "",
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(query)) continue;
    }

    let current: OutlineRowView | undefined = row;
    while (current && !visibleIds.has(current.id)) {
      visibleIds.add(current.id);
      current =
        current.parentId !== null ? rowById.get(current.parentId) : undefined;
    }
  }

  return rows.filter((row) => visibleIds.has(row.id));
}

/** Build the Stage-2 execution prompt sent after the human confirms the outline blueprint. */
export function buildOutlineExecutionPrompt(
  project: {
    name: string;
    deadline: string;
    vaultId: string | null;
    vaultName?: string | null;
  },
  outline: OutlineDocument,
  confirmation: { digest: string; confirmedAt: string },
): string {
  const volumeNames = outline.volumes.map((item) => item.name).join("、") || "默认分册";
  const includedCount = outline.nodes.filter((node) => node.included).length;
  const vaultLine = project.vaultId
    ? `企业知识库：${project.vaultName?.trim() ? `${project.vaultName.trim()}（${project.vaultId}）` : project.vaultId}`
    : "当前为无知识库模式";
  return [
    "人已在工作台确认编制大纲，请进入阶段二，严格按确认版大纲编制投标文件草稿。",
    `项目名称：${project.name}（截标日：${project.deadline}；${vaultLine}）`,
    `确认大纲摘要：${confirmation.digest.slice(0, 16)}…（确认时间：${confirmation.confirmedAt}；规划分册：${volumeNames}；启用章节：${includedCount} 节）`,
    "执行要求：",
    "1. 请先调用 `seal_outline(action=\"get\")` 读入最新人工确认版大纲（含增删改后的章节、单节 `note` 批注、绑定的 KB 记录、以及人上传至 `materials/` 的文件与 `renderedPages`）。",
    "2. 严格按确认分册与 `tenderSource.ranges` 调用 `seal_doc_extract` 建立分册草稿（跳过招标文件自身章节大标题，并仅保留大纲中 `included: true` 的章节）。",
    "3. 处理疑似空白并撰写全部启用自拟章节，逐条落实单节 `note` 写作批注；仅对 `materialMissing: true` 且无绑定材料的节点留待定黄标占位，普通正文与常规格式保持白底。",
    "4. 挂载全部已绑定知识库证据（`kb:<recordId>/<relPath>` 与 `{{record:...}}`）及大纲绑定的上传材料（单图或 PDF `renderedPages` 全部渲染页，一个不漏）。",
    "5. 若模板含目录占位页，先清理占位提示再调用 `insert_toc` 生成/刷新带真实页码的原生目录，并调用 `seal_requirements(action=\"patch\")` 回写响应位置。",
    "6. 反复运行 `seal_check` 直到 C17 大纲一致性缺口及其他 AI 可处理检查项清零，然后向人汇总交接。",
  ].join("\n");
}

/** Build a prompt asking AI to collaborate on revising one section or the overall outline. */
export function buildOutlineRevisionPrompt(
  project: { name: string },
  node: Pick<OutlineNode, "id" | "volume" | "title" | "kind" | "note"> | null,
  instruction: string,
): string {
  const trimmed = instruction.trim();
  const targetLine = node
    ? `目标节点：分册「${node.volume}」 / 节点 ID \`${node.id}\` / 标题「${node.title}」（类型：${node.kind}）${node.note ? `；当前批注：${node.note}` : ""}`
    : "目标范围：全局编制大纲";
  return [
    `请协助调整项目「${project.name}」的编制大纲（仅修改大纲，不要提取分册或改动草稿）。`,
    targetLine,
    `用户修改要求：${trimmed}`,
    "请先调用 `seal_outline(action=\"get\")` 查看当前大纲与材料清单，再调用 `seal_outline(action=\"patch\")` 或 `seal_outline(action=\"save\")` 更新大纲并汇报调整结果，提醒人在工作台确认。",
  ].join("\n");
}

/** Generate a unique valid outline node ID not colliding with existingIds. */
export function createOutlineNodeId(
  existingIds: ReadonlySet<string>,
  prefix = "node",
): string {
  const safePrefix =
    prefix.replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40) ||
    "node";
  let index = existingIds.size + 1;
  while (existingIds.has(`${safePrefix}-${index}`)) {
    index++;
  }
  return `${safePrefix}-${index}`;
}

/** Count rows matching each OutlineRowFilter for a given volume (or all volumes). */
export function outlineFilterCounts(
  rows: readonly OutlineRowView[],
  volume?: string,
): Record<OutlineRowFilter, number> {
  const scoped = volume ? rows.filter((row) => row.volume === volume) : rows;
  return {
    all: scoped.length,
    missing_material: scoped.filter(
      (row) => row.included && row.resolvedMaterialStatus === "missing",
    ).length,
    needs_review: scoped.filter(
      (row) => row.included && row.resolvedMaterialStatus === "needs_review",
    ).length,
    uncovered_req: scoped.filter(
      (row) =>
        row.included &&
        (row.resolvedRequirements.some(
          (req) => req.mustRespond && req.responses.length === 0,
        ) ||
          (row.kind === "authored" &&
            (!row.requirementIds || row.requirementIds.length === 0))),
    ).length,
    template: scoped.filter((row) => row.kind === "template").length,
    authored: scoped.filter((row) => row.kind === "authored").length,
    attachment: scoped.filter((row) => row.kind === "attachment").length,
    excluded: scoped.filter((row) => !row.included).length,
    c17: scoped.filter((row) => row.c17Issues.length > 0).length,
  };
}

/** Check whether a node can move up/down among siblings in the same volume and parentId. */
export function canMoveOutlineNode(
  outline: OutlineDocument,
  id: string,
  direction: "up" | "down",
): boolean {
  const target = outline.nodes.find((node) => node.id === id);
  if (!target) return false;
  const siblings = outline.nodes.filter(
    (node) => node.volume === target.volume && node.parentId === target.parentId,
  );
  const index = siblings.findIndex((node) => node.id === id);
  return direction === "up" ? index > 0 : index >= 0 && index < siblings.length - 1;
}

/** Check whether a node can be indented under its previous sibling. */
export function canIndentOutlineNode(outline: OutlineDocument, id: string): boolean {
  const target = outline.nodes.find((node) => node.id === id);
  if (!target) return false;
  const siblings = outline.nodes.filter(
    (node) => node.volume === target.volume && node.parentId === target.parentId,
  );
  return siblings.findIndex((node) => node.id === id) > 0;
}

/** Check whether a node can be outdented to its parent's sibling level. */
export function canOutdentOutlineNode(outline: OutlineDocument, id: string): boolean {
  const target = outline.nodes.find((node) => node.id === id);
  return !!target && target.parentId !== null;
}

/** Check whether a node and its entire subtree contain no non-optional lockedTemplate nodes. */
export function canDeleteOutlineNode(outline: OutlineDocument, id: string): boolean {
  if (!outline.nodes.some((node) => node.id === id)) return false;
  const childrenByParent = new Map<string, string[]>();
  for (const node of outline.nodes) {
    if (node.parentId !== null) {
      const list = childrenByParent.get(node.parentId) ?? [];
      list.push(node.id);
      childrenByParent.set(node.parentId, list);
    }
  }
  const stack = [id];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const currentId = stack.pop()!;
    if (seen.has(currentId)) continue;
    seen.add(currentId);
    const current = outline.nodes.find((node) => node.id === currentId);
    if (current?.lockedTemplate && !current.optional) return false;
    for (const childId of childrenByParent.get(currentId) ?? []) {
      stack.push(childId);
    }
  }
  return true;
}

/** Attach an evidence binding to a node (deduplicated by source+ref) and clear materialMissing. */
export function bindEvidenceToNode(
  outline: OutlineDocument,
  nodeId: string,
  binding: OutlineEvidenceBinding,
  meta?: { updatedAt?: string; updatedBy?: "agent" | "human" },
): OutlineDocument {
  const target = outline.nodes.find((node) => node.id === nodeId);
  if (!target) throw new Error(`节点不存在：${nodeId}`);
  const existing = target.evidence ?? [];
  const filtered = existing.filter(
    (item) => !(item.source === binding.source && item.ref === binding.ref),
  );
  const nextEvidence = [...filtered, binding];
  return updateOutlineNode(
    outline,
    nodeId,
    { evidence: nextEvidence, materialMissing: false },
    meta,
  );
}

/** Remove an evidence binding by source+ref from a node. */
export function unbindEvidenceFromNode(
  outline: OutlineDocument,
  nodeId: string,
  source: "kb" | "material",
  ref: string,
  meta?: { updatedAt?: string; updatedBy?: "agent" | "human" },
): OutlineDocument {
  const target = outline.nodes.find((node) => node.id === nodeId);
  if (!target) throw new Error(`节点不存在：${nodeId}`);
  const nextEvidence = (target.evidence ?? []).filter(
    (item) => !(item.source === source && item.ref === ref),
  );
  return updateOutlineNode(
    outline,
    nodeId,
    {
      evidence: nextEvidence,
      ...(nextEvidence.length === 0 && target.kind === "attachment"
        ? { materialMissing: undefined }
        : {}),
    },
    meta,
  );
}

export interface OutlineEditorSaveState {
  serverRevision: string;
  baselineOutline: OutlineDocument | null;
  draftOutline: OutlineDocument | null;
  undoStack: OutlineDocument[];
  redoStack: OutlineDocument[];
  conflictError: string;
  confirmMissing: boolean;
}

/**
 * Reconcile an in-flight `outline_save` response with any local edits made while waiting.
 * Only replaces the draft and clears Undo/Redo when no newer local edit occurred after dispatch.
 */
export function reconcileOutlineSaveResult(
  current: OutlineEditorSaveState,
  saved: { revision: string; outline: OutlineState },
  sentSeq: number,
  currentSeq: number,
): { state: OutlineEditorSaveState; syncedDraft: boolean } {
  const nextBaseline =
    saved.outline.kind === "value"
      ? saved.outline.outline
      : current.baselineOutline;
  if (currentSeq === sentSeq) {
    const nextDraft =
      saved.outline.kind === "value" ? saved.outline.outline : null;
    return {
      syncedDraft: true,
      state: {
        serverRevision: saved.revision,
        baselineOutline: nextDraft,
        draftOutline: nextDraft,
        undoStack: [],
        redoStack: [],
        conflictError: "",
        confirmMissing: false,
      },
    };
  }
  return {
    syncedDraft: false,
    state: {
      ...current,
      serverRevision: saved.revision,
      baselineOutline: nextBaseline,
      conflictError: "",
    },
  };
}

/** Abort confirmation if the user edited the outline after triggering the confirm flow. */
export function shouldAbortOutlineConfirm(
  confirmStartSeq: number,
  currentSeq: number,
): boolean {
  return currentSeq !== confirmStartSeq;
}

export interface OutlineConfirmFlowDeps {
  getEditSeq(): number;
  isDirty: boolean;
  initialRevision: string;
  saveDraft(): Promise<{ revision: string }>;
  confirmOutline(revision: string): Promise<{
    confirmed: boolean;
    digest: string;
    confirmedAt: string;
    prompt: string;
  }>;
  onConfirmFinished(): void;
  onClearDirty(): void;
  onReloadOverview(): void;
  sessionId?: string | null;
  sendPrompt(sessionId: string, prompt: string): void | Promise<void>;
  openReview(sessionId: string): void | Promise<void>;
  onReloadUnbound(): void;
}

/**
 * Shared async save-and-confirm coordinator used directly by OutlineEditor.
 * Guards both the in-flight save window and the in-flight confirm window against concurrent local edits.
 */
export async function runOutlineConfirmFlow(
  deps: OutlineConfirmFlowDeps,
): Promise<{
  confirmed: boolean;
  digest: string;
  confirmedAt: string;
  prompt: string;
}> {
  const confirmStartSeq = deps.getEditSeq();
  let rev = deps.initialRevision;
  if (deps.isDirty) {
    const saved = await deps.saveDraft();
    if (shouldAbortOutlineConfirm(confirmStartSeq, deps.getEditSeq())) {
      throw new Error(
        "保存期间大纲有新修改，已取消本次确认，请核对后重新确认。",
      );
    }
    rev = saved.revision;
  }
  if (shouldAbortOutlineConfirm(confirmStartSeq, deps.getEditSeq())) {
    throw new Error(
      "大纲在确认前发生新修改，已取消本次确认，请核对后重新确认。",
    );
  }
  const confirmed = await deps.confirmOutline(rev);
  deps.onConfirmFinished();
  deps.onReloadOverview();
  if (shouldAbortOutlineConfirm(confirmStartSeq, deps.getEditSeq())) {
    throw new Error(
      "确认期间大纲有新修改，已取消自动启动生成，请核对并重新保存确认。",
    );
  }
  deps.onClearDirty();
  if (deps.sessionId) {
    await deps.sendPrompt(deps.sessionId, confirmed.prompt);
    await deps.openReview(deps.sessionId);
  } else {
    deps.onReloadUnbound();
  }
  return confirmed;
}
