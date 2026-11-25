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
import { workflowTemplate } from "./fixtures/workflow-template.js";

test("owner workbench preflights a whole batch and rejects stale versions without partial persistence", async (t) => {
  const home = path.resolve(".tmp", `workbench-${randomUUID()}`),
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
  await fs.writeFile(source, await workflowTemplate());
  const created = await service.create({
    name: "人工事务",
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
    "商务",
    "--ranges",
    '[{"from":"p:2","to":"p:3"}]',
  ]);
  const edit = async (find: string, value: string) =>
    runProject(host, [
      "edit",
      "--project",
      root,
      "--draft",
      "商务",
      "--ops",
      JSON.stringify([{ op: "replace", at: "p:1", find, value }]),
    ]);
  await edit("________", "合成单位");
  let review = await service.review({ projectId: created.id });
  assert.equal(review.kind, "project");
  if (review.kind !== "project") throw new Error("project expected");
  const rows = review.groups!.flatMap((group) => group.items),
    row = rows.find((row) => row.actions.includes("confirm"))!;
  const ledgerPath = path.join(root, "ledger.json"),
    before = await fs.readFile(ledgerPath);
  await assert.rejects(
    service.act({
      projectId: created.id,
      revision: review.revision,
      keys: [row.key, "forged"],
      action: "confirm",
    }),
    /失效/,
  );
  assert.deepEqual(await fs.readFile(ledgerPath), before);
  await service.act({
    projectId: created.id,
    revision: review.revision,
    keys: [row.key],
    action: "confirm",
  });
  review = await service.review({ projectId: created.id });
  if (review.kind !== "project") throw new Error("project expected");
  assert.equal(review.counts.C04, 0);
  assert.equal(review.counts!.C05, 0);
  const confirmed = await fs.readFile(ledgerPath);
  await assert.rejects(
    service.act({
      projectId: created.id,
      revision: "stale",
      keys: [row.key],
      action: "confirm",
    }),
    /版本冲突/,
  );
  assert.deepEqual(await fs.readFile(ledgerPath), confirmed);
  await edit("合成单位", "当前单位");
  review = await service.review({ projectId: created.id });
  if (review.kind !== "project") throw new Error("project expected");
  assert.ok(review.counts.C04 > 0);
  for (const action of [
    "confirm",
    "accept",
    "acknowledge",
    "verify",
    "finalize",
  ])
    await assert.rejects(
      runProject(host, [action, "--project", root, "--draft", "商务"]),
      /支持的 project 命令/,
    );
  assert.deepEqual(
    await fs.readFile(source),
    Buffer.from(await workflowTemplate()),
    "the original input remains byte-identical",
  );
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
  assert.equal(routes.length, 4);
  const route = routes.find((route) => route.path === "/api/seal/action")!;
  const unsupported = await route.fetch(
    new Request("http://owner/api/seal/action", {
      method: "POST",
      body: JSON.stringify({ operation: "arbitrary_file_write", human: true }),
    }),
  );
  assert.equal(unsupported.status, 400);
});
