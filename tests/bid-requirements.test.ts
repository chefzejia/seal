import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NodeHostPort } from "../src/shells/node-host.js";
import { runProject } from "../src/shells/cli/project-v2.js";
import { checkDraft } from "../src/core/bid/check.js";
import { markCoverage } from "../src/core/bid/human-review.js";
import { sealLedger } from "../src/core/bid/ledger-integrity.js";
import {
  REQUIREMENTS_ITEM_MAX_CHARS,
  paginateRequirements,
  parseRequirements,
  requirementCoverageDigest,
  type Requirement,
} from "../src/core/bid/requirements.js";
import { packageDocument, paragraph } from "./fixtures/layout-matrix.js";

const run = promisify(execFile);

async function cli(...args: string[]): Promise<any> {
  const result = await run(process.execPath, [
    "--import",
    "tsx",
    "src/shells/cli/index.ts",
    ...args,
  ]);
  return JSON.parse(result.stdout);
}

async function createTenderDocx(): Promise<Uint8Array> {
  return packageDocument(
    [
      paragraph("第0段 封面"),
      paragraph("第1段 投标人须知"),
      paragraph("第2段 投标文件格式"),
      paragraph("第3段 响应人：____"),
      paragraph("第4段 前置背景"),
      paragraph("第5段 资格要求正文：须具备有效营业执照及安全生产许可证。"),
      paragraph("第6段 后置说明"),
      paragraph("第7段 一般说明"),
      paragraph("第8段 其他内容"),
      paragraph("第9段 第九块文本"),
      paragraph("第10段 第十块文本"),
      paragraph("第11段 第十一块超出窗口文本"),
      paragraph("第12段 报价：____"),
      paragraph("第13段 金额对照：壹元整，1元"),
    ].join(""),
  );
}

test("requirements save/list shared operation enforces schema, 5-block C14 window, atomicity and pagination", async (t) => {
  await fs.mkdir(".tmp", { recursive: true });
  const sandbox = await fs.mkdtemp(path.resolve(".tmp/bid-req-"));
  const previousSealHome = process.env.SEAL_HOME;
  process.env.SEAL_HOME = path.join(sandbox, "seal-home");
  t.after(async () => {
    if (previousSealHome === undefined) delete process.env.SEAL_HOME;
    else process.env.SEAL_HOME = previousSealHome;
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  const host = new NodeHostPort();
  const source = path.join(sandbox, "tender.docx");
  const root = path.join(sandbox, "project");
  const tenderBytes = await createTenderDocx();
  await fs.writeFile(source, tenderBytes);
  await runProject(host, [
    "init",
    "--root",
    root,
    "--name",
    "要求清单测试",
    "--deadline",
    "2028-12-31",
    "--tender",
    source,
  ]);

  // 1. Missing state is read-only and distinct from empty/error.
  const initial = (await cli(
    "requirements",
    "--project",
    root,
    "--action",
    "list",
  )) as any;
  assert.equal(initial.kind, "missing");
  await assert.rejects(fs.stat(path.join(root, "requirements.json")));

  // 2. Materials file cannot be cited as a requirement source.
  await fs.writeFile(path.join(root, "materials/extra.txt"), "须具备有效营业执照");
  await assert.rejects(
    runProject(host, [
      "requirements",
      "--project",
      root,
      "--action",
      "save",
      "--items",
      JSON.stringify([
        {
          id: "req-mat",
          kind: "资格要求",
          text: "营业执照",
          quote: "须具备有效营业执照",
          source: { file: "materials/extra.txt", address: "p:0" },
          mustRespond: true,
          responses: [],
        },
      ]),
    ]),
    /可信的登记招标副本/,
  );
  await assert.rejects(fs.stat(path.join(root, "requirements.json")));

  // 3. Batch atomicity: one valid item + one bad item (6th block outside window / forbidden field) writes nothing.
  const validItem: Requirement = {
    id: "req-qual-1",
    kind: "资格要求",
    text: "提供有效营业执照与安许证",
    quote: "须具备有效营业执照及安全生产许可证",
    source: { file: "tender/1.docx", address: "p:5" },
    mustRespond: true,
    responses: [],
  };
  await assert.rejects(
    runProject(host, [
      "requirements",
      "--project",
      root,
      "--action",
      "save",
      "--items",
      JSON.stringify([
        validItem,
        {
          id: "req-window-fail",
          kind: "实质性条款",
          text: "超出五块窗口",
          quote: "第十一块超出窗口文本",
          source: { file: "tender/1.docx", address: "p:5" },
          mustRespond: true,
          responses: [],
        },
        {
          id: "req-forbidden",
          kind: "格式要求",
          text: "禁止授权字段",
          quote: "投标文件格式",
          source: { file: "tender/1.docx", address: "p:2" },
          mustRespond: false,
          responses: [],
          covered: true,
        },
      ]),
    ]),
    (error: any) => {
      const payload = JSON.parse(error.message);
      assert.equal(payload.saved, false);
      assert.ok(
        payload.errors.some(
          (entry: any) =>
            entry.id === "req-window-fail" &&
            entry.field === "quote" &&
            entry.source?.address === "p:5" &&
            entry.action.includes("seal_doc_read"),
        ),
      );
      assert.ok(
        payload.errors.some(
          (entry: any) =>
            entry.id === "req-forbidden" && entry.field === "covered",
        ),
      );
      return true;
    },
  );
  await assert.rejects(fs.stat(path.join(root, "requirements.json")));

  // 4. Positive C14: exact block, +5 block, -5 block, fullwidth/whitespace equivalence; mustRespond=true with responses=[] allowed.
  const windowPositiveItems: Requirement[] = [
    validItem,
    {
      id: "req-plus-5",
      kind: "评分项",
      text: "正向五块窗口与全半角空白归一化",
      quote: "第 １０ 段 　 第十块文本",
      source: { file: "tender/1.docx", address: "p:5" },
      mustRespond: false,
      points: 5,
      responses: [],
      evidence: ["kb-01"],
    },
    {
      id: "req-minus-5",
      kind: "递交要求",
      text: "负向五块窗口",
      quote: "第0段封面",
      source: { file: "tender/1.docx", address: "p:5" },
      mustRespond: false,
      responses: [],
    },
  ];
  const ledgerBefore = await fs.readFile(path.join(root, "ledger.json"));
  const projectBefore = await fs.readFile(path.join(root, "seal-project.json"));
  const saved = (await cli(
    "requirements",
    "--project",
    root,
    "--action",
    "save",
    "--items",
    JSON.stringify(windowPositiveItems),
  )) as any;
  assert.equal(saved.saved, true);
  assert.equal(saved.format, "seal-requirements-1");
  assert.equal(saved.count, 3);
  assert.equal(saved.mustRespondCount, 1);
  assert.deepEqual(await fs.readFile(path.join(root, "ledger.json")), ledgerBefore);
  assert.deepEqual(
    await fs.readFile(path.join(root, "seal-project.json")),
    projectBefore,
  );
  const persisted = parseRequirements(
    await fs.readFile(path.join(root, "requirements.json"), "utf8"),
  );
  assert.equal(persisted.kind, "value");

  // 5. CLI/tool rejects unauthorized actions.
  await assert.rejects(
    cli(
      "requirements",
      "--project",
      root,
      "--action",
      "cover",
    ),
    /save、patch 或 list/,
  );

  // 6. Paginated list & oversized item without JSON truncation.
  const paged1 = (await cli(
    "requirements",
    "--project",
    root,
    "--action",
    "list",
    "--offset",
    "0",
    "--limit",
    "2",
  )) as any;
  assert.equal(paged1.kind, "value");
  assert.equal(paged1.total, 3);
  assert.equal(paged1.items.length, 2);
  assert.equal(paged1.nextOffset, 2);
  const paged2 = (await cli(
    "requirements",
    "--project",
    root,
    "--action",
    "list",
    "--offset",
    String(paged1.nextOffset),
    "--limit",
    "2",
  )) as any;
  assert.equal(paged2.items.length, 1);
  assert.equal(paged2.nextOffset, null);

  const manyItems: Requirement[] = Array.from({ length: 30 }, (_, index) => ({
    id: `bulk-${index}`,
    kind: "实质性条款",
    text: `${"长要求文本".repeat(500)}-${index}`,
    quote: "须具备有效营业执照及安全生产许可证",
    source: { file: "tender/1.docx", address: "p:5" },
    mustRespond: false,
    responses: [],
  }));
  await runProject(host, [
    "requirements",
    "--project",
    root,
    "--action",
    "save",
    "--items",
    JSON.stringify(manyItems),
  ]);
  const collected: string[] = [];
  for (let offset: number | null = 0; offset !== null; ) {
    const page = (await runProject(host, [
      "requirements",
      "--project",
      root,
      "--action",
      "list",
      "--offset",
      String(offset),
      "--limit",
      "50",
    ])) as any;
    assert.equal(page.kind, "value");
    assert.ok(JSON.stringify(page).length <= 45000);
    for (const item of page.items) collected.push(item.id);
    offset = page.nextOffset;
  }
  assert.equal(collected.length, 30);
  assert.equal(new Set(collected).size, 30);

  // 7. Corrupt requirements.json returns error (never empty) and blocks check.
  await fs.writeFile(path.join(root, "requirements.json"), "{broken");
  const corruptList = (await cli(
    "requirements",
    "--project",
    root,
    "--action",
    "list",
  )) as any;
  assert.equal(corruptList.kind, "error");
  const corruptCheck = (await cli("check", "--project", root)) as any;
  assert.ok(corruptCheck.counts.C12 > 0);
  assert.ok(corruptCheck.counts.C14 > 0);
  assert.equal(corruptCheck.ready, false);
});

test("valid CoverageMark clears only matching C12 gap and invalidates on requirement, response, vaultId or deadline changes", async (t) => {
  await fs.mkdir(".tmp", { recursive: true });
  const sandbox = await fs.mkdtemp(path.resolve(".tmp/bid-cov-"));
  const previousSealHome = process.env.SEAL_HOME;
  process.env.SEAL_HOME = path.join(sandbox, "seal-home");
  t.after(async () => {
    if (previousSealHome === undefined) delete process.env.SEAL_HOME;
    else process.env.SEAL_HOME = previousSealHome;
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  const host = new NodeHostPort();
  const source = path.join(sandbox, "tender.docx");
  const root = path.join(sandbox, "project");
  await fs.writeFile(source, await createTenderDocx());
  await runProject(host, [
    "init",
    "--root",
    root,
    "--name",
    "覆盖联动测试",
    "--deadline",
    "2028-12-31",
    "--tender",
    source,
  ]);
  await runProject(host, [
    "extract",
    "--project",
    root,
    "--tender",
    "tender/1.docx",
    "--draft",
    "商务",
    "--ranges",
    JSON.stringify([{ from: "p:5", to: "p:6" }]),
  ]);

  const reqA: Requirement = {
    id: "req-a",
    kind: "资格要求",
    text: "提供有效营业执照",
    quote: "须具备有效营业执照及安全生产许可证",
    source: { file: "tender/1.docx", address: "p:5" },
    mustRespond: true,
    responses: [],
  };
  const reqB: Requirement = {
    id: "req-b",
    kind: "实质性条款",
    text: "后置说明响应",
    quote: "后置说明",
    source: { file: "tender/1.docx", address: "p:6" },
    mustRespond: true,
    responses: [],
  };
  await runProject(host, [
    "requirements",
    "--project",
    root,
    "--action",
    "save",
    "--items",
    JSON.stringify([reqA, reqB]),
  ]);

  const checkAll = async () =>
    (await runProject(host, ["check", "--project", root])) as any;

  let report = await checkAll();
  assert.equal(report.blockingCounts.C12, 2);
  assert.equal(report.ready, false);

  // Sign CoverageMark ONLY for req-a at 商务:p:0.
  const key = (await host.authorizationKey(false))!;
  const anchorPath = await host.ledgerAnchorPath(root, false);
  const signMark = async (requirement: Requirement, responseText: string) => {
    const ledger = JSON.parse(
      await fs.readFile(path.join(root, "ledger.json"), "utf8"),
    );
    const project = JSON.parse(
      await fs.readFile(path.join(root, "seal-project.json"), "utf8"),
    );
    await markCoverage(
      ledger,
      {
        id: requirement.id,
        draft: "商务",
        address: "p:0",
        requirement: requirementCoverageDigest(requirement),
        response: responseText,
      },
      { root, vaultId: project.vaultId, deadline: project.deadline },
      key,
    );
    await sealLedger(ledger, root, key);
    await host.writeFiles([
      {
        path: path.join(root, "ledger.json"),
        data: new TextEncoder().encode(JSON.stringify(ledger, null, 2)),
      },
      {
        path: anchorPath,
        data: new TextEncoder().encode(JSON.stringify(ledger.integrity)),
      },
    ]);
  };

  await signMark(reqA, "第5段 资格要求正文：须具备有效营业执照及安全生产许可证。");
  report = await checkAll();
  assert.equal(report.blockingCounts.C12, 1, "req-a cleared while req-b remains");
  assert.equal(report.volumes[0].results.C12[0].id, "req-b");
  assert.equal(report.blockingCounts.C15, 0);

  // Cover req-b as well -> C12 becomes 0 and project is ready!
  await signMark(reqB, "第5段 资格要求正文：须具备有效营业执照及安全生产许可证。");
  report = await checkAll();
  assert.equal(report.blockingCounts.C12, 0);
  assert.equal(report.ready, true);

  // Valid coverage never suppresses C14 or C13!
  const badRequirements = path.join(root, "requirements.json");
  const prevReqFile = await fs.readFile(badRequirements);
  await fs.writeFile(
    badRequirements,
    JSON.stringify({
      format: "seal-requirements-1",
      items: [{ ...reqA, quote: "篡改的不存在引文" }, reqB],
    }),
  );
  report = await checkAll();
  assert.equal(report.blockingCounts.C14, 1, "coverage cannot hide C14 failure");
  assert.equal(report.blockingCounts.C12, 1, "req-a quote changed so coverage expired");
  await fs.writeFile(badRequirements, prevReqFile);

  // 1) Requirement text change via seal_requirements invalidates coverage for req-a without false C15 alarm.
  await runProject(host, [
    "requirements",
    "--project",
    root,
    "--action",
    "save",
    "--items",
    JSON.stringify([{ ...reqA, text: "修改后的要求概括" }, reqB]),
  ]);
  report = await checkAll();
  assert.equal(report.blockingCounts.C12, 1);
  assert.equal(report.volumes[0].results.C12[0].id, "req-a");
  assert.equal(report.blockingCounts.C15, 0);

  // Restore req-a and re-sign.
  await runProject(host, [
    "requirements",
    "--project",
    root,
    "--action",
    "save",
    "--items",
    JSON.stringify([reqA, reqB]),
  ]);
  await signMark(reqA, "第5段 资格要求正文：须具备有效营业执照及安全生产许可证。");
  assert.equal((await checkAll()).blockingCounts.C12, 0);

  // 2) Draft edit via seal_doc_edit changing response text invalidates coverage for both marks on p:0 without C15 alarm.
  await runProject(host, [
    "edit",
    "--project",
    root,
    "--draft",
    "商务",
    "--ops",
    JSON.stringify([
      {
        op: "replace",
        at: "p:0",
        find: "及安全生产许可证",
        value: "与施工资质",
      },
    ]),
  ]);
  report = await checkAll();
  assert.equal(report.blockingCounts.C12, 2);
  assert.equal(report.blockingCounts.C15, 0);

  // Re-sign against the edited response text, confirm C12 clears.
  await signMark(reqA, "第5段 资格要求正文：须具备有效营业执照与施工资质。");
  await signMark(reqB, "第5段 资格要求正文：须具备有效营业执照与施工资质。");
  assert.equal((await checkAll()).blockingCounts.C12, 0);

  // 3) Changing deadline invalidates coverage.
  const projectPath = path.join(root, "seal-project.json");
  const projectJson = JSON.parse(await fs.readFile(projectPath, "utf8"));
  await fs.writeFile(
    projectPath,
    JSON.stringify({ ...projectJson, deadline: "2029-01-15" }, null, 2),
  );
  report = await checkAll();
  assert.equal(report.blockingCounts.C12, 2);
  assert.ok(report.blockingCounts.C15 > 0);

  // Restore deadline and verify vaultId change invalidates too.
  await fs.writeFile(
    projectPath,
    JSON.stringify({ ...projectJson, vaultId: "another-vault" }, null, 2),
  );
  report = await checkAll();
  assert.equal(report.blockingCounts.C12, 2);
  assert.ok(report.blockingCounts.C15 > 0);
  await fs.writeFile(projectPath, JSON.stringify(projectJson, null, 2));

  // 4) Forged coverage signature triggers C15 and leaves C12 blocking.
  const tamperedLedger = JSON.parse(
    await fs.readFile(path.join(root, "ledger.json"), "utf8"),
  );
  tamperedLedger.requirements[0].authorization.signature = "0".repeat(64);
  await sealLedger(tamperedLedger, root, key);
  await host.writeFiles([
    {
      path: path.join(root, "ledger.json"),
      data: new TextEncoder().encode(JSON.stringify(tamperedLedger, null, 2)),
    },
    {
      path: anchorPath,
      data: new TextEncoder().encode(JSON.stringify(tamperedLedger.integrity)),
    },
  ]);
  report = await checkAll();
  assert.ok(report.blockingCounts.C12 >= 1);
  assert.ok(report.blockingCounts.C15 >= 1);

  // 5) Direct checkDraft also rejects forged coverage when anchor & ledger match.
  const direct = await checkDraft(host, {
    name: "商务",
    root,
    draft: await fs.readFile(path.join(root, "draft/商务.docx")),
    base: await fs.readFile(path.join(root, "draft/商务.base.docx")),
    ledger: tamperedLedger,
    anchor: tamperedLedger.integrity,
    project: projectJson,
    secret: key,
  });
  assert.ok(direct.results.C15.length > 0);
});

test("re-marking coverage across drafts replaces prior mark and orphan draft coverage triggers C15", async (t) => {
  await fs.mkdir(".tmp", { recursive: true });
  const sandbox = await fs.mkdtemp(path.resolve(".tmp/bid-cov-cross-"));
  const previousSealHome = process.env.SEAL_HOME;
  process.env.SEAL_HOME = path.join(sandbox, "seal-home");
  t.after(async () => {
    if (previousSealHome === undefined) delete process.env.SEAL_HOME;
    else process.env.SEAL_HOME = previousSealHome;
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  const host = new NodeHostPort();
  const source = path.join(sandbox, "tender.docx");
  const root = path.join(sandbox, "project");
  await fs.writeFile(source, await createTenderDocx());
  await runProject(host, [
    "init",
    "--root",
    root,
    "--name",
    "跨分册覆盖测试",
    "--deadline",
    "2028-12-31",
    "--tender",
    source,
  ]);
  const reqItem: Requirement = {
    id: "req-cross",
    kind: "资格要求",
    text: "提供有效营业执照",
    quote: "须具备有效营业执照及安全生产许可证",
    source: { file: "tender/1.docx", address: "p:5" },
    mustRespond: true,
    responses: [],
  };
  await runProject(host, [
    "requirements",
    "--project",
    root,
    "--action",
    "save",
    "--items",
    JSON.stringify([reqItem]),
  ]);

  const key = (await host.authorizationKey(false))!;
  const anchorPath = await host.ledgerAnchorPath(root, false);
  const signAt = async (draft: string, address: string, responseText: string) => {
    const ledger = JSON.parse(
      await fs.readFile(path.join(root, "ledger.json"), "utf8"),
    );
    const project = JSON.parse(
      await fs.readFile(path.join(root, "seal-project.json"), "utf8"),
    );
    await markCoverage(
      ledger,
      {
        id: reqItem.id,
        draft,
        address,
        requirement: requirementCoverageDigest(reqItem),
        response: responseText,
      },
      { root, vaultId: project.vaultId, deadline: project.deadline },
      key,
    );
    await sealLedger(ledger, root, key);
    await host.writeFiles([
      {
        path: path.join(root, "ledger.json"),
        data: new TextEncoder().encode(JSON.stringify(ledger, null, 2)),
      },
      {
        path: anchorPath,
        data: new TextEncoder().encode(JSON.stringify(ledger.integrity)),
      },
    ]);
  };

  // Orphan CoverageMark before any draft exists is caught by C15 and leaves ready=false.
  await signAt("不存在分册", "p:0", "孤立响应");
  let report = (await runProject(host, ["check", "--project", root])) as any;
  assert.ok(report.blockingCounts.C15 > 0);
  assert.equal(report.ready, false);

  // Extract two drafts A and B.
  await runProject(host, [
    "extract",
    "--project",
    root,
    "--tender",
    "tender/1.docx",
    "--draft",
    "A",
    "--ranges",
    JSON.stringify([{ from: "p:5", to: "p:5" }]),
  ]);
  await runProject(host, [
    "extract",
    "--project",
    root,
    "--tender",
    "tender/1.docx",
    "--draft",
    "B",
    "--ranges",
    JSON.stringify([{ from: "p:5", to: "p:5" }]),
  ]);

  // While orphan mark still points to non-existent draft, C15 reports it even with drafts A & B present.
  report = (await runProject(host, ["check", "--project", root])) as any;
  assert.equal(report.blockingCounts.C15, 1);
  assert.equal(report.ready, false);

  // Mark coverage on draft A -> replaces orphan mark; C12 and C15 both become 0.
  await signAt("A", "p:0", "第5段 资格要求正文：须具备有效营业执照及安全生产许可证。");
  report = (await runProject(host, ["check", "--project", root])) as any;
  assert.equal(report.blockingCounts.C12, 0);
  assert.equal(report.blockingCounts.C15, 0);
  assert.equal(report.ready, true);

  // Change deadline -> C12 and C15 both trigger.
  const projectPath = path.join(root, "seal-project.json");
  const projectJson = JSON.parse(await fs.readFile(projectPath, "utf8"));
  await fs.writeFile(
    projectPath,
    JSON.stringify({ ...projectJson, deadline: "2029-02-01" }, null, 2),
  );
  report = (await runProject(host, ["check", "--project", root])) as any;
  assert.equal(report.blockingCounts.C12, 1);
  assert.equal(report.blockingCounts.C15, 1);
  assert.equal(report.ready, false);

  // Re-mark coverage on draft B -> replaces draft A mark cleanly; C12 and C15 both clear!
  await signAt("B", "p:0", "第5段 资格要求正文：须具备有效营业执照及安全生产许可证。");
  const savedLedger = JSON.parse(
    await fs.readFile(path.join(root, "ledger.json"), "utf8"),
  );
  assert.equal(savedLedger.requirements.length, 1);
  assert.equal(savedLedger.requirements[0].draft, "B");
  report = (await runProject(host, ["check", "--project", root])) as any;
  assert.equal(report.blockingCounts.C12, 0);
  assert.equal(report.blockingCounts.C15, 0);
  assert.equal(report.ready, true);
});

test("single requirement exceeding REQUIREMENTS_ITEM_MAX_CHARS or page maxChars is rejected by save, parseRequirements and paginateRequirements", async (t) => {
  await fs.mkdir(".tmp", { recursive: true });
  const sandbox = await fs.mkdtemp(path.resolve(".tmp/bid-req-limit-"));
  const previousSealHome = process.env.SEAL_HOME;
  process.env.SEAL_HOME = path.join(sandbox, "seal-home");
  t.after(async () => {
    if (previousSealHome === undefined) delete process.env.SEAL_HOME;
    else process.env.SEAL_HOME = previousSealHome;
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  const host = new NodeHostPort();
  const source = path.join(sandbox, "tender.docx");
  const root = path.join(sandbox, "project");
  await fs.writeFile(source, await createTenderDocx());
  await runProject(host, [
    "init",
    "--root",
    root,
    "--name",
    "单条上限测试",
    "--deadline",
    "2028-12-31",
    "--tender",
    source,
  ]);

  const oversized: Requirement = {
    id: "req-oversized",
    kind: "实质性条款",
    text: "超".repeat(REQUIREMENTS_ITEM_MAX_CHARS + 100),
    quote: "须具备有效营业执照及安全生产许可证",
    source: { file: "tender/1.docx", address: "p:5" },
    mustRespond: true,
    responses: [],
  };

  await assert.rejects(
    runProject(host, [
      "requirements",
      "--project",
      root,
      "--action",
      "save",
      "--items",
      JSON.stringify([oversized]),
    ]),
    (error: any) => {
      const payload = JSON.parse(error.message);
      assert.equal(payload.saved, false);
      assert.ok(
        payload.errors.some(
          (entry: any) =>
            entry.id === "req-oversized" &&
            entry.field === "item" &&
            entry.reason.includes(String(REQUIREMENTS_ITEM_MAX_CHARS)),
        ),
      );
      return true;
    },
  );
  await assert.rejects(fs.stat(path.join(root, "requirements.json")));

  const parsed = parseRequirements(
    JSON.stringify({ format: "seal-requirements-1", items: [oversized] }),
  );
  assert.equal(parsed.kind, "error");
  if (parsed.kind === "error") {
    assert.ok(parsed.reason.includes(String(REQUIREMENTS_ITEM_MAX_CHARS)));
  }

  const normalItem: Requirement = {
    id: "req-normal",
    kind: "格式要求",
    text: "按格式要求编制投标文件并逐页核对正文内容。",
    quote: "投标文件格式",
    source: { file: "tender/1.docx", address: "p:2" },
    mustRespond: false,
    responses: [],
  };
  assert.throws(
    () => paginateRequirements([normalItem], 0, 50, 120),
    /超过分页输出上限/,
  );
});
