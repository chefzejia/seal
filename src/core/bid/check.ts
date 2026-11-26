import type { HostPort } from "../host.js";
import { compareDocuments } from "../docx/package-compare.js";
import { readableParagraphs, readOnlyHints } from "../docx/read-document.js";
import { resolveAddress } from "../docx/addresses.js";
import { validatePackageStructure } from "../docx/package-structure.js";
import { validatePackageImages } from "../docx/package-images.js";
import { auditSealPending } from "../docx/pending-audit.js";
import { sealRanges } from "../docx/seal-ranges.js";
import { bodyViewNodes } from "../docx/document-view.js";
import {
  currentHints,
  dismissalFingerprint,
  dismissalId,
  sameHint,
  type CurrentHint,
} from "./dismissals.js";
import { editableText, visibleOffsetBefore } from "../docx/visible-surgery.js";
import { sha256Hex } from "../docx/zip.js";
import { invalidDates } from "./dates.js";
import { isCurrentAuthorization } from "./authorization.js";
import { pendingFingerprint } from "./pending-fingerprint.js";
import {
  changeFingerprint,
  coverageFingerprint,
  type AcceptedChange,
  type CoverageMark,
  type ReviewContext,
} from "./human-review.js";
import type { BidLedger, PendingRecord, ProjectMetadata } from "./project.js";
import { hasUnresolvedLedgerIncident, resolveLedger } from "./ledger-integrity.js";
import { auditImageLayout } from "../docx/layout.js";
import { checkMoney } from "./money.js";
import { emptyResults, type DraftCheckReport } from "./report.js";
import {
  requirementCoverageDigest,
  type RequirementsState,
} from "./requirements.js";

export interface FactCheckState {
  id: string;
  verified: boolean;
  issues: string[];
  reviewableIssues?: string[];
  evidenceDates: Array<{
    recordId: string;
    validity: "expired" | "expiring_soon";
  }>;
}

export interface IdentityContext {
  creditCode?: string;
  forbiddenAffiliates: string[];
  thirdPartyCreditCodes: string[];
}
export function checkIdentity(
  blocks: readonly { address: string; text: string }[],
  identity: IdentityContext,
) {
  const issues: Array<{ address: string; value: string; reason: string }> = [];
  const forbidden = identity.forbiddenAffiliates.filter((value) =>
    value.trim(),
  );
  const allowedCodes = new Set(
    [identity.creditCode, ...identity.thirdPartyCreditCodes]
      .filter((value): value is string => !!value)
      .map((value) => value.toLocaleUpperCase("en-US")),
  );
  const codePattern =
    /(?<![\p{L}\p{N}])[0-9A-HJ-NP-RT-UW-Y]{18}(?![\p{L}\p{N}])/giu;
  for (const block of blocks) {
    for (const name of forbidden)
      if (block.text.includes(name))
        issues.push({
          address: block.address,
          value: name,
          reason: "草稿出现禁用关联企业名称",
        });
    for (const match of block.text.matchAll(codePattern))
      if (!allowedCodes.has(match[0].toLocaleUpperCase("en-US")))
        issues.push({
          address: block.address,
          value: match[0],
          reason: "草稿出现与本企业不同且不属于允许第三方的统一社会信用代码",
        });
  }
  return issues;
}

export interface CoverageEvaluation {
  validMarks: CoverageMark[];
  expiredIds: Set<string>;
  invalidAuthorizations: Array<{ item: string; reason: string }>;
}

export async function evaluateCoverageMarks(input: {
  marks: readonly unknown[];
  draft: string;
  xml: string;
  root: string;
  secret: Uint8Array | null;
  context: ReviewContext;
  requirements?: RequirementsState;
  knownDrafts?: readonly string[];
  includeOrphanCoverage?: boolean;
}): Promise<CoverageEvaluation> {
  const validMarks: CoverageMark[] = [];
  const expiredIds = new Set<string>();
  const invalidAuthorizations: Array<{ item: string; reason: string }> = [];
  for (const value of input.marks) {
    if (!value || typeof value !== "object") {
      invalidAuthorizations.push({ item: "", reason: "覆盖授权记录无效" });
      continue;
    }
    const mark = value as Partial<CoverageMark>;
    if (
      typeof mark.id !== "string" ||
      typeof mark.draft !== "string" ||
      typeof mark.address !== "string" ||
      typeof mark.requirement !== "string" ||
      typeof mark.response !== "string"
    ) {
      invalidAuthorizations.push({ item: "", reason: "覆盖授权记录无效" });
      continue;
    }
    if (mark.draft !== input.draft) {
      if (
        input.knownDrafts &&
        !input.knownDrafts.includes(mark.draft) &&
        input.includeOrphanCoverage !== false
      ) {
        invalidAuthorizations.push({
          item: mark.id,
          reason: "覆盖授权引用了不存在的分册",
        });
      }
      continue;
    }
    const authorized =
      !!input.secret &&
      (await isCurrentAuthorization(input.secret, mark.authorization, {
        kind: "coverage",
        project: input.root,
        item: mark.id,
        fingerprint: coverageFingerprint(mark as CoverageMark, input.context),
      }));
    if (!authorized) {
      invalidAuthorizations.push({
        item: mark.id,
        reason: "覆盖授权签名无效或内容已变化",
      });
      continue;
    }
    let matchesDraft = false;
    try {
      matchesDraft =
        editableText(resolveAddress(input.xml, mark.address).xml) ===
        mark.response;
    } catch {
      matchesDraft = false;
    }
    if (!matchesDraft) {
      expiredIds.add(mark.id);
      continue;
    }
    if (input.requirements) {
      if (input.requirements.kind !== "value") {
        expiredIds.add(mark.id);
        continue;
      }
      const req = input.requirements.items.find((item) => item.id === mark.id);
      if (!req || mark.requirement !== requirementCoverageDigest(req)) {
        expiredIds.add(mark.id);
        continue;
      }
    }
    validMarks.push(mark as CoverageMark);
  }
  return { validMarks, expiredIds, invalidAuthorizations };
}

export async function checkDraft(
  host: HostPort,
  input: {
    name: string;
    root: string;
    draft: Uint8Array;
    base: Uint8Array;
    ledger: unknown;
    project: ProjectMetadata;
    secret: Uint8Array | null;
    anchor?: unknown;
    factStates?: readonly FactCheckState[];
    identity?: {
      creditCode?: string;
      forbiddenAffiliates: string[];
      thirdPartyCreditCodes: string[];
    };
    identityError?: string;
    requirements?: { C12: unknown[]; C14: unknown[] };
    outline?: { C17: unknown[]; invalidAuthorization?: { item: string; reason: string } };
    requirementsState?: RequirementsState;
    knownDrafts?: readonly string[];
    includeOrphanCoverage?: boolean;
  },
): Promise<DraftCheckReport> {
  const { name, root, draft, base, project, secret } = input;
  const ledger = await resolveLedger(input.ledger, root, secret, input.anchor);
  const baseValid =
    typeof ledger.bases?.[name] === "string" &&
    ledger.bases[name] === sha256Hex(base);
  let parts: Map<string, Uint8Array>;
  try {
    parts = await validatePackageStructure(draft);
  } catch (error) {
    return {
      draft: name,
      complete: false,
      results: {
        ...emptyResults(),
        C01: [
          { reason: error instanceof Error ? error.message : String(error) },
        ],
      },
      limitations: ["文档结构损坏，其他检查未执行"],
    };
  }
  const images = await validatePackageImages(parts, host);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const xml = decoder.decode(parts.get("word/document.xml")!);
  let baseParts: Map<string, Uint8Array>;
  try {
    baseParts = await validatePackageStructure(base);
  } catch {
    return {
      draft: name,
      complete: false,
      results: {
        ...emptyResults(),
        C01: images,
        C06: [{ reason: "分册基准无法核验，原文差异未知" }],
        C07: [{ reason: "分册基准无法核验，内容丢失未知" }],
        C15: [{ reason: "分册基准缺失或损坏" }],
      },
      limitations: ["分册基准无法读取，其他检查未执行"],
    };
  }
  const differences = await compareDocuments(base, draft);
  let ranges: ReturnType<typeof sealRanges> = [];
  try {
    ranges = sealRanges(xml);
  } catch {
    /* C10 reports malformed or missing ranges. */
  }
  const open: Array<
      PendingRecord & { address?: string; value?: string; offset?: number }
    > = [],
    invalidAuthorizations: Array<{ reason: string; item: string }> = [];
  const confirmed = new Set<string>();
  const incident = ledger.integrityIncident;
  const unresolvedIncident = await hasUnresolvedLedgerIncident(
    ledger,
    root,
    secret,
  );
  if (unresolvedIncident && incident) {
    invalidAuthorizations.push({ item: "ledger", reason: incident.reason });
  }
  let bodyNodes: ReturnType<typeof bodyViewNodes> | undefined;
  for (const item of ledger.pending.filter((entry) => entry.draft === name)) {
    if (item.status === "removed") continue;
    const range = ranges.find(
      (candidate) => candidate.name === `_Seal_P_${item.id}`,
    );
    const current =
      item.status === "confirmed" &&
      !!range &&
      !!secret &&
      (await isCurrentAuthorization(secret, item.confirmation, {
        kind: "confirm",
        project: root,
        item: item.id,
        fingerprint: pendingFingerprint(item, range.text, {
          vaultId: project.vaultId,
          deadline: project.deadline,
        }),
      }));
    if (current) {
      confirmed.add(item.id);
      continue;
    }
    if (item.status === "confirmed")
      invalidAuthorizations.push({
        reason: "待定确认签名无效或内容已变化",
        item: item.id,
      });
    let address: string | undefined, offset: number | undefined;
    if (range) {
      bodyNodes ??= bodyViewNodes(xml);
      const locate = (nodes: ReturnType<typeof bodyViewNodes>) => {
        for (const node of nodes)
          if (node.start <= range.startXml && node.end >= range.endXml) {
            if (node.kind === "paragraph" || node.kind === "cell") {
              address = node.address;
              offset = visibleOffsetBefore(
                node.xml,
                range.startXml - node.start,
              );
            }
            locate(node.children);
          }
      };
      locate(bodyNodes);
    }
    open.push({
      ...item,
      ...(range ? { value: range.text } : {}),
      ...(address === undefined ? {} : { address, offset }),
    });
  }
  const context: ReviewContext = {
    root,
    vaultId: project.vaultId,
    deadline: project.deadline,
  };
  const factIssues: Array<{ id: string; reason: string }> = [];
  const factStates = new Map(
    (input.factStates ?? []).map((state) => [state.id, state]),
  );
  const evidenceIssues: Array<{
    id: string;
    recordId: string;
    validity: "expired" | "expiring_soon";
    reason: string;
  }> = [];
  const seenFillIds = new Set<string>();
  const activeFactIds = new Set<string>();
  for (const fill of ledger.fills) {
    if (
      !fill ||
      typeof fill !== "object" ||
      typeof fill.draft !== "string" ||
      typeof fill.id !== "string" ||
      !fill.id ||
      typeof fill.resolvedValue !== "string" ||
      typeof fill.verified !== "boolean" ||
      (fill.status !== undefined &&
        fill.status !== "active" &&
        fill.status !== "removed")
    ) {
      factIssues.push({ id: "", reason: "事实引用记录无效" });
      continue;
    }
    if (fill.draft !== name) continue;
    if (seenFillIds.has(fill.id)) {
      factIssues.push({ id: fill.id, reason: "事实引用编号重复" });
      continue;
    }
    seenFillIds.add(fill.id);
    if (fill.status === "removed") continue;
    activeFactIds.add(fill.id);
    const marker =
      fill.sealKind === "pending" ? `_Seal_P_${fill.id}` : `_Seal_F_${fill.id}`;
    const range = ranges.find((candidate) => candidate.name === marker);
    const state = factStates.get(fill.id);
    const reviewed = fill.sealKind === "pending" && confirmed.has(fill.id);
    const reasons = [
      ...(!reviewed && !(state?.verified ?? fill.verified)
        ? ["事实来源未核实"]
        : []),
      ...(!range
        ? ["事实引用范围缺失"]
        : range.text !== fill.resolvedValue
          ? ["事实引用内容已变化"]
          : []),
      ...(state?.issues ?? []),
      ...(!reviewed ? (state?.reviewableIssues ?? []) : []),
    ];
    for (const reason of new Set(reasons))
      factIssues.push({ id: fill.id, reason });
    for (const { recordId, validity } of state?.evidenceDates ?? []) {
      evidenceIssues.push({
        id: fill.id,
        recordId,
        validity,
        reason:
          validity === "expired"
            ? "草稿引用的证据已过期"
            : "草稿引用的证据将在 60 天内到期",
      });
    }
  }
  for (const range of ranges)
    if (
      range.name.startsWith("_Seal_F_") &&
      !activeFactIds.has(range.name.slice("_Seal_F_".length))
    )
      factIssues.push({
        id: range.name.slice("_Seal_F_".length),
        reason: "事实引用缺少台账记录",
      });
  const openHints: CurrentHint[] = [],
    agentHints: Array<CurrentHint & { reason: string }> = [];
  for (const hint of currentHints(xml, name)) {
    const dismissal = ledger.dismissals?.find((record) =>
      sameHint(record, hint),
    );
    if (!dismissal || !dismissal.reason?.trim()) {
      openHints.push(hint);
      continue;
    }
    const kind = dismissal.actor === "human" ? "dismiss" : "acknowledge";
    const valid =
      !!secret &&
      !!dismissal.authorization &&
      (await isCurrentAuthorization(secret, dismissal.authorization, {
        kind,
        project: root,
        item: dismissalId(dismissal),
        fingerprint: dismissalFingerprint(dismissal, context),
      }));
    if (dismissal.authorization && !valid)
      invalidAuthorizations.push({
        item: hint.id,
        reason: "空白处置签名无效或内容已变化",
      });
    if (!valid) {
      if (dismissal.actor === "agent")
        agentHints.push({ ...hint, reason: dismissal.reason });
      else openHints.push(hint);
    }
  }
  const accepted = new Set<string>();
  for (const value of ledger.acceptedChanges) {
    if (!value || typeof value !== "object") {
      invalidAuthorizations.push({ item: "", reason: "原文改动授权记录无效" });
      continue;
    }
    const record = value as Partial<AcceptedChange>;
    if (typeof record.draft !== "string" || typeof record.id !== "string") {
      invalidAuthorizations.push({ item: "", reason: "原文改动授权记录无效" });
      continue;
    }
    if (record.draft !== name) continue;
    const difference = differences.find(
      (item) =>
        item.id === record.id &&
        ["modified", "deleted", "formatChanged", "objectLost"].includes(
          item.kind,
        ),
    );
    const valid =
      difference !== undefined &&
      !!secret &&
      (await isCurrentAuthorization(secret, record.authorization, {
        kind: "accept",
        project: root,
        item: difference.id,
        fingerprint: changeFingerprint(name, difference, context),
      }));
    if (valid) accepted.add(difference!.id);
    else
      invalidAuthorizations.push({
        item: record.id ?? "",
        reason: "原文改动授权签名无效或内容已变化",
      });
  }
  const coverageEvaluation = await evaluateCoverageMarks({
    marks: ledger.requirements,
    draft: name,
    xml,
    root,
    secret,
    context,
    knownDrafts: input.knownDrafts ?? project.drafts,
    includeOrphanCoverage: input.includeOrphanCoverage,
    ...(input.requirementsState
      ? { requirements: input.requirementsState }
      : {}),
  });
  invalidAuthorizations.push(...coverageEvaluation.invalidAuthorizations);
  if (input.outline?.invalidAuthorization) {
    invalidAuthorizations.push(input.outline.invalidAuthorization);
  }
  const readonlyHints = readOnlyHints(parts);
  const identityIssues: Array<{
    address: string;
    value: string;
    reason: string;
  }> = [];
  if (input.identity)
    identityIssues.push(
      ...checkIdentity(readableParagraphs(parts), input.identity),
    );
  if (input.identityError)
    identityIssues.push({
      address: "",
      value: "",
      reason: input.identityError,
    });
  return {
    draft: name,
    complete: true,
    readonlyHints,
    results: {
      C01: images,
      C02: [...openHints, ...readonlyHints],
      C03: agentHints,
      C04:
        unresolvedIncident && incident?.recoveryNeeded
          ? [...open, { id: "ledger", reason: "台账无法核验，待定项状态未知" }]
          : open,
      C05: [
        ...open.filter((item) =>
          item.reasons.some((reason) => reason.source === "unverified"),
        ),
        ...factIssues,
      ],
      C08: evidenceIssues,
      C09: identityIssues,
      C06: differences.filter(
        (item) =>
          ["modified", "deleted", "formatChanged"].includes(item.kind) &&
          !accepted.has(item.id),
      ),
      C07: differences.filter(
        (item) => item.kind === "objectLost" && !accepted.has(item.id),
      ),
      C10: auditSealPending(
        xml,
        open.map((item) => `_Seal_P_${item.id}`),
      ),
      C11: readableParagraphs(parts).flatMap((block) =>
        invalidDates(block.text).map((date) => ({
          address: block.address,
          ...date,
        })),
      ),
      C12: input.requirements?.C12 ?? [],
      C13: checkMoney(readableParagraphs(parts)),
      C14: input.requirements?.C14 ?? [],
      C16: auditImageLayout(
        xml,
        decoder.decode(parts.get("word/styles.xml") ?? new Uint8Array()),
      ),
      C17: input.outline?.C17 ?? [],
      C15: [
        ...(!baseValid
          ? [{ reason: "分册基准与已封印摘要不一致或摘要缺失" }]
          : []),
        ...(ledger.drafts[name] === sha256Hex(draft)
          ? []
          : [{ reason: "草稿与台账摘要不一致" }]),
        ...invalidAuthorizations,
      ],
    },
    limitations: baseValid
      ? []
      : ["分册基准未经核验，原文差异和内容丢失检查不能作为合格结论"],
  };
}
