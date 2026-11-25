# Seal

> **AI 判断，Seal 验算，人拍板。**

Seal 是一个 DeepSeek Harness（DSH）插件，面向所有需要**受控传统 Office 格式交付**的工作场景：从规定格式的 Word 源文件中提取模板结构，结合机构知识库填写事实、撰写自拟章节、挂载证明材料，经确定性检查与人工审阅确认后导出终稿。当前以**招投标**作为首个端到端落地的具体场景推进至真实可用，通用 Word 引擎、知识库与范围/签名/闸门底座不写死招投标特例。

Seal 不替 Agent 做语义判断，只提供可靠的文档与知识库工具，对能机械验证的事实做确定性检查（C01–C16）；商业决定、原文改动接受、资料核实与定稿导出只能由人在工作台完成。

## 文档导航

- 产品定义：[docs/PRODUCT.md](docs/PRODUCT.md)
- 架构总纲：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 子系统契约：[1-知识库](docs/subsystems/1-knowledge-base.md) · [2-Word 引擎](docs/subsystems/2-word-engine.md) · [3-投标流程与检查](docs/subsystems/3-bid-workflow-and-checks.md) · [4-DSH 插件与工作台](docs/subsystems/4-dsh-plugin-and-workbench.md)
- 发版与用户安装指南：[docs/RELEASE.md](docs/RELEASE.md) · [DSH 市场索引](market/index.json)
- 语料说明与最新多样本评测报告：[tests/corpus/README.md](tests/corpus/README.md) · [2026-11-22 量化评测报告](tests/corpus/results/2026-11-22.md)
- 执行队列与经验教训：[docs/TASKS.md](docs/TASKS.md) · [docs/LESSONS.md](docs/LESSONS.md)

## 运行环境与外部依赖说明

- **零 Poppler 开箱即用**：PDF 页数识别、中文文本抽取与扫描件高分辨率光栅化默认由随包内置的 MIT 协议 **PDFium WASM**（`@hyzyla/pdfium` + `sharp`）完成，Windows 与 macOS 用户均**无需安装或配置 Poppler**。
- **可选 LibreOffice**：日常 `.docx` 编辑、PDF/扫描件/图片/表格/文本入库与 C01–C16 核验不依赖 LibreOffice；仅导入旧版 `.doc`/`.xls`、在右栏查看「页面预览」或为 `insert_toc` 自动回填真实目录页码时需要安装免费官方 [LibreOffice](https://www.libreoffice.org/download/download-libreoffice/)（Windows/macOS/Linux 自动探测默认安装路径；未安装时工作台顶部会温和提示，不影响其余功能）。

## 安装与在 DSH Desktop 中使用

### 1. 从 DSH 插件市场或 npm 安装（推荐普通 Office 用户）

- **DSH 插件市场索引 URL**（添加后可一键安装与更新）：
  `https://raw.githubusercontent.com/chefzejia/seal/main/market/index.json`
- **或直接在 DSH 桌面端通过 npm 包名安装**：打开 DeepSeek Harness → 左侧 **插件（Plugins）** → **添加插件（Add plugin）** → 输入 `seal-dsh` 点击安装即可（命令行 Web 模式可用 `dsh plugin --profile web add seal-dsh`）。
- 完整发版与安装步骤见 [docs/RELEASE.md](docs/RELEASE.md)。

### 2. 从源码构建并本地安装

```bash
npm install
npm run build:dsh
npm run build:market       # 同步更新 market/index.json 与 market/icon.svg
# 桌面端：在 DSH「插件 → 添加插件」填入 dist/seal-dsh-<version>.tgz 路径
# Web 命令行模式：
dsh plugin --profile web add dist/seal-dsh-<version>.tgz
```

重启 DeepSeek Harness Desktop 后，左侧导航栏会出现 **Seal** 全局入口（建议先核对顶部「运行版本」与安装包版本一致）：

1. **知识库中心**：新建或管理企业资料柜；支持将多格式资料或整个文件夹（Word `.docx`/`.doc`、PDF `.pdf` 含扫描件、图片、表格 `.xlsx`/`.xls`/`.ods`/`.csv`/`.tsv` 与纯文本 `.txt`/`.md`）只读入库生成候选，由 Agent 配合 `seal-kb` 操作手册看图读表建档，再经人工分类与核实主体字段及证明材料（**原件始终只读**），页面刷新后仍可续推未整理批次。
2. **开启投标**：在「开启投标」页选择或拖入招标文件副本、绑定知识库并填写截止日期，Seal 自动创建项目目录、开启会话、引导 Agent 加载 `seal-bid` skill 并展开右侧审阅工作台。
3. **审阅、确认与定稿导出**：Agent 完成要求清单提取、分册填写、证据图挂载与自检交接后，业务人员在右栏「审阅清单」与「要求清单」逐类确认待定项、原位修改或接受原文改动、过目跳过的空白、查看页面预览；待全部阻断项清零（`可以定稿`）后点击「导出终稿」，输出不含 Seal 书签与临时黄标的终稿 `.docx`（不修改草稿与基准摘要）。

> 可选沙盒隔离：运行测试或评测时设置环境变量 `SEAL_HOME=/path/to/sandbox` 即可与真实 `~/.seal` 完全隔离。

### 2. CLI 入口（只读检查、编排与资料管理）

CLI 提供与 Agent 工具一致的非授权能力（不支持人工确认、核实或定稿导出，授权操作仅在工作台界面提供）：

```bash
# 查看项目与知识库命令帮助
npx tsx src/shells/cli/index.ts --help

# 对项目执行完整 C01–C16 确定性检查
SEAL_HOME=/path/to/sandbox npx tsx src/shells/cli/index.ts check --project <project-dir> --json
```

## 开发与验证

```bash
npm run typecheck          # TypeScript 全仓严格检查
npm test                   # 全仓单测、三层架构边界与文档链接检查
npm run verify             # typecheck + test
npm run build:dsh          # 构建新补丁版本 DSH 插件包 dist/seal-dsh-<version>.tgz
```

### 真实插件包与语料核验

```bash
# 1. 在真实 DSH SDK 与 HTTP 载体上验证刚构建的插件包
SEAL_DSH_ARTIFACT="$PWD/dist/seal-dsh-<version>.tgz" npx tsx --test tests/dsh-bundle.test.ts

# 2. 校验公开语料与只读黄金样本元数据及 SHA256（不会修改任何原件）
node tests/corpus/verify.mjs --metadata-only
SEAL_CORPUS_DIR="$PWD/.tmp/corpus" SEAL_GOLDEN_DOC="/path/to/golden.doc" node tests/corpus/verify.mjs
```
