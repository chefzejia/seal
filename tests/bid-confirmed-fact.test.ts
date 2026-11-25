import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NodeHostPort } from "../src/shells/node-host.js";
import { KnowledgeBase } from "../src/core/kb/index.js";
import { runProject } from "../src/shells/cli/project-v2.js";
import { confirmPending } from "../src/core/bid/human-review.js";
import { sealLedger } from "../src/core/bid/ledger-integrity.js";
import { validatePackageStructure } from "../src/core/docx/package-structure.js";
import { workflowTemplate } from "./fixtures/workflow-template.js";

test("current human P confirmation clears unverified C05 but never changed or missing sources", async (t) => {
  const home = path.resolve(".tmp", `review-fact-${randomUUID()}`),
    root = path.join(home, "project");
  const previous = process.env.SEAL_HOME;
  process.env.SEAL_HOME = home;
  await fs.mkdir(home, { recursive: true });
  t.after(async () => {
    if (previous === undefined) delete process.env.SEAL_HOME;
    else process.env.SEAL_HOME = previous;
    await fs.rm(home, { recursive: true, force: true });
  });
  const host = new NodeHostPort(),
    kb = new KnowledgeBase(host, path.join(home, "vaults"));
  await kb.createVault({ vaultId: "synthetic", name: "合成核实库" });
  await kb.save("synthetic", {
    action: "update",
    kind: "subject",
    fields: { legalName: "合成单位" },
  });
  const source = path.join(home, "source.docx");
  await fs.writeFile(source, await workflowTemplate());
  await runProject(host, [
    "init",
    "--root",
    root,
    "--name",
    "核实闭环",
    "--deadline",
    "2028-02-29",
    "--vault",
    "synthetic",
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
    '[{"from":"p:2","to":"p:2"}]',
  ]);
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
        find: "________",
        value: "{{subject.legalName}}",
      },
    ]),
  ]);
  const check = async () =>
    (await runProject(host, [
      "check",
      "--project",
      root,
      "--draft",
      "商务",
    ])) as { counts: Record<string, number> };
  assert.ok((await check()).counts.C05 > 0);
  const file = path.join(root, "ledger.json"),
    ledger = JSON.parse(await fs.readFile(file, "utf8"));
  const key = (await host.authorizationKey(true))!;
  const xml = new TextDecoder().decode(
    (
      await validatePackageStructure(
        await fs.readFile(path.join(root, "draft/商务.docx")),
      )
    ).get("word/document.xml"),
  );
  await confirmPending(
    ledger,
    "商务",
    ledger.pending[0].id,
    xml,
    { root, vaultId: "synthetic", deadline: "2028-02-29" },
    key,
  );
  await sealLedger(ledger, root, key);
  await host.writeFiles([
    { path: file, data: new TextEncoder().encode(JSON.stringify(ledger)) },
    {
      path: await host.ledgerAnchorPath(root, true),
      data: new TextEncoder().encode(JSON.stringify(ledger.integrity)),
    },
  ]);
  assert.equal(
    (await check()).counts.C05,
    0,
    "a valid human confirmation covers current unverified facts",
  );
  await kb.save("synthetic", {
    action: "update",
    kind: "subject",
    fields: { legalName: "已变更单位" },
  });
  assert.ok(
    (await check()).counts.C05 > 0,
    "a changed source remains blocking after confirmation",
  );
});
