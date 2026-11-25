import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = path.join(root, "dist");
const PACKAGE_NAME_RE =
  /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const packageName = process.env.SEAL_NPM_PACKAGE?.trim() || "seal-dsh";
if (packageName.length > 214 || !PACKAGE_NAME_RE.test(packageName)) {
  throw new Error(`Invalid SEAL_NPM_PACKAGE: ${JSON.stringify(packageName)}`);
}
const git = (...args) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
const common = git("rev-parse", "--path-format=absolute", "--git-common-dir");
const reservations = path.join(common, "seal-build-versions");
fs.mkdirSync(reservations, { recursive: true });
const worktrees = git("worktree", "list", "--porcelain", "-z")
  .split("\0")
  .filter((item) => item.startsWith("worktree "))
  .map((item) => item.slice(9));
const patches = fs.readdirSync(reservations).flatMap((file) => {
  const match = /^0\.1\.(\d+)$/.exec(file);
  return match ? [Number(match[1])] : [];
});
for (const directory of new Set([
  releaseDir,
  ...worktrees.map((worktree) => path.join(worktree, "dist")),
])) {
  let files;
  try {
    files = fs.readdirSync(directory);
  } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }
  for (const file of files) {
    const match = /^seal-dsh-0\.1\.(\d+)\.tgz$/.exec(file);
    if (match) patches.push(Number(match[1]));
  }
}
let patch = Math.max(0, ...patches) + 1;
let allocation;
for (;;) {
  if (!Number.isSafeInteger(patch))
    throw new Error("Bundle patch version exhausted");
  allocation = path.join(reservations, `0.1.${patch}`);
  try {
    fs.mkdirSync(allocation);
    break;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    patch++;
  }
}
const version = `0.1.${patch}`;
const artifact = path.join(releaseDir, `seal-dsh-${version}.tgz`);
const reservation = fs.openSync(path.join(allocation, "allocation.json"), "wx");
try {
  fs.writeFileSync(
    reservation,
    JSON.stringify(
      {
        version,
        root,
        artifact,
        pid: process.pid,
        allocatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  fs.fsyncSync(reservation);
} finally {
  fs.closeSync(reservation);
}
// An allocated version is never removed, including when compilation or packing fails.
const directory = fs.openSync(reservations, "r");
try {
  fs.fsyncSync(directory);
} finally {
  fs.closeSync(directory);
}
fs.mkdirSync(releaseDir, { recursive: true });
fs.mkdirSync(path.join(root, ".tmp"), { recursive: true });
const scratch = fs.mkdtempSync(path.join(root, ".tmp/dsh-build-"));
try {
  const destination = path.join(scratch, "package");
  fs.mkdirSync(destination);
  const config = path.join(scratch, "tsconfig.json");
  fs.writeFileSync(
    config,
    JSON.stringify({
      extends: path.join(root, "tsconfig.json"),
      compilerOptions: {
        outDir: path.join(destination, "lib"),
        rootDir: path.join(root, "src"),
      },
      include: [path.join(root, "src/**/*.ts")],
    }),
  );
  execFileSync(
    process.execPath,
    [path.join(root, "node_modules/typescript/bin/tsc"), "-p", config],
    { stdio: "inherit" },
  );
  await build({
    entryPoints: [path.join(root, "src/shells/dsh/client.ts")],
    outfile: path.join(destination, "lib/client.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2022",
    define: {
      __SEAL_VERSION__: JSON.stringify(version),
      __SEAL_PACKAGE_NAME__: JSON.stringify(packageName),
    },
  });
  fs.writeFileSync(
    path.join(destination, "lib/index.js"),
    'export * from "./shells/dsh/index.js";\n',
  );
  fs.copyFileSync(
    path.join(root, "README.md"),
    path.join(destination, "README.md"),
  );
  fs.writeFileSync(
    path.join(destination, "package.json"),
    JSON.stringify(
      {
        name: packageName,
        version,
        description: "Seal — 证据驱动文档装配与核验工作台（DSH 原生插件）",
        author: "Seal Team",
        license: "MIT",
        homepage: "https://github.com/chefzejia/seal#readme",
        repository: {
          type: "git",
          url: "git+https://github.com/chefzejia/seal.git",
        },
        keywords: [
          "dsh",
          "deepseek-harness",
          "seal",
          "docx",
          "office",
          "knowledge-base",
          "bidding",
        ],
        publishConfig: { access: "public" },
        type: "module",
        main: "./lib/index.js",
        exports: {
          ".": "./lib/index.js",
          "./client": "./lib/client.js",
          "./cordis.patch.yml": "./cordis.patch.yml",
          "./package.json": "./package.json",
          "./locale/*.json": "./locale/*.json",
          "./icon": "./icon.svg",
        },
        files: [
          "lib",
          "cordis.patch.yml",
          "locale/*.json",
          "icon.svg",
          "README.md",
        ],
        engines: { dsh: ">=0.2.2-rc.5 <0.3.0", node: ">=22.0.0" },
        dependencies: {
          "@hyzyla/pdfium": "^3.0.0",
          saxes: "6.0.0",
          marked: "^15.0.0",
          "jpeg-js": "^0.4.4",
          sharp: "^0.35.5",
          "bmp-ts": "^1.0.9",
        },
        peerDependencies: {
          "@deepseek-ai/cordis": "~4.1.0",
          "@deepseek-ai/dsh-tools": ">=0.2.2-rc.5 <0.3.0",
        },
        dsh: {
          bundle: { patch: "./cordis.patch.yml" },
          client: { platform: "web", inject: [] },
        },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(destination, "cordis.patch.yml"),
    `- insert:\n    - id: seal-workbench\n      name: '${packageName}'\n`,
  );
  fs.mkdirSync(path.join(destination, "locale"));
  for (const [language, title, description] of [
    [
      "zh",
      "Seal",
      "面向受控 Word/Office 交付的证据驱动文档装配与核验工作台（以招投标为首个端到端场景）：左侧「Seal」全局指挥台提供企业知识库建档与开启项目入口，会话右栏提供审阅清单、页面预览与定稿导出。已内置 MIT 协议 PDFium WASM 引擎，无需配置 Poppler；安装免费官方 LibreOffice 后可解锁 .doc/.xls 导入、页面预览与目录自动回填页码。停用插件后将移除 Seal 工具、审阅工作台与技能，项目及知识库文件仍保留在本地。",
    ],
    [
      "en",
      "Seal",
      "Evidence-backed Word/Office assembly and deterministic verification workbench (with bidding as the first end-to-end workflow): use the Seal sidebar page for knowledge vaults and starting bids, and the right session pane for review, page preview, and final export. Includes built-in MIT PDFium WASM (no Poppler needed); install free official LibreOffice to enable .doc/.xls import, page preview, and automatic TOC page numbers. Disabling the plugin removes Seal tools, panels, and skills while keeping local projects and vaults intact.",
    ],
  ]) {
    fs.writeFileSync(
      path.join(destination, `locale/${language}.json`),
      JSON.stringify({ meta: { title, description } }),
    );
  }
  fs.writeFileSync(
    path.join(destination, "icon.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="5" y="5" width="54" height="54" rx="14" fill="#264766"/><path d="M20 15h18l8 8v27H20z" fill="#f5f1e6"/><path d="M38 15v10h8M25 34l6 6 11-13" fill="none" stroke="#264766" stroke-width="4" stroke-linejoin="round"/></svg>',
  );
  const packed = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", scratch],
      {
        cwd: destination,
        encoding: "utf8",
        env: {
          ...process.env,
          npm_config_cache: path.join(scratch, "npm-cache"),
          npm_config_logs_dir: path.join(scratch, "npm-logs"),
        },
      },
    ),
  );
  fs.linkSync(path.join(scratch, packed[0].filename), artifact);
  fs.writeFileSync(
    path.join(allocation, "artifact.json"),
    JSON.stringify(
      {
        artifact,
        sha256: createHash("sha256")
          .update(fs.readFileSync(artifact))
          .digest("hex"),
      },
      null,
      2,
    ),
    { flag: "wx" },
  );
  console.log(artifact);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
