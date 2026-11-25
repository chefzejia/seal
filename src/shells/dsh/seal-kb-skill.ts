export const SEAL_KB_SKILL = {
  name: "seal-kb",
  description:
    "在 Seal 中将多格式机构材料（Word/PDF/图片/表格/文本或本地目录）入库并分类整理为主体档案、证据记录与写作素材的标准操作手册；收到建库、入库或整理待分类候选任务时先加载本手册。",
  source: "bundled" as const,
  content: `# Seal 知识库建库与候选整理操作手册

## 铁律（严格遵守）

1. **原件 100% 只读，只经 Seal 工具读写知识库**：严禁修改用户原件，也不要用通用文件工具或 Shell 直接写入 \`subject.md\`、\`records/\`、\`materials/\`、\`inbox/\` 或 \`log.jsonl\`；入库与建档全部通过 \`seal_kb_ingest\`、\`seal_kb_search\`、\`seal_kb_get\`、\`seal_kb_save\` 执行。
2. **绝不越权设置核实状态**：严禁传 \`verified\`、\`verifiedAt\`、\`verifiedFields\` 或 \`__seal*\` 字段；一切入库内容均为未核实状态，必须留给用户在「知识库中心」人工核实。
3. **看不清或原文缺失绝不编造**：证照编号、持证方、有效期或业绩金额在原件/图片中看不清或未写明时，保持字段缺省（普通带有效期的资质/许可/认证证书若原件未印到期日，必须留空由人核对，不得猜测或写成 \`不适用\`；\`不适用\` 仅限原文明确写明）。**新版营业执照处理**：中国 2019 年改版后的新版营业执照证面本身依法不再印制「营业期限」栏，如营业执照原图清晰且未标注固定届满日期，\`validUntil\` 应填 \`长期\` 并在正文注明“新版营业执照证面无固定营业期限栏，请人工复核章程及公示状态”（仍保持未核实态，由人在工作台最终核实）。

## 标准四步建库流程

### 1. 多格式材料入库（\`seal_kb_ingest\`）
- 若用户直接给出文件或资料文件夹路径，调用 \`seal_kb_ingest(vaultId, files=[...])\`；支持直接传入混合文件路径或本地目录路径：
  - Word（\`.docx\` / \`.doc\`）：按大纲章节拆分候选并提取内嵌图片；
  - PDF（\`.pdf\`，含电子版与纯扫描件）：提取文本层并按页渲染高清可挂载 PNG（存档原 PDF），超过安全渲染上限时透明返回 \`truncatedPages\`；
  - 散装图片（\`.png\` / \`.jpg\` / \`.jpeg\` / \`.gif\` / \`.bmp\` / \`.tif\` / \`.tiff\` / \`.svg\` / \`.wmf\` / \`.emf\` / \`.webp\`）：真实验码，\`.webp\` 自动转为 \`.png\`；
  - 表格（\`.xlsx\` / \`.xls\` / \`.ods\` / \`.csv\` / \`.tsv\`）与纯文本（\`.txt\` / \`.md\`）：按工作表/行窗或段落分块转为候选。
- 若返回 \`skipped\`，如实向用户说明被跳过的无关文件。

### 2. 分页读取待分类候选（\`seal_kb_search\` + \`seal_kb_get\`）
- 使用 \`seal_kb_search(vaultId, batchId, after, limit)\` 翻页获取批次内候选 ID。
- 使用 \`seal_kb_get(vaultId, id, offset)\` 逐页读取候选正文；当存在 \`nextOffset\` 时传入 \`offset: nextOffset\` 续读完整内容。

### 3. 看图读表提取结构化字段
- 遇到含扫描件或内嵌图片的候选（包括 Word 母本拆出的图片、PDF 渲染页与散装图片）时，检查候选 \`files\` / \`imageFiles\` 与正文中的图片相对路径，直接读取 \`<vaultRoot>/<relPath>\` 查看图像内容，按允许字段清单提取（严禁传 \`verified\`、\`verifiedAt\`、\`verifiedFields\` 或 \`__seal*\`）：
  - **主体档案（\`subject\`）允许字段**：\`legalName\`、\`creditCode\`（18 位统一社会信用代码，须符合 GB 32100 校验位）、\`legalRepresentative\`、\`registeredCapital\`、\`establishedOn\`（\`YYYY-MM-DD\`）、\`address\`、\`phone\`、\`email\`、\`bankName\`、\`bankAccount\`、\`forbiddenAffiliates\`（字符串数组）、\`thirdPartyHolders\`（字符串数组）；
  - **证据记录（\`record\`）允许字段**：\`type\`（\`营业执照 | 资质证书 | 认证证书 | 许可证 | 人员证书 | 社保证明 | 业绩合同 | 验收证明 | 财务审计 | 纳税证明 | 信用证明 | 授权文件 | 其他\`）、\`title\`、\`number\`、\`holder\`（人员证书另填 \`employer\`）、\`issuedOn\`（\`YYYY-MM-DD\`）、\`validUntil\`（\`YYYY-MM-DD\` / \`长期\` / 明确写明时填 \`不适用\`）、\`client\`、\`projectName\`、\`amount\`、\`signedOn\`（\`YYYY-MM-DD\`）、\`files\`（库内相对路径字符串数组）、\`source\`、\`tags\`（字符串数组）；
  - **写作素材（\`material\`）允许字段**：\`title\`、\`tags\`（字符串数组）、\`source\`、\`files\`（库内相对路径字符串数组）；公司简介、方案段落、工艺说明、案例描述写入 \`body\`。
- **以最新有效证照原图为准**：当历史文字表格（如旧企业基本情况表）与最新证照原图（如新版营业执照、基本存款账户信息）中的注册资本、成立日期、法定代表人、住所、开户行或经营范围存在冲突时，主体档案与证照记录必须以最新有效证照原图为准，并在正文注明与旧文字表的差异供人核实；营业执照的完整「经营范围」须一并转录入营业执照记录正文，方便后续编标引用。

### 4. 保存建档、挂载库内图片并批量清理候选（\`seal_kb_save\`）
- 用 \`seal_kb_save(vaultId, action="update"|"create", kind="subject"|"record"|"material", fields, body, dismissCandidateIds?)\` 写入条目；传入 \`dismissCandidateIds: ["candidate-..."]\` 可在保存成功时原子标记关联候选已处理。
- **\`files\` 库内相对路径规则与挂载语法（切勿留空）**：凡来源于已入库候选（**Word 母本拆出的 \`files/<batchId>/source-N/...\`**、PDF 渲染 PNG \`files/<batchId>/src-N/page-NNN.png\` 或散装图片）的证照与证明记录，新建/更新 \`record\` 时**必须**在 \`fields.files\` 中直接写入对应的库内相对路径（绝不留空，也绝不写本机绝对路径），后续编标才能通过 \`kb:<recordId>/<relPath>\`（如 \`![证书](<kb:<recordId>/files/<batchId>/source-1/0001-image.jpeg>)\`）挂载扫描件原图。若需追加库外本地原件，使用 \`action="attach_file"\`。
- 对纯冗余/无需建档的候选或需集中收尾时，使用 \`seal_kb_save(vaultId, action="dismiss_candidates", ids=["candidate-..."])\` 一次性批量标记已处理（或单条 \`action="dismiss_candidate"\`）。
- 全部候选处理完成后，向用户汇报已建档的主体、证据记录与写作素材清单，提示哪些条目/字段尚缺或效期未知，并引导用户在「知识库中心」人工核实。`,
};
