import type {
  HealthIssue,
  HealthReport,
  KbEntry,
  PendingBatchSummary,
} from "../core/kb/types.js";

export type KnowledgeVerification =
  | "verified"
  | "unverified"
  | "not_applicable";

export interface VaultSummary {
  recordCount: number;
  evidenceCount: number;
  materialCount: number;
  expiring: number;
  unknown: number;
  unverified: number;
}

export interface VaultSummaryLineInput {
  creditCode?: string | null;
  recordCount?: number;
  evidenceCount?: number;
  materialCount?: number;
  expiring?: number;
  unknown?: number;
  unverified?: number;
}

export interface VaultSummaryLabels {
  items: string;
  evidence: string;
  materials: string;
  expiring: string;
  unknown: string;
  unverified: string;
}

export interface VaultSummaryLineOptions {
  locale?: "zh" | "en";
  labels?: VaultSummaryLabels;
}

export interface VaultOverviewSummary extends VaultSummary {
  pendingCandidateCount: number;
  subjectName?: string;
  subjectVerified: boolean;
}

export interface KnowledgeCatalogItem {
  id: string;
  kind: "record" | "material";
  title: string;
  type: string;
  validity: HealthReport["records"][number]["validity"];
  verification: KnowledgeVerification;
  verified: boolean;
  number?: string;
  validUntil?: string;
  imageCount?: number;
  firstImageIndex?: number;
}

export interface KnowledgeCatalogView extends VaultSummary {
  count: number;
  items: KnowledgeCatalogItem[];
  types: string[];
  issues: HealthIssue[];
  issueCount: number;
  issueOffset: number;
  nextIssueOffset: number | null;
  nextOffset: number | null;
  pendingBatches: PendingBatchSummary[];
}

const defaultLabels: Record<"zh" | "en", VaultSummaryLabels> = {
  zh: {
    items: "资料",
    evidence: "证据",
    materials: "素材",
    expiring: "即将过期",
    unknown: "效期未知",
    unverified: "未核实",
  },
  en: {
    items: "Items",
    evidence: "Evidence",
    materials: "Materials",
    expiring: "Expiring soon",
    unknown: "Unknown validity",
    unverified: "Unverified",
  },
};

/** Summarize vault inventory and verification counts across records, materials, and health issues. */
export function summarizeVault(input: {
  records: readonly Pick<HealthReport["records"][number], "validity">[];
  materials: readonly unknown[];
  issues: readonly Pick<HealthIssue, "code">[];
}): VaultSummary {
  const evidenceCount = input.records.length;
  const materialCount = input.materials.length;
  return {
    recordCount: evidenceCount + materialCount,
    evidenceCount,
    materialCount,
    expiring: input.records.filter(
      (record) => record.validity === "expiring_soon",
    ).length,
    unknown: input.records.filter((record) => record.validity === "unknown")
      .length,
    unverified: input.issues.filter(
      (issue) =>
        issue.code === "subject_unverified" ||
        issue.code === "record_unverified",
    ).length,
  };
}

/** Unified readiness predicate for an entity subject across overview badges and subject detail cards. */
export function isSubjectReady(input: {
  subject?: Pick<KbEntry, "fields" | "verified" | "verifiedFields"> & {
    issues?: readonly string[];
  };
  issues?: readonly { code: string; kind?: string }[];
}): boolean {
  const subject = input.subject;
  if (!subject) return false;
  const rawLegalName = subject.fields.legalName;
  const hasLegalName =
    typeof rawLegalName === "string" && rawLegalName.trim().length > 0;
  if (!hasLegalName || !subject.verified) return false;
  if (!subject.verifiedFields.includes("legalName")) return false;
  if (Array.isArray(subject.issues) && subject.issues.length > 0) return false;
  const blockingSubjectCodes = new Set([
    "subject_unverified",
    "subject_missing",
    "credit_code_invalid",
    "verification_invalid",
    "date_invalid",
  ]);
  return !(input.issues ?? []).some(
    (issue) =>
      blockingSubjectCodes.has(issue.code) &&
      (!issue.kind || issue.kind === "subject"),
  );
}

/** Strip raw internal `files/batch-...` storage paths and markdown image links from candidate preview text. */
export function formatCandidatePreviewBody(body: string): string {
  const cleanedLines = body
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (/^!\[[^\]]*\]\((?:\.\.\/)*files\/[^)]+\)$/.test(trimmed)) {
        return false;
      }
      if (
        /^(?:原\s*PDF\s*存档|图片路径|原图路径|归档路径)[：:]\s*`?files\/batch-[a-z0-9-]+\/[^`]+`?$/i.test(
          trimmed,
        )
      ) {
        return false;
      }
      return true;
    });
  return cleanedLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Summarize vault inventory, verification counts, subject status, and pending candidates for overview cards. */
export function summarizeVaultOverview(input: {
  records: readonly Pick<HealthReport["records"][number], "validity">[];
  materials: readonly unknown[];
  issues: readonly { code: string; kind?: string }[];
  subject?: Pick<KbEntry, "fields" | "verified" | "verifiedFields"> & {
    issues?: readonly string[];
  };
  pendingBatches?: readonly Pick<PendingBatchSummary, "pendingCount">[];
}): VaultOverviewSummary {
  const base = summarizeVault(input);
  const pendingCandidateCount = (input.pendingBatches ?? []).reduce(
    (sum, batch) => sum + batch.pendingCount,
    0,
  );
  const rawLegalName = input.subject?.fields.legalName;
  const subjectName =
    typeof rawLegalName === "string" && rawLegalName.trim()
      ? rawLegalName.trim()
      : undefined;
  const subjectVerified = isSubjectReady({
    subject: input.subject,
    issues: input.issues,
  });
  return {
    ...base,
    pendingCandidateCount,
    ...(subjectName ? { subjectName } : {}),
    subjectVerified,
  };
}

/** Format a vault summary card line without empty-field separators and with evidence/material breakdown. */
export function formatVaultSummaryLine(
  input: VaultSummaryLineInput,
  options: VaultSummaryLineOptions = {},
): string {
  const locale = options.locale === "en" ? "en" : "zh";
  const labels = options.labels ?? defaultLabels[locale];
  const materialCount = input.materialCount ?? 0;
  const recordCount =
    input.recordCount ??
    (input.evidenceCount !== undefined || input.materialCount !== undefined
      ? (input.evidenceCount ?? 0) + materialCount
      : 0);
  const evidenceCount =
    input.evidenceCount ?? Math.max(0, recordCount - materialCount);
  const expiring = input.expiring ?? 0;
  const unknown = input.unknown ?? 0;
  const unverified = input.unverified ?? 0;

  const countSegment =
    materialCount > 0
      ? locale === "en"
        ? `${labels.items} ${recordCount} (${labels.evidence} ${evidenceCount} · ${labels.materials} ${materialCount})`
        : `${labels.items} ${recordCount}（${labels.evidence} ${evidenceCount} · ${labels.materials} ${materialCount}）`
      : `${labels.items} ${recordCount}`;

  const creditCode =
    typeof input.creditCode === "string" ? input.creditCode.trim() : "";

  return [
    creditCode,
    countSegment,
    `${labels.expiring} ${expiring}`,
    `${labels.unknown} ${unknown}`,
    `${labels.unverified} ${unverified}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function matchesVerificationFilter(
  verification: KnowledgeVerification,
  filter: string,
): boolean {
  if (!filter) return true;
  if (filter === "yes") return verification === "verified";
  if (filter === "no") return verification === "unverified";
  if (filter === "not_applicable") return verification === "not_applicable";
  return false;
}

const renderableImagePattern = /\.(png|jpe?g|gif|bmp|webp|svg)$/i;

function extractImageMeta(filesValue: unknown): {
  imageCount: number;
  firstImageIndex?: number;
} {
  if (!Array.isArray(filesValue)) return { imageCount: 0 };
  let imageCount = 0;
  let firstImageIndex: number | undefined;
  for (let i = 0; i < filesValue.length; i++) {
    const file = filesValue[i];
    if (typeof file === "string" && renderableImagePattern.test(file)) {
      if (firstImageIndex === undefined) firstImageIndex = i;
      imageCount++;
    }
  }
  return firstImageIndex === undefined
    ? { imageCount: 0 }
    : { imageCount, firstImageIndex };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Project records and materials into a filterable catalog with explicit tri-state verification. */
export function buildKnowledgeCatalog(input: {
  records: readonly HealthReport["records"][number][];
  materials: readonly KbEntry[];
  issues: readonly HealthIssue[];
  kind?: "record" | "material";
  query?: string;
  type?: string;
  validity?: string;
  verified?: string;
  offset?: number;
  issueOffset?: number;
  limit?: number;
  pendingBatches?: readonly PendingBatchSummary[];
}): KnowledgeCatalogView {
  const offset = input.offset ?? 0;
  const issueOffset = input.issueOffset ?? 0;
  const limit = input.limit ?? 25;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(issueOffset) ||
    issueOffset < 0
  ) {
    throw new Error("资料分页位置无效");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("资料分页大小无效");
  }

  const projected: Array<KnowledgeCatalogItem & { searchText: string }> = [
    ...input.records.map((entry) => {
      const imageMeta = extractImageMeta(entry.fields.files);
      const number = optionalString(entry.fields.number);
      const validUntil = optionalString(entry.fields.validUntil);
      return {
        id: entry.id,
        kind: "record" as const,
        title:
          typeof entry.fields.title === "string" && entry.fields.title
            ? entry.fields.title
            : entry.id,
        type: typeof entry.fields.type === "string" ? entry.fields.type : "",
        validity: entry.validity,
        verification: (entry.verified
          ? "verified"
          : "unverified") as KnowledgeVerification,
        verified: entry.verified,
        ...(number ? { number } : {}),
        ...(validUntil ? { validUntil } : {}),
        imageCount: imageMeta.imageCount,
        ...(imageMeta.firstImageIndex !== undefined
          ? { firstImageIndex: imageMeta.firstImageIndex }
          : {}),
        searchText: JSON.stringify([entry.fields, entry.body]).toLocaleLowerCase(),
      };
    }),
    ...input.materials.map((entry) => {
      const imageMeta = extractImageMeta(entry.fields.files);
      return {
        id: entry.id,
        kind: "material" as const,
        title:
          typeof entry.fields.title === "string" && entry.fields.title
            ? entry.fields.title
            : entry.id,
        type: "material",
        validity: "not_applicable" as const,
        verification: "not_applicable" as const,
        verified: false,
        imageCount: imageMeta.imageCount,
        ...(imageMeta.firstImageIndex !== undefined
          ? { firstImageIndex: imageMeta.firstImageIndex }
          : {}),
        searchText: JSON.stringify([entry.fields, entry.body]).toLocaleLowerCase(),
      };
    }),
  ];

  const query = (input.query ?? "").trim().toLocaleLowerCase();
  const kindFilter = input.kind ?? "";
  const typeFilter = input.type ?? "";
  const validityFilter = input.validity ?? "";
  const verifiedFilter = input.verified ?? "";

  const filtered = projected.filter(
    (item) =>
      (!kindFilter || item.kind === kindFilter) &&
      (!query || item.searchText.includes(query)) &&
      (!typeFilter || item.type === typeFilter) &&
      (!validityFilter || item.validity === validityFilter) &&
      matchesVerificationFilter(item.verification, verifiedFilter),
  );

  const types = [
    ...new Set(
      projected
        .map((item) => item.type)
        .filter((value): value is string => value.length > 0),
    ),
  ];

  const summary = summarizeVault({
    records: input.records,
    materials: input.materials,
    issues: input.issues,
  });

  return {
    ...summary,
    count: filtered.length,
    items: filtered
      .slice(offset, offset + limit)
      .map(({ searchText: _searchText, ...item }) => item),
    types,
    issues: input.issues.slice(issueOffset, issueOffset + limit),
    issueCount: input.issues.length,
    issueOffset,
    nextIssueOffset:
      issueOffset + limit < input.issues.length ? issueOffset + limit : null,
    nextOffset: offset + limit < filtered.length ? offset + limit : null,
    pendingBatches: [...(input.pendingBatches ?? [])],
  };
}

const fieldLabels: Record<"zh" | "en", Readonly<Record<string, string>>> = {
  zh: {
    legalName: "法定名称",
    creditCode: "统一社会信用代码",
    legalRepresentative: "法定代表人",
    registeredCapital: "注册资本",
    establishedOn: "成立日期",
    address: "住所/地址",
    phone: "联系电话",
    email: "电子邮箱",
    bankName: "开户银行",
    bankAccount: "银行账号",
    forbiddenAffiliates: "禁止混用关联企业",
    thirdPartyHolders: "允许第三方持证方",
    type: "资料类型",
    title: "标题",
    number: "编号",
    issuedOn: "签发日期",
    holder: "持证方",
    employer: "任职单位",
    validUntil: "有效期至",
    client: "客户",
    projectName: "项目名称",
    amount: "金额",
    signedOn: "签约日期",
    source: "来源",
    tags: "标签",
    files: "原件与图片",
  },
  en: {
    legalName: "Legal name",
    creditCode: "Credit code",
    legalRepresentative: "Legal representative",
    registeredCapital: "Registered capital",
    establishedOn: "Established on",
    address: "Address",
    phone: "Phone",
    email: "Email",
    bankName: "Bank",
    bankAccount: "Bank account",
    forbiddenAffiliates: "Forbidden entities",
    thirdPartyHolders: "Allowed third-party holders",
    type: "Record type",
    title: "Title",
    number: "Number",
    issuedOn: "Issued on",
    holder: "Holder",
    employer: "Employer",
    validUntil: "Valid until",
    client: "Client",
    projectName: "Project name",
    amount: "Amount",
    signedOn: "Signed on",
    source: "Source",
    tags: "Tags",
    files: "Originals and images",
  },
};

/** Resolve a human-readable localized label for a knowledge-base field key. */
export function kbFieldLabel(
  field: string,
  locale: "zh" | "en" = "zh",
): string {
  const dict = locale === "en" ? fieldLabels.en : fieldLabels.zh;
  return dict[field] ?? field;
}

/** Format a knowledge-base health issue message cleanly without exposing raw internal field keys. */
export function formatHealthIssueMessage(
  issue: Pick<HealthIssue, "code" | "field" | "message">,
  locale: "zh" | "en" = "zh",
): string {
  const label = issue.field ? kbFieldLabel(issue.field, locale) : "";
  if (locale === "en") {
    switch (issue.code) {
      case "subject_unverified":
        return label
          ? `Entity field "${label}" is not verified`
          : "Entity field is not verified";
      case "subject_missing":
        return "Entity legal name is missing";
      case "credit_code_invalid":
        return "Invalid credit code format or check digit";
      case "record_unverified":
        return "Evidence record is not verified";
      case "field_missing":
        return label
          ? `Required field "${label}" is missing`
          : "Required field is missing";
      case "date_invalid":
        return label
          ? `Date field "${label}" is not a valid calendar date`
          : "Date field is not a valid calendar date";
      case "field_unknown":
        return issue.field
          ? `Custom field "${issue.field}" preserved`
          : issue.message;
      case "validity_unknown":
        return "Evidence validity is unknown";
      case "record_type_missing":
        return "Record type is missing";
      case "expired":
        return "Evidence expired on reference date";
      case "expiring_soon":
        return "Evidence expires within 60 days";
      case "forbidden_subject":
        return "Evidence holder is a forbidden entity";
      case "subject_mismatch":
        return "Evidence holder does not match entity or allowed third parties";
      case "subject_unknown":
        return "Evidence holder is unknown";
      case "entry_malformed":
        return "Entry could not be parsed";
      case "record_duplicate":
        return "Duplicate record with the same type and number";
      case "file_missing":
        return "Referenced file or attachment is missing";
      case "image_invalid":
        return "Image cannot be decoded";
      case "verification_invalid":
        return label
          ? `Verification signature invalid or content changed for "${label}"`
          : "Verification signature invalid or content changed";
      default:
        return issue.message;
    }
  }
  switch (issue.code) {
    case "subject_unverified":
      return label ? `主体字段「${label}」尚未核实` : issue.message;
    case "field_missing":
      return label ? `关键字段「${label}」缺失` : issue.message;
    case "date_invalid":
      return label ? `日期字段「${label}」不是合法日历日期` : issue.message;
    case "verification_invalid":
      return label ? `字段「${label}」核实签名无效或内容已变化` : issue.message;
    default:
      return issue.message;
  }
}

/** Determine the visual badge tone for the vault unverified counter. */
export function unverifiedBadgeTone(input: {
  recordCount: number;
  subjectVerified: boolean;
  unverified: number;
}): "warn" | "neutral" | "ok" {
  if (input.unverified > 0) return "warn";
  if (input.recordCount === 0 && !input.subjectVerified) return "neutral";
  return "ok";
}

/** Format candidate source and location subtitle without duplicating identical or overlapping values. */
export function formatCandidateLocation(
  source?: unknown,
  location?: unknown,
): string {
  const s = typeof source === "string" ? source.trim() : "";
  const l = typeof location === "string" ? location.trim() : "";
  if (!s) return l;
  if (!l) return s;
  if (s === l || l.includes(s)) return l;
  if (s.includes(l)) return s;
  return `${s} · ${l}`;
}

/** Determine the label key and visual variant for the Knowledge Centre import toggle button. */
export function importToggleState(ingestOpen: boolean): {
  labelKey: "hideImport" | "importMaterials";
  variant: "secondary" | "primary";
} {
  return ingestOpen
    ? { labelKey: "hideImport", variant: "secondary" }
    : { labelKey: "importMaterials", variant: "primary" };
}

/** Show expiry reference-date notice only on the evidence certificates tab. */
export function shouldShowReferenceDateHint(
  subTab: "subject" | "evidence" | "materials",
): boolean {
  return subTab === "evidence";
}

/** Format the automatic initial user-facing prompt when starting a seal-kb classification session. */
export function buildKbClassifyPrompt(input: {
  vaultId: string;
  vaultName?: string | null;
  batchId: string;
  vaultRoot: string;
  skipped?: ReadonlyArray<{ source: string; reason: string }>;
}): string {
  const name = input.vaultName?.trim();
  const vaultLabel = name
    ? `企业知识库：${name}（ID: ${input.vaultId}）`
    : `vaultId=${input.vaultId}`;
  const skipped = (input.skipped ?? []).filter(
    (item) => item && typeof item.source === "string" && item.source.trim(),
  );
  const lines = [
    `请先调用 \`skill\` 工具加载 \`seal-kb\` 操作手册，再按手册整理待分类候选：${vaultLabel}，批次：batchId=${input.batchId}（知识库根目录：${input.vaultRoot}）。请使用 seal_kb_search(vaultId, batchId) 与 seal_kb_get(vaultId, id, offset) 逐页读取候选；遇到扫描件 PDF 渲染 PNG 或散装图片时读取对应图片提取主体/证照/有效期/编号，调用 seal_kb_save 分类写入并在 files 中引用库内可挂载图片相对路径，处理完每条候选可调用 dismissCandidateIds 或 dismiss_candidates 批量标记已处理；严禁修改原件或设置任何核实字段，完成后输出人工核实清单。`,
  ];
  if (skipped.length > 0) {
    const details = skipped
      .map((item) => `${item.source}（${item.reason}）`)
      .join("、");
    lines.push(
      `注：以下 ${skipped.length} 个不支持文件已在入库时跳过：${details}，请在汇报整理结果时一并告知用户。`,
    );
  }
  return lines.join("\n");
}

/** Pick the next vault to select after deleting a vault, preferring healthy vaults. */
export function nextSelectedVaultId(
  vaults: ReadonlyArray<{ vaultId: string; error?: string }>,
  deletedVaultId: string,
): string {
  const remaining = vaults.filter((item) => item.vaultId !== deletedVaultId);
  const healthy = remaining.find((item) => !item.error);
  return healthy?.vaultId ?? remaining[0]?.vaultId ?? "";
}

/** Format a concise human-readable summary notice after deleting an import batch. */
export function formatDeleteBatchNotice(
  result: {
    removedCandidates: number;
    removedFiles: number;
    preservedFiles: number;
  },
  locale: "zh" | "en" = "zh",
): string {
  if (locale === "en") {
    const preserved =
      result.preservedFiles > 0
        ? `, ${result.preservedFiles} referenced files preserved`
        : "";
    return `Import batch deleted (${result.removedCandidates} slices, ${result.removedFiles} copies removed${preserved}).`;
  }
  const preserved =
    result.preservedFiles > 0
      ? `，保留 ${result.preservedFiles} 份已引用文件`
      : "";
  return `已删除此导入批次（清理 ${result.removedCandidates} 条切片、${result.removedFiles} 份副本${preserved}）。`;
}

export interface InlineDeleteState {
  armedKey: string | null;
  busy: boolean;
  error: string;
}

export interface InlineDeleteController {
  snapshot(): InlineDeleteState;
  arm(key: string): void;
  cancel(): void;
  reset(): void;
  confirm(key: string, operation: () => Promise<void>): Promise<boolean>;
}

/** Pure state machine coordinating two-step inline deletion confirmation and re-entrancy protection. */
export function createInlineDeleteController(
  onChange: (state: InlineDeleteState) => void = () => {},
): InlineDeleteController {
  let state: InlineDeleteState = { armedKey: null, busy: false, error: "" };
  let opSeq = 0;
  let activeOpId: number | null = null;
  let contextGeneration = 0;
  const update = (next: InlineDeleteState) => {
    state = next;
    onChange(state);
  };
  return {
    snapshot: () => state,
    arm(key: string) {
      if (state.busy || activeOpId !== null) return;
      update({
        armedKey: state.armedKey === key ? null : key,
        busy: false,
        error: "",
      });
    },
    cancel() {
      if (state.busy || activeOpId !== null) return;
      update({ armedKey: null, busy: false, error: "" });
    },
    reset() {
      contextGeneration++;
      update({
        armedKey: null,
        busy: activeOpId !== null,
        error: "",
      });
    },
    async confirm(key: string, operation: () => Promise<void>): Promise<boolean> {
      if (state.busy || activeOpId !== null || state.armedKey !== key) return false;
      const myOpId = ++opSeq;
      const myGeneration = contextGeneration;
      activeOpId = myOpId;
      update({ armedKey: key, busy: true, error: "" });
      try {
        await operation();
        if (activeOpId === myOpId) {
          activeOpId = null;
          if (contextGeneration === myGeneration) {
            update({ armedKey: null, busy: false, error: "" });
          } else {
            update({ armedKey: state.armedKey, busy: false, error: state.error });
          }
        }
        return true;
      } catch (err) {
        if (activeOpId === myOpId) {
          activeOpId = null;
          if (contextGeneration === myGeneration) {
            update({
              armedKey: key,
              busy: false,
              error: err instanceof Error ? err.message : String(err),
            });
          } else {
            update({ armedKey: state.armedKey, busy: false, error: state.error });
          }
        }
        return false;
      }
    },
  };
}
