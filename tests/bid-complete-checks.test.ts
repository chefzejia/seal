import { test } from "node:test";
import assert from "node:assert/strict";
import { checkMoney, chineseMoneyCents } from "../src/core/bid/money.js";
import {
  checkRequirements,
  parseRequirements,
  validateRequirementsBatch,
} from "../src/core/bid/requirements.js";
import { completeProjectCheck, emptyResults } from "../src/core/bid/report.js";
import { workflowTemplate } from "./fixtures/workflow-template.js";
import { packageDocument, paragraph } from "./fixtures/layout-matrix.js";

test("C13 preserves currency prefixes, zero connectors and fractional-only amounts", () => {
  const pairs = [
    ["壹佰元整", "人民币100元", "人民币99元"],
    ["壹佰元零伍分", "100.05元", "100.04元"],
    ["壹佰元零伍分正", "人民币100.05", "人民币100.04"],
    ["伍角", "0.50元", "0.40元"],
    ["伍角整", "人民币0.50元", "人民币0.40元"],
    ["伍角贰分", "￥0.52", "￥0.51"],
    ["伍分", "0.05元", "0.04元"],
    ["零元零伍分", "0.05元", "0.04元"],
    ["零元零角伍分", "0.05元", "0.04元"],
    ["零元零角零分", "0.00元", "0.01元"],
    ["壹元零角", "1元", "2元"],
    ["壹圆正", "人民币1", "人民币2"],
  ];
  for (const [upper, equal, different] of pairs) {
    for (const [lower, expected] of [
      [equal, 0],
      [different, 1],
    ] as const) {
      const text = `人民币大写：${upper}，小写${lower}。`;
      assert.equal(
        checkMoney([{ address: "p:0", text }]).length,
        expected,
        text,
      );
    }
  }
  assert.equal(
    checkMoney([
      { address: "p:0", text: "壹佰元零伍分，100.05元；伍角，0.40元" },
    ]).length,
    1,
  );
  assert.equal(
    checkMoney([
      { address: "t:0/r:0/c:0/p:0", text: "壹佰元零伍分；伍角" },
      { address: "t:0/r:0/c:1/p:0", text: "人民币100.05元；人民币0.40元" },
    ]).length,
    1,
  );
  const ambiguous = checkMoney([
    { address: "p:0", text: "壹元整；贰元整；人民币2元" },
  ]);
  assert.equal(ambiguous.length, 1, "Unequal literal counts remain visible");
  assert.match(ambiguous[0].reason, /唯一/);
});

test("C13 compares exact integer cents across the money grammar and each readable row", () => {
  for (const [chinese, arabic] of [
    ["壹仟贰佰叁拾肆圆伍角陆分", "￥1,234.56"],
    ["壹元整", "1.00元"],
    ["壹元正", "1元"],
    ["零元壹分", "0.01元"],
    ["壹元零角伍分", "1.05元"],
    ["壹亿零叁万零伍元贰角叁分", "100,030,005.23元"],
    ["玖仟玖佰万亿零壹元整", "9900000000000001元"],
  ]) {
    assert.deepEqual(
      checkMoney([{ address: "p:0", text: `（${chinese}），${arabic}。` }]),
      [],
      chinese,
    );
    assert.equal(
      checkMoney([
        {
          address: "p:0",
          text: `（${chinese}），${arabic.replace(/1|5|3|0/, "8")}。`,
        },
      ]).length,
      1,
      chinese,
    );
  }
  assert.equal(
    checkMoney([
      { address: "t:0/r:0/c:0/p:0", text: "壹元整" },
      { address: "t:0/r:0/c:1/p:0", text: "2元" },
    ]).length,
    1,
  );
  assert.deepEqual(
    checkMoney([{ address: "p:0", text: "壹元整 1元；贰元整 2元" }]),
    [],
  );
  assert.equal(
    checkMoney([{ address: "p:0", text: "壹元整 2元；贰元整 1元" }]).length,
    2,
  );
  assert.equal(
    checkMoney([{ address: "readonly:header/p:0", text: "壹元整：2元" }])
      .length,
    1,
  );
  assert.equal(
    checkMoney([
      { address: "p:0", text: "玖仟玖佰万亿零壹元壹分，9900000000000001.02元" },
    ]).length,
    1,
    "one cent remains distinct beyond Number precision",
  );
  assert.equal(
    checkMoney([
      { address: "t:0/r:0/c:0/p:0", text: "壹元整，1元" },
      { address: "t:0/r:0/c:0/t:0/r:0/c:0/p:0", text: "贰元整" },
      { address: "t:0/r:0/c:0/t:0/r:0/c:1/p:0", text: "3元" },
    ]).length,
    1,
    "nested rows form their own amount context",
  );
});

test("C14 normalizes only width and whitespace and resolves complete source containers", async () => {
  const inside = paragraph("ＡＢＣ １２３，逐字①核对");
  const nested = `<w:tbl><w:tr><w:tc>${inside}</w:tc></w:tr></w:tbl>`;
  const bytes = await packageDocument(
    paragraph("开头") +
      `<w:tbl><w:tr><w:tc>${paragraph("外层")}${nested}</w:tc></w:tr></w:tbl>` +
      `<w:sdt><w:sdtContent>${paragraph("只读来源原文")}</w:sdtContent></w:sdt>`,
  );
  const sources = new Map([["tender/1.docx", bytes]]);
  const check = (address: string, quote = "ABC123,逐字①核对") =>
    checkRequirements(
      parseRequirements(
        JSON.stringify({
          format: "seal-requirements-1",
          items: [
            {
              id: "literal",
              kind: "格式要求",
              text: "逐字引文",
              quote,
              source: { file: "tender/1.docx", address },
              mustRespond: true,
              responses: [
                { draft: "甲", address: "word/document.xml#readonly:p:0" },
              ],
            },
          ],
        }),
      ),
      sources,
      new Map([["甲", bytes]]),
    );
  for (const address of [
    "t:0",
    "t:0/r:0",
    "t:0/r:0/c:0",
    "t:0/r:0/c:0/t:0",
    "t:0/r:0/c:0/t:0/r:0/c:0/p:0",
  ])
    assert.deepEqual(await check(address), { C12: [], C14: [] }, address);
  assert.deepEqual(
    await check("word/document.xml#readonly:p:0", "只读来源原文"),
    { C12: [], C14: [] },
  );
  assert.equal(
    (await check("t:0", "ABC123,逐字1核对")).C14.length,
    1,
    "circled digits are not width variants",
  );
  assert.equal(
    (await check("t:9")).C14.length,
    1,
    "a missing container cannot match neighbouring text",
  );
});

test("C12/C14 distinguish missing, malformed, unavailable and exact source/response addresses", async () => {
  const bytes = await workflowTemplate();
  const item = {
    id: "req-1",
    kind: "实质性条款",
    text: "固定责任",
    quote: "固定责任条款：资料按真实原件提供，禁止篡改。",
    source: { file: "tender/1.docx", address: "p:1" },
    mustRespond: true,
    responses: [{ draft: "商务", address: "p:6" }],
  };
  const sources = new Map([["tender/1.docx", bytes]]),
    drafts = new Map([["商务", bytes]]);
  assert.deepEqual(
    await checkRequirements({ kind: "missing" }, sources, drafts),
    { C12: [], C14: [] },
  );
  for (const raw of [
    "{",
    "{}",
    '{"format":"seal-requirements-1","items":[{}]}',
  ]) {
    const result = await checkRequirements(
      parseRequirements(raw),
      sources,
      drafts,
    );
    assert.equal(result.C12.length, 1);
    assert.equal(result.C14.length, 1);
  }
  const state = (changes: object = {}) =>
    parseRequirements(
      JSON.stringify({
        format: "seal-requirements-1",
        items: [{ ...item, ...changes }],
      }),
    );
  assert.deepEqual(await checkRequirements(state(), sources, drafts), {
    C12: [],
    C14: [],
  });
  assert.equal(
    (await checkRequirements(state({ responses: [] }), sources, drafts)).C12
      .length,
    1,
  );
  assert.equal(
    (
      await checkRequirements(
        state({ responses: [{ draft: "商务", address: "p:999" }] }),
        sources,
        drafts,
      )
    ).C12.length,
    1,
  );
  assert.equal(
    (
      await checkRequirements(
        state({ source: { file: "tender/1.docx", address: "p:0" } }),
        sources,
        drafts,
      )
    ).C14.length,
    1,
    "the sixth neighbouring block is outside the quote window",
  );
  assert.equal(
    (
      await checkRequirements(
        state({ quote: item.quote.replace("禁止", "允许") }),
        sources,
        drafts,
      )
    ).C14.length,
    1,
  );
  assert.equal(
    (await checkRequirements(state(), new Map(), drafts)).C14.length,
    1,
  );
  assert.equal(
    (
      await checkRequirements(
        state(),
        new Map([["tender/1.docx", new Uint8Array()]]),
        drafts,
      )
    ).C14.length,
    1,
  );
});

test("project readiness uses every untruncated volume and typed C08 expiry", () => {
  const first = {
    draft: "甲",
    complete: true,
    limitations: [],
    results: emptyResults(),
  };
  const second = {
    draft: "乙",
    complete: true,
    limitations: [],
    results: emptyResults(),
  };
  second.results.C08.push(
    ...Array.from({ length: 50 }, () => ({ validity: "expiring_soon" })),
  );
  assert.equal(completeProjectCheck([first, second]).ready, true);
  second.results.C08.push({ validity: "expired" });
  const report = completeProjectCheck([first, second]);
  assert.equal(report.ready, false);
  assert.equal(report.counts.C08, 51);
  assert.equal(report.blockingCounts.C08, 1);
  assert.equal(completeProjectCheck([]).ready, false);
  for (const code of Object.keys(emptyResults())) {
    const results = emptyResults();
    results[code as keyof typeof results].push({ validity: "expired" });
    assert.equal(
      completeProjectCheck([{ ...first, results }]).ready,
      false,
      code,
    );
  }
  assert.equal(
    completeProjectCheck([{ ...first, complete: false }]).ready,
    false,
  );
});

test("C13 ignores bare scale nouns and matches Arabic 万/亿 units with exact BigInt decimal math", () => {
  for (const text of [
    "2025 项目A 280万元(合成) 签署日 2025-04-10",
    "投标价（万元）：280 亿元 万圆 亿圆 佰元 仟元 佰万元 2025",
    "280万元，大写：贰佰捌拾万元整",
    "项目金额 2025年 280万元 贰佰捌拾万元整",
    "128.5 万元（壹佰贰拾捌万伍仟元整）",
    "人民币 128.5 万元，壹佰贰拾捌万伍仟元正",
    "128.5678万元，壹佰贰拾捌万伍仟陆佰柒拾捌元整",
    "￥280.5678万元，贰佰捌拾万伍仟陆佰柒拾捌元整",
    "1.25亿元，壹亿贰仟伍佰万元整",
    "280 萬圓，贰佰捌拾万元整",
    "1.25 億圆，壹亿贰仟伍佰万元整",
    "人数280万人，单价贰元整（2元）",
    "人数 280 万人，单价 贰元整 2元",
    "人数280万次，单价贰元整",
    "1.000元，壹元整",
  ]) {
    assert.deepEqual(checkMoney([{ address: "p:0", text }]), [], text);
  }

  for (const text of [
    "280万元，叁佰万元整",
    "2025年 280万元 叁佰万元整",
    "128.5678万元，壹佰贰拾捌万伍仟陆佰柒拾玖元整",
    "128.567801万元，壹佰贰拾捌万伍仟陆佰柒拾捌元整",
    "128.5678万元，壹佰贰拾捌万伍仟陆佰柒拾捌元零壹分",
    "1.2501亿元，壹亿贰仟伍佰万元整",
    "1.005元，壹元整",
    "人民币1.005，壹元整",
    "￥1.005万元，壹万元整",
  ]) {
    const issues = checkMoney([{ address: "p:0", text }]);
    assert.equal(issues.length, 1, text);
    assert.equal(issues[0].reason, "中文大写金额与阿拉伯数字金额不一致", text);
  }

  for (const invalid of [
    "万元",
    "亿元",
    "万圆",
    "亿圆",
    "佰元",
    "仟元",
    "佰万元",
    "壹万万元",
    "壹拾佰元",
    "壹亿万零壹元",
    "壹贰元",
    "壹零元",
    "壹佰零拾元",
    "壹佰零零伍元",
    "壹佰贰仟元",
    "壹佰贰佰元",
    "壹拾贰拾元",
  ]) {
    assert.throws(() => chineseMoneyCents(invalid), /中文金额语法无法确定核对/, invalid);
  }

  for (const text of [
    "2元，大写壹贰元整",
    "10元，大写壹零元整",
    "100元，大写壹佰零拾元整",
    "105元，大写壹佰零零伍元整",
    "2100元，大写壹佰贰仟元整",
    "300元，大写壹佰贰佰元整",
    "30元，大写壹拾贰拾元整",
  ]) {
    const issues = checkMoney([{ address: "p:0", text }]);
    assert.equal(issues.length, 1, text);
    assert.equal(issues[0].reason, "中文金额语法无法确定核对", text);
  }
});

test("C12/C14 parse large document once across 100 requirements in under 500ms", async () => {
  const blockCount = 400;
  const sourceBody = Array.from({ length: blockCount }, (_, i) =>
    paragraph(`招标要求第${i}条：投标人须满足第${i}项技术与商务指标要求。`),
  ).join("");
  const draftBody = Array.from({ length: blockCount }, (_, i) =>
    paragraph(`投标响应第${i}条：我方完全响应第${i}项技术与商务指标要求。`),
  ).join("");
  const [sourceBytes, draftBytes] = await Promise.all([
    packageDocument(sourceBody),
    packageDocument(draftBody),
  ]);
  const sources = new Map([["tender/large.docx", sourceBytes]]);
  const drafts = new Map([["商务", draftBytes]]);
  const items = Array.from({ length: 100 }, (_, i) => {
    const blockIndex = i * 3;
    return {
      id: `req-${i}`,
      kind: "实质性条款",
      text: `第${blockIndex}项要求`,
      quote: `招标要求第${blockIndex}条：投标人须满足第${blockIndex}项技术与商务指标要求。`,
      source: { file: "tender/large.docx", address: `p:${blockIndex}` },
      mustRespond: true,
      responses: [{ draft: "商务", address: `p:${blockIndex}` }],
    };
  });
  const state = parseRequirements(
    JSON.stringify({ format: "seal-requirements-1", items }),
  );

  const batchStart = performance.now();
  const batch = await validateRequirementsBatch(items, sources);
  const batchMs = performance.now() - batchStart;
  assert.deepEqual(batch.errors, []);
  assert.equal(batch.items.length, 100);
  assert.ok(batchMs < 500, `validateRequirementsBatch took ${batchMs.toFixed(1)}ms`);

  const checkStart = performance.now();
  const checked = await checkRequirements(state, sources, drafts);
  const checkMs = performance.now() - checkStart;
  assert.deepEqual(checked, { C12: [], C14: [] });
  assert.ok(checkMs < 500, `checkRequirements took ${checkMs.toFixed(1)}ms`);

  const brokenItems = items.map((item, index) =>
    index === 99 ? { ...item, quote: "不存在的引文内容" } : item,
  );
  const brokenState = parseRequirements(
    JSON.stringify({ format: "seal-requirements-1", items: brokenItems }),
  );
  const brokenChecked = await checkRequirements(brokenState, sources, drafts);
  assert.equal(brokenChecked.C12.length, 0);
  assert.equal(brokenChecked.C14.length, 1);
  assert.equal(brokenChecked.C14[0].id, "req-99");
});
