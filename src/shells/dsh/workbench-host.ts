import fs from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { HostPort } from "../../core/host.js";
import {
  readProjectSnapshot,
  runProject,
  runProjectUnlocked,
} from "../cli/project-v2.js";
import { serializedProject } from "../cli/project-operations.js";
import { runKnowledgeBase } from "../cli/kb.js";
import { KnowledgeBase } from "../../core/kb/index.js";
import type { KbKind } from "../../core/kb/types.js";
import {
  assertKnowledgeBaseTree,
  knowledgeBasesRoot,
  serializedKnowledgeBase,
} from "../knowledge-base-service.js";
import { assertOutputIsolation } from "../output-isolation.js";
import {
  detectLibreOfficeStatus,
  isPopplerPdfEngine,
} from "../node-host.js";
import {
  confirmPending,
  acceptChange,
  markCoverage,
  reviewHint,
  type DraftReviewCache,
} from "../../core/bid/human-review.js";
import { requirementCoverageDigest } from "../../core/bid/requirements.js";
import { sealLedger } from "../../core/bid/ledger-integrity.js";
import { finalizeDraftMarkers } from "../../core/bid/finalize.js";
import { checkIdentity } from "../../core/bid/check.js";
import { invalidDates } from "../../core/bid/dates.js";
import { readableParagraphs } from "../../core/docx/read-document.js";
import { outline, xmlAttributes } from "../../core/docx/outline.js";
import {
  resolveRelationshipTarget,
  validatePackageStructure,
} from "../../core/docx/package-structure.js";
import { parseDocumentBody, xmlElements } from "../../core/docx/xml.js";
import { validatePackageImages } from "../../core/docx/package-images.js";
import { auditImageLayout } from "../../core/docx/layout.js";
import { sealRanges } from "../../core/docx/seal-ranges.js";
import { resolveAddress } from "../../core/docx/addresses.js";
import { editableText } from "../../core/docx/visible-surgery.js";
import { sha256Hex } from "../../core/docx/zip.js";
import type { Difference } from "../../core/docx/compare.js";
import {
  reviewItems,
  reviewPage,
  type DraftOutlineHint,
  type ReviewItem,
} from "../../workbench/review.js";
import { buildRequirementsView } from "../../workbench/requirements.js";
import {
  buildKnowledgeCatalog,
  summarizeVaultOverview,
} from "../../workbench/knowledge.js";

type Snapshot = Awaited<ReturnType<typeof readProjectSnapshot>>;
const encoder = new TextEncoder();
const decode = (bytes: Uint8Array) =>
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
function required(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label}不能为空`);
  return value;
}
function identifier(value: unknown): string {
  const id = required(value, "编号");
  if (!/^[\p{L}\p{N}_ -]{1,120}$/u.test(id))
    throw new Error("编号包含非法字符");
  return id;
}
function fileList(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.some((file) => typeof file !== "string" || !path.isAbsolute(file))
  )
    throw new Error("请选择本机文件");
  return value as string[];
}
async function regular(file: string): Promise<string> {
  const physical = await fs.realpath(file),
    stat = await fs.lstat(file);
  if (
    physical !== path.resolve(file) ||
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.nlink !== 1
  )
    throw new Error("文件必须是隔离目录中的普通文件");
  return physical;
}
async function itemsFor(snapshot: Snapshot): Promise<ReviewItem[]> {
  const blocks = new Map<string, string>();
  const outlines: DraftOutlineHint[] = [];
  for (const volume of snapshot.volumes) {
    try {
      const parts = await validatePackageStructure(volume.draft);
      for (const block of readableParagraphs(parts))
        blocks.set(`${volume.name}:${block.address}`, block.text);
      try {
        const docXml = decode(parts.get("word/document.xml")!);
        const relsXml = parts.has("word/_rels/document.xml.rels")
          ? decode(parts.get("word/_rels/document.xml.rels")!)
          : "";
        const stylesTarget = relsXml
          ? xmlElements(relsXml)
              .filter((el) => el.name.split(":").pop() === "Relationship")
              .map((el) => xmlAttributes(relsXml, el))
              .find(
                (attrs) =>
                  attrs.get("Type")?.split("/").pop() === "styles" &&
                  attrs.get("TargetMode") !== "External",
              )
              ?.get("Target")
          : undefined;
        const stylesPath = stylesTarget
          ? resolveRelationshipTarget("word/", stylesTarget)
          : "word/styles.xml";
        const stylesXml = parts.has(stylesPath)
          ? decode(parts.get(stylesPath)!)
          : "";
        const bodyBlocks = parseDocumentBody(docXml).blocks.filter(
          (block) => block.kind === "paragraph" || block.kind === "table",
        );
        outlines.push({
          draft: volume.name,
          blockOrder: bodyBlocks.map(
            (block) =>
              `${block.kind === "paragraph" ? "p" : "t"}:${block.index}`,
          ),
          sections: outline(docXml, stylesXml).map((section) => ({
            address: section.from,
            from: section.from,
            to: section.to,
            level: section.level,
            title: section.title,
          })),
        });
      } catch {
        /* Missing or invalid styles fall back to default draft/table sectioning. */
      }
    } catch {
      /* The original C01 failure remains visible in the review report. */
    }
  }
  return reviewItems(snapshot.reports, blocks, outlines);
}

function currentEnvironment() {
  return {
    platform: process.platform,
    pdfEngine: isPopplerPdfEngine()
      ? ("poppler" as const)
      : ("builtin-pdfium" as const),
    libreOffice: detectLibreOfficeStatus(),
  };
}

/** Owner-carrier entrypoints; never register these methods as Agent tools or CLI commands. */
export class WorkbenchHost {
  readonly home: string;
  constructor(readonly host: HostPort) {
    this.home = path.resolve(
      process.env.SEAL_HOME ?? path.join(homedir(), ".seal"),
    );
  }

  async status() {
    const manifest = JSON.parse(
      await fs.readFile(
        new URL("../../../package.json", import.meta.url),
        "utf8",
      ),
    );
    return {
      version: manifest.version as string,
      home: this.home,
      knowledgeBasesRoot: knowledgeBasesRoot(),
      temporaryDirectory: process.env.TMPDIR ?? null,
      environment: currentEnvironment(),
    };
  }

  async projectRoot(id: unknown): Promise<string> {
    const directory = path.join(this.home, "projects", identifier(id));
    const physical = await fs.realpath(directory);
    if (
      physical !== directory ||
      !physical.startsWith(path.join(this.home, "projects") + path.sep)
    )
      throw new Error("项目路径越界");
    return physical;
  }

  async projectForCwd(cwd: unknown) {
    if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return null;
    try {
      const physical = await fs.realpath(cwd),
        id = path.basename(physical);
      return (await this.projectRoot(id)) === physical ? id : null;
    } catch {
      return null;
    }
  }

  private async resolveVaultName(
    vaultId: string | null | undefined,
  ): Promise<string | null> {
    if (typeof vaultId !== "string" || !vaultId.trim()) return null;
    try {
      const vaultRoot = knowledgeBasesRoot();
      assertKnowledgeBaseTree(vaultRoot);
      const metadata = await new KnowledgeBase(this.host, vaultRoot).metadata(
        vaultId,
      );
      return metadata.name;
    } catch {
      return null;
    }
  }

  async overview() {
    const projects: Array<Record<string, unknown>> = [],
      vaults: Array<Record<string, unknown>> = [];
    let entries: string[];
    try {
      entries = await fs.readdir(path.join(this.home, "projects"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      entries = [];
    }
    for (const id of entries) {
      try {
        const root = await this.projectRoot(id);
        const snapshot = await serializedProject(root, () =>
          readProjectSnapshot(this.host, root),
        );
        let binding: unknown = null;
        try {
          binding = JSON.parse(
            await fs.readFile(
              await regular(path.join(root, "ui-binding.json")),
              "utf8",
            ),
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            binding = { error: "会话关联文件无法读取，请重新关联" };
        }
        projects.push({
          id,
          root,
          project: snapshot.project,
          ready: snapshot.ready,
          counts: snapshot.counts,
          binding,
        });
      } catch (error) {
        projects.push({ id, error: message(error) });
      }
    }
    const vaultRoot = knowledgeBasesRoot();
    assertKnowledgeBaseTree(vaultRoot);
    try {
      entries = await fs.readdir(vaultRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      entries = [];
    }
    const kb = new KnowledgeBase(this.host, vaultRoot),
      date = new Date().toISOString().slice(0, 10);
    for (const id of entries) {
      try {
        const metadata = await kb.metadata(id),
          subject = await kb.get(id, "subject"),
          health = await kb.health(id, date),
          materials = await this.listVaultMaterials(kb, id),
          pendingBatches = await kb.listPendingBatches(id);
        vaults.push({
          ...metadata,
          creditCode: subject.fields.creditCode,
          ...summarizeVaultOverview({
            records: health.records,
            materials,
            issues: health.issues,
            subject,
            pendingBatches,
          }),
        });
      } catch (error) {
        vaults.push({ vaultId: id, error: message(error) });
      }
    }
    const vaultNameById = new Map<string, string>();
    for (const vault of vaults) {
      if (
        typeof vault.vaultId === "string" &&
        typeof vault.name === "string" &&
        !vault.error
      ) {
        vaultNameById.set(vault.vaultId, vault.name);
      }
    }
    for (const project of projects) {
      const meta = project.project as { vaultId?: string | null } | undefined;
      if (meta) {
        project.vaultName =
          typeof meta.vaultId === "string" && meta.vaultId
            ? (vaultNameById.get(meta.vaultId) ?? null)
            : null;
      }
    }
    return { projects, vaults, environment: currentEnvironment() };
  }

  async create(input: Record<string, unknown>) {
    const id = `project-${randomUUID()}`,
      root = path.join(this.home, "projects", id),
      files = fileList(input.files);
    await fs.mkdir(path.dirname(root), { recursive: true });
    assertOutputIsolation({ directories: [root] }, { files });
    const projectName = required(input.name, "项目名称");
    const deadline = required(input.deadline, "截标日");
    const kbRoot = knowledgeBasesRoot();
    assertKnowledgeBaseTree(kbRoot);
    return serializedKnowledgeBase(kbRoot, async () => {
      const args = [
        "init",
        "--root",
        root,
        "--name",
        projectName,
        "--deadline",
        deadline,
        ...files.flatMap((file) => ["--tender", file]),
      ];
      let vaultName: string | null = null;
      if (typeof input.vaultId === "string" && input.vaultId) {
        const metadata = await new KnowledgeBase(this.host, kbRoot).metadata(
          input.vaultId,
        );
        vaultName = metadata.name;
        args.push("--vault", input.vaultId);
      }
      const project = await runProject(this.host, args);
      return { id, root, project, vaultName };
    });
  }

  async deleteProject(input: Record<string, unknown>) {
    const projectId = identifier(input.projectId);
    const projectsRoot = path.join(this.home, "projects");
    let physicalProjectsRoot: string;
    try {
      const rootStat = await fs.lstat(projectsRoot);
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        throw new Error("项目根目录无效");
      }
      physicalProjectsRoot = await fs.realpath(projectsRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("项目不存在");
      }
      throw error;
    }
    const target = path.join(projectsRoot, projectId);
    let targetStat;
    try {
      targetStat = await fs.lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("项目不存在");
      }
      throw error;
    }
    if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
      throw new Error("项目目录无效（不能为符号链接）");
    }
    const physicalRoot = await fs.realpath(target);
    if (physicalRoot !== path.join(physicalProjectsRoot, projectId)) {
      throw new Error("项目路径越界");
    }
    return serializedProject(physicalRoot, async () => {
      if (this.host.ledgerAnchorPath) {
        const anchorCandidates = new Set<string>([
          await this.host.ledgerAnchorPath(physicalRoot, false),
        ]);
        if (target !== physicalRoot) {
          anchorCandidates.add(await this.host.ledgerAnchorPath(target, false));
        }
        for (const anchorPath of anchorCandidates) {
          try {
            const anchorStat = await fs.lstat(anchorPath);
            if (anchorStat.isFile() && !anchorStat.isSymbolicLink()) {
              await fs.unlink(anchorPath);
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
              throw error;
            }
          }
        }
      }
      await fs.rm(physicalRoot, { recursive: true, force: false });
      return { deleted: true, projectId };
    });
  }

  async bind(input: Record<string, unknown>) {
    const root = await this.projectRoot(input.projectId);
    const binding = {
      workspaceId: required(input.workspaceId, "工作区"),
      sessionId: required(input.sessionId, "会话"),
    };
    await this.host.writeFiles!([
      {
        path: path.join(root, "ui-binding.json"),
        data: encoder.encode(JSON.stringify(binding)),
      },
    ]);
    return binding;
  }

  async review(input: Record<string, unknown>) {
    const selected = input.projectId ?? (await this.projectForCwd(input.cwd));
    if (!selected) return { kind: "not_project" as const };
    const id = required(selected, "项目");
    const root = await this.projectRoot(id);
    return serializedProject(root, async () => {
      const snapshot = await readProjectSnapshot(this.host, root),
        items = await itemsFor(snapshot);
      let exported: { revision: string; files: string[] } | null = null;
      try {
        exported = JSON.parse(
          await fs.readFile(
            await regular(path.join(root, "final/export.json")),
            "utf8",
          ),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const vaultName = await this.resolveVaultName(snapshot.project.vaultId);
      return {
        kind: "project" as const,
        projectId: id,
        project: snapshot.project,
        vaultName,
        revision: snapshot.revision,
        ready: snapshot.ready,
        complete: snapshot.complete,
        counts: snapshot.counts,
        blockingCounts: snapshot.blockingCounts,
        groups: reviewPage(
          items,
          input.pages as Record<string, number> | undefined,
          undefined,
          input.sections as Record<string, string> | undefined,
        ),
        limitations: snapshot.reports.flatMap((report) => report.limitations),
        exported: exported
          ? { ...exported, stale: exported.revision !== snapshot.revision }
          : null,
      };
    });
  }

  async requirements(input: Record<string, unknown>) {
    const selected = input.projectId ?? (await this.projectForCwd(input.cwd));
    if (!selected) return { kind: "not_project" as const };
    const id = required(selected, "项目");
    const root = await this.projectRoot(id);
    const offset = input.offset === undefined ? 0 : Number(input.offset);
    const limit = input.limit === undefined ? 25 : Number(input.limit);
    return serializedProject(root, async () => {
      const snapshot = await readProjectSnapshot(this.host, root);
      const view = buildRequirementsView({
        state: snapshot.requirements,
        c12: snapshot.requirementResults.C12,
        c14: snapshot.requirementResults.C14,
        validMarks: snapshot.coverageSummary.validMarks,
        expiredIds: snapshot.coverageSummary.expiredIds,
        drafts: snapshot.project.drafts,
        offset,
        limit,
      });
      return {
        projectKind: "project" as const,
        projectId: id,
        project: snapshot.project,
        revision: snapshot.revision,
        ...view,
      };
    });
  }

  async cover(input: Record<string, unknown>) {
    if (
      [
        "requirement",
        "response",
        "authorization",
        "covered",
        "fingerprint",
      ].some((key) => Object.hasOwn(input, key))
    ) {
      throw new Error(
        "人工覆盖只能由宿主重读实际内容签名，客户端不得传入内容或签名",
      );
    }
    const root = await this.projectRoot(input.projectId);
    const expectedRevision = required(
      input.expectedRevision ?? input.revision,
      "修订版本",
    );
    const id = required(input.id, "要求编号");
    const draft = required(input.draft, "分册");
    const address = required(input.address, "响应地址");
    return serializedProject(root, async () => {
      const snapshot = await readProjectSnapshot(this.host, root);
      if (snapshot.revision !== expectedRevision) {
        throw new Error(
          "版本冲突：草稿、要求清单或资料已变化。输入已保留，请刷新后重新核对。",
        );
      }
      if (!snapshot.secret || !snapshot.ledger.integrity) {
        throw new Error("台账或授权密钥无法核验");
      }
      if (snapshot.requirements.kind !== "value") {
        throw new Error("要求清单尚未建立或无法读取");
      }
      const requirement = snapshot.requirements.items.find(
        (item) => item.id === id,
      );
      if (!requirement) throw new Error("要求不存在，请刷新后重试");
      const volume = snapshot.volumes.find((item) => item.name === draft);
      if (!volume) throw new Error("分册不存在");
      if (snapshot.ledger.drafts[draft] !== sha256Hex(volume.draft)) {
        throw new Error("草稿在 Seal 之外发生变化，不能签发覆盖标记");
      }
      const xml = decode(
        (await validatePackageStructure(volume.draft)).get(
          "word/document.xml",
        )!,
      );
      const responseText = editableText(resolveAddress(xml, address).xml);
      if (!responseText.trim()) {
        throw new Error(
          "所选响应位置没有可见文本内容，请选择包含响应文字的段落或单元格",
        );
      }
      const ledger = structuredClone(snapshot.ledger);
      await markCoverage(
        ledger,
        {
          id: requirement.id,
          draft,
          address,
          requirement: requirementCoverageDigest(requirement),
          response: responseText,
        },
        {
          root,
          vaultId: snapshot.project.vaultId,
          deadline: snapshot.project.deadline,
        },
        snapshot.secret,
      );
      await sealLedger(ledger, root, snapshot.secret);
      await this.host.writeFiles!([
        {
          path: path.join(root, "ledger.json"),
          data: encoder.encode(JSON.stringify(ledger, null, 2)),
        },
        {
          path: snapshot.anchor.path,
          data: encoder.encode(JSON.stringify(ledger.integrity)),
        },
      ]);
      return { saved: true, id: requirement.id, draft, address };
    });
  }

  async act(input: Record<string, unknown>) {
    const root = await this.projectRoot(input.projectId);
    return serializedProject(root, async () => {
      const snapshot = await readProjectSnapshot(this.host, root);
      if (snapshot.revision !== input.revision)
        throw new Error(
          "版本冲突：草稿或资料已变化。输入已保留，请刷新后重新核对。",
        );
      const section =
        input.section === undefined
          ? undefined
          : required(input.section, "分节");
      if (section !== undefined && typeof input.group !== "string")
        throw new Error("分节批量操作需要指定类别");
      const action = required(input.action, "操作");
      if (
        typeof input.group === "string" &&
        ((action === "accept" && input.group !== "bracketText") ||
          (action === "review" && input.group !== "C03") ||
          (action === "confirm" && !input.group.startsWith("pending:")) ||
          !["confirm", "accept", "review"].includes(action))
      )
        throw new Error("该类别不支持批量操作");
      const rows = await itemsFor(snapshot),
        keys =
          typeof input.group === "string"
            ? rows
                .filter(
                  (row) =>
                    row.group === input.group &&
                    (section === undefined || row.sectionKey === section),
                )
                .map((row) => row.key)
            : input.keys;
      if (
        !Array.isArray(keys) ||
        !keys.length ||
        keys.some((key) => typeof key !== "string") ||
        new Set(keys).size !== keys.length
      )
        throw new Error("请选中有效审阅项");
      const selected = keys.map((key) => {
        const row = rows.find((item) => item.key === key);
        if (!row) throw new Error("审阅项已失效，请刷新");
        return row;
      });
      if (
        ![
          "confirm",
          "accept",
          "review",
          "confirm_accept",
          "modify",
          "finalize",
        ].includes(action)
      )
        throw new Error("不支持的人工操作");
      if (action === "modify") {
        if (selected.length !== 1 || !selected[0].actions.includes("modify"))
          throw new Error("该审阅项不支持直接修改");
        const row = selected[0],
          value =
            typeof input.value === "string"
              ? input.value
              : required(input.value, "修改内容");
        await runProjectUnlocked(this.host, [
          "edit",
          "--project",
          root,
          "--draft",
          row.draft,
          "--ops",
          JSON.stringify([
            { op: "replace", at: row.address, find: row.value, value },
          ]),
        ]);
        return { saved: true };
      }
      if (action === "finalize") throw new Error("请使用独立的项目定稿操作");
      const context = {
        root,
        vaultId: snapshot.project.vaultId,
        deadline: snapshot.project.deadline,
      };
      if (!snapshot.secret || !snapshot.ledger.integrity)
        throw new Error("台账或授权密钥无法核验");
      const ledger = structuredClone(snapshot.ledger);
      const xmlByDraft = new Map<string, string>();
      const reviewCacheByDraft = new Map<string, DraftReviewCache>();
      const volumeByDraft = new Map(
        snapshot.volumes.map((volume) => [volume.name, volume]),
      );
      const reportByDraft = new Map(
        snapshot.reports.map((report) => [report.draft, report]),
      );
      const draftXml = async (
        draft: string,
      ): Promise<{ xml: string; cache: DraftReviewCache }> => {
        const cached = xmlByDraft.get(draft);
        if (cached !== undefined) {
          return { xml: cached, cache: reviewCacheByDraft.get(draft)! };
        }
        const volume = volumeByDraft.get(draft);
        if (!volume) throw new Error("分册不存在");
        const xml = decode(
          (await validatePackageStructure(volume.draft)).get(
            "word/document.xml",
          )!,
        );
        const cache: DraftReviewCache = {};
        xmlByDraft.set(draft, xml);
        reviewCacheByDraft.set(draft, cache);
        return { xml, cache };
      };
      for (const row of selected) {
        const wantsConfirm =
            action === "confirm" || action === "confirm_accept",
          wantsAccept = action === "accept" || action === "confirm_accept";
        if (
          (wantsConfirm && !row.actions.includes("confirm")) ||
          (wantsAccept && !row.actions.includes("accept")) ||
          (action === "review" && !row.actions.includes("review"))
        )
          throw new Error("此项不支持所选人工操作");
        const { xml, cache } = await draftXml(row.draft);
        if (wantsConfirm)
          for (const id of row.pendingIds)
            await confirmPending(
              ledger,
              row.draft,
              id,
              xml,
              context,
              snapshot.secret,
              cache,
            );
        if (wantsAccept)
          for (const id of row.differenceIds) {
            const report = reportByDraft.get(row.draft)!;
            const difference = [
              ...report.results.C06,
              ...report.results.C07,
            ].find((value) => (value as Difference).id === id) as
              | Difference
              | undefined;
            if (!difference) throw new Error("原文改动已失效");
            await acceptChange(
              ledger,
              row.draft,
              difference,
              context,
              snapshot.secret,
            );
          }
        if (action === "review")
          for (const id of row.hintIds)
            await reviewHint(
              ledger,
              row.draft,
              id,
              xml,
              context,
              snapshot.secret,
              typeof input.reason === "string"
                ? input.reason
                : "人工确认无需填写",
              cache,
            );
      }
      await sealLedger(ledger, root, snapshot.secret);
      await this.host.writeFiles!([
        {
          path: path.join(root, "ledger.json"),
          data: encoder.encode(JSON.stringify(ledger, null, 2)),
        },
        {
          path: snapshot.anchor.path,
          data: encoder.encode(JSON.stringify(ledger.integrity)),
        },
      ]);
      return { saved: true, processed: selected.length };
    });
  }

  async finalize(input: Record<string, unknown>) {
    const root = await this.projectRoot(input.projectId);
    return serializedProject(root, async () => {
      const snapshot = await readProjectSnapshot(this.host, root);
      if (snapshot.revision !== input.revision)
        throw new Error("版本冲突，请重新检查后导出");
      if (!snapshot.ready || !snapshot.secret)
        throw new Error("定稿闸门未通过，请先处理全部分册的阻断项");
      const files = [];
      for (const volume of snapshot.volumes) {
        const data = await finalizeDraftMarkers(this.host, {
          name: volume.name,
          root,
          draft: volume.draft,
          base: volume.base,
          project: snapshot.project,
          ledger: snapshot.ledger,
          secret: snapshot.secret,
          anchor: snapshot.anchor.value,
        });
        const parts = await validatePackageStructure(data),
          xml = decode(parts.get("word/document.xml")!);
        const blocks = readableParagraphs(parts);
        const postcheck = {
          C01: await validatePackageImages(parts, this.host),
          C09: snapshot.identity
            ? checkIdentity(blocks, snapshot.identity)
            : [],
          C10: sealRanges(xml).filter((range) =>
            range.name.startsWith("_Seal_"),
          ),
          C11: blocks.flatMap((block) => invalidDates(block.text)),
          C16: auditImageLayout(
            xml,
            decode(parts.get("word/styles.xml") ?? new Uint8Array()),
          ),
        };
        for (const [code, issues] of Object.entries(postcheck))
          if (issues.length)
            throw new Error(`终稿复检失败：${volume.name} ${code}`);
        files.push({
          path: path.join(root, "final", `${volume.name}.docx`),
          data,
        });
      }
      assertOutputIsolation(
        { files: files.map((file) => file.path) },
        {
          files: snapshot.volumes.flatMap((volume) => [
            volume.file,
            volume.file.replace(/\.docx$/, ".base.docx"),
          ]),
          directories: [path.join(root, "tender")],
        },
      );
      const exported = {
        revision: snapshot.revision,
        files: snapshot.volumes.map((volume) => volume.name),
        exportedAt: new Date().toISOString(),
      };
      files.push({
        path: path.join(root, "final/export.json"),
        data: encoder.encode(JSON.stringify(exported)),
      });
      await this.host.writeFiles!(files);
      return exported;
    });
  }

  async preview(input: Record<string, unknown>) {
    const root = await this.projectRoot(input.projectId),
      name = identifier(input.draft);
    const snapshot = await serializedProject(root, () =>
      readProjectSnapshot(this.host, root),
    );
    const volume = snapshot.volumes.find((volume) => volume.name === name);
    if (!volume || !this.host.renderDocxPages)
      throw new Error("分册或宿主渲染能力不可用");
    const digest = sha256Hex(volume.draft),
      directory = path.join(root, "review", `${name}-${digest}`);
    await fs.mkdir(directory, { recursive: true });
    const copied = path.join(directory, "preview.docx");
    await this.host.writeBytes(copied, volume.draft);
    const pages = await this.host.renderDocxPages(
      copied,
      path.join(directory, "pages"),
    );
    const current = await serializedProject(root, () =>
      readProjectSnapshot(this.host, root),
    );
    if (current.revision !== snapshot.revision)
      throw new Error("渲染期间草稿已变化，请重新预览");
    return {
      digest,
      pages: pages.map((_, index) => ({
        page: index + 1,
        file: path.relative(root, pages[index]),
      })),
      revision: snapshot.revision,
    };
  }

  async file(
    input: Record<string, unknown>,
  ): Promise<{ bytes: Uint8Array; name: string; type: string }> {
    const root = await this.projectRoot(input.projectId);
    if (typeof input.preview === "string") {
      if (
        !/^review\/[\p{L}\p{N}_ -]+-[a-f0-9]{64}\/pages\/page-\d+\.png$/u.test(
          input.preview,
        )
      )
        throw new Error("预览页路径无效");
      return {
        bytes: await fs.readFile(await regular(path.join(root, input.preview))),
        name: path.basename(input.preview),
        type: "image/png",
      };
    }
    const draft = identifier(input.draft),
      snapshot = await serializedProject(root, () =>
        readProjectSnapshot(this.host, root),
      );
    if (!snapshot.project.drafts.includes(draft)) throw new Error("分册不存在");
    const directory = input.final === "true" ? "final" : "draft";
    if (directory === "final") {
      const exported = JSON.parse(
        await fs.readFile(
          await regular(path.join(root, "final/export.json")),
          "utf8",
        ),
      );
      if (exported.revision !== snapshot.revision)
        throw new Error("终稿已过时，请重新导出");
    }
    return {
      bytes: await fs.readFile(
        await regular(path.join(root, directory, `${draft}.docx`)),
      ),
      name: `${draft}.docx`,
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    };
  }

  private async listVaultMaterials(kb: KnowledgeBase, vaultId: string) {
    if (!this.host.listFiles) throw new Error("宿主资料枚举能力不可用");
    const files = (await this.host.listFiles(kb.vaultRoot(vaultId)))
      .filter((file) => /^materials\/[^/]+\.md$/.test(file))
      .sort();
    const materials = [];
    for (const file of files) {
      const id = file.slice("materials/".length, -3);
      try {
        materials.push(await kb.get(vaultId, "material", id));
      } catch {
        /* Malformed material entries are reported in health.issues as entry_malformed. */
      }
    }
    return materials;
  }

  async kb(input: Record<string, unknown>) {
    const action = required(input.action, "知识库操作");
    if (action === "create")
      return runKnowledgeBase(this.host, [
        "init",
        "--name",
        required(input.name, "知识库名称"),
      ]);
    const vaultId = required(input.vaultId, "知识库"),
      root = knowledgeBasesRoot();
    assertKnowledgeBaseTree(root);
    if (action === "catalog") {
      const kb = new KnowledgeBase(this.host, root),
        health = await kb.health(
          vaultId,
          new Date().toISOString().slice(0, 10),
        ),
        materials = await this.listVaultMaterials(kb, vaultId),
        pendingBatches = await kb.listPendingBatches(vaultId);
      return {
        root: kb.vaultRoot(vaultId),
        ...buildKnowledgeCatalog({
          records: health.records,
          materials,
          issues: health.issues,
          pendingBatches,
          kind:
            input.kind === "record" || input.kind === "material"
              ? input.kind
              : undefined,
          query: typeof input.query === "string" ? input.query : undefined,
          type: typeof input.type === "string" ? input.type : undefined,
          validity:
            typeof input.validity === "string" ? input.validity : undefined,
          verified:
            typeof input.verified === "string" ? input.verified : undefined,
          offset: input.offset === undefined ? 0 : Number(input.offset),
          issueOffset:
            input.issueOffset === undefined ? 0 : Number(input.issueOffset),
        }),
      };
    }
    if (action === "candidates")
      return new KnowledgeBase(this.host, root).listCandidates(
        vaultId,
        required(input.batchId, "批次"),
        25,
        typeof input.after === "string" ? input.after : undefined,
      );
    if (action === "candidate")
      return new KnowledgeBase(this.host, root).getCandidate(
        vaultId,
        required(input.id, "候选编号"),
      );
    if (action === "verify")
      return serializedKnowledgeBase(root, async () => {
        const kb = new KnowledgeBase(this.host, root),
          kind = required(input.kind, "资料类型") as KbKind,
          id = required(input.id, "资料编号");
        if (!["subject", "record"].includes(kind))
          throw new Error("该资料不能核实");
        const current = await kb.get(vaultId, kind, id);
        if (sha256Hex(JSON.stringify(current)) !== input.revision)
          throw new Error("资料已变化，请重新核对后核实");
        const fields = input.fields;
        if (
          !Array.isArray(fields) ||
          fields.some((field) => typeof field !== "string")
        )
          throw new Error("核实字段无效");
        return kb.verify(vaultId, kind, id, fields as string[]);
      });
    if (action === "detail") {
      const kind = required(input.kind, "资料类型") as KbKind;
      if (!["subject", "record", "material"].includes(kind))
        throw new Error("资料类型无效");
      const entry = await new KnowledgeBase(this.host, root).get(
        vaultId,
        kind,
        required(input.id, "资料编号"),
      );
      return { entry, revision: sha256Hex(JSON.stringify(entry)) };
    }
    if (action === "ingest")
      return runKnowledgeBase(this.host, [
        "ingest",
        "--vault",
        vaultId,
        "--files",
        JSON.stringify(fileList(input.files)),
      ]);
    if (action === "save")
      return serializedKnowledgeBase(root, async () => {
        const data = input.data as {
          kind: KbKind;
          id: string;
          action: "update";
          fields: Record<string, unknown>;
          body: string;
        };
        if (
          !data ||
          data.action !== "update" ||
          !["subject", "record", "material"].includes(data.kind)
        )
          throw new Error("资料修改参数无效");
        const kb = new KnowledgeBase(this.host, root),
          current = await kb.get(vaultId, data.kind, data.id);
        if (sha256Hex(JSON.stringify(current)) !== input.revision)
          throw new Error("版本冲突：资料已变化，请重新核对后保存");
        return kb.save(vaultId, data);
      });
    if (action === "delete_batch") {
      const batchId = required(input.batchId, "批次");
      return serializedKnowledgeBase(root, async () =>
        new KnowledgeBase(this.host, root).deleteBatch(vaultId, batchId),
      );
    }
    if (action === "delete_entry") {
      const kind = required(input.kind, "资料类型");
      if (kind !== "record" && kind !== "material") {
        throw new Error("只能删除证据记录或写作素材");
      }
      const id = required(input.id, "资料编号");
      const revision = required(input.revision, "修订版本");
      return serializedKnowledgeBase(root, async () => {
        const kb = new KnowledgeBase(this.host, root);
        const current = await kb.get(vaultId, kind, id);
        if (sha256Hex(JSON.stringify(current)) !== revision) {
          throw new Error("版本冲突：资料已变化，请刷新后重试");
        }
        return kb.deleteEntry(vaultId, kind, id, "human");
      });
    }
    if (action === "delete_vault") {
      if (!/^[\p{L}\p{N}-]+$/u.test(vaultId)) {
        throw new Error("知识库 ID 只能包含字母、数字、连字符与中文");
      }
      return serializedKnowledgeBase(root, async () => {
        let physicalRoot: string;
        try {
          const rootStat = await fs.lstat(root);
          if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
            throw new Error("知识库根目录无效");
          }
          physicalRoot = await fs.realpath(root);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            throw new Error("知识库不存在");
          }
          throw error;
        }
        const target = path.join(root, vaultId);
        let targetStat;
        try {
          targetStat = await fs.lstat(target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            throw new Error("知识库不存在");
          }
          throw error;
        }
        if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
          throw new Error("知识库目录无效（不能为符号链接）");
        }
        const physicalTarget = await fs.realpath(target);
        if (physicalTarget !== path.join(physicalRoot, vaultId)) {
          throw new Error("知识库路径越界");
        }

        const projectsDir = path.join(this.home, "projects");
        let projectEntries: Array<{ name: string }> = [];
        try {
          projectEntries = await fs.readdir(projectsDir, { withFileTypes: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const referencingProjects: string[] = [];
        const brokenProjects: string[] = [];
        for (const entry of projectEntries) {
          if (entry.name.startsWith(".")) continue;
          const projectDir = path.join(projectsDir, entry.name);
          try {
            const entryStat = await fs.lstat(projectDir);
            if (entryStat.isSymbolicLink() || !entryStat.isDirectory()) {
              brokenProjects.push(entry.name);
              continue;
            }
            const metaPath = path.join(projectDir, "seal-project.json");
            const metaStat = await fs.lstat(metaPath);
            if (metaStat.isSymbolicLink() || !metaStat.isFile()) {
              brokenProjects.push(entry.name);
              continue;
            }
            const parsed = JSON.parse(await fs.readFile(metaPath, "utf8")) as {
              format?: unknown;
              name?: unknown;
              vaultId?: unknown;
            };
            if (
              !parsed ||
              typeof parsed !== "object" ||
              Array.isArray(parsed) ||
              parsed.format !== "seal-project-1" ||
              (parsed.vaultId !== null && typeof parsed.vaultId !== "string")
            ) {
              brokenProjects.push(entry.name);
              continue;
            }
            if (parsed.vaultId === vaultId) {
              const displayName =
                typeof parsed.name === "string" && parsed.name.trim()
                  ? parsed.name.trim()
                  : entry.name;
              referencingProjects.push(displayName);
            }
          } catch {
            brokenProjects.push(entry.name);
          }
        }
        if (referencingProjects.length > 0) {
          throw new Error(
            `知识库正在被投标项目「${referencingProjects.join("、")}」引用，无法删除`,
          );
        }
        if (brokenProjects.length > 0) {
          throw new Error(
            `无法确认损坏项目「${brokenProjects[0]}」是否引用该知识库，请先在「进行中的投标」清理对应损坏项目`,
          );
        }
        await fs.rm(physicalTarget, { recursive: true, force: false });
        return { deleted: true, vaultId };
      });
    }
    if (action === "search")
      return runKnowledgeBase(this.host, [
        "search",
        "--vault",
        vaultId,
        "--reference-date",
        new Date().toISOString().slice(0, 10),
        "--query",
        typeof input.query === "string" ? input.query : "",
        "--limit",
        "100",
        ...(typeof input.type === "string" && input.type
          ? ["--type", input.type]
          : []),
        ...(typeof input.validity === "string" && input.validity
          ? ["--validity", input.validity]
          : []),
      ]);
    throw new Error("知识库操作无效");
  }

  async kbFile(input: Record<string, unknown>) {
    const root = knowledgeBasesRoot();
    assertKnowledgeBaseTree(root);
    const vaultId = required(input.vaultId, "知识库"),
      kb = new KnowledgeBase(this.host, root);
    const kind = required(input.kind, "类型");
    if (!["subject", "record", "material", "candidate"].includes(kind))
      throw new Error("类型无效");
    const id = required(input.id, "编号");
    const entry =
      kind === "candidate"
        ? await kb.getCandidate(vaultId, id)
        : await kb.get(vaultId, kind as KbKind, id);
    const files =
      kind === "candidate"
        ? Array.isArray(entry.fields.imageFiles)
          ? entry.fields.imageFiles
          : Array.isArray(entry.fields.files)
            ? entry.fields.files.filter(
                (file) =>
                  typeof file === "string" &&
                  /\.(png|jpe?g|gif|bmp|webp|svg|tiff?)$/i.test(file),
              )
            : []
        : entry.fields.files;
    const index = Number(input.index);
    if (
      !Array.isArray(files) ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= files.length
    )
      throw new Error("原件不存在");
    const relative = files[index];
    if (
      typeof relative !== "string" ||
      !/^files\//.test(relative) ||
      relative
        .split("/")
        .some((part) => !part || part === "." || part === "..") ||
      relative.includes("\\")
    )
      throw new Error("原件路径无效");
    const file = await regular(path.join(kb.vaultRoot(vaultId), relative));
    const types: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".bmp": "image/bmp",
      ".tif": "image/tiff",
      ".tiff": "image/tiff",
      ".svg": "image/svg+xml",
      ".webp": "image/webp",
      ".pdf": "application/pdf",
    };
    return {
      bytes: await fs.readFile(file),
      name: path.basename(file),
      type:
        types[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    };
  }
}

export interface OwnerConnection {
  fetch: {
    register(route: {
      path: string;
      methods: string[];
      requestBody?: "buffered";
      fetch(request: Request): Promise<Response>;
    }): () => Promise<void>;
  };
}
export function registerWorkbenchRoutes(
  connection: OwnerConnection,
  service: WorkbenchHost,
): Array<() => Promise<void>> {
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  const safely =
    (operation: (request: Request) => Promise<Response>) =>
    async (request: Request) => {
      try {
        return await operation(request);
      } catch (error) {
        const reason = message(error);
        return json({ error: reason }, reason.includes("版本冲突") ? 409 : 400);
      }
    };
  return [
    connection.fetch.register({
      path: "/api/seal/status",
      methods: ["GET"],
      requestBody: "buffered",
      fetch: safely(async () => json(await service.status())),
    }),
    connection.fetch.register({
      path: "/api/seal/action",
      methods: ["POST"],
      requestBody: "buffered",
      fetch: safely(async (request) => {
        const body = (await request.json()) as Record<string, unknown>;
        if (!body || typeof body !== "object" || Array.isArray(body))
          throw new Error("请求格式无效");
        const operation = required(body.operation, "操作");
        const handlers: Record<
          string,
          (input: Record<string, unknown>) => Promise<unknown>
        > = {
          overview: () => service.overview(),
          create: (input) => service.create(input),
          delete_project: (input) => service.deleteProject(input),
          bind: (input) => service.bind(input),
          review: (input) => service.review(input),
          act: (input) => service.act(input),
          finalize: (input) => service.finalize(input),
          preview: (input) => service.preview(input),
          kb: (input) => service.kb(input),
          requirements: (input) => service.requirements(input),
          cover: (input) => service.cover(input),
        };
        if (!handlers[operation]) throw new Error("操作不存在");
        return json(await handlers[operation](body));
      }),
    }),
    connection.fetch.register({
      path: "/api/seal/file",
      methods: ["GET"],
      requestBody: "buffered",
      fetch: safely(async (request) => {
        const file = await service.file(
          Object.fromEntries(new URL(request.url).searchParams),
        );
        return new Response(Buffer.from(file.bytes), {
          headers: {
            "Content-Type": file.type,
            "Cache-Control": "no-store",
            "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
          },
        });
      }),
    }),
    connection.fetch.register({
      path: "/api/seal/kb-file",
      methods: ["GET"],
      requestBody: "buffered",
      fetch: safely(async (request) => {
        const file = await service.kbFile(
          Object.fromEntries(new URL(request.url).searchParams),
        );
        return new Response(Buffer.from(file.bytes), {
          headers: {
            "Content-Type": file.type,
            "Cache-Control": "no-store",
            "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
          },
        });
      }),
    }),
  ];
}
