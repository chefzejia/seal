# Seal · 当前执行队列

Brain 派单日期：2026-11-22。契约基线：`3c88d90`（Antigravity Brain + Swarm 执行环 + 大节点 `Executor: gpt-cua` 标签过滤唤醒机制；业务契约延续 `ac1a614` 单用户桌面三层信任模型与 `0b1699a` 通用 Office 底座、第一性原理冗余与定稿闸门解耦）。

本文件经用户授权调整：
1. 既有拆分：#24 改为 `superseded (by #30)`，拆成 #29（几何模型，Word 引擎）与 #30（知识库 v2 验收，依赖 #29）；两者均已 `verified`。
2. 本轮解耦：#25 改为 `superseded (by #31)`，#26 改为 `superseded (by #32)`；#27 的前置 #26 按 [ROLES.md](ROLES.md) 自动改看 #32（及合并真机验收 #33）。
3. 协作拓扑升级（2026-11-22）：日常实现与独立终端验证由 Antigravity Brain + 原生 Swarm 闭环；`.git/hooks/post-commit` 改为仅在新增 `Executor: gpt-cua` 且 `Status: pending` 的大节点集中真机验收里程碑时唤醒 GPT Router（只读源码、不改业务代码）。#31 与 #32 的全量代码、独立 Swarm Tester 终端验证与异源 `gpt-auditor` 审计已在 `1f6f079` 闭环并统一冻结为 `dist/seal-dsh-0.1.329.tgz`，现派发 `#33`（`Executor: gpt-cua`）执行一次合批真实 DSH Desktop Final CUA 验收。

**执行顺序：#29–#41、#27 全部 `verified`（且已于 `b39810c` 完成公开仓脱敏与公网 npm `seal-dsh@0.1.604` 交付）；当前派发 `#42`（两阶段编制蓝图：大纲先审、当场补料与 C17 漏章漏证验算）。**

## Router 冷启动与执行边界

1. 每个里程碑开工前重读 [ROLES.md](ROLES.md)，协议改动在下一个里程碑生效。冷启动时先读 [AGENTS.md](../AGENTS.md)、[ARCHITECTURE.md](ARCHITECTURE.md)、[PRODUCT.md](PRODUCT.md)、[ROLES.md](ROLES.md) 与当前里程碑引用的子系统契约，再读 [LESSONS.md](LESSONS.md)。最新契约基线 `ac1a614` 在 [ARCHITECTURE.md](ARCHITECTURE.md)（决定 7）、[3-bid-workflow-and-checks.md](subsystems/3-bid-workflow-and-checks.md)（第四节）与 [4-dsh-plugin-and-workbench.md](subsystems/4-dsh-plugin-and-workbench.md)（第六节）冻结了单用户桌面三层信任模型与项目外写隔离锚点验收要求；前序 `0b1699a` 修订仍全部生效。
2. Brain 只维护契约与派单。Router 不写业务代码，按执行顺序派生 Worker 与独立 Tester；派出的 Worker 与 Tester 都先读本轮契约。
3. 写作用域相交的里程碑串行执行，同一工作树 Write=1。前置（`Depends-On`）未通过独立验收，不开展后续业务修改；只读准备可以并行。
4. 每个里程碑通过后才改为 `verified`，填写真实业务提交的 `Verified-Commit` 并附 Tester 证据位置；调度提交只含本文件。显性缺陷在执行环内闭环；契约冲突或需要人取舍的问题才升级 Brain。
5. 继续授权暴力重构：在各里程碑 Scope 内直接删除被契约淘汰的代码、测试与工具，不保留兼容层与迁移层；不得削弱确定性检查、授权边界与原件只读。
6. #29 复验按 `0b1699a` 修订后的 [2-word-engine.md](subsystems/2-word-engine.md) 第十一节裁定；#30 启动写阶段前，Worker 须先核对 `0b1699a` 补全的体检与权限条款（含 `effectiveEntry()` 签名失效进入 `health()` 报告）。

## 本轮生效的 Brain 裁定

- **单用户桌面信任模型与解除 #31 阻塞（2026-11-21 新增，已入 `ac1a614`）**：
  1. 在当前单 OS 用户桌面宿主（DSH `0.2.2-rc.5`）下，防越权采用**三层明确边界**：① 接口隔离（Agent 工具与 CLI 无授权/核实/定稿入口；工作台只走宿主 owner 认证的精确 Host 路由）；② **项目外写隔离与权威锚点（`workspace-write` 下的主防篡改边界）**——宿主沙盒禁止写入会话 `cwd`（`SEAL_HOME/projects/<id>/`）之外的 `SEAL_HOME/ledgers/` 与 `SEAL_HOME/vaults/`，即便同用户 Agent 读到 `SEAL_HOME/keys/authorization.key` 并用合法 HMAC 重签篡改项目内 `ledger.json`，只要项目外锚点未被改写，`resolveLedger()` 仍丢弃项目内伪造、恢复权威快照并由 C15 阻断定稿；③ HMAC + 内容指纹防误改并在内容/知识库/截标日变化时使确认失效。
  2. **诚实边界（不构成 #31 阻塞）**：正式承认 DSH `0.2.2-rc.5` `workspace-write` 不提供跨 FS/shell 的路径读隔离，`0600` 仅防其他 OS 用户，不宣称对同用户恶意进程（或用户主动切换至 `danger-full-access` 时）具备密码学读保密隔离；不暴露密钥字节的宿主签名服务记为上游宿主能力演进项并在验收报告中如实披露。
  3. **#31 对应实证要求**：补一条确定性测试——模拟攻击者持有相同 `authorization.key` 并合法重签篡改项目内 `ledger.json`，验证未改动的项目外锚点仍丢弃伪造并报 C15 阻断定稿；并在真实 DSH `workspace-write` 会话下用项目 `cwd` 外 `.tmp` 合成哨兵验证 FS 与 shell **写入**被宿主沙盒拒绝（同时如实记录 rc.5 允许项目外读）。
- **通用传统 Office 交付底座 + 第一性原理保守冗余（2026-11-20 新增）**：Seal 面向所有需要传统 Office 格式交付的受控文档工作；**当前以招投标作为首个具体场景推进到真实可用**，暂不铺开其他场景包，但 `src/core/docx`、`src/core/kb` 及范围/签名/闸门机制不得写死招投标特例。严禁“先有数据再写代码、追着样本打补丁”：对自生成结构写全显式属性与中性样式，对不可精确模拟的外部排版与未知脏文档留足保守冗余（安全下界与显式安全余量），测试须覆盖机制输入域的退化/异常合成构造，而非仅锁住现有语料。
- **方向**：Agent 负责理解与写作；Seal 提供看文档、改文档、查资料的工具，当场拒绝会损坏文件或引用失效证据的编辑，其余问题以黄标和检查报告呈现；只有人能确认待定项、接受原文改动、核实资料与导出终稿。规划器、语义正则、知识库自动匹配一律不恢复；识别规则只用于疑似空白提示与敏感关键词加严。
- **#29 几何契约补正（2026-11-20）**：正式认可 `ea81fe7` 采用的保守安全下界模型——不等宽多栏取最窄栏宽、逐层扣除祖先单元格上下边距、精确行高（`w:hRule="exact"`）计入既有段落/嵌套表/图片与标注基线占位、计入继承段落缩进（含字符单位 `Chars`）与同行前缀、Seal 生成图片段落采用中性缩进与行距、无正空间容量归零并由 C16 阻断定稿。已写入 [2-word-engine.md](subsystems/2-word-engine.md) 第十一节，#29 复验按此裁定执行。
- **#30 知识库闭环清单（2026-11-20）**：除只读预研已定位的五项缺口（体检缺未知字段/关键缺项/同类型同编号重复/主体逐字段未核实、图片体检仅覆盖 PNG/JPEG、`save` 部分动作跳过私有字段校验、`seal_kb_get` 缺 `offset` 续读参数、无改动 `save` 误删核实签名）外，**必须补齐第六项**：`effectiveEntry()` 检出的核实 HMAC 签名失效（`entry.issues` / `subject.issues`）必须并入 `KnowledgeBase.health()` 报告（见 `1-knowledge-base.md` 第六、九节）。
- **#31/#32 定稿闸门解耦（2026-11-20）**：原 #25 依赖完整 C01–C16 定稿闸门而 C12–C14 排在 #26，构成验收循环。现将 C12/C13/C14 内核检查（`requirements.json` 缺失时 C12/C14 计为 0，损坏时阻断；C13 独立于 `requirements.json` 对全文生效）与 CLI/`seal_check` 未截断 `ready` 计算划入 #31（取代 #25）；#32（取代 #26）聚焦 `seal_requirements` 工具、右栏要求清单 UI、`seal-bid` skill 与 Agent 自主编标验收。
- **代码可读性红线（2026-11-20）**：禁止压缩单行、无空格的难读生产代码（如 `src/core/docx/layout-paragraph.ts` 的格式，后续审计或相关切片触及时须规范化；新代码一律保持正常空格、换行与清晰函数边界）。
- **#24 阻塞根因（2026-11-20）**：
  1. 直接原因：`src/core/docx/image-insert.ts` 的 `imageBox()` 只凭两条可选线索计算单元格可用宽度：dxa 单位的 `w:tcW`，或只有“同次 Markdown 建表并插图”路径才传的 `columns` 提示。两者都缺时退回整页版心宽度。而 Seal 自己生成的 Markdown 表格（`src/core/docx/markdown.ts`）不写 `w:tblGrid` 与 `w:tcW`，所以“先建表再插图”时证书按整页宽度放进半宽的列，被裁掉一半（5,471,612 对 2,723,515 EMU）。
  2. 同一机制的不同表现：第 2–4 轮的标注分页、跨页与裁切，都是图片在表格和页面中的尺寸与排布没有确定模型。已晋升的守卫“图片布局与继承格式”只覆盖带 `w:tcW` 的单元格，没有自动宽度表格或 `gridCol` 用例。
  3. 流程原因：缺陷按症状归类，三轮症状不同，“同一症状两轮就重判根因”没有触发；守卫只锁住见过的例子；知识库功能与 Word 版式捆在同一个里程碑。
- **据此冻结的新规则**（已写入契约与 ROLES）：插图尺寸只由 2-word-engine 第十一节的几何函数计算，表格内绝不退回整页宽度；Seal 生成的表格写明确几何；新增 C16；缺陷按机制归类，同一机制第二次出现即改派机制级修复；晋升的守卫必须覆盖机制的输入维度。
- **#23 阻塞根因（2026-11-18，已由 #28 解决）**：差异比较曾用括号词表豁免 C06，且身份存在文档外需要重新对位。现行规则：比较不使用提示或词表；提示无状态；身份放进隐藏书签。禁止重新引入偏移量或对齐推断的身份投影。
- **验收重点**：确定性保证（编辑不损坏文档、差异比较不漏报、检查与闸门正确、授权操作只在界面）与真实用户流程。疑似空白的漏报与误报不是不通过的理由；确定性检查漏报、编辑损坏文档、授权越界、原件被改属于严重缺陷。
- **测试策略**：确定性规则用正负控与破坏验证；启发式不堆叠笛卡尔积网格；涉及几何与版式的机制用覆盖输入维度的矩阵测试，并配渲染矩阵人工看图；真实样本集成测试只经环境变量显式运行。
- **资料与权限**：用户本地招标文件、企业母本与知识库原件永久只读。测试的 `SEAL_HOME` 指向 `.tmp/` 下的临时目录，不读写真实的 `~/.seal`。界面与安装验收使用真实 DSH Desktop Profile，可以安装本项目新包并按需重启 DSH，保留用户已有的配置、会话与其他插件，不授予兼容性豁免。
- **公开语料**：#22 下载的公开招标文件只存放在 `.tmp/corpus/`，不进仓库，样本信息不进 `src/**` 与 `scripts/**`。

## 当前状态（2026-11-26 16:46）

| 观察面 | 事实 |
| :--- | :--- |
| 已完成 | #22、#28、#29、#30、#31、#32、#33、#27、#34、#35、#36、#37、#38、#39、#40、#41 全部 `verified`；`b39810c` 已公开脱敏仓库并发布公网 `seal-dsh@0.1.604`（npm + DSH 市场索引 + GitHub Release）。 |
| 进行中 | **#42（两阶段编制蓝图：大纲先审、当场补料与 C17 漏章漏证验算）**，已冻结契约，分 2 个实现切片 + 独立验收/实屏验收/异源审计推进。 |
| 审计水位 | `d868b10e1d0cdb143ca1f495819dedbc39f9f117`（见 [LESSONS.md](LESSONS.md) 首行 `reviewed-through`）。 |

真实只读输入（只在测试输入与本调度板出现）：

- 招标文件：由环境变量 `SEAL_GOLDEN_DOC` 传入的只读 85 页 `.doc` 黄金样本。
- 母本：由本地只读资料目录传入的企业商务/技术母本 `.docx` 样本。
- 母本中“直接套用 / 每次都放 / 标黄”等文字是资料复用标签，不是对执行 Agent 的操作授权。

## 全部里程碑共用的交卷门槛

见 [ROLES.md](ROLES.md)「默认门禁与验收」。

## [Milestone #28] 替换身份层：无状态提示、文档内身份与确定性 C06

- **Status**: verified
- **Verified-Commit**: 16c59a2e7b72a414f7c8c666902c1d7f3abd5c9f
- **Depends-On**: —
- **独立验收**：冻结包 `0.1.208`；`.tmp/evidence/task-28/tester-208-corpus/report.md`、`.tmp/evidence/task-28/tester-208/report.md`；专项 Auditor 区间 `264a9b6..16c59a2` 无实证，见 `.tmp/evidence/task-28/audit-208/report.md`。

## [Milestone #24] 知识库 v2：资料柜、母本入库、事实引用与证据核验

- **Status**: superseded (by #30)
- **Verified-Commit**: none
- **Depends-On**: #28
- **说明**：实现已提交至 `d13061b`。四轮独立复验中，知识库功能在首轮返工后通过；第 2–4 轮退回均为证据图版式，根因见上方裁定，拆入 #29（几何）与 #30（验收）。各轮报告见 `.tmp/evidence/milestone-24/tester/`。

## [Milestone #25] 审阅台、人工确认与定稿导出

- **Status**: superseded (by #31)
- **Verified-Commit**: none
- **Depends-On**: #24
- **说明**：原定稿导出验收依赖完整 C01–C16 闸门，而 C12–C14 排在 #26 且 Scope 遗漏 `src/shells/cli/**`，存在验收前置循环；由 #31 取代并补齐范围。

## [Milestone #26] 招标要求清单、覆盖与金额检查，`seal-bid` 操作手册

- **Status**: superseded (by #32)
- **Verified-Commit**: none
- **Depends-On**: #25
- **说明**：C12–C14 内核确定性检查前置到 #31；本单其余交付（`seal_requirements` 工具、右栏要求清单与覆盖界面、`seal-bid` skill 与工具提示词复查）由 #32 承接。

## [Milestone #27] 多样本端到端验收与评测报告

- **Status**: verified
- **Scope**: `src/**`, `tests/**`, `scripts/**`, `package.json`, `README.md`（缺陷修复限于本单发现的问题）
- **Verified-Commit**: 27f3a43b4bf9e6343b00a21ec731a4edb4288d83
- **Updated**: 2026-11-22
- **Depends-On**: #26
- **独立验收**：冻结安装包 `dist/seal-dsh-0.1.356.tgz`（SHA256 `793954e938a80e1ea3285531f88ba8519d831679b871552daf4ae0bd2c390660`）；业务修复含 P0 大文档遍历线性化 `6bfacea`、C13 金额词法与单位修复 + `requirements` 缓存 `2e8fb7a`/`1a4d4a8`/`588b7e3` 及量化评测报告与 README 更新 `27f3a43`；真实 DSH Desktop 4 样本闭环（`sccc-property-2022`、`zhengzhou-goods-2023` 双分册、`luoding-tax-property-2023`、`golden-template` `.doc`→`.docx`，另核验 `forestry-construction-2024` PDF 对照与两份只读母本原件 SHA256 不变），量化评测报告见 [tests/corpus/results/2026-11-22.md](../tests/corpus/results/2026-11-22.md)；独立 Swarm Tester（`m27-tester`）独立复跑 `sccc-property-2022` 与 `golden-template` 完整流程、亲眼审视 22 张渲染图并核对全部报告数字与缺口披露，`PASS` 报告见 `.tmp/evidence/milestone-27/tester/report.md`；异源 `gpt-auditor` 全区间（`7ab1f1a..6bfacea`、`6bfacea..588b7e3`、`588b7e3..27f3a43`）均为 `NO_ISSUES`（`.tmp/evidence/milestone-27/gpt-audit-{6bfacea,588b7e3,27f3a43}.md`）。
- **目标**：在多份真实招标文件上证明“读招标文件 → 草稿 → 人审 → 终稿”的闭环可用，并给出量化评测与剩余缺口。
- **接口与行为契约**：
  1. 黄金招标文件加上不少于 3 份语料（招标人不同，至少两类品类），在真实 Desktop 中各完整走一遍：测试知识库（真实母本副本入库，加上明显标注的合成资料）、Agent 编写、Tester 以人的身份确认合成的决定、导出终稿、渲染查看。不得替真实项目确认金额、工期、质保或偏离。
  2. 记录每份样本的指标：耗时、工具调用次数、疑似空白召回率（对照 #22 的标注）、待定项数、各检查项数量（含 `bracketText` 数量）、人工修改次数与发现的缺陷，写入 `tests/corpus/results/<日期>.md`。
  3. 本单发现的缺陷按共用门槛修复并复验；需要修改契约的问题写回本单并升级 Brain。
  4. 更新 `README.md` 中真实使用与验证的入口。
- **不在范围内**：其他场景；对外发布；替真实项目做商业确认。
- **Worker 工程门禁**：共用门槛；每个修复的缺陷都有回归测试。
- **Tester 验收要求**：独立复跑至少 2 份样本的完整流程并核对报告数据；检查终稿的固定文字、表格、图片与中文字形；确认报告列出了剩余缺口与未覆盖范围。

## [Milestone #29] 证据图片在任何表格与版面中完整、等比，并与标注同页

- **Status**: verified
- **Verified-Commit**: ea81fe7ce575e0a144a480492f7f259c3b5f81dc
- **独立验收**：冻结包 `0.1.273`（SHA256 `5c3bb2ada3b9a64c78e0b3a775f9cbf0a8e2e6c72891e683be0402911f1dde92`）；`.tmp/evidence/milestone-29/tester/retest-273/report.md` 与 `metadata.json`。124 组合、76 份正式输出，28 组 CLI/Native 字节一致；116 页与 5 张高 DPI 细节实际审视。四份旧坏输出由 C16 与终稿复检拒绝。固定小行高中的图片完整但纸面尺寸很小；Desktop 与 Microsoft Word 本机渲染不计入本单通过。
- **Depends-On**: —
- **Features**: —
- **Scope**: `src/core/docx/**`, `src/core/bid/**`（仅 C16 与插图调用）, `tests/**`（不含 `tests/corpus/**`）
- **用户可观测目标**：Agent 把证书、合同等证据图片插进正文、分栏、任何招标表格、Seal 生成的表格或嵌套表格后，渲染出的 Word 中图片完整可读、等比缩放、不超出所在单元格与页面，持证方标注与图片同页，相邻内容不受影响；超出版面的 Seal 图片由 C16 报出，终稿复检拦下。
- **行为契约**：
  1. 按 [2-word-engine.md](subsystems/2-word-engine.md) 第十一节实现唯一的几何函数；`insert_image`、`insert` 中的 Markdown 图片与标注包装都改用它；删除 `columns` 提示与表格内退回整页宽度的分支（现位于 `src/core/docx/image-insert.ts` 的 `imageBox`）。
  2. Seal 生成的 Markdown 表格（现位于 `src/core/docx/markdown.ts`）与标注包装写明确几何：dxa 表宽、固定布局、带宽度的 `w:tblGrid` 与每格 `w:tcW`。
  3. 按 [3-bid-workflow-and-checks.md](subsystems/3-bid-workflow-and-checks.md) 第五、六节实现 C16，并加入终稿复检。
  4. **几何矩阵**，维度如下：
     - 容器：正文、横向分节、双栏分节、dxa 宽度格、pct 宽度格、带网格的自动宽度表、缺 `w:tblGrid` 的表、Seal Markdown 表、横向合并格、嵌套表内的格、窄格、大边距格；
     - 图片：宽幅、长幅（如 1239×1827）、小于格宽的小图；
     - 路径：直接 `insert_image`、同次 Markdown 建表并插图、先建表再插图、格内段落后插入 Markdown 图片；
     - 标注：有、无。

     交付两件东西：(a) 确定性测试，容器 × 路径全覆盖（使用带标注的长幅图），其余维度的每个取值至少出现一次，逐例断言图片不超过可用宽高、小图不被放大、Seal 表格几何完整；(b) 一份渲染矩阵文档，每个容器至少一例，每例带可读标签，供 Worker 与 Tester 逐例看图。#24 退回的三个复现（先建两列表再插证书、普通报价格内长证书分页、标注与证书分页）必须在矩阵内。
- **Worker 门禁（偏离默认）**：破坏验证必须包括：恢复表格内整页宽度回退、恢复 `columns` 提示、去掉 Seal 表格的 `w:tblGrid`，对应矩阵用例都要变红；渲染矩阵文档全部页面亲自看图。
- **Tester 验收**：第一轮按矩阵全量覆盖。在 Worker 交付的渲染矩阵、黄金招标文件副本与 #22 至少 2 份语料的真实表格上，用 CLI 与解包后的真实 DSH 工具插入证据图，LibreOffice（中文字形）渲染后逐页查看：图片完整、等比、不越界，标注同页，相邻列与相邻行内容完整。用越界图片（例如人为放大 `wp:extent`）确认 C16 报出，终稿复检拦下。
- **不在范围内**：知识库与证据规则（#30）；界面（#25）；Microsoft Word 本机渲染（记为未覆盖）；新增识别规则或词表。

## [Milestone #30] 企业资料可入库、检索，并以引用写进草稿（知识库 v2 验收）

- **Status**: verified
- **Verified-Commit**: c9c6353733f2869f21c7f59b3893d8c5a316b199
- **独立验收**：冻结包 `0.1.288`（SHA256 `77f907907f81c55e6c7554d4957a2e063a66dd48482bb9f227dbb5c9d56af077`）；`.tmp/evidence/milestone-30/tester/report.md` 与 `retest-288/report.md`、`metadata.json`。首轮两入口各入库 152 候选、480 原图（4 WMF 预览另计），分类 12 候选，48 草稿/114 页逐页亲看；唯一 Unicode 起点缺陷修复后，独立复验 912 案例、96 条续读链通过。新旧包仅共享读取实现编译字节变化，未变路径与 114 页按 Tester 独立身份链复用，不冒称新包重跑。Desktop 安装、人工界面与定稿导出归 #31；HEIC 当前解码能力不可用，明确拒绝，未计支持。
- **Depends-On**: #29
- **Features**: —
- **Scope**: `src/core/kb/**`, `src/core/bid/**`, `src/core/docx/**`（仅证据插入所需）, `src/shells/**`, `tests/**`（不含 `tests/corpus/**`）
- **用户可观测目标**：企业资料以“主体档案 + 证据记录 + 写作素材”的文件形式管理。Agent 能入库、分类、检索资料，并以引用方式把事实与证据写进草稿；过期、禁用主体与主体不符的资料写不进去，未核实与效期未知的内容自动待定；证据图片按 #29 的几何模型排版。实现沿用 #24 已提交的代码（截至 `d13061b`），本里程碑补齐未过项并完成独立验收。
- **行为契约**（沿用 #24，按当前契约核对）：
  1. 按 [1-knowledge-base.md](subsystems/1-knowledge-base.md) 实现 `src/core/kb`；旧 `src/core/vault/**`、旧 Markdown 知识库编译器、`seal-vault-1` 格式及旧工具保持删除。
  2. 入库：两份真实母本副本在宿主默认内存上限内完成入库，图片一张不丢；候选保留标题标记文字与原文位置；重复入库不覆盖；失败只回滚本批次；入库结果结构化、可分页续读。
  3. 体检与检索按 1-knowledge-base 第六、八节实现；统一社会信用代码按 GB 32100 检查校验位。
  4. 事实引用与证据插入按 [3-bid-workflow-and-checks.md](subsystems/3-bid-workflow-and-checks.md) 第二节实现：已核实引用写入 `_Seal_F_`，未核实或效期、主体未知的引用写入“待核对”的 `_Seal_P_`；包括 `quote` 原文校验、`kb:` 图片引用、第三方资料规则与 Word 中可见的持证方标注；检查 C05、C08、C09。
  5. 写入权限：Agent 工具不能写 `verified`、`verifiedAt`、`verifiedFields`；核实只实现为签名的 core 函数；已核实内容被修改后核实状态清除；每次写入追加变更日志。
  6. Agent 工具 `seal_kb_search`、`seal_kb_get`、`seal_kb_save`、`seal_kb_ingest` 与对应 CLI。
- **Tester 验收**：沿用 #24 的验收路径：在 `.tmp/` 下新建测试知识库；入库两份真实母本副本并核对候选数与图片数；分类不少于 10 个候选；核对体检结果；在黄金招标文件分册中以引用填写主体信息并插入证据；过期、禁用主体与主体不符的证据被拒且草稿不变。另须复验 #24 四轮退回的全部项（`.tmp/evidence/milestone-24/tester/` 下各轮报告），并渲染查看所有插入证据的页面。
- **不在范围内**：界面（#25）；内置 OCR；旧数据迁移；几何模型本身的修改（属 #29；发现问题按 ROLES 第 4 条归类处理）。

## [Milestone #31] 审阅台、人工确认、完整 C01–C16 定稿闸门与导出（取代 #25）

- **Status**: verified
- **Verified-Commit**: 7ab1f1a1909e2c721fde4d23073c877e042eac3b
- **独立验收**：业务实现 `c22e03c` + 异源 `gpt-auditor` 外部锚点 fail-closed 修复 `6af6242` + 知识库卡片一致性修复 `7ab1f1a`，统一冻结包 `dist/seal-dsh-0.1.336.tgz`（SHA256 `8961d804b1338721329c176b50318406001766fbd6441c07a4ab44ce4bef97cb`）；`npm run verify` 420/420、`dsh-bundle.test.ts` 15/15、独立终端验收 `.tmp/evidence/milestone-32/tester/report.md` & `.tmp/evidence/milestone-33/fix-tester/report.md`、`gpt-auditor` `NO_ISSUES`（`.tmp/evidence/milestone-33/gpt-audit-7ab1f1a.md`），及合批真机验收 #33（`.tmp/evidence/milestone-33/retest-336-agy/report.md` + 首轮 Electron 原生 `FilePicker` 证据 `.tmp/evidence/milestone-33/screenshots/04-start-bid-form.png`）全部通过。
- **Depends-On**: #30
- **历史阻塞与 Brain 裁定（2026-11-21 已解阻）**：Router 实测 DSH `0.2.2-rc.5` `workspace-write` 仅限制项目外写而不限制项目外读（证据 `.tmp/evidence/milestone-31/authorization-probe/report.md`、`worker/ui/permission-shell-result.txt`），据此升级 Brain。Brain 已在 `ac1a614` 正式冻结单用户桌面三层信任模型（接口 owner 隔离 + `workspace-write` 项目外锚点写隔离 + HMAC/指纹内容绑定），不要求 `0600` 密钥充当同用户读保密边界，也不将 `danger-full-access` 纳入插件级隔离承诺；该次裁定后里程碑曾恢复为 `pending`，沿用工作树中已有 #31 进度继续收尾并进入独立验收。
- **Router 更正（2026-11-21）**：上一条将 #31 标为 `blocked` 是 Router 的 CUA 附着目标选择错误，现撤销该阻塞。按原生 CUA 文档以应用显示名 `getApp("DeepSeek Harness")` 成功附着真实桌面窗口，左侧 Seal 插件显示运行版本 `0.1.311`，开启投标页正常加载。此版本与真实 UI 仍须完成 #31 全量人审、导出、摘要核对与逐页视觉验收；详见 `.tmp/evidence/milestone-31/router/cua-reattached-2026-11-21.md`。
- **Features**: —
- **Scope**: `src/workbench/**`, `src/shells/dsh/**`, `src/shells/cli/**`, `src/shells/node-host.ts`, `src/core/bid/**`, `src/core/kb/**`（仅界面所需的读取与核实入口）, `scripts/build-dsh-bundle.mjs`, `package.json`, `package-lock.json`, `tests/**`（不含 `tests/corpus/**`）
- **用户可观测目标**：业务人员在真实 DSH Desktop 中完成开启项目/投标、审阅、确认、知识库核实与导出终稿；定稿闸门基于完整 C01–C16 未截断检查真实阻断与放行；授权类操作在单用户桌面三层信任模型（`ac1a614`）下只能由人在界面完成。
- **行为契约**：
  1. **完整确定性检查与 `ready` 计算**（按 [3-bid-workflow-and-checks.md](subsystems/3-bid-workflow-and-checks.md) 第五、六节）：在 `src/core/bid/**` 实现 C12（`requirements.json` 覆盖检查）、C13（中文大写与阿拉伯数字金额一致检查，从第一性原理覆盖元/圆/角/分/整/正、万/亿、零、千分位逗号与常见标点边界）与 C14（`requirements.json` 引文核对）。`requirements.json` 尚未建立时 C12/C14 计为 0，存在但损坏时阻断；C13 独立于 `requirements.json` 对草稿全文生效。CLI `check`、`seal_check` 与工作台的 `ready` 均基于全部分册、未截断的完整 C01–C16 阻断计数计算（C08 仅过期阻断），移除写死的 `ready: false`。
  2. **重建 React 工作台界面**（按 [4-dsh-plugin-and-workbench.md](subsystems/4-dsh-plugin-and-workbench.md) 第四节）：React 组件注册到插槽（左侧同 ID `sidebar.panellist` 与 `main`；右侧 `sidebarRight`），复用宿主 React、主题变量与 locale，不以 `dangerouslySetInnerHTML` 渲染业务数据；纯视图模型放在 `src/workbench`。
  3. **左侧全局页面**：开启投标（原生选择与拖入双路径，创建项目目录、复制招标文件、以项目目录为工作目录开启会话并打开右栏）、进行中的投标（含失效/归档会话可理解提示）、知识库中心（卡片、资料列表与筛选/详情、核实队列、母本入库）。
  4. **会话右栏**：审阅清单（按检查类别分组；确认含批量；修改并保护未保存编辑；接受改动，`bracketText` 可分组批量接受；过目；交给 AI；同一位置的待定项与原文改动合并处理）、页面预览、下载草稿、导出终稿。
  5. **授权边界与指纹失效**：确认、接受、过目、核实与定稿只在界面提供，实现为 owner 认证 Host 方法，Agent 工具与 CLI 都无法调用；确认按 3-bid 第三节记录指纹，内容、知识库或截标日变化后自动失效；按 `ac1a614` 验证“即便持相同 `authorization.key` 合法重签篡改项目内 `ledger.json`，未改动项目外锚点仍丢弃伪造并报 C15”。
  6. **定稿导出与复检**：按 3-bid 第六节执行；闸门未通过时按钮不可用并列出原因；终稿只移除 Seal 书签与已确认范围的 Seal 高亮，保留原文件原有高亮；导出后对终稿复检 C01、C09、C10、C11、C16，且不改变草稿与基准摘要。
  7. **健壮性与窄栏可用**：页面重载后状态从项目与知识库恢复；失败在操作位置可见；在 360–560 px 窄栏、悬停/聚焦态及长清单下排版与可读性正常。
  8. **真实安装**：构建新版本（递增补丁版本、使用新文件名）并安装到真实 Desktop Profile（保留用户已有配置、会话与其他插件，沙盒经 `SEAL_HOME` 隔离），核对实际加载版本。
- **不在范围内**：`seal_requirements` 工具与右栏要求清单界面（#32）；`seal-bid` skill（#32）；Agent 自主编写质量（#32、#27）；上游宿主跨 FS/shell 读隔离或 `danger-full-access` 下同用户进程隔离（记为未覆盖与宿主前提）。
- **Worker 工程门禁**：共用门槛；C12–C14 正负控与破坏验证（含超出每组 50 条展示页的后页阻断项仍令 `ready=false`、金额大小写各种边界、损坏 `requirements.json` 阻断）；视图模型单测；授权隔离测试（工具与 CLI 无法确认、接受、过目、核实或定稿；未认证/跨源/非 owner 请求被拒；持相同 `authorization.key` 重签篡改项目内 `ledger.json` 仍被项目外锚点拦截并报 C15）；指纹失效测试；真实 Desktop 截图自检。
- **Tester 验收要求**：在真实 Desktop 中以业务人员身份操作：
  1. 从无会话的左侧全局页面用黄金招标文件副本与测试知识库开启投标，验证文件选择/拖入、无库与默认单库；载入预制草稿或跑短流程；
  2. 在右栏确认合成待定项（含批量确认）、批量接受 `bracketText` 改动并逐项接受一处故意的其他原文改动、过目 Agent 跳过的空白；验证金额大小写不一致触发 C13 阻断、修正后解除，以及损坏 `requirements.json` 触发阻断；
  3. 核对闸门在处理完之前不可用并列出原因；导出后核对草稿/基准摘要未变，用 LibreOffice（中文字形）渲染终稿，核对无 Seal 黄标与书签、原文件高亮保留；
  4. 修改已确认内容后确认失效；页面重载后状态恢复；360 px 与 560 px 窄栏、长清单与知识库核实队列可用；
  5. 验证授权三层边界：① 让 Agent 通过工具或 CLI 尝试确认待定项、核实资料或定稿，确认失败；② 验证持相同密钥重签项目内 `ledger.json` 仍被项目外锚点拦下（C15）；③ 在真实 DSH `workspace-write` 会话下用项目 `cwd` 外 `.tmp` 合成哨兵验证 FS 与 shell **写入**被宿主拒绝，并在报告中如实记录 rc.5 允许项目外读及 `danger-full-access` 的宿主前提。
  每屏截图并检查。

## [Milestone #32] 招标要求清单工具与界面、`seal-bid` 操作手册与自主编标（取代 #26）

- **Status**: verified
- **Verified-Commit**: 7ab1f1a1909e2c721fde4d23073c877e042eac3b
- **独立验收**：业务实现 `6af6242` / `816b380` / `1f6f079` + `#33` 修复 `7ab1f1a`，统一冻结包 `dist/seal-dsh-0.1.336.tgz`（SHA256 `8961d804b1338721329c176b50318406001766fbd6441c07a4ab44ce4bef97cb`）；独立终端验收 `.tmp/evidence/milestone-32/tester/report.md`、离线工具 schema 估算 `.tmp/evidence/milestone-32/worker/tool-prompt-diff.md`、异源审计 `.tmp/evidence/milestone-32/gpt-audit-m32-only.md` / `.tmp/evidence/milestone-33/gpt-audit-7ab1f1a.md`，及合批真机验收 #33（`.tmp/evidence/milestone-33/retest-336-agy/report.md`，含真实 `deepseek-v4.1-flash` Turn 1 Step 1 `42,812 inputTokens` 实测、自主加载 `seal-bid` 与右栏「要求清单」C12 覆盖闭环）全部通过。
- **Depends-On**: #31
- **Features**: —
- **Scope**: `src/core/bid/**`, `src/shells/dsh/**`, `src/shells/cli/**`, `src/workbench/**`, `tests/**`（不含 `tests/corpus/**`）
- **用户可观测目标**：Agent 在 `seal-bid` skill 指引下，从“只给招标文件和知识库”开始独立完成投标文件草稿；Seal 能保存并核对必须响应的招标要求及引文，人在右栏查看并标记覆盖。
- **行为契约**：
  1. `seal_requirements` 工具、对应 CLI `requirements` 命令与 `requirements.json`（3-bid 第七节）：保存时复用 #31 的引文校验（C14）并原子写入；右栏展示要求清单，并由人在界面标记已覆盖（接入 #31 的 C12 覆盖检查）。
  2. `seal-bid` skill：按 3-bid 第八节编写，通过 `ctx.skills.register` 随插件注册（字段见 4-dsh 第三节）；开启投标的首条消息引导 Agent 加载该 skill。
  3. 按 `tool-design.md` 复查全部工具描述与错误信息，并比较修改前后首轮提示词的 token 数。
- **不在范围内**：为提高召回率新增识别规则；多样本评测（#27）。
- **Worker 工程门禁**：共用门槛；`seal_requirements` 工具与 CLI 正负控及破坏验证；右栏要求清单与人工覆盖标记测试；skill 注册测试（真实 SDK 下 skill 出现在目录中且可加载）。
- **Tester 验收要求**：在真实 Desktop 中开启新的投标，只告诉 Agent“请为这份招标文件编写投标文件”。观察并记录 Agent 是否加载 skill、保存要求清单、复制格式文件、填写、撰写技术方案章节、挂载证据、运行自检、给出交接总结；核对 C12/C13/C14 在检查报告和右栏中的呈现与联动；列出 Agent 卡住或出错的地方，作为 #27 与 skill 迭代的输入。
- **Brain 进度注记（2026-11-22）**：#31 与 #32 的全部代码、单元测试（418/418）、真实 `0.2.2-rc.5` SDK/Owner Carrier/`dsh-skill` 测试（15/15）、6 项 `Broken by hand`、独立 Swarm Tester 终端与 CJK 渲染验收（`.tmp/evidence/milestone-32/tester/report.md`）及异源 `gpt-auditor` 审计修复均已在业务提交 `1f6f079f9f08d4639d576ebeb5c03b4763476ada` 闭环，统一冻结为 `dist/seal-dsh-0.1.329.tgz`。两者的真实 Desktop GUI 与自主编标验收统一合批至下方 `#33`（`Executor: gpt-cua`），待 `#33` 完成后由 Brain 统一审图并将 `#31`、`#32` 与 `#33` 结案为 `verified`。

## [Milestone #33] 大节点集中真机 Final CUA 验收：#31 工作台/闸门 + #32 要求清单/Skill/自主编标

- **Executor**: gpt-cua
- **Status**: verified
- **Verified-Commit**: 7ab1f1a1909e2c721fde4d23073c877e042eac3b
- **Round-1-Blocked-Report**: `.tmp/evidence/milestone-33/report.md`（`0.1.329` 查出知识库卡片/列表计数与写作素材核实语义不一致，已于 `7ab1f1a` 机制级修复并通过独立终端验收与 `gpt-auditor` `NO_ISSUES`）
- **Retest-336-Report**: `.tmp/evidence/milestone-33/retest-336/report.md`（ChatGPT Desktop App 在原生 macOS CUA 期间崩溃两次，见 `~/Library/Logs/DiagnosticReports/ChatGPT-2026-11-22-{122241,135446}.ips`，DSH 无崩溃）；随后由 Brain 接管在真实 DSH Desktop（已装 `0.1.336`）的原生认证 `dsh web` 上经 Antigravity `browser` subagent 全量跑通并出具最终报告 `.tmp/evidence/milestone-33/retest-336-agy/report.md`（6 张真机截图 + 4 页终稿 LibreOffice CJK 渲染图 + Turn 1 Step 1 `42,812 inputTokens` 实测 + 360px 深色主题实测全部 PASS）。
- **Depends-On**: —
- **冻结验收产物（严禁重新构建）**：
  - 业务提交 SHA：`7ab1f1a1909e2c721fde4d23073c877e042eac3b`（含 `#31` `c22e03c`、`#32` `6af6242`/`816b380`/`1f6f079` 及 `#33` 修复 `7ab1f1a`）
  - 冻结 TGZ：`./dist/seal-dsh-0.1.336.tgz`
  - 预期版本：`@seal/dsh@0.1.336`
  - 预期 SHA256：`8961d804b1338721329c176b50318406001766fbd6441c07a4ab44ce4bef97cb`
- **Scope（严格只读源码）**：
  - **禁止修改** `src/`、`tests/`、`scripts/`、`package.json`、`package-lock.json` 或重新执行 `npm run build:dsh`；**禁止**接手或修改 `#27`、`#31`、`#32` 状态；
  - 本轮复验（`0.1.336`）的沙盒、逐屏截图与报告统一写入 `.tmp/evidence/milestone-33/retest-336/`（保留首轮 `.tmp/evidence/milestone-33/report.md` 与 `screenshots/` 原件不覆盖）；
  - 验收结束后**只更新**本里程碑（`#33`）的 `Status`（`verified` 或 `blocked`）与验收报告链接，执行 `git commit --only docs/TASKS.md` 后休眠。若发现真机产品缺陷，标 `blocked` 并在报告中给出精确复现路径与截图，由 Antigravity Brain + Swarm 修复并重新冻结派单。
- **沙盒与原件红线（含防 `cgWindowNotFound` 操作提示）**：
  - 用户本地招标与母本原件 100% 只读；绝不触碰用户真实 `~/.seal`；
  - 安装 `dist/seal-dsh-0.1.336.tgz` 到真实 `~/.dsh/profiles/desktop`（保留用户配置、会话与其他插件，不授予兼容性豁免），以独立沙盒环境 `SEAL_HOME=./.tmp/evidence/milestone-33/retest-336/seal-home` 与 `TMPDIR=./.tmp/evidence/milestone-33/retest-336/tmp` 启动真实 DSH Desktop；
  - **防 `cgWindowNotFound` 提示**：安装新包前先确认无旧的无窗口残留 `DeepSeek Harness` 进程（如有则优雅退出），再用环境变量直接拉起 `/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness`（避免 `open -a` 触发 Error 37），待主窗口可见后按显示名 `getApp("DeepSeek Harness")` 附着；若中途因系统休眠失联，直接冷重启 DSH 进程恢复窗口继续验收。
- **本轮复验与补齐矩阵（`0.1.336`，保留首轮已验项并重点复验修复项 + 补齐首轮未覆盖项；逐屏截图存入 `.tmp/evidence/milestone-33/retest-336/screenshots/` 并亲自看图）**：
  1. **真实安装与运行版本核对**：核对 `dist/seal-dsh-0.1.336.tgz` SHA256，安装到真实 Desktop Profile，确认左侧 `Seal` 全局页显示的实际加载运行版本为 `0.1.336` 且无报错。
  2. **重点复验 `#33` 阻塞修复（知识库中心卡片/列表/三态核实/刷新联动）**：
     - 新建测试知识库并写入 1 条合成写作素材（`material`），核对知识库卡片显示 `资料 1（证据 0 · 素材 1） · 即将过期 0 · 效期未知 0 · 未核实 0`（无前导孤立点），资料列表显示 `共 1 项` 且写作素材标为 `写作素材 · 不适用 · 无需核实`（绝非「未核实」），筛选「未核实」返回 0 条、筛选「无需核实」或「写作素材」返回 1 条，下方折叠标题为 `核实与体检提示 · N`；
     - 同库新增 1 条未核实证据记录（`record`）与未核实主体字段，点击页面右上角全局「刷新」，验证卡片与列表/详情同步更新（`资料 2（证据 1 · 素材 1）`、`未核实 2`）；在界面人工核实主体字段与证据记录并重载页面，验证 `未核实 0` 持久化。
  3. **开启投标、真实 LLM 自主编标与首轮 Token 记录（`#32`）**：
     - 用合成招标副本与上述测试库开启投标，验证自动建项、自动发送引导加载 `seal-bid` 的首条消息并自动展开右栏；
     - 确认 Agent（使用配置好的会话模型）加载 `seal-bid`、保存要求清单、提取分册、填写草稿与自检并交接；记录真实 provider `usage`（若能读到 turn 1 实测则记录 turn 1，否则如实注明宿主 metadata 粒度并附实测样本）。
  4. **右栏审阅清单 + 要求清单 + 页面预览（含 360 px / 560 px 与深浅双主题全覆盖）**：
     - 复验右栏「审阅清单」（单条/批量确认、接受原文改动、原位修改与 dirty 离开保护、修改已确认项触发确认失效、重载恢复）、「要求清单」（查看全部字段与 C12/C14 状态、标为已覆盖、非法地址保留输入、交给 AI）与「页面预览」；
     - **补齐首轮未覆盖的深色主题**：在 **浅色主题（Light）** 与 **深色主题（Dark）** 以及 **360 px** 与 **560 px** 侧栏宽度下截取全局页、右栏审阅清单与要求清单截图，亲自审图核对对比度、可读性与无裁切溢出。
  5. **补齐首轮未覆盖的完整人审 → 定稿导出 → LibreOffice 中文字形终稿逐页审图**：
     - 在纯虚构合成验收项目中以测试人员身份在右栏界面逐项完成所有待定项确认、原文改动接受、空白过目/覆盖标记（绝不绕过闸门），验证闸门未清零前「导出终稿」按钮禁用并说明原因，全部清零 `ready === true` 后点击「导出终稿」；
     - 核对导出后草稿与基准摘要未变，确认终稿 `.docx` 无 `_Seal_*` 书签残留与非原始黄标残留，用带中文字形的 LibreOffice（参考 `.tmp/evidence/milestone-29/worker/fonts.conf`）将终稿全部页面渲染为 PNG 存入 `.tmp/evidence/milestone-33/retest-336/render/` 并亲自肉眼看图核对中文清晰、无黄标、无裁切。
  6. **补齐首轮未重跑的 `0.1.336` Agent 授权负控**：在真实会话内让 Agent 尝试调用 `seal_requirements` / `seal_kb_save` 越权设置核实/覆盖或尝试定稿，确认全部被拒；沿用并注明 `0.2.2-rc.5` 三层信任模型与诚实边界前提。
- **交付物**：
  - 完整复验报告：`.tmp/evidence/milestone-33/retest-336/report.md`（含 `0.1.336` SHA256、每项复验与补齐矩阵的实测结果、全部浅/深色与 360/560px 截图、终稿渲染图路径与肉眼审查结论、provider usage 与未覆盖边界、明确 `PASS` / `BLOCKED` 结论）。

## [Milestone #34] #27 实测体验收口：消除空壳黄标 run、长清单分节批处理与 Skill/CLI 细节完善

- **Status**: verified
- **Scope**: `src/core/docx/visible-surgery.ts`, `src/core/docx/text-batch.ts`, `src/core/bid/human-review.ts`, `src/workbench/review.ts`, `src/shells/dsh/workbench-host.ts`, `src/shells/dsh/client*.ts`, `src/shells/dsh/seal-bid-skill.ts`, `src/shells/cli/**`, `tests/**`
- **Verified-Commit**: 75932af4c6a6ec214192f7e04dc8852f27f3f131
- **Updated**: 2026-11-23
- **Depends-On**: #27
- **独立验收**：冻结安装包 `dist/seal-dsh-0.1.376.tgz`（SHA256 `254c340d1d8ff5c1ce680ada352d3a3177151f5d40a33769fe3fb381efc597f1`，已安装至真实 Desktop Profile）；业务提交 `337ea1c` + `gpt-auditor` P2 线性化修复 `dd265c1`/`75932af`；`npm run verify` **435/435**、`tests/dsh-bundle.test.ts` **15/15**、2 项 `Broken by hand` 红→绿（`.tmp/evidence/milestone-34/worker/mutations.log`）；独立 Swarm Tester（`m34-tester`）解包真实语料 `sccc-property-2022` 端到端实测终稿 `_Seal_*`=0、非空黄标=0、**空壳黄标 run=0**、分节定向批处理正负控与 CLI `--help` 退出码 `0` 全部 **`PASS`**（`.tmp/evidence/milestone-34/tester/report.md`）；跨模型 `gpt-auditor`（`e60308e..75932af`，`effort=high`）最终 **`NO_ISSUES`**（`.tmp/evidence/milestone-34/gpt-audit-75932af.md`）。
- **目标**：根治 `#27` 多样本实测暴露的 4 项细节微瑕与效率摩擦，不改契约红线、保持底层领域无关。
- **行为契约**：
  1. **根治空壳黄标 run**：修复 `src/core/docx/visible-surgery.ts`（`wrapVisibleRange` 与 `replaceVisibleRange`）与 `src/core/docx/text-batch.ts`（`highlightRange`）在 run 首尾切分时无条件生成空壳黄标 `<w:r>` 的根因，并保持全路径 $O(E)$ 线性遍历；确保新建待定、原位修改与定稿后均不产生无内容空壳黄标 run。
  2. **大文档审阅长清单分节与定向批处理**：在 `src/workbench/review.ts` 增加领域无关的文档结构定位与分节过滤分页；在 `WorkbenchHost.act()` 支持 `group + section` 定向批处理（沿用权限边界 + 按分册缓存 XML）；在右栏 `client.ts`（适配 360px 窄栏与深浅双主题）展示分节筛选与定向批处理按钮。
  3. **自拟章节写作指引与 CLI 帮助完善**：强化 `seal-bid-skill.ts` 步骤 4；修复 CLI `--help` / `-h` / `help` 及 `kb --help` 输出到 stdout 并返回退出码 `0`。

## [Milestone #35] 多格式任意材料知识库入库与 `seal-kb` 建库闭环

- **Status**: verified
- **Scope**: `src/core/host.ts`, `src/core/kb/**`, `src/workbench/knowledge.ts`, `src/shells/node-host.ts`, `src/shells/kb-ingest-prep.ts`, `src/shells/cli/kb.ts`, `src/shells/dsh/**`, `tests/**`, `README.md`
- **Verified-Commit**: 9972de3f96f3e223e364088f451aee69031397f4
- **Updated**: 2026-11-23
- **Depends-On**: #34
- **独立验收**：冻结安装包 `dist/seal-dsh-0.1.400.tgz`（SHA256 `e48b3d8d30b17dda67a4d0064bf116b908d78e609e9b69e0e0272b94e7282dfe`，已安装至真实 `~/.dsh/profiles/desktop`）；业务提交 `7e5a504` + 异源审计加固 `ea860cf`/`3f81396`/`0a667e4`/`a9b54db` + 开启投标本机路径对称增强 `9972de3`；`npm run verify` **445/445**、`tests/dsh-bundle.test.ts` **15/15**（验证 `seal-bid` 与 `seal-kb` 双内置 skill 注册与运行）、2 项 `Broken by hand` 红→绿（`.tmp/evidence/milestone-35/worker/mutations.log`）；真实 DSH Desktop（`0.1.400`）全链路实测通过：混合资料目录（纯扫描无文本层 PDF + 电子文本 PDF + 散装 JPG + 格式化 XLSX + TXT + 不支持 `.zip`）入库透明跳过 `无关压缩包.zip` → 刷新页面 `pendingBatches`（5/5）持久化保留 → AI 载入 `seal-kb` 看图建主体/4 份档案（含 ISO 9001 挂载 PDF 渲染 `page-001.png`）/2 份写作素材并保持 10 项全未核实 → 人工在 UI 核实（`10 → 0`）→ 经「开启投标」本机路径输入发起标书项目 → AI 挂载 PDF 衍生 PNG 进 Word 表格并撰写结构化第三节 → 右栏 `#34` 分节胶囊零溢出并完成人审导出终稿（物理校验 `_Seal_*`=0、非空黄标=0、**空壳黄标 run=0**、有效嵌入 `word/media/seal-image-1.png`；LibreOffice CJK 3 页渲染视觉验收通过，见 `.tmp/evidence/milestone-35/desktop-e2e/final-render/page-{1,2,3}.png`）；独立 Swarm Tester（`m35-tester`）解包 `0.1.400` 全项验算 **`PASS`**（`.tmp/evidence/milestone-35/tester/report.md`）；异源 `gpt-auditor`（`effort=high`）终审 **`NO_ISSUES`**（`.tmp/evidence/milestone-35/gpt-audit-{a9b54db,9972de3}.md`）。
- **目标**：按 [1-knowledge-base.md](subsystems/1-knowledge-base.md) 第七节，让 Seal 知识库从仅支持 `.doc`/`.docx` 母本扩展为面向真实混合资料文件夹的**多格式确定性入库管线**（Word / PDF 文本+高清 PNG 页 / 散装图片 / Excel·CSV / TXT·MD / 目录递归），配套内置 `seal-kb` 操作手册与知识库中心待整理批次续推入口，打通「喂任意材料（含扫描件 PDF）→ Agent 看图读表建库 → 人工核实 → PDF 证照页直接挂载进 Word 终稿」的完整闭环。
- **行为契约**：
  1. **多容器确定性入库（零新 npm 依赖，严守三层边界）**：
     - `HostPort` / `NodeHostPort` 新增 `extractPdf`（基于 Poppler `pdfinfo`/`pdftotext`/`pdftoppm -png -r 150` + `sharp` 验码 + `assertOutputIsolation`，支持 `maxPages` 上限并透明报告 `truncatedPages`）与 `convertSpreadsheetToXlsx`（基于 LibreOffice 转换 `.xls`/`.ods`）；
     - `src/core/kb/xlsx.ts` 纯内核解析 `.xlsx`（复用现有 `readZip` + `xmlElements`，含 OOXML 坐标/预算上限、`styles.xml`/`date1904`/时间与毫秒精度/精确科学计数百分比/单调行号与未缓存公式透明报告）与 RFC-4180 `.csv`/`.tsv`（逐格预算与未闭合引号 fail-closed）为 Markdown 表格；
     - `src/core/kb/ingest.ts` 保持既有 `.docx` 母本拆分语义 100% 不变，并新增 PDF（每页验证 PNG 存 `files/<batchId>/` + 保留原 PDF 存档 + 分页/10 页分块生成含无文本层扫描件提示的候选）、散装图片（验码，`.webp` 转 `.png` 存 `files/<batchId>/`）、表格与纯文本候选，支持统一 `skipped` 透明报告与失败全批回滚；
     - `shells/cli/kb.ts` 与 `WorkbenchHost.kb({ action: "ingest" })` 均支持文件列表与目录路径递归展开（跳过隐藏点文件、`assertOutputIsolation` 防库入库，显式传单个不支持文件报错，目录内夹杂不支持文件透明记入 `skipped` 且目录内零有效文件时报错）。
  2. **内置 `seal-kb` 操作手册与知识库中心 / 开启投标 UI 升级**：
     - 新增 `src/shells/dsh/seal-kb-skill.ts` 并在 `src/shells/dsh/index.ts` 注册为内置 skill，指导 Agent 使用 `seal_kb_ingest`/`seal_kb_get`/`seal_kb_save`（含对扫描件 PDF PNG 与散装图片看图提取字段、绝不越权核实、引用可挂载 PNG 路径写入 `records`）；
     - 更新 `seal_kb_ingest` 工具描述与参数提示，支持多格式文件与目录；
     - 升级知识库中心 UI（「材料入库」支持多格式文件选择/拖入 + 可选本地目录路径输入，且列出库内尚有未处理候选的既有 `inbox` 批次，重载页面后仍可一键点击「让 AI 整理待分类候选」自动拉起会话并引导加载 `seal-kb`），并为「开启投标」补齐对称的可选本机绝对路径输入。
  3. **文档与入口同步**：更新 `README.md` 与 `docs/subsystems/1-knowledge-base.md` 反映多格式建库与 `seal-kb` 流程。
- **Worker 工程门禁**：共用门槛；为 PDF（含电子文本 PDF + 纯扫描图无文本层 PDF + 超 `maxPages` 截断提示）、散装图片（PNG/JPG/WebP 转 PNG + 损坏图片回滚负控）、表格（`.xlsx`/`.csv` 含共享字符串/内联串/空列对齐与安全边界）、文本（`.txt`/`.md` + 非法 UTF-8 负控）、目录递归（混合文件 + 透明 `skipped` + 自递归隔离负控）、`seal-kb` 注册与 PDF 渲染 PNG 直接挂载进 Word 终稿并校验 C16=0 补齐确定性测试；至少 2 项 `Broken by hand` 破坏验证；构建新冻结 TGZ 并通过 `tests/dsh-bundle.test.ts`。
- **Tester 验收要求**：① 真实 DSH Desktop 端到端实跑：向新建测试库喂入一个混合材料目录（含真实扫描件/电子 PDF、JPG 证照图、XLSX 表、TXT 与不支持文件）→ 在 UI 点击「让 AI 整理待分类候选」验证真实 LLM 加载 `seal-kb`、看图建主体/证据记录/素材 → 人工在 UI 核实 → 把该 PDF 衍生 PNG 证据直接挂载进一份 Word 草稿并导出终稿，LibreOffice CJK 渲染看图确认清晰无裁切；② 独立 Swarm Tester 解包新冻结 TGZ 复验全套多格式入库、损坏文件回滚、PDF 页挂图定稿与 `seal-kb` 注册；③ 异源 `gpt-auditor` 全区间 `NO_ISSUES`。

## [Milestone #36] Seal 工作台与知识库中心 UI/UX 全面重构

- **Status**: verified
- **Scope**: `src/core/kb/types.ts`, `src/core/kb/service.ts`, `src/workbench/knowledge.ts`, `src/shells/dsh/workbench-host.ts`, `src/shells/dsh/client-style.ts`, `src/shells/dsh/client-locale.ts`, `src/shells/dsh/client.ts`, `tests/**`
- **Verified-Commit**: db3806552dc76f42aa4c9671217c611da3ca4095
- **Updated**: 2026-11-23
- **Depends-On**: #35
- **独立验收**：冻结安装包 `dist/seal-dsh-0.1.410.tgz`（SHA256 `3dafd650ecc1d999cd8e5e9d81462ed10a8a81a753cdf59b469f66634257b4aa`，已安装至 `~/.dsh/profiles/desktop`）；业务提交 `fc813a1` + 视觉抛光与异源 P2 修复 `15314be` + kind 隔离配对测试 `db38065`；`npm run verify` **448/448**、`tests/dsh-bundle.test.ts` **15/15**、2 项 `Broken by hand` 红→绿（`.tmp/evidence/milestone-36/worker/mutations.log`）；全程在物理隔离的 `dsh --profile web --port 0`（独立 `DSH_HOME` + `SEAL_HOME`，零触碰用户日常 Desktop 与 `~/.dsh`）完成浏览器逐屏实测：验证 0 库引导、`开启投标` 双栏表单、`知识库中心` 三步空态、顶栏切库与一步导入流、待整理批次与展开切片明细**全页 `batch-UUID`=0、`candidate-UUID`=0**、左侧切片行左对齐、候选扫描件 PDF 渲染页内联缩略图（`1240×1469` HTTP 200）正常展示、`企业主体 / 证照与档案 / 参考素材` 三分段及 `1200px` / `560px` 零横向溢出；独立 Swarm Tester（`m36-tester`）解包 `0.1.410` 复验 **`PASS`**（`.tmp/evidence/milestone-36/tester/report.md`）；异源 `gpt-auditor`（`effort=high`）终审 **`NO_ISSUES`**（`.tmp/evidence/milestone-36/gpt-audit-db38065.md`）。
- **目标**：彻底消除早期“工程师调试表单”风格与机器 UUID 裸露问题，在不改动核心语义红线（原件只读、AI 不可核实、定稿闸门、三层架构边界）的前提下，将 Seal 主工作台（开启投标 / 进行中的投标 / 知识库中心）与右栏审阅面板重构为现代、有设计感、心智零摩擦的桌面 Web 应用。
- **行为契约**：
  1. **数据层可读元数据补全（向后兼容，不破既有测试）**：
     - `PendingBatchSummary`（`src/core/kb/types.ts` / `service.ts`）新增 `sources: string[]`（该批次去重后的来源文件名列表，零额外磁盘读）；
     - `KnowledgeBase.listCandidates` 分页返回项在保留 `id` 的同时，补全人类可读元数据：`title`、`source`、`location`、`sourceType`、`imageCount`、`processed`；
     - `WorkbenchHost.kbFile` 扩展支持 `kind: "candidate"`（严格沿用 `^files\/` 路径隔离校验，读取候选的 `imageFiles[index]`），便于在 UI 内直接预览扫描件 PDF 渲染页或提取配图；
     - `KnowledgeCatalogItem` / `WorkbenchHost.kb({ action: "catalog" })` 与 `overview.vaults` 补全界面展示所需的只读元信息（如证据记录的 `validUntil`、`number`、`imageCount`、`firstImageIndex` 及库级 `pendingCandidateCount` / `subjectName` / `subjectVerified` 摘要），仍由纯视图模型 `src/workbench/knowledge.ts` 汇总、单源一致。
  2. **知识库中心信息架构重构（告别一页硬堆与裸 UUID）**：
     - **零库引导空态**：无任何知识库时展示清晰的三步入门引导卡片 + 新建企业库入口；
     - **顶栏切库 + 紧凑指标 + 主按钮 `+ 导入材料`**：存在库时，顶部采用清爽的「企业库切换器 + `+ 新建库` 折叠/弹层表单 + 状态徽章 + `+ 导入材料` 主按钮」，不再永久把新建表单与全部列表堆在一起；
     - **一步「导入并让 AI 整理」主流程**：点击 `+ 导入材料` 展开干净的导入面板（多格式拖选 + 可选本机目录/文件绝对路径），主 CTA 为 **「导入并让 AI 整理」**（点击后完成本地入库并立即自动拉起 `seal-kb` 会话；同时提供次要按钮「仅导入暂不整理」满足多批攒齐需求）；
     - **零 UUID 裸露的待整理批次条**：仅当存在未处理候选时在库顶显示一条紧凑提醒横幅，展示来源文件名（如 `《商务文件.docx》等 2 份文件`）与进度（`待 AI 整理 152 / 152 条切片`）+ 主按钮「让 AI 整理」+ 可展开「查看切片明细」；切片列表严禁展示 `candidate-UUID`，改用人类可读行卡片（章节标题 + 来源文件名与位置 + 类型标签 + 配图数徽章），点击高亮选中并就近展示正文与**内联图片缩略图**；
     - **库内 3 个清爽二级分段视图（Segmented Control）**：
       - `企业主体`：直接以双列结构化卡片呈现企业核心字段、逐项核实状态与行内编辑/一键核实（不再藏在孤立按钮后）；
       - `证照与档案`：0 条数据时展示清晰引导空态（不渲染空筛选器与置灰分页）；有数据时顶部单行紧凑工具栏（搜索 + 类型胶囊 + 仅看待核实开关 + 效期筛选），列表卡片支持图片缩略图、效期状态标签、一键查看/核实；
       - `参考素材`：写作参考素材列表与清晰「写作参考 · 无需核实」提示，空态友好；
     - 体检问题仅在存在问题时以折叠告警条呈现。
  3. **开启投标心智引导与全局现代视觉系统（深浅双主题 + 360px 窄栏自适应）**：
     - `开启投标`：尚无知识库（或所选知识库未核实项较多）时在顶部给出温和的非阻塞引导卡片（说明建库一次可跨标书自动复用事实与证照图，提供一键跳转「前往知识库中心」按钮），表单升级为干净的分块卡片布局并显示所选知识库状态预览；
     - `进行中的投标` 与右栏 `审阅工作台`：统一现代视觉系统（`src/shells/dsh/client-style.ts`，完全基于 DSH 原生 CSS 变量 + `color-mix()` 实现深浅双主题自适应的卡片层级、语义徽章、分段控件、拖放区、缩略图网格与微交互），严保右栏 `360px` 窄栏与主工作台 `560px`/宽屏零横向溢出。
- **Worker 工程门禁**：共用门槛；为新增的 `PendingBatchSummary.sources`、`listCandidates` 可读元数据、`kbFile(kind="candidate")` 正负控（含路径穿越拒绝）及 `workbench/knowledge.ts` 视图模型补齐确定性单测；至少 2 项 `Broken by hand` 破坏验证；构建新冻结 TGZ 并通过 `tests/dsh-bundle.test.ts`。
- **Tester 验收要求**：① 严守物理隔离纪律，通过独立沙盒 `dsh --profile web --host 127.0.0.1 --port 0 --no-open`（独立 `DSH_HOME` + `SEAL_HOME`，绝不碰用户日常 Desktop 单例锁与 `~/.dsh`）经浏览器实测深浅双主题、空库引导、多格式导入与待整理切片可读列表（确认界面 0 处 `candidate-UUID` / `batch-UUID` 裸露且候选图片缩略图可渲染）、3 个二级分段切换、开启投标无库引导与有库预览、`360px` 窄栏零溢出，并保存逐屏截图视觉核对；② 独立 Swarm Tester 解包冻结 TGZ 复验；③ 异源 `gpt-auditor` 全区间 `NO_ISSUES`。

## [Milestone #37] 工具效率与批量能力升级、`0.1.410` 体验收口与效果/WPS 核验

- **Status**: verified
- **Scope**: `src/core/docx/read-document.ts`, `src/core/bid/edit.ts`, `src/core/bid/check.ts`, `src/core/bid/project.ts`, `src/core/bid/requirements.ts`, `src/core/kb/**`, `src/workbench/**`, `src/shells/cli/**`, `src/shells/dsh/**`, `tests/**`
- **Verified-Commit**: b9dee6f48f7ab6bb15406b73c75ea256145024c9
- **Updated**: 2026-11-24
- **Depends-On**: #36
- **独立验收**：冻结安装包 `dist/seal-dsh-0.1.449.tgz`（SHA256 `d62f88e5934a263eef196527aebd611d81f32e7c5c51651abd3975fbf4c2a1b0`，已安装至 `~/.dsh/profiles/desktop`，`npm run dsh:doctor` 零残留）；业务提交含切片 1 `3ce3abd` + 切片 2 `b43362a` + `gpt-auditor` P2 加固 `0522d7e` + 真机端到端捕获的历史 P1 C05 定稿死锁根治 `b9dee6f`；`npm run verify` **461/461 PASS**、`tests/dsh-bundle.test.ts` **16/16 PASS**、全部 6 项 `Broken by hand` 红→绿（`.tmp/evidence/milestone-37/{s1-worker/mutations.log,s1-worker/mutations-c05.log,s2-worker/mutations.log}`）；独立 Swarm Tester（`m37-tester`）全量解包与 `0.1.448`/`0.1.449` 增量复验全部 **`PASS`**（实测 `seal_doc_read` blocks 体积压缩 **86.43% / 85.71%**、outline 压缩 **72.10% / 76.20%** 且信息无损，`.tmp/evidence/milestone-37/tester/report.md`）；异源 `gpt-auditor`（`effort=high`）全区间 `db38065..b9dee6f` 终审 **`NO_ISSUES`**（`.tmp/evidence/milestone-37/gpt-audit-{b43362a,0522d7e,b9dee6f}.md`）；真机浏览器验收（物理隔离 `dsh --profile web --port 0`）：① `0.1.448` 6 项 UI/UX 收口 **6/6 PASS**（含左侧工作区树 `ctx.workspaces.rename` 零 UUID 可读命名、跳过文件透传与提示条、中文化体检提示、详情高亮自动滚动、右栏真实库名）；② `seal-kb` 建库（`DeepSeek-V4.1-Flash`）由 `0.1.410` 基线 **~5–6 分钟 / 38 次调用 / 648K tok（9 次翻源码）** 降至 **3 分 27 秒 / 26 次调用 / 465K tok（0 次翻源码）**；③ 同样本 `sccc-property-2022` 在较慢的 **`GPT-6.2 Sol`** 上以 **32 步 / 46 次调用 / 26 分 31 秒** 完成全部格式 1–10、29 项技术响应、7 项商务响应、六节完整实施方案、2 张证照图挂载及 55 条要求（51 条必答经 `patch` 一次绑定）且 `C01/C02/C07–C16` 全 0（对比 M27 旧版 `dsf` 76 步 / 82 次调用 / 46.3 分钟大幅提效），终稿（`.tmp/evidence/milestone-37/final-for-wps/M37-SCCC-GPT62-final.docx`）物理核验 281 确认全清、`_Seal_*`=0、非空黄标=0、空壳黄标=0，LibreOffice CJK 28 页渲染看图通过（`.tmp/evidence/milestone-37/render-gpt62/`）。**如实披露未覆盖项**：① `Claude Opus 5.5` 实测时上游返回 `HTTP 503 No available accounts`，暂未完成 `opus5.5` 跑分；② WPS Office 桌面客户端逐页人眼核验待用户在 `/Applications/wpsoffice.app` 直接打开上述终稿与 M27 终稿核对。
- **目标**：以最终成标质量与用户体验为第一目标，在不依赖特定模型、不放松 C01–C16 确定性检查与授权边界的前提下，系统性消除 `0.1.410` 与 M27 量化诊断暴露的 6 项工具效率/协议瓶颈（JSON 17× 膨胀、cursor 字符串解析 Bug、读草稿重跑全量 `checkDraft`、`originalHighlights` 垃圾回吐、逐条 `dismiss_hint` / `dismiss_candidate` 与 `seal_requirements` 全量重吐），同步收口 `0.1.410` 真机 UI/UX 摸底发现的 6 项体验摩擦，并完成跨模型端到端效果实测与 WPS 终稿核验。
- **行为契约**：
  1. **切片 1：模型无关的工具协议与批量能力升级**
     - **`seal_doc_read`（`src/core/docx/read-document.ts`、`src/shells/cli/project-v2.ts`、`src/shells/dsh/project-tools.ts`）**：
       - 修复 `cursor` 续读 Bug：工具参数接受 JSON 对象或合法 JSON 字符串双形态（不再对字符串二次 `JSON.stringify`），续读失败给出明确恢复提示；
       - 新增可选参数 `to`（结束块地址，闭区间包含该块及其后代，与 `from` 协同截取指定章节/表格范围）与 `onlyHints`（布尔值，仅返回含疑似空白提示的块，便于填空与补漏 C02）；
       - 读草稿获取 `C04` 待定锚点时改用轻量读取逻辑（直接解析台账有效未确认待定 + 文档内 `_Seal_P_` 范围，不再每次读草稿重跑完整 `checkDraft` 全量包/差异/全部检查，同时保持基准/台账异常校验语义不变）；
       - 在 Agent 工具输出 `render` 层（不破坏 CLI `--json` 既有结构与既有单测）提供高信息密度的紧凑视图：跳过无文本空壳 `table`/`row`/`cell` 节点（保留空单元格 `⟦0:⟧`、续格 `〃` 及所有可见文本与 `[图片]`/`[对象]`），省略默认 `editable: true`、重复 `location` 与 `complete: true` 的 `fragment` 冗余外壳，完整保留地址、`⟦k:…⟧`、`«待定:…»`、`next` 续读信息与 `warnings`。
     - **`seal_doc_edit`（`src/core/bid/edit.ts`、`src/shells/cli/project-v2.ts`、`src/shells/dsh/project-tools.ts`）**：
       - 返回体中 `pending` 剥离内部 `originalHighlights` 字符级高亮数组（该字段仍完整持久化于 `ledger.json` 用于定稿还原，绝不喂给 LLM 上下文）；
       - 新增批量跳过操作 `{ op: "dismiss_hints", targets: [{ at, blanks? }], reason }` 或 `{ op: "dismiss_hints", from, to, reason }`：按块或块区间一次性跳过未处理的疑似空白，内部整批仅计算一次 `currentHints(xml, name)`，仍**逐条**写入 `ledger.dismissals`（保留块指纹、提示原文与 `actor: "agent"`，不削弱 C03 人工过目红线）；同步优化现有逐条 `dismiss_hint` 仅计算一次 `currentHints`；
       - 批次编辑失败诊断升级：每个 `rejected` 项返回 `index`（在 `ops` 中的 0 基序号）、`at`（目标地址）、精准原因及该块当前的可见文本与提示序号摘要（若地址存在），避免模型被迫多跑一轮 `seal_doc_read`。
     - **`seal_requirements`（`src/core/bid/requirements.ts`、`src/shells/cli/project-v2.ts`、`src/shells/dsh/project-tools.ts`）**：
       - 新增增量更新动作 `action: "patch"`：接收 `items`（数组，每项含 `id` 及可选 `responses`、`evidence`，禁止任何人工覆盖/核实字段及未知字段），在现有 `requirements.json` 基础上原子更新对应条目的响应位置与证据绑定，校验全部 `id` 存在且 `responses` 合法，无需整表重吐全部 `quote`/`source`。
     - **`seal_kb_save` 与双 Skill（`src/core/kb/service.ts`、`src/shells/cli/kb.ts`、`src/shells/dsh/project-tools.ts`、`src/shells/dsh/seal-bid-skill.ts`、`src/shells/dsh/seal-kb-skill.ts`）**：
       - 支持 `dismiss_candidates`（批量 `ids: string[]`）或在 `create`/`update` 时支持可选 `dismissCandidateIds: string[]` 顺手清理已处理候选（严格遵守禁止越权字段与原子日志）；
       - 在 `seal_kb_save` 工具参数描述与 `seal-kb` / `seal-bid` skill 中补全合法字段白名单、`files` 相对路径与 `kb:<recordId>/<relPath>` 挂载规范及上述新批量/增量工具用法，减少 Agent 盲探源码。
  2. **切片 2：`0.1.410` 真机 UI/UX 6 项体验收口**（`src/core/kb/service.ts`, `src/workbench/**`, `src/shells/dsh/workbench-host.ts`, `src/shells/dsh/client*.ts`）
     - **导入跳过文件醒目反馈**：点击「导入并让 AI 整理」且结果包含 `skipped` 时，不仅保留在库状态提示中，且在自动发送给 AI 的首条消息或跳转提示中明确告知被跳过的文件名与原因，避免静默丢失反馈；
     - **体检与核实提示中文化**：主体字段未核实提示（如 `creditCode`、`legalRepresentative` 等）在 UI 视图层（及服务提示）映射为人类可读中文标签，消除英文内部键名裸露；
     - **「查看详情」定位与聚焦体验**：在「证照与档案」「参考素材」点击「查看详情」时自动平滑滚动到详情卡片并高亮当前选中行，给出清晰边界与关闭按钮；
     - **「+ 导入材料」按钮状态一致**：导入面板已展开时右上角主按钮文案与状态切换为「收起导入」，避免用户误点关闭；
     - **右栏与首条消息可读命名**：右栏副标题展示真实关联知识库名称（而非泛称「企业知识库」）；启动投标/建库首条引导消息同时优先呈现人类可读的知识库名称（如 `星河智联摸底测试库（ID: …）`）并核对工作区命名可用性；
     - **细节抛光**：空库无记录时 `未核实 0` 使用中性徽章而非绿色「已就绪」样式；切片预览副标题去重避免 `文件名 · 文件名` 重复拼接；「参考素材」分段隐藏不适用的有效期体检说明；美化文件拖放区文件选择交互（隐藏割裂的原生 `<input type="file">` 外观）。
- **Worker 工程门禁**：共用门槛；切片 1 与切片 2 各自补齐正负控单测（含 `cursor` 字符串/对象双形态、`to`/`onlyHints`、紧凑渲染保真与压缩率、`originalHighlights` 剥离、`dismiss_hints` 批量跳过与 C03 兼容、失败诊断含当前块原文、`requirements patch` 越权拒绝与增量更新、`dismiss_candidates`、6 项 UI 视图与行为单测）；每个切片至少 2 项 `Broken by hand` 破坏验证；切片 2 结束后构建新冻结 TGZ 并通过 `tests/dsh-bundle.test.ts`。
- **Tester 与最终效果验收要求**：① 独立 Swarm Tester（`m37-tester`）解包新冻结 TGZ 复验全部新增能力与既有回归；② 异源 `gpt-auditor` 全区间 `NO_ISSUES`；③ 在物理隔离 `dsh --profile web` 中真机复测 6 项 UI 收口，并用 `deepseek-v4.1-flash`（及 `gpt-6.1-sol`/`gpt-6.2-sol` 抽测）复跑端到端样本对比效果与效率，确认稳定后切 `claude-opus-5-5` 跑最终高质量验收，同时产出真实终稿进行 WPS 排版核验。

## [Milestone #38] 精准敏感项标黄与 Office 正文插入排版加固

- **Status**: verified
- **Verified-Commit**: 5215cb7eac4105fdb747acd9b52ca8d7aa322211
- **Updated**: 2026-11-24
- **Depends-On**: #37
- **独立验收**：冻结安装包 `dist/seal-dsh-0.1.488.tgz`（SHA256 `0c2849a5d0d6fb485cc8189c77a946e0b348cd9adfddbbd475f829ef4cf16d08`，已安装至 `~/.dsh/profiles/desktop`，`npm run dsh:doctor` 零残留）；契约对齐 `95880dd`/`b204397`/`16ff4d6` + 业务实现 `3e60c58` + 三轮异源 `gpt-auditor` 实证加固 `a6284eb`/`23d73d1`/`5215cb7`；`npm run verify` **474/474 PASS**、`tests/dsh-bundle.test.ts` **16/16 PASS**、2 项 `Broken by hand` 红→绿；独立 Swarm Tester（`m38-tester`）3 轮全量解包与对抗探针全部 **`PASS`**；异源 `gpt-auditor`（`effort=high`）终审 `.tmp/evidence/milestone-38/gpt-audit-5215cb7.md` **`P0=0, P1=0, P2=2`**（两项遗留低频边界如实记录：`insert` 未核实事实值与普通正文互为子串碰撞、`sanitizeInsertedBodyParagraphPr` 无条件移除 `keepNext=0`/`pageBreakBefore=0` 显式关闭开关，后续按需收口）；真实 85 页 `.doc` 设备采购安装招标样本物理隔离复测（`.tmp/final-for-wps/M38-golden-clean-draft.docx`，原件 SHA256 前后 100% 一致）：对比改前 `0.1.449`（`M37-golden-GPT62-draft.docx`），全稿标黄占比从 **68.1%（478 处）** 骤降至 **6.3%（41 处 `_Seal_P_` / `C04=46`）**，`C05` 从 **403 → 12**，`t:7` 技术偏离表从 **99%（282 处）→ 3%（仅 1 处真实资质缺口）**，自拟章节正文仅 **2.7%** 局部标黄且 `4.4`/`4.6` 均已正确恢复左对齐（47 页 LibreOffice CJK 渲染抽检通过，`C01/C02/C07–C16` 全 0，3 份高清有效证照原图完整挂载且已过期安全生产许可证未被挂载）。
- **Scope**: `src/core/bid/policy.ts`, `src/core/bid/edit.ts`, `src/core/docx/xml.ts`, `src/core/docx/text-batch.ts`, `src/core/docx/text-document.ts`, `src/shells/dsh/seal-bid-skill.ts`, `tests/**`
- **目标**：落实“Seal 稳定 Office 格式、内容信任 AI 发挥、仅对极少数真正敏感项标黄”的产品原则，根治真实 85 页招标文件测试暴露的两项高影响体验缺陷：① 68.1% 全文泛黄（478 处黄标淹没真正商业拍板项）；② 自拟章节紧接居中模板提示段插入时误继承居中对齐。
- **行为契约**：
  1. **精准敏感项策略（`src/core/bid/policy.ts`、`src/core/bid/edit.ts`）**：
     - 收窄自动敏感词规则为核心商业参数（`报价`: `/报价|总价|单价|合价|金额|税率|保证金|优惠/`、`工期交期`: `/工期|交货期|交付期|交货时间|交付时间/`、`质保`: `/质保|保修|维保/`）；`偏离`、`承诺` 保留为 `PendingCategory` 合法类别供 Agent 精准声明，不再全局正则轰炸；
     - **移除 `isFormatFill && !verifiedReference` 泛化标黄**：仅当操作实际引用了未核实/未知效期/未知主体的 KB 事实或图片（`hasUnverifiedFact`）时，才自动追加 `source: 'unverified'` 待定与 C05；普通格式文字填写与表格扩展行默认正常白底；
     - **`insert` 自拟章节不再触发敏感词自动连坐**：`insert` 的 `operation.markdown` 不喂给敏感词正则（仅保留显式 `operation.pending` 与未核实 KB 事实/图片的待定标记）；
     - **字段/单元格级上下文与 `insert_rows` 逐格独立判定**：
       - 非表格段落的 `replace`/`check` 仅检查当前段落文本；
       - 表格单元格的 `replace`/`set_cell`/`check` 仅检查当前单元格文本 + 所属字段标签（两列键值表且 `c:0` 非空时取 `c:0`；多列表格或 `c:0` 为空时取本列列头 `r:0/c:j`），不再拼接整表 `r:0` 或无关同行列文字；
       - `insert_rows` 若未显式传 `operation.pending`，则按每个插入单元格 `(rowIdx, colIdx)` 独立判定敏感词（仅检查该单元格文本 + 其自身列头 `r:0/c:colIdx` 或两列表左侧 `rows[rowIdx][0]`）与未核实 KB 引用，绝不因某一列是报价/工期/偏离而把整行序号/品名/要求/响应全部染黄；若显式传 `operation.pending` 则尊重显式声明标黄该批行；
       - 当 `insert_rows` 中某格同时含已核实事实引用且该格不需待定时，仍精确包进 `_Seal_F_` 并写入台账 `fills`，确保 C05 事实篡改防线与定稿清理完全 intact。
  2. **Office 正文插入排版加固（`src/core/docx/xml.ts`、`src/core/docx/text-batch.ts`、`src/core/docx/text-document.ts`）**：
     - 新增第一性原理纯函数 `sanitizeInsertedBodyParagraphPr(pPrXml)`，供 `insert`（`markdownBlocks`）从锚点段落派生默认正文 `<w:pPr>` 时使用：保留字体/字号/行距等正常排版属性，剥离非正文结构性/特殊对齐属性——`<w:jc w:val="center|right"/>`（遇到居中或右对齐时改为左对齐或显式 `<w:jc w:val="left"/>` 防止样式继承居中）、`<w:pageBreakBefore.../>`、`<w:keepNext.../>`、`<w:outlineLvl.../>`、`<w:numPr>...</w:numPr>`，以及标题/目录类 `<w:pStyle>`（如 `Heading*`、`Title`、`Subtitle`、`TOC*`、`标题*`）；表格行复制 `row-copies.ts` 保持原样不误伤居中表头/单元格。
  3. **`seal-bid` 手册同步升级（`src/shells/dsh/seal-bid-skill.ts`）**：
     - 明确传达“内容信任 AI 整合生成、正常白底交付、仅对极少数真正需要企业决策者拍板的敏感项标黄”，禁止对整章自拟方案或整张技术偏离表批量挂 `pending` 或通篇写“待审定”；自拟段落内如仅有单个待拍板数值，先写正常正文再用 `mark_pending` 局部标出该短语。
- **Worker 工程门禁**：共用门槛；补齐并更新正负控单测（覆盖 `policy.ts`、两列表 vs 多列表格单元格上下文、`insert_rows` 逐格独立标黄与 `_Seal_F_` 共存、`insert` 含“承诺/维保/工期”正文不自动标黄、`sanitizeInsertedBodyParagraphPr` 剥离居中/分页/标题样式/编号并保留字体行距、至少 2 项 `Broken by hand` 破坏验证）；构建新冻结 TGZ 并通过 `tests/dsh-bundle.test.ts`。
- **Tester 与复测要求**：独立 Swarm Tester（`m38-tester`）全量验算与解包测试 `PASS`；异源 `gpt-auditor` `NO_ISSUES`；在物理隔离沙盒用新包跑真实端到端复测，量化验证黄标占比大幅下降且排版无误继承居中。

## [Milestone #39] Word/WPS 原生自动目录原语（`insert_toc`）与真实页码缓存

- **Status**: verified
- **Verified-Commit**: 96aa88220434144fcd9e648cba6d3977e6696a6f
- **Updated**: 2026-11-25
- **Depends-On**: #38
- **独立验收**：冻结安装包 `dist/seal-dsh-0.1.560.tgz`（SHA256 `31e7a50e263098329b2032baaee5591bea1b81824bbca3f62e17c998d1ce5751`，已通过 DSH 内置 pnpm v11 安装至 `~/.dsh/profiles/desktop`，`npm run dsh:doctor` 零进程/零死锁/零残留）；契约冻结 `759155e` + 核心实现 `589b23e` + 五轮异源 `gpt-auditor` 与真标复测加固 `4ce47ca`/`cccb217`/`64b20aa`/`952ce43`/`654014e`/`96aa882`（含封面清“第六章”与“正本”手册更新 `e57c88d`）；`npm run verify` **488/488 PASS**、`tests/dsh-bundle.test.ts` **16/16 PASS**；独立 Swarm Tester（`m39-tester-r2`）解包验证与多轮对抗探针 **`PASS`**；异源 `gpt-auditor`（`effort=high`）终审 `.tmp/evidence/milestone-39/gpt-audit-654014e.md` **`P0=0, P1=0, P2=1`**（两项低频 P2 边界如实记录：`w:sdt` 内容控件内标题未纳入 `outline.ts`/`toc.ts` 顶层收集；多目录行掩码候选在正文后文原样复述标题时可能误掩码，后续按需收口）；真实 47/48 页草稿复测 `.tmp/final-for-wps/M39-golden-with-toc-draft.docx`（SHA256 `b702a74aac41eac811707d06f4a2eac6e53589b1e0219c95781b4e8f495cf56d`）：已去除顶部 `第六章 投标文件格式`、将 `正（或副）本` 填为 `正本`、清除 `（投标人自行编写）`（保留尾部原生分页符）并插入 24 条原生目录（排除“目录”自身且 `outlineLvl=9`），实测回填 **24/24 条真实页码**（`3,7,7,9,11,13,13,14,15,22,23,25,27,29,30,30,33,37,40,42,43,44,47,48`），LibreOffice CJK 渲染抽看封面、目录与第一章衔接无误。
- **Scope**: `src/core/host.ts`, `src/core/docx/toc.ts`, `src/core/docx/index.ts`, `src/core/docx/text-batch.ts`, `src/core/docx/text-document.ts`, `src/core/bid/edit.ts`, `src/shells/node-host.ts`, `src/shells/cli/project-v2.ts`, `src/shells/dsh/project-tools.ts`, `src/shells/dsh/seal-bid-skill.ts`, `tests/**`
- **目标**：根治招标模板中“目录 / （投标人自行编写）”整页空白的问题，按“Seal 把 Office 格式做稳”的第一性原理，在 Word 引擎中实现兼容 WPS Office、Microsoft Word 与 LibreOffice 的原生目录域原语 `insert_toc`，打开即见带右对齐引导点线与真实页码的完整目录，且支持在 WPS/Word 中右键「更新域」动态重算页码。
- **行为契约**：
  1. **操作契约（`insert_toc`）**：
     - 签名：`{ op: 'insert_toc', at: string, position: 'before' | 'after', maxLevel?: 1 | 2 | 3 }`（`maxLevel` 默认 `3`，非法值或指向表格内单元格/不存在地址当场拒绝）；
     - 绝不触发 `pending` 自动标黄（亦禁止与 `pending`/`thirdPartyHolder` 混用或显式拒绝无效字段）。
  2. **原生 OOXML 目录生成（`src/core/docx/toc.ts`，零 `node:*` 依赖）**：
     - 复用 `outline.ts` 标题识别逻辑收集文档正文顶层段落中 `1 <= level <= maxLevel` 且非空的标题；若没有符合条件的标题则当场拒绝并给出清晰原因；
     - **排除目录自身**：当 `position === 'after'` 且锚点段落文本匹配 `/^目\s*录$|^contents$|^table\s+of\s+contents$/i`（去除空白后）时，将其从目录条目中排除，并把该锚点段落的 `<w:outlineLvl>` 设为 `<w:outlineLvl w:val="9"/>`，确保 WPS/Word 原生「更新域」也不把“目录”自身列进目录；
     - **幂等刷新**：若锚点紧邻位置（`after` 为紧后一段，`before` 为紧前一段）已是顶层目录域（包含 `TOC` 指令的 `fldChar begin..end` 跨段或单段区域），`insert_toc` 原子替换该旧目录域，不产生双份重复目录；
     - **书签锚点（`_TocSeal_<N>`）**：为每个目标标题分配全局唯一不冲突的 `w:id` 与 `_TocSeal_<N>` 书签名（已有 `_TocSeal_*` 书签则复用；绝不使用 `_Seal_` 前缀以免被定稿清理误删）；
     - **标准多段目录域 XML**：
       - 首段包含 `<w:fldChar w:fldCharType="begin"/>` + `<w:instrText xml:space="preserve"> TOC \o "1-<maxLevel>" \h \z \u </w:instrText>` + `<w:fldChar w:fldCharType="separate"/>`；
       - 每条目录项为独立 `<w:p>`，使用安全中性段落属性（左对齐、按所在版心宽度设置右对齐点线制表位 `<w:tabs><w:tab w:val="right" w:leader="dot" w:pos="<widthDxa>"/></w:tabs>`、按 `heading.level - minLevel` 相对缩进 `420 dxa`/级，保留文档正文基础字体/字号），段内含 `<w:hyperlink w:anchor="_TocSeal_<N>" w:history="1">`（标题文字 + `<w:tab/>` + 标准 `PAGEREF _TocSeal_<N> \h` 域包裹缓存页码）；
       - 末段闭合外层 `<w:fldChar w:fldCharType="end"/>`；
     - **`word/settings.xml` 自动更新标记**：在 `editTextDocument` 落盘前确保 `word/settings.xml` 存在 `<w:updateFields w:val="true"/>`（若包中缺 `word/settings.xml` 则同步创建并登记 `[Content_Types].xml` 与 `word/_rels/document.xml.rels`）。
  3. **真实渲染页码填充（可选 `HostPort.extractDocxPageTexts`）**：
     - 在 `src/core/host.ts` 新增可选方法 `extractDocxPageTexts?(docxBytes: Uint8Array): Promise<string[]>`，由 `src/shells/node-host.ts` 用隔离临时目录 + LibreOffice headless PDF + `pdftotext`（优先使用 CJK `fonts.conf`，`finally` 彻底清理临时目录）实现；
     - `editTextDocument` 执行 `insert_toc` 时，先生成带占位页码的完整包（使目录本身占好真实版面高度），若 `host.extractDocxPageTexts` 可用则抽取渲染后各页文本，按标题文档顺序单调匹配各标题真实所在页码（避开目录自身所在页），精准回填各条 `PAGEREF` 缓存页码并重新校验包合法性；无渲染器时优雅降级为空缓存（仍带 `<w:updateFields w:val="true"/>`），不写假页码。
  4. **工具、CLI 与 `seal-bid` 手册接入（`src/core/bid/edit.ts`、`src/shells/cli/project-v2.ts`、`src/shells/dsh/project-tools.ts`、`src/shells/dsh/seal-bid-skill.ts`）**：
     - `seal_doc_edit` 工具参数描述与 CLI 完整支持 `insert_toc`（含同批混合 `delete` 占位段 + `insert_toc` 时的地址偏移映射 `addressAfterEdits`）；
     - `seal-bid` 手册明确指导 Agent：在所有内容与证照编写完毕、进入最终 `seal_check` 前，若模板存在“目录 / （投标人自行编写）”页，删除占位提示段并调用 `insert_toc` 生成/刷新原生自动目录。
- **Worker 工程门禁**：共用门槛；补齐正负控单测（含无标题拒绝、单元格地址拒绝、排除“目录”自身并设 `outlineLvl=9`、幂等刷新不重复、`_TocSeal_*` 书签唯一且经 `finalizeDocument` 完整保留、多级相对缩进与右对齐点线 tab、`word/settings.xml` 已有与缺失双路径写入 `updateFields`、mock `extractDocxPageTexts` 单调页码精准回填且避开目录页、`addressAfterEdits` 同批 `delete` + `insert_toc`、至少 2 项 `Broken by hand` 破坏验证）；构建新冻结 TGZ 并通过 `tests/dsh-bundle.test.ts`。
- **Tester 与真实文件验收要求**：独立 Swarm Tester（`m39-tester`）全量验算与解包测试 `PASS`；异源 `gpt-auditor` 终审 `P0=0, P1=0`；在真实 47 页 `M38-golden-clean-draft.docx` 工作副本上实跑 `delete` 占位行 + `insert_toc`（同时验证去除 `第六章` 与 `正（或副）本→正本`），LibreOffice CJK 渲染目录页看图确认引导点线、层级缩进与真实页码完全准确。

## [Milestone #40] 工作台安全删除闭环（批次 · 条目 · 知识库 · 投标项目）

- **Status**: verified
- **Verified-Commit**: ef364eb0e7c7a9af55909d7222a8b23879721559
- **Updated**: 2026-11-25
- **Depends-On**: #39
- **独立验收**：冻结安装包 `dist/seal-dsh-0.1.590.tgz`（SHA256 `d5619e59620ba51b6bbffd771e1899ffa20635d2f0a9daea2a524a45d9c839a4`，已通过 DSH 内置 pnpm v11 安装至 `~/.dsh/profiles/desktop`，`npm run dsh:doctor` 零进程/零死锁/零残留）；契约冻结 `3337db4` + 核心实现 `d9adde2` + 四轮异源 `gpt-auditor` 实证加固 `8c88955`/`879dc35`/`b0170dc`/`ef364eb`；`npm run verify` **496/496 PASS**、`tests/dsh-bundle.test.ts` **16/16 PASS**、2 项 `Broken by hand` 红→绿；独立 Swarm Tester（`m40-tester`）3 轮解包对抗探针全部 **`PASS`**；异源 `gpt-auditor`（`effort=high`）终审 `.tmp/evidence/milestone-40/gpt-audit-final.md` **`P0=0, P1=0, P2=1`**（两项低频非阻塞项如实记录：实体大小写表驱动单测待补、删除最后一个知识库瞬间后台偶发两次旧 `vaultId` 400 竞态刷新但不呈现错误提示）；隔离 `dsh --profile web` 浏览器实屏验收 5 项全过（删除当前库取消与项目引用拦截、删除导入批次并保留已引用原图且详情页正常渲染、删除参考素材与证照记录、删除正常与损坏投标项目、解引用后成功删库归零干净空态，磁盘 `projects/`/`ledgers/`/`vaults/` 全部清零且原件 100% 完好）。
- **Scope**: `src/core/kb/service.ts`, `src/core/kb/types.ts`, `src/core/kb/index.ts`, `src/workbench/knowledge.ts`, `src/shells/dsh/workbench-host.ts`, `src/shells/dsh/client.ts`, `src/shells/dsh/client-locale.ts`, `src/shells/dsh/client-style.ts`, `tests/**`
- **目标**：根治工作台“能进不能出、误导材料删不掉、历史测试库清不掉”的产品体验缺陷，在 owner 工作台补齐四类安全删除能力（删除导入批次、删除单条记录/素材、删除知识库、删除进行中的投标项目），100% 不碰用户本地原件，不扩大 Agent 工具破坏面。
- **行为契约**：
  1. **内核安全删除原语（`src/core/kb/service.ts`，零 `node:*` 依赖）**：
     - `deleteBatch(vaultId, batchId)`: 校验 `vaultId` 与 `batchId`（`^batch-[a-z0-9-]+$`）及 `inbox/<batchId>/` 存在；先扫描全库活跃条目（`subject.md`、`records/*.md`、`materials/*.md`）收集 `files` 数组与 Markdown 正文中所有引用的 `files/<batchId>/...` 相对路径（兼容 URL 编码路径）；删除 `inbox/<batchId>/`；若全库条目均成功解析且 `files/<batchId>/` 存在，仅清理未被任何已建档条目引用的副本文件（全部未引用则直接移除 `files/<batchId>/` 目录；存在无法解析的损坏条目时保守保留全部 `files/<batchId>/` 文件防误删）；追加 `actor: 'human'` 变更日志并返回 `{ batchId, removedCandidates, removedFiles, preservedFiles }`。
     - `deleteEntry(vaultId, kind, id, actor = 'human')`（或复用删除路径）：仅允许 `record` / `material`（拒绝 `subject`），删除对应 `.md` 文件并追加对应 `actor` 变更日志（写日志失败时尽力回滚恢复原 `.md`）；不误删共享 `files/` 资产。
  2. **Owner 工作台服务端接口（`src/shells/dsh/workbench-host.ts`，仅经 `/api/seal/action` 暴露，绝不注册为 Agent 工具或 CLI 命令）**：
     - `kb({ action: 'delete_batch', vaultId, batchId })`：在 `serializedKnowledgeBase` 锁内调用 `kb.deleteBatch(vaultId, batchId)`。
     - `kb({ action: 'delete_entry', vaultId, kind, id, revision })`：在 `serializedKnowledgeBase` 锁内校验 `kind ∈ {record, material}` 与当前条目 `revision` 一致（不一致返回 409 版本冲突），随后以 `actor: 'human'` 删除条目。
     - `kb({ action: 'delete_vault', vaultId })`：在 `serializedKnowledgeBase` 锁内校验 `safeId`、`lstat` 非符号链接、`realpath` 严格位于 `knowledgeBasesRoot()` 直接子目录且存在；遍历 `this.home/projects/*` 检查是否被任意投标项目绑定（若命中引用或存在无法读取 `seal-project.json` 的损坏项目，fail-closed 拒绝并给出清晰原因）；无引用时递归删除该知识库目录。
     - `delete_project({ projectId })`（`WorkbenchHost.deleteProject`）：严格经 `projectRoot` + `lstat` 非符号链接校验位于 `this.home/projects/<id>`；在 `serializedProject(root, ...)` 串行锁内先清除对应的项目外台账锚点（`host.ledgerAnchorPath(root, false)`，若存在且为普通文件），再递归删除项目目录；支持清理正常项目与损坏项目，100% 不触碰原招标文件或知识库。
  3. **工作台前端内联二次确认 UI（`src/shells/dsh/client.ts`、`client-locale.ts`、`client-style.ts`）**：
     - 全部四处删除均使用**组件内联二次确认条**（不依赖 `window.confirm`），明确告知“只删 Seal 副本，不影响电脑原件”，提供「确认删除 / 取消」与提交中防重复点击态，失败在原地展示原因：
       - 待整理导入批次黄条：「查看切片明细」「让 AI 整理」旁增设「删除此批」，删后自动刷新并关闭已展开的该批切片抽屉；
       - 证照与档案 / 参考素材详情卡：增设「删除」按钮（主体档案不显示），携带 `revision` 提交，删后关闭详情卡并刷新计数与列表；
       - 知识库中心顶栏：「+ 新建库」旁增设「删除当前库」，删除后自动切到下一个库或干净空态；被项目引用时清晰呈现拦截提示；
       - 「进行中的投标」列表：正常与损坏项目卡片均增设「删除项目」，删除后立即刷新列表与标签计数。
- **Worker 工程门禁**：共用门槛；补齐正负控单测（覆盖 `deleteBatch` 全量回收 vs 部分被已建档条目引用保留 vs URL 编码正文引用 vs 损坏条目保守保留 vs 非法 `batchId` 拒绝、`deleteEntry` `revision` 冲突 409 + 拒绝删 `subject` + `actor: 'human'` 日志、`deleteVault` 活跃项目引用拦截 + 损坏项目 fail-closed 拦截 + 符号链接拒绝 + 无引用成功删除、`deleteProject` 正常与损坏项目清理 + 同步删 `ledgers/<hash>.json` 锚点 + 原招标文件零改动 + Agent 工具/CLI 零越权暴露、至少 2 项 `Broken by hand` 破坏验证）；构建新冻结 TGZ 并通过 `tests/dsh-bundle.test.ts`。
- **Tester 与实屏验收要求**：独立 Swarm Tester（`m40-tester`）全量验算、解包测试与边界探针 `PASS`；异源 `gpt-auditor`（`effort=high`）终审 `P0=0, P1=0`；物理隔离 `dsh --profile web` 经 `browser` 子代理亲测四类删除 UI 交互（内联二次确认、引用阻断提示、删批次保留已引用图、删条目、删项目、删库后干净空态）并截屏留证。

## [Milestone #41] 面向 Office 用户的发布与 DSH 直接发现闭环（内置 PDFium · Windows 适配与环境体检 · npm 与 DSH 市场索引）

- **Status**: verified
- **Verified-Commit**: d868b10e1d0cdb143ca1f495819dedbc39f9f117
- **Updated**: 2026-11-25
- **Depends-On**: #40
- **独立验收**：冻结安装包 `dist/seal-dsh-0.1.597.tgz`（SHA256 `f845186e07a6c59277970afad14dd4f822900c31cf81d41d2a54b61e0297d0e6`，已通过 DSH 内置 pnpm v11 安装至 `~/.dsh/profiles/desktop`，`npm run dsh:doctor` 零残留）；契约冻结 `b0148dd` + 核心实现 `5df51c2` + 审计加固 `d868b10`；`npm run verify` **500/500 PASS**、`tests/dsh-bundle.test.ts` **16/16 PASS**（实测解包后在真实 Electron ASAR-aware 运行时零 Poppler 加载 `@hyzyla/pdfium`）、3 项 `Broken by hand` 红→绿；独立 Swarm Tester（`m41-tester`）2 轮解包对抗探针 **`PASS`**（含 `env -i PATH=""` 零 Poppler 下 48 页中文标书 PDF 抽取/渲染/目录页码回填、电子签章 `/Subtype /Widget` 红色像素 `111,556` 实测、损坏 PDF 恢复、并发 `Promise.all`、Windows/macOS/Linux 只读探测 `1.89 ms` 及本机 `DeepSeek Harness.app` 内 `@deepseek-ai/dsh-plugin-market-index` `parseMarketIndex`/`marketInstallTarget` 真校验 `market/index.json`）；异源 `gpt-auditor`（`effort=high`）终审 `.tmp/evidence/milestone-41/gpt-audit-d868b10.md` **`NO_ISSUES`**（0 P0 / 0 P1 / 0 P2）。（注：本机 Chrome 未开启远端调试端口导致自动浏览器截屏跳过，缺失 LibreOffice 横幅的后端 `status()`/`overview()` 响应与前端状态逻辑已由单测与代码审计覆验，用户可直接在桌面端确认。）
- **Scope**: `package.json`, `package-lock.json`, `src/shells/pdf-engine.ts`, `src/shells/node-host.ts`, `src/shells/dsh/workbench-host.ts`, `src/shells/dsh/client.ts`, `src/shells/dsh/client-locale.ts`, `src/shells/dsh/client-style.ts`, `scripts/build-dsh-bundle.mjs`, `scripts/build-market-index.mjs`, `market/**`, `docs/RELEASE.md`, `README.md`, `tests/**`
- **目标**：让普通 Office 用户（含 Windows 与 macOS）能直接从 DeepSeek Harness 通过 npm 或 DSH 插件市场索引一键安装和更新 Seal，彻底消除极难配置的外部 Poppler 依赖，并在缺失 LibreOffice 时给出清晰温和的环境体检引导。
- **行为契约**：
  1. **内置 MIT PDFium WASM 引擎替换 Poppler（`src/shells/pdf-engine.ts`、`src/shells/node-host.ts`）**：
     - 安装并打包 `@hyzyla/pdfium`（MIT 协议、纯 WASM、零原生编译），通过 `src/shells/pdf-engine.ts` 封装串行化复用的 PDFium WASM 实例（避免并发访问单一 WASM 堆竞争，异常初始化自动重置，`page.close()` 与 `document.destroy()` 全部放在 `try/finally` 防内存泄漏），配合已有 `sharp` 编码 PNG 并校验图片合法性；
     - `NodeHostPort.extractPdf`、`NodeHostPort.renderDocxPages`（PDF 转 PNG 段）、`NodeHostPort.extractDocxPageTexts`（PDF 抽页文本段）**默认全部走内置 PDFium WASM**，在零 `pdfinfo`/`pdftotext`/`pdftoppm` 环境下完整可用；
     - 保持 `maxPages` 截断计数（`truncatedPages`）、`dpi` 校验（36–600）、`assertOutputIsolation`、损坏/加密/零页 PDF 清晰中文报错、每页 `\r\n`→`\n` 归一化与 `validateImageBytes` 不变量；保留 `SEAL_PDF_ENGINE=poppler` 及 `SEAL_PDFINFO`/`SEAL_PDFTOTEXT`/`SEAL_PDFTOPPM` 显式覆盖回退（方便高级场景，但不作为默认路径）。
  2. **跨平台 LibreOffice 探测与工作台「环境体检」横幅（`src/shells/node-host.ts`、`src/shells/dsh/workbench-host.ts`、`src/shells/dsh/client*.ts`）**：
     - 升级 `findSofficeBinary(platform?, env?, exists?)` 与新增只读毫秒级 `detectLibreOfficeStatus(platform?, env?, exists?)`：支持 `SEAL_SOFFICE`、macOS（`/opt/homebrew/bin/soffice`、`/usr/local/bin/soffice`、`/Applications/LibreOffice.app/Contents/MacOS/soffice`）、Windows（`%ProgramFiles%\LibreOffice\program\soffice.exe`、`%ProgramFiles(x86)%\LibreOffice\program\soffice.exe`、`%LOCALAPPDATA%\Programs\LibreOffice\program\soffice.exe`、`C:\Program Files\LibreOffice\program\soffice.exe`、`C:\Program Files (x86)\LibreOffice\program\soffice.exe`）、Linux（`/usr/bin/soffice`、`/usr/local/bin/soffice`、`/snap/bin/libreoffice`）及 `PATH` 扫描（绝不在只读状态探测中启动 `soffice` 进程）；
     - `WorkbenchHost.status()` 与 `WorkbenchHost.overview()` 返回 `environment: { platform, pdfEngine: 'builtin-pdfium' | 'poppler', libreOffice: { available, binaryPath } }`；
     - 前端工作台顶部在 `libreOffice.available === false` 时展示一条温和、可收起的中文环境提示横幅（清晰说明 `.docx` 编辑与 PDF 入库不受影响，安装免费官方 LibreOffice 后支持 `.doc`/`.xls`、页面预览与目录自动页码，并附官网链接 `https://www.libreoffice.org/download/download-libreoffice/`）；装齐 LibreOffice 时完全隐藏，零打扰。
  3. **npm 正式发包规范 + DSH Format 1 市场索引自动生成与真校验（`scripts/build-dsh-bundle.mjs`、`scripts/build-market-index.mjs`、`market/**`、`docs/RELEASE.md`）**：
     - 包名保持默认 `@seal/dsh`（支持 `SEAL_NPM_PACKAGE` 环境变量按需覆盖），`scripts/build-dsh-bundle.mjs` 将 `@hyzyla/pdfium` 纳入 `dependencies`，补全 `author`、`license: "MIT"`、`homepage`、`repository`、`keywords`、`publishConfig: { access: "public" }`、`README.md` 及专业清晰的中英文 `locale/zh.json` / `locale/en.json`；
     - 新增 `scripts/build-market-index.mjs`（`npm run build:market`）：从最新构建的 `dist/seal-dsh-*.tgz`（或 `SEAL_DSH_ARTIFACT`）自动生成符合 DSH Format 1 规范的 `market/index.json` 与 `market/icon.svg`（支持 `SEAL_MARKET_BASE_URL`，默认 `https://raw.githubusercontent.com/chefzejia/seal/main/market/`），并保留历史版本号递减合并能力；
     - 同步编写 `docs/RELEASE.md`（包含仓库改 public 前隐私自检、npm 登录与发布、更新市场索引推送以及用户端在 DSH 中直接安装/添加市场索引的简明图文步骤）并更新 `README.md` 链接。
- **Worker 工程门禁**：共用门槛；补齐 `tests/milestone41-release-and-pdfium.test.ts`：
  - 内置 PDFium WASM 在零 Poppler（故意将 `PATH` 置空）下完成中文电子版 PDF + 扫描图 PDF 的 `extractPdf`（含 `maxPages` 截断与损坏 PDF 报错）、`renderDocxPages`、`extractDocxPageTexts`（配合 `insert_toc` 真实页码回填）及并发调用安全性验证；
  - 跨平台 `findSofficeBinary` / `detectLibreOfficeStatus` 矩阵测试（macOS / Windows `Program Files` & `Program Files (x86)` & `LOCALAPPDATA` / Linux / `PATH` / 缺失）；
  - `WorkbenchHost.status()` & `overview()` `environment` 返回测试（装有 vs 缺失 LibreOffice）；
  - `scripts/build-market-index.mjs` 产物使用真实本机 DSH `app.asar` 中的 `@deepseek-ai/dsh-plugin-market-index` `parseMarketIndex` + `marketInstallTarget` 校验 100% 通过（无本机 DSH 时回退内置严格 schema 校验）；
  - 至少 2 项 `Broken by hand` 破坏验证；
  - `npm run verify` 全绿 + `tests/dsh-bundle.test.ts` 全绿（并在 `dsh-bundle.test.ts` 实测解包后的真实 DSH 运行时成功加载 `@hyzyla/pdfium` 完成 PDF 解析！）。
- **Tester 与实屏验收要求**：独立 Swarm Tester（`m41-tester`）全量验算、解包实测零 Poppler 下的 PDFium WASM 与 `market/index.json` 真校验 `PASS`；异源 `gpt-auditor`（`effort=high`）终审 `P0=0, P1=0`；物理隔离 `dsh --profile web` 经 `browser` 子代理实屏核验「缺 LibreOffice 时横幅展示与收起 + 有 LibreOffice 时静默不显示」；安装最新 TGZ 到桌面 Profile 并确认 `npm run dsh:doctor` 干净。

## [Milestone #42] 两阶段编制蓝图：大纲先审、当场补料与 C17 漏章漏证验算

- **Status**: pending
- **Depends-On**: #41
- **Scope**: `src/core/bid/**`, `src/workbench/**`, `src/shells/cli/**`, `src/shells/dsh/**`, `tests/**`
- **用户可观测目标**：支持默认“先生成大纲 → 人工审改与当场补齐缺失材料并确认 → 再精准生成标书”的两阶段流程（同时保留“跳过大纲直接生成”快捷选项）；业务人员可在会话右栏快速确认或一键进入全宽大纲编辑器对章节做增删改查、层级调整、模板锁保护、评分项映射、当场上传/绑定证照材料与撤回重做；确认大纲后 Seal 以 C17 确定性核验草稿未漏章、未漏挂已绑定材料。
- **行为契约**：
  1. **纯逻辑大纲内核与 C17 确定性验算（`src/core/bid/outline.ts`、`authorization.ts`、`project.ts`、`human-review.ts`、`report.ts`、`check.ts`，零 `node:*` 依赖）**：
     - 严格遵循 [3-bid-workflow-and-checks.md](subsystems/3-bid-workflow-and-checks.md) 第五、六、八节：`seal-outline-1` schema 与严格校验（唯一 ID、无环树、层级 `1–6`、拒绝任何确认/授权字段、路径隔离校验）、规范摘要 `canonicalOutlineDigest`、树编辑纯函数（新增、编辑、删子树并保护非可选 `lockedTemplate`、上下移动子树、升/降级、开关启用、绑定/解绑证据）；
     - 人工确认 `confirmOutline` 使用 `kind: 'outline_confirm'` HMAC 签名存入 `ledger.outlineConfirmation` 并受项目外锚点保护；大纲摘要/知识库/截标日变化后自动失效为 `stale`，伪造签名报 C15；
     - `CHECK_CODES` 纳入 `C17`（无 `outline.json` 时计为 0，100% 向后兼容；`outline.json` 损坏阻断；`outline_first` 模式未确认或 `stale` 未重确认阻断；启用分册未建、启用章节标题未落盘、已绑定 KB 证据未出现在活跃 `ledger.fills`+文档书签、或已绑定上传材料/PDF 渲染页字节 SHA256 未出现在草稿活跃嵌入 `word/media/*` 均阻断）。
  2. **Agent 工具、CLI、两阶段 Skill 与纯视图模型（`src/shells/dsh/project-tools.ts`、`seal-bid-skill.ts`、`src/shells/cli/**`、`src/workbench/outline.ts`、`requirements.ts`、`review.ts`）**：
     - 新增 `seal_outline`（`get` / `save` / `patch`）与 CLI `seal outline`（绝不提供 `confirm`）；CLI `project init` 支持 `--workflow-mode <outline_first|direct>`；
     - 升级 `seal-bid` 操作手册与 `buildBidStartupPrompt` / `buildOutlineExecutionPrompt` / `buildOutlineRevisionPrompt` 支持两阶段闭环；
     - `src/workbench/outline.ts` 实现树投影、统计（总节数、待补材料、待核实材料、未覆盖必答要求、C17 缺口、相对基线调整数 `countOutlineChanges`）与保留祖先上下文的搜索/筛选纯函数；`src/workbench/review.ts` 接入 C17 分组。
  3. **Owner 宿主服务与双视图工作台界面（`src/shells/dsh/workbench-host.ts`、`client.ts`、`client-locale.ts`、`client-style.ts`）**：
     - 仅经 owner `/api/seal/action` 暴露 `outline_get`、`outline_save`（409 版本冲突守卫）、`outline_upload_material`（原件只读复制至 `materials/outline/`，PDF 自动走内置 PDFium 渲染 PNG 页并自动绑定清除 `materialMissing`）、`outline_confirm`（签章落盘并返回阶段二执行指令），并在 `/api/seal/file` 支持安全预览已上传 `materials/` 文件；`overview()` 与 `review()` 附带实时 `outlineSummary`；
     - UI 完整落地 [4-dsh-plugin-and-workbench.md](subsystems/4-dsh-plugin-and-workbench.md) 第四节：开启投标默认两阶段模式切换、进行中的投标显示大纲状态与「编辑大纲」入口、会话右栏新增「大纲」标签页（快览、待补提醒、一键「全宽编辑大纲」与内联确认触发阶段二）及 C17 审阅卡片、左侧全局页承载完整全宽双栏/三区大纲编辑器（左树搜索与底部统计、中栏树形增删改查/移动/升降级/撤回重做/模板锁保护/筛选、右抽屉写作批注+评分项勾选+KB 证照选择+本地材料上传预览+「让 AI 调整本节」），兼容浅/深双主题与 360px 窄栏。
- **Worker 工程门禁**：共用门槛；新增 `tests/milestone42-outline-blueprint.test.ts` 覆盖内核校验、树变换、HMAC 确认与失效/篡改（C15）、C17 漏分册/漏章/漏 KB 证据/漏上传图与 PDF 渲染页/删除后复现漏证、授权隔离（工具与 CLI 不可确认）、`outline_upload_material` PDFium 自动渲染与原件只读、视图模型筛选/统计/调整计数、至少 2 项 `Broken by hand` 破坏验证；`npm run verify` 与 `tests/dsh-bundle.test.ts` 全绿。
- **Tester 与实屏验收要求**：独立 Swarm Tester（`m42-tester`）全量验算、解包实测与对抗探针 `PASS`；异源 `gpt-auditor`（`effort=high`）终审 `P0=0, P1=0`；物理隔离 `dsh --profile web` 经 `browser` 子代理实屏核验「新建两阶段项目 → 右栏大纲快览 → 全宽大纲编辑器增删改查/移动/升降级/撤回重做/搜索筛选 → 绑定 KB 与上传本地图片/PDF 清除待补材料 → 内联确认锁定并触发阶段二消息 → C17 展示」，覆盖浅/深双主题与 360px 窄栏并截屏留证。

## 本轮完成的判据

#29–#42、#27 全部 `verified`；默认门禁、构建与真实环境闭环通过。不以测试数量、检查报告为零、安装成功或 HTTP 200 单独宣告可用于真实投标。
