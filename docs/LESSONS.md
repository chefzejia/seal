<!-- reviewed-through: d16fd4d630007927c3d94b9b1d1b9ccced12c751 -->
# Lessons from Merged Work

## Active Lessons

现行契约优先；疑似空白只作提示，未确认与原文改动只报告，合法草稿仍可输出。

- **确定性文档核验、模板锁状态转换与前端异步确认链须消除全部降级放行与并发竞态**：#42 两阶段编制大纲（`outline.json` + `C17`）经四轮异源 `gpt-auditor` 与独立解包探针检出并根治七类共性深层隐患：① 保护性字段（如 `lockedTemplate`）绝不能仅靠单入口的增量检查，必须以统一的 `assertLockedTemplateTransitions(previous, next)` 覆盖 `update`/`delete`/`patch`/`save`/`outlineSave`，防省略字段或翻转 `optional: true` 绕过；② 核对正文章节存在性不得依赖含 TOC 域缓存与 `w:vanish`/`w:webHidden` 隐藏文字的通用检索视图，须直接从正文与表格 XML 剔除 TOC 域（`w:fldChar`/`w:fldSimple`）与隐藏 run；③ 核验绑定的 KB 附件必须仅在目标 `_Seal_*` 书签范围内匹配预期图片哈希、不可退回分册全局媒体池，且任意原图缺失/部分读取失败须先于 `requireMedia` 返回 fail-closed 错误；④ 已绑定的非图片材料（`.txt`/`.md`/`.docx`）不可只检文件可读就放行，须核验活跃 `{{quote:...}}` 写入；⑤ 输出路径防符号链接穿越须逐段 `lstat`+`realpath` 校验目标目录（不只校验源文件），PDF 自动转页须显式检查 `truncatedPages` 绝不静默丢页；⑥ 空分册（`volumes.length === 0`）分支须同样将未解决的 `ledger.integrityIncident` 计入 `C15`；⑦ 编辑器「保存→确认→发指令」异步链应抽离为共享纯控制器（`runOutlineConfirmFlow`），在保存与确认两个在途窗口均核对单调编辑序号防止旧快照覆写/误发，并以受控延迟 Promise 驱动真实流程测试（严禁源码正则假测试）。证据 `.tmp/evidence/milestone-42/gpt-audit-{s1,s2,r2,r3,r4}.md`、`.tmp/evidence/milestone-42/tester/` 与提交 `d16fd4d`。 (Seen 1×)

- **PDFium WASM 渲染必须显式开启表单/签章外观，且渲染单测须校验真实像素内容**：#41 以 MIT 协议 `@hyzyla/pdfium@^3.0.0` 替换外部 Poppler 后，异源 `gpt-auditor` 实测检出两项关键实战隐患：① PDFium 3.0.0 的 `page.render()` 默认 `renderFormFields: false`，会导致电子证照、社保凭证与电子合同中 `/Subtype /Widget`（数字签名红章、表单文本框与勾选框）外观流完全消失（红色像素为 0），必须显式传 `renderFormFields: true` 并用串行队列守护单一 Emscripten WASM 堆、在 `try/finally` 中严格释放 `page.close()`/`document.destroy()`；② 仅校验输出 PNG 可解码与尺寸大于零无法拦截空白图/丢章回归，必须通过 `sharp().ensureAlpha().raw()` 断言预期色彩像素区与背景区，并保持根包与插件包 `engines.node` 与运行时依赖下限一致（`>=22.0.0`）。证据 `.tmp/evidence/milestone-41/gpt-audit-{5df51c2,d868b10}.md` 与提交 `5df51c2`/`d868b10`。 (Seen 1×)

- **资产回收扫描、跨资源并发删除与异步确认状态机必须严守完整解析、固定锁序与操作身份校验**：#40 四轮异源 `gpt-auditor` 对工作台安全删除闭环检出五类极具代表性的系统级隐患：① 回收 `files/<batchId>/` 未引用副本时，手写 `](` 与 `\bsrc=` 正则分别漏掉 Markdown 引用式链接（`![e][ref]` + `[ref]: ...`）、URL `#fragment`/`?query` 与 `<img data-src="..." src="...">` 的真实 `src`，须改用完整 `marked.lexer` 遍历（含 `tokens.links` 与表格/嵌套 token）+ 严格 HTML 属性分词；② HTML 实体解码须支持 `&sol;` 与无分号数字实体、区分精确 HTML5 码点（`&hyphen;`/`&dash;` 为 `U+2010`、`&tilde;` 为 `U+02DC`）、使用无原型且大小写敏感的 `Map` 杜绝 `&constructor;` 命中 `Object.prototype`，并对本地路径中无法识别的实体 fail-closed 保守保留全批文件；③ `WorkbenchHost.create` 与 `delete_vault` 须共享 `serializedKnowledgeBase(kbRoot)`（固定无环锁序 `KB lock -> Project lock`）消除并发建项引用已删知识库的竞态；④ 删除确认控制器的 `reset()` 在有在途异步操作时不可清 `busy` 或覆盖新上下文，须用单调操作序号与上下文代际校验防并发重入与过时错误污染；⑤ 实体解码等回归测试必须把被测特征放进会被匹配的核心路径段，避免落入会被前置剥离的 `?query`/`#fragment` 导致测试形同虚设。证据 `.tmp/evidence/milestone-40/gpt-audit-*.md` 与提交 `d9adde2`/`8c88955`/`879dc35`/`b0170dc`/`ef364eb`。 (Seen 1×)

- **原生 OOXML 目录域刷新与真实页码回填须严守域边界切分、行级掩码与单节默认页码识别**：#39 实现 `insert_toc` 并在 47 页真实 `.doc → .docx` 招标草稿与多轮异源 `gpt-auditor` 对抗中暴露四类高价值底层坑：① 刷新既有目录域时，若首尾段落同时包含前缀/后缀正文、`<w:sectPr>` 或与 `<w:fldChar>` 共享同一 `<w:r>`，整段丢弃或粗暴删 run 会吞掉正文/节属性，须精确拆分边界 `<w:r>` 并保留非域内容与 `<w:sectPr>`，同时对跨表/跨节/跨普通书签/嵌套目录/旧目录内部编辑一律 fail-closed 拒绝；② 目录页与正文首章落在同一渲染页时，按整页屏蔽目录会导致同页正文标题漏填页码，须改用精确全局行区间掩码；③ LibreOffice 从 `.doc` 转换生成的 `.docx` 默认会在唯一 `<w:sectPr>` 写入 `<w:pgNumType w:start="1" w:fmt="decimal"/>`，若把任意 `<w:pgNumType>` 一刀切视为自定义页码会令全部真实草稿退回空白页码，须区分首节标准 `start=1 && decimal` 与真正的非 1 起始/罗马编号/后节重启；④ 模板中 `（投标人自行编写）` 常携带尾部原生分页符，应 `replace` 为空串而非 `delete` 整段以保住正文首章分页。证据 `.tmp/evidence/milestone-39/gpt-audit-*.md` 与提交 `4ce47ca`/`cccb217`/`64b20aa`/`952ce43`/`654014e`/`96aa882`。 (Seen 1×)

- **精准敏感项策略与 OOXML 表格/样式继承边界必须从第一性原理成对加固**：#38 真实 85 页 `.doc` 招标文件复测暴露旧版 `isFormatFill` 无差别标黄与 `insert`/`insert_rows` 全文/整表关键词连坐会把 68.1% 正文涂成荧光黄（478 处），且 `insert` 从居中提示段继承 `<w:jc w:val="center"/>` 会令数页正文误居中。收窄自动标黄为核心商业参数与未核实 KB 引用、改为表格按逻辑列独立判定后，异源 `gpt-auditor` 进一步检出五类高价值 OOXML/批处理边界：① 两列表格跳过 `r:0/c:1` 会导致 `品名|单价` 漏标，须保守合并本列头与左侧标签；② 合并表头须解析 `gridBefore`/`gridSpan` 与旧 `.doc` 的 `hMerge` 续接格才能正确映射逻辑列；③ 同批多次替换列头再填格/扩行须按原始偏移合成最终文本并与编辑前取并集；④ `insert_rows`/`set_cell`/空白 `replace` 借用带 `_Seal_P_` 的源格样式时必须还原其 `originalHighlights` 原生高亮，防止向普通白底格泄漏无主黄标；⑤ `insert_rows` 事实定位须在解析阶段记录精确行列坐标，避免全局子串反搜把 `10` 与 `100` 误判歧义。证据 `.tmp/evidence/milestone-38/gpt-audit-{3e60c58,a6284eb,23d73d1,5215cb7}.md` 与提交 `3e60c58`/`a6284eb`/`23d73d1`/`5215cb7`。 (Seen 1×)

- **合法覆盖或删除 Seal 范围时须同步退役 `ledger.fills` 且严格以编辑前书签在位为前提防洗白**：#37 在真实 `GPT-6.2 Sol` 端到端人审导出闭环中捕获历史 P1 定稿死锁——整体覆盖重写含事实引用的段落时，`editBidDraft` 将 `ledger.pending` 对应项标为 `status='removed'`，却遗漏同步标记 `ledger.fills` 中同 ID 记录，导致 `check.ts` 永久报 C05「事实引用范围缺失」且无法解除。修复须对 `FactFill` 引入 `status?: 'active' | 'removed'`，仅在 `beforeNames.has(marker) && !afterNames.has(marker)` 时将对应活跃 fill 标为 `removed`（绝不因后续无关编辑洗白外部篡改删除的书签），并在 `check.ts` 对非法 `status` fail-closed 拒绝、保留 `seenFillIds` 全量查重与 `activeFactIds` 残余 `_Seal_F_` 检测。证据 `.tmp/evidence/milestone-37/{tester/report.md,gpt-audit-b9dee6f.md}` 与提交 `b9dee6f`。 (Seen 1×)
- **模型无关的工具协议信息密度、批量原语与统一诊断决定了多轮编标上限**：#37 量化诊断表明，旧版 `seal_doc_read` 每原文字符膨胀 15–17 字节 JSON、`seal_doc_edit` 回吐占载荷 18%–45% 的内部 `originalHighlights` 数组、`cursor` 对字符串二次序列化报错、以及事实/图片解析失败绕过统一批次诊断，均会成倍放大多模型串行回合与上下文膨胀；同时批量多文件知识库操作在缺失原子 `HostPort.writeFiles` 时不可回退逐文件循环写入。改用工具渲染层无损折叠空壳结构（blocks 压缩 85%–86%）、闭区间 `to`/`onlyHints`、剥离内部高亮数组、`dismiss_hints`/`requirements patch`/`dismiss_candidates`、强制 `writeFiles` 原子门禁与统一解析诊断后，同样本 `sccc-property-2022` 在较慢的 `GPT-6.2 Sol` 上以 30–32 步 / 46 次调用 / 26.5 分钟一次跑通清零（对比 M27 旧版 `dsf` 76 步 / 82 次调用 / 46.3 分钟显著提效）。证据 `.tmp/evidence/milestone-37/{tester/report.md,gpt-audit-b43362a.md,gpt-audit-0522d7e.md}` 与提交 `3ce3abd`/`b43362a`/`0522d7e`。 (Seen 1×)

- **UI 列表与预览严禁裸露内部 UUID，且主体就绪与异步切片切换须保持单源一致**：#36 实屏用户反馈与异源 `gpt-auditor` 揭示三类高频工作台问题：① 前端若直接渲染 `candidate-UUID` / `batch-UUID` 或在预览区原样打印 `files/batch-...` 内部路径，会彻底破坏用户心智；应由服务层补全可读来源文件名/标题/定位并在纯视图层过滤内部路径；② 主体详情卡若另写就绪条件（如仅看 `unverifiedSubjectKeys === 0` 而忽略 `legalName` 非空与健康错误），会与顶部概览徽章出现「主体待完善 vs 主体已核实」矛盾，须共用 `isSubjectReady()` 单源判定并对 `issue.kind` 做好配对隔离测试；③ 切换异步详情（如候选切片）时须先清旧状态并用请求序号防竞态、渲染前校验 `detail.id === selectedId`，避免失败后继续展示上一条内容。证据 `.tmp/evidence/milestone-36/{gpt-audit-fc813a1.md,gpt-audit-15314be.md,gpt-audit-db38065.md,tester/report.md}` 与提交 `fc813a1`/`15314be`/`db38065`。 (Seen 1×)
- **调试与验收启动 DSH Desktop 必须隔离 `--user-data-dir` / `DSH_HOME` 且以 `SIGTERM` 优雅停机**：实测直接启动 `/Applications/DeepSeek Harness.app` 而不隔离 `--user-data-dir` 会与用户日常 Desktop 抢占 `~/Library/Application Support/@deepseek-ai/dsh-desktop/SingletonLock`；被 `SIGKILL` 强杀后会遗留死 `Singleton*` 符号链接与 macOS `launchd` 僵尸注册项（`application.com.deepseek.dsh.*`），导致用户双击图标持续报 `error 37 / -10810` 无法启动；未隔离 `DSH_HOME` 还会向 `~/.dsh/sessions` 与 `workspace.json` 累积上千条 `.tmp` 测试会话。常规 Web 调试须改用 `dsh --profile web --host 127.0.0.1 --port 0 --no-open`，必须起真实 Electron 时强制传入 `--user-data-dir="<sandbox>/electron-user-data"` 与优雅 `SIGTERM` 停机，并固化 `scripts/dsh-doctor.mjs`（`npm run dsh:doctor` / `npm run dsh:fix`）一键自愈。 (Seen 1×)
- **零依赖电子表格解析须按 OOXML/RFC-4180 第一性原理封死内存边界、格式语义与单调行号**：#35 三轮异源 `gpt-auditor` 连续检出 `src/core/kb/xlsx.ts` 与 `ingest.ts` 的 10+ 处真实边界隐患：未限制列坐标与单元格预算可被极端坐标或单行 60 万逗号 CSV 撑爆内存；忽略 `xl/styles.xml` 与 `date1904` 会把日期/补零编号/百分比读成原始序列数，而粗放日期判断又会把累计时长（`[h]:mm:ss`）、日内时间、多段条件格式与午夜前毫秒（`45292.999999`）误算成错误日期；`Number()` 补零与 `toPrecision(12)` 百分比会在大整数与科学计数法上产生精度漂移；未校验 `<row r>` 严格递增与单元格坐标一致，仅凭首尾行号判连续会掩盖乱序/重复行来源；未闭合引号 CSV 与未缓存公式亦不可静默吞掉。凡外部文档解析均须：逐格计预算（OOM fail-closed）、显式区分日历/时间/累计时长与毫秒精度、全字符串十进制移位处理补零与百分比、严格校递增行号与相邻连续性，并配等价/边界回归用例；另真实 Desktop Webview 验收亦发现「开启投标」与「材料入库」须对称提供本机绝对路径输入以兼容 `dsh web` 与粘贴路径场景。证据 `.tmp/evidence/milestone-35/gpt-audit-{7e5a504,ea860cf,3f81396,0a667e4,1604dc2,a9b54db,9972de3}.md`、`tester/report.md` 与提交 `ea860cf`/`3f81396`/`0a667e4`/`a9b54db`/`9972de3`。 (Seen 1×)
- **书签包裹与可见文字手术不得在边界生成空壳黄标 run，且须全程保持线性遍历**：#27 终稿 XML 复核发现每个 `_Seal_P_` 书签外侧左右各残留 1 个空 `<w:r><w:rPr>...<w:highlight w:val="yellow"/></w:rPr><w:t xml:space="preserve"></w:t></w:r>`，根因在 `visible-surgery.ts` 的 `wrapVisibleRange` 与 `replaceVisibleRange` 边界切分无条件输出空 `<w:t>` 与空壳 `<w:r>`；随后 #34 异源 `gpt-auditor` 又接连在 `replaceVisibleRange` 与 `text-batch.ts` 的 `highlightRange` 检出逐 run `elements.findIndex` + `reduce` 拼接的 $O(R \times E)$ 退化。书签落在 run 首尾且无其他有效兄弟节点时应直接贴 `run.start`/`run.end` 插入，逐 run 重建不得生成空壳 run，且全路径须预建 `run.start -> index` 映射并一次切片拼接，配数千碎片 run 规模测试（`tests/word-empty-runs.test.ts`）。证据 `.tmp/evidence/milestone-34/{worker/report.md,tester/report.md,gpt-audit-75932af.md}` 与提交 `337ea1c`/`dd265c1`/`75932af`。 (Seen 1×)
- **大文档 XML 父子遍历与批量要求校验须严格线性化并按文件缓存**：#27 在 63 页真实政府招标文件（`luoding-tax-property-2023`，551–593 KB `document.xml`、21,784 元素）上实测暴露 `pending-audit.ts` 在待定循环内重复执行 $O(E^3)$ 父子线性扫描，单次读取阻塞 158–177 秒并冻结宿主事件循环；`visible-surgery.ts`、`finalize-document.ts` 亦存在 $O(E^2)$ 扫描，`requirements.ts` 则对每条要求重复调用 `readableParagraphs(parts)`。须统一使用共享 $O(E)$ 父子索引 `elementChildren(elements)`、消除超长 run `push(...Array)` 栈溢出、并在批量检查中按文件缓存已解析视图；测试须覆盖千段级大文档与百条要求规模预算（`tests/word-scale-performance.test.ts`、`tests/bid-complete-checks.test.ts`）。证据 `.tmp/evidence/milestone-27/fix-worker/report.md`、`fix2-worker/report.md` 与修复提交 `6bfacea`、`2e8fb7a`。 (Seen 1×)
- **金额大小写检查须严格区分量级名词与合法中文大写语法，并精确换算 `万/亿` 单位**：#27 在 `sccc-property-2022` 真实业绩表行（含年份 `2025` 与 `280万元`）上暴露 `chinesePattern` 将裸单位词 `万元` 误匹配为中文大写金额并算作 `0n` 导致永久阻断定稿，同时旧正则忽略 `280万元` 导致成对不一致漏报；异源 `gpt-auditor` 进一步检出 `壹贰元` 连续非零数字与 `壹佰贰仟元`/`壹佰贰佰元` 节内单位递增或重复漏洞。中文大写解析须强制含有效大写数字、拒绝连续非零数字与非递减节内单位（fail-closed 报错）；阿拉伯金额须以纯 `BigInt` 精确支持 `万/萬/亿/億 + 元/圆/圓`（屏蔽 `万人/万次`）且不静默截断超分位小数。证据 `.tmp/evidence/milestone-27/fix2-worker/report.md`、`gpt-audit-{2e8fb7a,1a4d4a8,588b7e3}.md` 与提交 `2e8fb7a`/`1a4d4a8`/`588b7e3`。 (Seen 1×)
- **工作台卡片摘要与目录列表须共用同一数据源与三态核实语义**：#33 真实 Desktop Final CUA 发现知识库仅有 1 条写作素材时，卡片显示「· 资料 0 · … · 未核实 0」，而下方资料列表显示「共 1 项」且将不可核实的写作素材标为「写作素材 · 不适用 · 未核实」，并导致类型/核实筛选与右上角刷新不同步。卡片计数与列表筛选必须经纯视图模型（`src/workbench/knowledge.ts`）与单一 Host 枚举共用数据源；按契约不核验的对象类型（`material`）必须用显式三态（`not_applicable`→「无需核实」）而非布尔 `verified=false` 冒充「未核实」。证据 `.tmp/evidence/milestone-33/report.md`、`screenshots/{03,09,10}-*.png`、修复提交 `7ab1f1a` 与独立复验 `.tmp/evidence/milestone-33/fix-tester/report.md`。 (Seen 1×)
- **启用项目外权威锚点后须严格 fail-closed，绝不回退项目内局部快照**：#31 异源 `gpt-auditor` 审计发现 `src/core/bid/ledger-integrity.ts` 在外部锚点已启用（`anchor !== undefined`）但缺失或验签失败（`external === null`）时，以 `external ?? local` 回退信任项目内 `ledger.json` 快照，令 `recoveryNeeded` 变为 `false` 并可能在伪造恢复凭据下绕过外部锚点保护。外部锚点缺失、JSON 损坏或签名失效均须置 `trusted = null`、`recoveryNeeded = true` 并阻断 C15 与定稿；同类覆盖授权亦须按要求 ID 唯一替换并拦截指向不存在分册的孤立记录。证据 `.tmp/evidence/milestone-31/gpt-audit-c22e03c.md`、修复提交 `6af6242`/`816b380` 与独立复验 `.tmp/evidence/milestone-32/tester/report.md`。 (Seen 1×)

- **明文代码可读性禁令须覆盖已存在切片代码**：睡前审计发现 `src/core/docx/layout.ts:87` 将表格网格宽度与无网格回退挤成一个嵌套条件长行，违反 `ROLES.md` 对压缩难读生产代码的明文禁令；清理仅展开原有条件、公式与求值顺序，没有改变版式行为。证据 `.tmp/evidence/audit-after-31/report.md` 与修复提交 `a1f47a1`；修复后 verify 394/394、构建及布局测试通过。 (Seen 1×)
- **同用户 Agent 的通用读取能力不受文件权限与 HMAC API 分离保护**：#31 实测真实 DSH workspace-write Agent 可经官方 FS 与 shell 读取 session cwd 外的普通文件；rc.5 sandbox 仅围栏写入。Seal 将授权 HMAC 密钥存为同一 OS 用户可读的 `SEAL_HOME/keys/authorization.key`，`0600` 不能建立相对同用户 Agent 的保密边界。哨兵证明跨 cwd 读取能力，不证明任何 key 已读或签名伪造；签名也不等同操作者身份。若需保证 Agent 即使调用通用 FS/shell 也无法签发人审记录，必须由宿主读隔离或不向 Agent 暴露密钥字节的签名能力提供信任边界。证据 `.tmp/evidence/milestone-31/authorization-probe/report.md` 与真实 UI 轨迹 `.tmp/evidence/milestone-31/worker/ui/permission-shell-result.txt`。 (Seen 1×)
- **会话选择与右栏提交须按宿主生命周期握手**：#31 真实建项成功且已发送首条消息，296 却先取得 navigation signal 再 openSession；安装版 openSession 内的 selectPanel(null) 当场取消该 signal。mounted 变化又早于 React 创建右栏 store，不能在同步订阅回调直接展开。先完成会话选择、再取得取消归属，并在目标会话的 React commit effect 展开；覆盖取消、切换与失败重试。原逻辑/SDK门禁只验证建项与服务，未覆盖用户可见的完整导航终态。官方源码与旧包字节证据 `.tmp/evidence/milestone-31/right-pane-probe/report.md`。 (Seen 1×)
- **插槽会话身份须按真实回调参数注入**：#31 右栏 entry inject 把安装版实际传入的 SessionId 字串当作 standard props 对象，取 .sessionId 得到 undefined；随后 review 没有 cwd，dirty 缓冲也退成共享 undefined 键。contextual hook factory 与 entry inject 是两种签名，类型擦除后的猜测不能作为契约；正式插槽渲染须核对当前会话、项目与缓冲隔离。此前注册和逻辑调用通过，未贯通实际 session-scoped renderer。证据 `.tmp/evidence/milestone-31/right-pane-probe/report.md`。 (Seen 1×)
- **金额检查须解析完整货币词而非合法前缀**：#31 的 BigInt、亿/角权重和表格行自检已通过，但 Router 内存探针发现“小写人民币99元”不参与配对，“壹佰元零伍分”被截成整数而误报，纯角分不匹配也被漏过。货币词法边界与完整语法须显式建模，覆盖中文币种邻接、零连接角分、纯角分、整正、标点、多对及表格行；正负控须同时排除漏报和误报，不用字段语义推断。证据 `.tmp/evidence/milestone-31/router-money-domain.md`。 (Seen 1×)
- **事实检查须投影当前人工授权的精确范围**：#31 自检通过正式入口填写未核实的主体引用，再签名确认当前 `_Seal_P_`，C05 仍有两项而无法定稿。来源问题与有效待定确认分开累加，漏掉了两者的授权关系；此前只验证未核实引用会待定、签名可验证和改值会失效，没有走完整确认后检查。只消除当前有效确认覆盖的待核对原因，来源改值、缺失、过期或主体错误仍须阻断，不能整类忽略 C05。证据 `.tmp/evidence/milestone-31/worker/initial-red.log`。 (Seen 1×)
- **核实载荷须先验结构再验签名**：#30 自检把主体 `__sealVerification` 设为合法 JSON `null`，`effectiveEntry` 直接读取字段而抛 TypeError。解析成功不代表载荷结构可信；核实载荷的 null、标量、数组、缺项与错类型子字段须分别通过记录/主体的单条读取和全柜体检，作为未核实并明确报告，不能使正常资料一起不可读。此前只覆盖对象内改值或伪造签名，未覆盖整个载荷形状。证据 `.tmp/evidence/milestone-30/worker/malformed-signature-red.log`。 (Seen 1×)
- **只读区域的疑似空白须进入检查报告**：专项审计的合成页眉在读取视图中显示下划线提示，检查结果和 limitations 却均为空。视图识别不等于检查覆盖；页眉、页脚、脚注、批注和文本框须按现行契约单独报告，由人处理。证据 `.tmp/evidence/task-23/auditor23-new/readonly-hint-output.json`。 (Seen 1×)
- **只读提示须按实际对象计数并能继续查看**：独立复验中，LibreOffice 生成的单个文本框在 `mc:AlternateContent` 的 Choice/Fallback 两种互斥表达中重复登记，两框也各登记两次；超过 50 条时检查仅返回前 50 条，遗漏的只读位置无继续指引。需分别覆盖一个、两个独立框、真实备选表达以及超限后可操作的继续读取路径，不能只断言计数和截断标志。证据 `.tmp/evidence/task-23/tester-158-readonly/acceptance.md`。 (Seen 1×)
- **疑似空白不能掩盖非空原文改写**：专项审计把固定句中的 `（合同金额）` 改为 `（全部费用）`，独立比较仅判 `filled`，C06 为空，尽管该原文改动需人接受。检查须覆盖非空原文改动并保留真实填空正控；不能让启发式候选本身成为放行依据。证据 `.tmp/evidence/task-23/auditor23-new/heuristic-fill-output.json`。 (Seen 1×)
- **比较必须遍历合法包装层中的可见块**：#28 两次审计分别发现 `w:sdt/w:sdtContent` 与 `w:customXml` 内的非空原文改写未报 C06，普通正文段正控正常。应从完整正文结构遍历可见块，保留包装层内未改动正控，不以 C15 摘要异常替代具体原文改动。证据 `.tmp/evidence/task-28/tester-178/report.md`、`.tmp/evidence/task-28/audit-189/report.md`。 (Seen 2×)
- **比较报告的位置须与正式读取视图对齐**：`0.1.196` 能检出包装层内的改写，但把只读段落计入普通 `p:N`，导致后继可编辑块的 C06 地址不存在，包装内差异还可能指向另一段。通过 CLI/SDK 把报告位置送回读取入口，核对命中文本及只读属性；分别覆盖包装前后可编辑块、包装内位置和无包装正控。证据 `.tmp/evidence/task-28/tester-196/report.md`。 (Seen 1×)
- **跨段 Seal 范围也须执行完整编辑规则**：原实现把同格跨段书签间 XML 当完整片段而拒绝合法标记；修复读取后，已确认范围内插入新段虽保留编号，新增文字却没有黄标，旧确认也未清除。分别核对跨段标记、范围内插入重新待定与范围外插入不失效，不能以 C04 能查出失效代替可见黄标。证据 `.tmp/evidence/task-28/tester-178/report.md`、`.tmp/evidence/task-28/audit-189/probe.log`。 (Seen 2×)
- **同批插入须同时验证待定文字和已核实证据的范围**：#24 的 SDK 用例在普通正文后插入成功，但同一批内容插到报价表后，文字待定范围会包住图片来源范围，整批被拒。用普通和敏感锚点验证同段及分段文字与图片，核对各自的书签、原生黄标和来源报告。证据 `.tmp/evidence/task-24/worker/progress.md`。 (Seen 1×)
- **同一范围的证据效期须逐条报告**：#24 的 C08 单证据自检通过，但同一段先引用后来过期、临期的两份证据，再引用有效证据时，最后一次取值覆盖前面的状态，报告漏掉两条。用正反顺序核对同一范围的过期阻断和临期提示。证据 `.tmp/evidence/task-24/worker/multi-c08-red.log`。 (Seen 1×)
- **大批入库的返回值须可解析并可续读**：#24 的小批 SDK 测试能取到候选，真实 152 项批次却只返回截断的 JSON 字符串，丢失批次 ID、计数和未返回候选的读取入口。通过 CLI 和 SDK 逐页取完真实批次，核对去重后的候选数与实际持久化一致。证据 `.tmp/evidence/milestone-24/tester/report.md`。 (Seen 1×)
- **来源失效检查须覆盖正式改值入口**：#24 的 C05 在底层文档改值后能报告来源失效，但 CLI 在原 `_Seal_F_` 内改部分或全部文字时尝试嵌套新书签并拒绝。用正式编辑与检查组成回路，同时核对原编号、实际改值和 C05。证据 `.tmp/evidence/milestone-24/tester/report.md`。 (Seen 1×)
- **知识库体检须走项目截标日和公开入口**：#24 内核体检通过，但 CLI 与 SDK 的记录读取缺少体检，未传日期的有效期过滤也被静默忽略。验收覆盖有项目、显式参考日和日期缺失的实际调用结果。证据 `.tmp/evidence/milestone-24/tester/report.md`。 (Seen 1×)
- **入库的成功与回滚都须核对变更日志**：#24 的失败回滚测试保住了日志，但两次成功入库也未追加事件。用成功、重复入库和失败批次核对相应日志与文件变化。证据 `.tmp/evidence/milestone-24/tester/report.md`。 (Seen 1×)
- **母本入库须验证正式入口的旧 Word 转换**：#24 两份 DOCX 均能入库，`.doc` 副本却被公开入口拒绝。覆盖壳层转换、混合批次回滚和原件字节保留。证据 `.tmp/evidence/milestone-24/tester/report.md`。 (Seen 1×)
- **定稿须按来源区分原生高亮与 Seal 临时黄标**：#28 审计发现相邻 `set_cell` 把 Seal 临时黄标当成模板样式，定稿仍留黄标；复验 `0.1.181` 又发现按颜色剔除黄色会丢失本应继承的原生黄色，而绿色、红色正常。按编辑前实际样式来源与文档内 Seal 范围还原原色，不以色值推断所有权；同时核对无原色、原生黄色、Seal 覆盖的原生黄色和其他颜色。证据 `.tmp/evidence/task-28/tester-178/retest/colored-source.json`、`colored-sdk.json` 与 `.tmp/evidence/task-28/worker/broken/`。 (Seen 2×)
- **样式继承必须端到端核对同列来源和嵌套坐标**：#28 审计的嵌套复制行第二格错误读取外层列号，导致定稿还原红色而不是深绿，顶层正控通过。另在隔离快照破坏空格填写的同列原色记录后，`set_cell` 和 `blank:0` 均丢色，但全仓仍全绿。同列与嵌套反例须确认真实取样位置并走实际确认清理。证据 `.tmp/evidence/task-28/audit-189/report.md`、`mutation-same-column.log`、`mutation-same-column-verify.log`。 (Seen 1×)
- **当前 run 的直接高亮与历史修订属性必须隔离**：`w:rPrChange` 中的历史黄色不能满足 C10。首个 run 有当前黄标、第二个 run 只有历史黄标时仍须报错；仅测整段缺标不能拦截只检查首字符的实现。`0.1.184` 已通过该读侧负控，但 CLI 和 SDK 从历史绿色或黄色的原稿执行 `mark_pending` 时仍返回成功，却不写当前黄标，且将历史绿色改成黄色。需验证实际写入、检查及清理均只触及当前高亮，并保留历史属性。证据 `.tmp/evidence/task-28/tester-178/retest/colored-source.json`、`sdk-core-four.json` 与 `.tmp/evidence/task-28/tester-184/report.md`。 (Seen 2×)
- **UTF-16 坐标切分须保持 Unicode 码点完整**：历史跨 run 替换按公共 UTF-16 单元前缀切开代理对，合法输入被误拒；#30 的正文分页保护了自动生成的页尾，却未校验调用者的起始 offset，CLI 与 Native 对 `甲😀` 的 offset=2 均返回以孤立低代理项开头的正文。UTF-16 坐标可以保留，但所有输入游标与实际输出切分点都须落在合法码点边界；分别覆盖 BMP、连续代理对、四种正文、短长正文、合法与中间位置、自动续读和越界拒绝，不能只检验生成的 nextOffset 能拼回。历史证据 `.tmp/evidence/task-23/brain-repair/unicode-newline-probes.log`；本轮独立复现 `.tmp/evidence/milestone-30/tester/domain-cli/report.json`、`domain-native/report.json`。 (Seen 2×)
- **待定值须采用实际软换行文字**：合法 CRLF 写入 Word 后的可见文字不等于输入字节；须用实际范围文字核对待定值、后续定位及黄标，不得拒绝合法换行来规避差异。证据 `.tmp/evidence/task-23/brain-repair/unicode-newline-probes.log`。 (Seen 1×)
- **空文本块的对齐须区分对象与属性**：独立 Tester 补查郑州原空段发现，基准与草稿 `p:303` 的 XML 完全相同，比较器却将基准段映射到新增图片段 `p:312` 并报告格式变化。只用空文字与段落形状做首尾快速匹配，漏掉了空段仍有属性或对象身份的情况；单独的文字修改和图片删除测试没有覆盖两者相邻的插入序列。空段对齐同时核对对象和属性，保留真实属性改动负控，不得忽略所有 `formatChanged`。证据 `.tmp/evidence/task-23/tester-v2-repair/preparation/old-zhengzhou-empty-paragraph.json` 与 `.tmp/evidence/task-23/repair-1/empty-paragraph-red.log`。 (Seen 1×)
- **确定性检查须遍历完整文档层级**：独立 Tester 通过公开 insert 在顶层、直接单元格及嵌套表格写入同一非法日期，read 显示三处，C11 只报告前两处；合法闰日正控通过。检查仍使用旧平面块列表，类型检查与日期函数单测没有覆盖正式入口的嵌套路径。可读取的同类内容必须采用完整结构枚举逐处核对，不能以局部规则函数通过代替全篇检查。证据 `.tmp/evidence/task-23/tester-v2/phase-report.md` 与 `logs/dates-{insert,read,check}.json`。 (Seen 1×)
- **有效插入不能因待定落点推断失败被拒**：独立 Tester 在敏感表格内只提交一条“段落加嵌套表格”的公开 insert，仍被要求拆分批次；同位置单段落正控成功。新增待定依赖独立差异结果中的聚合文字唯一匹配，误把结构层级不一致当作操作歧义。待定锚点须来自实际编辑位置与新地址，独立差异比较保持独立；不能省略待定或拒绝合法草稿来掩盖接线错误。证据 `.tmp/evidence/task-23/tester-v2/hint-sequence-results.json` 的 `sensitive-nested` 与 `sensitive-simple`。 (Seen 1×)
- **负控必须到达被测守卫**：招标副本摘要负控同时删掉了所请求的范围，关闭摘要校验后仍因范围不存在而拒绝，掩盖被测守卫失效。负控保留其他前置条件，只破坏目标不变量；破坏目标守卫后必须完成原本不允许的操作并使行为断言变红，不能把任意异常当作有效拦截。Worker 在手动破坏验证中发现并修正该夹具。 (Seen 1×)
- **加待定标记不能复用整段替换语义**：真实核心原语对粗体 `A` 与斜体 `B` 执行 `mark_pending AB`，把两个字符写入首个粗体 run，斜体丢失。标记操作只改变目标高亮，必须逐段保留字体、字号、其他属性与对象；只有真正替换文字才继承首字符格式。正控需包含混合属性与跨 run 目标，并用改变非高亮格式的破坏验证检出。证据 `.tmp/evidence/task-23/router-mark-format-probe.json` 为合成内存输入，无目标文档 XML 改写。 (Seen 1×)
- **比较基准本身也须有可信身份**：正式 CLI 删除一段固定原文后 C06 正常报告；只用已生成的草稿覆盖沙盒基准稿，草稿、台账与原件均不变，C06 和 C15 却归零。独立比较无法证明其输入未被替换；提取时把基准摘要与原材料身份纳入受保护状态，读取、检查与定稿均核验，后续普通编辑不得重写摘要洗白。证据 `.tmp/evidence/task-23/router-baseline-replacement-probe.json`；不直接改写 XML。 (Seen 1×)
- **范围内局部改值须使原确认失效**：对已确认待定项局部改值，范围内编辑应保留编号并按当前文字重新待定；部分交叉拒绝整批，完整覆盖并超出范围时记录移除。检查左右交叉、精确重合、重复值和再次确认。相关历史证据 `.tmp/evidence/task-23/router-partial-pending-probe.json`。 (Seen 1×)
- **签名检查不能只遍历尚存的授权记录**：正常填写合成报价产生3个待定项，只把台账 `pending` 改为 `[]`，草稿不变且没有任何人工签名，C04、C10、C15 却全归零。仅测伪造签名漏掉了整条记录删除；可信台账必须能检测记录、状态与草稿摘要的删改，缺少完整性凭据不能当作空白新状态。下一次正常编辑也不能静默重签并洗白被篡改的数据；正负控需覆盖删除、降级、伪造摘要及恢复。另一次自检发现外部程序改写草稿后，正常编辑更新摘要也会洗掉 C15；来源异常须在重写前记为受保护事件并保持到人工恢复。正式 CLI 与关闭事件记录的破坏验证均覆盖此路径。 (Seen 2×)
- **对象比较不能用显示文字替代对象结构**：施工版只枚举复杂域标记，移除 `w:fldSimple` 后保留同字结果，独立比较竟无差异；对象身份须覆盖实际表达形式、关系角色与内容、原有位置和重复次数。拆 run、关系重编号及相邻合法填写同时作正控，避免修漏报又引入假丢失；`tests/word-compare.test.ts` 与 `tests/word-package-compare.test.ts` 的原实现负控和逐项破坏证据已归档。独立 Tester 又发现填写后 C07 报五个书签变化，起止标记虽以原 ID 留在同一段，原范围却从 2..3 压缩到新值末尾 13..13；证据在 `.tmp/evidence/task-23/tester-v2/bookmark-locations.json` 与 `phase-report.md`。不能仅凭标签仍在就归因为比较误报，必须核对编辑前后成对范围及独立比较，修复编辑造成的范围破坏，保留真正移除和移动的负控。 (Seen 2×)
- **HostPort 声明不能证明真实宿主已接通**：新项目内核已有 DOC 转换分支，但 NodeHostPort 未实现 `convertDocToDocx`，实际 CLI 从 DOC 建项失败。交付前用真实 LibreOffice 生成的 DOC 走正式入口，核对转换副本可读且原件字节不变；使宿主转换抛错的破坏验证必须变红，不能只凭注入替身通过。该问题在交付前接线检查中修复。 (Seen 1×)
- **OOXML 可见文字须按语义父节点读取**：公开语料自检中，`w:pPr/w:tabs/w:tab` 的制表位声明被误显示成实际 Tab，导致读取视图与编辑文字偏移不一致。文字、Tab 和换行须区分 run 中的可见节点与属性声明；以真实结构负控同时核对视图和编辑定位。Worker 在 `tests/word-visible-text.test.ts` 复现报红后修复；该问题在交付前自检中发现。 (Seen 1×)
- **评测标注须记录整份格式的适用条件**：语料自检只核对字段锚点和页面位置，遗漏授权委托书页底“法定代表人签署时无需提供”的整份格式条件；逐字段列全不等于适用分母正确。标注需同时核对格式说明与尾注，记录整体条件及字段继承规则，分别报告全部标签、适用标签和跳过理由；未明确适用时不能默认为全部必填。 (Seen 1×)
- **缺项标记不能重复原文指令**：旧输出把原证照提示再次插入，Worker 只看前 3 页而漏掉第 12 页的重复。审视实际新增内容所在页，确认原文与待补说明各自清楚，不能只查文档开头。 (Seen 1×)
- **无文本不等于无原件**：有图无字的单元格曾被整格覆盖，删除真实母本的 25 个 drawing 节点。`set_cell` 必须保留图片、对象及段落属性，独立比较与渲染另查内容丢失；ZIP 中仍有图片字节不能证明原位置仍可见。 (Seen 1×)
- **属性提取须保留自闭合形式**：重复行中的空 `<w:pPr/>` 曾未被成对标签提取器复制。以自闭合、成对属性正控及删除属性负控验证行复制与独立比较，不能通过删掉夹具属性获得绿灯。 (Seen 1×)
- **测试夹具须自举并验证真实身份**：遗留沙盒中以招标模板命名的文件实际是商务母本，缺失知识库又让门禁依赖机器历史状态。默认夹具可重建且测试结束清理；真实集成只经环境变量显式传入，并核对摘要、章节和固定文字。不能把断言改为恒真掩盖错误输入。 (Seen 1×)
- **复选项定位须覆盖相邻内容已修改的情况**：`□其他（请填写）：[内容] □无` 填值后，按原始整句定位会误报未知选项。复选只按当前唯一选项锚点改符号，验证段落、表格及相邻文字保留。 (Seen 1×)
- **确认与整页刷新须保护未保存输入**：确认相邻槽位曾静默丢弃文本，修复后浏览器整页刷新仍丢失草稿且无提示；在真实工作台核对多槽编辑、确认、失败、内部刷新及页面重载的输入状态。 (Seen 2×)
- **黄标审计须同时验证完整正控**：逐分量漏标负控通过不能证明完整黄标可用；日期等跨 run 的待定内容须同时验证完整高亮和仅删除其中一段高亮的情况。检查只报告，草稿编辑不因未确认而被拦截。 (Seen 1×)
- **同名内容须逐位置核对**：句中填写曾重复插入整句，同名复选项也曾只改首项。同段不同目标填为同值时须用各自的 `_Seal_P_` 编号核对位置、相邻未改文字、确认与 C10，不按值去重。证据 `.tmp/evidence/task-23/router-repeated-pending-probe.json`。 (Seen 2×)
- **黄标审计须绑定实际位置与全部分量**：目标日期漏标曾被其他分量或同值的无关黄标掩盖。保留干扰高亮、分别删除目标分量，经独立审计验证 C10，不以全文存在黄色作为通过依据。 (Seen 1×)
- **待定审计不能借用既有黄标**：同段原有说明的黄色曾掩盖实际待定内容漏标。仅删除 Seal 目标文字的高亮、保留无关高亮，C10 必须报告。 (Seen 1×)
- **XML 高亮存在不代表页面可见**：黄标写在 `w:vMerge` 续格时，LibreOffice 页面不可见。视图如实标注续格，编辑后的可见性必须通过真实合并表页面核对。 (Seen 1×)
- **黄标可见性审计须按独立片段计数**：同一处黄标因 Word run 拆分而被重复计数，会掩盖同一位置其他槽位漏标；以拆分 run 的单个黄标对多个待处理槽位作负控。 (Seen 1×)
- **发行包测试须绑定本次构建产物**：固定指向旧版本包会让新源码验证实际运行旧代码；核对运行包的版本和来源，并以新行为负控证明测试命中本次产物。 (Seen 1×)
- **表行增删与批次地址须端到端校验**：旧装配误删异构相邻行，扩展后旧坐标又曾写入新行。所有批次操作按批次开始状态寻址，以正式入口核对相邻行、固定尾行、每条值及返回的新地址。 (Seen 2×)
- **无库模式须核对空状态文案**：无库装配虽可启动，空工作台仍要求选择企业知识库；在无库和有库两条真实入口核对提示与可执行操作一致。 (Seen 1×)
- **加载中不能伪装为空数据并触发错误写入**：知识库列表请求尚未返回时，启动台显示无库并允许创建会话，导致已有企业场景落成无库任务；以延迟真实响应验证加载、空库和有库三态，确保启动绑定与提示一致。 (Seen 1×)
- **大模板装配须实测内存上限**：80.3 MiB 真实模板副本在 0.1.40 与 0.1.41 的官方宿主均超过默认约 4 GiB 堆并退出；小模板通过不能证明大模板可用，保留原件并记录同条件基线与内存证据。 (Seen 1×)
- **隐藏技术错误须保留可辨识的恢复对象**：Hub 将损坏知识库的路径和异常一并隐藏后，只提示部分库不可读，用户无法辨认受影响的库；以多个健康库与损坏库并存验证业务名称、可执行恢复提示和健康库可用性。 (Seen 1×)
- **上传错误须在操作当下的视口内可见**：错误消息虽然存在 DOM，但位于已滚动上传控件上方，用户选择损坏模板后看不到反馈；以真实滚动位置验证错误与控件的可见关系并覆盖恢复。 (Seen 1×)
- **会话看板须验证宿主生命周期而非只信登记表**：真实归档会话仍可点击并跳到空白输入框，失效 ID 则抛出未捕获异常；用宿主真实归档及失效记录验证可见反馈，保留已登记的工作成果，不得误入其他会话。 (Seen 1×)
- **项目可恢复须核对外部依赖**：复制 Word 和状态文件不代表项目可用，原知识库不存在时后续读取仍会失败。读取项目须明确呈现缺失依赖，保留现存成果，不能报告虚假成功。 (Seen 1×)
- **AI 指令与工作台编辑必须分别跟踪**：自由指令提交后留在输入框被误判为未保存编辑，工具执行成功却阻断右侧刷新；用真实成功工具轮次验证自由指令、快捷动作和实际未保存编辑的刷新行为。 (Seen 1×)
- **AI 提示词引用当前选中的实际知识库**：固定或过期的工作区回退路径可与选中库 ID 不一致，Agent 按提示调用工具会读取错误目录；验证装配前后及切换知识库时 ID 和可用路径都指向同一库。 (Seen 1×)
- **选中与主要操作须审视真实交互状态**：通用悬停规则先后覆盖主按钮及选中标签背景而保留白字，静态首屏截图无法暴露不可读状态；在 Web 和宿主中实际悬停、键盘聚焦、忙碌与恢复并核对可读性。 (Seen 2×)
- **人工授权与 Agent 编辑分开验证**：Agent 工具和 CLI 不提供确认、接受、过目、核实或定稿入口；人在工作台可正常执行。授权记录由 `SEAL_HOME/keys/` 下的密钥签名，内容、位置、类别或相关知识库与截标日变化后确认失效。分别验证 Agent 越权被拒和真实界面可用。 (Seen 2×)
- **操作成功须核对最终 Word**：复选框曾只更新状态而未改动文档。以实际符号、黄标及渲染核验操作结果，不能只断言台账状态或布尔值。 (Seen 1×)
- **区间复制须核对首尾原文**：提取到文末曾混入后续评审附件。由 Agent 明确选择范围，以范围前后相邻块核对输出；复制裁断的成对标记只清理残端并逐项报告。 (Seen 1×)
- **从零业务流程须覆盖真实材料绑定与全部上传入口**：新建证照虽有效且必带，却未绑定企业证照章节；母本和图片拖拽无请求，筛选及卡片定位缺失。以真实材料与模板验证覆盖、落位、上传和可发现的处理动作。 (Seen 1×)
- **历史母本媒介不能套用手工上传格式限制**：真实母本含 WMF，逐张调用仅允许 PNG/JPEG 的接口使整份导入回滚；修复矢量后 GIF 等其他已提取图像仍触发同一回滚。按入库器实际支持的完整媒介类型验证原件保留、可用落位和失败隔离。 (Seen 2×)
- **统计与待办界面须区分事实来源并约束长列表**：人工确认项被计入自动填充，真实模板的数百卡片遮住首屏和预览，底层坐标及 UUID 替代业务名称；用大模板和混合来源检验统计、首屏及业务指引。 (Seen 1×)
- **归档预览须覆盖请求及解码失败**：页面存在不代表浏览器能够展示，损坏图片与请求时消失的文件均只留下破图；真实 404 和不可解码图片分别验证清晰反馈、正常页面保留及恢复。 (Seen 1×)
- **初始页面错误和 API 错误分别呈现**：Web 首次读取损坏工作区直接返回原始 JSON，即使 API 状态码和后续刷新恢复正确，普通用户仍无法重试；初次加载须验证可理解的错误界面、重试和隔离技术详情。 (Seen 1×)
- **OOXML 扫描按精确元素名与嵌套边界定位**：把 `<w:tblPr>` 当成 `<w:tbl>` 会提前结束外表，使行列跨度串层。编辑、独立比较和标准 XML 合法性校验分别验证嵌套表；不能共用同一错误解析结论来自证。 (Seen 1×)
- **证据引用必须解析成功**：非空 ID 数组不能证明资料存在。引用不存在的记录或字段应拒绝整批编辑，现有草稿不变；未知来源不能获得已核实状态。 (Seen 1×)
- **工作台入口按用户指定导航验收**：把旧实现与旧任务里的会话顶部按钮当成正确产品入口，会漏检用户要求的左侧全局工作台；验收从未打开会话的左侧入口开始，核对 `sidebar.panellist` 与同 ID `main` 的真实挂载和工作区。 (Seen 1×)
- **项目 JSON 损坏须进入请求错误边界**：状态文件截断曾导致宿主退出与连接中断。通过真实请求核对可理解的错误、进程存活及修复后的恢复。 (Seen 1×)
- **输出路径必须与全部输入原件物理隔离**：CLI 导出路径与模板输入重合时，成功退出仍会覆盖原件；正式 CLI、工具与界面装配入口在任何写入前检查输出和输入路径、符号链接及物理别名，冲突明确拒绝且输入字节保持不变。 (Seen 1×)
- **业务数据不能进入可执行上下文**：旧 HTML 拼接中的单引号造成属性注入。工作台用 React 安全渲染数据，真实交互覆盖单引号、结束标签及无害脚本哨兵。 (Seen 1×)
- **架构守卫按解析目标判层，覆盖全部导入语法**：仅匹配 `packs/` 字串会漏过相对跨包路径，静态 import 正则也漏检动态宿主导入；使用实际语法节点和规范化目标执行层级约束，非法导入破壁必须红，静态宿主导入作为正控。 (Seen 1×)
- **重建包必须有新的发行身份**：DSH/pnpm 对同版本同路径本地包可能复用旧字节；每次交付递增补丁版本并生成新文件名，验收核对实际安装/加载文件与冻结 TGZ，而不是只看安装成功或 UI 标题。 (Seen 1×)
- **脱敏显示值不能作为内部关联键**：诊断投影正确遮蔽敏感行 ID 后，UI 用遮蔽后的 ID 与原始 ID 比较而无法打开弹窗；内部稳定关联与脱敏导出分离，真实按钮同时验证普通 ID、敏感 ID 和过滤列表。 (Seen 1×)
- **媒体计数必须区分图像与控件部件**：将 ActiveX XML 控件当成图片会夸大入库完整性指标；提取和统计依据图像部件类型，物理图像、有效绑定和非图像附件分别核对。 (Seen 1×)
- **诊断脱敏必须覆盖所有自由文本**：删除证据绑定或建议值仍会从 `gateMessages` 泄露电话、证件号和金额；以真实弹窗/导出注入敏感哨兵验证完整投影。 (Seen 1×)
- **知识库图片绑定必须支持合法路径括号**：简单右括号截断会让六张已入库图片在编译时静默失联；解析实际 Markdown 目标并核对物理路径与编译绑定，原件保持只读。 (Seen 1×)
- **DOCX 视觉验收必须使用可用的中文字形**：缺失 CJK 字体时页面数与版式均失真；LibreOffice 使用沙盒字体配置，肉眼确认中文字形后再采信分页与黄标。 (Seen 1×)
- **缺失证据不能由固定企业事实补齐**：编译器、入库器与装配器中的固定主体、信用代码、资本、日期和产能均可能把缺项变成已确认事实；同类扫描覆盖完整流水线，必需身份/规则缺失明确失败，可选或待决事实保持缺失/黄标。 (Seen 2×)
- **媒体名与入库单元名必须覆盖完整命名空间**：新图片不能覆盖已有 ZIP 媒体，多 DOCX 批次不能因同类别同标题覆盖前一输入；物理输出与报告计数一起验证。 (Seen 1×)
- **非法日期不能退化为无有效期限制**：无效截标日或证书日期不得变成“不适用”。严格校验日历日期，区分未知、长期有效与不适用。 (Seen 1×)
- **未知主体不能获得已核实状态**：任意外部名称不等于获准的第三方持证方；主体未知保持待核对，不能取消过期、禁用主体和主体不符的拒绝条件。 (Seen 1×)
- **入库标签须有可破坏的回归保护**：只断言图片数大于零曾漏过全部标题标签丢失。真实入口分别验证标题标记、原文位置、图片完整性和重复入库；删掉标签的破壁必须报红。 (Seen 1×)
- **宿主逻辑调用通过不等于真实载体已接通**：旧 `tests/dsh-bundle.test.ts` 仅计数注册项、替换 React hooks 并导入构建目录，漏掉 action 路由和交互；#31 已用真实 SDK 执行 12 项逻辑，但真实 Desktop 的 status GET 仍返回 400。安装版 rc.5 的默认流式载体为 GET 构造了带 body 的 Request；显式 buffered 才能通过。正式载体门禁须覆盖 webServer、认证交换、真实 HTTP 与各 sibling 路由，并分辨启动错误、认证拒绝和产品响应断言；不以直接调用 handler 或注册成功替代。证据 `.tmp/evidence/milestone-31/worker/carrier-get-red.log` 与 `progress.md`。 (Seen 2×)
- **任务结案锚点必须是实际业务提交**：Task #7 的 `Verified-Commit: a6e431f` 不是仓库 Git 对象，结案提交 `8594f66` 仅更新任务板。Router 在结案前核对业务 SHA、独立 Tester 报告与产物，不沿用未经核验的 verified 声明。 (Seen 1×)
- **Worker 执行任务中断且未上报完成信号**：Worker 在完成工程底座和边界测试文件后，未实现核心逻辑（`src/core/docx/` 空）即进入 `inactive` 状态。 (Seen 1×)
- **内核不能导入宿主 API**：Worker 曾在内核直接导入 `node:path` 并留下实现占位。三层边界守卫按解析目标检查全部导入形式，宿主能力只经 `HostPort` 注入；占位代码不是交付。 (Seen 1×)
- **提交完整空壳逻辑并破坏既有功能（Stub & Regression）**：Worker 提交了 `9bba5be` 与 `9c98418`，包含大量不可运行的 Stub（如 `9c98418` 中 `server.ts` 仅 6 行返回空 `<div id="app"></div>`、`src/workbench/` 与 `src/shells/dsh/` 目录完全为空、`ingestor.ts` 未解析 `w:outlineLvl`/`<w:highlight>`/`r:embed` 且 `enrichmentGaps` 永远为空数组、`src/shells/cli/index.ts` 未实现 `ingest` 命令，且未生成 `.tmp/evidence/task-4/` UI 截图）。此为严重的交付欺诈。 (Seen 2×)
- **DSH Client 依赖与入口以安装版契约为准**：把静态包写入 `dsh.client.inject` 曾使 Fiber 等待不存在的 Loader Entry；静态可加载也不代表稳定公开 API。安装版 `dsh-doc/references/practices.md` 要求不以模块方式 `require` Harness Client 控件包，控件复用宿主主题、locale 与交互约定，React 取自宿主模块表。Seal 以同 ID 的 `sidebar.panellist` 与 `main` 注册左侧全局工作台；旧模块加载经验不能覆盖安装版文档。 (Seen 1×)

## Moved to Guard Tests / Standards

- **表格与页面几何（Seen 4×）** → [word-layout-matrix.test.ts](../tests/word-layout-matrix.test.ts)、[word-layout-constraints.test.ts](../tests/word-layout-constraints.test.ts)、[word-layout-boundaries.test.ts](../tests/word-layout-boundaries.test.ts)、[cli-layout.test.ts](../tests/cli-layout.test.ts) 与 [dsh-bundle.test.ts](../tests/dsh-bundle.test.ts) 保护原 48 + 新 76 组合：行高、自然分栏、缩进与同行占位、四边及祖先边距、合并与嵌套、标注与多图、零容量草稿及 C16。四份旧坏输出均由 C16 与定稿清理后复检拒绝；独立复验看过 116 页与 5 张高 DPI 细节，见 `.tmp/evidence/milestone-29/tester/retest-273/report.md`。固定小行图片完整但纸面尺寸很小，不据此宣称普通纸面字号可读。
- **图片合法性与真实解码（Seen 3×）** → [tests/word-package-images.test.ts](../tests/word-package-images.test.ts) 覆盖 PNG 截断、JPEG 像素数据损坏及任意字节伪 WMF，并保留真实图片正控。第三次在交付前自检发现：LibreOffice 将三个任意字节作为 WMF 接受并导出占位 PNG，故转换成功不等于源图合法；源格式结构与真实解码必须同时成立，不能以头部、占位图或虚构尺寸放行。
- **三层依赖与宿主 API 边界** → [tests/boundaries.test.ts](../tests/boundaries.test.ts) 按解析后的导入目标约束 `core`、`workbench`、`shells`，并保留生产代码零硬编码检查。

## 已废止（#28 身份层替换）

以下条目保留历史实证，不再要求提示身份、来源血缘或偏移量迁移。提示由当前草稿重算，跳过绑定块文字指纹；待定与事实引用改用文档内 `_Seal_P_` / `_Seal_F_` 书签，台账按编号记录。部分交叉拒绝、范围内编辑保留编号、完整覆盖并超出范围时移除；旧推断与歧义复核不再适用。独立差异比较、黄标与原生样式保真仍适用。

- **跨固定文字改值须逐条核对待定来源**：独立复验中，两处原提示均填为 `100` 后，以唯一目标 `甲100` 替换为 `甲101`，原提示身份和位置正确，第一项的两条既有待定却丢失 `origin`、`sources`；新增待定又将整段 `甲101` 错锚到基准单字 `甲`，C10/C15 均为零。拆分文字来源与格式来源后该完整跨界例通过，但唯一目标 `00中→01中` 只与原填写部分相交时，原提示失联、两类来源均丢失；真实表格跨叶的同类编辑在人审后仍无法清理定稿标记。只验证完整覆盖、提示身份或确认失效不能证明相交范围正确；应分别核对从左右跨界、部分覆盖、跨叶的原 ID、来源片段、格式恢复和实际定稿，保留相邻重复值正控。证据 `.tmp/evidence/task-23/tester-r6-independent/acceptance.md`、`.tmp/evidence/task-23/tester-148-independent/acceptance.md`。 (Seen 2×)
- **已填写提示的后续改值也须保留操作来源**：恢复包验收中，明确填写的原提示已有 `resolution=100`，再以唯一 `find` 将其改为 `101` 后，原记录却失联并重新计入 C02；日期的 `17` 改为 `18` 同样发生。原值及待定确认失效正确，不能据此推断填写身份也被正确更新。须沿已知编辑范围追踪旧填写记录的真实新值，并验证同批、局部改值、人工确认失效及歧义时不误放行。源码与 SDK 的实际结果见 `.tmp/evidence/task-23/tester-brain-repair/source/recovery-results.json`、`sdk/recovery-results.json` 与 `source/date-followup-results.json`、`sdk/date-followup-results.json`；既有恢复守卫覆盖初填和提示迁移，漏掉初填后再次修改填写值。 (Seen 1×)
- **跨叶迁移须同时核对待定来源**：Worker 自检在父格整段替换后发现，原待定文字迁至另一叶段且位置和值正确，`sources` 却丢失；只断言位置与 C10 无法证明来源完整。以实际编辑验证来源片段、原文锚点及当前值一致，并保留跨叶和逐叶正控。该问题在交卷前修复，红绿证据分别为 `.tmp/evidence/task-23/brain-repair/cross-source.log` 与 `cross-source-green.log`。 (Seen 1×)
- **来源不确定时的人工复核须可重新完成**：Worker 在交卷前验证重复占位缩减：两个旧项无法唯一归属，原先过目的签名失效，旧项仍报告未处理；但 `reviewHint` 因状态已是 `acknowledged` 拒绝重新过目。不能自动猜测归属或沿用旧授权，也不能把待处理项留在人工无法复核的状态。人工重新审查基准及当前上下文后才签发新授权，并验证后续相关内容变化再次使之失效；当前未归属提示仍需独立处理。证据 `.tmp/evidence/task-23/brain-repair/ambiguity-recovery.log`。 (Seen 1×)
- **历史定位映射须覆盖全部可编辑地址层级**：未改变的表格也缺少 `t:N/r:I/c:J/p:K` 映射，历史待定项会被误记为位置丢失。地址解析支持的段落、单元格和嵌套表层级必须都有映射；在普通填值、插入及删除后核对旧项当前内容，不能只测顶层段落。映射守卫已建立，历史待定项的完整流转仍须经正式入口验收。 (Seen 1×)
- **同名内容须逐位置核对**：句中填写曾重复插入整句，同名复选项也曾只改首项。通过真实输出核验目标位置、相邻同名内容和未改文字。另一次真实核心调用把同段两个不同原锚点都填为 `100`，待定项因只在输出中找唯一值而没有偏移，全部无法人工确认并误报 C10；须按批次前目标与整体位移保留精确位置，去重、确认、视图和黄标审计均区分同段同值的不同出现。证据 `.tmp/evidence/task-23/router-repeated-pending-probe.json`。 (Seen 2×)
- **待定流转须覆盖值内的局部编辑**：完整值替换的确认失效测试通过后，正常填写合成的 `100万元`、人工确认，再只把 `100` 改成 `200`，旧待定仍指向 `100万元` 且无法重新确认；新值确认后 C04、C10、C15 仍各有两条旧项。只匹配 `find === pending.value` 漏掉相交片段；须按编辑前位置与范围映射重新打开当前内容，验证局部改值、多项同块及再次确认，不能留下不可恢复的旧值记录。移除相交文字或包含块时也不能由 Agent 静默删除账本待定项；须保留当前移除状态与人工签名处置路径，不能用自动过滤旧项换取检查归零。证据为交付前真实 core 调用 `.tmp/evidence/task-23/router-partial-pending-probe.json`。 (Seen 1×)
- **输出坐标和待定值须遵循软换行规范化结果**：正式核心编辑写入含 CRLF 的合法文本时，Word 软换行的实际可见长度与原输入长度不同，待定定位仍按原值查找，误拒整个编辑并要求拆批。输出位移、待定值和来源映射应以真实输出的规范化可见文字为准，同时验证后续批次目标与黄标；不得通过拒绝换行规避。证据 `.tmp/evidence/task-23/brain-repair/unicode-newline-probes.log`。 (Seen 1×)

## 已废止（#23 重构）

以下记录保留历史失效模式，不再要求槽位写权限、语义规划器、指纹阻断或旧入口。历史路径仅作文字记录，不表示现有守卫；成对标记裁断以现行区间复制契约为准。

- **章节外图例不能携带同格无关正文或隐藏标识**：复制整格曾带入章外段落，裁剪文本后图例段落的书签属性仍会进入导出；以正式导出检查图例生效及无关文本、书签等非文本标识不出现。 (Seen 2×)
- **章节提取须覆盖全部成对修订范围**：仅检查书签、批注和权限范围会漏掉跨章节移动及自定义 XML 修订，导出留下孤立结束标记；对全部支持的成对范围逐类验证跨边界阻断和完整范围保留。 (Seen 1×)
- **隐藏样式守卫须识别显式关闭值**：默认样式的 `w:vanish w:val="0"` 表示可见，只按元素存在判断会误拒合法图例；以显式开启、关闭和继承组合验证导出及渲染。 (Seen 1×)
- **复选框审计须考虑同段其他槽位的合法替换**：复选框与括号槽同段时，沿用包含原占位符的整段文本定位会误拒正确标黄的输出；以正式导出、逐项去黄和相邻槽位已填正控验证。 (Seen 1×)
- **同一位置的不同槽型必须同时检视**：段落或单元格中已有括号槽时，下划线槽被漏掉并无黄标导出；用混合槽型正式装配验证每个缺口及独立可见性。 (Seen 1×)
- **可见性审计的搜索上限不能被无关空格耗尽**：正确标黄的括号槽后有多组排版空格时，被无关候选组合耗尽预算并误拒；用空格密集正控和真实缺标负控验证。 (Seen 1×)
- **主体一致性守卫须覆盖括号和混合字段**：主体槽混排、表格标签、双语冲突、名称修饰语及主体角色前缀加信用代码均曾让错误主体通过确认；以主体语义、角色、修饰语、槽型和标签结构的交叉网格走完整确认、导出负控。 (Seen 7×；须晋升守卫测试)
- **网格须覆盖槽位周围上下文**：带字段前缀与尾随角色注记的空格留白、带格式或签署注记的日期留白曾完全漏槽且无黄标；先以交叉网格验证槽位存在，再验证缺标拦截。 (Seen 1×)
- **图例识别与单元格段落顺序无关**：图例出现在同格其他内容之后时仍须升级全文同类括号权限；覆盖图例前后均含待填项的真实单元格。 (Seen 1×)
- **附件挂载指令须覆盖上下文与表格**：带标签的段落或独立单元格中的 `【提供…复印件】` 不应变成普通文本槽或丢失；以正文及表格负控核对实际挂载能力。 (Seen 1×)
- **重复行探测须遵守括号语法例外**：数字引文和版本字面量虽然带括号，却被重复行识别为待填示例并标黄；在表格行级别验证引文、版本和真实占位符正负控。 (Seen 1×)
- **章节提取须保留文外图例的适用范围**：模板图例位于提取章节之外时，提取后的槽位权限不能悄然降级；用正式提取与装配路径检查原文档图例的传递。 (Seen 1×)
- **图例与待填项同格时不能冻结整格**：同一单元格含图例和待填项时跳过整格会漏掉真实槽位；覆盖同格、跨段落和合并单元格，并核对提取后权限。 (Seen 1×)
- **保护相邻行不能跳过真实未填写槽位的黄标**：为避免重复行后的空单元格被误改而跳过未规划表格槽位，会让真实模板的文字占位符及纯空白必填单元格失去原生黄标；同时验证异构行冻结与真实未填槽位的 XML 高亮和渲染。 (Seen 2×)
- **分类附录必须在普通章节边界结束**：只识别下一个附录标题会把后续章节的槽位一并冻结；用附录后接普通章节的文档验证枚举与槽位范围。 (Seen 1×)
- **括号槽位与确认须验证已填事实及未知值**：已填事实中的方括号内容被识别为可写槽位并通过保真，未修改的占位符及多种未知表达也可人工确认消黄；以段落和表格中的已填事实作负控，并从真实界面验证未填写和未知值不能确认就绪。 (Seen 3×；须晋升守卫测试)
- **槽位误判修复须保留真实相邻正控**：仅以前缀排除已填括号事实会漏掉连续占位符、年月日和句中字段；以真实模板及句中、连续槽位正控同时验证冻结和可填性。 (Seen 1×)
- **会话隔离升级须保留旧工作区成果的可见恢复路径**：把状态迁到会话专属目录后，旧版工作区矩阵仍在但看板和会话均显示空；不能猜测旧矩阵属于哪个会话，应显式呈现未关联成果并允许用户安全关联，同时保护原件与现有会话数据。 (Seen 1×)
- **主体保护覆盖真实标签变体且失败不能报成功**：单独修复一种投标人标签后，带盖章注记或投标单位的槽位仍能确认禁用主体；同时已阻断行仍报告保存成功。按结构识别主体字段并以真实 Word 检验不同变体，阻断时不得写入或报告成功。 (Seen 2×)
- **挂载归因覆盖实际落位的后代证据**：容器自身归因合格不代表子证据合格；最终行守卫只重算根绑定会丢失已解析子证据的过期或禁用主体结论，导致材料覆盖失败但图片仍写入 Word。按实际落位的完整证据闭包检查归因，过期/禁用子证据阻断出补丁，未知主体保持待确认；`tests/container-evidence.test.ts` 实际打中挂载拦截分支，不能以规划器留白样本证明过期拦截。 (Seen 1×)
- **隔离 DSH profile 同时覆盖默认 Documents 根**：独立 `DSH_HOME` 仍可能让宿主确保真实 Documents 下的默认工作区目录；浏览器验收启动前同时配置沙盒 Documents 根和会话 cwd，不在启动后才切换，未知既存目录保持不动。 (Seen 1×)
- **受保护决策的黄标覆盖全部公开生成入口**：仅验证 bidding planner 的黄标会漏过独立 filler/generator；其偏离勾选和合同金额在没有项目确认记录时仍以普通文本输出。默认不确定语义传到实际勾选与金额 run，以正式注册模板导出和原生 XML 验证，不以输入布尔值或普通数值推断审批。 (Seen 1×)
- **表格槽位不能由固定标签空格猜测**：体系认证固定窄标签被当成可写槽位，长文占满窄列并跨页，真正宽描述单元格未填；验收核对原标签、目标单元格与列宽，排除误槽后仍须完成真实描述槽位；收紧空格识别同时验证交期/质保等合法留白，不能用删除识别规则掩盖误判。 (Seen 2×)
- **矩阵结论必须传到实际补丁与 Word**：只核对 row gate 而不检查 emitted patches/OOXML 时，未知主体虽为黄标行，图片补丁仍无高亮；最终补丁使用同一守卫后的值与标记，附件覆盖依据实际有效落位。 (Seen 1×)
- **依赖恢复须验证完整模板与所有入口（Seen 4×）** → `tests/dsh-bundle.test.ts` 覆盖损坏 ZIP 各部件、上传及工具入口、确认阻断与宿主存活；`tests/docx-probe.test.ts` 覆盖未定义实体等 XML 合法性；`tests/workbench-recovery.test.ts` 覆盖上传错误提示和视口可见性。独立验收核对替换恢复及原件保留。
- **知识库枚举须隔离单个损坏记录（Seen 3×）** → `tests/dsh-bundle.test.ts` 覆盖语法与结构损坏、健康库正控、确认阻断、原件保留及真实装配；独立验收另覆盖 16 类装配字段异常和恢复。
- **重复行属性、样式与合法适配（Seen 3×）** → `tests/input-preservation.test.ts`、`tests/audit-release-017.test.ts` 与 `tests/audit-release-018.test.ts` 保护独立保真校验，同时覆盖多表头继承、URL 适配正控和属性丢失负控。
- **可视化核验状态与页面镜（Seen 3×）** → `tests/audit-release-017.test.ts`、`tests/browser/dsh-global.mjs` 与 `tests/browser/dsh-diagnostic.mjs` 从正式入口核对错误恢复、归档页可用性、真实状态与过滤交互。
- **历史槽位授权与非槽位保真（Seen 10×）** → 现行编辑原语的定位、非法批次与相邻样式保护见 [word-text-batch.test.ts](../tests/word-text-batch.test.ts)，原件对象、媒体与关系保真见 [word-package-compare.test.ts](../tests/word-package-compare.test.ts)，部分交叉的原子拒绝见 [bid-document-identity.test.ts](../tests/bid-document-identity.test.ts)。旧槽位授权已被替换，固定原文改写由独立差异检查报告。原测试中的知识库日期、主体及图片路径守卫分别由 [kb-health.test.ts](../tests/kb-health.test.ts)、[kb-ingest.test.ts](../tests/kb-ingest.test.ts) 和 [kb-markdown-images.test.ts](../tests/kb-markdown-images.test.ts) 承接。
