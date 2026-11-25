import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { HostPort } from "../src/core/host.js";
import { KnowledgeBase, serializeEntry } from "../src/core/kb/index.js";
import { NodeHostPort } from "../src/shells/node-host.js";
import {
  WorkbenchHost,
  registerWorkbenchRoutes,
} from "../src/shells/dsh/workbench-host.js";
import { runProject } from "../src/shells/cli/project-v2.js";
import { runKnowledgeBase } from "../src/shells/cli/kb.js";
import { zh, en } from "../src/shells/dsh/client-locale.js";
import {
  createInlineDeleteController,
  formatDeleteBatchNotice,
  nextSelectedVaultId,
  type InlineDeleteState,
} from "../src/workbench/knowledge.js";
import { packageDocument, paragraph } from "./fixtures/layout-matrix.js";

const VALID_PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function createSandbox(t: TestContext, prefix: string) {
  await fs.mkdir(path.resolve(".tmp"), { recursive: true });
  const sandbox = await fs.mkdtemp(path.resolve(".tmp", prefix));
  const home = path.join(sandbox, "seal-home");
  const prevHome = process.env.SEAL_HOME;
  const prevVaults = process.env.SEAL_VAULTS_ROOT;
  process.env.SEAL_HOME = home;
  delete process.env.SEAL_VAULTS_ROOT;
  await fs.mkdir(home, { recursive: true });
  t.after(async () => {
    if (prevHome === undefined) delete process.env.SEAL_HOME;
    else process.env.SEAL_HOME = prevHome;
    if (prevVaults === undefined) delete process.env.SEAL_VAULTS_ROOT;
    else process.env.SEAL_VAULTS_ROOT = prevVaults;
    await fs.rm(sandbox, { recursive: true, force: true });
  });
  return { sandbox, home };
}

function makeActionRouter(service: WorkbenchHost) {
  const routes: Array<{
    path: string;
    methods: string[];
    fetch(request: Request): Promise<Response>;
  }> = [];
  registerWorkbenchRoutes(
    {
      fetch: {
        register(route) {
          routes.push(route);
          return async () => {};
        },
      },
    },
    service,
  );
  const actionRoute = routes.find((r) => r.path === "/api/seal/action")!;
  assert.ok(actionRoute, "/api/seal/action route must be registered");
  return async (payload: Record<string, unknown>) => {
    const res = await actionRoute.fetch(
      new Request("http://127.0.0.1/api/seal/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
    );
    return { status: res.status, body: (await res.json()) as any };
  };
}

test("deleteBatch: cleans unreferenced batch completely, preserves referenced frontmatter/URL-encoded markdown files, and fails closed on malformed entries", async (t) => {
  const { sandbox, home } = await createSandbox(t, "m40-batch-");
  const host = new NodeHostPort();
  const vaultsRoot = path.join(home, "vaults");
  const kb = new KnowledgeBase(host, vaultsRoot);
  const service = new WorkbenchHost(host);
  const postAction = makeActionRouter(service);

  const vault = await kb.createVault({ vaultId: "v-batch", name: "批次测试库" });
  const originalImage = path.join(sandbox, "原件扫描图.png");
  await fs.writeFile(originalImage, VALID_PNG_BYTES);

  // Batch 1: completely unreferenced -> inbox and files/<batchId> both deleted
  const report1 = await kb.ingestMaterials(
    vault.vaultId,
    [
      {
        kind: "image",
        sourcePath: originalImage,
        originalPath: originalImage,
        mime: "image/png",
      },
    ],
    path.join(sandbox, "stage-1"),
  );
  assert.equal(report1.candidates.length, 1);

  const res1 = await postAction({
    operation: "kb",
    action: "delete_batch",
    vaultId: vault.vaultId,
    batchId: report1.batchId,
  });
  assert.equal(res1.status, 200);
  assert.deepEqual(res1.body, {
    batchId: report1.batchId,
    removedCandidates: 1,
    removedFiles: 1,
    preservedFiles: 0,
  });
  await assert.rejects(
    fs.stat(path.join(vaultsRoot, vault.vaultId, "inbox", report1.batchId)),
  );
  await assert.rejects(
    fs.stat(path.join(vaultsRoot, vault.vaultId, "files", report1.batchId)),
  );
  assert.deepEqual(await fs.readFile(originalImage), VALID_PNG_BYTES);

  // Batch 2: 3 files; 1 referenced via frontmatter `files`, 1 via URL-encoded markdown link, 1 unreferenced
  const imgA = path.join(sandbox, "a-营业执照.png");
  const imgB = path.join(sandbox, "b-资质图.png");
  const imgC = path.join(sandbox, "c-多余图.png");
  await fs.writeFile(imgA, VALID_PNG_BYTES);
  await fs.writeFile(imgB, VALID_PNG_BYTES);
  await fs.writeFile(imgC, VALID_PNG_BYTES);

  const report2 = await kb.ingestMaterials(
    vault.vaultId,
    [
      { kind: "image", sourcePath: imgA, originalPath: imgA, mime: "image/png" },
      { kind: "image", sourcePath: imgB, originalPath: imgB, mime: "image/png" },
      { kind: "image", sourcePath: imgC, originalPath: imgC, mime: "image/png" },
    ],
    path.join(sandbox, "stage-2"),
  );
  const fileA = report2.candidates[0].imageFiles[0];
  const fileB = report2.candidates[1].imageFiles[0];
  const fileC = report2.candidates[2].imageFiles[0];
  assert.ok(fileA && fileB && fileC);

  await kb.save(vault.vaultId, {
    action: "create",
    kind: "record",
    fields: {
      type: "营业执照",
      title: "已建档营业执照",
      files: [fileA],
    },
    body: "来自 frontmatter 引用",
  });
  const encodedFileB = fileB
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  await kb.save(vault.vaultId, {
    action: "create",
    kind: "material",
    fields: {
      title: "引用URL编码图片素材",
    },
    body: `说明正文：\n\n![资质图](../../${encodedFileB})`,
  });

  const res2 = await postAction({
    operation: "kb",
    action: "delete_batch",
    vaultId: vault.vaultId,
    batchId: report2.batchId,
  });
  assert.equal(res2.status, 200);
  assert.deepEqual(res2.body, {
    batchId: report2.batchId,
    removedCandidates: 3,
    removedFiles: 1,
    preservedFiles: 2,
  });
  // inbox removed, fileA & fileB preserved, fileC deleted
  await assert.rejects(
    fs.stat(path.join(vaultsRoot, vault.vaultId, "inbox", report2.batchId)),
  );
  await fs.stat(path.join(vaultsRoot, vault.vaultId, fileA));
  await fs.stat(path.join(vaultsRoot, vault.vaultId, fileB));
  await assert.rejects(
    fs.stat(path.join(vaultsRoot, vault.vaultId, fileC)),
  );

  // Batch 3: malformed entry present -> fail-closed preserve all files in files/<batchId>
  const report3 = await kb.ingestMaterials(
    vault.vaultId,
    [{ kind: "image", sourcePath: imgC, originalPath: imgC, mime: "image/png" }],
    path.join(sandbox, "stage-3"),
  );
  const file3 = report3.candidates[0].imageFiles[0];
  await fs.writeFile(
    path.join(vaultsRoot, vault.vaultId, "records", "broken-entry.md"),
    "NOT VALID FRONTMATTER",
    "utf8",
  );
  const res3 = await postAction({
    operation: "kb",
    action: "delete_batch",
    vaultId: vault.vaultId,
    batchId: report3.batchId,
  });
  assert.equal(res3.status, 200);
  assert.deepEqual(res3.body, {
    batchId: report3.batchId,
    removedCandidates: 1,
    removedFiles: 0,
    preservedFiles: 1,
  });
  await fs.stat(path.join(vaultsRoot, vault.vaultId, file3));

  // Negative controls: invalid batchId & missing batch
  await assert.rejects(kb.deleteBatch(vault.vaultId, "../escape"), /无效/);
  await assert.rejects(kb.deleteBatch(vault.vaultId, "batch-nonexistent"), /不存在/);

  // Verify actor: 'human' & action: 'delete_batch' in log.jsonl
  const logLines = (
    await fs.readFile(path.join(vaultsRoot, vault.vaultId, "log.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const deleteLogs = logLines.filter((l) => l.action === "delete_batch");
  assert.equal(deleteLogs.length, 3);
  assert.ok(deleteLogs.every((l) => l.actor === "human"));
  assert.equal(deleteLogs[0].object, `batch:${report1.batchId}`);
});

test("deleteEntry: enforces revision 409, rejects subject, records actor='human', preserves shared files, and rolls back on log failure", async (t) => {
  const { sandbox, home } = await createSandbox(t, "m40-entry-");
  const host = new NodeHostPort();
  const vaultsRoot = path.join(home, "vaults");
  const kb = new KnowledgeBase(host, vaultsRoot);
  const service = new WorkbenchHost(host);
  const postAction = makeActionRouter(service);

  const vault = await kb.createVault({ vaultId: "v-entry", name: "条目测试库" });
  const img = path.join(sandbox, "shared.png");
  await fs.writeFile(img, VALID_PNG_BYTES);
  const ingested = await kb.ingestMaterials(
    vault.vaultId,
    [{ kind: "image", sourcePath: img, originalPath: img, mime: "image/png" }],
    path.join(sandbox, "stage"),
  );
  const sharedRel = ingested.candidates[0].imageFiles[0];

  const rec = await kb.save(vault.vaultId, {
    action: "create",
    kind: "record",
    fields: { type: "资质证书", title: "测试资质", files: [sharedRel] },
    body: "资质正文",
  });
  const mat = await kb.save(vault.vaultId, {
    action: "create",
    kind: "material",
    fields: { title: "测试素材", files: [sharedRel] },
    body: "素材正文",
  });

  // Cannot delete subject
  const subjectAttempt = await postAction({
    operation: "kb",
    action: "delete_entry",
    vaultId: vault.vaultId,
    kind: "subject",
    id: "subject",
    revision: "any",
  });
  assert.equal(subjectAttempt.status, 400);
  await assert.rejects(
    kb.deleteEntry(vault.vaultId, "subject" as unknown as "record", "subject"),
    /证据记录或写作素材/,
  );

  // Stale revision -> HTTP 409, record untouched
  const detail = await postAction({
    operation: "kb",
    action: "detail",
    vaultId: vault.vaultId,
    kind: "record",
    id: rec.id,
  });
  assert.equal(detail.status, 200);
  const staleRes = await postAction({
    operation: "kb",
    action: "delete_entry",
    vaultId: vault.vaultId,
    kind: "record",
    id: rec.id,
    revision: "stale-revision-hash",
  });
  assert.equal(staleRes.status, 409);
  assert.match(staleRes.body.error, /版本冲突/);
  assert.equal((await kb.get(vault.vaultId, "record", rec.id)).id, rec.id);

  // Valid delete record -> 200, actor: human, shared file preserved
  const okRec = await postAction({
    operation: "kb",
    action: "delete_entry",
    vaultId: vault.vaultId,
    kind: "record",
    id: rec.id,
    revision: detail.body.revision,
  });
  assert.equal(okRec.status, 200);
  await assert.rejects(kb.get(vault.vaultId, "record", rec.id));
  await fs.stat(path.join(vaultsRoot, vault.vaultId, sharedRel));

  // Valid delete material -> 200, actor: human
  const matDetail = await postAction({
    operation: "kb",
    action: "detail",
    vaultId: vault.vaultId,
    kind: "material",
    id: mat.id,
  });
  const okMat = await postAction({
    operation: "kb",
    action: "delete_entry",
    vaultId: vault.vaultId,
    kind: "material",
    id: mat.id,
    revision: matDetail.body.revision,
  });
  assert.equal(okMat.status, 200);
  await assert.rejects(kb.get(vault.vaultId, "material", mat.id));

  // save({ action: 'delete' }) still logs actor: 'agent'
  const agentRec = await kb.save(vault.vaultId, {
    action: "create",
    kind: "record",
    fields: { title: "Agent删除记录" },
  });
  await kb.save(vault.vaultId, {
    action: "delete",
    kind: "record",
    id: agentRec.id,
  });

  const logs = (
    await fs.readFile(path.join(vaultsRoot, vault.vaultId, "log.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(
    logs.find((l) => l.object === `record:${rec.id}` && l.action === "delete")?.actor,
    "human",
  );
  assert.equal(
    logs.find((l) => l.object === `material:${mat.id}` && l.action === "delete")?.actor,
    "human",
  );
  assert.equal(
    logs.find((l) => l.object === `record:${agentRec.id}` && l.action === "delete")?.actor,
    "agent",
  );

  // Rollback when appendLog fails
  const rollbackRec = await kb.save(vault.vaultId, {
    action: "create",
    kind: "record",
    fields: { title: "回滚记录" },
  });
  const failingHost: HostPort = {
    readBytes: (p) => host.readBytes(p),
    writeBytes: (p, d) => host.writeBytes(p, d),
    readText: (p) => host.readText(p),
    writeText: (p, c) => host.writeText(p, c),
    stat: (p) => host.stat(p),
    removeFile: (p) => host.removeFile!(p),
    joinPath: (...s) => host.joinPath(...s),
    dirname: (p) => host.dirname(p),
    writeFiles: async () => {
      throw new Error("模拟日志写入失败");
    },
  };
  const failingKb = new KnowledgeBase(failingHost, vaultsRoot);
  await assert.rejects(
    failingKb.deleteEntry(vault.vaultId, "record", rollbackRec.id, "human"),
    /模拟日志写入失败/,
  );
  // File must have been restored
  const restored = await kb.get(vault.vaultId, "record", rollbackRec.id);
  assert.equal(restored.fields.title, "回滚记录");
});

test("deleteVault & deleteProject: reference checks, broken-project fail-closed, symlink rejection, anchor cleanup, and original preservation", async (t) => {
  const { sandbox, home } = await createSandbox(t, "m40-vault-proj-");
  const host = new NodeHostPort();
  const vaultsRoot = path.join(home, "vaults");
  const kb = new KnowledgeBase(host, vaultsRoot);
  const service = new WorkbenchHost(host);
  const postAction = makeActionRouter(service);

  const tenderBytes = await packageDocument(paragraph("招标测试正文"));
  const tenderPath = path.join(sandbox, "原招标文件.docx");
  await fs.writeFile(tenderPath, tenderBytes);

  const vReferenced = await kb.createVault({ vaultId: "v-ref", name: "引用中的库" });
  const vFree = await kb.createVault({ vaultId: "v-free", name: "待删除空库" });

  // Hidden .DS_Store inside projects/ must be ignored when checking vault references
  await fs.mkdir(path.join(home, "projects"), { recursive: true });
  await fs.writeFile(path.join(home, "projects", ".DS_Store"), "junk", "utf8");

  const created = await service.create({
    name: "市政改造投标",
    deadline: "2028-12-31",
    vaultId: vReferenced.vaultId,
    files: [tenderPath],
  });
  const anchorPath = path.join(
    home,
    "ledgers",
    `${createHash("sha256").update(path.resolve(created.root)).digest("hex")}.json`,
  );
  await fs.stat(anchorPath);

  // 1. delete_vault blocked when referenced by active project (lists project name)
  const blockedRes = await postAction({
    operation: "kb",
    action: "delete_vault",
    vaultId: vReferenced.vaultId,
  });
  assert.equal(blockedRes.status, 400);
  assert.match(blockedRes.body.error, /市政改造投标/);
  await fs.stat(path.join(vaultsRoot, vReferenced.vaultId));

  // 2. delete_vault fail-closed when ANY broken project exists in projects/
  const brokenProjectDir = path.join(home, "projects", "project-broken-1");
  await fs.mkdir(brokenProjectDir, { recursive: true });
  await fs.writeFile(path.join(brokenProjectDir, "seal-project.json"), "{bad-json", "utf8");

  const brokenBlockedRes = await postAction({
    operation: "kb",
    action: "delete_vault",
    vaultId: vFree.vaultId,
  });
  assert.equal(brokenBlockedRes.status, 400);
  assert.match(brokenBlockedRes.body.error, /project-broken-1/);
  assert.match(brokenBlockedRes.body.error, /进行中的投标/);
  await fs.stat(path.join(vaultsRoot, vFree.vaultId));

  // 3. delete_project works on broken projects too!
  const delBrokenProj = await postAction({
    operation: "delete_project",
    projectId: "project-broken-1",
  });
  assert.equal(delBrokenProj.status, 200);
  assert.deepEqual(delBrokenProj.body, {
    deleted: true,
    projectId: "project-broken-1",
  });
  await assert.rejects(fs.stat(brokenProjectDir));

  // 4. Now vFree can be deleted cleanly while vReferenced is still blocked
  const delFree = await postAction({
    operation: "kb",
    action: "delete_vault",
    vaultId: vFree.vaultId,
  });
  assert.equal(delFree.status, 200);
  assert.deepEqual(delFree.body, { deleted: true, vaultId: vFree.vaultId });
  await assert.rejects(fs.stat(path.join(vaultsRoot, vFree.vaultId)));

  const stillBlocked = await postAction({
    operation: "kb",
    action: "delete_vault",
    vaultId: vReferenced.vaultId,
  });
  assert.equal(stillBlocked.status, 400);
  assert.match(stillBlocked.body.error, /市政改造投标/);

  // 5. delete_project deletes normal project + external ledger anchor, leaves original tender & KB untouched
  const delProj = await postAction({
    operation: "delete_project",
    projectId: created.id,
  });
  assert.equal(delProj.status, 200);
  assert.deepEqual(delProj.body, { deleted: true, projectId: created.id });
  await assert.rejects(fs.stat(created.root));
  await assert.rejects(fs.stat(anchorPath));
  assert.deepEqual(await fs.readFile(tenderPath), Buffer.from(tenderBytes));
  assert.equal((await kb.metadata(vReferenced.vaultId)).name, "引用中的库");

  // 6. Now vReferenced has no referencing projects and can be deleted cleanly
  const delRef = await postAction({
    operation: "kb",
    action: "delete_vault",
    vaultId: vReferenced.vaultId,
  });
  assert.equal(delRef.status, 200);
  await assert.rejects(fs.stat(path.join(vaultsRoot, vReferenced.vaultId)));

  // 7. Symlink & traversal rejection for delete_vault and delete_project
  const outsideDir = path.join(sandbox, "outside-target");
  await fs.mkdir(outsideDir, { recursive: true });
  await fs.writeFile(path.join(outsideDir, "keep.txt"), "must-stay", "utf8");

  const symVault = path.join(vaultsRoot, "sym-vault");
  await fs.symlink(outsideDir, symVault);
  const symVaultRes = await postAction({
    operation: "kb",
    action: "delete_vault",
    vaultId: "sym-vault",
  });
  assert.equal(symVaultRes.status, 400);
  assert.equal(await fs.readFile(path.join(outsideDir, "keep.txt"), "utf8"), "must-stay");
  await fs.unlink(symVault);

  const symProj = path.join(home, "projects", "sym-proj");
  await fs.symlink(outsideDir, symProj);
  const symProjRes = await postAction({
    operation: "delete_project",
    projectId: "sym-proj",
  });
  assert.equal(symProjRes.status, 400);
  assert.equal(await fs.readFile(path.join(outsideDir, "keep.txt"), "utf8"), "must-stay");
  await fs.unlink(symProj);

  for (const badId of ["../outside", "a/b", ".hidden"]) {
    const badVaultRes = await postAction({
      operation: "kb",
      action: "delete_vault",
      vaultId: badId,
    });
    assert.equal(badVaultRes.status, 400);
    const badProjRes = await postAction({
      operation: "delete_project",
      projectId: badId,
    });
    assert.equal(badProjRes.status, 400);
  }
});

test("permission boundary: Agent tools and CLI never expose delete_batch, delete_vault, or delete_project", async (t) => {
  const { sandbox, home } = await createSandbox(t, "m40-perms-");
  const host = new NodeHostPort();

  const toolsSource = await fs.readFile(
    path.resolve("src/shells/dsh/project-tools.ts"),
    "utf8",
  );
  const toolNames = [...toolsSource.matchAll(/name:\s*"(seal_[^"]+)"/g)].map(
    (m) => m[1],
  );
  assert.ok(toolNames.length >= 8);
  assert.ok(!toolNames.some((name) => name.includes("delete")));
  assert.doesNotMatch(toolsSource, /delete_batch|delete_vault|delete_entry|delete_project/);

  const cliProjectSource = await fs.readFile(
    path.resolve("src/shells/cli/project-v2.ts"),
    "utf8",
  );
  const cliKbSource = await fs.readFile(
    path.resolve("src/shells/cli/kb.ts"),
    "utf8",
  );
  assert.doesNotMatch(cliProjectSource, /delete_project|delete-project/);
  assert.doesNotMatch(cliKbSource, /delete_batch|delete-batch|delete_vault|delete-vault|delete_entry/);

  // CLI rejects delete_project / delete_vault / delete_batch at runtime
  const tenderPath = path.join(sandbox, "t.docx");
  await fs.writeFile(tenderPath, await packageDocument(paragraph("测试")));
  const projRoot = path.join(home, "projects", "proj-cli");
  await runProject(host, [
    "init",
    "--root",
    projRoot,
    "--name",
    "边界测试项目",
    "--deadline",
    "2028-12-31",
    "--tender",
    tenderPath,
  ]);
  await runProject(host, [
    "extract",
    "--project",
    projRoot,
    "--tender",
    "tender/1.docx",
    "--draft",
    "商务",
    "--ranges",
    '[{"from":"p:0","to":"p:0"}]',
  ]);
  await assert.rejects(
    runProject(host, ["delete_project", "--project", projRoot, "--draft", "商务"]),
    /支持的 project 命令/,
  );
  const kb = new KnowledgeBase(host, path.join(home, "vaults"));
  const v = await kb.createVault({ vaultId: "v-cli", name: "CLI边界库" });
  await assert.rejects(
    runKnowledgeBase(host, ["delete_vault", "--vault", v.vaultId]),
    /支持的知识库命令/,
  );
  await assert.rejects(
    runKnowledgeBase(host, ["delete_batch", "--vault", v.vaultId]),
    /支持的知识库命令/,
  );
  await assert.rejects(
    runKnowledgeBase(host, [
      "save",
      "--vault",
      v.vaultId,
      "--data",
      JSON.stringify({ action: "delete_batch", kind: "material", id: "batch-1" }),
    ]),
    /action 无效/,
  );
});

test("workbench helpers, locale parity, and client safety invariants for safe delete UI", async () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  for (const key of Object.keys(zh) as Array<keyof typeof zh>) {
    assert.ok(zh[key].trim().length > 0, `zh.${key} must not be empty`);
    assert.ok(en[key].trim().length > 0, `en.${key} must not be empty`);
  }
  assert.match(zh.deleteWarningCopyOnly, /Seal/);
  assert.match(zh.deleteWarningCopyOnly, /原件/);

  assert.equal(
    nextSelectedVaultId(
      [
        { vaultId: "v1" },
        { vaultId: "v2", error: "broken" },
        { vaultId: "v3" },
      ],
      "v1",
    ),
    "v3",
  );
  assert.equal(
    nextSelectedVaultId([{ vaultId: "v1" }, { vaultId: "v2", error: "broken" }], "v1"),
    "v2",
  );
  assert.equal(nextSelectedVaultId([{ vaultId: "v1" }], "v1"), "");

  assert.equal(
    formatDeleteBatchNotice({ removedCandidates: 3, removedFiles: 2, preservedFiles: 0 }, "zh"),
    "已删除此导入批次（清理 3 条切片、2 份副本）。",
  );
  assert.equal(
    formatDeleteBatchNotice({ removedCandidates: 3, removedFiles: 1, preservedFiles: 2 }, "zh"),
    "已删除此导入批次（清理 3 条切片、1 份副本，保留 2 份已引用文件）。",
  );
  assert.equal(
    formatDeleteBatchNotice({ removedCandidates: 2, removedFiles: 0, preservedFiles: 1 }, "en"),
    "Import batch deleted (2 slices, 0 copies removed, 1 referenced files preserved).",
  );

  const clientSource = await fs.readFile(path.resolve("src/shells/dsh/client.ts"), "utf8");
  assert.doesNotMatch(clientSource, /dangerouslySetInnerHTML/);
  assert.match(clientSource, /createInlineDeleteController/);
  assert.match(clientSource, /delete_batch/);
  assert.match(clientSource, /delete_entry/);
  assert.match(clientSource, /delete_vault/);
  assert.match(clientSource, /delete_project/);
});

test("P1-1 regression: deleteBatch preserves reference-style links, #fragment, ?query, table-cell links, and HTML img tags", async (t) => {
  const { sandbox, home } = await createSandbox(t, "m40-p1-md-");
  const host = new NodeHostPort();
  const vaultsRoot = path.join(home, "vaults");
  const kb = new KnowledgeBase(host, vaultsRoot);

  const vault = await kb.createVault({ vaultId: "v-md", name: "Markdown引用库" });
  const names = [
    "proof-ref.png",
    "proof-frag.png",
    "proof-query.png",
    "proof-table.png",
    "proof-html.png",
    "proof-data-src.png",
    "proof-entity-q.png",
    "unused-extra.png",
  ];
  const inputs = [];
  for (const name of names) {
    const filePath = path.join(sandbox, name);
    await fs.writeFile(filePath, VALID_PNG_BYTES);
    inputs.push({
      kind: "image" as const,
      sourcePath: filePath,
      originalPath: filePath,
      mime: "image/png",
    });
  }
  const report = await kb.ingestMaterials(
    vault.vaultId,
    inputs,
    path.join(sandbox, "stage"),
  );
  assert.equal(report.candidates.length, 8);
  const byName = (target: string) =>
    report.candidates.find((c) => c.imageFiles[0]?.endsWith(target))!.imageFiles[0]!;

  const refRel = byName("proof-ref.png");
  const fragRel = byName("proof-frag.png");
  const queryRel = byName("proof-query.png");
  const tableRel = byName("proof-table.png");
  const htmlRel = byName("proof-html.png");
  const dataSrcRel = byName("proof-data-src.png");
  const entityQRel = byName("proof-entity-q.png");
  const unusedRel = byName("unused-extra.png");

  await kb.save(vault.vaultId, {
    action: "create",
    kind: "material",
    fields: { title: "多种Markdown引用写法" },
    body: [
      "![证据][e]",
      "",
      `![片段图](../../${fragRel}#page=1)`,
      "",
      `[带参数附件](../../${queryRel}?v=1&raw=true)`,
      "",
      "| 项目 | 附件 |",
      "| --- | --- |",
      `| 表格项 | [表格图](../../${tableRel}) |`,
      "",
      `<img src="../../${htmlRel}" alt="html图" />`,
      "",
      `<img data-src="../../${unusedRel}" alt="a > b" src="../../${dataSrcRel}">`,
      "",
      `<a href="../../${entityQRel.replace("/", "&sol;").replace("/", "&#47").replace(/\./g, "&#46;")}?a=1&amp;b=2#sec&#39;1&#39;">实体路径链接</a>`,
      "",
      `[e]: ../../${refRel}`,
    ].join("\n"),
  });

  const deleted = await kb.deleteBatch(vault.vaultId, report.batchId);
  assert.deepEqual(deleted, {
    batchId: report.batchId,
    removedCandidates: 8,
    removedFiles: 1,
    preservedFiles: 7,
  });

  for (const preserved of [
    refRel,
    fragRel,
    queryRel,
    tableRel,
    htmlRel,
    dataSrcRel,
    entityQRel,
  ]) {
    assert.deepEqual(
      await fs.readFile(path.join(vaultsRoot, vault.vaultId, preserved)),
      VALID_PNG_BYTES,
    );
  }
  await assert.rejects(
    fs.stat(path.join(vaultsRoot, vault.vaultId, unusedRel)),
  );

  // Unknown named entity (including Object.prototype keys like &constructor;) and Unicode HTML5 entities (&hyphen; = U+2010)
  const fHyphen = path.join(sandbox, "proof\u2010unicode.png");
  const fUnused2 = path.join(sandbox, "unused-2.png");
  await fs.writeFile(fHyphen, VALID_PNG_BYTES);
  await fs.writeFile(fUnused2, VALID_PNG_BYTES);
  const reportHyphen = await kb.ingestMaterials(
    vault.vaultId,
    [
      { kind: "image", sourcePath: fHyphen, originalPath: fHyphen, mime: "image/png" },
      { kind: "image", sourcePath: fUnused2, originalPath: fUnused2, mime: "image/png" },
    ],
    path.join(sandbox, "stage-hyphen"),
  );
  const hyphenRel = reportHyphen.candidates[0].imageFiles[0];
  await kb.save(vault.vaultId, {
    action: "create",
    kind: "material",
    fields: { title: "Unicode命名实体引用" },
    body: `<img src="../../${hyphenRel.replace("\u2010", "&hyphen;")}">`,
  });
  const deletedHyphen = await kb.deleteBatch(vault.vaultId, reportHyphen.batchId);
  assert.deepEqual(deletedHyphen, {
    batchId: reportHyphen.batchId,
    removedCandidates: 2,
    removedFiles: 1,
    preservedFiles: 1,
  });
  assert.deepEqual(
    await fs.readFile(path.join(vaultsRoot, vault.vaultId, hyphenRel)),
    VALID_PNG_BYTES,
  );

  // Unknown named entity including prototype key &constructor; must fail closed and preserve batch files
  const fUnknown = path.join(sandbox, "unknown-entity-proof.png");
  await fs.writeFile(fUnknown, VALID_PNG_BYTES);
  const report2 = await kb.ingestMaterials(
    vault.vaultId,
    [{ kind: "image", sourcePath: fUnknown, originalPath: fUnknown, mime: "image/png" }],
    path.join(sandbox, "stage-unknown"),
  );
  const unknownRel = report2.candidates[0].imageFiles[0];
  await kb.save(vault.vaultId, {
    action: "create",
    kind: "material",
    fields: { title: "未知HTML实体保守保留" },
    body: `<img src="../../files/${report2.batchId}/&constructor;proof.png">`,
  });
  const deleted2 = await kb.deleteBatch(vault.vaultId, report2.batchId);
  assert.deepEqual(deleted2, {
    batchId: report2.batchId,
    removedCandidates: 1,
    removedFiles: 0,
    preservedFiles: 1,
  });
  assert.deepEqual(
    await fs.readFile(path.join(vaultsRoot, vault.vaultId, unknownRel)),
    VALID_PNG_BYTES,
  );
});

test("P1-2 regression: concurrent create() and delete_vault() serialize on KB lock without leaving orphan vaultId reference", async (t) => {
  const { sandbox, home } = await createSandbox(t, "m40-p1-race-");
  const baseHost = new NodeHostPort();
  const vaultsRoot = path.join(home, "vaults");
  const tenderPath = path.join(sandbox, "tender.docx");
  await fs.writeFile(tenderPath, await packageDocument(paragraph("并发竞态招标")));

  // Case A: create() enters KB lock first, pauses inside readText('vault.json'); delete_vault() queues behind it and must fail
  const kbA = new KnowledgeBase(baseHost, vaultsRoot);
  await kbA.createVault({ vaultId: "v-race-a", name: "竞态库A" });

  let notifyEnteredMetadata!: () => void;
  const enteredMetadata = new Promise<void>((resolve) => {
    notifyEnteredMetadata = resolve;
  });
  let releaseCreate!: () => void;
  const createGate = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  let hooked = false;
  const hookedHost: HostPort = {
    readBytes: (p) => baseHost.readBytes(p),
    writeBytes: (p, d) => baseHost.writeBytes(p, d),
    readText: async (p) => {
      const content = await baseHost.readText(p);
      if (!hooked && p.endsWith(path.join("v-race-a", "vault.json"))) {
        hooked = true;
        notifyEnteredMetadata();
        await createGate;
      }
      return content;
    },
    writeText: (p, c) => baseHost.writeText(p, c),
    stat: (p) => baseHost.stat(p),
    removeDirectory: (p) => baseHost.removeDirectory!(p),
    removeFile: (p) => baseHost.removeFile!(p),
    makeDirectory: (p) => baseHost.makeDirectory!(p),
    listFiles: (p) => baseHost.listFiles!(p),
    joinPath: (...s) => baseHost.joinPath(...s),
    dirname: (p) => baseHost.dirname(p),
    writeFiles: (f) => baseHost.writeFiles!(f),
    authorizationKey: (c) => baseHost.authorizationKey!(c),
    ledgerAnchorPath: (r, c) => baseHost.ledgerAnchorPath!(r, c),
  };

  const serviceA = new WorkbenchHost(hookedHost);
  const createPromise = serviceA.create({
    name: "并发项目A",
    deadline: "2028-12-31",
    vaultId: "v-race-a",
    files: [tenderPath],
  });
  await enteredMetadata;

  // Fire delete_vault while create() is paused inside KB lock
  let deleteSettledEarly = false;
  const deletePromise = serviceA
    .kb({ action: "delete_vault", vaultId: "v-race-a" })
    .finally(() => {
      deleteSettledEarly = true;
    });

  await new Promise((r) => setTimeout(r, 25));
  assert.equal(
    deleteSettledEarly,
    false,
    "delete_vault must wait for create() holding KB lock",
  );

  releaseCreate();
  const createdA = (await createPromise) as { id: string; root: string };
  await assert.rejects(deletePromise, /并发项目A/);
  // Both project and vault remain intact and consistent
  await fs.stat(path.join(vaultsRoot, "v-race-a", "vault.json"));
  await fs.stat(path.join(createdA.root, "seal-project.json"));

  // Case B: delete_vault() runs first on an unreferenced vault while create() queues behind it; create() must reject
  await kbA.createVault({ vaultId: "v-race-b", name: "竞态库B" });
  const serviceB = new WorkbenchHost(baseHost);
  const [delB, createB] = await Promise.allSettled([
    serviceB.kb({ action: "delete_vault", vaultId: "v-race-b" }),
    serviceB.create({
      name: "并发项目B",
      deadline: "2028-12-31",
      vaultId: "v-race-b",
      files: [tenderPath],
    }),
  ]);
  assert.equal(delB.status, "fulfilled");
  assert.equal(createB.status, "rejected");
  await assert.rejects(fs.stat(path.join(vaultsRoot, "v-race-b")));
  const overview = await serviceB.overview();
  assert.ok(
    !overview.projects.some(
      (p) => (p.project as { vaultId?: string } | undefined)?.vaultId === "v-race-b",
    ),
    "no project may reference a deleted vault",
  );
});

test("P2-3 regression: InlineDeleteController enforces arm/cancel/re-entrancy/error-retention state machine", async () => {
  const snapshots: InlineDeleteState[] = [];
  const ctrl = createInlineDeleteController((state) => snapshots.push(state));

  assert.deepEqual(ctrl.snapshot(), { armedKey: null, busy: false, error: "" });

  let calls = 0;
  // Calling confirm before arming does nothing
  assert.equal(
    await ctrl.confirm("item-1", async () => {
      calls++;
    }),
    false,
  );
  assert.equal(calls, 0);

  // Arming does not execute callback
  ctrl.arm("item-1");
  assert.deepEqual(ctrl.snapshot(), { armedKey: "item-1", busy: false, error: "" });
  assert.equal(calls, 0);

  // Confirming wrong key is rejected
  assert.equal(
    await ctrl.confirm("item-2", async () => {
      calls++;
    }),
    false,
  );
  assert.equal(calls, 0);
  assert.equal(ctrl.snapshot().armedKey, "item-1");

  // Cancel disarms without executing callback
  ctrl.cancel();
  assert.deepEqual(ctrl.snapshot(), { armedKey: null, busy: false, error: "" });

  // Re-arm and confirm with failing operation -> preserves armedKey & error
  ctrl.arm("item-1");
  const failed = await ctrl.confirm("item-1", async () => {
    calls++;
    throw new Error("项目正被占用");
  });
  assert.equal(failed, false);
  assert.equal(calls, 1);
  assert.deepEqual(ctrl.snapshot(), {
    armedKey: "item-1",
    busy: false,
    error: "项目正被占用",
  });

  // Reset clears armedKey & error
  ctrl.reset();
  assert.deepEqual(ctrl.snapshot(), { armedKey: null, busy: false, error: "" });

  // Re-entrancy guard during in-flight confirm
  ctrl.arm("item-1");
  let releaseFlight!: () => void;
  const flight = new Promise<void>((resolve) => {
    releaseFlight = resolve;
  });
  const firstConfirm = ctrl.confirm("item-1", async () => {
    calls++;
    await flight;
  });
  assert.equal(ctrl.snapshot().busy, true);
  // Second confirm, arm, and cancel while busy are all ignored
  assert.equal(
    await ctrl.confirm("item-1", async () => {
      calls++;
    }),
    false,
  );
  ctrl.arm("item-2");
  ctrl.cancel();
  assert.equal(ctrl.snapshot().armedKey, "item-1");
  assert.equal(ctrl.snapshot().busy, true);

  releaseFlight();
  assert.equal(await firstConfirm, true);
  assert.equal(calls, 2);
  assert.deepEqual(ctrl.snapshot(), { armedKey: null, busy: false, error: "" });
  assert.ok(snapshots.some((s) => s.busy === true));

  // Reset during in-flight failing confirm preserves busy=true, blocks B, and suppresses stale error after A finishes
  ctrl.arm("item-A");
  let rejectA!: (err: Error) => void;
  const flightA = new Promise<void>((_resolve, reject) => {
    rejectA = reject;
  });
  const confirmA = ctrl.confirm("item-A", async () => {
    calls++;
    await flightA;
  });
  assert.equal(ctrl.snapshot().busy, true);
  ctrl.reset();
  assert.deepEqual(ctrl.snapshot(), { armedKey: null, busy: true, error: "" });

  // While A is still in-flight after reset(), cannot arm B or confirm B
  ctrl.arm("item-B");
  assert.deepEqual(ctrl.snapshot(), { armedKey: null, busy: true, error: "" });
  assert.equal(
    await ctrl.confirm("item-B", async () => {
      calls++;
    }),
    false,
  );
  assert.equal(calls, 3);

  // Now A fails; busy clears to false, stale error from A is NOT leaked into new context
  rejectA(new Error("过时错误"));
  assert.equal(await confirmA, false);
  assert.deepEqual(ctrl.snapshot(), { armedKey: null, busy: false, error: "" });

  // New target B now works cleanly
  ctrl.arm("item-B");
  assert.equal(
    await ctrl.confirm("item-B", async () => {
      calls++;
    }),
    true,
  );
  assert.equal(calls, 4);
  assert.deepEqual(ctrl.snapshot(), { armedKey: null, busy: false, error: "" });
});
