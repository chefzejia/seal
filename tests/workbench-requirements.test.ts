import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NodeHostPort } from "../src/shells/node-host.js";
import {
  WorkbenchHost,
  registerWorkbenchRoutes,
} from "../src/shells/dsh/workbench-host.js";
import { runProject } from "../src/shells/cli/project-v2.js";
import {
  buildBidStartupPrompt,
  buildRequirementsView,
} from "../src/workbench/requirements.js";
import { packageDocument, paragraph } from "./fixtures/layout-matrix.js";

test("WorkbenchHost requirements & owner cover enforce revision preflight, host re-read and route isolation", async (t) => {
  const home = path.resolve(".tmp", `wb-req-${randomUUID()}`),
    previous = process.env.SEAL_HOME;
  process.env.SEAL_HOME = home;
  await fs.mkdir(home, { recursive: true });
  t.after(async () => {
    if (previous === undefined) delete process.env.SEAL_HOME;
    else process.env.SEAL_HOME = previous;
    await fs.rm(home, { recursive: true, force: true });
  });

  const host = new NodeHostPort();
  const service = new WorkbenchHost(host);
  const source = path.join(home, "source.docx");
  await fs.writeFile(
    source,
    await packageDocument(
      [
        paragraph("第一章 资格要求"),
        paragraph("必须提供安全生产许可证。"),
        paragraph("第二章 响应内容"),
        paragraph("已附有效安全生产许可证及说明。"),
        paragraph("空白段落"),
      ].join(""),
    ),
  );

  const created = await service.create({
    name: "工作台要求测试",
    deadline: "2028-12-31",
    files: [source],
  });
  const root = created.root;

  // Missing state before requirements.json is saved.
  const missingView = (await service.requirements({
    projectId: created.id,
  })) as any;
  assert.equal(missingView.projectKind, "project");
  assert.equal(missingView.kind, "missing");

  await runProject(host, [
    "extract",
    "--project",
    root,
    "--tender",
    "tender/1.docx",
    "--draft",
    "商务",
    "--ranges",
    JSON.stringify([{ from: "p:2", to: "p:3" }]),
  ]);

  const items = [
    {
      id: "req-safety",
      kind: "资格要求",
      text: "具备安全生产许可证",
      quote: "必须提供安全生产许可证。",
      source: { file: "tender/1.docx", address: "p:1" },
      mustRespond: true,
      responses: [],
    },
    {
      id: "req-format",
      kind: "格式要求",
      text: "按格式编制",
      quote: "第一章 资格要求",
      source: { file: "tender/1.docx", address: "p:0" },
      mustRespond: false,
      responses: [],
    },
  ];
  await runProject(host, [
    "requirements",
    "--project",
    root,
    "--action",
    "save",
    "--items",
    JSON.stringify(items),
  ]);

  let reqView = (await service.requirements({
    projectId: created.id,
    offset: 0,
    limit: 1,
  })) as any;
  assert.equal(reqView.kind, "value");
  assert.equal(reqView.total, 2);
  assert.equal(reqView.items.length, 1);
  assert.equal(reqView.nextOffset, 1);
  assert.equal(reqView.summary.c12Gaps, 1);
  assert.equal(reqView.summary.covered, 0);
  assert.equal(reqView.items[0].id, "req-safety");
  assert.equal(reqView.items[0].c12Issues.length, 1);

  const ledgerBefore = await fs.readFile(path.join(root, "ledger.json"));

  // Client cannot inject arbitrary requirement/response/authorization/covered fields.
  for (const forbidden of [
    { requirement: "任意要求" },
    { response: "任意响应" },
    { authorization: { signature: "0".repeat(64) } },
    { covered: true },
  ]) {
    await assert.rejects(
      service.cover({
        projectId: created.id,
        expectedRevision: reqView.revision,
        id: "req-safety",
        draft: "商务",
        address: "p:1",
        ...forbidden,
      }),
      /宿主重读实际内容签名/,
    );
  }

  // Stale revision is rejected without mutating ledger.json.
  await assert.rejects(
    service.cover({
      projectId: created.id,
      expectedRevision: "stale-rev",
      id: "req-safety",
      draft: "商务",
      address: "p:1",
    }),
    /版本冲突/,
  );
  assert.deepEqual(await fs.readFile(path.join(root, "ledger.json")), ledgerBefore);

  // Invalid address fails cleanly.
  await assert.rejects(
    service.cover({
      projectId: created.id,
      expectedRevision: reqView.revision,
      id: "req-safety",
      draft: "商务",
      address: "p:99",
    }),
  );

  // Owner marks coverage via HTTP action route; Host re-reads actual block and seals ledger + anchor.
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
  const actionRoute = routes.find((route) => route.path === "/api/seal/action")!;

  const conflictRes = await actionRoute.fetch(
    new Request("http://owner/api/seal/action", {
      method: "POST",
      body: JSON.stringify({
        operation: "cover",
        projectId: created.id,
        expectedRevision: "wrong",
        id: "req-safety",
        draft: "商务",
        address: "p:1",
      }),
    }),
  );
  assert.equal(conflictRes.status, 409);

  const coverRes = await actionRoute.fetch(
    new Request("http://owner/api/seal/action", {
      method: "POST",
      body: JSON.stringify({
        operation: "cover",
        projectId: created.id,
        expectedRevision: reqView.revision,
        id: "req-safety",
        draft: "商务",
        address: "p:1",
      }),
    }),
  );
  assert.equal(coverRes.status, 200);
  assert.equal((await coverRes.json()).saved, true);

  // After owner coverage, requirements view & review readiness both reflect C12=0 and ready=true.
  const listRes = await actionRoute.fetch(
    new Request("http://owner/api/seal/action", {
      method: "POST",
      body: JSON.stringify({
        operation: "requirements",
        projectId: created.id,
        offset: 0,
        limit: 25,
      }),
    }),
  );
  assert.equal(listRes.status, 200);
  reqView = await listRes.json();
  assert.equal(reqView.summary.c12Gaps, 0);
  assert.equal(reqView.summary.covered, 1);
  assert.equal(reqView.items[0].coverage.status, "covered");
  assert.equal(reqView.items[0].coverage.draft, "商务");
  assert.equal(reqView.items[0].coverage.address, "p:1");
  assert.equal(
    reqView.items[0].coverage.response,
    "已附有效安全生产许可证及说明。",
  );

  const review = (await service.review({ projectId: created.id })) as any;
  assert.equal(review.blockingCounts.C12, 0);
  assert.equal(review.ready, true);

  // External draft modification blocks WorkbenchHost.cover from issuing a coverage mark.
  const draftPath = path.join(root, "draft/商务.docx");
  const draftBytes = await fs.readFile(draftPath);
  await fs.writeFile(draftPath, Buffer.concat([draftBytes, Buffer.from(" ")]));
  const tamperedView = (await service.requirements({
    projectId: created.id,
  })) as any;
  const ledgerBeforeTamperReject = await fs.readFile(path.join(root, "ledger.json"));
  await assert.rejects(
    service.cover({
      projectId: created.id,
      expectedRevision: tamperedView.revision,
      id: "req-safety",
      draft: "商务",
      address: "p:1",
    }),
    /Seal 之外/,
  );
  assert.deepEqual(
    await fs.readFile(path.join(root, "ledger.json")),
    ledgerBeforeTamperReject,
  );
});

test("pure requirements view model and startup prompt builder cover all states", () => {
  assert.deepEqual(
    buildRequirementsView({
      state: { kind: "missing" },
      c12: [],
      c14: [],
      validMarks: [],
      expiredIds: [],
      drafts: ["商务"],
    }),
    { kind: "missing", drafts: ["商务"] },
  );

  assert.deepEqual(
    buildRequirementsView({
      state: { kind: "error", reason: "JSON 解析错误" },
      c12: [],
      c14: [],
      validMarks: [],
      expiredIds: [],
      drafts: [],
    }),
    { kind: "error", reason: "JSON 解析错误", drafts: [] },
  );

  const view = buildRequirementsView({
    state: {
      kind: "value",
      items: [
        {
          id: "r1",
          kind: "评分项",
          text: "技术方案",
          quote: "评分标准",
          source: { file: "tender/1.docx", address: "p:10" },
          mustRespond: true,
          points: 20,
          responses: [],
        },
        {
          id: "r2",
          kind: "资格要求",
          text: "执照",
          quote: "营业执照",
          source: { file: "tender/1.docx", address: "p:2" },
          mustRespond: true,
          responses: [{ draft: "商务", address: "p:1" }],
        },
      ],
    },
    c12: [{ id: "r1", reason: "必须响应的要求没有响应位置" }],
    c14: [{ id: "r2", address: "p:2", reason: "要求引文未出现在来源块或前后五块" }],
    validMarks: [],
    expiredIds: ["r1"],
    drafts: ["商务", "技术"],
    offset: 0,
    limit: 1,
  });
  assert.equal(view.kind, "value");
  if (view.kind !== "value") throw new Error("value expected");
  assert.equal(view.total, 2);
  assert.equal(view.nextOffset, 1);
  assert.equal(view.summary.c12Gaps, 1);
  assert.equal(view.summary.c14Errors, 1);
  assert.equal(view.summary.expired, 1);
  assert.equal(view.items[0].coverage.status, "expired");

  const withVault = buildBidStartupPrompt({
    name: "电梯采购",
    deadline: "2028-06-01",
    vaultId: "vault-main",
    tenders: [{ copy: "tender/1.docx" }],
  });
  assert.match(withVault, /skill/);
  assert.match(withVault, /seal-bid/);
  assert.match(withVault, /tender\/1\.docx/);
  assert.match(withVault, /2028-06-01/);
  assert.match(withVault, /vault-main/);

  const withoutVault = buildBidStartupPrompt({
    name: "无库项目",
    deadline: "2028-06-01",
    vaultId: null,
    tenders: [{ copy: "tender/1.docx" }],
  });
  assert.match(withoutVault, /无库模式/);
  assert.match(withoutVault, /seal-bid/);
});
