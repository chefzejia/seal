import { defineTool } from "@deepseek-ai/dsh-tools";
import type { HostPort } from "../../core/host.js";
import type { ReadDocumentResult } from "../../core/docx/read-document.js";
import { CHECK_CODES } from "../../core/bid/report.js";
import { REQUIREMENT_KINDS } from "../../core/bid/requirements.js";
import { runProject } from "../cli/project-v2.js";
import { runKnowledgeBase } from "../cli/kb.js";

export interface ToolContext {
  tools: { register(definition: unknown): () => void };
  effect(register: () => () => void): unknown;
  workingDirectory: {
    ensure(agent: unknown, signal: AbortSignal): Promise<string>;
  };
}
type Execution = { agent?: unknown; signal: AbortSignal };
type Common = { project?: string; vaultId?: string; referenceDate?: string };
const output = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: { json: { type: "string", required: true } },
  },
  render: (_args: unknown, value: { json: string }) => [
    { type: "text" as const, text: value.json },
  ],
};

function renderDocRead(_args: unknown, value: { json: string }) {
  const data = JSON.parse(value.json) as ReadDocumentResult;
  const lines: string[] = [];
  if (data.mode === "outline") {
    for (const item of data.items) {
      const partial =
        !item.fragment.complete || item.fragment.offset > 0
          ? ` frag:${item.fragment.offset}..${item.fragment.offset + item.text.length}/${item.fragment.totalCharacters}`
          : "";
      const parent = item.parent ? `, parent=${item.parent}` : "";
      const meta =
        item.range && item.counts
          ? ` (${item.range.from}..${item.range.to}, p=${item.counts.paragraphs}, t=${item.counts.tables}, hints=${item.counts.hints}${parent})`
          : "";
      lines.push(
        `[${item.address ?? item.location}${partial}] H${item.level ?? 0} ${item.text}${meta}`,
      );
    }
  } else {
    for (const item of data.items) {
      if (
        (item.kind === "table" ||
          item.kind === "row" ||
          item.kind === "cell") &&
        item.text === ""
      ) {
        continue;
      }
      const frag =
        !item.fragment.complete || item.fragment.offset > 0
          ? ` frag:${item.fragment.offset}..${item.fragment.offset + item.text.length}/${item.fragment.totalCharacters}`
          : "";
      if (item.editable && item.address !== null) {
        lines.push(`[${item.address}${frag}]${item.text ? ` ${item.text}` : ""}`);
      } else {
        const label = item.label ?? "不可编辑";
        lines.push(
          `[${item.location}${frag}] [${label}]${item.text ? ` ${item.text}` : ""}`,
        );
      }
    }
    if (lines.length === 0) {
      lines.push(
        data.items.length === 0
          ? "(无匹配块)"
          : "(本页仅含表格结构外壳，请用 next 继续读取)",
      );
    }
  }
  if (data.warningCount > 0 || data.warnings.length > 0) {
    lines.push(
      `warnings(${data.warningCount}${data.warningsTruncated ? ", truncated" : ""}): ${data.warnings.join(" | ")}`,
    );
  }
  if (data.truncated && data.next) {
    lines.push(`truncated=true next=${JSON.stringify(data.next)}`);
  } else {
    lines.push("truncated=false");
  }
  return [{ type: "text" as const, text: lines.join("\n") }];
}

const readOutput = {
  schema: output.schema,
  render: renderDocRead,
};

function parseCursorInput(cursor: unknown): Record<string, unknown> {
  let parsed: unknown = cursor;
  if (typeof cursor === "string") {
    try {
      parsed = JSON.parse(cursor);
    } catch {
      throw new Error(
        "cursor 参数无效：不是合法 JSON；请原样传入上一次返回的 next.cursor 对象或去掉 cursor 从头读取。",
      );
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      "cursor 参数无效：必须为 JSON 对象（或合法 JSON 对象字符串）；请原样传入上一次返回的 next.cursor 或去掉 cursor 从头读取。",
    );
  }
  return parsed as Record<string, unknown>;
}

async function root(
  ctx: ToolContext,
  args: Common,
  exec: Execution,
): Promise<string> {
  exec.signal.throwIfAborted();
  if (exec.agent !== undefined)
    return ctx.workingDirectory.ensure(exec.agent, exec.signal);
  if (!args.project)
    throw new Error("没有会话工作目录，请提供 project 项目路径参数");
  return args.project;
}

const projectParameter = {
  type: "string" as const,
  description: "项目根目录；无会话工作目录时必填。",
};

export function registerProjectTools(ctx: ToolContext, host: HostPort): void {
  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: "seal_doc_read",
        description:
          "读取项目内 Word 的大纲、带地址正文块或字面搜索结果，返回有界内容与 next 续读参数。",
        parameters: {
          project: projectParameter,
          file: {
            type: "string",
            required: true,
            description: "分册名或项目内相对路径（如 tender/1.docx）。",
          },
          mode: {
            type: "string",
            enum: ["outline", "blocks", "search"],
            required: true,
            description: "读取模式：outline（目录与区间）、blocks（正文块）或 search（字面搜索）。",
          },
          from: {
            type: "string",
            description: "outline 或 blocks 起始块地址（省略从文档开头读取）。",
          },
          to: {
            type: "string",
            description:
              "结束块地址（仅 blocks 与 outline 可用，闭区间包含该块及其后代子块，如 t:N 包含表内所有行格段）。",
          },
          onlyHints: {
            type: "boolean",
            description:
              "仅 blocks 可用；设为 true 时只返回含疑似空白提示的块（配合 from/to 快速定位待填与待跳过位置）。",
          },
          query: {
            type: "string",
            description: "mode=search 必填，非空字面搜索文本（不做正则匹配，最长 4096 字符）。",
          },
          limit: {
            type: "integer",
            description: "返回条目上限（outline 默认 60、blocks 默认 50，范围 1–200；search 默认 30，范围 1–100）。",
          },
          maxChars: {
            type: "integer",
            description: "单次字符预算（2–50000，默认 12000）。",
          },
          context: {
            type: "integer",
            description: "search 命中两侧上下文字符数（0–200，默认 40）。",
          },
          cursor: {
            type: "json",
            description: "续读时原样传入上一次返回的 next.cursor（支持 JSON 对象或 JSON 字符串）。",
          },
        },
        output: readOutput,
        async execute(
          args: Common & {
            file: string;
            mode: string;
            from?: string;
            to?: string;
            onlyHints?: boolean;
            query?: string;
            limit?: number;
            maxChars?: number;
            context?: number;
            cursor?: unknown;
          },
          exec,
        ) {
          const project = await root(ctx, args, exec);
          const options = [
            "read",
            "--project",
            project,
            "--file",
            args.file,
            "--mode",
            args.mode,
          ];
          if (args.query !== undefined) options.push("--query", args.query);
          if (args.from !== undefined) options.push("--from", args.from);
          if (args.to !== undefined) options.push("--to", args.to);
          if (args.onlyHints !== undefined)
            options.push("--only-hints", String(args.onlyHints));
          if (args.limit !== undefined)
            options.push("--limit", String(args.limit));
          if (args.maxChars !== undefined)
            options.push("--max-chars", String(args.maxChars));
          if (args.context !== undefined)
            options.push("--context", String(args.context));
          if (args.cursor !== undefined)
            options.push("--cursor", JSON.stringify(parseCursorInput(args.cursor)));
          return { json: JSON.stringify(await runProject(host, options)) };
        },
      }),
    ),
  );
  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: "seal_doc_extract",
        description:
          "按有序区间复制项目登记招标副本创建分册基准与工作稿，返回分册、空白提示数与清理标记。",
        parameters: {
          project: projectParameter,
          tender: {
            type: "string",
            required: true,
            description: "项目登记的招标副本相对路径（如 tender/1.docx）。",
          },
          draft: {
            type: "string",
            required: true,
            description: "新分册名（1–100 位字母、数字、空格、下划线或连字符，不能重名）。",
          },
          ranges: {
            type: "array",
            items: { type: "json" },
            required: true,
            description: "非空有序顶层块区间数组，每项为 { from, to }。",
          },
        },
        output,
        async execute(
          args: Common & { tender: string; draft: string; ranges: unknown[] },
          exec,
        ) {
          const project = await root(ctx, args, exec);
          return {
            json: JSON.stringify(
              await runProject(host, [
                "extract",
                "--project",
                project,
                "--tender",
                args.tender,
                "--draft",
                args.draft,
                "--ranges",
                JSON.stringify(args.ranges),
              ]),
            ),
          };
        },
      }),
    ),
  );
  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: "seal_doc_edit",
        description:
          "对分册工作稿提交原子编辑批次（失败整批不落盘），返回逐操作视图与新增待定项。",
        parameters: {
          project: projectParameter,
          draft: {
            type: "string",
            required: true,
            description: "目标分册名。",
          },
          ops: {
            type: "array",
            items: { type: "json" },
            required: true,
            description:
              "编辑操作数组：replace(at, find|blank, value)、set_cell(at, value)、check(at, option, checked)、mark_pending(at, find|blank, pending)、insert_rows(at, mode: after|replace, rows)、insert(at, position: before|after, markdown，图片可用 kb:<recordId>/<relPath>)、insert_image(at, image，可用项目内路径或 kb:<recordId>/<relPath>)、insert_toc(at, position: before|after, maxLevel?)、delete(at, allowDeleteSectionBreak?)、dismiss_hint(at, blank, reason)、dismiss_hints({ targets: [{ at, blanks? }], reason } | { from, to, reason })；可选 pending({ category, note }) 与 thirdPartyHolder。",
          },
        },
        output,
        async execute(args: Common & { draft: string; ops: unknown[] }, exec) {
          const project = await root(ctx, args, exec);
          return {
            json: JSON.stringify(
              await runProject(host, [
                "edit",
                "--project",
                project,
                "--draft",
                args.draft,
                "--ops",
                JSON.stringify(args.ops),
              ]),
            ),
          };
        },
      }),
    ),
  );
  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: "seal_check",
        description:
          "运行全项目确定性检查，返回全部分册完整 ready 状态、计数与分页结果。",
        parameters: {
          project: projectParameter,
          draft: {
            type: "string",
            description: "仅返回指定分册；省略返回全部分册（ready 始终计入全部分册）。",
          },
          group: {
            type: "string",
            enum: [...CHECK_CODES],
            description: "仅返回某项检查分组（C01–C17）。",
          },
          offset: {
            type: "integer",
            description: "每组条目起始偏移（>= 0，默认 0）。",
          },
          limit: {
            type: "integer",
            description: "每组返回条数上限（1–200，默认 50）。",
          },
        },
        output,
        async execute(
          args: Common & {
            draft?: string;
            group?: string;
            offset?: number;
            limit?: number;
          },
          exec,
        ) {
          const project = await root(ctx, args, exec);
          return {
            json: JSON.stringify(
              await runProject(host, [
                "check",
                "--project",
                project,
                ...(args.draft ? ["--draft", args.draft] : []),
                ...(args.group ? ["--group", args.group] : []),
                ...(args.offset === undefined
                  ? []
                  : ["--offset", String(args.offset)]),
                ...(args.limit === undefined
                  ? []
                  : ["--limit", String(args.limit)]),
              ]),
            ),
          };
        },
      }),
    ),
  );
  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: "seal_requirements",
        description:
          "保存、增量更新或分页读取项目招标要求清单；save 全量校验引文，patch 按 id 增量更新 responses/evidence，人工覆盖标记仅限工作台操作。",
        parameters: {
          project: projectParameter,
          action: {
            type: "string",
            enum: ["save", "patch", "list"],
            required: true,
            description:
              "操作：save 全量校验并写入；patch 按 id 增量更新 responses/evidence；list 只读分页读取。",
          },
          items: {
            type: "array",
            items: { type: "json" },
            description: `save 时为完整要求数组，每项含 id、kind（${REQUIREMENT_KINDS.join("|")}）、text、quote、source({ file, address })、mustRespond、responses([{ draft, address }])，可选 points、evidence；patch 时为增量数组，每项仅允许 id 及 responses/evidence 之一；禁填人工覆盖或核实字段。`,
          },
          offset: {
            type: "integer",
            description: "action=list 起始位置（>= 0，默认 0）。",
          },
          limit: {
            type: "integer",
            description: "action=list 返回条数上限（1–200，默认 50）。",
          },
        },
        output,
        async execute(
          args: Common & {
            action: string;
            items?: unknown[];
            offset?: number;
            limit?: number;
          },
          exec,
        ) {
          const project = await root(ctx, args, exec);
          if (
            args.action !== "save" &&
            args.action !== "patch" &&
            args.action !== "list"
          ) {
            throw new Error(
              "action 必须为 save、patch 或 list；人工覆盖标记仅限工作台操作。",
            );
          }
          if (args.action === "save" || args.action === "patch") {
            if (args.items === undefined) {
              throw new Error(
                args.action === "patch"
                  ? "缺少 items；请传入包含 id 与 responses/evidence 的更新数组。"
                  : "缺少 items；请传入要求对象数组（尚无草稿地址时 responses 可传 []）。",
              );
            }
            if (args.offset !== undefined || args.limit !== undefined) {
              throw new Error(
                `action=${args.action} 不接受 offset 或 limit；分页读取请改用 action=list。`,
              );
            }
            return {
              json: JSON.stringify(
                await runProject(host, [
                  "requirements",
                  "--project",
                  project,
                  "--action",
                  args.action,
                  "--items",
                  JSON.stringify(args.items),
                ]),
              ),
            };
          }
          if (args.items !== undefined) {
            throw new Error(
              "action=list 为只读，不接受 items；保存请改用 action=save。",
            );
          }
          const options = [
            "requirements",
            "--project",
            project,
            "--action",
            "list",
          ];
          if (args.offset !== undefined)
            options.push("--offset", String(args.offset));
          if (args.limit !== undefined)
            options.push("--limit", String(args.limit));
          return { json: JSON.stringify(await runProject(host, options)) };
        },
      }),
    ),
  );
  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: "seal_outline",
        description:
          "读取、保存或增量修订项目编制大纲蓝图（outline.json）；返回当前大纲、确认状态、统计摘要与项目 materials/ 可用材料清单，大纲确认仅限工作台操作。",
        parameters: {
          project: projectParameter,
          action: {
            type: "string",
            enum: ["get", "save", "patch"],
            required: true,
            description:
              "操作：get 只读获取大纲与材料清单；save 全量校验并写入；patch 增量增删改节点或分册；禁传确认或核实字段。",
          },
          volumes: {
            type: "array",
            items: { type: "json" },
            description:
              "action=save 必填，分册规划数组 [{ name, tender?, ranges?, note? }]。",
          },
          nodes: {
            type: "array",
            items: { type: "json" },
            description:
              "action=save 必填，树节点数组（含 id、volume、parentId、level、title、kind、included，可选 number、optional、lockedTemplate、tenderSource、requirementIds、evidence、materialMissing、materialNote、note、expectedHeading）。",
          },
          upsertNodes: {
            type: "array",
            items: { type: "json" },
            description: "action=patch 可选，按 id 新增或更新节点数组。",
          },
          removeNodeIds: {
            type: "array",
            items: { type: "string" },
            description:
              "action=patch 可选，待删除节点 id 数组（连同子树删除；受非可选 lockedTemplate 保护）。",
          },
          updateVolumes: {
            type: "array",
            items: { type: "json" },
            description: "action=patch 可选，新增或更新分册配置数组。",
          },
        },
        output,
        async execute(
          args: Common & {
            action: string;
            volumes?: unknown[];
            nodes?: unknown[];
            upsertNodes?: unknown[];
            removeNodeIds?: string[];
            updateVolumes?: unknown[];
          },
          exec,
        ) {
          const project = await root(ctx, args, exec);
          if (
            args.action !== "get" &&
            args.action !== "save" &&
            args.action !== "patch"
          ) {
            throw new Error(
              "action 必须为 get、save 或 patch；确认大纲仅限工作台人工操作。",
            );
          }
          if (args.action === "get") {
            if (
              args.volumes !== undefined ||
              args.nodes !== undefined ||
              args.upsertNodes !== undefined ||
              args.removeNodeIds !== undefined ||
              args.updateVolumes !== undefined
            ) {
              throw new Error("action=get 为只读，不接受保存或修改参数。");
            }
            return {
              json: JSON.stringify(
                await runProject(host, [
                  "outline",
                  "--project",
                  project,
                  "--action",
                  "get",
                ]),
              ),
            };
          }
          if (args.action === "save") {
            if (args.volumes === undefined || args.nodes === undefined) {
              throw new Error("action=save 必须同时提供 volumes 与 nodes 数组。");
            }
            if (
              args.upsertNodes !== undefined ||
              args.removeNodeIds !== undefined ||
              args.updateVolumes !== undefined
            ) {
              throw new Error(
                "action=save 不接受 upsertNodes、removeNodeIds 或 updateVolumes；增量修改请改用 action=patch。",
              );
            }
            return {
              json: JSON.stringify(
                await runProject(host, [
                  "outline",
                  "--project",
                  project,
                  "--action",
                  "save",
                  "--volumes",
                  JSON.stringify(args.volumes),
                  "--nodes",
                  JSON.stringify(args.nodes),
                ]),
              ),
            };
          }
          if (args.volumes !== undefined || args.nodes !== undefined) {
            throw new Error(
              "action=patch 不接受 volumes 或 nodes；全量替换请改用 action=save。",
            );
          }
          if (
            args.upsertNodes === undefined &&
            args.removeNodeIds === undefined &&
            args.updateVolumes === undefined
          ) {
            throw new Error(
              "action=patch 至少需提供 upsertNodes、removeNodeIds 或 updateVolumes 之一。",
            );
          }
          const options = [
            "outline",
            "--project",
            project,
            "--action",
            "patch",
          ];
          if (args.upsertNodes !== undefined) {
            options.push("--upsert-nodes", JSON.stringify(args.upsertNodes));
          }
          if (args.removeNodeIds !== undefined) {
            options.push(
              "--remove-node-ids",
              JSON.stringify(args.removeNodeIds),
            );
          }
          if (args.updateVolumes !== undefined) {
            options.push("--update-volumes", JSON.stringify(args.updateVolumes));
          }
          return { json: JSON.stringify(await runProject(host, options)) };
        },
      }),
    ),
  );

  const kbArgs = async (args: Common, exec: Execution): Promise<string[]> => {
    exec.signal.throwIfAborted();
    const values: string[] = [];
    if (exec.agent !== undefined || args.project !== undefined) {
      const directory = await root(ctx, args, exec);
      if (
        args.project !== undefined ||
        args.vaultId === undefined ||
        (await host.stat(host.joinPath(directory, "seal-project.json"))).exists
      )
        values.push("--project", directory);
    }
    if (args.vaultId !== undefined) values.push("--vault", args.vaultId);
    if (args.referenceDate !== undefined)
      values.push("--reference-date", args.referenceDate);
    return values;
  };
  const commonParameters = {
    project: {
      type: "string" as const,
      description: "项目根目录；自动关联知识库与截标日。",
    },
    vaultId: {
      type: "string" as const,
      description: "知识库 ID；无关联项目时必填。",
    },
    referenceDate: {
      type: "string" as const,
      description:
        "单库体检或按 validity 筛选时的日期（YYYY-MM-DD）；项目内自动使用截标日。",
    },
  };
  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: "seal_kb_search",
        description:
          "按条件检索记录与写作素材，或按 batchId 分页列出入库候选（用 nextAfter 续读）。",
        parameters: {
          ...commonParameters,
          query: {
            type: "string",
            description: "检索关键词（与 batchId 互斥）。",
          },
          type: {
            type: "string",
            description: "按资料类型筛选（仅检索模式）。",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "按标签筛选（仅检索模式）。",
          },
          validity: {
            type: "string",
            enum: ["valid", "expiring_soon", "expired", "unknown"],
            description: "按效期筛选（需项目截标日或 referenceDate）。",
          },
          limit: {
            type: "integer",
            description: "返回条数上限（默认 20）。",
          },
          batchId: {
            type: "string",
            description: "入库批次 ID；分页列出待分类候选编号（不输出正文）。",
          },
          after: {
            type: "string",
            description: "配合 batchId 传入上页返回的 nextAfter 续读。",
          },
        },
        output,
        async execute(
          args: Common & {
            query?: string;
            type?: string;
            tags?: string[];
            validity?: string;
            limit?: number;
            batchId?: string;
            after?: string;
          },
          exec,
        ) {
          const values = ["search", ...(await kbArgs(args, exec))];
          if (args.query !== undefined) values.push("--query", args.query);
          if (args.batchId !== undefined) values.push("--batch", args.batchId);
          if (args.after !== undefined) values.push("--after", args.after);
          if (args.type !== undefined) values.push("--type", args.type);
          if (args.tags !== undefined)
            values.push("--tags", JSON.stringify(args.tags));
          if (args.validity !== undefined)
            values.push("--validity", args.validity);
          if (args.limit !== undefined)
            values.push("--limit", String(args.limit));
          return { json: JSON.stringify(await runKnowledgeBase(host, values)) };
        },
      }),
    ),
  );
  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: "seal_kb_get",
        description:
          "读取主体档案、证据记录、写作素材或入库候选及体检状态；长正文返回 nextOffset。",
        parameters: {
          ...commonParameters,
          id: {
            type: "string",
            description: "记录、素材或候选 ID（与 subject=true 二选一）。",
          },
          kind: {
            type: "string",
            enum: ["subject", "record", "material"],
            description: "条目类型；读普通条目时建议显式指定。",
          },
          subject: {
            type: "boolean",
            description: "设为 true 读取企业主体档案。",
          },
          offset: {
            type: "integer",
            description:
              "正文 UTF-16 字符起始位置（>= 0，不得切分代理对）；截断时传上页 nextOffset。",
          },
        },
        output,
        async execute(
          args: Common & {
            id?: string;
            kind?: string;
            subject?: boolean;
            offset?: number;
          },
          exec,
        ) {
          const values = ["get", ...(await kbArgs(args, exec))];
          if (args.subject) values.push("--subject");
          else if (args.id !== undefined) values.push("--id", args.id);
          else
            throw new Error(
              "请提供 id 或设 subject=true 读取主体档案。",
            );
          if (args.kind !== undefined) values.push("--kind", args.kind);
          if (args.offset !== undefined)
            values.push("--offset", String(args.offset));
          return { json: JSON.stringify(await runKnowledgeBase(host, values)) };
        },
      }),
    ),
  );
  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: "seal_kb_save",
        description:
          "创建、更新、删除知识库条目、附加只读原件或单条/批量清理候选；核实状态仅限工作台人工设置。",
        parameters: {
          ...commonParameters,
          action: {
            type: "string",
            enum: [
              "create",
              "update",
              "delete",
              "attach_file",
              "dismiss_candidate",
              "dismiss_candidates",
            ],
            required: true,
            description:
              "保存动作：create/update/delete/attach_file 操作条目，dismiss_candidate/dismiss_candidates 标记候选已处理。",
          },
          kind: {
            type: "string",
            enum: ["subject", "record", "material"],
            description:
              "条目类型（create/update/delete/attach_file 必填；dismiss_candidate/dismiss_candidates 可省略）。",
          },
          id: {
            type: "string",
            description:
              "条目或候选 ID（update、delete、attach_file、dismiss_candidate 必填）。",
          },
          ids: {
            type: "array",
            items: { type: "string" },
            description: "候选 ID 数组（action=dismiss_candidates 必填）。",
          },
          dismissCandidateIds: {
            type: "array",
            items: { type: "string" },
            description:
              "可选（create/update 可用）：保存条目同时批量标记已处理的关联候选 ID 数组。",
          },
          fields: {
            type: "object",
            additionalProperties: true,
            description:
              "结构化字段对象（禁止传 verified/verifiedAt/verifiedFields 或 __seal*）。subject 允许：legalName、creditCode、legalRepresentative、registeredCapital、establishedOn、address、phone、email、bankName、bankAccount、forbiddenAffiliates、thirdPartyHolders；record 允许：type（营业执照|资质证书|认证证书|许可证|人员证书|社保证明|业绩合同|验收证明|财务审计|纳税证明|信用证明|授权文件|其他）、title、number、issuedOn、holder、employer、validUntil（YYYY-MM-DD|长期|不适用；新版无固定营业期限营业执照可填长期待人核实）、client、projectName、amount、signedOn、files（库内相对路径数组如 files/<batchId>/...；凡含 Word 母本/PDF/散装扫描件的证照记录务必填写勿留空）、source、tags；material 允许：title、tags、source、files。",
          },
          body: { type: "string", description: "条目正文。" },
          filePath: {
            type: "string",
            description: "本地只读原件路径（action=attach_file 必填）。",
          },
        },
        output,
        async execute(
          args: Common & {
            action: string;
            kind?: string;
            id?: string;
            ids?: string[];
            dismissCandidateIds?: string[];
            fields?: Record<string, unknown>;
            body?: string;
            filePath?: string;
          },
          exec,
        ) {
          const isCandidateDismiss =
            args.action === "dismiss_candidate" ||
            args.action === "dismiss_candidates";
          const kind = args.kind ?? (isCandidateDismiss ? "material" : undefined);
          if (!kind) {
            throw new Error(
              `action=${args.action} 必须提供 kind（subject、record 或 material）。`,
            );
          }
          const data = {
            action: args.action,
            kind,
            ...(args.id === undefined ? {} : { id: args.id }),
            ...(args.ids === undefined ? {} : { ids: args.ids }),
            ...(args.dismissCandidateIds === undefined
              ? {}
              : { dismissCandidateIds: args.dismissCandidateIds }),
            ...(args.fields === undefined ? {} : { fields: args.fields }),
            ...(args.body === undefined ? {} : { body: args.body }),
            ...(args.filePath === undefined ? {} : { filePath: args.filePath }),
          };
          return {
            json: JSON.stringify(
              await runKnowledgeBase(host, [
                "save",
                ...(await kbArgs(args, exec)),
                "--data",
                JSON.stringify(data),
              ]),
            ),
          };
        },
      }),
    ),
  );
  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: "seal_kb_ingest",
        description:
          "只读入库多格式企业材料（Word/PDF/图片/表格/文本或本地目录）生成待分类候选，返回 batchId、sourceType、计数、skipped（如有）与首批候选 ID。",
        parameters: {
          ...commonParameters,
          files: {
            type: "array",
            items: { type: "string" },
            required: true,
            description:
              "非空本地文件或文件夹绝对路径数组（支持 .doc/.docx/.pdf/图片/.xlsx/.xls/.ods/.csv/.tsv/.txt/.md 及目录递归；原件只读）。",
          },
          limit: {
            type: "integer",
            description: "首批返回候选 ID 上限（1–100，默认 20）。",
          },
        },
        output,
        async execute(
          args: Common & { files: string[]; limit?: number },
          exec,
        ) {
          if (
            !Array.isArray(args.files) ||
            !args.files.length ||
            args.files.some((file) => typeof file !== "string")
          )
            throw new Error(
              "files 必须为非空文件或文件夹路径列表；请至少传入 1 个路径。",
            );
          const values = [
            "ingest",
            ...(await kbArgs(args, exec)),
            "--files",
            JSON.stringify(args.files),
          ];
          if (args.limit !== undefined)
            values.push("--limit", String(args.limit));
          return { json: JSON.stringify(await runKnowledgeBase(host, values)) };
        },
      }),
    ),
  );
}
