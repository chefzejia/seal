export const SEAL_BID_SKILL = {
  name: "seal-bid",
  description:
    "在 Seal 中完成两阶段（先审大纲再编制，默认）或直接编制模式的投标文件编写、招标要求保存、编制大纲共编、格式提取、知识库引用、证据挂载与自检交接的标准操作手册；收到编标或投标任务时先加载本手册。",
  source: "bundled" as const,
  content: `# Seal 投标编写操作手册

## 铁律（严格遵守）

1. **只经 Seal 工具操作文档与资料**：草稿（\`draft/\`）、台账（\`ledger.json\`）、要求清单（\`requirements.json\`）、编制大纲（\`outline.json\`）与企业知识库只能通过 \`seal_*\` 工具读写；严禁用通用文件工具、Shell 或脚本直接修改 XML、JSON 或知识库文件。
2. **禁止越权与编造**：商业决定确认、大纲确认锁定、原文改动接受、跳过空白过目、资料核实、要求覆盖标记与终稿导出只能由人在 Seal 工作台执行。绝不编造不存在的资质、业绩、产品参数、金额或证据记录。

## 两种工作模式

- **两阶段模式（\`outline_first\`，工作台默认）**：先执行**阶段一**（读招标文件 + 保存 \`requirements.json\` + 检索知识库预匹配证照 + 调用 \`seal_outline(action="save")\` 提交结构化编制大纲草案），随后向人汇报并**立即暂停等人确认**；在人确认大纲前**严禁**调用 \`seal_doc_extract\` 或 \`seal_doc_edit\` 编辑草稿。待人在工作台点击「确认大纲并开始生成标书」后再执行**阶段二**。
- **直接编制模式（\`direct\`）**：用户显式选择跳过大纲直接生成时，直接从阶段二流程开始。

## 阶段一 · 读标、存要求并拟定编制大纲（\`outline_first\` 模式完成本步即停下等人审）

1. **读招标文件并保存要求清单**：
   - 先用 \`seal_doc_read(file, mode="outline")\` 查看登记招标副本（如 \`tender/1.docx\`）的章节目录、块范围与疑似空白分布。
   - 再用 \`seal_doc_read(file, mode="blocks" | "search", from, to, onlyHints, limit, maxChars, cursor)\` 分页精读（支持传 \`to\` 限定闭区间，或 \`onlyHints=true\` 仅看含疑似空白的块）：找出投标文件格式所在章节、投标文件组成与分册要求，以及全部资格要求、评分项、实质性条款、废标条款、格式要求与递交要求。
   - 调用 \`seal_requirements(action="save", items=[...])\` 保存要求清单：
     - 每项包含 \`id\`、\`kind\`（\`资格要求 | 评分项 | 实质性条款 | 废标条款 | 格式要求 | 递交要求\`）、\`text\`、\`quote\`、\`source: { file, address }\`、\`mustRespond\`、\`responses: [{ draft, address }]\`，可选 \`points\`、\`evidence\`。
     - \`quote\` 必须出现在 \`source.address\` 指向块或其前后 5 个块内（仅允许空白与全半角等价）。
     - 尚无草稿地址时，\`mustRespond: true\` 允许先设 \`responses: []\` 保存，后续在阶段二用 \`action="patch"\` 回写响应位置。
2. **检索知识库预匹配**：
   - 使用 \`seal_kb_search\` / \`seal_kb_get\` 检索可用的主体字段、证照记录与写作素材，梳理已具备的证据与缺失材料清单。
3. **提交结构化编制大纲草案（\`seal_outline(action="save")\`）**：
   - 标明 \`volumes\`（分册名、关联 \`tender\` 与 \`ranges\`）；
   - 按文档顺序列出 \`nodes\`（\`id\`、\`volume\`、\`parentId\`、\`level\` 1–6、可选 \`number\`、\`title\`、\`kind: "template" | "authored" | "attachment"\`、\`included\`）：
     - 固定格式节点设 \`kind: "template"\`、\`lockedTemplate: true\` 与 \`tenderSource: { file, ranges }\`（可选部分设 \`optional: true\`）；
     - 自拟章节设 \`kind: "authored"\` 并关联评分/技术要求 \`requirementIds\`；
     - 证明材料设 \`kind: "attachment"\`，绑定已匹配的 KB 记录（\`evidence: [{ source: "kb", ref: "<recordId>", label?, thirdPartyHolder? }]\`），对确实缺失的材料标 \`materialMissing: true\` 与 \`materialNote\`。
4. **汇报并暂停等人确认**：
   - 向人汇报大纲结构、评分项覆盖情况与待补材料清单，提示可在右侧栏或全宽大纲编辑器增删改查章节、补传扫描件/PDF，并点击「确认大纲并开始生成标书」。
   - 若收到人在对话中的大纲修订意见，调用 \`seal_outline(action="patch" | "save")\` 协同更新后继续等待人确认。

## 阶段二 · 按确认大纲编制草稿（\`direct\` 模式直接从本阶段开始）

### 1. 读入最新确认版大纲
- 若项目存在 \`outline.json\`，先调用 \`seal_outline(action="get")\` 读入最新人工确认版大纲（含人调整后的章节树、单节 \`note\` 写作批注、已绑定的 KB 记录、以及人在大纲页补传的 \`materials/\` 文件与 PDF \`renderedPages\`）。

### 2. 复制格式文件创建分册
- 严格按确认大纲中含启用节点（\`included: true\`）的分册与 \`ranges\` 调用 \`seal_doc_extract(tender, draft, ranges)\`（\`ranges\` 为有序 \`[{ from, to }]\` 顶层块区间）创建各分册草稿（\`direct\` 模式若无 \`outline.json\` 则直接先读招标文件保存 \`requirements.json\` 再提取）。
- 选定 \`ranges\` 起点时，**必须跳过招标文件自身的章节大标题与总说明**（如“第X章 投标文件格式”“格式说明”等非投标文件正文段落），直接从真正的投标文件封面或首项格式正文开始提取；若不慎带入招标章节标题，务必用 \`delete\` 清除。

### 3. 填写格式文件
- 用 \`seal_doc_read(file="<分册名>", mode="blocks", from, to, onlyHints)\` 读取草稿与 \`⟦序号:…⟧\` 疑似空白提示；注意不要在编辑时把阅读前缀当原文。
- 封面上的二选一提示（如“正（或副）本”“正本/副本”）不可原样保留：若招标要求区分正副本，默认按本分册属性改为“正本”（或对应分册标识）；若为不区分正副本的纯电子标，按招标递交要求删除或留空。
- 用 \`seal_doc_edit(draft, ops=[...])\` 提交原子批次（任一项失败整批不落盘，失败时会返回 \`index\`、\`at\` 与 \`currentBlock\` 供直接修正）：
  - \`{ op: "replace", at, find | blank, value, pending?, thirdPartyHolder? }\`（\`find\` 与 \`blank\` 二选一）
  - \`{ op: "set_cell", at, value, pending?, thirdPartyHolder? }\`
  - \`{ op: "check", at, option, checked, pending? }\`
  - \`{ op: "insert_rows", at, mode: "after" | "replace", rows, pending?, thirdPartyHolder? }\`
  - \`{ op: "mark_pending", at, find | blank, pending }\`
  - \`{ op: "insert_toc", at, position: "before" | "after", maxLevel? }\`
  - \`{ op: "delete", at }\`
  - \`{ op: "dismiss_hint", at, blank, reason }\` 或批量跳过 \`{ op: "dismiss_hints", targets: [{ at, blanks? }], reason }\` / \`{ op: "dismiss_hints", from, to, reason }\`（仅当确认疑似空白确实无需填写时使用）
- **事实引用**：主体字段用 \`{{subject.<字段>}}\`，证据记录字段用 \`{{record:<id>.<字段>}}\`，招标/项目材料原文片段用 \`{{quote:<项目内相对路径>|<原文片段>}}\`。
- **内容信任 AI、仅敏感项标黄**：常规格式填写与表格扩展由 AI 结合知识库与招标要求直接写成正式白底正文；**仅对极少数真正需要企业决策者拍板的敏感项声明 \`pending\`**（报价/税率/保证金、具体交期/工期、质保/免费维保年限、实质性负偏离、签章日期、真实资料缺口、未核实 KB 引用；\`category\` 为 \`报价 | 工期交期 | 质保 | 偏离 | 承诺 | 待核对 | 其他\`）。未核实 KB 引用会自动标为 \`待核对\`；无库模式下无法核实的硬性缺口才标待定。

### 4. 撰写自拟章节
- 严格覆盖确认大纲中全部 \`included: true\` 节点标题（含单节 \`note\` 写作要求）并逐项对照 \`requirements.json\` 中的评分项与技术/服务要求组织正文；先调用 \`seal_kb_search\` / \`seal_kb_get\` 检索可用写作素材与企业事实，再结合本项目要求改写。
- 用 \`seal_doc_edit\` 的 \`{ op: "insert", at, position: "before" | "after", markdown }\` 写出结构完整、实质响应评分细则的正文段落、实施细节与响应对照表（避免只留一句空泛提纲），不覆盖固定原文。
- **默认白底正式正文，严禁泛化标黄**：自拟正文与常规技术偏离表/响应表直接作为正式白底内容交付，**严禁**对整章自拟方案或整张偏离表批量挂 \`pending\`，也不要通篇写“待审定”。若某段落内仅有个别数值需企业决策者拍板或存在真实资料缺口，先写出正常正文，再用 \`mark_pending\` 局部标出该短语；对于大纲中 \`materialMissing: true\` 且未绑定材料的节点，建好对应章节并留黄标占位；不编造资质、业绩与数据。

### 5. 挂载证明材料、生成目录与回写响应位置
- **挂载知识库证据**：用 \`seal_kb_search\` / \`seal_kb_get\` 选取相关证据记录（**已过期、禁用主体、主体不符**的记录不可引用；**只要知识库中确实存在且未过期、主体相符的证照，即便当前为未核实或效期未知，仍必须照常写入事实并挂载其 \`fields.files\` 扫描件进对应章节**——Seal 会自动标黄交人在审阅台核对，绝不可跳过不挂载并在草稿中误报“知识库未检出”）。使用第三方资料时必须在操作中显式传入 \`thirdPartyHolder: "<持证方>"\`。
- **挂载大纲绑定的全部上传材料**：大纲节点中 \`source: "material"\` 的绑定文件（\`materials/...\` 单图，或 PDF 的 \`renderedPages\` 全部渲染 PNG 页）必须全部使用 \`insert_image(at, image)\` 或 \`insert\` 内 Markdown 图片 \`![说明](<路径>)\` 挂载到对应章节（\`kb:<recordId>/<relPath>\` 用于 KB 图片），一个不漏（漏页会触发 C17 阻断）。
- 完成后优先调用 \`seal_requirements(action="patch", items=[{ id, responses: [{ draft, address }], evidence?: [...] }])\` 增量回写响应位置与证据 ID（仅在新增/改写原文引文时才用 \`action="save"\`）；不要把“已保存要求”当作“响应充分”。
- **生成/刷新原生目录**：所有章节与证照编写完成后、进入最终自检前，若模板含“目录 / （投标人自行编写）”占位页，清理占位提示文字（若该段末尾可能带原生分页符，优先用 \`replace(..., value: "")\` 清空文字而非整段 \`delete\`，以保留正文首章分页）并调用 \`insert_toc\` 自动生成或刷新带真实页码的原生目录。

### 6. 自检循环
- 调用 \`seal_check\` 检查全部分册（\`ready\` 始终反映全部分册未截断的完整阻断计数；C08 仅“已过期”阻断，“即将过期”为提示；用 \`offset\`/\`limit\` 或 \`group\` 翻阅剩余项）。
- 优先修正 AI 可处理的问题：遗漏空白（C02）、无效引文（C14）、无效日期（C11）、金额大小写不一致（C13）、图片超出版面（C16）、缺少响应位置（C12）、**大纲漏章或漏挂已绑定材料/渲染页（C17）**。
- 填写 \`【…】\` / \`（…）\` 类括号占位符产生的 \`bracketText\`（C06）属于预期的人审批量接受项，无需为消除 \`bracketText\` 反复改写或排查内部源码；AI 可处理项处理完毕后即应回写 \`requirements\` 响应位置并进入步骤 7 向人交接。
- 应由人拍板的 C03/C04/C05/C06/C07 与 C15 异常不得越权消除，也不要无意义空转。

### 7. 向人交接
- 按分册总结：已完成内容与结构、待人拍板的商业参数（报价/工期/质保/偏离/承诺）、来源待核实的事实、原文改动及原因、仍缺的资料与要求缺口、C17 大纲一致性状态、剩余检查项及请在右侧工作台核对/确认/标记覆盖/导出终稿的下一步指引。`,
};
