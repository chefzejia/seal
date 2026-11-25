# Seal 发版与 DSH 市场索引指南

本文档面向两类读者：
1. **维护者发版**：公开仓库前隐私检查、打包并发布 npm 插件包、更新并推送 DSH Format 1 市场索引。
2. **普通 Office 用户安装**：在 DeepSeek Harness（DSH）中直接通过插件市场索引或 npm 包名一键安装与升级。

---

## 一、面向 Office 用户的安装指南（macOS / Windows / Linux）

Seal 现已内置 MIT 协议的 **PDFium WASM** 引擎，**无需安装或配置 Poppler**；打开工作台即可直接编辑 `.docx`、导入 PDF/扫描件入库及执行全部 C01–C16 确定性检查。

### 方式 1（推荐）：在 DSH 插件市场直接添加 Seal 官方索引

1. 打开 **DeepSeek Harness Desktop**，进入左侧 **Plugins / 插件管理** → **Discover / 发现**（或 **Market Sources / 市场源**）。
2. 添加市场索引链接（GitHub Raw 免费直链）：
   ```text
   https://raw.githubusercontent.com/chefzejia/seal/main/market/index.json
   ```
3. 在发现列表中找到 **Seal**，点击 **Install / 安装**；后续有新版本发布时，DSH 会自动从同一索引识别更新并提示一键升级。

### 方式 2：通过 npm 包名直接安装

- **Desktop 桌面端用户（推荐）**：打开 DeepSeek Harness → 左侧 **插件（Plugins）** → **添加插件（Add plugin）** → 直接输入包名 `@seal/dsh`（或自定义 `SEAL_NPM_PACKAGE` 包名 / 本地 `.tgz` 路径）点击安装即可，无需命令行。
- **Web 命令行模式用户**：

```bash
dsh plugin --profile web add @seal/dsh
# 或使用本地构建产物离线安装：
dsh plugin --profile web add dist/seal-dsh-<version>.tgz
```

### 可选扩展：安装免费官方 LibreOffice

仅以下三类能力需要外部 **LibreOffice**：
- 导入旧版 `.doc` / `.xls` 资料并自动转为 `.docx` / `.xlsx`；
- 在右侧审阅工作台生成文档「页面预览」图；
- 为 `insert_toc` 自动计算并回填目录真实页码。

如需要上述能力，前往官网免费下载并安装默认路径即可（Windows `C:\Program Files\LibreOffice\program\soffice.exe`、macOS `/Applications/LibreOffice.app`、Linux `/usr/bin/soffice` 均自动识别，无需手动配置环境变量）：
- 下载地址：<https://www.libreoffice.org/download/download-libreoffice/>

安装完成后重启 DeepSeek Harness，工作台顶部的环境提示横幅会自动消失。

---

## 二、维护者发版清单

### 1. 仓库改 Public 前的隐私与红线自检

在将 Git 仓库设为 Public 或发布到公网 npm 前，务必逐项核对：

1. **只读原件与客户脱敏**：确认仓库内无任何真实客户名、合同号、本机用户路径或私密证照扫描件（`tests/boundaries.test.ts` 会自动扫描 `src/**` 与 `scripts/**` 中的本机路径及样例标识）。
2. **工作区与构建产物**：确认 `.tmp/`、`dist/*.tgz`、`.DS_Store`、测试截图及临时凭证未被 `git add`。
3. **全仓门禁全绿**：
   ```bash
   npm run verify
   ```

### 2. 构建新补丁版本并发布到 npm

`scripts/build-dsh-bundle.mjs` 会自动分配递增补丁版本号（不修改根 `package.json` 版本号），并将 `@hyzyla/pdfium`、`README.md`、`locale/zh.json`、`locale/en.json`、`icon.svg` 与 `publishConfig: { access: "public" }` 打入 `dist/seal-dsh-<version>.tgz`。

1. 构建并验证打包产物：
   ```bash
   npm run build:dsh
   SEAL_DSH_ARTIFACT="$PWD/dist/seal-dsh-<version>.tgz" npx tsx --test tests/dsh-bundle.test.ts
   ```
   > 如需发布到自有 npm scope（例如 `@your-org/seal-dsh`），在构建和生成索引时同时设置 `SEAL_NPM_PACKAGE=@your-org/seal-dsh`。
2. 登录 npm 并发布刚构建的 TGZ（公开包需加 `--access public`）：
   ```bash
   npm login
   npm publish "$PWD/dist/seal-dsh-<version>.tgz" --access public
   ```

### 3. 生成并推送 DSH Format 1 市场索引

`scripts/build-market-index.mjs` 会从最新 `dist/seal-dsh-*.tgz`（或 `SEAL_DSH_ARTIFACT`）读取版本与多语言元数据，保留历史版本号并按 SemVer 降序合并，输出符合 `@deepseek-ai/dsh-plugin-market-index` Format 1 规范的 `market/index.json` 与 `market/icon.svg`：

```bash
npm run build:market
```

常用可选环境变量：
- `SEAL_DSH_ARTIFACT`：显式指定目标 `.tgz` 路径（默认自动挑选 `dist/` 中最新 SemVer 产物）。
- `SEAL_MARKET_BASE_URL`：索引托管根 URL（默认 `https://raw.githubusercontent.com/chefzejia/seal/main/market/`）。
- `SEAL_NPM_REGISTRY`：若发布到私有或镜像 npm 源，可在此填入源站 URL 写入 `versions[].source.registry`。

校验并推送到公开主分支：

```bash
npx tsx --test tests/milestone41-release-and-pdfium.test.ts
git add market/index.json market/icon.svg docs/RELEASE.md README.md
git commit -m "chore(release): publish v<version> and update DSH market index"
git push origin main
```
