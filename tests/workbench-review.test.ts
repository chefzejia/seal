import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reviewItems,
  reviewPage,
  editBuffer,
  dirtyBuffers,
} from "../src/workbench/review.js";
import { emptyResults } from "../src/core/bid/report.js";

test("review merges only a unique exact range, preserves different positions, and pages every item", () => {
  const results = emptyResults();
  results.C04 = [
    { id: "p1", address: "p:0", offset: 2, value: "100", category: "报价" },
  ];
  results.C05 = [{ id: "p1", reason: "未核实" }];
  results.C06 = [
    {
      id: "d1",
      kind: "modified",
      address: "p:0",
      before: "提示",
      after: "100",
      subtype: "bracketText",
    },
  ];
  const report = { draft: "商务", complete: true, results, limitations: [] };
  const merged = reviewItems([report], new Map([["商务:p:0", "前文100"]]));
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].pendingIds, ["p1"]);
  assert.deepEqual(merged[0].differenceIds, ["d1"]);
  assert.ok(merged[0].actions.includes("accept"));
  assert.equal(merged[0].group, "bracketText");
  assert.match(merged[0].reason, /未核实/);
  results.C04.push({
    id: "p2",
    address: "p:0",
    offset: 6,
    value: "100",
    category: "报价",
  });
  assert.equal(
    reviewItems([report], new Map([["商务:p:0", "前文100后文100"]])).length,
    3,
  );
  const long = Array.from({ length: 51 }, (_, index) => ({
    ...merged[0],
    key: String(index),
  }));
  const first = reviewPage(long);
  assert.equal(first[0].count, 51);
  assert.equal(first[0].nextPage, 1);
  assert.equal(reviewPage(long, { [merged[0].group]: 2 })[0].items.length, 1);
});

test("dirty buffers survive refreshed data and preserve the revision the user edited", () => {
  const initial = editBuffer(undefined, "r1", "原文");
  const dirty = { ...initial, value: "正在编辑" };
  assert.equal(dirtyBuffers({ row: dirty }), true);
  assert.deepEqual(editBuffer(dirty, "r2", "新原文"), dirty);
  assert.deepEqual(editBuffer(initial, "r2", "新原文"), {
    baseRevision: "r2",
    original: "新原文",
    value: "新原文",
  });
  assert.equal(dirtyBuffers({ row: initial }), false);
});

test("reviewItems maps headings and tables to domain-neutral section keys and falls back without outlines", () => {
  const results = emptyResults();
  results.C03 = [
    { id: "h0", address: "p:0", hintText: "____" },
    { id: "h1", address: "p:2", hintText: "____" },
    { id: "h2", address: "t:0/r:1/c:0", hintText: "____" },
    { id: "h3", address: "p:5", hintText: "____" },
    { id: "h4", address: "t:1/r:0/c:1", hintText: "____" },
  ];
  const report = { draft: "技术", complete: true, results, limitations: [] };
  const withoutOutline = reviewItems([report]);
  assert.equal(withoutOutline[0].sectionLabel, "技术 · 正文");
  assert.equal(withoutOutline[2].sectionLabel, "技术 · 表格 t:0");
  assert.equal(withoutOutline[4].sectionLabel, "技术 · 表格 t:1");

  const withOutline = reviewItems([report], new Map(), [
    {
      draft: "技术",
      blockOrder: ["p:0", "p:1", "p:2", "t:0", "p:3", "p:4", "p:5", "t:1"],
      sections: [
        { address: "p:1", from: "p:1", to: "p:3", title: "一、总体方案" },
        { address: "p:4", from: "p:4", to: "t:1", title: "二、售后承诺" },
      ],
    },
  ]);
  assert.equal(withOutline[0].sectionLabel, "技术 · 正文");
  assert.equal(withOutline[1].sectionLabel, "技术 · 一、总体方案");
  assert.equal(withOutline[2].sectionLabel, "技术 · 一、总体方案 · 表格 t:0");
  assert.equal(withOutline[3].sectionLabel, "技术 · 二、售后承诺");
  assert.equal(withOutline[4].sectionLabel, "技术 · 二、售后承诺 · 表格 t:1");
  assert.ok(withOutline.every((item) => item.sectionKey.length > 0 && item.sectionLabel.length > 0));
});

test("reviewPage computes full section summaries in document order and paginates filtered sections", () => {
  const results = emptyResults();
  for (let i = 0; i < 30; i++) {
    results.C03.push({ id: `a${i}`, address: "p:1", hintText: "__" });
  }
  for (let i = 0; i < 20; i++) {
    results.C03.push({ id: `b${i}`, address: "t:0/r:0/c:0", hintText: "__" });
  }
  for (let i = 0; i < 10; i++) {
    results.C03.push({ id: `c${i}`, address: "p:4", hintText: "__" });
  }
  const report = { draft: "商务", complete: true, results, limitations: [] };
  const items = reviewItems([report], new Map(), [
    {
      draft: "商务",
      blockOrder: ["p:0", "p:1", "t:0", "p:3", "p:4"],
      sections: [
        { address: "p:0", title: "第一章 商务响应" },
        { address: "p:3", title: "第二章 偏差说明" },
      ],
    },
  ]);
  const full = reviewPage(items, {}, 25);
  assert.equal(full[0].totalCount, 60);
  assert.equal(full[0].count, 60);
  assert.equal(full[0].activeSection, null);
  assert.equal(full[0].items.length, 25);
  assert.equal(full[0].nextPage, 1);
  assert.deepEqual(full[0].sections, [
    { key: "商务::p:0", label: "商务 · 第一章 商务响应", count: 30 },
    { key: "商务::p:0::t:0", label: "商务 · 第一章 商务响应 · 表格 t:0", count: 20 },
    { key: "商务::p:3", label: "商务 · 第二章 偏差说明", count: 10 },
  ]);

  const filteredTable = reviewPage(items, {}, 25, { C03: "商务::p:0::t:0" });
  assert.equal(filteredTable[0].totalCount, 60);
  assert.equal(filteredTable[0].count, 20);
  assert.equal(filteredTable[0].activeSection, "商务::p:0::t:0");
  assert.equal(filteredTable[0].items.length, 20);
  assert.equal(filteredTable[0].nextPage, null);
  assert.equal(filteredTable[0].sections.length, 3);

  const filteredPage2 = reviewPage(items, { C03: 1 }, 25, { C03: "商务::p:0" });
  assert.equal(filteredPage2[0].count, 30);
  assert.equal(filteredPage2[0].items.length, 5);
  assert.equal(filteredPage2[0].nextPage, null);

  const missingSection = reviewPage(items, {}, 25, { C03: "商务::nonexistent" });
  assert.equal(missingSection[0].activeSection, null);
  assert.equal(missingSection[0].count, 60);
});
