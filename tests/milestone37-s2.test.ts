import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NodeHostPort } from "../src/shells/node-host.js";
import { KnowledgeBase } from "../src/core/kb/index.js";
import { WorkbenchHost } from "../src/shells/dsh/workbench-host.js";
import { zh, en } from "../src/shells/dsh/client-locale.js";
import {
  buildKbClassifyPrompt,
  formatCandidateLocation,
  formatHealthIssueMessage,
  importToggleState,
  kbFieldLabel,
  shouldShowReferenceDateHint,
  unverifiedBadgeTone,
} from "../src/workbench/knowledge.js";
import {
  buildBidStartupPrompt,
  formatProjectSubtitle,
} from "../src/workbench/requirements.js";
import { packageDocument, paragraph } from "./fixtures/layout-matrix.js";

test("m37-s2 item 1 & 5: startup and classify prompts include readable vaultName and skipped files", () => {
  const classifyWithSkipped = buildKbClassifyPrompt({
    vaultId: "kb-12345678-aaaa-bbbb-cccc-1234567890ab",
    vaultName: "星河智联摸底测试库",
    batchId: "batch-9999",
    vaultRoot: "/tmp/seal/vaults/kb-12345678",
    skipped: [
      { source: "无关压缩包.zip", reason: "不支持的文件类型（.zip）" },
      { source: "备份.rar", reason: "不支持的文件类型（.rar）" },
    ],
  });
  assert.match(classifyWithSkipped, /seal-kb/);
  assert.match(classifyWithSkipped, /星河智联摸底测试库（ID: kb-12345678-aaaa-bbbb-cccc-1234567890ab）/);
  assert.match(classifyWithSkipped, /batch-9999/);
  assert.match(classifyWithSkipped, /无关压缩包\.zip（不支持的文件类型（\.zip））/);
  assert.match(classifyWithSkipped, /备份\.rar（不支持的文件类型（\.rar））/);
  assert.match(classifyWithSkipped, /告知用户/);

  const classifyWithoutSkipped = buildKbClassifyPrompt({
    vaultId: "kb-12345678",
    vaultName: "星河智联摸底测试库",
    batchId: "batch-1000",
    vaultRoot: "/tmp/seal/vaults/kb-12345678",
    skipped: [],
  });
  assert.doesNotMatch(classifyWithoutSkipped, /已跳过/);

  const bidWithVaultName = buildBidStartupPrompt({
    name: "电梯采购项目",
    deadline: "2026-12-31",
    vaultId: "kb-12345678",
    vaultName: "星河智联摸底测试库",
    tenders: [{ copy: "tender/1.docx" }],
  });
  assert.match(bidWithVaultName, /关联企业知识库：星河智联摸底测试库（ID: kb-12345678/);
});

function syntheticCreditCode(prefix17 = "91110000000000000"): string {
  const alphabet = "0123456789ABCDEFGHJKLMNPQRTUWXY";
  const weights = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    sum += alphabet.indexOf(prefix17[i]) * weights[i];
  }
  return prefix17 + alphabet[(31 - (sum % 31)) % 31];
}

test("m37-s2 item 2: KB health issues and workbench formatters localize subject & record field keys", async (t) => {
  const home = path.resolve(".tmp", `m37-s2-health-${randomUUID()}`);
  const previous = process.env.SEAL_HOME;
  process.env.SEAL_HOME = home;
  await fs.mkdir(home, { recursive: true });
  t.after(async () => {
    if (previous === undefined) delete process.env.SEAL_HOME;
    else process.env.SEAL_HOME = previous;
    await fs.rm(home, { recursive: true, force: true });
  });

  const host = new NodeHostPort();
  const kb = new KnowledgeBase(host, path.join(home, "vaults"));
  const vault = await kb.createVault({ vaultId: "s2-health", name: "中文提示测试库" });

  await kb.save(vault.vaultId, {
    action: "update",
    kind: "subject",
    fields: {
      legalName: "测试企业有限公司",
      creditCode: syntheticCreditCode(),
      legalRepresentative: "张三",
      registeredCapital: "1000万元",
      establishedOn: "2020-01-15",
      address: "北京市海淀区",
      phone: "010-12345678",
      email: "test@example.com",
      bankName: "示例银行",
      bankAccount: "6222000011112222",
      forbiddenAffiliates: ["关联甲公司"],
      thirdPartyHolders: ["合作乙公司"],
    },
  });
  await kb.save(vault.vaultId, {
    action: "create",
    kind: "record",
    fields: {
      type: "营业执照",
      title: "缺字段执照",
    },
    body: "",
  });

  const report = await kb.health(vault.vaultId, "2026-11-24");
  const subjectIssues = report.issues.filter((item) => item.code === "subject_unverified");
  assert.equal(subjectIssues.length, 12);

  const expectedZhLabels: Record<string, string> = {
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
  };

  for (const [key, label] of Object.entries(expectedZhLabels)) {
    const issue = subjectIssues.find((item) => item.field === key);
    assert.ok(issue, `missing subject_unverified issue for ${key}`);
    assert.ok(issue.message.includes(label), `expected "${issue.message}" to include "${label}"`);
    assert.ok(!issue.message.includes(key), `issue message should not expose raw key "${key}": ${issue.message}`);
    assert.equal(kbFieldLabel(key, "zh"), label);
    assert.ok(kbFieldLabel(key, "en").length > 0);
  }

  const missingIssues = report.issues.filter((item) => item.code === "field_missing");
  assert.ok(missingIssues.some((item) => item.field === "holder" && item.message.includes("持证方")));
  assert.ok(missingIssues.some((item) => item.field === "number" && item.message.includes("编号")));
  assert.ok(missingIssues.some((item) => item.field === "validUntil" && item.message.includes("有效期至")));

  assert.equal(
    formatHealthIssueMessage(
      { code: "subject_unverified", field: "creditCode", message: "主体字段「creditCode」尚未核实" },
      "zh",
    ),
    "主体字段「统一社会信用代码」尚未核实",
  );
  assert.equal(
    formatHealthIssueMessage(
      { code: "subject_unverified", field: "legalRepresentative", message: "主体字段「legalRepresentative」尚未核实" },
      "en",
    ),
    'Entity field "Legal representative" is not verified',
  );
  assert.equal(kbFieldLabel("customUnknownField", "zh"), "customUnknownField");
});

test("m37-s2 item 4 & 6: import toggle state, empty badge tone, slice location dedupe, reference hint visibility, and locale parity", () => {
  assert.deepEqual(importToggleState(true), { labelKey: "hideImport", variant: "secondary" });
  assert.deepEqual(importToggleState(false), { labelKey: "importMaterials", variant: "primary" });

  assert.equal(unverifiedBadgeTone({ recordCount: 0, subjectVerified: false, unverified: 0 }), "neutral");
  assert.equal(unverifiedBadgeTone({ recordCount: 0, subjectVerified: true, unverified: 0 }), "ok");
  assert.equal(unverifiedBadgeTone({ recordCount: 1, subjectVerified: false, unverified: 0 }), "ok");
  assert.equal(unverifiedBadgeTone({ recordCount: 2, subjectVerified: false, unverified: 2 }), "warn");

  assert.equal(formatCandidateLocation("营业执照副本.jpg", "营业执照副本.jpg"), "营业执照副本.jpg");
  assert.equal(formatCandidateLocation("营业执照副本.jpg", "图片：营业执照副本.jpg"), "图片：营业执照副本.jpg");
  assert.equal(formatCandidateLocation("license.pdf", "第 1 页 / 共 2 页"), "license.pdf · 第 1 页 / 共 2 页");
  assert.equal(formatCandidateLocation("", "Sheet1"), "Sheet1");
  assert.equal(formatCandidateLocation("readme.txt", ""), "readme.txt");

  assert.equal(shouldShowReferenceDateHint("evidence"), true);
  assert.equal(shouldShowReferenceDateHint("materials"), false);
  assert.equal(shouldShowReferenceDateHint("subject"), false);

  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  for (const key of Object.keys(zh) as Array<keyof typeof zh>) {
    assert.ok(zh[key].trim().length > 0, `zh.${key} is empty`);
    assert.ok(en[key].trim().length > 0, `en.${key} is empty`);
  }
  assert.equal(zh.closeDetail, "收起详情");
  assert.equal(zh.hideImport, "收起导入");
  assert.equal(en.hideImport, "Hide Import");
  assert.equal(zh.importMaterials, "+ 导入材料");
  assert.equal(en.importMaterials, "+ Import");
  assert.equal(zh.noVaultMode, "无知识库模式");
  assert.notEqual(zh.noVaultOption, zh.noVault);
  assert.notEqual(en.noVaultOption, en.noVault);
  assert.equal(zh.chooseFiles, "选择文件");
});

test("m37-s2 item 5: WorkbenchHost projects vaultName on create, overview, and review with graceful missing-vault fallback", async (t) => {
  const home = path.resolve(".tmp", `m37-s2-vaultname-${randomUUID()}`);
  const previous = process.env.SEAL_HOME;
  process.env.SEAL_HOME = home;
  await fs.mkdir(home, { recursive: true });
  t.after(async () => {
    if (previous === undefined) delete process.env.SEAL_HOME;
    else process.env.SEAL_HOME = previous;
    await fs.rm(home, { recursive: true, force: true });
  });

  const host = new NodeHostPort();
  const service = new WorkbenchHost(host);
  const source = path.join(home, "tender.docx");
  await fs.writeFile(source, await packageDocument(paragraph("招标测试文档")));

  const vault = (await service.kb({
    action: "create",
    name: "星河智联摸底测试库",
  })) as { vaultId: string; name: string };

  const withVault = (await service.create({
    name: "关联库项目",
    deadline: "2026-12-31",
    vaultId: vault.vaultId,
    files: [source],
  })) as { id: string; vaultName: string | null };
  assert.equal(withVault.vaultName, "星河智联摸底测试库");

  const withoutVault = (await service.create({
    name: "无库项目",
    deadline: "2026-12-31",
    files: [source],
  })) as { id: string; vaultName: string | null };
  assert.equal(withoutVault.vaultName, null);

  const reviewWithVault = (await service.review({ projectId: withVault.id })) as any;
  assert.equal(reviewWithVault.vaultName, "星河智联摸底测试库");
  assert.equal(
    formatProjectSubtitle({
      deadline: reviewWithVault.project.deadline,
      vaultId: reviewWithVault.project.vaultId,
      vaultName: reviewWithVault.vaultName,
    }),
    "2026-12-31 · 星河智联摸底测试库",
  );

  const reviewWithoutVault = (await service.review({ projectId: withoutVault.id })) as any;
  assert.equal(reviewWithoutVault.vaultName, null);
  assert.equal(
    formatProjectSubtitle({
      deadline: reviewWithoutVault.project.deadline,
      vaultId: reviewWithoutVault.project.vaultId,
      vaultName: reviewWithoutVault.vaultName,
      noVaultLabel: zh.noVaultMode,
    }),
    "2026-12-31 · 无知识库模式",
  );

  const overview = await service.overview();
  const projectWithVault = overview.projects.find((p) => p.id === withVault.id) as any;
  assert.equal(projectWithVault.vaultName, "星河智联摸底测试库");

  // Delete the linked vault and verify graceful fallback (no throw, vaultName=null).
  await fs.rm(path.join(home, "vaults", vault.vaultId), { recursive: true, force: true });
  const reviewAfterVaultDeleted = (await service.review({ projectId: withVault.id })) as any;
  assert.equal(reviewAfterVaultDeleted.kind, "project");
  assert.equal(reviewAfterVaultDeleted.vaultName, null);
  assert.equal(
    formatProjectSubtitle({
      deadline: reviewAfterVaultDeleted.project.deadline,
      vaultId: reviewAfterVaultDeleted.project.vaultId,
      vaultName: reviewAfterVaultDeleted.vaultName,
      missingVaultLabel: zh.missingVault,
    }),
    `2026-12-31 · ${zh.missingVault}`,
  );
});
