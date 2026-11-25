import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NodeHostPort } from "../src/shells/node-host.js";
import { KnowledgeBase } from "../src/core/kb/index.js";
import { WorkbenchHost } from "../src/shells/dsh/workbench-host.js";

test("knowledge catalogue includes materials and continues every health issue", async (t) => {
  const home = path.resolve(".tmp", `kb-workbench-${randomUUID()}`);
  const previous = process.env.SEAL_HOME;
  process.env.SEAL_HOME = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.SEAL_HOME;
    else process.env.SEAL_HOME = previous;
    await fs.rm(home, { recursive: true, force: true });
  });
  const host = new NodeHostPort(),
    kb = new KnowledgeBase(host, path.join(home, "vaults")),
    service = new WorkbenchHost(host);
  await kb.createVault({ vaultId: "catalogue", name: "合成资料库" });
  await kb.save("catalogue", {
    action: "update",
    kind: "subject",
    fields: { legalName: "合成单位" },
  });
  for (let index = 0; index < 27; index++)
    await kb.save("catalogue", {
      action: "create",
      kind: "material",
      fields: { title: `素材${index}`, unknownField: "显式诊断" },
      body: `可检索正文${index}`,
    });
  const first = (await service.kb({
    action: "catalog",
    vaultId: "catalogue",
  })) as any;
  assert.equal(first.count, 27);
  assert.equal(first.items.length, 25);
  assert.ok(first.items.every((item: any) => item.kind === "material"));
  const second = (await service.kb({
    action: "catalog",
    vaultId: "catalogue",
    offset: first.nextOffset,
  })) as any;
  assert.equal(
    new Set([...first.items, ...second.items].map((item: any) => item.id)).size,
    27,
  );
  const issues = [...first.issues];
  let offset = first.nextIssueOffset;
  while (offset !== null) {
    const page = (await service.kb({
      action: "catalog",
      vaultId: "catalogue",
      issueOffset: offset,
    })) as any;
    issues.push(...page.issues);
    offset = page.nextIssueOffset;
  }
  assert.equal(issues.length, first.issueCount);
  assert.equal(
    issues.filter((issue: any) => issue.kind === "material").length,
    27,
  );
  const detail = (await service.kb({
    action: "detail",
    vaultId: "catalogue",
    kind: "material",
    id: first.items[0].id,
  })) as any;
  await assert.rejects(
    service.kb({
      action: "save",
      vaultId: "catalogue",
      revision: "stale",
      data: {
        action: "update",
        kind: "material",
        id: detail.entry.id,
        body: "覆盖",
      },
    }),
    /版本冲突/,
  );
  await assert.rejects(
    service.kb({ action: "catalog", vaultId: "catalogue", issueOffset: -1 }),
    /分页/,
  );
});
