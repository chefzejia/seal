# 子系统 4：DSH 插件与工作台（`src/shells/dsh/`、`src/shells/cli/`、`src/workbench/`）

## 一、插件身份、打包与参考资料

- 包名 `seal-dsh`（支持通过 `SEAL_NPM_PACKAGE` 在构建/发版时覆盖，打包时同步注入 `cordis.patch.yml` 与客户端 `__ModuleLoader__` 模块 ID），插件行名 `seal-workbench`，由 `scripts/build-dsh-bundle.mjs` 构建为 `dist/seal-dsh-<version>.tgz`（含 `README.md`、`locale/zh.json`、`locale/en.json`、`icon.svg`、`license`、`repository`、`homepage`、`keywords`、`publishConfig` 等公网 npm 与 DSH 插件展示元数据）。每次交付递增补丁版本并使用新文件名；`engines.dsh` 与对等依赖按实际安装的 DSH 版本核对。
- **DSH 插件市场索引（Format 1）**：由 `scripts/build-market-index.mjs`（`npm run build:market`）依据最新打包产物生成 `market/index.json` 与 `market/icon.svg`，严格遵循 `@deepseek-ai/dsh-plugin-market-index` Format 1 规范（`format: 1`、中英文 `title`/`description`、`metadata`、`plugins[].versions[]` 含 `source: { type: "npm" }` 与 `engines.dsh`），托管于公开仓库免费直链供 DSH 发现页直接安装更新。
- **零 Poppler 外部依赖与跨平台环境体检**：PDF 页数、中文文本抽取与高清 PNG 光栅化（`extractPdf`、`renderDocxPages`、`extractDocxPageTexts`）默认由随包内置的 MIT 协议 PDFium WASM（`@hyzyla/pdfium` + `sharp`）在串行 WASM 访问保护下完成，用户无需安装或配置 Poppler；外部系统依赖仅保留有官方图形安装包、跨平台自动探测路径（macOS / Windows / Linux）的 LibreOffice（`soffice`），并在工作台首页通过 `/api/seal/status` 与 `overview()` 做只读环境自检——装齐时静默不打扰，缺失 LibreOffice 时温和提示影响范围与官方下载直链。
- DSH 插件开发以已安装版本的文档与源码为准，不凭记忆：
  - DSH 应用内 `dsh-doc` skill 的参考文件，重点是 `references/practices.md`、`user-actions.md`、`tool-design.md`、`ui-plugin.md`、`host-plugin.md`。macOS Desktop 默认位于 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/dsh-doc/`；
  - `@deepseek-ai/dsh-tools`（工具定义与执行上下文）、`@deepseek-ai/dsh-skill`（skill 注册）的 README 与源码。
  - 这些文件位于 `app.asar` 内，普通的 `ls`/`cat` 无法读取。读取方法：以 `ELECTRON_RUN_AS_NODE=1` 运行宿主可执行文件（`/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness`），用 `node:fs` 读取，详见 `dsh-doc` 的 `references/locate-docs.md`。

## 二、Agent 工具

| 工具 | 主要参数 | 返回 | 备注 |
| :--- | :--- | :--- | :--- |
| `seal_doc_read` | `file`（项目内路径或分册名）、`mode`（`outline` / `blocks` / `search`）、`from`、`limit`、`query` | [子系统 2](2-word-engine.md) 第三节的视图 | 读招标文件与草稿 |
| `seal_doc_extract` | `tender`、`ranges`（有序列表）、`draft`（分册名） | 复制摘要、疑似空白数、被删除的残留标记 | 建立分册 |
| `seal_doc_edit` | `draft`、`ops`（子系统 2 第五节） | 每个操作的结果、受影响块的新视图、新增待定项 | 原子批次 |
| `seal_check` | `draft`（省略表示全部分册）、`group`（只看某类，可选） | [子系统 3](3-bid-workflow-and-checks.md) 第五节的分组报告与定稿就绪状态 | 只读 |
| `seal_kb_search` | `query`、`type`、`tags`、`validity`、`limit` | 简要结果列表 | 只读 |
| `seal_kb_get` | `id`（或 `subject`）、`kind`、`offset`（可选，长正文截断时配合 `nextOffset` 续读） | 完整或分页记录，以及按项目截标日（或显式 `referenceDate`）计算的体检结果 | 只读 |
| `seal_kb_save` | `action`（`create` / `update` / `delete` / `attach_file` / `dismiss_candidate`）、`kind`（`record` / `material` / `subject`）、`id`、`fields`、`body` | 保存后的记录与体检结果 | 不能写核实字段 |
| `seal_kb_ingest` | `files`（母本路径） | 入库批次、候选数与图片数 | 原件只读 |
| `seal_requirements` | `action`（`save` / `patch` / `list`）、`items` | 校验结果，引文不符的逐条列出 | — |
| `seal_outline` | `action`（`get` / `save` / `patch`）、`volumes`、`nodes`、`upsertNodes`、`removeNodeIds`、`updateVolumes` | 当前编制大纲、确认状态、统计摘要与项目 `materials/` 可用材料清单 | 不能写入确认/授权字段 |

- 工具描述遵循 `tool-design.md`：说明工具做什么、返回什么；参数规则写在参数上；输出有界，截断时说明如何继续；错误信息给出可执行的修改方式。
- 项目根目录取当前会话的工作目录：插件 `inject` 声明 `workingDirectory`，工具在执行时调用 `ctx.workingDirectory.ensure(exec.agent, exec.signal)` 取得（与宿主 `@deepseek-ai/dsh-tool-bash` 的做法相同，Brain 已于 2026-11-16 在 DSH 0.2.2-rc.3 源码中核实）。`exec.agent` 缺失时（如程序化调用），工具要求显式的 `project` 参数。所有写入路径必须位于项目目录或知识库目录内；招标文件原件只读。
- Agent 工具**不提供**：确认待定项、确认大纲、接受原文改动、过目跳过的空白、核实资料、标记要求已覆盖、定稿导出。

## 三、`seal-bid` skill 与 `/seal` 命令

- 插件通过 `ctx.skills.register(registration)` 注册 `seal-bid` skill，内容见子系统 3 第九节，skill 文本随包发布。`registration` 的字段以 `@deepseek-ai/dsh-skill` 的 `src/index.ts` 中 `SkillRegistration` 为准（核实时包括 `name`、`description`、可选的 `whenToUse`、`content` 与 `source`，省略 `invocation` 时模型与用户都可调用）；返回的注销函数交给 `ctx.effect` 管理。`skills` 作为可选注入（`ctx.inject(['skills'], …)`），缺失时不影响工具注册。
- `/seal`：在当前会话打开右侧审阅栏。当前工作目录不是 Seal 项目时，审阅栏引导用户从指挥台新建项目，或在当前目录初始化项目。

## 四、工作台界面

- 用 React 组件注册到 DSH 插槽（React 取自宿主模块表），使用宿主主题变量（`--dsw-alias-*`）与 locale。业务数据不得经 `dangerouslySetInnerHTML` 渲染；不在组件之外操作 DOM，不嵌入 iframe。
- 界面上的每个数据操作，都调用与 Agent 工具相同的 Host 实现（`user-actions.md`：一个操作，两个调用方）；授权类操作（含确认大纲）只有界面入口。客户端与 Host 之间可以沿用插件的 webServer 路由（须做同源校验），也可以使用宿主提供的 Client 调用入口。
- 失败必须在操作位置可见并给出原因；页面重载后，状态从项目文件与知识库恢复；有未保存的编辑时，离开或重载前给出提示。
- `src/workbench` 只放视图模型（分组、排序、文案、格式化），React 组件放在 `src/shells/dsh/`。

### 4.1 左侧全局页面 `Seal`（`sidebar.panellist` 与 `main`）

1. **开启投标**：拖入或选择招标文件（`.doc`/`.docx`），选择知识库（只有一个时默认选中，也可以不选），填写截标日，并选择编制模式（默认「先确认大纲再生成标书」`outline_first`，可选「跳过大纲直接生成」`direct`）。随后创建 `~/.seal/projects/<projectId>/`、复制招标文件、以项目目录为工作目录开启会话、发送对应模式的首条 `seal-bid` 指引消息，并打开右侧审阅栏。
2. **进行中的投标**：项目名、截标日倒计时、编制大纲状态（待确认大纲 / 大纲已确认 / 大纲待重审及待补材料数）、各类检查的数量（待定、原文改动、未处理空白、要求缺口、大纲一致缺口）与「继续」「编辑大纲」入口；会话已归档或失效时给出可理解的提示；支持经二次确认删除指定项目（含损坏项目），仅移除 `~/.seal/projects/<projectId>/` 与对应的 `ledgers/<hash>.json` 锚点，100% 不碰原招标文件或知识库。
3. **全宽编制大纲编辑器（由项目卡片或会话右栏一键进入）**：
   - 顶栏：返回会话/项目列表、项目名与「仅编辑大纲安排，不改动原 Word」提示、撤回/重做（Undo/Redo）、状态筛选（全部 / 待补材料 / 未覆盖要求 / 规定格式 / 自拟章节 / 证明材料 / 已跳过）、分册切换与新增分册、保存大纲（带未保存离开保护与 409 版本冲突提示）以及主按钮「确认大纲并开始生成标书」（有未补齐待补材料时经内联确认条温和提醒后仍允许继续，签章锁定并自动向绑定会话发送阶段二执行指令）；
   - 左栏（项目章节导航）：按标题/编号搜索、折叠章节树定位、底部实时统计（标题总数、本次调整数、已跳过数、待补材料数、未覆盖必答要求数）；
   - 中栏（可编辑大纲树）：层级徽标（一级–六级）、编号与标题行内编辑、三类来源标识（规定格式锁定保护、可选格式一键开关、自拟章节自由增删改查、证明材料状态徽标 `已匹配`/`待核实`/`待补材料`），支持新增同级/子节、上下移动整棵子树、升级/降级与内联二次确认删除；
   - 右栏详情抽屉：编辑单节给 AI 的写作/编排批注、勾选关联招标要求（高亮未覆盖必答要求）、绑定/替换知识库证照记录、当场上传/补传本地材料（支持图片、PDF、DOCX、TXT；原件 100% 只读，复制至 `materials/outline/`，PDF 自动经内置 PDFium 渲染 PNG 供阶段二直接插图，上传即清除 `待补材料` 标记）以及「让 AI 调整本节」快捷指令。
4. **知识库中心**：
   - 知识库卡片：名称、信用代码、资料数、即将过期数、效期未知数、未核实数；新建知识库；经二次确认删除当前知识库（被进行中的投标引用时阻断并提示）；
   - 资料列表：按类型、有效期状态、核实状态筛选，支持搜索；资料详情：字段、原件预览、编辑与二次确认删除（记录/素材，带版本冲突校验）；
   - 核实队列：人逐项核实关键字段；
   - 母本入库：拖入多格式材料或目录，显示批次结果与待分类候选，可交给 AI 分类，并支持经二次确认删除待整理导入批次（安全保留已被已建档条目引用的副本文件）。

### 4.2 会话右栏 `Seal`（`sidebarRight`）

1. **顶部**：项目名、知识库、截标日、定稿就绪状态；“导出终稿”按钮（闸门未通过时不可用并说明原因）；“下载草稿”；项目处于待确认大纲态且尚未出稿时顶部突出展示大纲确认引导条。
2. **大纲快览标签页**：展示当前大纲状态（未生成 / 待确认 / 已确认 / 已变更需重审）、章节数、待补材料数与未覆盖必答要求数，提供紧凑章节浏览、一键跳转「全宽编辑大纲」与内联「确认大纲并开始生成标书」（直接向当前会话发送阶段二指令）。
3. **审阅清单**：按检查类别分组（待拍板、待核对、原文改动、内容丢失、未处理空白、Agent 跳过的空白、证据、主体、日期、金额、要求缺口、大纲一致 C17）。每项显示位置、原文片段、当前内容与原因，并提供：确认（可批量）、修改（作为人的编辑写入草稿）、接受改动、过目、标记已覆盖、打开大纲编辑（C17）、交给 AI（把位置与要求发到左侧对话）。原文改动中的 `bracketText`（只改写了括号段）单列一组，可以批量接受；同一位置的待定项与原文改动合并显示，可以一次处理。
4. **页面预览**：渲染后的页面图片；点击审阅项尽量定位到所在页。
5. 在 360–560 px 的窄栏中可用；长清单分页或折叠。

## 五、CLI（`src/shells/cli`）

- 命令与 Agent 工具一一对应：`project init`（支持 `--workflow-mode <outline_first|direct>`）、`read`、`extract`、`edit`、`check`、`kb search|get|save|ingest`、`requirements`、`outline`（`get|save|patch`），输出与工具一致。
- 不提供确认、确认大纲、接受、核实、定稿命令。测试需要模拟人工操作时，直接调用 `src/core` 的函数。

## 六、验收环境

- **逻辑测试**：`npm run verify` 中的单测与集成测试；临时目录位于 `.tmp/` 且名称唯一，测试结束时清理；`SEAL_HOME` 指向临时目录。真实样本只通过环境变量显式传入。
- **插件包测试**：用实际安装的 DSH SDK 解包执行本次构建产物，并核对版本。
- **界面与端到端验收**：把本次构建的 TGZ 安装到真实 DSH Desktop Profile（保留用户已有的配置、会话与其他插件，不授予兼容性豁免），核对实际加载的版本，用测试知识库与招标文件副本操作，截图归档到 `.tmp/evidence/milestone-<ID>/`。授权边界验收覆盖三件事：① Agent 工具、CLI 与未认证/跨源/非 owner 请求均无法执行确认、接受、过目、核实或定稿；② 确定性测试证明即便持相同 `authorization.key` 伪造重签项目内 `ledger.json`，未改动的项目外锚点仍会丢弃伪造并触发 C15；③ 真实 DSH `workspace-write` 会话下，向项目 `cwd` 外 `.tmp` 合成哨兵的写入被宿主沙盒拒绝，同时在报告中如实披露 rc.5 允许项目外读及 `danger-full-access` 不具插件级写隔离的宿主前提。
