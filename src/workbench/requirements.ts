import type { CoverageMark } from "../core/bid/human-review.js";
import type {
  Requirement,
  RequirementsState,
} from "../core/bid/requirements.js";

export interface RequirementCoverageView {
  status: "none" | "covered" | "expired";
  draft?: string;
  address?: string;
  response?: string;
}

export interface RequirementRowView extends Requirement {
  c12Issues: string[];
  c14Issues: string[];
  coverage: RequirementCoverageView;
}

export type RequirementsViewModel =
  | { kind: "missing"; drafts: string[] }
  | { kind: "error"; reason: string; drafts: string[] }
  | {
      kind: "value";
      total: number;
      offset: number;
      limit: number;
      nextOffset: number | null;
      drafts: string[];
      summary: {
        total: number;
        mustRespond: number;
        c12Gaps: number;
        c14Errors: number;
        covered: number;
        expired: number;
      };
      items: RequirementRowView[];
    };

interface CheckIssueLike {
  id?: unknown;
  draft?: unknown;
  address?: unknown;
  reason?: unknown;
}

function issueReason(raw: unknown): { id: string; message: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const issue = raw as CheckIssueLike;
  if (typeof issue.id !== "string" || !issue.id) return null;
  const parts: string[] = [];
  if (typeof issue.draft === "string" && issue.draft) {
    parts.push(
      typeof issue.address === "string" && issue.address
        ? `${issue.draft} · ${issue.address}`
        : issue.draft,
    );
  }
  if (typeof issue.reason === "string" && issue.reason) parts.push(issue.reason);
  return { id: issue.id, message: parts.join("：") || "存在问题" };
}

/** Build the pure UI projection for the right-pane requirements checklist. */
export function buildRequirementsView(input: {
  state: RequirementsState;
  c12: readonly unknown[];
  c14: readonly unknown[];
  validMarks: readonly CoverageMark[];
  expiredIds: readonly string[];
  drafts: readonly string[];
  offset?: number;
  limit?: number;
}): RequirementsViewModel {
  const drafts = [...input.drafts];
  if (input.state.kind === "missing") return { kind: "missing", drafts };
  if (input.state.kind === "error")
    return { kind: "error", reason: input.state.reason, drafts };

  const offset = input.offset ?? 0;
  const limit = input.limit ?? 25;
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new Error("要求清单分页偏移无效");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    throw new Error("要求清单每页数量无效");

  const c12ById = new Map<string, string[]>();
  for (const raw of input.c12) {
    const parsed = issueReason(raw);
    if (!parsed) continue;
    const list = c12ById.get(parsed.id) ?? [];
    list.push(parsed.message);
    c12ById.set(parsed.id, list);
  }

  const c14ById = new Map<string, string[]>();
  for (const raw of input.c14) {
    const parsed = issueReason(raw);
    if (!parsed) continue;
    const list = c14ById.get(parsed.id) ?? [];
    list.push(parsed.message);
    c14ById.set(parsed.id, list);
  }

  const validById = new Map<string, CoverageMark>();
  for (const mark of input.validMarks) validById.set(mark.id, mark);
  const expired = new Set(input.expiredIds);

  const rows: RequirementRowView[] = input.state.items.map((item) => {
    const valid = validById.get(item.id);
    const coverage: RequirementCoverageView = valid
      ? {
          status: "covered",
          draft: valid.draft,
          address: valid.address,
          response: valid.response,
        }
      : expired.has(item.id)
        ? { status: "expired" }
        : { status: "none" };
    return {
      ...item,
      c12Issues: c12ById.get(item.id) ?? [],
      c14Issues: c14ById.get(item.id) ?? [],
      coverage,
    };
  });

  const paged = rows.slice(offset, offset + limit);
  const nextOffset = offset + paged.length < rows.length ? offset + paged.length : null;
  return {
    kind: "value",
    total: rows.length,
    offset,
    limit,
    nextOffset,
    drafts,
    summary: {
      total: rows.length,
      mustRespond: rows.filter((row) => row.mustRespond).length,
      c12Gaps: rows.filter((row) => row.c12Issues.length > 0).length,
      c14Errors: rows.filter((row) => row.c14Issues.length > 0).length,
      covered: rows.filter((row) => row.coverage.status === "covered").length,
      expired: rows.filter((row) => row.coverage.status === "expired").length,
    },
    items: paged,
  };
}

/** Format the right-pane subtitle displaying deadline and readable knowledge vault name. */
export function formatProjectSubtitle(input: {
  deadline: string;
  vaultId: string | null;
  vaultName?: string | null;
  noVaultLabel?: string;
  missingVaultLabel?: string;
}): string {
  if (!input.vaultId) {
    return `${input.deadline} · ${input.noVaultLabel ?? "无知识库模式"}`;
  }
  const name = input.vaultName?.trim();
  if (name) {
    return `${input.deadline} · ${name}`;
  }
  return `${input.deadline} · ${input.missingVaultLabel ?? "关联知识库不可用"}`;
}

/** Format the automatic initial user-facing prompt when starting a bid session. */
export function buildBidStartupPrompt(project: {
  name: string;
  deadline: string;
  vaultId: string | null;
  vaultName?: string | null;
  tenders: ReadonlyArray<{ copy: string }>;
}): string {
  const tenders = project.tenders.map((item) => item.copy).join("、");
  const vaultName = project.vaultName?.trim();
  const vaultNote = project.vaultId
    ? vaultName
      ? `关联企业知识库：${vaultName}（ID: ${project.vaultId}；使用 seal_kb_search / seal_kb_get 检索主体与证据）。`
      : `关联企业知识库：${project.vaultId}（使用 seal_kb_search / seal_kb_get 检索主体与证据）。`
    : "当前未关联企业知识库（无库模式：事实性内容允许填写但保持待定交人核对，不得编造主体资质、业绩或数据）。";
  return [
    "请先调用 `skill` 工具加载 `seal-bid` 操作手册，再严格按手册流程编写投标文件。",
    `项目名称：${project.name}`,
    `项目登记招标副本：${tenders || "见项目 tender/ 目录"}`,
    `截标日：${project.deadline}`,
    vaultNote,
    "不要用通用文件工具改写草稿、台账、requirements.json 或知识库，也不要尝试确认待定、接受原文改动、核实资料、标记要求覆盖或导出终稿。",
  ].join("\n");
}
