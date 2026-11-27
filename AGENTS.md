# Seal

> **AI 判断，Seal 验算，人拍板。**

Seal 是一个 DeepSeek Harness（DSH）插件，面向所有需要**受控传统 Office 格式交付**的工作场景：从规定格式的 Word 源文件中找出模板结构，结合机构知识库填写事实、撰写自拟章节、挂载证明材料，经人审阅确认后导出终稿。**当前以招投标作为首个端到端落地的具体场景推进至真实可用**，但通用底座不写死招投标特例。Seal 不替 Agent 做语义判断，只提供 Agent 好用的文档与知识库工具，并对能机械验证的事实做确定性检查。

本项目采用「纯逻辑内核（`src/core`）+ 界面视图模型（`src/workbench`）+ 宿主薄壳（`src/shells`）」三层单向架构（见 [ARCHITECTURE.md](docs/ARCHITECTURE.md)），日常采用主会话（Brain）+ 宿主原生双模型/子代理（显式团队模式按需启用 Swarm）推进实现与验算，全周期关键节点通过 `gpt-peer` 调用异源第二大脑双向互审，大节点由真实 DSH Desktop Final CUA 把关（见 [ROLES.md](docs/ROLES.md)）。

## 核心红线

1. **三层单向依赖与宿主零泄漏**：`src/core/` 不导入上层；`src/workbench/` 只导入 `src/core/`；`src/core/**` 与 `src/workbench/**` 禁止导入 `node:*` 和 `@deepseek-ai/*`，文件、子进程与渲染能力经 `HostPort`（`src/core/host.ts`）注入；宿主相关代码只在 `src/shells/`。由 `tests/boundaries.test.ts` 锁死。
2. **原件只读**：用户的招标文件、企业母本与知识库原件 100% 只读；转换、编辑与测试只在项目目录、工作副本或 `.tmp/` 中进行。
3. **Word 只经 Seal 编辑原语修改；草稿永远可出，定稿才设闸门**：对 `.docx` 的任何修改只能通过 `src/core/docx` 的编辑原语执行，禁止 Agent 或一次性脚本直接改写 XML。编辑原语当场拒绝会损坏文件、引用不存在的资料或挂载失效证据的操作，被拒的整批编辑不改变草稿；其余问题（未处理空白、待拍板项、原文改动、内容丢失等）一律以 Word 内可见标记和检查报告呈现，不阻止草稿输出。只有定稿导出设闸门，条件见 [3-bid-workflow-and-checks.md](docs/subsystems/3-bid-workflow-and-checks.md)。
4. **商业敏感项与未核实引用只由人确认**：核心商业敏感参数（报价、工期/交货期、质保）、Agent 显式标定的偏离/承诺/缺口，以及引用了未核实知识库资料的事实，以 Word 原生黄色高亮（`<w:highlight w:val="yellow"/>`）标为待定；常规非敏感内容填充与自拟正文信任 AI 整合生成，默认白底呈现。Agent 不能确认或消除待定项；只有人在工作台确认，被确认内容一旦改变，确认自动失效。知识库事实的“已核实”状态同样只能由人设置。
5. **启发式只能提醒或加严，不能放行**：识别规则（疑似空白、敏感关键词等）只用于提示 Agent 和自动加标待定，不得决定“能不能写”，也不得把任何内容判为已核实。禁止在代码里用正则替 Agent 做语义判断、字段匹配或装配规划。
6. **生产代码零硬编码，真实 Desktop 验收与物理隔离**：`src/**` 与 `scripts/**` 中禁止出现特定客户名、项目编号、本机用户绝对路径或特定模板坐标（由 `tests/boundaries.test.ts` 锁死）；样本只能在 `tests/**` 中通过环境变量或临时目录传入。界面与安装验收在真实 DSH Desktop Profile 中进行，不建假 Profile；**任何自动化/调试启动 DSH 严禁与用户日常 Desktop 抢占单例锁或污染 `~/.dsh`**：常规 Web/UI 调试优先用 `dsh --profile web --host 127.0.0.1 --port 0 --no-open`（配 `.tmp/` 沙盒 `SEAL_HOME` 与临时 `DSH_HOME`）；必须启动真实 Electron `DeepSeek Harness.app` 做真机验收时，必须同时隔离 `SEAL_HOME`、`TMPDIR`、`--user-data-dir="<sandbox>/electron-user-data"`（按需隔离 `DSH_HOME`），且停机必须先发 `SIGTERM` 优雅退出，禁止直接 `SIGKILL` 强杀导致 `SingletonLock` 与 macOS `launchd` 僵尸项残留（排障与自愈见 `npm run dsh:doctor` / `npm run dsh:fix`）。
7. **多 Agent 协作与异源双向互审纪律**：主会话担任 Brain，负责契约维护、任务切分、调度与审美/质量终审；日常切片开发优先走宿主原生双模型与轻量子代理隔离（物理正交并行写使用隔离工作树，仅在显式触发团队模式时启用重型 Swarm），验收通过后按最小可独立回滚语义单元 Squash 线性合入 `main` 并立即清理本地分支与工作树（严禁作者自审结案）；在 0→1 方案互搏（`debate`）、疑难排错破盲（`debug`）、对抗边界测试设计（`adversarial-tests`）、低频第一性架构体检（`first-principles`）、方案红队（`plan`）、合并/发版前实证审计（`diff`）及显式隔离 Worktree 硬核纯逻辑攻坚（`implement --worktree-write`，主控反向审查）等全周期高杠杆节点按需调用 `gpt-peer`（默认只读沙盒、默认推理深度 `xhigh`、不硬编码模型名）；大节点发版前可向 `docs/TASKS.md` 压入标记 `Executor: gpt-cua` 的集中真机验收里程碑，由标签过滤的 `.git/hooks/post-commit` 仅在该大节点唤醒外部执行只读源码的真实 DSH Desktop Final CUA 验收（日常普通里程碑绝不唤醒，杜绝双写冲突；见 [ROLES.md](docs/ROLES.md)）。
8. **第一性原理与保守冗余（拒绝针对样本打补丁）**：现实中的传统 Office 文档与资料千奇百怪（不同版本 Word / WPS / `.doc` 转换、缺失或脏样式、异构表格、非标准包装与媒体）。禁止“先有数据再写代码、追着已知样本打补丁”；必须从第一性原理抽离根本机制，对 Seal 自生成的结构写入完整显式属性，对无法精确模拟的外部排版与未知输入留足保守冗余（安全下界与显式安全余量），遇到无解容器或异常输入时透明报告而非静默裁切或放行。通用底座（`src/core/docx`、`src/core/kb` 及范围/签名/闸门机制）不得渗入特定行业词汇或假设。

契约优先级：本文件 > [ARCHITECTURE.md](docs/ARCHITECTURE.md)、[PRODUCT.md](docs/PRODUCT.md) 与子系统契约 > [TASKS.md](docs/TASKS.md) > [LESSONS.md](docs/LESSONS.md)。经验教训与现行契约冲突时以契约为准。

## 修改与验证

```bash
npm run typecheck          # TypeScript 全仓严格检查
npm test                   # 全仓单测、架构边界与文档链接检查
npm run verify             # typecheck + test
npm run build:dsh          # 构建 DSH 插件包 dist/seal-dsh-<version>.tgz
npm run dsh:doctor         # 只读诊断 DSH 单例锁、launchd 僵尸项与测试残余会话
npm run dsh:fix            # 优雅关闭测试沙盒 DSH 并自动清理死锁与 launchd 僵尸项
```

## 按需路由

- [里程碑调度板](docs/TASKS.md)：执行队列、状态、前置（`Depends-On`）与写作用域（`Scope`）。
- [协作角色契约](docs/ROLES.md)：Brain · Router · Worker · Tester · Auditor 的职责与升级闭环。
- [产品定义](docs/PRODUCT.md)：要解决的问题、标书的三种内容、用户流程与明确不做的事。
- [架构总纲](docs/ARCHITECTURE.md) 与子系统契约：[1-知识库](docs/subsystems/1-knowledge-base.md) · [2-Word 引擎](docs/subsystems/2-word-engine.md) · [3-投标流程与检查](docs/subsystems/3-bid-workflow-and-checks.md) · [4-DSH 插件与工作台](docs/subsystems/4-dsh-plugin-and-workbench.md)。
- [经验教训](docs/LESSONS.md)：已知翻车模式与 `Seen N×` 计数。
