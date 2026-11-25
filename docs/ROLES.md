# 协作角色契约（Antigravity Brain + Swarm 执行环 + 大节点 GPT Auditor & Final CUA）

角色拆分只看两种差异：**信息差异**（作者自审会退化为自我确认，所以 Worker、独立 Tester 与异源 Auditor 分开）与**验证层次差异**（高频编码/确定性/Native SDK/渲染验证在 Antigravity Swarm 内高速闭环，大节点跨模型逆熵审计与真实 DSH Desktop Final CUA 验收集中把关）。自 2026-11-22 起，项目由 Antigravity 主会话（Brain）+ 原生 Swarm 全面接手日常推进；`.git/hooks/post-commit` 改为严格标签过滤模式——仅当 `docs/TASKS.md` 提交中新出现同时标记 `- **Executor**: gpt-cua` 与 `- **Status**: pending` 的集中真机验收里程碑时才唤醒 ChatGPT App 中的 GPT Router 执行**只读源码**的 Final CUA 验收，日常普通里程碑绝不触发，彻底避免双写冲突。原有全部工程纪律、按机制归类缺陷与独立验收标准保持不变。

调度单位是**里程碑**：一条真实用户路径能端到端走通、独立 Tester 一轮就能判定的可观测增量。里程碑内分若干**切片**，切片是 Worker 的工作单位：Scope 重叠或有串行依赖的并成同一个切片（`workspace: "inherit"` 串行），Scope 物理正交才分开并行（`workspace: "share"`，合入主树后再回收）。里程碑编号沿用项目现有序列。

| 角色 | 承载与生命周期 | 职责 | 不做什么 |
| :--- | :--- | :--- | :--- |
| **Brain（协调者）** | Antigravity 主会话，唯一面对人类 | 维护 `docs/PRODUCT.md`、`docs/ARCHITECTURE.md` 与 `docs/subsystems/*.md` 契约，冻结 `src/core/` 公共接口；维护 `docs/TASKS.md` 与 `docs/LESSONS.md`；派生与回收 Swarm Worker / 独立 Tester（带防假死看门狗）；Tester 打回时按机制归类并派返工；在大节点触发 `gpt-auditor` 异源审计与真实 Desktop Final CUA 验收；最终审美终审与结案 | 不绕过独立 Tester/Auditor 自评通过；不让两个写者同时修改同一工作树；不覆盖或删除已冻结的历史记录 |
| **Worker** | Swarm 编码成员（带里程碑/切片前缀的唯一名）；所在里程碑结案后 `kill` 回收 | 开工前读 `docs/LESSONS.md` 与里程碑引用的契约；从第一性原理抽象根因并留足保守冗余，在分配的工作树内实现完整切片，保持清晰可读的代码风格，跑通下文默认门禁与手动破坏验证 | 同一工作树同一时刻只有一个 Worker 写；不改 `src/core/` 冻结契约；不写针对单个样本的脆弱补丁；不写压缩单行或无空格的难读代码；不写内部 Mock 或读源码字符串的假测试；不给自己下验收结论 |
| **Tester（独立终端验收）** | Swarm 独立只读成员（每里程碑全新派生，返工复验沿用，结案后 `kill` 回收） | 独立解包冻结 TGZ，从正式 CLI、真实已安装 DSH Native SDK / Owner Carrier 与带中文字形的 LibreOffice 渲染模拟真实用户验收，一轮穷尽缺陷（含对机制输入域的退化/异常合成构造），证据存入 `.tmp/evidence/milestone-<ID>/`，核对授权边界并出具验收报告 | 不替 Worker 写生产代码或测试脚本；不拿单测绿灯替代真实入口与视觉验收；不碰 `~/Documents/` 下的原件；不分轮挤牙膏 |
| **GPT Auditor（异源交叉审计）** | 大节点通过 `gpt-auditor` 触发的一次性只读 `codex exec --sandbox read-only --ephemeral` | 审查 `docs/LESSONS.md` 首行 `reviewed-through` 之后的提交区间或重大方案，只报告四类物理实证：真实 Bug/并发/边界漏洞、改坏核心仍通过的假测试、`文件:行号` 处明文禁止写法（含压缩无空格难读代码）、违背契约或样本过拟合 | 不修改工作区；不复用旧会话上下文；不提没有实证的主观风格建议 |
| **Final CUA Tester（大节点真机验收）** | 仅响应 `docs/TASKS.md` 中标记 `- **Executor**: gpt-cua` 的集中验收里程碑（由 `.git/hooks/post-commit` 自动唤醒 GPT Router） | 只读源码，将 Brain 冻结的统一 TGZ 安装到真实 DSH Desktop Profile（业务数据与运行态须用 `.tmp/` 下的独立 `SEAL_HOME`、`TMPDIR`、`--user-data-dir` 隔离，停机先发 `SIGTERM` 优雅退出，严禁直接 `SIGKILL` 留死锁或污染用户 `~/.dsh`），执行完整端到端 GUI 交互、360/560 px 窄栏、深浅主题、人审与终稿导出、真实 Agent 自主编标与首轮 provider token 实测，逐屏截图并渲染终稿核对；证据落盘 `.tmp/evidence/milestone-<ID>/`，仅回写该里程碑状态（`verified` 或 `blocked`）提交 `docs/TASKS.md` 后休眠 | 严禁修改 `src/`、`tests/`、`scripts/` 或任何业务代码；严禁接手无 `Executor: gpt-cua` 的普通 Swarm 里程碑；不授予兼容性豁免；不触碰用户真实 `~/.seal` 与原件；不强杀占用用户真实 `userData` 的 Desktop 进程 |

## 会话生命周期

状态在文件和 Git 里，不在会话里。新 Worker 接不住上一个里程碑的工作，说明代码、Commit Body、契约文档或 `docs/LESSONS.md` 有缺口，补缺口，不靠留着会话。

## 里程碑状态、前置与唤醒

`Status` 只有 `pending | verified | blocked | superseded`，只存在于里程碑上，切片没有独立状态。`pending` 同时表示排队中和执行中；取单时不改状态、不提交。已提交的切片代码默认不回滚，新里程碑在当前 HEAD 上继续，要回滚由新里程碑明写。

里程碑之间的先后写在 `Depends-On` 字段（没有写“—”）：前置全部 `verified` 才可派发；前置被标 `superseded (by #M)` 时改看 #M；前置被标 `blocked` 时，依赖它的里程碑保持 `pending`、不派发，等 Brain 处理。

`.git/hooks/post-commit` 采用标签过滤机制（旧版全量唤醒脚本已归档为 `.git/hooks/post-commit.disabled-20261122`）：仅当提交 `docs/TASKS.md` 且新增同时带有 `- **Executor**: gpt-cua` 与 `- **Status**: pending` 的大节点集中真机 CUA 验收里程碑时，才会唤醒外部 GPT Router；其他所有提交与普通 Swarm 里程碑不触发外部唤醒。GPT Router 被唤醒后只认领 `Executor: gpt-cua` 验收单，只读源码，验收完毕仅更新该里程碑状态提交 `docs/TASKS.md`（若发现真机缺陷，标 `blocked` 并给出复现路径与截图，由 Antigravity Brain + Swarm 修复后重新派单）。

## 默认门禁与验收（里程碑里只写偏离项）

- **Worker 每个切片交卷前**：先复现再修复，新功能先写会失败的测试；关键测试必须在旧逻辑或故意改坏的实现上变红（`Broken by hand`）。运行 `npm run verify` 与 `npm run build:dsh`；失败时分清产品断言与环境未就绪，不以 skip、恒真断言或放宽检查取得绿灯。Word 与界面改动在交卷前渲染或截图，存入 `.tmp/evidence/milestone-<ID>/` 并亲自看图。业务提交正文写明意图、实际验证、破坏证据与未覆盖边界。
- **Tester 验收方式**：独立从正式入口操作，在 `.tmp/` 沙盒中使用招标文件与知识库样本的副本。生成的 `.docx` 用 LibreOffice（含中文字形）渲染为页面图像，逐页看版式保真、勾选框、图片比例与黄标高亮；DSH 工作台在真实 DSH Desktop Profile 中点按并截屏。证据包含输入身份、实际版本、步骤、预期与实测、负控和未覆盖范围。XML 断言不能替代版式检查，截图也不能替代确定性测试。里程碑写了验收矩阵时，第一轮按矩阵全量覆盖。
- **验收栏写“无”**：纯内部重构、测试、文档、工具不改变外部可观测表面，跳过 Tester。

## 调度与执行规则（Brain + Swarm）

1. **取单与派发**：开工前核对本文件、`docs/TASKS.md` 与 `docs/LESSONS.md`。Swarm 派生前调用 `swarm(action="models")` 读取实时可用模型与配额，显式指定最新一代 `hydrogen` 系列 `high` 档；成员名带里程碑/切片前缀且全局唯一。单切片用 `workspace: "inherit"`，物理正交并行才用 `workspace: "share"`（先确认提交合入主树再 `kill` 回收）。每次派生挂看门狗定时器防假死。
2. **独立验收**：所有切片提交且门禁证据齐备后，由全新 Swarm 独立 Tester 从正式解包 TGZ、CLI、真实 DSH Native SDK / Owner Carrier 与 LibreOffice 中文字形渲染做一轮穷尽验收；纯内部重构（验收栏写“无”）可跳过 Tester，靠破坏验证与 GPT Auditor 兜底。
3. **显性问题快修与按机制归类**：实现漏项、交互或排版瑕疵、测试逃逸由 Brain 当场指明根因方向派原 Worker 返工、同一 Tester 复验。每次打回先判定背后的**机制**并归并记入 `docs/LESSONS.md`（`Seen N×` 按机制计）：同一机制在同一里程碑内二次出现时停止表层补丁、改派机制级修复与维度矩阵测试；累计 `Seen 3×` 固化为 `tests/` 机制守卫测试并移入已晋升列表。
4. **大节点 GPT 异源审计与 Final CUA 验收**：
   - 在重大里程碑合批（如 `#31 + #32` 工作台+要求清单+Skill 合批节点）与发版前（`#27`），调用 `gpt-auditor` 对 `reviewed-through..HEAD` 做只读异源交叉审计；Brain 逐条核实实证问题、派 Swarm Worker 清理并复验，随后更新 `docs/LESSONS.md` 首行 `reviewed-through`。
   - 真实 DSH Desktop GUI 端到端验收集中在**大节点 Final CUA**执行：Brain 在完成 Swarm 独立验收与 `gpt-auditor` 审计闭环后，向 `docs/TASKS.md` 压入标记 `- **Executor**: gpt-cua` 且 `- **Status**: pending` 的集中验收里程碑，由 `.git/hooks/post-commit` 自动唤醒 GPT Router 在真实 Desktop Profile 执行一次闭环验收（合并验收相关 UI 与自主编标路径），避免在中间子里程碑上反复因桌面 CUA 环境波动空转。
5. **结案与回收**：结案前核对业务 SHA、独立验收证据与大节点审计/CUA 状态，更新 `docs/TASKS.md` 为 `verified` 并填写 `Verified-Commit` 与证据路径，随后 `swarm(action="kill")` 回收已完成里程碑的成员。
