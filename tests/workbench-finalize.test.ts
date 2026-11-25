import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NodeHostPort } from "../src/shells/node-host.js";
import { WorkbenchHost } from "../src/shells/dsh/workbench-host.js";
import { runProject } from "../src/shells/cli/project-v2.js";
import { packageDocument, paragraph } from "./fixtures/layout-matrix.js";
import { validatePackageStructure } from "../src/core/docx/package-structure.js";
import {
  editableText,
  visibleRunProperties,
} from "../src/core/docx/visible-surgery.js";

test("owner exports all clean volumes while draft, baseline and ledger bytes stay unchanged", async (t) => {
  const home = path.resolve(".tmp", `final-workbench-${randomUUID()}`),
    previous = process.env.SEAL_HOME;
  process.env.SEAL_HOME = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.SEAL_HOME;
    else process.env.SEAL_HOME = previous;
    await fs.rm(home, { recursive: true, force: true });
  });
  const host = new NodeHostPort(),
    service = new WorkbenchHost(host),
    source = path.join(home, "source.docx");
  await fs.mkdir(home, { recursive: true });
  const original = await packageDocument(
    '<w:p><w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t>原件黄色保留</w:t></w:r></w:p>' +
      paragraph("名称：________") +
      paragraph("报价：________"),
  );
  await fs.writeFile(source, original);
  const created = await service.create({
    name: "合成定稿",
    deadline: "2028-02-29",
    files: [source],
  });
  const root = created.root;
  for (const draft of ["甲", "乙"])
    await runProject(host, [
      "extract",
      "--project",
      root,
      "--tender",
      "tender/1.docx",
      "--draft",
      draft,
      "--ranges",
      '[{"from":"p:0","to":"p:2"}]',
    ]);
  const loadReview = async () => {
    const value = await service.review({ projectId: created.id });
    if (value.kind !== "project") throw new Error("project expected");
    return value;
  };
  let review = await loadReview();
  await assert.rejects(
    service.finalize({ projectId: created.id, revision: review.revision }),
    /闸门/,
  );
  for (const draft of ["甲", "乙"])
    await runProject(host, [
      "edit",
      "--project",
      root,
      "--draft",
      draft,
      "--ops",
      JSON.stringify([
        { op: "replace", at: "p:1", find: "________", value: "合成单位" },
        { op: "replace", at: "p:2", find: "________", value: "壹元整，1元" },
      ]),
    ]);
  for (let attempt = 0; attempt < 12; attempt++) {
    review = await loadReview();
    if (review.ready) break;
    const row = review
      .groups!.flatMap((group) => group.items)
      .find(
        (row) =>
          row.actions.includes("confirm") || row.actions.includes("accept"),
      );
    assert.ok(row, JSON.stringify(review));
    await service.act({
      projectId: created.id,
      revision: review.revision,
      keys: [row.key],
      action: row.actions.includes("confirm")
        ? row.actions.includes("accept")
          ? "confirm_accept"
          : "confirm"
        : "accept",
    });
  }
  review = await loadReview();
  assert.equal(review.ready, true, JSON.stringify(review));
  const preserved = [
    "ledger.json",
    "draft/甲.docx",
    "draft/甲.base.docx",
    "draft/乙.docx",
    "draft/乙.base.docx",
  ];
  const before = await Promise.all(
    preserved.map((file) => fs.readFile(path.join(root, file))),
  );
  const exported = await service.finalize({
    projectId: created.id,
    revision: review.revision,
  });
  assert.deepEqual(exported.files, ["甲", "乙"]);
  for (const [index, file] of preserved.entries())
    assert.deepEqual(
      await fs.readFile(path.join(root, file)),
      before[index],
      file,
    );
  for (const draft of exported.files) {
    const bytes = (
      await service.file({ projectId: created.id, draft, final: "true" })
    ).bytes;
    const xml = new TextDecoder().decode(
      (await validatePackageStructure(bytes)).get("word/document.xml"),
    );
    assert.equal(xml.includes("_Seal_"), false);
    assert.equal(
      visibleRunProperties(xml).filter((properties) =>
        properties.includes('<w:highlight w:val="yellow"'),
      ).length,
      "原件黄色保留".length,
    );
    const text = editableText(xml),
      properties = visibleRunProperties(xml);
    for (const value of ["原件黄色保留", "合成单位", "壹元整，1元"]) {
      const start = text.indexOf(value);
      assert.ok(start >= 0, value);
      assert.ok(
        properties
          .slice(start, start + value.length)
          .every(
            (style) =>
              style.includes('<w:highlight w:val="yellow"') ===
              (value === "原件黄色保留"),
          ),
        value,
      );
    }
  }
  await runProject(host, [
    "edit",
    "--project",
    root,
    "--draft",
    "甲",
    "--ops",
    '[{"op":"replace","at":"p:1","find":"合成单位","value":"变化单位"}]',
  ]);
  await assert.rejects(
    service.file({ projectId: created.id, draft: "甲", final: "true" }),
    /过时/,
  );
  assert.deepEqual(await fs.readFile(source), Buffer.from(original));
});

test("public checks retain global readiness across selectors and the fifty-first result", async (t) => {
  const home = path.resolve(".tmp", `global-check-${randomUUID()}`),
    previous = process.env.SEAL_HOME;
  process.env.SEAL_HOME = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.SEAL_HOME;
    else process.env.SEAL_HOME = previous;
    await fs.rm(home, { recursive: true, force: true });
  });
  const host = new NodeHostPort(),
    service = new WorkbenchHost(host),
    source = path.join(home, "source.docx");
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(
    source,
    await packageDocument(
      paragraph("完整固定原文") +
        Array.from({ length: 51 }, () => paragraph("壹元整，2元")).join(""),
    ),
  );
  const created = await service.create({
      name: "全册闸门",
      deadline: "2028-02-29",
      files: [source],
    }),
    root = created.root;
  for (const [draft, ranges] of [
    ["甲", [{ from: "p:0", to: "p:0" }]],
    ["乙", [{ from: "p:1", to: "p:51" }]],
  ] as const)
    await runProject(host, [
      "extract",
      "--project",
      root,
      "--tender",
      "tender/1.docx",
      "--draft",
      draft,
      "--ranges",
      JSON.stringify(ranges),
    ]);
  const selected = (await runProject(host, [
    "check",
    "--project",
    root,
    "--draft",
    "甲",
    "--group",
    "C01",
  ])) as any;
  assert.equal(selected.ready, false);
  assert.equal(selected.blockingCounts.C13, 51);
  assert.deepEqual(selected.results, { C01: [] });
  const first = (await runProject(host, [
    "check",
    "--project",
    root,
    "--draft",
    "乙",
    "--group",
    "C13",
  ])) as any;
  assert.equal(first.results.C13.length, 50);
  assert.equal(first.counts.C13, 51);
  const second = (await runProject(host, [
    "check",
    "--project",
    root,
    "--draft",
    "乙",
    "--group",
    "C13",
    "--offset",
    "50",
  ])) as any;
  assert.equal(second.results.C13.length, 1);
  assert.equal(second.ready, false);
  const review = await service.review({ projectId: created.id });
  if (review.kind !== "project") throw new Error("project expected");
  await assert.rejects(
    service.finalize({ projectId: created.id, revision: review.revision }),
    /闸门/,
  );
});

test("section filtering, targeted batch actions, permission boundaries, and large-batch caching in WorkbenchHost", async (t) => {
  const home = path.resolve(".tmp", `section-workbench-${randomUUID()}`),
    previous = process.env.SEAL_HOME;
  process.env.SEAL_HOME = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.SEAL_HOME;
    else process.env.SEAL_HOME = previous;
    await fs.rm(home, { recursive: true, force: true });
  });
  const host = new NodeHostPort(),
    service = new WorkbenchHost(host),
    source = path.join(home, "source.docx");
  await fs.mkdir(home, { recursive: true });
  const heading = (title: string) =>
    `<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>${title}</w:t></w:r></w:p>`;
  const tableRow = (a: string, b: string) =>
    `<w:tr><w:tc><w:p><w:r><w:t>${a}</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>${b}</w:t></w:r></w:p></w:tc></w:tr>`;
  const original = await packageDocument(
    heading("第一章 商务部分") +
      paragraph("报价A：____") +
      paragraph("说明A：____") +
      paragraph("固定条A：甲乙") +
      `<w:tbl>${tableRow("项目", "【填表格A】")}</w:tbl>` +
      heading("第二章 技术部分") +
      paragraph("报价B：____") +
      paragraph("说明B：____") +
      paragraph("未填空白：____") +
      paragraph("【填括号B】"),
  );
  await fs.writeFile(source, original);
  const created = await service.create({
    name: "分节批处理",
    deadline: "2028-02-29",
    files: [source],
  });
  const root = created.root;
  await runProject(host, [
    "extract",
    "--project",
    root,
    "--tender",
    "tender/1.docx",
    "--draft",
    "投标文件",
    "--ranges",
    '[{"from":"p:0","to":"p:8"}]',
  ]);
  await runProject(host, [
    "edit",
    "--project",
    root,
    "--draft",
    "投标文件",
    "--ops",
    JSON.stringify([
      { op: "replace", at: "p:1", find: "____", value: "100元", pending: { category: "报价", note: "A" } },
      { op: "dismiss_hint", at: "p:2", blank: 0, reason: "无需填写" },
      { op: "replace", at: "p:3", find: "甲乙", value: "丙丁" },
      { op: "replace", at: "t:0/r:0/c:1", find: "【填表格A】", value: "表格值A" },
      { op: "replace", at: "p:5", find: "____", value: "200元", pending: { category: "报价", note: "B" } },
      { op: "dismiss_hint", at: "p:6", blank: 0, reason: "无需填写" },
      { op: "replace", at: "p:8", find: "【填括号B】", value: "括号值B" },
    ]),
  ]);
  const loadReview = async (sections?: Record<string, string>) => {
    const view = await service.review({ projectId: created.id, sections });
    if (view.kind !== "project") throw new Error("project expected");
    return view;
  };
  let view = await loadReview();
  const c03 = view.groups.find((g) => g.id === "C03")!;
  assert.equal(c03.sections.length, 2);
  assert.equal(c03.sections[0].label, "投标文件 · 第一章 商务部分");
  assert.equal(c03.sections[1].label, "投标文件 · 第二章 技术部分");

  const bracket = view.groups.find((g) => g.id === "bracketText")!;
  assert.equal(bracket.sections.length, 2);
  assert.equal(bracket.sections[0].label, "投标文件 · 第一章 商务部分 · 表格 t:0");
  assert.equal(bracket.sections[1].label, "投标文件 · 第二章 技术部分");

  const pendingQuote = view.groups.find((g) => g.id === "pending:报价")!;
  assert.equal(pendingQuote.sections.length, 2);

  // Filtered view counts only the selected section while preserving totalCount and full sections
  const filteredView = await loadReview({ C03: c03.sections[0].key });
  const filteredC03 = filteredView.groups.find((g) => g.id === "C03")!;
  assert.equal(filteredC03.count, 1);
  assert.equal(filteredC03.totalCount, 2);
  assert.equal(filteredC03.activeSection, c03.sections[0].key);
  assert.equal(filteredC03.sections.length, 2);

  // Negative permission checks: section batching must reject ordinary C06, C02, C07
  const c06 = view.groups.find((g) => g.id === "C06")!;
  const c02 = view.groups.find((g) => g.id === "C02")!;
  for (const invalid of [
    { group: "C06", section: c06.sections[0].key, action: "accept" },
    { group: "C06", section: c06.sections[0].key, action: "confirm" },
    { group: "C02", section: c02.sections[0].key, action: "review" },
    { group: "C02", section: c02.sections[0].key, action: "confirm" },
    { group: "C07", section: c06.sections[0].key, action: "accept" },
    { group: "bracketText", section: bracket.sections[0].key, action: "confirm" },
  ]) {
    await assert.rejects(
      service.act({ projectId: created.id, revision: view.revision, ...invalid }),
      /不支持/,
    );
  }

  // Targeted section batch actions only clear the chosen section
  await service.act({
    projectId: created.id,
    revision: view.revision,
    group: "bracketText",
    section: bracket.sections[0].key,
    action: "accept",
  });
  view = await loadReview();
  const bracketAfter = view.groups.find((g) => g.id === "bracketText")!;
  assert.equal(bracketAfter.count, 1);
  assert.equal(bracketAfter.items[0].sectionKey, bracket.sections[1].key);

  await service.act({
    projectId: created.id,
    revision: view.revision,
    group: "C03",
    section: c03.sections[0].key,
    action: "review",
  });
  view = await loadReview();
  const c03After = view.groups.find((g) => g.id === "C03")!;
  assert.equal(c03After.count, 1);
  assert.equal(c03After.items[0].sectionKey, c03.sections[1].key);

  await service.act({
    projectId: created.id,
    revision: view.revision,
    group: "pending:报价",
    section: pendingQuote.sections[0].key,
    action: "confirm",
  });
  view = await loadReview();
  const pendingAfter = view.groups.find((g) => g.id === "pending:报价")!;
  assert.equal(pendingAfter.count, 1);
  assert.equal(pendingAfter.items[0].sectionKey, pendingQuote.sections[1].key);
});

test("WorkbenchHost.act processes 300+ C03 items efficiently via per-draft XML cache", async (t) => {
  const home = path.resolve(".tmp", `perf-workbench-${randomUUID()}`),
    previous = process.env.SEAL_HOME;
  process.env.SEAL_HOME = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.SEAL_HOME;
    else process.env.SEAL_HOME = previous;
    await fs.rm(home, { recursive: true, force: true });
  });
  const host = new NodeHostPort(),
    service = new WorkbenchHost(host),
    source = path.join(home, "source.docx");
  await fs.mkdir(home, { recursive: true });
  const count = 360;
  const original = await packageDocument(
    Array.from({ length: count }, (_, i) => paragraph(`条款${i}：____`)).join(""),
  );
  await fs.writeFile(source, original);
  const created = await service.create({
    name: "大批量缓存",
    deadline: "2028-02-29",
    files: [source],
  });
  await runProject(host, [
    "extract",
    "--project",
    created.root,
    "--tender",
    "tender/1.docx",
    "--draft",
    "长分册",
    "--ranges",
    JSON.stringify([{ from: "p:0", to: `p:${count - 1}` }]),
  ]);
  await runProject(host, [
    "edit",
    "--project",
    created.root,
    "--draft",
    "长分册",
    "--ops",
    JSON.stringify(
      Array.from({ length: count }, (_, i) => ({
        op: "dismiss_hint",
        at: `p:${i}`,
        blank: 0,
        reason: "批量跳过",
      })),
    ),
  ]);
  const view = await service.review({ projectId: created.id });
  if (view.kind !== "project") throw new Error("project expected");
  const started = performance.now();
  const res = await service.act({
    projectId: created.id,
    revision: view.revision,
    group: "C03",
    action: "review",
  });
  const elapsedMs = performance.now() - started;
  assert.equal(res.processed, count);
  assert.ok(elapsedMs < 5000, `Expected < 5000ms, got ${elapsedMs.toFixed(1)}ms`);
  const after = await service.review({ projectId: created.id });
  if (after.kind !== "project") throw new Error("project expected");
  assert.equal(after.groups.some((g) => g.id === "C03"), false);
});
