import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NodeHostPort } from "../src/shells/node-host.js";
import {
  KnowledgeBase,
  parseEntry,
  serializeEntry,
} from "../src/core/kb/index.js";
import { WorkbenchHost } from "../src/shells/dsh/workbench-host.js";
import { runProject } from "../src/shells/cli/project-v2.js";
import { workflowTemplate } from "./fixtures/workflow-template.js";

test("human confirmation never bypasses deleted, expired, wrong-holder or invalidly signed evidence", async (t) => {
  const home = path.resolve(".tmp", `confirmed-sources-${randomUUID()}`),
    previous = process.env.SEAL_HOME;
  process.env.SEAL_HOME = home;
  await fs.mkdir(home, { recursive: true });
  t.after(async () => {
    if (previous === undefined) delete process.env.SEAL_HOME;
    else process.env.SEAL_HOME = previous;
    await fs.rm(home, { recursive: true, force: true });
  });
  const host = new NodeHostPort(),
    service = new WorkbenchHost(host),
    kb = new KnowledgeBase(host, path.join(home, "vaults"));
  await kb.createVault({ vaultId: "sources", name: "合成来源库" });
  await kb.save("sources", {
    action: "update",
    kind: "subject",
    fields: { legalName: "合成单位" },
  });
  const record = await kb.save("sources", {
    action: "create",
    kind: "record",
    fields: {
      type: "资质证书",
      title: "合成证书",
      holder: "合成单位",
      number: "SYN-001",
      validUntil: "长期",
    },
  });
  const source = path.join(home, "source.docx");
  await fs.writeFile(source, await workflowTemplate());
  const created = await service.create({
      name: "证据确认负控",
      deadline: "2028-02-29",
      vaultId: "sources",
      files: [source],
    }),
    root = created.root;
  await runProject(host, [
    "extract",
    "--project",
    root,
    "--tender",
    "tender/1.docx",
    "--draft",
    "甲",
    "--ranges",
    '[{"from":"p:2","to":"p:2"}]',
  ]);
  await runProject(host, [
    "edit",
    "--project",
    root,
    "--draft",
    "甲",
    "--ops",
    JSON.stringify([
      {
        op: "replace",
        at: "p:0",
        find: "________",
        value: `{{record:${record.id}.number}}`,
      },
    ]),
  ]);
  const review = await service.review({ projectId: created.id });
  if (review.kind !== "project") throw new Error("project expected");
  const row = review.groups
    .flatMap((group) => group.items)
    .find((row) => row.pendingIds.length)!;
  await service.act({
    projectId: created.id,
    revision: review.revision,
    keys: [row.key],
    action: "confirm",
  });
  const check = async () =>
    (await runProject(host, [
      "check",
      "--project",
      root,
      "--draft",
      "甲",
    ])) as any;
  assert.equal((await check()).counts.C05, 0);
  const changeRecord = (fields: Record<string, unknown>) =>
    kb.save("sources", {
      action: "update",
      kind: "record",
      id: record.id,
      fields,
    });
  await changeRecord({ validUntil: "2027-01-01" });
  assert.ok((await check()).counts.C05 > 0);
  assert.ok((await check()).counts.C08 > 0);
  await changeRecord({ validUntil: "长期", holder: "其他单位" });
  assert.ok((await check()).counts.C05 > 0);
  await changeRecord({ holder: "禁用单位" });
  await kb.save("sources", {
    action: "update",
    kind: "subject",
    fields: { forbiddenAffiliates: ["禁用单位"] },
  });
  assert.ok((await check()).counts.C05 > 0);
  await kb.save("sources", {
    action: "update",
    kind: "subject",
    fields: { forbiddenAffiliates: [] },
  });
  await changeRecord({ holder: "合成单位" });
  assert.equal((await check()).counts.C05, 0);
  await kb.verify("sources", "record", record.id);
  const file = path.join(
      home,
      "vaults",
      "sources",
      "records",
      `${record.id}.md`,
    ),
    raw = parseEntry(await fs.readFile(file, "utf8"));
  raw.fields.__sealVerification = "{}";
  await fs.writeFile(file, serializeEntry(raw.fields, raw.body));
  assert.ok(
    (await check()).counts.C05 > 0,
    "an invalid verification signature is a hard source problem",
  );
  await kb.save("sources", { action: "delete", kind: "record", id: record.id });
  assert.ok((await check()).counts.C05 > 0);
});
