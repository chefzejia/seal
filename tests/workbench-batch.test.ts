import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NodeHostPort } from "../src/shells/node-host.js";
import { WorkbenchHost } from "../src/shells/dsh/workbench-host.js";
import { runProject } from "../src/shells/cli/project-v2.js";
import { packageDocument, paragraph } from "./fixtures/layout-matrix.js";

test("owner groups span every page and bracket acceptance never accepts ordinary changes", async (t) => {
  const home = path.resolve(".tmp", `review-batch-${randomUUID()}`),
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
    source = path.join(home, "source.docx");
  await fs.writeFile(
    source,
    await packageDocument(
      Array.from({ length: 51 }, () => paragraph("报价：____")).join("") +
        paragraph("说明（格式自拟）") +
        paragraph("固定原文内容"),
    ),
  );
  const created = await service.create({
      name: "合成批量审阅",
      deadline: "2028-02-29",
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
    '[{"from":"p:0","to":"p:52"}]',
  ]);
  await runProject(host, [
    "edit",
    "--project",
    root,
    "--draft",
    "甲",
    "--ops",
    JSON.stringify(
      Array.from({ length: 51 }, (_, index) => ({
        op: "replace",
        at: `p:${index}`,
        find: "____",
        value: "合成单位",
      })),
    ),
  ]);
  const load = async () => {
    const value = await service.review({ projectId: created.id });
    if (value.kind !== "project") throw new Error("project expected");
    return value;
  };
  let review = await load();
  const group = review.groups.find((group) => group.id.startsWith("pending:"))!;
  assert.equal(group.count, 51);
  assert.equal(group.items.length, 25);
  const saved = await service.act({
    projectId: created.id,
    revision: review.revision,
    group: group.id,
    action: "confirm",
  });
  assert.ok("processed" in saved);
  assert.equal(saved.processed, 51);
  review = await load();
  assert.equal(review.counts.C04, 0);
  const ledger = JSON.parse(
    await fs.readFile(path.join(root, "ledger.json"), "utf8"),
  );
  assert.ok(
    ledger.pending.every(
      (item: any) => item.status === "confirmed" && item.confirmation,
    ),
  );
  assert.equal(
    new Set(ledger.pending.map((item: any) => item.confirmation.signature))
      .size,
    51,
  );
  await runProject(host, [
    "edit",
    "--project",
    root,
    "--draft",
    "甲",
    "--ops",
    JSON.stringify([
      { op: "replace", at: "p:51", find: "格式自拟", value: "合成说明" },
      {
        op: "replace",
        at: "p:52",
        find: "固定原文内容",
        value: "已修改原文内容",
      },
    ]),
  ]);
  review = await load();
  const bracket = review.groups.find((group) => group.id === "bracketText");
  assert.ok(
    bracket,
    "the bracket category remains available after exact pending/change merging",
  );
  assert.equal(bracket.count, 1);
  const before = review.counts.C06;
  const normal = review.groups
    .flatMap((group) => group.items)
    .find((row) => row.differenceIds.length && row.group !== "bracketText")!;
  await assert.rejects(
    service.act({
      projectId: created.id,
      revision: review.revision,
      group: normal.group,
      action: "accept",
    }),
    /批量/,
  );
  await service.act({
    projectId: created.id,
    revision: review.revision,
    group: "bracketText",
    action: "accept",
  });
  review = await load();
  assert.equal(review.counts.C06, before - 1);
  assert.ok(
    review.groups
      .flatMap((group) => group.items)
      .some((row) => row.differenceIds.length && row.group !== "bracketText"),
  );
});
