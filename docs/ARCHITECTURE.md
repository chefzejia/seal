# 架构总纲

本文是 Seal 分层、模块、数据流与数据所有权的总纲。产品定义见 [PRODUCT.md](PRODUCT.md)，协作角色见 [ROLES.md](ROLES.md)，执行队列见 [TASKS.md](TASKS.md)。

## 一、三层单向架构

依赖方向只允许 `shells → workbench → core`，由 `tests/boundaries.test.ts` 按解析后的导入目标静态检查。

| 层 | 目录 | 职责与硬边界 |
| :--- | :--- | :--- |
| **1. 内核** | [`src/core/`](../src/core/) | 纯逻辑，零宿主依赖：`docx/`（Word 引擎）、`kb/`（知识库）、`bid/`（投标项目、台账、检查与定稿闸门）、`host.ts`（`HostPort`）。禁止导入 `node:*`、`@deepseek-ai/*` 与上层目录。可以使用纯 JavaScript 依赖（如 `saxes`）。 |
| **2. 视图模型** | [`src/workbench/`](../src/workbench/) | 工作台界面的纯视图模型：审阅清单分组、知识库健康摘要、状态文案与格式化。不含 DOM、React 或网络请求，只导入 `src/core/`。 |
| **3. 宿主薄壳** | [`src/shells/`](../src/shells/) | `dsh/`：DSH 插件（Agent 工具、`seal-bid` skill、Host 服务与路由、React 客户端）；`cli/`：开发与测试入口。唯一允许使用 `node:*`、`@deepseek-ai/*`、子进程与 LibreOffice 的层，负责实现 `HostPort`。 |

## 二、模块地图

| 模块 | 职责 | 契约 |
| :--- | :--- | :--- |
| `src/core/docx` | 文档视图（带地址的分页文本）、疑似空白提示、区间复制、编辑原语、差异比较、文件合法性、待定标记可见性、定稿清理 | [2-word-engine.md](subsystems/2-word-engine.md) |
| `src/core/kb` | 企业知识库：主体档案、证据记录、写作素材的存储与校验；母本入库；检索；有效期与持证主体体检 | [1-knowledge-base.md](subsystems/1-knowledge-base.md) |
| `src/core/bid` | 投标项目目录、草稿分册、台账、事实引用解析、待定项与人工确认、检查目录、招标要求清单、定稿闸门 | [3-bid-workflow-and-checks.md](subsystems/3-bid-workflow-and-checks.md) |
| `src/workbench` | 指挥台与审阅栏的视图模型 | [4-dsh-plugin-and-workbench.md](subsystems/4-dsh-plugin-and-workbench.md) |
| `src/shells/dsh` | DSH 插件：工具、skill、命令、Host 服务、客户端 | [4-dsh-plugin-and-workbench.md](subsystems/4-dsh-plugin-and-workbench.md) |
| `src/shells/cli` | 与 Agent 工具对应的命令行入口，供开发与测试使用；不提供人工确认与定稿 | [4-dsh-plugin-and-workbench.md](subsystems/4-dsh-plugin-and-workbench.md) |

## 三、端到端数据流

```text
招标文件（只读原件）                       企业母本、扫描件（只读原件）
   │ 复制、.doc 转 .docx                         │ 复制
   ▼                                             ▼
项目 tender/ ──seal_doc_read / extract──┐    知识库 inbox/（入库候选）
                                        │        │ seal_kb_save（Agent 分类、摘字段，待核实）
                                        ▼        ▼
                      draft/<分册>.base.docx    subject.md · records/ · materials/ · files/
                      （复制时的基准，只读）         │            ▲
                                        │ 复制      │ 事实引用     │ 人核实关键字段（工作台）
                                        ▼          ▼            │
Agent ──seal_doc_edit（编辑原语 + 事实引用）──▶ draft/<分册>.docx + ledger.json
                                        │
                              seal_check（Agent 自查；审阅栏展示）
                                        ▼
人（工作台：确认待定、接受改动、过目跳过的空白）──▶ ledger.json ──定稿闸门──▶ final/<分册>.docx
```

## 四、数据所有权

| 路径 | 内容 | 唯一写入者 | 可否删除重建 |
| :--- | :--- | :--- | :--- |
| 用户原件（招标文件、母本、扫描件） | 原始资料 | 无，100% 只读 | 否 |
| `~/.seal/vaults/<vaultId>/` | 企业知识库 | `src/core/kb`（经 Agent 工具或工作台调用） | 否 |
| `~/.seal/projects/<projectId>/` | 一次投标的项目目录，同时是该 AI 会话的工作目录 | `src/core/bid` 与 `src/core/docx` | 草稿、基准稿与台账否；`review/`、`final/` 可由草稿与台账重新生成 |
| `.tmp/` | 测试沙盒、评测语料、验收证据、`.tmp/worktrees/` | Router / Worker / Tester | 是 |

环境变量 `SEAL_HOME` 覆盖 `~/.seal`。测试必须把它指向 `.tmp/` 下的临时目录，不得读写真实的 `~/.seal`。

## 五、关键设计决定

1. **草稿永远可出，定稿才设闸门。** 旧设计“槽位以外的 XML 一变就拒绝输出”既误拒过正确输出，又放过了真实母本中 25 张图片被删的情况。现在只有会损坏文件或引用失效证据的编辑被当场拒绝；其余问题标在 Word 与检查报告中，由人在定稿前处理。
2. **按“地址 + 原文锚点”编辑，不再只能填预先识别的槽位。** 识别规则只生成“疑似空白”提示与检查清单，提示不记身份，每次从当前草稿重新识别；识别漏掉的空，Agent 照样能填；识别错了，代价只是 Agent 写一句跳过理由。
3. **差异报告只比较基准稿与草稿，不读取编辑记录，也不使用识别规则。** “填空”与“改写原文”只按被替换的原文是否全是空位字符区分；编辑执行与检查相互独立，不能共用同一个误判来互相证明；人在 Word 里改过的草稿同样能查。
4. **事实优先引用，只对敏感项与未核实引用标黄。** `{{subject.creditCode}}` 等引用由 Seal 解析为值并记录来源；核心商业敏感参数（报价、工期交期、质保）、Agent 显式声明待定项，以及引用了未核实/未知效期/未知主体知识库资料的填写自动待定；常规非敏感内容填充与自拟正文信任 AI 整合与生成，默认白底呈现。
5. **主体检查针对全文的封闭集合**（禁用关联企业名称、统一社会信用代码的格式与校验位），不再推断哪个格子是“主体位”。
6. **流程知识写进随插件发布的 `seal-bid` skill，代码只提供能力与检查。** 提升 Agent 表现优先改 skill 与工具描述，并用多份真实招标文件评测，而不是增加识别规则。
7. **授权类操作只由人执行（单用户桌面三层信任模型）。** 确认待定、接受原文改动、过目跳过、核实资料、覆盖标记与定稿导出只在工作台提供，其余操作由工作台与 Agent 工具共用同一个 Host 实现。在当前单 OS 用户桌面宿主（DSH `0.2.2-rc.5`）下，防越权由三层明确边界组成：
   - **接口隔离**：Agent 工具与 CLI 不暴露授权/核实/定稿入口；工作台变更只走宿主 owner 认证的精确 Host 路由（`peer.principal.kind === 'owner'`）。
   - **项目外写隔离与权威锚点（主防篡改边界）**：在 DSH 推荐的 `workspace-write` 模式下，宿主沙盒（`SandboxedFileSystem` + OS 写隔离）允许读但禁止写会话工作目录（`SEAL_HOME/projects/<id>/`）之外的路径。权威台账快照保存在项目外的 `SEAL_HOME/ledgers/<hash>.json`，知识库与核实记录保存在项目外的 `SEAL_HOME/vaults/`。即使同用户 Agent 读到项目外文件（包括 `SEAL_HOME/keys/authorization.key`）并试图重签篡改项目内的 `ledger.json`，因无法改写项目外锚点与知识库目录，`resolveLedger()` 仍会丢弃伪造、恢复权威快照并以 C15 阻断定稿。
   - **HMAC 与内容指纹**：检测普通误改与未经授权的项目内变更，并在内容、知识库或截标日变化时使旧确认自动失效。
   - **明确不虚报的边界**：DSH `0.2.2-rc.5` 不提供跨 FS/shell 的路径读隔离；`SEAL_HOME/keys/authorization.key` 的 `0600` 仅防其他 OS 用户，不宣称对同 OS 用户进程（尤其是用户主动开启 `danger-full-access` 解除写隔离时）具备密码学读保密边界。不向进程暴露密钥字节的宿主签名服务属于上游宿主能力演进项，在验收报告中如实披露，不阻断工作台验收。
8. **身份放在文档里，不靠偏移量追踪。** 待定内容与事实引用写入的内容用 Word 隐藏书签（Seal 范围）包住，身份随文字移动；台账只记编号对应的信息。#23 的教训：把身份存在文档外、每次编辑后重新对位，遇到重复文字、跨段迁移和部分覆盖时必然产生歧义，补得再细也补不完。
9. **版面几何显式化与保守冗余。** 插图尺寸只由一个表格与页面几何模型计算；Seal 生成的表格与图片段落写明确几何与中性段落属性（主动隔离脏模板继承缩进与行距）；对纯 XML 无法确定的外部排版（如不等宽多栏的自然流动）采用保守安全下界，对几何上不可能容纳的容器保持草稿可出并由 C16 透明报出。#24 与 #29 的教训：靠可选线索推断单元格宽度或试图按样本打补丁，现实文档里每种写法都会冒出新的裁切或分页问题。
10. **通用传统 Office 交付底座 + 场景策略分离，第一性原理优先。** `src/core/docx` 与 `src/core/kb` 面向所有受控传统 Office 格式交付场景，不得渗入招投标专属假设；招投标只是首个端到端打穿的具体场景，其领域规则（截标日、商业敏感词、招标要求清单、`seal-bid` skill）收口在 `src/core/bid` 与 skill 中。所有核心机制拒绝“先有样本再写代码”的局部拟合：对未知、缺省、历史转换或异构结构留足保守冗余，测试须覆盖机制输入域的退化/极端构造，而非只锁住已知语料。

## 六、子系统契约

- [1. 知识库](subsystems/1-knowledge-base.md)
- [2. Word 引擎](subsystems/2-word-engine.md)
- [3. 投标流程、台账与检查](subsystems/3-bid-workflow-and-checks.md)
- [4. DSH 插件与工作台](subsystems/4-dsh-plugin-and-workbench.md)
