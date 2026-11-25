import { lstat, readFile, realpath } from "node:fs/promises";
import * as path from "node:path";
import type { HostPort } from "../../core/host.js";
import {
  initializeProject,
  persistExtractedDraft,
  prepareExtractedDraft,
  readProject,
  type BidLedger,
} from "../../core/bid/project.js";
import {
  editBidDraft,
  persistEditedDraft,
  type AgentEdit,
} from "../../core/bid/edit.js";
import {
  checkDraft,
  evaluateCoverageMarks,
  type FactCheckState,
} from "../../core/bid/check.js";
import { isCurrentAuthorization } from "../../core/bid/authorization.js";
import { pendingFingerprint } from "../../core/bid/pending-fingerprint.js";
import type { CoverageMark } from "../../core/bid/human-review.js";
import {
  incidentFingerprint,
  resolveLedger,
  sealLedger,
} from "../../core/bid/ledger-integrity.js";
import { resolveAddress } from "../../core/docx/addresses.js";
import {
  bodyHintBlocks,
  bodyViewNodes,
} from "../../core/docx/document-view.js";
import { sealRanges } from "../../core/docx/seal-ranges.js";
import {
  editableText,
  visibleOffsetBefore,
} from "../../core/docx/visible-surgery.js";
import {
  readDocument,
  type ReadDocumentMode,
  type ReadDocumentCursor,
  type PendingReadMark,
} from "../../core/docx/read-document.js";
import type { ExtractionRange } from "../../core/docx/range-extraction.js";
import { markdownImageTokens } from "../../core/docx/markdown.js";
import { sha256Hex } from "../../core/docx/zip.js";
import { KnowledgeBase } from "../../core/kb/index.js";
import {
  resolveFactReferences,
  recordFactSource,
  type FactContext,
  type FactRecord,
  type FactResolution,
  type FactSource,
} from "../../core/bid/facts.js";
import { readableParagraphs } from "../../core/docx/read-document.js";
import { validatePackageStructure } from "../../core/docx/package-structure.js";
import type { KbEntry } from "../../core/kb/types.js";
import {
  assertKnowledgeBaseTree,
  knowledgeBasesRoot,
} from "../knowledge-base-service.js";
import {
  CHECK_CODES,
  completeProjectCheck,
  type DraftCheckReport,
} from "../../core/bid/report.js";
import {
  checkRequirements,
  paginateRequirements,
  parseRequirements,
  patchRequirements,
  validateRequirementsBatch,
  type Requirement,
  type RequirementsState,
} from "../../core/bid/requirements.js";
import { assertOutputIsolation } from "../output-isolation.js";
import { serializedProject } from "./project-operations.js";

function flag(args: string[], name: string, fallback?: string): string {
  const index = args.indexOf(`--${name}`);
  if (index >= 0 && args[index + 1] && !args[index + 1].startsWith("--"))
    return args[index + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`缺少 --${name}`);
}

function volume(value: string): string {
  if (!/^[\p{L}\p{N}_ -]{1,100}$/u.test(value))
    throw new Error(
      "分册名称包含非法字符；请使用 1–100 位字母、数字、空格、下划线或连字符。",
    );
  return value;
}

async function readRequirementsState(root: string): Promise<RequirementsState> {
  const target = path.join(root, "requirements.json");
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) {
      return {
        kind: "error",
        reason: "requirements.json 不是项目内的普通文件",
      };
    }
    const physical = await realpath(target);
    if (physical !== path.join(await realpath(root), "requirements.json")) {
      return {
        kind: "error",
        reason: "requirements.json 路径越界",
      };
    }
    const bytes = await readFile(physical);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return parseRequirements(text);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { kind: "missing" };
    return {
      kind: "error",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function registeredTenderSources(
  root: string,
  project: Awaited<ReturnType<typeof readProject>>,
  ledger: BidLedger,
): Promise<Map<string, Uint8Array>> {
  const sources = new Map<string, Uint8Array>();
  for (const tender of project.tenders) {
    try {
      const bytes = await readFile(await existing(root, tender.copy));
      if (ledger.tenders?.[tender.copy] === sha256Hex(bytes))
        sources.set(tender.copy, bytes);
    } catch {
      /* A registered but unavailable source is reported by C14 or save validation. */
    }
  }
  return sources;
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function existing(root: string, relative: string): Promise<string> {
  if (path.isAbsolute(relative)) throw new Error("文件必须位于项目目录内");
  const result = await realpath(path.resolve(root, relative));
  if (!inside(root, result)) throw new Error("文件必须位于项目目录内");
  return result;
}

async function draftPath(
  root: string,
  name: string,
  base = false,
): Promise<string> {
  const directory = await realpath(path.join(root, "draft"));
  if (!inside(root, directory)) throw new Error("分册目录不在项目内");
  return path.join(directory, `${volume(name)}${base ? ".base" : ""}.docx`);
}

async function ledgerAt(root: string): Promise<unknown> {
  let content: string;
  try {
    content = await readFile(await existing(root, "ledger.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return JSON.parse(content);
  } catch {
    return { malformed: content };
  }
}

async function readBase(root: string, file: string): Promise<Uint8Array> {
  try {
    return await readFile(await existing(root, path.relative(root, file)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return new Uint8Array();
    throw error;
  }
}

async function ledgerKey(host: HostPort): Promise<Uint8Array> {
  const key = await host.authorizationKey?.(true);
  if (!key) throw new Error("宿主不支持台账密钥");
  return key;
}

function asStringList(value: unknown): string[] {
  if (Array.isArray(value))
    return value.filter((item): item is string => typeof item === "string");
  return typeof value === "string" && value ? [value] : [];
}

async function readQuoteSource(
  root: string,
  relative: string,
): Promise<string> {
  const segments = relative.split("/");
  if (
    path.isAbsolute(relative) ||
    relative.includes("\\") ||
    segments.some((part) => !part || part === "." || part === "..") ||
    !["tender", "materials"].includes(segments[0])
  ) {
    throw new Error("原文引用只能指向项目内 tender/ 或 materials/ 文件");
  }
  const file = await existing(root, relative),
    bytes = await readFile(file),
    extension = path.extname(file).toLocaleLowerCase("en-US");
  if (extension === ".docx") {
    const parts = await validatePackageStructure(bytes);
    return readableParagraphs(parts)
      .map((block) => block.text)
      .join("\n");
  }
  if (extension === ".txt" || extension === ".md")
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  throw new Error("原文引用暂只支持 DOCX、TXT 或 Markdown 文件");
}

async function loadFactContext(
  host: HostPort,
  root: string,
  project: Awaited<ReturnType<typeof readProject>>,
  references: readonly string[],
  strict: boolean,
): Promise<{
  context: FactContext;
  identity?: {
    creditCode?: string;
    forbiddenAffiliates: string[];
    thirdPartyCreditCodes: string[];
  };
  knowledgeError?: string;
  quoteErrors: Map<string, string>;
}> {
  const records = new Map<string, FactRecord>(),
    quotes = new Map<string, string>(),
    quoteErrors = new Map<string, string>();
  let subject: KbEntry | undefined,
    identity:
      | {
          creditCode?: string;
          forbiddenAffiliates: string[];
          thirdPartyCreditCodes: string[];
        }
      | undefined,
    knowledgeError: string | undefined;
  if (project.vaultId) {
    try {
      const kbRoot = knowledgeBasesRoot();
      assertKnowledgeBaseTree(kbRoot);
      const kb = new KnowledgeBase(host, kbRoot),
        [currentSubject, health] = await Promise.all([
          kb.get(project.vaultId, "subject"),
          kb.health(project.vaultId, project.deadline),
        ]);
      subject = currentSubject;
      for (const record of health.records) records.set(record.id, record);
      const citedIds = new Set(
        references.flatMap(
          (reference) =>
            /^\{\{record:([\p{L}\p{N}-]+)\./u.exec(reference)?.[1] ?? [],
        ),
      );
      const thirdPartyCreditCodes = health.records
        .filter(
          (record) =>
            record.subject === "third_party" && citedIds.has(record.id),
        )
        .map((record) => record.fields.creditCode)
        .filter(
          (value): value is string => typeof value === "string" && !!value,
        );
      identity = {
        ...(typeof currentSubject.fields.creditCode === "string"
          ? { creditCode: currentSubject.fields.creditCode }
          : {}),
        forbiddenAffiliates: asStringList(
          currentSubject.fields.forbiddenAffiliates,
        ),
        thirdPartyCreditCodes,
      };
    } catch (error) {
      knowledgeError = error instanceof Error ? error.message : String(error);
      if (strict)
        throw new Error(`无法读取投标关联的知识库：${knowledgeError}`);
    }
  }
  const quotePaths = new Set<string>();
  for (const reference of references)
    for (const match of reference.matchAll(/\{\{quote:([^|{}]+)\|/g))
      quotePaths.add(match[1]);
  for (const relative of quotePaths) {
    try {
      quotes.set(relative, await readQuoteSource(root, relative));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      quoteErrors.set(relative, reason);
      if (strict) throw error;
    }
  }
  return {
    context: {
      deadline: project.deadline,
      ...(subject ? { subject } : {}),
      records,
      quotes,
    },
    ...(identity ? { identity } : {}),
    ...(knowledgeError ? { knowledgeError } : {}),
    quoteErrors,
  };
}

function factValues(operations: readonly AgentEdit[]): string[] {
  const values: string[] = [];
  for (const operation of operations) {
    if (!operation || typeof operation !== "object") continue;
    if (
      (operation.op === "replace" || operation.op === "set_cell") &&
      typeof operation.value === "string"
    )
      values.push(operation.value);
    else if (
      operation.op === "insert" &&
      typeof operation.markdown === "string"
    )
      values.push(operation.markdown);
    else if (
      operation.op === "insert_rows" &&
      Array.isArray(operation.rows)
    ) {
      for (const row of operation.rows) {
        if (!Array.isArray(row)) continue;
        for (const cell of row) {
          if (typeof cell === "string") values.push(cell);
        }
      }
    }
  }
  return values;
}

function combineFacts(
  left: FactResolution | undefined,
  right: FactResolution,
): FactResolution {
  const shift = left?.value.length ?? 0;
  const sources = [...(left?.sources ?? []), ...right.sources];
  return {
    value: left ? `${left.value}\n${right.value}` : right.value,
    sources,
    spans: [
      ...(left?.spans ?? []),
      ...right.spans.map((span) => ({
        ...span,
        start: span.start + shift + (left ? 1 : 0),
        end: span.end + shift + (left ? 1 : 0),
      })),
    ],
    verified: sources.length > 0 && sources.every((source) => source.verified),
    markdownLiterals: left?.markdownLiterals ?? right.markdownLiterals,
  };
}

async function kbImage(
  host: HostPort,
  project: Awaited<ReturnType<typeof readProject>>,
  context: FactContext,
  reference: string,
  thirdPartyHolder?: string,
  imageIndex?: number,
): Promise<{ bytes: Uint8Array; source: FactSource }> {
  if (!project.vaultId) throw new Error("KB 图片引用需要关联知识库");
  let decoded: string;
  try {
    decoded = decodeURIComponent(reference);
  } catch {
    throw new Error("KB 图片引用包含无效百分号编码");
  }
  const match = /^kb:([\p{L}\p{N}-]+)\/(.+)$/u.exec(decoded);
  if (!match) throw new Error("KB 图片引用格式应为 kb:<record-id>/<file>");
  const [, id, relative] = match,
    record = context.records.get(id);
  if (!record) throw new Error(`KB 图片证据记录不存在：${id}`);
  if (
    !/^files\/(?:[\p{L}\p{N}_.() -]+\/)*[\p{L}\p{N}_.() -]+$/u.test(relative) ||
    relative.split("/").some((part) => part === "." || part === "..")
  )
    throw new Error("KB 图片路径无效");
  if (!asStringList(record.fields.files).includes(relative))
    throw new Error(`图片未登记在证据记录中：${id}`);
  const extension = path.extname(relative).toLocaleLowerCase("en-US");
  if (
    ![".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tif", ".tiff"].includes(
      extension,
    )
  )
    throw new Error("KB 引用文件不是支持的图片类型");
  const kb = new KnowledgeBase(host, knowledgeBasesRoot()),
    vaultRoot = kb.vaultRoot(project.vaultId);
  const full = path.resolve(vaultRoot, relative),
    rel = path.relative(vaultRoot, full);
  if (
    !rel ||
    rel === ".." ||
    rel.startsWith(`..${path.sep}`) ||
    path.isAbsolute(rel)
  )
    throw new Error("KB 图片路径越出知识库目录");
  const stored = await host.readBytes(full);
  const source = {
    ...recordFactSource(record, decoded, thirdPartyHolder, ""),
    media: true,
    ...(imageIndex === undefined ? {} : { imageIndex }),
  };
  return {
    bytes: host.normalizeImage
      ? await host.normalizeImage(stored, relative)
      : stored,
    source,
  };
}

async function resolveOperations(
  host: HostPort,
  root: string,
  project: Awaited<ReturnType<typeof readProject>>,
  operations: readonly AgentEdit[],
  loadedFacts: Awaited<ReturnType<typeof loadFactContext>>,
): Promise<{
  resolvedOperations: AgentEdit[];
  facts: Map<AgentEdit, FactResolution>;
  images: Map<AgentEdit, Uint8Array>;
  markdownImages: Map<AgentEdit, Uint8Array[]>;
  resolutionErrors: Map<number, string>;
}> {
  const { context, knowledgeError, quoteErrors } = loadedFacts;
  const resolvedOperations: AgentEdit[] = [];
  const facts = new Map<AgentEdit, FactResolution>(),
    images = new Map<AgentEdit, Uint8Array>(),
    markdownImages = new Map<AgentEdit, Uint8Array[]>();
  const resolutionErrors = new Map<number, string>();
  const add = (operation: AgentEdit, value: FactResolution) => {
    if (value.sources.length)
      facts.set(operation, combineFacts(facts.get(operation), value));
  };
  const thirdPartyHolder = (operation: AgentEdit): string | undefined =>
    "thirdPartyHolder" in operation ? operation.thirdPartyHolder : undefined;
  const resolveText = (
    operation: AgentEdit,
    text: string,
    markdown = false,
    cellCoords?: { row: number; col: number },
  ): string => {
    if (knowledgeError && /\{\{(?:subject\.|record:)/.test(text)) {
      throw new Error(`无法读取投标关联的知识库：${knowledgeError}`);
    }
    for (const match of text.matchAll(/\{\{quote:([^|{}]+)\|/g)) {
      const quoteErr = quoteErrors.get(match[1]);
      if (quoteErr) throw new Error(quoteErr);
    }
    const resolved = resolveFactReferences(
      text,
      context,
      thirdPartyHolder(operation),
      markdown,
    );
    if (resolved.sources.length) {
      if (cellCoords) {
        for (const span of resolved.spans) {
          const start = resolved.value.slice(0, span.start).replace(/\r\n/g, "\n").length;
          const length = resolved.value.slice(span.start, span.end).replace(/\r\n/g, "\n").length;
          span.source.cell = {
            row: cellCoords.row,
            col: cellCoords.col,
            start,
            end: start + length,
          };
        }
      }
      add(operation, resolved);
      return resolved.value;
    }
    return text;
  };
  const readImage = async (
    operation: AgentEdit,
    href: string,
    imageIndex?: number,
  ): Promise<Uint8Array> => {
    if (href.startsWith("kb:")) {
      if (knowledgeError) {
        throw new Error(`无法读取投标关联的知识库：${knowledgeError}`);
      }
      const resolved = await kbImage(
        host,
        project,
        context,
        href,
        thirdPartyHolder(operation),
        imageIndex,
      );
      add(operation, {
        value: "",
        sources: [resolved.source],
        spans: [],
        verified: resolved.source.verified,
      });
      return resolved.bytes;
    }
    if (path.isAbsolute(href))
      throw new Error("图片必须使用项目内路径或 kb: 证据引用");
    const bytes = await readFile(await existing(root, href));
    return host.normalizeImage ? host.normalizeImage(bytes, href) : bytes;
  };
  for (const [index, rawOp] of operations.entries()) {
    const operation = structuredClone(rawOp);
    try {
      if (!operation || typeof operation !== "object") {
        throw new Error("编辑操作必须是对象");
      }
      if (operation.op === "dismiss_hint" || operation.op === "dismiss_hints") {
        resolvedOperations.push(operation);
        continue;
      }
      if (operation.op === "insert_toc") {
        if (operation.pending !== undefined || operation.thirdPartyHolder !== undefined) {
          throw new Error("insert_toc 不支持 pending 或 thirdPartyHolder");
        }
        if (operation.position !== "before" && operation.position !== "after") {
          throw new Error("insert_toc 的 position 必须为 before 或 after");
        }
        if (
          operation.maxLevel !== undefined &&
          (typeof operation.maxLevel !== "number" ||
            !Number.isInteger(operation.maxLevel) ||
            ![1, 2, 3].includes(operation.maxLevel))
        ) {
          throw new Error("insert_toc 的 maxLevel 必须为 1、2 或 3");
        }
        if (typeof operation.at !== "string" || !/^(?:p|t):(?:0|[1-9]\d*)$/.test(operation.at)) {
          throw new Error("insert_toc 仅支持正文顶层段落或表格地址（p:N 或 t:N）");
        }
        resolvedOperations.push(operation);
        continue;
      }
      if (operation.op === "replace" || operation.op === "set_cell") {
        if (typeof operation.value === "string") {
          operation.value = resolveText(operation, operation.value);
        }
      } else if (operation.op === "insert") {
        if (typeof operation.markdown === "string") {
          operation.markdown = resolveText(operation, operation.markdown, true);
        }
      } else if (operation.op === "insert_rows") {
        if (Array.isArray(operation.rows)) {
          for (let rowIdx = 0; rowIdx < operation.rows.length; rowIdx++) {
            const row = operation.rows[rowIdx];
            if (!Array.isArray(row)) continue;
            for (let col = 0; col < row.length; col++) {
              if (typeof row[col] === "string") {
                row[col] = resolveText(operation, row[col], false, {
                  row: rowIdx,
                  col,
                });
              }
            }
          }
        }
      }
      if (operation.op === "insert_image") {
        if (typeof operation.image === "string") {
          images.set(operation, await readImage(operation, operation.image));
        }
      } else if (
        operation.op === "insert" &&
        typeof operation.markdown === "string"
      ) {
        const refs = markdownImageTokens(operation.markdown).images,
          contents: Uint8Array[] = [];
        for (const [imageIndex, image] of refs.entries())
          contents.push(await readImage(operation, image.href, imageIndex));
        markdownImages.set(operation, contents);
      }
      resolvedOperations.push(operation);
    } catch (error) {
      resolutionErrors.set(
        index,
        error instanceof Error ? error.message : String(error),
      );
      resolvedOperations.push(operation);
    }
  }
  return {
    resolvedOperations,
    facts,
    images,
    markdownImages,
    resolutionErrors,
  };
}

function factReferences(fills: unknown): string[] {
  if (!Array.isArray(fills)) return [];
  return fills.flatMap((item) =>
    item &&
    typeof item === "object" &&
    (item as { status?: unknown }).status !== "removed" &&
    Array.isArray((item as { sources?: unknown }).sources)
      ? (item as { sources: unknown[] }).sources.flatMap((source) =>
          source &&
          typeof source === "object" &&
          typeof (source as { reference?: unknown }).reference === "string"
            ? [(source as { reference: string }).reference]
            : [],
        )
      : [],
  );
}

function verifiedSources(
  fills: unknown,
  context: FactContext,
  knowledgeError?: string,
  quoteErrors: ReadonlyMap<string, string> = new Map(),
): FactCheckState[] {
  if (!Array.isArray(fills)) return [];
  return fills.flatMap((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      typeof (item as { id?: unknown }).id !== "string" ||
      (item as { status?: unknown }).status === "removed"
    )
      return [];
    const fill = item as {
      id: string;
      sources?: FactSource[];
      thirdPartyHolder?: string;
      verified?: boolean;
    };
    const sources = Array.isArray(fill.sources) ? fill.sources : [];
    const issues: string[] = [],
      reviewableIssues: string[] = [];
    const evidenceDates = new Map<string, "expired" | "expiring_soon">();
    for (const source of sources) {
      const declaredHolder =
        source.thirdPartyHolder ??
        (source.subject === "third_party" ? fill.thirdPartyHolder : undefined);
      if (source.recordId) {
        const record = context.records.get(source.recordId);
        if (record?.issues.length)
          issues.push("引用资料核实签名失效，请重新核实资料");
        if (
          record?.validity === "expired" ||
          record?.validity === "expiring_soon"
        )
          evidenceDates.set(source.recordId, record.validity);
        if (!record && knowledgeError)
          issues.push("无法读取引用证据记录的当前状态");
      }
      try {
        if (
          source.reference.startsWith("{{subject.") &&
          context.subject?.issues.length
        )
          issues.push("引用主体核实签名失效，请重新核实资料");
        let current: FactSource;
        if (source.media) {
          let decoded: string;
          try {
            decoded = decodeURIComponent(source.reference);
          } catch {
            throw new Error("KB 图片引用包含无效百分号编码");
          }
          const match = /^kb:([\p{L}\p{N}-]+)\/(.+)$/u.exec(decoded);
          const record = match && context.records.get(match[1]);
          if (!record || !match) throw new Error("KB 图片证据记录不存在");
          if (!asStringList(record.fields.files).includes(match[2]))
            throw new Error("KB 图片已从证据记录中移除");
          current = {
            ...recordFactSource(record, source.reference, declaredHolder, ""),
            media: true,
            imageIndex: source.imageIndex,
          };
        } else {
          const resolved = resolveFactReferences(
            source.reference,
            context,
            declaredHolder,
          );
          current = resolved.sources[0];
          if (!current) throw new Error("事实引用来源无效");
        }
        if (current.resolvedValue !== source.resolvedValue)
          issues.push("引用资料字段内容已变化");
        if (!current.verified)
          reviewableIssues.push("引用资料未核实或效期、主体未知");
      } catch (error) {
        issues.push(error instanceof Error ? error.message : String(error));
        if (source.reference.startsWith("{{quote:")) {
          const relative = /^\{\{quote:([^|{}]+)\|/.exec(source.reference)?.[1];
          if (relative && quoteErrors.has(relative))
            issues.push(quoteErrors.get(relative)!);
        }
      }
    }
    return [
      {
        id: fill.id,
        verified: sources.length
          ? issues.length === 0 && reviewableIssues.length === 0
          : fill.verified === true,
        issues: [...new Set(issues)],
        reviewableIssues: [...new Set(reviewableIssues)],
        evidenceDates: [...evidenceDates].map(([recordId, validity]) => ({
          recordId,
          validity,
        })),
      },
    ];
  });
}

async function anchorAt(
  host: HostPort,
  root: string,
  create: boolean,
): Promise<{ path: string; value: unknown }> {
  if (!host.ledgerAnchorPath) throw new Error("宿主不支持台账锚点");
  const file = await host.ledgerAnchorPath(root, create);
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("台账锚点不是普通文件");
    const content = await readFile(file, "utf8");
    try {
      return { path: file, value: JSON.parse(content) };
    } catch {
      return { path: file, value: null };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { path: file, value: null };
    throw error;
  }
}

export async function readProjectSnapshot(host: HostPort, root: string) {
  const project = await readProject(host, root),
    rawLedger = await ledgerAt(root);
  const secret = (await host.authorizationKey?.(false)) ?? null,
    anchor = await anchorAt(host, root, false);
  const ledger = await resolveLedger(rawLedger, root, secret, anchor.value);
  const references = factReferences(ledger.fills);
  const loaded = await loadFactContext(host, root, project, references, false);
  const facts = verifiedSources(
    ledger.fills,
    loaded.context,
    loaded.knowledgeError,
    loaded.quoteErrors,
  );
  const volumes = [];
  for (const name of project.drafts) {
    const file = await draftPath(root, name),
      baseFile = await draftPath(root, name, true);
    const draft = await readBase(root, file),
      base = await readBase(root, baseFile);
    volumes.push({ name, file, draft, base });
  }
  const requirements = await readRequirementsState(root);
  const sources = await registeredTenderSources(root, project, ledger);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const reviewContext = {
    root,
    vaultId: project.vaultId,
    deadline: project.deadline,
  };
  const validCoverageMarks: CoverageMark[] = [];
  const expiredCoverageIds = new Set<string>();
  for (const volumeItem of volumes) {
    try {
      const parts = await validatePackageStructure(volumeItem.draft);
      const xml = decoder.decode(parts.get("word/document.xml")!);
      const evaluated = await evaluateCoverageMarks({
        marks: ledger.requirements,
        draft: volumeItem.name,
        xml,
        root,
        secret,
        context: reviewContext,
        requirements,
      });
      validCoverageMarks.push(...evaluated.validMarks);
      for (const id of evaluated.expiredIds) expiredCoverageIds.add(id);
    } catch {
      /* Broken package structure is reported as C01 and cannot satisfy coverage. */
    }
  }
  const coveredIds = new Set(validCoverageMarks.map((mark) => mark.id));
  const requirementResults = await checkRequirements(
    requirements,
    sources,
    new Map(volumes.map((item) => [item.name, item.draft])),
    coveredIds,
  );
  const reports: DraftCheckReport[] = [];
  for (const [index, item] of volumes.entries()) {
    reports.push(
      await checkDraft(host, {
        name: item.name,
        root,
        draft: item.draft,
        base: item.base,
        ledger: rawLedger,
        project,
        secret,
        anchor: anchor.value,
        factStates: facts,
        requirementsState: requirements,
        knownDrafts: project.drafts,
        includeOrphanCoverage: index === 0,
        ...(loaded.identity ? { identity: loaded.identity } : {}),
        ...(project.vaultId && loaded.knowledgeError
          ? { identityError: "关联知识库无法读取，C09 主体检查未知" }
          : {}),
        ...(index === 0 ? { requirements: requirementResults } : {}),
      }),
    );
  }
  const summary = completeProjectCheck(reports);
  if (volumes.length === 0) {
    const orphanCoverage = await evaluateCoverageMarks({
      marks: ledger.requirements,
      draft: "",
      xml: "",
      root,
      secret,
      context: reviewContext,
      knownDrafts: project.drafts,
      includeOrphanCoverage: true,
    });
    summary.counts.C12 = requirementResults.C12.length;
    summary.blockingCounts.C12 = requirementResults.C12.length;
    summary.counts.C14 = requirementResults.C14.length;
    summary.blockingCounts.C14 = requirementResults.C14.length;
    summary.counts.C15 = orphanCoverage.invalidAuthorizations.length;
    summary.blockingCounts.C15 = orphanCoverage.invalidAuthorizations.length;
  }
  const revision = sha256Hex(
    JSON.stringify([
      project,
      ledger,
      anchor.value,
      requirements,
      facts,
      loaded.identity,
      volumes.map((item) => [
        item.name,
        sha256Hex(item.draft),
        sha256Hex(item.base),
      ]),
    ]),
  );
  return {
    project,
    ledger,
    secret,
    anchor,
    volumes,
    reports,
    requirements,
    requirementResults,
    coverageSummary: {
      validMarks: validCoverageMarks,
      expiredIds: [...expiredCoverageIds],
    },
    revision,
    identity: loaded.identity,
    identityError: loaded.knowledgeError,
    ...summary,
  };
}

function pageReport(
  report: DraftCheckReport,
  group: string | undefined,
  offset: number,
  limit: number,
) {
  const counts = Object.fromEntries(
    CHECK_CODES.map((code) => [code, report.results[code].length]),
  );
  const results = Object.fromEntries(
    CHECK_CODES.filter((code) => !group || code === group).map((code) => [
      code,
      report.results[code].slice(offset, offset + limit),
    ]),
  );
  const remaining = Object.fromEntries(
    Object.entries(results).map(([code, values]) => [
      code,
      Math.max(0, counts[code] - offset - values.length),
    ]),
  );
  const readonly = report.readonlyHints ?? [];
  const readonlyHints =
    !group || group === "C02"
      ? {
          items: readonly.slice(offset, offset + limit),
          count: readonly.length,
          remaining: Math.max(0, readonly.length - offset - limit),
          truncated: readonly.length > offset + limit,
          ...(readonly.length > offset + limit
            ? {
                continuation: {
                  tool: "seal_doc_read",
                  arguments: { file: report.draft, mode: "blocks", limit: 50 },
                  instruction:
                    "调用 seal_doc_read 并提供 project；使用返回的 next 继续读取，直至 next 为 null。CLI 将 next 中的 mode、limit、maxChars、context 和 cursor 传给对应选项。",
                },
              }
            : {}),
        }
      : undefined;
  return {
    ...report,
    results,
    counts,
    remaining,
    truncated: Object.fromEntries(
      Object.entries(remaining).map(([code, value]) => [code, value > 0]),
    ),
    offset,
    limit,
    nextOffset: Object.values(remaining).some((value) => value > 0)
      ? offset + limit
      : null,
    readonlyHints,
  };
}

async function lightweightDraftPending(input: {
  draftName: string;
  draftBytes: Uint8Array;
  baseBytes: Uint8Array;
  rawLedger: unknown;
  root: string;
  project: Awaited<ReturnType<typeof readProject>>;
  secret: Uint8Array | null;
  anchorValue: unknown;
}): Promise<{ pending: PendingReadMark[]; baselineWarning?: string }> {
  const {
    draftName,
    draftBytes,
    baseBytes,
    rawLedger,
    root,
    project,
    secret,
    anchorValue,
  } = input;
  const ledger = await resolveLedger(rawLedger, root, secret, anchorValue);
  const incident = ledger.integrityIncident;
  if (incident && incident.recoveryNeeded) {
    const resolution = incident.resolution as
      | { note?: unknown; authorization?: unknown }
      | undefined;
    const note = typeof resolution?.note === "string" ? resolution.note : "";
    const valid =
      !!secret &&
      !!note.trim() &&
      (await isCurrentAuthorization(secret, resolution?.authorization, {
        kind: "recover",
        project: root,
        item: "ledger",
        fingerprint: incidentFingerprint(incident, note),
      }));
    if (!valid) throw new Error("台账无法核验，待定项状态未知");
  }

  let baselineWarning: string | undefined;
  const baseValid =
    typeof ledger.bases?.[draftName] === "string" &&
    ledger.bases[draftName] === sha256Hex(baseBytes);
  if (!baseValid) {
    if (baseBytes.length === 0) {
      baselineWarning = "分册基准缺失或损坏";
    } else {
      try {
        await validatePackageStructure(baseBytes);
        baselineWarning = "分册基准与已封印摘要不一致或摘要缺失";
      } catch {
        baselineWarning = "分册基准缺失或损坏";
      }
    }
  }

  const draftItems = ledger.pending.filter(
    (entry) => entry.draft === draftName && entry.status !== "removed",
  );
  if (draftItems.length === 0) {
    return { pending: [], ...(baselineWarning ? { baselineWarning } : {}) };
  }

  let xml: string;
  try {
    const parts = await validatePackageStructure(draftBytes);
    xml = new TextDecoder("utf-8", { fatal: true }).decode(
      parts.get("word/document.xml")!,
    );
  } catch {
    return { pending: [], ...(baselineWarning ? { baselineWarning } : {}) };
  }

  let ranges: ReturnType<typeof sealRanges> = [];
  try {
    ranges = sealRanges(xml);
  } catch {
    return { pending: [], ...(baselineWarning ? { baselineWarning } : {}) };
  }

  const rangeByName = new Map(
    ranges.map((candidate) => [candidate.name, candidate]),
  );
  let bodyNodes: ReturnType<typeof bodyViewNodes> | undefined;
  const pending: PendingReadMark[] = [];

  for (const item of draftItems) {
    const range = rangeByName.get(`_Seal_P_${item.id}`);
    const confirmed =
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
    if (confirmed || !range || !range.text) continue;

    bodyNodes ??= bodyViewNodes(xml);
    let address: string | undefined;
    let offset: number | undefined;
    const locate = (nodes: ReturnType<typeof bodyViewNodes>) => {
      for (const node of nodes) {
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
      }
    };
    locate(bodyNodes);
    if (address !== undefined) {
      pending.push({
        address,
        find: range.text,
        category: item.category,
        ...(offset !== undefined ? { offset } : {}),
      });
    }
  }

  return { pending, ...(baselineWarning ? { baselineWarning } : {}) };
}

function safeTruncateText(value: string, maxChars = 600): string {
  if (value.length <= maxChars) return value;
  let end = maxChars;
  if (/[\uD800-\uDBFF]/.test(value[end - 1] ?? "")) end--;
  return `${value.slice(0, end)}…`;
}

async function diagnoseEditFailure(input: {
  name: string;
  old: Uint8Array;
  base: Uint8Array;
  host: HostPort;
  ledger: BidLedger;
  operations: AgentEdit[];
  images: Map<AgentEdit, Uint8Array>;
  markdownImages: Map<AgentEdit, Uint8Array[]>;
  facts: ReadonlyMap<AgentEdit, FactResolution>;
  resolutionErrors?: ReadonlyMap<number, string>;
  reason: string;
}) {
  const {
    name,
    old,
    base,
    host,
    ledger,
    operations,
    images,
    markdownImages,
    facts,
    resolutionErrors,
    reason,
  } = input;
  let cachedXml: string | null | undefined;
  let cachedHintBlocks: ReturnType<typeof bodyHintBlocks> | undefined;
  const readCurrentBlock = async (at: string | undefined) => {
    if (!at) return undefined;
    try {
      if (cachedXml === undefined) {
        try {
          const parts = await validatePackageStructure(old);
          cachedXml = new TextDecoder("utf-8", { fatal: true }).decode(
            parts.get("word/document.xml")!,
          );
        } catch {
          cachedXml = null;
        }
      }
      if (!cachedXml) return undefined;
      cachedHintBlocks ??= bodyHintBlocks(cachedXml);
      const block = cachedHintBlocks.get(at);
      if (block) {
        return {
          address: at,
          text: safeTruncateText(block.text, 600),
          hints: block.hints.slice(0, 30).map((hint, blank) => ({
            blank,
            kind: hint.kind,
            text: safeTruncateText(hint.text, 120),
          })),
        };
      }
      const resolved = resolveAddress(cachedXml, at);
      return {
        address: at,
        text: safeTruncateText(editableText(resolved.xml), 600),
        hints: [],
      };
    } catch {
      return undefined;
    }
  };
  const operationAddress = (
    operation: AgentEdit | undefined,
  ): string | undefined => {
    if (!operation || typeof operation !== "object") return undefined;
    if ("at" in operation && typeof operation.at === "string")
      return operation.at;
    if (
      operation.op === "dismiss_hints" &&
      "targets" in operation &&
      Array.isArray(operation.targets) &&
      operation.targets.length === 1 &&
      typeof operation.targets[0]?.at === "string"
    ) {
      return operation.targets[0].at;
    }
    return undefined;
  };

  const results: Array<{
    index: number;
    op: unknown;
    at?: string;
    status: "rolled_back" | "rejected";
    suggestion: string;
    currentBlock?: {
      address: string;
      text: string;
      hints: Array<{ blank: number; kind: string; text: string }>;
    };
  }> = [];

  if (operations.length === 1) {
    const operation = operations[0];
    const at = operationAddress(operation);
    const currentBlock = await readCurrentBlock(at);
    results.push({
      index: 0,
      op: operation?.op,
      ...(at !== undefined ? { at } : {}),
      status: "rejected",
      suggestion: `${reason}；建议重新读取目标并核对操作参数。`,
      ...(currentBlock ? { currentBlock } : {}),
    });
    return { committed: false, reason, results };
  }

  for (const [index, operation] of operations.entries()) {
    const at = operationAddress(operation);
    const resolutionError = resolutionErrors?.get(index);
    if (resolutionError !== undefined) {
      const currentBlock = await readCurrentBlock(at);
      results.push({
        index,
        op: operation?.op,
        ...(at !== undefined ? { at } : {}),
        status: "rejected",
        suggestion: `${resolutionError}；建议重新读取目标并核对操作参数。`,
        ...(currentBlock ? { currentBlock } : {}),
      });
      continue;
    }
    const hasNewImage =
      operation?.op === "insert_image" ||
      (operation?.op === "insert" &&
        (markdownImages.get(operation)?.length ?? 0) > 0);
    try {
      await editBidDraft({
        name,
        old,
        base,
        ...(hasNewImage ? { host } : {}),
        ledger: structuredClone(ledger),
        operations: [operation],
        images,
        markdownImages,
        facts,
      });
      results.push({
        index,
        op: operation?.op,
        ...(at !== undefined ? { at } : {}),
        status: "rolled_back",
        suggestion: "整批未写入；请修正被拒绝的操作后重新提交。",
      });
    } catch (individual) {
      const detail =
        individual instanceof Error ? individual.message : String(individual);
      const currentBlock = await readCurrentBlock(at);
      results.push({
        index,
        op: operation?.op,
        ...(at !== undefined ? { at } : {}),
        status: "rejected",
        suggestion: `${detail}；建议重新读取目标并核对操作参数。`,
        ...(currentBlock ? { currentBlock } : {}),
      });
    }
  }
  if (
    operations.length > 0 &&
    results.every((item) => item.status === "rolled_back")
  ) {
    for (const item of results) {
      item.suggestion = `整批未写入；操作之间可能存在冲突：${reason}；建议拆分或调整后重新提交。`;
    }
  }
  return { committed: false, reason, results };
}

async function writeRequirementsFile(
  host: HostPort,
  root: string,
  project: Awaited<ReturnType<typeof readProject>>,
  items: readonly Requirement[],
): Promise<void> {
  const serialized = JSON.stringify(
    { format: "seal-requirements-1", items },
    null,
    2,
  );
  if (parseRequirements(serialized).kind !== "value") {
    throw new Error("要求清单序列化校验失败");
  }
  if (!host.writeFiles) throw new Error("宿主不支持原子文件批次");
  const target = path.join(root, "requirements.json");
  assertOutputIsolation(
    { files: [target] },
    {
      files: project.tenders.map((item) => path.resolve(root, item.copy)),
      directories: [path.join(root, "tender"), path.join(root, "draft")],
    },
  );
  try {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("requirements.json 不是项目内的普通文件");
    }
    if ((await realpath(target)) !== target) {
      throw new Error("requirements.json 路径越界");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await host.writeFiles([
    { path: target, data: new TextEncoder().encode(serialized) },
  ]);
}

export async function runProject(
  host: HostPort,
  args: string[],
): Promise<unknown> {
  const root = path.resolve(
    flag(args, args[0] === "init" ? "root" : "project"),
  );
  return serializedProject(root, () => runProjectUnlocked(host, args));
}

/** Owner transactions may compose ordinary edits while already holding the project queue. */
export async function runProjectUnlocked(
  host: HostPort,
  args: string[],
): Promise<unknown> {
  const action = args[0];
  if (action === "init") {
    const root = path.resolve(flag(args, "root"));
    const tenders = args.flatMap((item, index) =>
      item === "--tender" && args[index + 1]
        ? [path.resolve(args[index + 1])]
        : [],
    );
    const project = await initializeProject(host, root, {
      name: flag(args, "name"),
      deadline: flag(args, "deadline"),
      ...(args.includes("--vault") ? { vaultId: flag(args, "vault") } : {}),
      tenders,
      createdAt: new Date().toISOString(),
    });
    return project;
  }
  const root = await realpath(path.resolve(flag(args, "project")));
  const project = await readProject(host, root);
  if (action === "read") {
    const requested = flag(args, "file");
    const file = await existing(
      root,
      project.drafts.includes(requested)
        ? path.relative(root, await draftPath(root, requested))
        : requested,
    );
    const bytes = await readFile(file);
    const draftName = (
      await Promise.all(
        project.drafts.map(async (name) => ({
          name,
          file: await draftPath(root, name),
        })),
      )
    ).find((item) => item.file === file)?.name;
    let pending: PendingReadMark[] = [];
    let baselineWarning: string | undefined;
    if (draftName) {
      const secret = (await host.authorizationKey?.(false)) ?? null;
      const anchor = await anchorAt(host, root, false);
      const rawLedger = await ledgerAt(root);
      const baseBytes = await readBase(
        root,
        await draftPath(root, draftName, true),
      );
      const loadedPending = await lightweightDraftPending({
        draftName,
        draftBytes: bytes,
        baseBytes,
        rawLedger,
        root,
        project,
        secret,
        anchorValue: anchor.value,
      });
      pending = loadedPending.pending;
      baselineWarning = loadedPending.baselineWarning;
    }
    const optional = (name: string) =>
      args.includes(`--${name}`) ? flag(args, name) : undefined;
    const mode = flag(args, "mode", "blocks") as ReadDocumentMode;
    if (!["outline", "blocks", "search"].includes(mode)) {
      throw new Error(
        "mode 必须为 outline、blocks 或 search；请改用允许值后重试。",
      );
    }
    const limit = optional("limit"),
      maxChars = optional("max-chars"),
      context = optional("context"),
      cursor = optional("cursor");
    let onlyHints: boolean | undefined;
    const onlyHintsIndex = args.indexOf("--only-hints");
    if (onlyHintsIndex >= 0) {
      const raw = args[onlyHintsIndex + 1];
      if (raw === undefined || raw.startsWith("--")) onlyHints = true;
      else if (raw === "true") onlyHints = true;
      else if (raw === "false") onlyHints = false;
      else throw new Error("onlyHints 参数必须为布尔值");
    }
    let parsedCursor: ReadDocumentCursor | undefined;
    if (cursor !== undefined) {
      let rawCursor: unknown;
      try {
        rawCursor = JSON.parse(cursor);
      } catch {
        throw new Error(
          "续读参数 cursor 必须是合法 JSON 对象；请去掉 cursor 从头重新读取。",
        );
      }
      if (
        !rawCursor ||
        typeof rawCursor !== "object" ||
        Array.isArray(rawCursor)
      ) {
        throw new Error(
          "续读参数 cursor 必须是对象；请去掉 cursor 从头重新读取。",
        );
      }
      parsedCursor = rawCursor as ReadDocumentCursor;
    }
    try {
      const result = await readDocument(
        bytes,
        {
          mode,
          from: optional("from"),
          to: optional("to"),
          ...(onlyHints === undefined ? {} : { onlyHints }),
          query: optional("query"),
          limit: limit === undefined ? undefined : Number(limit),
          maxChars: maxChars === undefined ? undefined : Number(maxChars),
          context: context === undefined ? undefined : Number(context),
          cursor: parsedCursor,
        },
        { pending },
      );
      if (baselineWarning) {
        result.warningCount++;
        if (result.warnings.length < 20) result.warnings.push(baselineWarning);
        else result.warningsTruncated = true;
      }
      return result;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (text === "读取长度或分页参数无效") {
        throw new Error(
          "读取长度或分页参数无效；请确保 limit 为 1–200、maxChars 为 2–50000、context 为 0–200 的整数。",
        );
      }
      if (text === "续读参数无效或文档、读取条件、待定状态已改变") {
        throw new Error(
          "续读参数无效或文档、读取条件、待定状态已改变；请去掉 cursor 并用相同读取条件从头重新读取。",
        );
      }
      throw error;
    }
  }
  if (action === "check") {
    const group = args.includes("--group") ? flag(args, "group") : undefined;
    if (group && !(CHECK_CODES as readonly string[]).includes(group))
      throw new Error(
        `检查分组不支持（${group}）；允许值：${CHECK_CODES.join("、")}，或省略 group 查看全部分组。`,
      );
    const offset = Number(flag(args, "offset", "0")),
      limit = Number(flag(args, "limit", "50"));
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 200
    )
      throw new Error(
        "检查分页参数无效；请传 offset >= 0 且 limit 为 1–200 的整数。",
      );
    const snapshot = await readProjectSnapshot(host, root);
    const name = args.includes("--draft")
      ? volume(flag(args, "draft"))
      : undefined;
    if (name && !project.drafts.includes(name))
      throw new Error(
        `分册不存在（${name}）；可用分册：${project.drafts.join("、") || "暂无（请先用 extract 创建）"}。`,
      );
    const volumes = snapshot.reports
      .filter((item) => !name || item.draft === name)
      .map((item) => pageReport(item, group, offset, limit));
    const summary = {
      ready: snapshot.ready,
      complete: snapshot.complete,
      projectCounts: snapshot.counts,
      blockingCounts: snapshot.blockingCounts,
      revision: snapshot.revision,
    };
    if (name) return { ...volumes[0], ...summary };
    return volumes.length === 0 &&
      (snapshot.counts.C12 > 0 || snapshot.counts.C14 > 0)
      ? {
          ...summary,
          counts: snapshot.counts,
          volumes,
          requirements: snapshot.requirementResults,
        }
      : { ...summary, counts: snapshot.counts, volumes };
  }
  if (action === "requirements") {
    const subAction = flag(args, "action");
    if (subAction !== "save" && subAction !== "patch" && subAction !== "list") {
      throw new Error(
        "requirements action 必须为 save、patch 或 list；人工覆盖标记仅限工作台操作。",
      );
    }
    if (subAction === "list") {
      if (args.includes("--items")) {
        throw new Error("requirements list 不接受 items 参数");
      }
      const offset = Number(flag(args, "offset", "0")),
        limit = Number(flag(args, "limit", "50"));
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 200
      ) {
        throw new Error(
          "requirements 分页参数无效；请传 offset >= 0 且 limit 为 1–200 的整数。",
        );
      }
      const state = await readRequirementsState(root);
      if (state.kind === "missing") {
        return {
          kind: "missing",
          total: 0,
          offset,
          limit,
          items: [],
          truncated: false,
          nextOffset: null,
        };
      }
      if (state.kind === "error") {
        return {
          kind: "error",
          reason: state.reason,
          action:
            "requirements.json 损坏或无法读取；请用 requirements save 写入合法清单。",
          total: 0,
          offset,
          limit,
          items: [],
          truncated: false,
          nextOffset: null,
        };
      }
      return {
        kind: "value",
        ...paginateRequirements(state.items, offset, limit),
      };
    }
    if (args.includes("--offset") || args.includes("--limit")) {
      throw new Error(`requirements ${subAction} 不接受 offset 或 limit 参数`);
    }
    let parsedItems: unknown;
    try {
      parsedItems = JSON.parse(flag(args, "items"));
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("缺少 --items")
      ) {
        throw new Error("缺少 items；请提供要求条目数组进行保存。");
      }
      throw new Error("items 必须是合法的 JSON 数组");
    }
    if (subAction === "patch") {
      const state = await readRequirementsState(root);
      if (state.kind === "missing") {
        throw new Error(
          JSON.stringify({
            patched: false,
            reason:
              "requirements.json 尚不存在；请先用 action=\"save\" 保存初始要求清单。",
          }),
        );
      }
      if (state.kind === "error") {
        throw new Error(
          JSON.stringify({
            patched: false,
            reason: `requirements.json 损坏或无法读取：${state.reason}；请先用 action="save" 重建。`,
          }),
        );
      }
      const patched = patchRequirements(state.items, parsedItems);
      if (patched.errors.length > 0) {
        throw new Error(
          JSON.stringify({
            patched: false,
            reason: `要求清单增量更新校验失败（${patched.errors.length} 项错误），整批未写入`,
            errors: patched.errors,
          }),
        );
      }
      await writeRequirementsFile(host, root, project, patched.items);
      return {
        patched: true,
        format: "seal-requirements-1",
        updatedCount: patched.updatedCount,
        total: patched.items.length,
        mustRespondCount: patched.items.filter((item) => item.mustRespond)
          .length,
      };
    }
    const secret = (await host.authorizationKey?.(false)) ?? null;
    const anchor = await anchorAt(host, root, false);
    const ledger = await resolveLedger(
      await ledgerAt(root),
      root,
      secret,
      anchor.value,
    );
    const sources = await registeredTenderSources(root, project, ledger);
    const validated = await validateRequirementsBatch(parsedItems, sources);
    if (validated.errors.length > 0) {
      throw new Error(
        JSON.stringify({
          saved: false,
          reason: `要求清单校验失败（${validated.errors.length} 项错误），整批未写入`,
          errors: validated.errors,
        }),
      );
    }
    await writeRequirementsFile(host, root, project, validated.items);
    return {
      saved: true,
      format: "seal-requirements-1",
      count: validated.items.length,
      mustRespondCount: validated.items.filter((item) => item.mustRespond)
        .length,
    };
  }
  const name = volume(flag(args, "draft"));
  const draft = await draftPath(root, name),
    base = await draftPath(root, name, true);
  if (action === "extract") {
    for (const file of [base, draft]) {
      try {
        await lstat(file);
        throw new Error(
          `分册已存在（${name}）；请改用新分册名或直接用 read/edit 操作该分册。`,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const source = await existing(root, flag(args, "tender"));
    if (
      !project.tenders.some((item) => path.resolve(root, item.copy) === source)
    )
      throw new Error(
        `请选择项目登记的招标文件副本；可用值：${project.tenders.map((item) => item.copy).join("、") || "无"}。`,
      );
    const ranges = JSON.parse(flag(args, "ranges")) as ExtractionRange[];
    if (!Array.isArray(ranges)) throw new Error("ranges 必须是列表");
    const key = await ledgerKey(host),
      anchor = await anchorAt(host, root, true);
    const ledger = await resolveLedger(
      await ledgerAt(root),
      root,
      key,
      anchor.value,
    );
    const sourceBytes = await readFile(source);
    const relativeSource = path.relative(root, source);
    if (
      !ledger.tenders?.[relativeSource] ||
      ledger.tenders[relativeSource] !== sha256Hex(sourceBytes)
    )
      throw new Error("招标副本与已封印摘要不一致或摘要缺失");
    const result = await prepareExtractedDraft(
      project,
      ledger,
      name,
      sourceBytes,
      ranges,
      host,
    );
    await sealLedger(ledger, root, key);
    await persistExtractedDraft(host, {
      basePath: base,
      draftPath: draft,
      projectPath: path.join(root, "seal-project.json"),
      ledgerPath: path.join(root, "ledger.json"),
      anchorPath: anchor.path,
      base: result.base,
      draft: result.draft,
      project,
      ledger,
    });
    return {
      draft: name,
      hints: result.hints,
      removedMarkers: result.removedMarkers,
      renamedMarkers: result.renamedMarkers,
    };
  }
  const actualDraft = await existing(root, path.relative(root, draft));
  if (actualDraft !== draft || (await lstat(draft)).isSymbolicLink())
    throw new Error("分册路径不是项目内的普通文件");
  if (action === "edit") {
    const operations = JSON.parse(flag(args, "ops")) as AgentEdit[];
    if (!Array.isArray(operations)) throw new Error("ops 必须是列表");
    const old = await readFile(actualDraft),
      key = await ledgerKey(host),
      anchor = await anchorAt(host, root, true);
    const ledger = await resolveLedger(
      await ledgerAt(root),
      root,
      key,
      anchor.value,
    );
    if (ledger.drafts[name] !== sha256Hex(old) && !ledger.integrityIncident) {
      const untrusted = JSON.stringify({
        draft: name,
        expected: ledger.drafts[name] ?? null,
        actual: sha256Hex(old),
      });
      ledger.integrityIncident = {
        reason: "草稿在 Seal 之外发生变化",
        untrusted,
        untrustedHash: sha256Hex(untrusted),
        recoveryNeeded: false,
      };
    }
    const loadedFacts = await loadFactContext(
      host,
      root,
      project,
      factValues(operations),
      false,
    );
    const {
      resolvedOperations,
      facts,
      images,
      markdownImages,
      resolutionErrors,
    } = await resolveOperations(host, root, project, operations, loadedFacts);
    const baseBytes = await readBase(root, base);
    let result: Awaited<ReturnType<typeof editBidDraft>>;
    const diagnosticLedger = structuredClone(ledger);
    try {
      if (resolutionErrors.size > 0) {
        const firstReason = resolutionErrors.values().next().value!;
        throw new Error(firstReason);
      }
      result = await editBidDraft({
        name,
        old,
        base: baseBytes,
        host,
        ledger,
        operations: resolvedOperations,
        images,
        markdownImages,
        facts,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const diagnostic = await diagnoseEditFailure({
        name,
        old,
        base: baseBytes,
        host,
        ledger: diagnosticLedger,
        operations: resolvedOperations,
        images,
        markdownImages,
        facts,
        resolutionErrors,
        reason,
      });
      throw new Error(JSON.stringify(diagnostic));
    }
    await sealLedger(result.ledger, root, key);
    await persistEditedDraft(
      host,
      actualDraft,
      path.join(root, "ledger.json"),
      anchor.path,
      result.output,
      result.ledger,
    );
    return {
      draft: name,
      operations: result.operations,
      results: result.results,
      pending: result.pending.map(
        ({ originalHighlights: _originalHighlights, ...item }) => item,
      ),
    };
  }
  throw new Error(
    "支持的 project 命令：init、read、extract、edit、check、requirements",
  );
}
