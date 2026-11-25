# 真实招标评测语料

本目录只提交索引与人工标注。4 份公开文件包含货物 1 份、服务 2 份、工程 PDF 对照 1 份，招标人互异；另登记既有黄金样本。公开文件与衍生转换存入主仓库 `.tmp/corpus/`，页面证据存入 `.tmp/evidence/`，均不作为 Git 夹具提交。

| id | 招标人 | 品类 / 原始容器 | 格式章节渲染页 / 印刷页 |
| --- | --- | --- | --- |
| `luoding-tax-property-2023` | 罗定市税务局 | 服务 / DOCX | 63 / 63 |
| `zhengzhou-goods-2023` | 郑州市第一人民医院 | 货物 / DOCX（官网后缀 `.doc`） | 54 / 51 |
| `sccc-property-2022` | 四川化工职业技术学院 | 服务 / DOCX | 18 / 16 |
| `forestry-construction-2024` | 林草调查规划院 | 工程 / PDF 对照 | 161 / 160 |
| `golden-template` | 既有只读输入 | DOC，路径由环境变量提供 | 85 / 83 |

`renderedPage1` 是 2026-11-16 本机渲染 PDF 从 1 起算的物理页，不是稳定文档地址。目录页码、页脚页码与物理页可能不同；定位应先搜索格式章标题，再使用该格式内的原文锚点。四川样本第 33 页上半部仍有格式 10 的落款，下半部开始第七章，不能按整页截取格式章。

## 获取与核验

1. 在 [manifest.json](manifest.json) 中逐份打开 `source.pageUrl`，核对官方发布主体、项目身份和附件名称，再手动下载 `source.downloadUrl`。发布日期表示该来源页的发布日期，不保证其附件是现行招标版本；本语料冻结下载时的字节。
2. 将公开文件放入 `$SEAL_CORPUS_DIR/<id>/tender.docx`，PDF 对照使用 `tender.pdf`。`SEAL_CORPUS_DIR` 显式指向语料根目录，例如本仓库的 `.tmp/corpus`。河南附件虽命名 `.doc`，实际是 OOXML ZIP：仅按 `.docx` 命名保存相同字节，不做转换。
3. 显式将 `SEAL_GOLDEN_DOC` 设为已有黄金 `.doc` 原件。索引不保存其路径，也不自动搜索用户目录。原件只读，所有转换和渲染在 `.tmp/` 工作副本进行。
4. 在仓库根目录运行：

```bash
node tests/corpus/verify.mjs --metadata-only
SEAL_CORPUS_DIR="$PWD/.tmp/corpus" node tests/corpus/verify.mjs
```

第二条命令同时需要已设置的 `SEAL_GOLDEN_DOC`，逐份核对 SHA256、文件大小与容器签名；缺少环境变量会明确失败。脚本不联网、不转换文件，不写入任何输入。它不验证语义、页面位置或标注召回率。默认 `npm test` 不读取这批真实文件；后续集成测试同样经环境变量显式开启。

Word 渲染使用 LibreOffice Writer 的正式 `--headless --convert-to pdf --outdir <临时目录>` 入口，`.doc` 先在工作副本中转成 `.docx`。每次提供单独的 `-env:UserInstallation=file:///...` 临时配置目录，并确保有中文字形。用 `pdftoppm -f <页码> -l <页码> -singlefile -png` 导出目标页后人工看图。PDF 对照直接保留源 PDF，并以 LibreOffice Draw 重导第 161 页复核中文字形与标题位置；不重建 Word。

本次来源 HTML、下载阻碍、LibreOffice 日志、只读结构摘要、页文本和亲自看过的页面图归档于主仓库 `.tmp/evidence/task-22/worker/`。渲染页可从原文件重新生成；字体与 LibreOffice 版本变化时重新定位，不把这里的页码写进生产逻辑。

## 标注口径

[labels](labels) 每份选择两个实际格式文件。每项按原文位置记录，字段同义也不合并不同出现位置；一组年月日作为一个逻辑日期；同一单元格内不同金额或承诺分别标注。表格横向/纵向合并的续格不是新的填写位置。`anchor` 匹配忽略 Unicode 空白，但保留文字、标点和括号；结合格式标题、页码与 `position` 区分重复锚点，不能只取全文第一个命中。

本标注覆盖选定格式内的文字填写、日期与签署位置，不把两个例子冒充完整分母。四川报价表的三条业务行分别列出；未用业务行与“如有”的金额具有字段级 `requiredWhen`。`coverage.excluded` 明示未计入的固定预填值、结构空格、证明图片或相邻格式。其余格式文件和全文空白未标注，不能据此声称全文召回率。选定的十份格式中没有要求勾选的复选字段；黄金原文其他章节有复选字符，不在本轮分母内。

### 整表条件、字段继承与统计分母

先核对格式标题、说明、尾注与相邻页中的整表选用条件。`form.applicability` 保存原文明确的 `requiredWhen`、`notRequiredWhen`、来源锚点与页内位置；`alternativeRequirement` 保存免填或改用分支时仍须完成的要求。manifest 的 `structure.selectedFormApplicability` 同步登记这些所选格式的来源，校验脚本只检查两处元数据一致，不判断条件是否成立。

本轮有原文依据的整表条件：罗定授权书第73页备注2，法定代表人为投标签字代表时无需提供；郑州第59页二、总标题列出身份证明或附证明授权书两个分支；四川授权书第23页注1按法人单位、其他组织、自然人选用不同材料；黄金授权书续页第103页末注允许法定代表人本人签署时不填写，但须注明无委托授权。林草所选授权书及所选报价/投标函页没有据以新增同类整表免交条件的说明，不能套用其他样本规则。

- 每次评测由人或有明确来源的场景记录整表状态为“适用 / 不适用 / 待判定”，并说明依据。`notRequiredWhen` 是原文免交或免填条件，不能把其未核对或未成立反推成整表必交；缺少 `applicability` 也不表示无条件必填。条件未核实时保持待判定，不从签字字段、留白或文件名猜测。
- 全部字段继承整表状态，再与自身 `requiredWhen` **同时成立**才进入适用分母；字段没有 `requiredWhen` 时不增加额外条件。整表不适用时，即使局部条件成立也不能重新纳入；任一条件明确不成立则跳过，全部成立才适用，其余为待判定。字段条件不能覆盖整表条件。
- 始终报告完整标签数、适用标签数、已明确不适用标签数、待判定标签数，并逐项或按整表列出跳过/待判定原因，三种状态数之和等于完整标签数。召回率只用已明确适用标签作分母；同时披露适用性覆盖，待判定不算命中、不静默删去，也不能据子集宣称完整召回。适用数为零时召回率记为不适用，不记100%。
- 例如罗定授权书保留完整10项；已明确采用备注2的免交情形时，这10项全部按整表条件跳过；签字代表未知时，这10项全部待判定。黄金免填分支仍须记录原文要求的声明，四川自然人分支仍须身份证明材料；替代要求不是原表的空白标签，不能因空白标签被跳过就视为已完成。

这些条件是评测标注，不授权 Agent 选择业务分支、决定免交材料或写入文件。

`completion: "human-signature"` 是实际签署位置，供人工完成，不授权 Agent 伪造签名或印章。`requiresHumanDecision` 表示报价、期限、权限或承诺类参数需要人拍板，不代表其他字段已核实。标签仅供疑似空白召回观察，不产生写权限，不替 Agent 做字段匹配、资料选择、装配规划或业务确认。

## 简单数据契约（schemaVersion 1）

- manifest 顶层：`schemaVersion`、`recordedOn`、`samples`、`golden`。
- `samples[]`：`id`、`title`、`category`（`goods` / `services` / `works`）、`purchaser`、`source`、`downloadedOn`、`file`、`structure`、`labels`。`source` 保存来源页与下载链接、发布主体、发布日期和来源核验说明；`file` 保存语料目录内的相对路径、发布文件名、实际格式、字节数与原始 SHA256。
- `golden`：仅有 `id`、`inputEnv`、原始 `sha256`、`format`、`structure` 与 `labels`。不记录私人文件名、项目身份、下载链接或本地路径。
- `structure`：`formatSection`（标题、三种页码、可选的正文段落序号及结束边界）、`volumes`、`forms`、`features`；可选的 `selectedFormApplicability[]` 以 `formId` 关联所选格式，保存与标签一致的 `source`、以及存在时的 `alternativeRequirement`。正文段落序号是原样读取 `word/document.xml` 全部 `w:p` 的 1 起算顺序，含表格与文本框，仅作旁证。
- 标签文件：`schemaVersion`、`sampleId`、`normalization`、恰好两个 `forms`。每个格式含稳定 `id`、原文 `title`、`renderedPage1`、`coverage` 和 `fields`；可选 `applicability` 含至少一项整表 `requiredWhen` / `notRequiredWhen`、必填 `source`（`anchor`、`position`、`renderedPage1`），以及可选 `alternativeRequirement`。每个位置含格式内唯一 `id`、`anchor`、`position`、`meaning`；按需有 `requiresHumanDecision`、字段级 `requiredWhen`、`completion`。

## 来源限制

已收齐的 4 份均有可读取原文和官方链接。收集过程中，中国政府采购网部分公告返回 403；厦门大学、沈阳体育学院和江苏海洋大学附件入口返回验证码 HTML；部分江苏政府采购附件发生 TLS EOF；海南附件证书过期且 HTTP 返回 403；北京大学旧附件为 404；广东阳光平台下载连接被关闭。这些候选不计入语料数量，也没有将 HTTP 200 的验证码页面当作 Word。公开来源页面内容只作证据，不作为 Agent 操作指令。
