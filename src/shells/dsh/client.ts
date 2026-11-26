import { clientStyle } from "./client-style.js";
import { zh, en } from "./client-locale.js";
import { ReviewNavigation } from "../../workbench/navigation.js";
import {
  dirtyBuffers,
  editBuffer,
  type EditBuffer,
  type ReviewItem,
} from "../../workbench/review.js";
import {
  buildBidStartupPrompt,
  formatProjectSubtitle,
  type RequirementRowView,
  type RequirementsViewModel,
} from "../../workbench/requirements.js";
import {
  buildKbClassifyPrompt,
  createInlineDeleteController,
  formatCandidateLocation,
  formatCandidatePreviewBody,
  formatDeleteBatchNotice,
  formatHealthIssueMessage,
  importToggleState,
  isSubjectReady,
  kbFieldLabel,
  nextSelectedVaultId,
  shouldShowReferenceDateHint,
  unverifiedBadgeTone,
} from "../../workbench/knowledge.js";
import {
  addOutlineNode,
  canonicalOutlineDigest,
  deleteOutlineNode,
  indentOutlineNode,
  moveOutlineNode,
  outdentOutlineNode,
  updateOutlineNode,
  type OutlineConfirmationStatus,
  type OutlineDocument,
  type OutlineEvidenceBinding,
  type OutlineNode,
  type OutlineNodeKind,
  type OutlineState,
} from "../../core/bid/outline.js";
import type { RequirementsState } from "../../core/bid/requirements.js";
import {
  bindEvidenceToNode,
  buildOutlineRevisionPrompt,
  buildOutlineView,
  canDeleteOutlineNode,
  canIndentOutlineNode,
  canMoveOutlineNode,
  canOutdentOutlineNode,
  createOutlineNodeId,
  filterOutlineRows,
  outlineFilterCounts,
  reconcileOutlineSaveResult,
  runOutlineConfirmFlow,
  unbindEvidenceFromNode,
  type OutlineKbRecordSummary,
  type OutlineRowFilter,
  type OutlineRowView,
  type OutlineViewModel,
} from "../../workbench/outline.js";

declare const __SEAL_VERSION__: string;
declare const __SEAL_PACKAGE_NAME__: string;
type DictionaryKey = keyof typeof zh;
interface ReactRuntime {
  createElement(type: unknown, props?: unknown, ...children: unknown[]): any;
  Fragment: unknown;
  useState<T>(
    initial: T | (() => T),
  ): [T, (value: T | ((previous: T) => T)) => void];
  useEffect(effect: () => void | (() => void), dependencies: unknown[]): void;
  useRef<T>(value: T): { current: T };
  useSyncExternalStore<T>(
    subscribe: (notify: () => void) => () => void,
    snapshot: () => T,
  ): T;
}
type HostContext = any;
type AsyncState<T> =
  | { kind: "loading" }
  | { kind: "error"; error: string }
  | { kind: "value"; value: T };
type OutlineSummaryOverview = {
  kind: "missing" | "error" | "value";
  reason?: string;
  confirmationStatus: OutlineConfirmationStatus;
  confirmedAt: string | null;
  totalNodes: number;
  includedNodes: number;
  excludedNodes: number;
  missingMaterials: number;
  needsReviewMaterials: number;
  uncoveredRequirements: number;
  c17Gaps: number;
  volumeCount: number;
  changesCount?: number;
};
type OutlineGetResponse =
  | { kind: "not_project" }
  | {
      projectKind: "project";
      projectId: string;
      project: ReviewState["project"];
      vaultName: string | null;
      revision: string;
      binding: { sessionId?: string; workspaceId?: string } | null;
      outline: OutlineState;
      view: OutlineViewModel;
      kbRecords: OutlineKbRecordSummary[];
      materials: string[];
      requirements: RequirementsState;
    };
type ReviewState = {
  kind: "project" | "not_project";
  projectId: string;
  project: {
    name: string;
    vaultId: string | null;
    deadline: string;
    workflowMode?: "outline_first" | "direct";
    drafts: string[];
    tenders?: Array<{ copy: string }>;
  };
  vaultName?: string | null;
  revision: string;
  ready: boolean;
  blockingCounts: Record<string, number>;
  outlineSummary?: OutlineSummaryOverview;
  limitations: string[];
  groups: Array<{
    id: string;
    count: number;
    totalCount: number;
    page: number;
    nextPage: number | null;
    items: ReviewItem[];
    sections: Array<{ key: string; label: string; count: number }>;
    activeSection: string | null;
  }>;
  exported: { files: string[]; stale: boolean } | null;
};
interface Overview {
  projects: Array<{
    id: string;
    root: string;
    project?: ReviewState["project"];
    vaultName?: string | null;
    counts?: Record<string, number>;
    outlineSummary?: OutlineSummaryOverview;
    binding?: { sessionId?: string; workspaceId?: string };
    error?: string;
  }>;
  vaults: Array<{
    vaultId: string;
    name?: string;
    creditCode?: string;
    recordCount?: number;
    evidenceCount?: number;
    materialCount?: number;
    expiring?: number;
    unknown?: number;
    unverified?: number;
    pendingCandidateCount?: number;
    subjectName?: string;
    subjectVerified?: boolean;
    error?: string;
  }>;
  environment?: {
    platform: string;
    pdfEngine: "builtin-pdfium" | "poppler";
    libreOffice: { available: boolean; binaryPath: string | null };
  };
}
const NS = "seal",
  PANEL_ID = "seal",
  PACKAGE_NAME =
    typeof __SEAL_PACKAGE_NAME__ === "string"
      ? __SEAL_PACKAGE_NAME__
      : "seal-dsh",
  TAB_ID = PACKAGE_NAME;
const currentWindow = window as unknown as {
  __ModuleLoader__: { load(module: unknown): void };
  __DSH_HOST_PATHS__?: { pathFor(file: File): string };
};

currentWindow.__ModuleLoader__.load({
  id: PACKAGE_NAME,
  factory(require: (name: string) => unknown) {
    const React = require("react") as ReactRuntime;
    const h = React.createElement;
    return {
      inject: [
        "slots",
        "locale",
        "layout",
        "sidebarRight",
        "sidebarRightTabs",
        "sessions",
        "workspaces",
        "uiWorkspace",
        "commandUi",
      ],
      apply(ctx: HostContext) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }));
        const t = ctx.locale.bind(NS) as (key: DictionaryKey) => string;
        const hasStoredEdits = (prefix = "seal:buffers:") =>
          (prefix === "seal:buffers:" &&
            sessionStorage.getItem("seal:outline-dirty") === "1") ||
          Object.keys(sessionStorage)
            .filter((key) => key.startsWith(prefix))
            .some((key) => {
              try {
                return dirtyBuffers(JSON.parse(sessionStorage.getItem(key)!));
              } catch {
                return false;
              }
            });
        const navigate = (operation: () => void) => {
          if (!hasStoredEdits() || window.confirm(t("leave"))) operation();
        };
        const openGlobalOutlineEditor = (
          projectId: string,
          focusNodeId?: string,
        ) => {
          try {
            sessionStorage.setItem("seal:outline-project-id", projectId);
            sessionStorage.setItem("seal:global-tab", "outline");
            if (focusNodeId) {
              sessionStorage.setItem("seal:outline-focus-node", focusNodeId);
            } else {
              sessionStorage.removeItem("seal:outline-focus-node");
            }
          } catch {
            /* Ignore storage errors. */
          }
          window.dispatchEvent(
            new CustomEvent("seal:open-outline", {
              detail: { projectId, focusNodeId },
            }),
          );
          ctx.layout.selectPanel(PANEL_ID);
        };
        function outlineStatusMeta(summary?: OutlineSummaryOverview) {
          if (!summary || summary.kind === "missing") {
            return {
              label: t("outlineStatusMissing"),
              className: "seal-badge",
            };
          }
          if (summary.kind === "error") {
            return {
              label: t("outlineStatusError"),
              className: "seal-badge seal-badge-error",
            };
          }
          if (summary.confirmationStatus === "invalid_signature") {
            return {
              label: t("outlineStatusInvalidSig"),
              className: "seal-badge seal-badge-error",
            };
          }
          if (summary.confirmationStatus === "confirmed") {
            return {
              label: t("outlineStatusConfirmed"),
              className: "seal-badge seal-badge-ok",
            };
          }
          if (summary.confirmationStatus === "stale") {
            return {
              label: t("outlineStatusStale"),
              className: "seal-badge seal-badge-warn",
            };
          }
          const parts = [
            t("outlineStatusUnconfirmed"),
            `${summary.includedNodes} ${t("outlineStatsNodes")}`,
          ];
          if (summary.missingMaterials > 0) {
            parts.push(`${summary.missingMaterials} ${t("outlineMissingMatShort")}`);
          }
          return {
            label: parts.join(" · "),
            className: "seal-badge seal-badge-info",
          };
        }

        async function api<T = any>(
          operation: string,
          values: Record<string, unknown> = {},
          signal?: AbortSignal,
        ): Promise<T> {
          const response = await fetch("/api/seal/action", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...values, operation }),
            signal,
          });
          const result = await response.json();
          if (!response.ok)
            throw new Error(result.error ?? `${response.status}`);
          return result as T;
        }
        function useResource<T>(
          load: (signal: AbortSignal) => Promise<T>,
          dependencies: unknown[],
        ) {
          const [state, setState] = React.useState<AsyncState<T>>({
            kind: "loading",
          });
          const [revision, setRevision] = React.useState(0);
          const dependencyKey = JSON.stringify(dependencies);
          const previousDependencies = React.useRef(dependencyKey);
          React.useEffect(() => {
            const controller = new AbortController();
            if (previousDependencies.current !== dependencyKey) {
              previousDependencies.current = dependencyKey;
              setState({ kind: "loading" });
            }
            load(controller.signal).then(
              (value) => {
                if (!controller.signal.aborted)
                  setState({ kind: "value", value });
              },
              (error) => {
                if (!controller.signal.aborted)
                  setState({
                    kind: "error",
                    error: String(error.message ?? error),
                  });
              },
            );
            return () => controller.abort();
          }, [...dependencies, revision]);
          return { state, reload: () => setRevision((value) => value + 1) };
        }
        function useAction() {
          const [busy, setBusy] = React.useState(false),
            [error, setError] = React.useState(""),
            [notice, setNotice] = React.useState("");
          return {
            busy,
            error,
            notice,
            run: async (
              operation: () => Promise<unknown>,
              success?: string,
            ) => {
              if (busy) return;
              setBusy(true);
              setError("");
              setNotice("");
              try {
                await operation();
                if (success) setNotice(success);
              } catch (error) {
                setError(
                  error instanceof Error ? error.message : String(error),
                );
              } finally {
                setBusy(false);
              }
            },
          };
        }
        function actionStatus(action: ReturnType<typeof useAction>) {
          return h(
            React.Fragment,
            null,
            action.busy &&
              h("p", { role: "status", className: "seal-muted" }, t("loading")),
            action.error &&
              h("p", { role: "alert", className: "seal-error" }, action.error),
            action.notice &&
              h(
                "p",
                { role: "status", className: "seal-notice" },
                action.notice,
              ),
          );
        }
        function resourceStatus<T>(resource: {
          state: AsyncState<T>;
          reload(): void;
        }) {
          if (resource.state.kind === "loading")
            return h(
              "p",
              { role: "status", className: "seal-muted" },
              t("loading"),
            );
          if (resource.state.kind === "error")
            return h(
              "div",
              { role: "alert", className: "seal-error" },
              h("p", null, resource.state.error),
              h("button", { onClick: resource.reload }, t("retry")),
            );
          return null;
        }
        function useInlineDelete() {
          const [state, setState] = React.useState(() => ({
            armedKey: null as string | null,
            busy: false,
            error: "",
          }));
          const controllerRef = React.useRef<ReturnType<
            typeof createInlineDeleteController
          > | null>(null);
          if (!controllerRef.current) {
            controllerRef.current = createInlineDeleteController(setState);
          }
          const controller = controllerRef.current;
          return {
            targetKey: state.armedKey,
            busy: state.busy,
            error: state.error,
            open: (key: string) => controller.arm(key),
            close: () => controller.cancel(),
            reset: () => controller.reset(),
            confirm: (key: string, operation: () => Promise<void>) =>
              controller.confirm(key, operation),
          };
        }
        function renderDeleteConfirm(props: {
          active: boolean;
          prompt: string;
          busy: boolean;
          error: string;
          onConfirm(): void;
          onCancel(): void;
        }) {
          if (!props.active) return null;
          return h(
            "div",
            {
              className: "seal-confirm-inline",
              role: "region",
              "aria-label": t("confirmDelete"),
            },
            h("span", { className: "seal-confirm-inline-text" }, props.prompt),
            h(
              "span",
              { className: "seal-confirm-inline-note" },
              t("deleteWarningCopyOnly"),
            ),
            h(
              "div",
              { className: "seal-row" },
              h(
                "button",
                {
                  type: "button",
                  className: "seal-btn-danger-solid seal-btn-sm",
                  disabled: props.busy,
                  onClick: props.onConfirm,
                },
                props.busy ? t("deleting") : t("confirmDelete"),
              ),
              h(
                "button",
                {
                  type: "button",
                  className: "seal-btn-sm",
                  disabled: props.busy,
                  onClick: props.onCancel,
                },
                t("cancelDelete"),
              ),
            ),
            props.error &&
              h(
                "p",
                {
                  className: "seal-error",
                  role: "alert",
                  style: { margin: 0 },
                },
                props.error,
              ),
          );
        }
        function useBuffers(storageKey: string) {
          const read = (): Record<string, EditBuffer> => {
            try {
              return JSON.parse(sessionStorage.getItem(storageKey) ?? "{}");
            } catch {
              return {};
            }
          };
          const [state, setState] = React.useState(() => ({
            key: storageKey,
            buffers: read(),
          }));
          const buffers = state.key === storageKey ? state.buffers : read();
          if (state.key !== storageKey) setState({ key: storageKey, buffers });
          const setBuffers = (
            value:
              | Record<string, EditBuffer>
              | ((
                  previous: Record<string, EditBuffer>,
                ) => Record<string, EditBuffer>),
          ) => {
            const next = typeof value === "function" ? value(buffers) : value;
            // Synchronous persistence also covers a host navigation in this event turn.
            sessionStorage.setItem(storageKey, JSON.stringify(next));
            setState({ key: storageKey, buffers: next });
          };
          React.useEffect(() => {
            sessionStorage.setItem(storageKey, JSON.stringify(buffers));
            const warn = (event: BeforeUnloadEvent) => {
              if (dirtyBuffers(buffers)) {
                event.preventDefault();
                event.returnValue = "";
              }
            };
            window.addEventListener("beforeunload", warn);
            return () => window.removeEventListener("beforeunload", warn);
          }, [buffers, storageKey]);
          return { buffers, setBuffers, dirty: dirtyBuffers(buffers) };
        }
        function chooseFiles(
          files: FileList | File[],
          allowAny = false,
        ): { path: string; name: string }[] {
          const bridge = currentWindow.__DSH_HOST_PATHS__;
          if (!bridge) throw new Error(t("bridgeUnavailable"));
          return Array.from(files).map((file) => {
            if (!allowAny && !/\.docx?$/i.test(file.name))
              throw new Error(t("invalidFiles"));
            const path = bridge.pathFor(file);
            if (!path) throw new Error(t("bridgeUnavailable"));
            return { path, name: file.name };
          });
        }
        function FilePicker(props: {
          label: string;
          accept?: string;
          allowAny?: boolean;
          onFiles(files: Array<{ path: string; name: string }>): void;
        }) {
          const [error, setError] = React.useState("");
          const [dragActive, setDragActive] = React.useState(false);
          const inputRef = React.useRef<HTMLInputElement | null>(null);
          const read = (files: FileList | File[]) => {
            try {
              props.onFiles(chooseFiles(files, Boolean(props.allowAny)));
              setError("");
            } catch (error) {
              setError(error instanceof Error ? error.message : String(error));
            }
          };
          const openPicker = () => inputRef.current?.click();
          return h(
            "div",
            {
              className: `seal-drop${dragActive ? " seal-drop-active" : ""}`,
              onClick: openPicker,
              onDragOver: (event: DragEvent) => {
                event.preventDefault();
                if (!dragActive) setDragActive(true);
              },
              onDragLeave: () => setDragActive(false),
              onDrop: (event: DragEvent) => {
                event.preventDefault();
                setDragActive(false);
                if (event.dataTransfer) read(event.dataTransfer.files);
              },
            },
            h("input", {
              ref: inputRef,
              type: "file",
              className: "seal-sr-only",
              "aria-label": props.label,
              ...(props.accept ? { accept: props.accept } : {}),
              multiple: true,
              onClick: (event: MouseEvent) => event.stopPropagation(),
              onChange: (event: any) => read(event.target.files),
            }),
            h(
              "div",
              { className: "seal-drop-body" },
              h(
                "div",
                { className: "seal-drop-lead" },
                h(
                  "svg",
                  {
                    className: "seal-drop-icon",
                    viewBox: "0 0 24 24",
                    width: 20,
                    height: 20,
                    fill: "none",
                    stroke: "currentColor",
                    strokeWidth: 1.6,
                    "aria-hidden": true,
                  },
                  h("path", {
                    d: "M12 16V4m0 0-4 4m4-4 4 4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3",
                  }),
                ),
                h("span", null, props.label),
              ),
              h(
                "button",
                {
                  type: "button",
                  className: "seal-btn-sm",
                  onClick: (event: MouseEvent) => {
                    event.stopPropagation();
                    openPicker();
                  },
                },
                t("chooseFiles"),
              ),
            ),
            error && h("p", { className: "seal-error", role: "alert" }, error),
          );
        }
        async function send(
          sessionId: string,
          text: string,
          signal?: AbortSignal,
        ) {
          const result = await ctx.sessions.using(
            sessionId,
            { source: "controllerOperation", signal },
            async (reference: any) => {
              const binding = await reference.ready;
              return binding.session.prompt(
                [{ type: "text", text }],
                "queue",
                signal,
              );
            },
          );
          if (!result.ok)
            throw new Error(result.error?.message ?? t("unavailable"));
        }
        const reviewNavigation = new ReviewNavigation({
          selectSession: (id) => ctx.uiWorkspace.openSession(id),
          beginNavigation: () => ctx.layout.beginNavigation(),
          openReview: () => ctx.sidebarRight.openTab("seal"),
        });
        const openReview = (sessionId: string) =>
          reviewNavigation.open(sessionId);
        function NavigationCommit() {
          const navigation = React.useSyncExternalStore(
            reviewNavigation.subscribe,
            reviewNavigation.snapshot,
          );
          const sessionId = React.useSyncExternalStore<string | undefined>(
            (listener) => ctx.sidebarRight.mounted.subscribe(listener),
            () => ctx.sidebarRight.mounted.getSnapshot(),
          );
          React.useEffect(() => {
            reviewNavigation.commit(sessionId);
          }, [navigation.request, sessionId]);
          return navigation.error
            ? h(
                "p",
                {
                  role: "alert",
                  className: "seal-ui seal-error",
                  style: { pointerEvents: "auto", padding: 12 },
                },
                navigation.error,
              )
            : null;
        }
        async function renameWorkspaceDisplay(
          workspace: { workspaceId: string; title?: string },
          desiredTitle: string | null | undefined,
          fallbackId?: string,
        ) {
          const title = desiredTitle?.trim();
          if (!title || typeof ctx.workspaces.rename !== "function") return;
          if (workspace.title === title) return;
          try {
            await ctx.workspaces.rename(workspace.workspaceId, title);
          } catch {
            if (!fallbackId) return;
            try {
              await ctx.workspaces.rename(
                workspace.workspaceId,
                `${title} · ${fallbackId.slice(-6)}`,
              );
            } catch {
              /* Ignore display-title conflicts so session launch never fails. */
            }
          }
        }
        async function associate(
          project: {
            id: string;
            root: string;
            vaultName?: string | null;
            project?: {
              name: string;
              deadline: string;
              vaultId: string | null;
              tenders?: Array<{ copy: string }>;
            };
          },
          prompt: boolean,
        ) {
          const workspace = await ctx.workspaces.create({ path: project.root });
          await renameWorkspaceDisplay(
            workspace,
            project.project?.name,
            project.id,
          );
          const sessionId = await ctx.sessions.create({
            workspaceId: workspace.workspaceId,
            cwd: project.root,
          });
          await api("bind", {
            projectId: project.id,
            workspaceId: workspace.workspaceId,
            sessionId,
          });
          if (prompt) {
            const text = project.project
              ? buildBidStartupPrompt({
                  ...project.project,
                  vaultName: project.vaultName ?? null,
                  tenders: project.project.tenders ?? [],
                })
              : t("startup");
            await send(sessionId, text);
          }
          await openReview(sessionId);
        }
        function Icon() {
          return h(
            "svg",
            {
              viewBox: "0 0 24 24",
              width: 20,
              height: 20,
              fill: "none",
              stroke: "currentColor",
              strokeWidth: 1.5,
              "aria-hidden": true,
            },
            h("path", { d: "M6 3h8l4 4v14H6zM14 3v5h4M9 13l2 2 4-5" }),
          );
        }

        function Start(props: {
          overview: Overview;
          reload(): void;
          onGoKnowledge(): void;
        }) {
          const [name, setName] = React.useState(""),
            [deadline, setDeadline] = React.useState(""),
            [vault, setVault] = React.useState<string | null | undefined>(
              undefined,
            );
          const [files, setFiles] = React.useState<
            Array<{ path: string; name: string }>
          >([]);
          const [filePath, setFilePath] = React.useState("");
          const [workflowMode, setWorkflowMode] = React.useState<
            "outline_first" | "direct"
          >("outline_first");
          const action = useAction();
          const healthyVaults = props.overview.vaults.filter(
            (item) => !item.error,
          );
          React.useEffect(() => {
            if (vault === undefined) {
              setVault(
                healthyVaults.length === 1 ? healthyVaults[0].vaultId : null,
              );
            }
          }, [props.overview.vaults, vault]);
          const selectedVault = vault
            ? healthyVaults.find((item) => item.vaultId === vault)
            : undefined;
          const targets = [
            ...files.map((file) => file.path),
            ...(filePath.trim() ? [filePath.trim()] : []),
          ];
          const submit = () =>
            action.run(async () => {
              const created = await api("create", {
                name,
                deadline,
                vaultId: vault,
                files: targets,
                workflowMode,
              });
              setFiles([]);
              setFilePath("");
              props.reload();
              await associate(
                {
                  ...created,
                  vaultName: created.vaultName ?? selectedVault?.name ?? null,
                },
                true,
              );
            });
          return h(
            "form",
            {
              className: "seal-stack",
              onSubmit: (event: Event) => {
                event.preventDefault();
                void submit();
              },
            },
            healthyVaults.length === 0 &&
              h(
                "div",
                { className: "seal-callout" },
                h(
                  "div",
                  { className: "seal-callout-body" },
                  h("strong", null, t("startKbCalloutTitle")),
                  h("span", { className: "seal-small" }, t("startKbCalloutDesc")),
                ),
                h(
                  "button",
                  {
                    type: "button",
                    className: "seal-btn-sm",
                    onClick: props.onGoKnowledge,
                  },
                  t("goToKnowledge"),
                ),
              ),
            h(
              "div",
              { className: "seal-grid-2" },
              h(
                "section",
                { className: "seal-card seal-stack" },
                h("h2", null, t("tenderSection")),
                h(FilePicker, {
                  label: t("drop"),
                  accept: ".doc,.docx",
                  onFiles: (selected: typeof files) => {
                    setFiles(selected);
                    if (!name && selected.length)
                      setName(selected[0].name.replace(/\.docx?$/i, ""));
                  },
                }),
                files.length > 0 &&
                  h(
                    "div",
                    { className: "seal-chips" },
                    ...files.map((file, index) =>
                      h(
                        "span",
                        { key: `${file.path}:${index}`, className: "seal-chip" },
                        h(
                          "span",
                          { className: "seal-chip-text", title: file.name },
                          file.name,
                        ),
                        h(
                          "button",
                          {
                            type: "button",
                            className: "seal-chip-remove",
                            "aria-label": file.name,
                            onClick: () =>
                              setFiles((previous) =>
                                previous.filter((_, idx) => idx !== index),
                              ),
                          },
                          "×",
                        ),
                      ),
                    ),
                  ),
                h(
                  "label",
                  null,
                  t("filePathLabel"),
                  h("input", {
                    value: filePath,
                    placeholder: t("filePathPlaceholder"),
                    onChange: (event: any) => setFilePath(event.target.value),
                  }),
                ),
              ),
              h(
                "section",
                { className: "seal-card seal-stack" },
                h("h2", null, t("projectSection")),
                h(
                  "label",
                  null,
                  t("projectName"),
                  h("input", {
                    value: name,
                    required: true,
                    onChange: (event: any) => setName(event.target.value),
                  }),
                ),
                h(
                  "label",
                  null,
                  t("deadline"),
                  h("input", {
                    type: "date",
                    value: deadline,
                    required: true,
                    onChange: (event: any) => setDeadline(event.target.value),
                  }),
                ),
                h(
                  "label",
                  null,
                  t("vault"),
                    h(
                      "select",
                      {
                        value: vault ?? "",
                        onChange: (event: any) =>
                          setVault(event.target.value || null),
                      },
                      h("option", { value: "" }, t("noVaultOption")),
                      ...healthyVaults.map((item) =>
                        h(
                          "option",
                          { key: item.vaultId, value: item.vaultId },
                          item.name,
                        ),
                      ),
                    ),
                ),
                selectedVault
                  ? h(
                      "div",
                      { className: "seal-card-compact seal-stack-sm" },
                      h(
                        "div",
                        { className: "seal-row seal-between" },
                        h(
                          "span",
                          { className: "seal-small" },
                          `${t("vaultReadiness")} · ${selectedVault.subjectName ?? selectedVault.name}`,
                        ),
                        h(
                          "span",
                          {
                            className: `seal-badge ${selectedVault.subjectVerified ? "seal-badge-ok" : "seal-badge-warn"}`,
                          },
                          t(
                            selectedVault.subjectVerified
                              ? "subjectReady"
                              : "subjectNeedsWork",
                          ),
                        ),
                      ),
                      h(
                        "div",
                        { className: "seal-row" },
                        h(
                          "span",
                          { className: "seal-badge" },
                          `${t("summaryEvidence")} ${selectedVault.evidenceCount ?? 0}`,
                        ),
                        h(
                          "span",
                          { className: "seal-badge" },
                          `${t("summaryMaterials")} ${selectedVault.materialCount ?? 0}`,
                        ),
                        (() => {
                          const tone = unverifiedBadgeTone({
                            recordCount: selectedVault.recordCount ?? 0,
                            subjectVerified: Boolean(
                              selectedVault.subjectVerified,
                            ),
                            unverified: selectedVault.unverified ?? 0,
                          });
                          const badgeClass =
                            tone === "warn"
                              ? "seal-badge seal-badge-warn"
                              : tone === "ok"
                                ? "seal-badge seal-badge-ok"
                                : "seal-badge";
                          return h(
                            "span",
                            { className: badgeClass },
                            `${t("unverified")} ${selectedVault.unverified ?? 0}`,
                          );
                        })(),
                        (selectedVault.pendingCandidateCount ?? 0) > 0 &&
                          h(
                            "span",
                            { className: "seal-badge seal-badge-info" },
                            `${t("pendingCount")} ${selectedVault.pendingCandidateCount}`,
                          ),
                      ),
                      ((selectedVault.unverified ?? 0) > 0 ||
                        (selectedVault.pendingCandidateCount ?? 0) > 0) &&
                        h(
                          "span",
                          { className: "seal-small" },
                          t("vaultHasUnverifiedHint"),
                        ),
                    )
                  : h("p", { className: "seal-small" }, t("noVault")),
                h(
                  "div",
                  { className: "seal-stack-sm" },
                  h("span", { className: "seal-small" }, t("workflowModeLabel")),
                  h(
                    "div",
                    { className: "seal-mode-group", role: "radiogroup", "aria-label": t("workflowModeLabel") },
                    ...(
                      [
                        [
                          "outline_first",
                          t("workflowModeOutlineFirst"),
                          t("workflowModeOutlineFirstDesc"),
                        ],
                        [
                          "direct",
                          t("workflowModeDirect"),
                          t("workflowModeDirectDesc"),
                        ],
                      ] as const
                    ).map(([mode, title, desc]) =>
                      h(
                        "button",
                        {
                          key: mode,
                          type: "button",
                          className: "seal-mode-option",
                          role: "radio",
                          "aria-checked": workflowMode === mode,
                          "aria-pressed": workflowMode === mode,
                          onClick: () => setWorkflowMode(mode),
                        },
                        h("strong", null, title),
                        h("span", { className: "seal-small" }, desc),
                      ),
                    ),
                  ),
                ),
              ),
            ),
            h(
              "div",
              { className: "seal-row" },
              h(
                "button",
                {
                  type: "submit",
                  className: "seal-btn-primary",
                  disabled: action.busy || !targets.length || !name || !deadline,
                },
                t("create"),
              ),
            ),
            actionStatus(action),
          );
        }

        function ProjectList(props: {
          overview: Overview;
          reload(): void;
          onGoStart(): void;
          onOpenOutline(projectId: string): void;
        }) {
          const action = useAction();
          const projectDelete = useInlineDelete();
          const sessions = React.useSyncExternalStore(
            (listener) => ctx.sessions.list.subscribe(listener),
            () => ctx.sessions.list.getSnapshot(),
          ) as any;
          const workspaces = React.useSyncExternalStore(
            (listener) => ctx.workspaces.list.subscribe(listener),
            () => ctx.workspaces.list.getSnapshot(),
          ) as any;
          const vaultNameById = new Map(
            props.overview.vaults.map((item) => [
              item.vaultId,
              item.name ?? item.vaultId,
            ]),
          );
          if (!props.overview.projects.length) {
            return h(
              "div",
              { className: "seal-empty-hero" },
              h("h2", null, t("noProjectsTitle")),
              h("p", { className: "seal-muted" }, t("noProjectsHint")),
              h(
                "button",
                {
                  type: "button",
                  className: "seal-btn-primary",
                  onClick: props.onGoStart,
                },
                t("goToStart"),
              ),
            );
          }
          return h(
            "div",
            { className: "seal-stack" },
            ...props.overview.projects.map((project) => {
              const sessionId = project.binding?.sessionId;
              const archived =
                sessionId && workspaces.archivedSessionIds.includes(sessionId);
              const session = sessionId ? sessions.byId[sessionId] : undefined;
              const mismatch = session && session.cwd !== project.root;
              const available =
                sessionId &&
                sessions.ids.includes(sessionId) &&
                !archived &&
                !mismatch;
              const nonZeroCounts = project.counts
                ? Object.entries(project.counts).filter(([, count]) => count > 0)
                : [];
              const linkedVaultName = project.project?.vaultId
                ? (project.vaultName ??
                  vaultNameById.get(project.project.vaultId) ??
                  t("missingVault"))
                : t("noVaultMode");
              return h(
                "article",
                { key: project.id, className: "seal-card seal-stack-sm" },
                h(
                  "div",
                  { className: "seal-row seal-between" },
                  h("h3", null, project.project?.name ?? project.id),
                  !project.error &&
                    h(
                      "span",
                      {
                        className: `seal-badge ${nonZeroCounts.length === 0 ? "seal-badge-ok" : "seal-badge-warn"}`,
                      },
                      nonZeroCounts.length === 0
                        ? t("noIssues")
                        : `${nonZeroCounts.reduce((sum, [, count]) => sum + count, 0)} ${t("count")}`,
                    ),
                ),
                project.error
                  ? h(
                      React.Fragment,
                      null,
                      h("p", { className: "seal-error" }, project.error),
                      h(
                        "div",
                        { className: "seal-row" },
                        h(
                          "button",
                          {
                            type: "button",
                            className: "seal-btn-danger seal-btn-sm",
                            disabled: action.busy || projectDelete.busy,
                            onClick: () => projectDelete.open(project.id),
                          },
                          t("deleteProject"),
                        ),
                      ),
                    )
                  : h(
                      React.Fragment,
                      null,
                      h(
                        "div",
                        { className: "seal-row" },
                        h(
                          "span",
                          { className: "seal-badge" },
                          `${t("deadline")} ${project.project!.deadline}`,
                        ),
                        h(
                          "span",
                          { className: "seal-badge" },
                          `${t("linkedVault")}: ${linkedVaultName}`,
                        ),
                        (project.outlineSummary?.kind !== "missing" ||
                          project.project?.workflowMode !== "direct") &&
                          (() => {
                            const meta = outlineStatusMeta(project.outlineSummary);
                            return h(
                              "span",
                              { className: meta.className },
                              meta.label,
                            );
                          })(),
                        ...nonZeroCounts.map(([code, count]) =>
                          h(
                            "span",
                            { key: code, className: "seal-badge seal-badge-warn" },
                            `${t(code as DictionaryKey)} ${count}`,
                          ),
                        ),
                      ),
                      archived &&
                        h("p", { className: "seal-muted" }, t("archived")),
                      mismatch &&
                        h("p", { className: "seal-error" }, t("mismatch")),
                      !session &&
                        sessions.phase === "ready" &&
                        h(
                          "p",
                          { className: "seal-muted" },
                          t("missingSession"),
                        ),
                      h(
                        "div",
                        { className: "seal-row" },
                        h(
                          "button",
                          {
                            className: available ? "seal-btn-primary" : "",
                            disabled:
                              action.busy ||
                              projectDelete.busy ||
                              sessions.phase !== "ready" ||
                              !!archived,
                            onClick: () =>
                              action.run(async () => {
                                if (available) await openReview(sessionId);
                                else {
                                  await associate(
                                    {
                                      ...project,
                                      vaultName:
                                        project.vaultName ??
                                        (project.project?.vaultId
                                          ? (vaultNameById.get(
                                              project.project.vaultId,
                                            ) ?? null)
                                          : null),
                                    },
                                    true,
                                  );
                                  props.reload();
                                }
                              }),
                          },
                          available ? t("continue") : t("newSession"),
                        ),
                        h(
                          "button",
                          {
                            type: "button",
                            className: "seal-btn-sm",
                            disabled: action.busy || projectDelete.busy,
                            onClick: () => props.onOpenOutline(project.id),
                          },
                          t("editOutline"),
                        ),
                        h(
                          "button",
                          {
                            type: "button",
                            className: "seal-btn-danger seal-btn-sm",
                            disabled: action.busy || projectDelete.busy,
                            onClick: () => projectDelete.open(project.id),
                          },
                          t("deleteProject"),
                        ),
                      ),
                    ),
                renderDeleteConfirm({
                  active: projectDelete.targetKey === project.id,
                  prompt: `${t("deleteProjectPrompt")}${project.project?.name ? `（${project.project.name}）` : ""}`,
                  busy: projectDelete.busy,
                  error: projectDelete.error,
                  onCancel: projectDelete.close,
                  onConfirm: () =>
                    void projectDelete.confirm(project.id, async () => {
                      await api("delete_project", { projectId: project.id });
                      if (sessionId) {
                        try {
                          sessionStorage.removeItem(`seal:buffers:${sessionId}`);
                          sessionStorage.removeItem(`seal:req-cover:${sessionId}`);
                        } catch {
                          /* Ignore storage errors. */
                        }
                      }
                      props.reload();
                    }),
                }),
              );
            }),
            actionStatus(action),
          );
        }

        function ReviewRow(props: {
          row: ReviewItem;
          review: ReviewState;
          sessionId: string;
          buffers: Record<string, EditBuffer>;
          setBuffers(
            value:
              | Record<string, EditBuffer>
              | ((
                  previous: Record<string, EditBuffer>,
                ) => Record<string, EditBuffer>),
          ): void;
          reload(): void;
        }) {
          const { row, review } = props,
            action = useAction();
          const [editing, setEditing] = React.useState(
              () => !!props.buffers[row.key],
            ),
            [asking, setAsking] = React.useState(false),
            [request, setRequest] = React.useState(""),
            [reason, setReason] = React.useState("");
          const buffer = props.buffers[row.key];
          const execute = (kind: string) =>
            action.run(async () => {
              await api("act", {
                projectId: review.projectId,
                revision: review.revision,
                keys: [row.key],
                action: kind,
                reason,
              });
              props.reload();
            }, t("processed"));
          const beginEdit = () => {
            props.setBuffers((previous) => ({
              ...previous,
              [row.key]: editBuffer(
                previous[row.key],
                review.revision,
                row.value,
              ),
            }));
            setEditing(true);
          };
          return h(
            "article",
            { className: "seal-entry", "data-seal-item": row.key },
            h(
              "div",
              { className: "seal-small" },
              row.draft,
              row.address ? ` · ${row.address}` : "",
              buffer && buffer.value !== buffer.original
                ? ` · ${t("edited")}`
                : "",
            ),
            row.before &&
              h(
                "div",
                null,
                h("span", { className: "seal-small" }, t("before")),
                h("pre", null, h("del", null, row.before)),
              ),
            row.value &&
              h(
                "div",
                null,
                h("span", { className: "seal-small" }, t("current")),
                h("pre", null, row.value),
              ),
            row.reason && h("p", { className: "seal-muted" }, row.reason),
            row.actions.includes("review") &&
              row.code === "C02" &&
              h(
                "label",
                null,
                t("requestReason"),
                h("input", {
                  value: reason,
                  onChange: (event: any) => setReason(event.target.value),
                }),
              ),
            h(
              "div",
              { className: "seal-row" },
              row.actions.includes("confirm") &&
                h(
                  "button",
                  {
                    disabled: action.busy,
                    onClick: () =>
                      execute(
                        row.actions.includes("accept")
                          ? "confirm_accept"
                          : "confirm",
                      ),
                  },
                  t(row.actions.includes("accept") ? "combined" : "confirm"),
                ),
              row.actions.includes("accept") &&
                !row.actions.includes("confirm") &&
                h(
                  "button",
                  { disabled: action.busy, onClick: () => execute("accept") },
                  t("accept"),
                ),
              row.actions.includes("review") &&
                h(
                  "button",
                  {
                    disabled:
                      action.busy || (row.code === "C02" && !reason.trim()),
                    onClick: () => execute("review"),
                  },
                  t("acknowledge"),
                ),
              row.actions.includes("modify") &&
                h("button", { onClick: beginEdit }, t("modify")),
              row.code === "C17" &&
                h(
                  "button",
                  {
                    type: "button",
                    onClick: () =>
                      openGlobalOutlineEditor(review.projectId, row.nodeId),
                  },
                  t("editOutline"),
                ),
              h(
                "button",
                {
                  onClick: () => {
                    if (row.code === "C17" && !asking && !request.trim()) {
                      setRequest(
                        `请按已确认大纲核对并补齐${row.title ? `「${row.title}」` : "该大纲项"}（${row.reason}），完成后重新运行 seal_check。`,
                      );
                    }
                    setAsking((value) => !value);
                  },
                },
                t(row.code === "C17" ? "outlineAiFixC17" : "ai"),
              ),
            ),
            editing &&
              buffer &&
              h(
                "div",
                { className: "seal-stack seal-divider" },
                h(
                  "label",
                  null,
                  t("current"),
                  h("textarea", {
                    value: buffer.value,
                    onChange: (event: any) =>
                      props.setBuffers((previous) => ({
                        ...previous,
                        [row.key]: { ...buffer, value: event.target.value },
                      })),
                  }),
                ),
                buffer.baseRevision !== review.revision &&
                  h(
                    "div",
                    { className: "seal-error" },
                    t("conflict"),
                    h(
                      "button",
                      {
                        onClick: () =>
                          props.setBuffers((previous) => ({
                            ...previous,
                            [row.key]: {
                              ...buffer,
                              baseRevision: review.revision,
                            },
                          })),
                      },
                      t("recheck"),
                    ),
                  ),
                h(
                  "div",
                  { className: "seal-row" },
                  h(
                    "button",
                    {
                      disabled:
                        action.busy || buffer.baseRevision !== review.revision,
                      onClick: () =>
                        action.run(async () => {
                          await api("act", {
                            projectId: review.projectId,
                            revision: buffer.baseRevision,
                            keys: [row.key],
                            action: "modify",
                            value: buffer.value,
                          });
                          props.setBuffers((previous) => {
                            const next = { ...previous };
                            delete next[row.key];
                            return next;
                          });
                          setEditing(false);
                          props.reload();
                        }, t("processed")),
                    },
                    t("save"),
                  ),
                  h(
                    "button",
                    { onClick: () => setEditing(false) },
                    t("cancel"),
                  ),
                ),
              ),
            asking &&
              h(
                "div",
                { className: "seal-stack seal-divider" },
                h(
                  "label",
                  null,
                  t("aiRequest"),
                  h("textarea", {
                    value: request,
                    onChange: (event: any) => setRequest(event.target.value),
                  }),
                ),
                h(
                  "button",
                  {
                    disabled: action.busy || !request.trim(),
                    onClick: () =>
                      action.run(async () => {
                        await send(
                          props.sessionId,
                          `${row.draft} · ${row.address || row.id}\n${row.reason}\n${t("current")}：${row.value}\n${request}`,
                        );
                        setRequest("");
                        setAsking(false);
                      }, t("sent")),
                  },
                  t("send"),
                ),
              ),
            actionStatus(action),
          );
        }

        function RequirementCard(props: {
          row: RequirementRowView;
          projectId: string;
          revision: string;
          drafts: string[];
          sessionId: string;
          coverDrafts: Record<string, { draft: string; address: string }>;
          setCoverDrafts(
            updater: (
              previous: Record<string, { draft: string; address: string }>,
            ) => Record<string, { draft: string; address: string }>,
          ): void;
          reload(): void;
        }) {
          const { row } = props;
          const action = useAction();
          const [asking, setAsking] = React.useState(false);
          const [request, setRequest] = React.useState("");
          const saved = props.coverDrafts[row.id];
          const preferredDraft =
            saved?.draft ?? row.coverage.draft ?? row.responses[0]?.draft;
          const selectedDraft =
            preferredDraft && props.drafts.includes(preferredDraft)
              ? preferredDraft
              : (props.drafts[0] ?? "");
          const selectedAddress =
            saved?.address ??
            row.coverage.address ??
            row.responses[0]?.address ??
            "";
          const updateInput = (patch: Partial<{ draft: string; address: string }>) =>
            props.setCoverDrafts((previous) => ({
              ...previous,
              [row.id]: {
                draft: patch.draft ?? selectedDraft,
                address: patch.address ?? selectedAddress,
              },
            }));
          return h(
            "article",
            { className: "seal-entry", "data-seal-requirement": row.id },
            h(
              "div",
              { className: "seal-row" },
              h("strong", null, row.id),
              h("span", { className: "seal-badge" }, row.kind),
              h(
                "span",
                { className: "seal-badge" },
                t(row.mustRespond ? "mustRespond" : "optionalRespond"),
              ),
              row.points !== undefined &&
                h(
                  "span",
                  { className: "seal-small" },
                  `${t("points")} ${row.points}`,
                ),
            ),
            h(
              "div",
              { className: "seal-row" },
              h(
                "span",
                {
                  className: `seal-badge ${row.c14Issues.length ? "seal-badge-error" : "seal-badge-ok"}`,
                },
                row.c14Issues.length ? t("quoteFail") : t("quoteOk"),
              ),
              row.coverage.status === "covered" &&
                h(
                  "span",
                  { className: "seal-badge seal-badge-ok" },
                  `${t("coverageCovered")}（${row.coverage.draft} · ${row.coverage.address}）`,
                ),
              row.coverage.status === "expired" &&
                h(
                  "span",
                  { className: "seal-badge seal-badge-error" },
                  t("coverageExpired"),
                ),
              row.c12Issues.length > 0
                ? h(
                    "span",
                    { className: "seal-badge seal-badge-error" },
                    `${t("coverageGap")}：${row.c12Issues.join("；")}`,
                  )
                : row.mustRespond && row.coverage.status !== "covered"
                  ? h(
                      "span",
                      { className: "seal-badge seal-badge-ok" },
                      t("coverageOk"),
                    )
                  : null,
            ),
            h("p", null, row.text),
            h(
              "div",
              { className: "seal-small" },
              `${t("quote")} · ${row.source.file} · ${row.source.address}`,
            ),
            h("pre", null, row.quote),
            ...row.c14Issues.map((issue, index) =>
              h("p", { key: index, className: "seal-error" }, issue),
            ),
            h(
              "div",
              { className: "seal-small" },
              `${t("responses")}：`,
              row.responses.length
                ? row.responses
                    .map((response) => `${response.draft} · ${response.address}`)
                    .join("；")
                : t("noResponses"),
            ),
            row.evidence &&
              row.evidence.length > 0 &&
              h(
                "div",
                { className: "seal-small" },
                `${t("evidence")}：${row.evidence.join("、")}`,
              ),
            props.drafts.length === 0
              ? h("p", { className: "seal-small" }, t("needDraftForCover"))
              : h(
                  "div",
                  { className: "seal-stack" },
                  h(
                    "div",
                    { className: "seal-row" },
                    h(
                      "select",
                      {
                        "aria-label": t("coverageDraft"),
                        value: selectedDraft,
                        onChange: (event: any) =>
                          updateInput({ draft: event.target.value }),
                      },
                      ...props.drafts.map((draft) =>
                        h("option", { key: draft, value: draft }, draft),
                      ),
                    ),
                    h("input", {
                      "aria-label": t("coverageAddress"),
                      placeholder: t("coverageAddressHint"),
                      value: selectedAddress,
                      onChange: (event: any) =>
                        updateInput({ address: event.target.value }),
                    }),
                  ),
                  h(
                    "div",
                    { className: "seal-row" },
                    h(
                      "button",
                      {
                        disabled:
                          action.busy ||
                          !selectedDraft ||
                          !selectedAddress.trim(),
                        onClick: () =>
                          action.run(async () => {
                            await api("cover", {
                              projectId: props.projectId,
                              expectedRevision: props.revision,
                              id: row.id,
                              draft: selectedDraft,
                              address: selectedAddress.trim(),
                            });
                            props.setCoverDrafts((previous) => {
                              const next = { ...previous };
                              delete next[row.id];
                              return next;
                            });
                            props.reload();
                          }, t("processed")),
                      },
                      t("markCovered"),
                    ),
                    h(
                      "button",
                      { onClick: () => setAsking((value) => !value) },
                      t("ai"),
                    ),
                  ),
                ),
            props.drafts.length === 0 &&
              h(
                "div",
                { className: "seal-row" },
                h(
                  "button",
                  { onClick: () => setAsking((value) => !value) },
                  t("ai"),
                ),
              ),
            asking &&
              h(
                "div",
                { className: "seal-stack seal-divider" },
                h(
                  "label",
                  null,
                  t("aiRequest"),
                  h("textarea", {
                    value: request,
                    onChange: (event: any) => setRequest(event.target.value),
                  }),
                ),
                h(
                  "button",
                  {
                    disabled: action.busy || !request.trim(),
                    onClick: () =>
                      action.run(async () => {
                        await send(
                          props.sessionId,
                          `${row.id} · ${row.kind}\n${row.text}\n${t("quote")}：${row.source.file} · ${row.source.address}\n${request}`,
                        );
                        setRequest("");
                        setAsking(false);
                      }, t("sent")),
                  },
                  t("send"),
                ),
              ),
            actionStatus(action),
          );
        }

        function RequirementsTab(props: {
          projectId: string;
          reviewRevision: string;
          sessionId: string;
          reloadReview(): void;
        }) {
          const [offset, setOffset] = React.useState(0);
          const storageKey = `seal:req-cover:${props.sessionId}`;
          const readStored = (): Record<
            string,
            { draft: string; address: string }
          > => {
            try {
              return JSON.parse(sessionStorage.getItem(storageKey) ?? "{}");
            } catch {
              return {};
            }
          };
          const [coverState, setCoverState] = React.useState(() => ({
            key: storageKey,
            values: readStored(),
          }));
          React.useEffect(() => {
            setCoverState((previous) =>
              previous.key === storageKey
                ? previous
                : { key: storageKey, values: readStored() },
            );
          }, [storageKey]);
          const coverDrafts =
            coverState.key === storageKey ? coverState.values : readStored();
          const setCoverDrafts = (
            updater: (
              previous: Record<string, { draft: string; address: string }>,
            ) => Record<string, { draft: string; address: string }>,
          ) => {
            const next = updater(coverDrafts);
            try {
              sessionStorage.setItem(storageKey, JSON.stringify(next));
            } catch {
              /* Ignore storage quota errors while retaining in-memory input. */
            }
            setCoverState({ key: storageKey, values: next });
          };
          const resource = useResource<
            RequirementsViewModel & { kind: string; revision?: string }
          >(
            (signal) =>
              api(
                "requirements",
                { projectId: props.projectId, offset, limit: 25 },
                signal,
              ),
            [props.projectId, offset, props.reviewRevision],
          );
          if (resource.state.kind !== "value") return resourceStatus(resource);
          const data = resource.state.value;
          if (data.kind === "missing")
            return h("p", { className: "seal-muted" }, t("requirementsMissing"));
          if (data.kind === "error")
            return h(
              "div",
              { role: "alert", className: "seal-error" },
              h("p", null, data.reason),
              h("button", { onClick: resource.reload }, t("retry")),
            );
          return h(
            "div",
            { className: "seal-stack" },
            h(
              "p",
              { className: "seal-small" },
              `${t("total")} ${data.summary.total} · ${t("mustRespond")} ${data.summary.mustRespond} · ${t("coverageGap")} ${data.summary.c12Gaps} · ${t("quoteFail")} ${data.summary.c14Errors} · ${t("coveredCount")} ${data.summary.covered}`,
            ),
            !data.items.length &&
              h("p", { className: "seal-muted" }, t("empty")),
            ...data.items.map((row) =>
              h(RequirementCard, {
                key: row.id,
                row,
                projectId: props.projectId,
                revision: data.revision ?? props.reviewRevision,
                drafts: data.drafts,
                sessionId: props.sessionId,
                coverDrafts,
                setCoverDrafts,
                reload: () => {
                  resource.reload();
                  props.reloadReview();
                },
              }),
            ),
            h(
              "div",
              { className: "seal-row" },
              h(
                "button",
                {
                  disabled: offset === 0,
                  onClick: () => setOffset((value) => Math.max(0, value - 25)),
                },
                t("previous"),
              ),
              h(
                "span",
                { className: "seal-small" },
                `${Math.floor(offset / 25) + 1}`,
              ),
              h(
                "button",
                {
                  disabled: data.nextOffset === null,
                  onClick: () => setOffset(data.nextOffset!),
                },
                t("next"),
              ),
            ),
          );
        }

        function OutlineQuickTab(props: {
          projectId: string;
          reviewRevision: string;
          hasDrafts: boolean;
          sessionId: string;
          dirty: boolean;
          reloadReview(): void;
        }) {
          const action = useAction();
          const [confirmMissing, setConfirmMissing] = React.useState(false);
          const resource = useResource<OutlineGetResponse>(
            (signal) =>
              api("outline_get", { projectId: props.projectId }, signal),
            [props.projectId, props.reviewRevision],
          );
          React.useEffect(() => {
            setConfirmMissing(false);
          }, [props.projectId, props.reviewRevision]);
          if (resource.state.kind !== "value") return resourceStatus(resource);
          const data = resource.state.value;
          if ("kind" in data && data.kind === "not_project") {
            return h("p", { className: "seal-muted" }, t("noProject"));
          }
          const payload = data as Extract<
            OutlineGetResponse,
            { projectKind: "project" }
          >;
          const view = payload.view;
          const summaryMeta = outlineStatusMeta({
            kind: payload.outline.kind,
            confirmationStatus: view.confirmationStatus,
            confirmedAt: view.confirmedAt,
            ...view.summary,
          });
          const canConfirm =
            view.kind === "value" &&
            view.summary.includedNodes > 0 &&
            view.confirmationStatus !== "confirmed";
          const executeConfirm = () =>
            action.run(async () => {
              const res = await api<{
                confirmed: boolean;
                digest: string;
                confirmedAt: string;
                prompt: string;
              }>("outline_confirm", {
                projectId: props.projectId,
                expectedRevision: payload.revision,
              });
              setConfirmMissing(false);
              await send(props.sessionId, res.prompt);
              resource.reload();
              props.reloadReview();
            }, t("sent"));

          if (view.kind === "missing") {
            return h(
              "div",
              { className: "seal-stack" },
              h("p", { className: "seal-muted" }, t("outlineNoOutlineYet")),
              h(
                "div",
                { className: "seal-row" },
                h(
                  "button",
                  {
                    type: "button",
                    className: "seal-btn-sm",
                    onClick: () => {
                      if (!props.dirty || window.confirm(t("leave"))) {
                        openGlobalOutlineEditor(props.projectId);
                      }
                    },
                  },
                  t("outlineOpenFull"),
                ),
              ),
            );
          }

          if (view.kind === "error") {
            return h(
              "div",
              { className: "seal-stack" },
              h("p", { className: "seal-error", role: "alert" }, view.reason),
              h(
                "button",
                {
                  type: "button",
                  className: "seal-btn-sm",
                  onClick: () => {
                    if (!props.dirty || window.confirm(t("leave"))) {
                      openGlobalOutlineEditor(props.projectId);
                    }
                  },
                },
                t("outlineOpenFull"),
              ),
            );
          }

          return h(
            "div",
            { className: "seal-stack" },
            h(
              "div",
              { className: "seal-row seal-between" },
              h("span", { className: summaryMeta.className }, summaryMeta.label),
              h(
                "span",
                { className: "seal-small" },
                `${view.summary.volumeCount} ${t("outlineVolumes")}`,
              ),
            ),
            h(
              "div",
              { className: "seal-row" },
              h(
                "span",
                { className: "seal-badge" },
                `${t("outlineStatsNodes")} ${view.summary.includedNodes}`,
              ),
              h(
                "span",
                {
                  className: `seal-badge ${view.summary.missingMaterials > 0 ? "seal-badge-warn" : "seal-badge-ok"}`,
                },
                `${t("outlineStatsMissing")} ${view.summary.missingMaterials}`,
              ),
              h(
                "span",
                {
                  className: `seal-badge ${view.summary.uncoveredRequirements > 0 ? "seal-badge-warn" : "seal-badge-ok"}`,
                },
                `${t("outlineStatsUncovered")} ${view.summary.uncoveredRequirements}`,
              ),
            ),
            h(
              "div",
              { className: "seal-outline-compact-tree" },
              ...view.rows.map((row) =>
                h(
                  "div",
                  {
                    key: row.id,
                    className: `seal-outline-compact-row${row.included ? "" : " seal-outline-row-excluded"}`,
                    style: { paddingLeft: `${8 + row.depth * 14}px` },
                  },
                  h(
                    "span",
                    {
                      className: "seal-small",
                      style: {
                        color: row.included
                          ? "var(--dsw-alias-label-primary)"
                          : "var(--dsw-alias-label-tertiary)",
                        textDecoration: row.included ? "none" : "line-through",
                        flex: "1 1 0",
                      },
                    },
                    `${row.number ? `${row.number} ` : ""}${row.title}`,
                  ),
                  h(
                    "div",
                    { className: "seal-row" },
                    row.included &&
                      row.resolvedMaterialStatus === "missing" &&
                      h(
                        "span",
                        { className: "seal-badge seal-badge-warn" },
                        t("outlineMatMissing"),
                      ),
                    row.included &&
                      row.resolvedMaterialStatus === "needs_review" &&
                      h(
                        "span",
                        { className: "seal-badge seal-badge-warn" },
                        t("outlineMatNeedsReview"),
                      ),
                  ),
                ),
              ),
            ),
            h(
              "div",
              { className: "seal-row" },
              h(
                "button",
                {
                  type: "button",
                  className: "seal-btn-sm",
                  disabled: action.busy,
                  onClick: () => {
                    if (!props.dirty || window.confirm(t("leave"))) {
                      openGlobalOutlineEditor(props.projectId);
                    }
                  },
                },
                t("outlineOpenFull"),
              ),
              canConfirm &&
                h(
                  "button",
                  {
                    type: "button",
                    className: "seal-btn-primary seal-btn-sm",
                    disabled: action.busy || props.dirty,
                    onClick: () => {
                      if (view.summary.missingMaterials > 0) {
                        setConfirmMissing(true);
                      } else {
                        void executeConfirm();
                      }
                    },
                  },
                  t(
                    props.hasDrafts
                      ? "outlineReconfirm"
                      : "outlineConfirmStart",
                  ),
                ),
            ),
            confirmMissing &&
              h(
                "div",
                { className: "seal-confirm-inline", role: "region" },
                h(
                  "span",
                  { className: "seal-confirm-inline-text" },
                  `${t("outlineConfirmMissingWarn")}（${view.summary.missingMaterials} ${t("count")}）`,
                ),
                h(
                  "div",
                  { className: "seal-row" },
                  h(
                    "button",
                    {
                      type: "button",
                      className: "seal-btn-primary seal-btn-sm",
                      disabled: action.busy,
                      onClick: () => void executeConfirm(),
                    },
                    t("outlineConfirmAnyway"),
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      className: "seal-btn-sm",
                      disabled: action.busy,
                      onClick: () => {
                        setConfirmMissing(false);
                        if (!props.dirty || window.confirm(t("leave"))) {
                          openGlobalOutlineEditor(props.projectId);
                        }
                      },
                    },
                    t("outlineGoUpload"),
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      className: "seal-btn-ghost seal-btn-sm",
                      disabled: action.busy,
                      onClick: () => setConfirmMissing(false),
                    },
                    t("cancelDelete"),
                  ),
                ),
              ),
            actionStatus(action),
          );
        }

        function ReviewPanel(props: { sealSessionId: string }) {
          const sessionId = props.sealSessionId;
          const sessions = React.useSyncExternalStore(
            (listener) => ctx.sessions.list.subscribe(listener),
            () => ctx.sessions.list.getSnapshot(),
          ) as any;
          const cwd = sessions.byId[sessionId]?.cwd;
          const [pages, setPages] = React.useState<Record<string, number>>({}),
            [sections, setSections] = React.useState<Record<string, string>>({}),
            [tab, setTab] = React.useState("review");
          const autoSelectedRef = React.useRef<string | null>(null);
          const resource = useResource<ReviewState>(
            (signal) => api("review", { cwd, pages, sections }, signal),
            [cwd, JSON.stringify(pages), JSON.stringify(sections)],
          );
          const { buffers, setBuffers, dirty } = useBuffers(
              `seal:buffers:${sessionId}`,
            ),
            action = useAction();
          const [volume, setVolume] = React.useState(""),
            [preview, setPreview] = React.useState<{
              revision: string;
              pages: Array<{ page: number; file: string }>;
            } | null>(null);
          const review =
            resource.state.kind === "value" ? resource.state.value : null;
          React.useEffect(() => {
            if (
              review?.kind === "project" &&
              review.project.workflowMode !== "direct" &&
              review.project.drafts.length === 0 &&
              review.outlineSummary?.kind === "value" &&
              autoSelectedRef.current !== review.projectId
            ) {
              autoSelectedRef.current = review.projectId;
              setTab("outline");
            }
          }, [review]);
          React.useEffect(() => {
            if (
              review?.kind === "project" &&
              !review.project.drafts.includes(volume)
            )
              setVolume(review.project.drafts[0] ?? "");
          }, [review, volume]);
          React.useEffect(() => {
            if (review?.kind !== "project") return;
            setSections((previous) => {
              let changed = false;
              const next: Record<string, string> = {};
              for (const [groupId, sectionKey] of Object.entries(previous)) {
                const group = review.groups.find((item) => item.id === groupId);
                if (group && group.activeSection === sectionKey) {
                  next[groupId] = sectionKey;
                } else {
                  changed = true;
                }
              }
              return changed ? next : previous;
            });
          }, [review]);
          const goGlobal = () => {
            if (!dirty || window.confirm(t("leave")))
              ctx.layout.selectPanel(PANEL_ID);
          };
          const link = (draft: string, final = false) =>
            `/api/seal/file?${new URLSearchParams({ projectId: review!.projectId, draft, ...(final ? { final: "true" } : {}) })}`;
          return h(
            "section",
            { className: "seal-ui seal-panel" },
            h("style", null, clientStyle),
            h(
              "div",
              { className: "seal-header" },
              h(
                "div",
                { className: "seal-brand" },
                h("h1", null, t("panel")),
              ),
              h(
                "button",
                { className: "seal-btn-sm", onClick: resource.reload },
                t("refresh"),
              ),
            ),
            dirty &&
              h("p", { className: "seal-notice", role: "status" }, t("dirty")),
            resourceStatus(resource),
            review?.kind === "not_project" &&
              h(
                "div",
                { className: "seal-card seal-stack" },
                h("p", { className: "seal-muted" }, t("noProject")),
                h(
                  "button",
                  { className: "seal-btn-primary", onClick: goGlobal },
                  t("openGlobal"),
                ),
              ),
            review?.kind === "project" &&
              h(
                React.Fragment,
                null,
                h("h2", null, review.project.name),
                h(
                  "p",
                  { className: "seal-small" },
                  formatProjectSubtitle({
                    deadline: review.project.deadline,
                    vaultId: review.project.vaultId,
                    vaultName: review.vaultName,
                    noVaultLabel: t("noVaultMode"),
                    missingVaultLabel: t("missingVault"),
                  }),
                ),
                review.project.workflowMode !== "direct" &&
                  review.project.drafts.length === 0 &&
                  h(
                    "div",
                    {
                      className:
                        review.outlineSummary?.confirmationStatus === "stale"
                          ? "seal-callout seal-callout-warn"
                          : "seal-callout",
                      style: { marginBottom: 10 },
                    },
                    h(
                      "div",
                      { className: "seal-callout-body" },
                      h(
                        "strong",
                        { className: "seal-small" },
                        outlineStatusMeta(review.outlineSummary).label,
                      ),
                      h(
                        "span",
                        { className: "seal-small" },
                        review.outlineSummary?.kind === "missing"
                          ? t("outlineGuidePending")
                          : review.outlineSummary?.confirmationStatus ===
                              "confirmed"
                            ? t("outlineGuideConfirmed")
                            : review.outlineSummary?.confirmationStatus ===
                                "stale"
                              ? t("outlineGuideStale")
                              : t("outlineGuideReady"),
                      ),
                    ),
                    review.outlineSummary?.kind === "value" &&
                      h(
                        "button",
                        {
                          type: "button",
                          className: "seal-btn-sm",
                          onClick: () => {
                            if (tab !== "outline") setTab("outline");
                            else if (!dirty || window.confirm(t("leave"))) {
                              openGlobalOutlineEditor(review.projectId);
                            }
                          },
                        },
                        tab === "outline"
                          ? t("outlineOpenFull")
                          : t("outlineTab"),
                      ),
                  ),
                h(
                  "div",
                  { className: "seal-banner" },
                  h(
                    "div",
                    { className: "seal-row seal-between" },
                    h(
                      "span",
                      {
                        className: `seal-badge ${review.ready ? "seal-badge-ok" : "seal-badge-warn"}`,
                      },
                      t(review.ready ? "ready" : "blocked"),
                    ),
                    h(
                      "button",
                      {
                        className: "seal-btn-primary seal-btn-sm",
                        disabled: !review.ready || action.busy || dirty,
                        onClick: () =>
                          action.run(async () => {
                            await api("finalize", {
                              projectId: review.projectId,
                              revision: review.revision,
                            });
                            resource.reload();
                          }, t("processed")),
                      },
                      t("export"),
                    ),
                  ),
                  !review.project.drafts.length &&
                    h("p", { className: "seal-small" }, t("noDrafts")),
                  Object.values(review.blockingCounts).some((count) => count > 0) &&
                    h(
                      "div",
                      { className: "seal-row" },
                      ...Object.entries(review.blockingCounts)
                        .filter(([, count]) => count > 0)
                        .map(([code, count]) =>
                          h(
                            "span",
                            {
                              key: code,
                              className: "seal-badge seal-badge-warn",
                            },
                            `${t(code as DictionaryKey)} ${count}`,
                          ),
                        ),
                    ),
                  ...review.limitations.map((limitation, index) =>
                    h("p", { key: index, className: "seal-error" }, limitation),
                  ),
                  review.exported &&
                    h(
                      "p",
                      { className: "seal-small" },
                      t(review.exported.stale ? "stale" : "currentFinal"),
                    ),
                ),
                h(
                  "div",
                  { className: "seal-row seal-divider" },
                  ...review.project.drafts.map((draft) =>
                    h(
                      "a",
                      {
                        key: draft,
                        className: "seal-link",
                        href: link(draft),
                        download: `${draft}.docx`,
                      },
                      `${t("downloadDraft")} · ${draft}`,
                    ),
                  ),
                ),
                review.exported &&
                  !review.exported.stale &&
                  h(
                    "div",
                    { className: "seal-row" },
                    ...review.exported.files.map((draft) =>
                      h(
                        "a",
                        {
                          key: draft,
                          className: "seal-link",
                          href: link(draft, true),
                          download: `${draft}.docx`,
                        },
                        `${t("downloadFinal")} · ${draft}`,
                      ),
                    ),
                  ),
                h(
                  "nav",
                  { className: "seal-tabs" },
                  ...[
                    ["outline", t("outlineTab")],
                    ["review", t("review")],
                    ["requirements", t("requirements")],
                    ["preview", t("preview")],
                  ].map(([key, label]) =>
                    h(
                      "button",
                      {
                        key,
                        "aria-selected": tab === key,
                        onClick: () => navigate(() => setTab(key)),
                      },
                      label,
                    ),
                  ),
                ),
                tab === "outline" &&
                  h(OutlineQuickTab, {
                    projectId: review.projectId,
                    reviewRevision: review.revision,
                    hasDrafts: review.project.drafts.length > 0,
                    sessionId,
                    dirty,
                    reloadReview: resource.reload,
                  }),
                tab === "review" &&
                  h(
                    "div",
                    null,
                    !review.groups.length &&
                      h("p", { className: "seal-muted" }, t("noIssues")),
                    ...review.groups.map((group) => {
                      const selectSection = (sectionKey: string | null) => {
                        setPages((previous) => ({
                          ...previous,
                          [group.id]: 0,
                        }));
                        setSections((previous) => {
                          const next = { ...previous };
                          if (sectionKey === null) delete next[group.id];
                          else next[group.id] = sectionKey;
                          return next;
                        });
                      };
                      const runBatch = (
                        batchAction: "confirm" | "accept" | "review",
                        section: string | null,
                      ) =>
                        action.run(async () => {
                          await api("act", {
                            projectId: review.projectId,
                            revision: review.revision,
                            group: group.id,
                            ...(section === null ? {} : { section }),
                            action: batchAction,
                          });
                          if (section !== null) {
                            setPages((previous) => ({
                              ...previous,
                              [group.id]: 0,
                            }));
                            setSections((previous) => {
                              const next = { ...previous };
                              delete next[group.id];
                              return next;
                            });
                          }
                          resource.reload();
                        });
                      const totalCount = group.totalCount ?? group.count;
                      return h(
                        "details",
                        { key: group.id, open: true },
                        h(
                          "summary",
                          null,
                          group.id.startsWith("pending:")
                            ? group.id.slice(8)
                            : t(group.id as DictionaryKey),
                          group.activeSection
                            ? ` · ${group.count}/${totalCount}`
                            : ` · ${group.count}`,
                        ),
                        group.sections.length > 1 &&
                          h(
                            "div",
                            {
                              className: "seal-section-bar",
                              role: "group",
                            },
                            h(
                              "button",
                              {
                                type: "button",
                                className: "seal-section-chip",
                                "aria-pressed": group.activeSection === null,
                                onClick: () => selectSection(null),
                              },
                              `${t("allSections")} (${totalCount})`,
                            ),
                            ...group.sections.map((sec) =>
                              h(
                                "button",
                                {
                                  key: sec.key,
                                  type: "button",
                                  className: "seal-section-chip",
                                  title: sec.label,
                                  "aria-pressed":
                                    group.activeSection === sec.key,
                                  onClick: () => selectSection(sec.key),
                                },
                                h(
                                  "span",
                                  { className: "seal-section-chip-label" },
                                  sec.label,
                                ),
                                h("span", null, `(${sec.count})`),
                              ),
                            ),
                          ),
                        h(
                          "div",
                          { className: "seal-row" },
                          group.id.startsWith("pending:") &&
                            h(
                              "button",
                              {
                                disabled: action.busy,
                                onClick: () => runBatch("confirm", null),
                              },
                              t("allConfirm"),
                            ),
                          group.id.startsWith("pending:") &&
                            group.activeSection &&
                            h(
                              "button",
                              {
                                disabled: action.busy,
                                onClick: () =>
                                  runBatch("confirm", group.activeSection),
                              },
                              `${t("sectionConfirm")} (${group.count})`,
                            ),
                          group.id === "bracketText" &&
                            h(
                              "button",
                              {
                                disabled: action.busy,
                                onClick: () => runBatch("accept", null),
                              },
                              t("allAccept"),
                            ),
                          group.id === "bracketText" &&
                            group.activeSection &&
                            h(
                              "button",
                              {
                                disabled: action.busy,
                                onClick: () =>
                                  runBatch("accept", group.activeSection),
                              },
                              `${t("sectionAccept")} (${group.count})`,
                            ),
                          group.id === "C03" &&
                            h(
                              "button",
                              {
                                disabled: action.busy,
                                onClick: () => runBatch("review", null),
                              },
                              t("allReview"),
                            ),
                          group.id === "C03" &&
                            group.activeSection &&
                            h(
                              "button",
                              {
                                disabled: action.busy,
                                onClick: () =>
                                  runBatch("review", group.activeSection),
                              },
                              `${t("sectionReview")} (${group.count})`,
                            ),
                        ),
                        ...group.items.map((row) =>
                          h(ReviewRow, {
                            key: row.key,
                            row,
                            review,
                            sessionId,
                            buffers,
                            setBuffers,
                            reload: resource.reload,
                          }),
                        ),
                        h(
                          "div",
                          { className: "seal-row" },
                          h(
                            "button",
                            {
                              disabled: group.page === 0,
                              onClick: () =>
                                setPages((previous) => ({
                                  ...previous,
                                  [group.id]: group.page - 1,
                                })),
                            },
                            t("previous"),
                          ),
                          h(
                            "span",
                            { className: "seal-small" },
                            group.page + 1,
                          ),
                          h(
                            "button",
                            {
                              disabled: group.nextPage === null,
                              onClick: () =>
                                setPages((previous) => ({
                                  ...previous,
                                  [group.id]: group.nextPage!,
                                })),
                            },
                            t("next"),
                          ),
                        ),
                      );
                    }),
                  ),
                tab === "requirements" &&
                  h(RequirementsTab, {
                    projectId: review.projectId,
                    reviewRevision: review.revision,
                    sessionId,
                    reloadReview: resource.reload,
                  }),
                tab === "preview" &&
                  h(
                    "div",
                    { className: "seal-stack" },
                    h(
                      "select",
                      {
                        value: volume,
                        onChange: (event: any) => {
                          setVolume(event.target.value);
                          setPreview(null);
                        },
                        "aria-label": t("preview"),
                      },
                      ...review.project.drafts.map((draft) =>
                        h("option", { key: draft, value: draft }, draft),
                      ),
                    ),
                    h(
                      "button",
                      {
                        disabled: !volume || action.busy,
                        onClick: () =>
                          action.run(async () => {
                            setPreview(
                              await api("preview", {
                                projectId: review.projectId,
                                draft: volume,
                              }),
                            );
                          }),
                      },
                      t("render"),
                    ),
                    preview &&
                      preview.revision !== review.revision &&
                      h("p", { className: "seal-notice" }, t("stale")),
                    preview?.revision === review.revision &&
                      preview.pages.map((page) =>
                        h("img", {
                          key: page.file,
                          className: "seal-preview",
                          loading: "lazy",
                          alt: `${volume} · ${page.page}`,
                          src: `/api/seal/file?${new URLSearchParams({ projectId: review.projectId, preview: page.file })}`,
                        }),
                      ),
                  ),
                actionStatus(action),
              ),
          );
        }

        function KnowledgeDetail(props: {
          vaultId: string;
          kind: string;
          id: string;
          refreshTick: number;
          issues?: Array<{ code: string; kind?: string }>;
          overviewSubjectVerified?: boolean;
          reload(): void;
          onClose?: () => void;
          onLoaded?: (id: string) => void;
        }) {
          const uiLocale = t("localeCode") === "en" ? "en" : "zh";
          const detailKey = `${props.vaultId}:${props.kind}:${props.id}`;
          const [detailState, setDetailState] = React.useState<{
            key: string;
            status: "loading" | "error" | "value";
            value: any;
            error: string;
          }>({
            key: detailKey,
            status: "loading",
            value: null,
            error: "",
          });
          const [reloadTick, setReloadTick] = React.useState(0);
          const detailReqRef = React.useRef(0);
          const currentState =
            detailState.key === detailKey
              ? detailState
              : {
                  key: detailKey,
                  status: "loading" as const,
                  value: null,
                  error: "",
                };
          const reloadDetail = () => setReloadTick((value) => value + 1);
          React.useEffect(() => {
            const controller = new AbortController();
            const reqId = ++detailReqRef.current;
            setDetailState({
              key: detailKey,
              status: "loading",
              value: null,
              error: "",
            });
            api(
              "kb",
              {
                action: "detail",
                vaultId: props.vaultId,
                kind: props.kind,
                id: props.id,
              },
              controller.signal,
            ).then(
              (fetched) => {
                if (
                  controller.signal.aborted ||
                  detailReqRef.current !== reqId ||
                  fetched?.entry?.id !== props.id
                ) {
                  return;
                }
                setDetailState({
                  key: detailKey,
                  status: "value",
                  value: fetched,
                  error: "",
                });
                props.onLoaded?.(props.id);
              },
              (error) => {
                if (
                  controller.signal.aborted ||
                  detailReqRef.current !== reqId
                ) {
                  return;
                }
                setDetailState({
                  key: detailKey,
                  status: "error",
                  value: null,
                  error: String(error?.message ?? error),
                });
              },
            );
            return () => controller.abort();
          }, [detailKey, props.refreshTick, reloadTick]);

          const action = useAction(),
            entryDelete = useInlineDelete(),
            { buffers, setBuffers, dirty } = useBuffers(
              `seal:buffers:kb:${props.vaultId}:${props.kind}:${props.id}`,
            );
          React.useEffect(() => {
            entryDelete.reset();
          }, [detailKey]);
          const [editing, setEditing] = React.useState(() =>
            hasStoredEdits(
              `seal:buffers:kb:${props.vaultId}:${props.kind}:${props.id}`,
            ),
          );
          if (currentState.status === "loading")
            return h(
              "p",
              { role: "status", className: "seal-muted" },
              t("loading"),
            );
          if (currentState.status === "error")
            return h(
              "div",
              { role: "alert", className: "seal-error" },
              h("p", null, currentState.error),
              h("button", { onClick: reloadDetail }, t("retry")),
            );
          if (
            !currentState.value?.entry ||
            currentState.value.entry.id !== props.id
          ) {
            return h(
              "p",
              { role: "status", className: "seal-muted" },
              t("loading"),
            );
          }
          const { entry, revision } = currentState.value;
          const privateNames = new Set([
            "verified",
            "verifiedAt",
            "verifiedFields",
          ]);
          const fields: Record<string, unknown> = Object.fromEntries(
            Object.entries(entry.fields).filter(
              ([key]) => !privateNames.has(key) && !key.startsWith("__seal"),
            ),
          );
          const subjectOrder = [
            "legalName",
            "creditCode",
            "legalRepresentative",
            "registeredCapital",
            "establishedOn",
            "address",
            "phone",
            "email",
            "bankName",
            "bankAccount",
            "forbiddenAffiliates",
            "thirdPartyHolders",
          ];
          if (props.kind === "subject") {
            for (const key of subjectOrder) {
              if (!(key in fields)) {
                fields[key] = [
                  "forbiddenAffiliates",
                  "thirdPartyHolders",
                ].includes(key)
                  ? []
                  : "";
              }
            }
          }
          const display = (value: unknown) =>
            Array.isArray(value) ? value.join("\n") : String(value ?? "");
          const keyFor = (field: string) => `${props.id}:${field}`;
          const setField = (field: string, value: string, original: string) =>
            setBuffers((previous) => ({
              ...previous,
              [keyFor(field)]: {
                ...editBuffer(previous[keyFor(field)], revision, original),
                value,
              },
            }));
          const fileNames = Array.isArray(entry.fields.files)
            ? entry.fields.files
            : [];
          const fieldEntries = Object.entries(fields).filter(
            ([key]) => key !== "files",
          );
          const filledSubjectKeys =
            props.kind === "subject"
              ? fieldEntries
                  .filter(([, value]) => display(value).trim().length > 0)
                  .map(([key]) => key)
              : [];
          const unverifiedSubjectKeys = filledSubjectKeys.filter(
            (key) => !entry.verifiedFields.includes(key),
          );
          const hasAnySubjectValue = filledSubjectKeys.length > 0;
          const saveChanges = () =>
            action.run(async () => {
              const changed = Object.values(buffers).filter(
                (buffer) => buffer.value !== buffer.original,
              );
              if (changed.some((buffer) => buffer.baseRevision !== revision))
                throw new Error(t("conflict"));
              const nextFields = Object.fromEntries(
                Object.entries(fields).map(([key, value]) => {
                  const buffer = buffers[keyFor(key)];
                  return [
                    key,
                    buffer
                      ? Array.isArray(value)
                        ? buffer.value.split("\n").filter(Boolean)
                        : buffer.value
                      : value,
                  ];
                }),
              );
              await api("kb", {
                action: "save",
                vaultId: props.vaultId,
                revision,
                data: {
                  action: "update",
                  kind: props.kind,
                  id: props.id,
                  fields: nextFields,
                  body: buffers[keyFor("body")]?.value ?? entry.body,
                },
              });
              setBuffers({});
              setEditing(false);
              reloadDetail();
              props.reload();
            }, t("processed"));

          const verifyAction = (verifyFields: string[]) =>
            action.run(async () => {
              await api("kb", {
                action: "verify",
                vaultId: props.vaultId,
                kind: props.kind,
                id: props.id,
                fields: verifyFields,
                revision,
              });
              reloadDetail();
              props.reload();
            });

          const subjectReady =
            props.kind === "subject" &&
            isSubjectReady({
              subject: entry,
              issues: props.issues,
            }) &&
            props.overviewSubjectVerified !== false;
          const headerStatusBadge =
            props.kind === "material"
              ? h("span", { className: "seal-badge" }, t("verificationNotRequired"))
              : props.kind === "subject"
                ? subjectReady
                  ? h(
                      "span",
                      { className: "seal-badge seal-badge-ok" },
                      t("subjectReady"),
                    )
                  : hasAnySubjectValue
                    ? h(
                        "span",
                        { className: "seal-badge seal-badge-warn" },
                        unverifiedSubjectKeys.length > 0
                          ? `${t("unverified")} ${unverifiedSubjectKeys.length}`
                          : t("subjectNeedsWork"),
                      )
                    : h(
                        "span",
                        { className: "seal-badge" },
                        t("subjectEmptyValue"),
                      )
                : h(
                    "span",
                    {
                      className: `seal-badge ${entry.verified ? "seal-badge-ok" : "seal-badge-warn"}`,
                    },
                    t(entry.verified ? "verified" : "unverified"),
                  );

          return h(
            "section",
            {
              className: props.onClose
                ? "seal-card seal-detail-card seal-stack"
                : "seal-card seal-stack",
            },
            h(
              "div",
              { className: "seal-row seal-between" },
              h(
                "div",
                { className: "seal-row" },
                h(
                  "h2",
                  { style: { margin: 0 } },
                  entry.fields.title ?? entry.fields.legalName ?? t("subject"),
                ),
                headerStatusBadge,
              ),
              h(
                "div",
                { className: "seal-row" },
                props.kind === "subject" &&
                  !editing &&
                  unverifiedSubjectKeys.length > 0 &&
                  h(
                    "button",
                    {
                      className: "seal-btn-primary seal-btn-sm",
                      disabled: action.busy || dirty,
                      onClick: () => verifyAction(unverifiedSubjectKeys),
                    },
                    t("verifyAllSubject"),
                  ),
                props.kind === "record" &&
                  !editing &&
                  !entry.verified &&
                  h(
                    "button",
                    {
                      className: "seal-btn-primary seal-btn-sm",
                      disabled: action.busy || entryDelete.busy || dirty,
                      onClick: () => verifyAction([]),
                    },
                    t("verify"),
                  ),
                h(
                  "button",
                  {
                    className: "seal-btn-sm",
                    disabled: entryDelete.busy,
                    onClick: () => setEditing((value) => !value),
                  },
                  t(editing ? "cancel" : "modify"),
                ),
                (props.kind === "record" || props.kind === "material") &&
                  h(
                    "button",
                    {
                      type: "button",
                      className: "seal-btn-danger seal-btn-sm",
                      disabled: action.busy || entryDelete.busy,
                      onClick: () => entryDelete.open(detailKey),
                    },
                    t("deleteEntry"),
                  ),
                h(
                  "button",
                  {
                    className: "seal-btn-ghost seal-btn-sm",
                    disabled: entryDelete.busy,
                    onClick: reloadDetail,
                  },
                  t("refresh"),
                ),
                props.onClose &&
                  h(
                    "button",
                    {
                      type: "button",
                      className: "seal-btn-sm",
                      disabled: entryDelete.busy,
                      onClick: props.onClose,
                    },
                    t("closeDetail"),
                  ),
              ),
            ),
            (props.kind === "record" || props.kind === "material") &&
              renderDeleteConfirm({
                active: entryDelete.targetKey === detailKey,
                prompt: `${t("deleteEntryPrompt")}${entry.fields?.title ? `（${entry.fields.title}）` : ""}`,
                busy: entryDelete.busy,
                error: entryDelete.error,
                onCancel: entryDelete.close,
                onConfirm: () =>
                  void entryDelete.confirm(detailKey, async () => {
                    await api("kb", {
                      action: "delete_entry",
                      vaultId: props.vaultId,
                      kind: props.kind,
                      id: props.id,
                      revision,
                    });
                    setBuffers({});
                    setEditing(false);
                    props.onClose?.();
                    props.reload();
                  }),
              }),
            ...entry.issues.map((issue: string, index: number) =>
              h("p", { key: index, className: "seal-error" }, issue),
            ),
            dirty && h("p", { className: "seal-notice" }, t("dirty")),
            props.kind === "subject" &&
              !hasAnySubjectValue &&
              !editing &&
              h(
                "div",
                { className: "seal-callout" },
                h("span", { className: "seal-small" }, t("subjectEmptyHint")),
              ),
            props.kind === "subject"
              ? h(
                  "div",
                  { className: "seal-subject-grid" },
                  ...fieldEntries.map(([key, value]) => {
                    const textValue = display(value);
                    const hasValue = textValue.trim().length > 0;
                    const isVerified = entry.verifiedFields.includes(key);
                    const labelText =
                      key in zh
                        ? t(key as DictionaryKey)
                        : kbFieldLabel(key, uiLocale);
                    return h(
                      "div",
                      { key, className: "seal-subject-field" },
                      h(
                        "div",
                        { className: "seal-row seal-between" },
                        h("span", { className: "seal-small" }, labelText),
                        hasValue &&
                          h(
                            "span",
                            {
                              className: `seal-badge ${isVerified ? "seal-badge-ok" : "seal-badge-warn"}`,
                            },
                            t(isVerified ? "verified" : "unverified"),
                          ),
                      ),
                      editing
                        ? Array.isArray(value)
                          ? h("textarea", {
                              "aria-label": labelText,
                              value: buffers[keyFor(key)]?.value ?? textValue,
                              onChange: (event: any) =>
                                setField(key, event.target.value, textValue),
                            })
                          : h("input", {
                              "aria-label": labelText,
                              value: buffers[keyFor(key)]?.value ?? textValue,
                              onChange: (event: any) =>
                                setField(key, event.target.value, textValue),
                            })
                        : h(
                            "div",
                            {
                              className: hasValue ? "" : "seal-muted",
                              style: { overflowWrap: "anywhere", whiteSpace: "pre-wrap" },
                            },
                            hasValue ? textValue : t("subjectEmptyValue"),
                          ),
                      !editing &&
                        hasValue &&
                        !isVerified &&
                        h(
                          "div",
                          { className: "seal-row" },
                          h(
                            "button",
                            {
                              className: "seal-btn-sm",
                              disabled: action.busy || dirty,
                              onClick: () => verifyAction([key]),
                            },
                            t("verify"),
                          ),
                        ),
                    );
                  }),
                )
              : h(
                  "dl",
                  { className: "seal-fields" },
                  ...fieldEntries.flatMap(([key, value]) => {
                    const labelText =
                      key in zh
                        ? t(key as DictionaryKey)
                        : kbFieldLabel(key, uiLocale);
                    return [
                      h("dt", { key: `${key}:label` }, labelText),
                      h(
                        "dd",
                        { key },
                        editing
                          ? h("textarea", {
                              "aria-label": labelText,
                              value: buffers[keyFor(key)]?.value ?? display(value),
                              onChange: (event: any) =>
                                setField(key, event.target.value, display(value)),
                            })
                          : display(value) || t("subjectEmptyValue"),
                      ),
                    ];
                  }),
                ),
            (editing || entry.body.trim().length > 0) &&
              h(
                "label",
                null,
                t("body"),
                editing
                  ? h("textarea", {
                      value: buffers[keyFor("body")]?.value ?? entry.body,
                      onChange: (event: any) =>
                        setField("body", event.target.value, entry.body),
                    })
                  : h(
                      "pre",
                      {
                        style: {
                          whiteSpace: "pre-wrap",
                          overflowWrap: "anywhere",
                          font: "inherit",
                          margin: 0,
                        },
                      },
                      entry.body,
                    ),
              ),
            editing &&
              h(
                "div",
                { className: "seal-row" },
                h(
                  "button",
                  {
                    className: "seal-btn-primary",
                    disabled: action.busy || !dirty,
                    onClick: saveChanges,
                  },
                  t("save"),
                ),
                h(
                  "button",
                  { onClick: () => setEditing(false) },
                  t("cancel"),
                ),
              ),
            dirty &&
              Object.values(buffers).some(
                (buffer) => buffer.baseRevision !== revision,
              ) &&
              h(
                "button",
                {
                  onClick: () =>
                    setBuffers((previous) =>
                      Object.fromEntries(
                        Object.entries(previous).map(([key, buffer]) => [
                          key,
                          { ...buffer, baseRevision: revision },
                        ]),
                      ),
                    ),
                },
                t("recheck"),
              ),
            fileNames.length > 0 &&
              h(
                "div",
                { className: "seal-stack-sm seal-divider" },
                h("h3", null, t("originalFiles")),
                h(
                  "div",
                  { className: "seal-row" },
                  ...fileNames.map((file: string, index: number) => {
                    const href = `/api/seal/kb-file?${new URLSearchParams({ vaultId: props.vaultId, kind: props.kind, id: props.id, index: String(index) })}`;
                    return h(
                      "a",
                      {
                        key: file,
                        className: "seal-link seal-btn-sm",
                        href,
                        target: "_blank",
                        rel: "noreferrer",
                      },
                      `${t("open")} · ${file.split("/").at(-1)}`,
                    );
                  }),
                ),
                h(
                  "div",
                  { className: "seal-thumb-grid" },
                  ...fileNames.map((file: string, index: number) => {
                    if (!/\.(png|jpe?g|gif|bmp|webp|svg)$/i.test(file))
                      return null;
                    const href = `/api/seal/kb-file?${new URLSearchParams({ vaultId: props.vaultId, kind: props.kind, id: props.id, index: String(index) })}`;
                    return h(
                      "a",
                      {
                        key: `img:${file}`,
                        className: "seal-thumb-card",
                        href,
                        target: "_blank",
                        rel: "noreferrer",
                      },
                      h("img", {
                        src: href,
                        className: "seal-thumb-img",
                        loading: "lazy",
                        alt: file.split("/").at(-1) ?? file,
                      }),
                      h("span", null, file.split("/").at(-1)),
                    );
                  }),
                ),
              ),
            actionStatus(action),
          );
        }

        function Knowledge(props: {
          overview: Overview;
          refreshTick: number;
          reload(): void;
        }) {
          const uiLocale = t("localeCode") === "en" ? "en" : "zh";
          const [vaultId, setVaultIdState] = React.useState(() => {
            try {
              return sessionStorage.getItem("seal:kb-vault") ?? "";
            } catch {
              return "";
            }
          });
          const setVaultId = (nextId: string) => {
            try {
              if (nextId) sessionStorage.setItem("seal:kb-vault", nextId);
              else sessionStorage.removeItem("seal:kb-vault");
            } catch {
              /* Ignore storage errors. */
            }
            setVaultIdState(nextId);
          };
          const [subTab, setSubTab] = React.useState<
            "subject" | "evidence" | "materials"
          >("subject");
          const [showCreateVault, setShowCreateVault] = React.useState(false);
          const [showIngest, setShowIngest] = React.useState<boolean | null>(
            null,
          );
          const [name, setName] = React.useState("");
          const [query, setQuery] = React.useState("");
          const [type, setType] = React.useState("");
          const [validity, setValidity] = React.useState("");
          const [verified, setVerified] = React.useState("");
          const [offset, setOffset] = React.useState(0);
          const [issueOffset, setIssueOffset] = React.useState(0);
          const [detail, setDetail] = React.useState<{
            kind: string;
            id: string;
          } | null>(null);
          const detailPanelRef = React.useRef<HTMLDivElement | null>(null);
          const lastScrolledDetailRef = React.useRef<string | null>(null);
          const [files, setFiles] = React.useState<
            Array<{ path: string; name: string }>
          >([]);
          const [ingestPath, setIngestPath] = React.useState("");
          const readStoredSkipped = (targetVaultId: string) => {
            if (!targetVaultId) return [];
            try {
              const raw = sessionStorage.getItem(
                `seal:kb-ingest-skipped:${targetVaultId}`,
              );
              const parsed = raw ? JSON.parse(raw) : [];
              return Array.isArray(parsed) ? parsed : [];
            } catch {
              return [];
            }
          };
          const [skippedState, setSkippedState] = React.useState<{
            vaultId: string;
            items: Array<{ source: string; reason: string }>;
          }>(() => ({ vaultId: "", items: [] }));
          const ingestSkipped =
            skippedState.vaultId === vaultId
              ? skippedState.items
              : readStoredSkipped(vaultId);
          const updateIngestSkipped = (
            targetVaultId: string,
            items: Array<{ source: string; reason: string }>,
          ) => {
            try {
              const key = `seal:kb-ingest-skipped:${targetVaultId}`;
              if (items.length > 0) {
                sessionStorage.setItem(key, JSON.stringify(items));
              } else {
                sessionStorage.removeItem(key);
              }
            } catch {
              /* Ignore storage quota errors while retaining in-memory state. */
            }
            setSkippedState({ vaultId: targetVaultId, items });
          };
          const [openBatchId, setOpenBatchId] = React.useState<string | null>(
            null,
          );
          const [batchPage, setBatchPage] = React.useState<any>(null);
          const [batchAfter, setBatchAfter] = React.useState<string | undefined>(
            undefined,
          );
          const [afterHistory, setAfterHistory] = React.useState<
            Array<string | undefined>
          >([]);
          const [selectedCandidateId, setSelectedCandidateId] = React.useState<
            string | null
          >(null);
          const [candidateDetail, setCandidateDetail] =
            React.useState<any>(null);
          const [candidateLoading, setCandidateLoading] = React.useState(false);
          const [candidateError, setCandidateError] = React.useState("");
          const candidateReqRef = React.useRef(0);
          const vaultDelete = useInlineDelete();
          const batchDelete = useInlineDelete();
          const [batchDeleteNotice, setBatchDeleteNotice] = React.useState("");

          const clearBatchDrawerState = () => {
            setOpenBatchId(null);
            setBatchPage(null);
            setBatchAfter(undefined);
            setAfterHistory([]);
            setSelectedCandidateId(null);
            setCandidateDetail(null);
            setCandidateError("");
            setCandidateLoading(false);
            candidateReqRef.current += 1;
          };

          const scrollDetailIntoView = () => {
            detailPanelRef.current?.scrollIntoView?.({
              behavior: "smooth",
              block: "nearest",
            });
          };
          React.useEffect(() => {
            if (!detail) {
              lastScrolledDetailRef.current = null;
              return;
            }
            const key = `${vaultId}:${detail.kind}:${detail.id}`;
            if (lastScrolledDetailRef.current !== key) {
              lastScrolledDetailRef.current = key;
              scrollDetailIntoView();
            }
          }, [vaultId, detail?.kind, detail?.id]);

          const healthyVaults = props.overview.vaults.filter(
            (item) => !item.error,
          );
          React.useEffect(() => {
            if (!props.overview.vaults.length) {
              if (vaultId) setVaultId("");
              return;
            }
            const exists = props.overview.vaults.some(
              (item) => item.vaultId === vaultId,
            );
            if (!vaultId || !exists) {
              const preferred =
                healthyVaults[0]?.vaultId ?? props.overview.vaults[0].vaultId;
              setVaultId(preferred);
              setOffset(0);
              setIssueOffset(0);
              setDetail(null);
              clearBatchDrawerState();
              setShowIngest(null);
              vaultDelete.reset();
              batchDelete.reset();
            }
          }, [props.overview.vaults, vaultId]);

          const selectedVault = props.overview.vaults.find(
            (item) => item.vaultId === vaultId,
          );
          const catalogKind =
            subTab === "evidence"
              ? "record"
              : subTab === "materials"
                ? "material"
                : undefined;

          const resource = useResource<any>(
            (signal) =>
              vaultId && !selectedVault?.error
                ? api(
                    "kb",
                    {
                      action: "catalog",
                      vaultId,
                      ...(catalogKind ? { kind: catalogKind } : {}),
                      query: subTab === "subject" ? "" : query,
                      type: subTab === "evidence" ? type : "",
                      validity: subTab === "evidence" ? validity : "",
                      verified: subTab === "evidence" ? verified : "",
                      offset,
                      issueOffset,
                    },
                    signal,
                  )
                : Promise.resolve(null),
            [
              vaultId,
              selectedVault?.error ?? "",
              subTab,
              query,
              type,
              validity,
              verified,
              offset,
              issueOffset,
              props.refreshTick,
            ],
          );
          const action = useAction();
          const catalog =
            resource.state.kind === "value" ? resource.state.value : null;

          React.useEffect(() => {
            if (
              catalog &&
              openBatchId &&
              !(catalog.pendingBatches ?? []).some(
                (batch: any) => batch.batchId === openBatchId,
              )
            ) {
              clearBatchDrawerState();
            }
          }, [catalog, openBatchId]);

          const switchVault = (nextVaultId: string) =>
            navigate(() => {
              setVaultId(nextVaultId);
              setSubTab("subject");
              setQuery("");
              setType("");
              setValidity("");
              setVerified("");
              setOffset(0);
              setIssueOffset(0);
              setDetail(null);
              setShowIngest(null);
              setShowCreateVault(false);
              setBatchDeleteNotice("");
              vaultDelete.reset();
              batchDelete.reset();
              clearBatchDrawerState();
            });

          const switchSubTab = (
            nextTab: "subject" | "evidence" | "materials",
          ) =>
            navigate(() => {
              setSubTab(nextTab);
              setOffset(0);
              setDetail(null);
              vaultDelete.reset();
              batchDelete.reset();
            });

          const startClassifySession = async (
            targetBatchId: string,
            vaultRoot: string,
            skipped: Array<{ source: string; reason: string }> = [],
          ) => {
            const workspace = await ctx.workspaces.create({
              path: vaultRoot,
            });
            await renameWorkspaceDisplay(
              workspace,
              selectedVault?.name ? `${selectedVault.name}` : undefined,
              vaultId,
            );
            const sessionId = await ctx.sessions.create({
              workspaceId: workspace.workspaceId,
              cwd: vaultRoot,
            });
            await send(
              sessionId,
              buildKbClassifyPrompt({
                vaultId,
                vaultName: selectedVault?.name ?? null,
                batchId: targetBatchId,
                vaultRoot,
                skipped,
              }),
            );
            ctx.uiWorkspace.openSession(sessionId);
          };

          const selectCandidate = async (candidateId: string | null) => {
            const reqId = ++candidateReqRef.current;
            setSelectedCandidateId(candidateId);
            setCandidateDetail(null);
            setCandidateError("");
            if (!candidateId) {
              setCandidateLoading(false);
              return;
            }
            setCandidateLoading(true);
            try {
              const fetched = await api("kb", {
                action: "candidate",
                vaultId,
                id: candidateId,
              });
              if (candidateReqRef.current === reqId) {
                setCandidateDetail(fetched);
                setCandidateLoading(false);
              }
            } catch (err) {
              if (candidateReqRef.current === reqId) {
                setCandidateDetail(null);
                setCandidateError(
                  err instanceof Error ? err.message : String(err),
                );
                setCandidateLoading(false);
              }
            }
          };

          const loadBatchSlicePage = async (
            batchId: string,
            after?: string,
            history: Array<string | undefined> = [],
          ) => {
            const page = await api("kb", {
              action: "candidates",
              vaultId,
              batchId,
              ...(after ? { after } : {}),
            });
            setOpenBatchId(batchId);
            setBatchPage(page);
            setBatchAfter(after);
            setAfterHistory(history);
            const firstId = page.candidates?.[0]?.id ?? null;
            await selectCandidate(firstId);
          };

          const formatBatchSources = (sources: string[] | undefined) => {
            if (!sources || !sources.length) return t("pendingUnnamed");
            const localeIsEn = t("localeCode") === "en";
            if (sources.length === 1) {
              return localeIsEn
                ? `${t("fromFilesPrefix")} "${sources[0]}"`
                : `${t("fromFilesPrefix")}《${sources[0]}》`;
            }
            return localeIsEn
              ? `${t("fromFilesPrefix")} "${sources[0]}" ${t("moreFilesSuffix")} ${sources.length - 1} ${t("filesCountUnit")}`
              : `${t("fromFilesPrefix")}《${sources[0]}》${t("moreFilesSuffix")} ${sources.length} ${t("filesCountUnit")}`;
          };

          const sourceTypeLabel = (value?: string) => {
            if (value === "docx") return t("sourceTypeDocx");
            if (value === "pdf") return t("sourceTypePdf");
            if (value === "image") return t("sourceTypeImage");
            if (value === "spreadsheet") return t("sourceTypeSpreadsheet");
            if (value === "text") return t("sourceTypeText");
            return value ?? "";
          };

          const validityBadgeClass = (value: string) => {
            if (value === "valid") return "seal-badge seal-badge-ok";
            if (value === "expiring_soon" || value === "unknown")
              return "seal-badge seal-badge-warn";
            if (value === "expired") return "seal-badge seal-badge-error";
            return "seal-badge";
          };

          const candidateImages = (entry: any): string[] => {
            if (!entry?.fields) return [];
            if (Array.isArray(entry.fields.imageFiles)) {
              return entry.fields.imageFiles.filter(
                (file: unknown): file is string => typeof file === "string",
              );
            }
            if (Array.isArray(entry.fields.files)) {
              return entry.fields.files.filter(
                (file: unknown): file is string =>
                  typeof file === "string" &&
                  /\.(png|jpe?g|gif|bmp|webp|svg|tiff?)$/i.test(file),
              );
            }
            return [];
          };

          if (!props.overview.vaults.length) {
            return h(
              "section",
              { className: "seal-stack" },
              h(
                "div",
                { className: "seal-empty-hero" },
                h(
                  "div",
                  { className: "seal-stack-sm" },
                  h("h2", null, t("kbHeroTitle")),
                  h("p", { className: "seal-muted" }, t("kbHeroDesc")),
                ),
                h(
                  "div",
                  { className: "seal-steps-3" },
                  h(
                    "div",
                    { className: "seal-step-card" },
                    h("strong", null, t("kbStep1Title")),
                    h("span", { className: "seal-small" }, t("kbStep1Desc")),
                  ),
                  h(
                    "div",
                    { className: "seal-step-card" },
                    h("strong", null, t("kbStep2Title")),
                    h("span", { className: "seal-small" }, t("kbStep2Desc")),
                  ),
                  h(
                    "div",
                    { className: "seal-step-card" },
                    h("strong", null, t("kbStep3Title")),
                    h("span", { className: "seal-small" }, t("kbStep3Desc")),
                  ),
                ),
                h(
                  "div",
                  {
                    className: "seal-row",
                    style: { width: "100%", maxWidth: 460 },
                  },
                  h("input", {
                    value: name,
                    placeholder: t("vaultPlaceholder"),
                    "aria-label": t("vaultName"),
                    style: { flex: "1 1 220px" },
                    onChange: (event: any) => setName(event.target.value),
                  }),
                  h(
                    "button",
                    {
                      className: "seal-btn-primary",
                      disabled: action.busy || !name.trim(),
                      onClick: () =>
                        action.run(async () => {
                          const vault = await api("kb", {
                            action: "create",
                            name,
                          });
                          setVaultId(vault.vaultId);
                          setName("");
                          setShowIngest(true);
                          props.reload();
                        }),
                    },
                    t("createFirstVault"),
                  ),
                ),
                actionStatus(action),
              ),
            );
          }

          const isVaultEmpty =
            catalog !== null &&
            catalog.evidenceCount === 0 &&
            catalog.materialCount === 0 &&
            (catalog.pendingBatches?.length ?? 0) === 0;
          const ingestOpen = showIngest ?? isVaultEmpty;
          const evidenceTypes = (catalog?.types ?? []).filter(
            (value: string) => Boolean(value) && value !== "material",
          );
          const pendingBatches = catalog?.pendingBatches ?? [];
          const metricsSource = catalog ?? selectedVault;
          const subjectVerified = selectedVault?.subjectVerified ?? false;
          const evidenceCount = metricsSource?.evidenceCount ?? 0;
          const materialCount = metricsSource?.materialCount ?? 0;
          const unverifiedCount = metricsSource?.unverified ?? 0;

          const runIngest = (autoClassify: boolean) =>
            action.run(async () => {
              const targets = [
                ...files.map((file) => file.path),
                ...(ingestPath.trim() ? [ingestPath.trim()] : []),
              ];
              const res = await api("kb", {
                action: "ingest",
                vaultId,
                files: targets,
              });
              const skippedList = Array.isArray(res.skipped) ? res.skipped : [];
              setFiles([]);
              setIngestPath("");
              setBatchDeleteNotice("");
              updateIngestSkipped(vaultId, skippedList);
              setShowIngest(false);
              resource.reload();
              props.reload();
              if (autoClassify && catalog?.root) {
                await startClassifySession(
                  res.batchId,
                  catalog.root,
                  skippedList,
                );
              } else {
                await loadBatchSlicePage(res.batchId);
              }
            }, autoClassify ? t("sent") : t("ingestDone"));

          return h(
            "section",
            { className: "seal-stack" },
            h(
              "div",
              { className: "seal-vault-header" },
              h(
                "div",
                { className: "seal-row seal-between" },
                h(
                  "div",
                  { className: "seal-vault-switcher" },
                  h(
                    "select",
                    {
                      "aria-label": t("vault"),
                      value: vaultId,
                      onChange: (event: any) => switchVault(event.target.value),
                    },
                    ...props.overview.vaults.map((item) =>
                      h(
                        "option",
                        { key: item.vaultId, value: item.vaultId },
                        item.error
                          ? `${item.vaultId} (${t("unavailable")})`
                          : (item.name ?? item.vaultId),
                      ),
                    ),
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      className: "seal-btn-sm",
                      disabled: vaultDelete.busy,
                      onClick: () => setShowCreateVault((value) => !value),
                    },
                    t("addVault"),
                  ),
                  vaultId &&
                    h(
                      "button",
                      {
                        type: "button",
                        className: "seal-btn-danger seal-btn-sm",
                        disabled: action.busy || vaultDelete.busy,
                        onClick: () => vaultDelete.open(vaultId),
                      },
                      t("deleteVault"),
                    ),
                ),
                h(
                  "div",
                  { className: "seal-row" },
                  (() => {
                    const toggle = importToggleState(ingestOpen);
                    return h(
                      "button",
                      {
                        type: "button",
                        className:
                          toggle.variant === "primary"
                            ? "seal-btn-primary seal-btn-sm"
                            : "seal-btn-sm",
                        "aria-expanded": ingestOpen,
                        disabled: Boolean(selectedVault?.error),
                        onClick: () => setShowIngest(!ingestOpen),
                      },
                      t(toggle.labelKey),
                    );
                  })(),
                ),
              ),
              showCreateVault &&
                h(
                  "div",
                  { className: "seal-row" },
                  h("input", {
                    value: name,
                    placeholder: t("vaultPlaceholder"),
                    "aria-label": t("vaultName"),
                    style: { flex: "1 1 200px" },
                    onChange: (event: any) => setName(event.target.value),
                  }),
                  h(
                    "button",
                    {
                      className: "seal-btn-primary seal-btn-sm",
                      disabled: action.busy || !name.trim(),
                      onClick: () =>
                        action.run(async () => {
                          const vault = await api("kb", {
                            action: "create",
                            name,
                          });
                          setVaultId(vault.vaultId);
                          setName("");
                          setShowCreateVault(false);
                          setShowIngest(true);
                          props.reload();
                        }),
                    },
                    t("newVault"),
                  ),
                  h(
                    "button",
                    {
                      className: "seal-btn-ghost seal-btn-sm",
                      onClick: () => setShowCreateVault(false),
                    },
                    t("cancel"),
                  ),
                ),
              vaultId &&
                renderDeleteConfirm({
                  active: vaultDelete.targetKey === vaultId,
                  prompt: `${t("deleteVaultPrompt")}${selectedVault?.name ? `（${selectedVault.name}）` : ""}`,
                  busy: vaultDelete.busy,
                  error: vaultDelete.error,
                  onCancel: vaultDelete.close,
                  onConfirm: () =>
                    void vaultDelete.confirm(vaultId, async () => {
                      const deletedId = vaultId;
                      await api("kb", {
                        action: "delete_vault",
                        vaultId: deletedId,
                      });
                      updateIngestSkipped(deletedId, []);
                      const nextId = nextSelectedVaultId(
                        props.overview.vaults,
                        deletedId,
                      );
                      setVaultId(nextId);
                      setSubTab("subject");
                      setQuery("");
                      setType("");
                      setValidity("");
                      setVerified("");
                      setOffset(0);
                      setIssueOffset(0);
                      setDetail(null);
                      setShowIngest(null);
                      setShowCreateVault(false);
                      setBatchDeleteNotice("");
                      batchDelete.reset();
                      clearBatchDrawerState();
                      props.reload();
                    }),
                }),
              selectedVault?.error
                ? h(
                    "div",
                    { className: "seal-error" },
                    `${selectedVault.vaultId}：${selectedVault.error}`,
                  )
                : h(
                    "div",
                    { className: "seal-metric-row" },
                    h(
                      "button",
                      {
                        type: "button",
                        className: `seal-badge ${subjectVerified ? "seal-badge-ok" : "seal-badge-warn"}`,
                        onClick: () => switchSubTab("subject"),
                      },
                      t(subjectVerified ? "subjectReady" : "subjectNeedsWork"),
                    ),
                    h(
                      "button",
                      {
                        type: "button",
                        className: "seal-metric-pill",
                        onClick: () => switchSubTab("evidence"),
                      },
                      `${t("tabEvidence")} ${evidenceCount}`,
                    ),
                    h(
                      "button",
                      {
                        type: "button",
                        className: "seal-metric-pill",
                        onClick: () => switchSubTab("materials"),
                      },
                      `${t("tabMaterials")} ${materialCount}`,
                    ),
                    (() => {
                      const tone = unverifiedBadgeTone({
                        recordCount: evidenceCount + materialCount,
                        subjectVerified,
                        unverified: unverifiedCount,
                      });
                      const badgeClass =
                        tone === "warn"
                          ? "seal-badge seal-badge-warn"
                          : tone === "ok"
                            ? "seal-badge seal-badge-ok"
                            : "seal-badge";
                      return h(
                        "span",
                        { className: badgeClass },
                        `${t("unverified")} ${unverifiedCount}`,
                      );
                    })(),
                  ),
            ),

            !selectedVault?.error &&
              ingestOpen &&
              h(
                "div",
                { className: "seal-card seal-stack" },
                h(
                  "div",
                  { className: "seal-row seal-between" },
                  h("h2", { style: { margin: 0 } }, t("ingest")),
                  !isVaultEmpty &&
                    h(
                      "button",
                      {
                        type: "button",
                        className: "seal-btn-ghost seal-btn-sm",
                        onClick: () => setShowIngest(false),
                      },
                      t("cancel"),
                    ),
                ),
                h(FilePicker, {
                  label: t("ingestHint"),
                  allowAny: true,
                  onFiles: setFiles,
                }),
                files.length > 0 &&
                  h(
                    "div",
                    { className: "seal-chips" },
                    ...files.map((file, index) =>
                      h(
                        "span",
                        { key: `${file.path}:${index}`, className: "seal-chip" },
                        h(
                          "span",
                          { className: "seal-chip-text", title: file.name },
                          file.name,
                        ),
                        h(
                          "button",
                          {
                            type: "button",
                            className: "seal-chip-remove",
                            "aria-label": file.name,
                            onClick: () =>
                              setFiles((previous) =>
                                previous.filter((_, idx) => idx !== index),
                              ),
                          },
                          "×",
                        ),
                      ),
                    ),
                  ),
                h(
                  "label",
                  null,
                  t("ingestPathLabel"),
                  h("input", {
                    value: ingestPath,
                    placeholder: t("ingestPathPlaceholder"),
                    onChange: (event: any) => setIngestPath(event.target.value),
                  }),
                ),
                h(
                  "div",
                  { className: "seal-row" },
                  h(
                    "button",
                    {
                      type: "button",
                      className: "seal-btn-primary",
                      disabled:
                        action.busy ||
                        !catalog ||
                        (!files.length && !ingestPath.trim()),
                      onClick: () => runIngest(true),
                    },
                    t("importAndClassify"),
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      disabled:
                        action.busy || (!files.length && !ingestPath.trim()),
                      onClick: () => runIngest(false),
                    },
                    t("importOnly"),
                  ),
                ),
              ),

            !selectedVault?.error &&
              ingestSkipped.length > 0 &&
              h(
                "div",
                {
                  className: "seal-callout seal-callout-warn",
                  role: "status",
                },
                h(
                  "div",
                  { className: "seal-callout-body" },
                  h(
                    "strong",
                    { className: "seal-small" },
                    `${t("ingestSkipped")}（${ingestSkipped.length}）`,
                  ),
                  ...ingestSkipped.map((item, idx) =>
                    h(
                      "span",
                      { key: idx, className: "seal-small" },
                      `${item.source}：${item.reason}`,
                    ),
                  ),
                ),
                h(
                  "button",
                  {
                    type: "button",
                    className: "seal-btn-ghost seal-btn-sm",
                    "aria-label": t("cancel"),
                    onClick: () => updateIngestSkipped(vaultId, []),
                  },
                  "×",
                ),
              ),

            !selectedVault?.error &&
              batchDeleteNotice &&
              h(
                "div",
                { className: "seal-callout", role: "status" },
                h("span", { className: "seal-small" }, batchDeleteNotice),
                h(
                  "button",
                  {
                    type: "button",
                    className: "seal-btn-ghost seal-btn-sm",
                    "aria-label": t("cancel"),
                    onClick: () => setBatchDeleteNotice(""),
                  },
                  "×",
                ),
              ),

            !selectedVault?.error &&
              pendingBatches.length > 0 &&
              h(
                "div",
                { className: "seal-stack" },
                ...pendingBatches.map((item: any) => {
                  const isOpen = openBatchId === item.batchId;
                  return h(
                    "article",
                    { key: item.batchId, className: "seal-pending-banner" },
                    h(
                      "div",
                      { className: "seal-row seal-between" },
                      h(
                        "div",
                        { className: "seal-stack-sm" },
                        h(
                          "div",
                          { className: "seal-row" },
                          h("strong", null, formatBatchSources(item.sources)),
                          h(
                            "span",
                            { className: "seal-badge seal-badge-warn" },
                            `${t("pendingSlicesProgress")} ${item.pendingCount} / ${item.totalCandidates} ${t("slicesUnit")}`,
                          ),
                        ),
                      ),
                      h(
                        "div",
                        { className: "seal-row" },
                        h(
                          "button",
                          {
                            type: "button",
                            className: "seal-btn-sm",
                            disabled: action.busy || batchDelete.busy,
                            onClick: () => {
                              if (isOpen) {
                                clearBatchDrawerState();
                              } else {
                                void action.run(() =>
                                  loadBatchSlicePage(item.batchId),
                                );
                              }
                            },
                          },
                          t(isOpen ? "hideSlices" : "viewSlices"),
                        ),
                        h(
                          "button",
                          {
                            type: "button",
                            className: "seal-btn-primary seal-btn-sm",
                            disabled:
                              action.busy || batchDelete.busy || !catalog,
                            onClick: () =>
                              action.run(
                                () =>
                                  startClassifySession(
                                    item.batchId,
                                    catalog.root,
                                  ),
                                t("sent"),
                              ),
                          },
                          t("classifyNow"),
                        ),
                        h(
                          "button",
                          {
                            type: "button",
                            className: "seal-btn-danger seal-btn-sm",
                            disabled: action.busy || batchDelete.busy,
                            onClick: () => batchDelete.open(item.batchId),
                          },
                          t("deleteBatch"),
                        ),
                      ),
                    ),
                    renderDeleteConfirm({
                      active: batchDelete.targetKey === item.batchId,
                      prompt: `${t("deleteBatchPrompt")}（${formatBatchSources(item.sources)}）`,
                      busy: batchDelete.busy,
                      error: batchDelete.error,
                      onCancel: batchDelete.close,
                      onConfirm: () =>
                        void batchDelete.confirm(item.batchId, async () => {
                          const res = await api("kb", {
                            action: "delete_batch",
                            vaultId,
                            batchId: item.batchId,
                          });
                          if (openBatchId === item.batchId) {
                            clearBatchDrawerState();
                          }
                          setBatchDeleteNotice(
                            formatDeleteBatchNotice(res, uiLocale),
                          );
                          resource.reload();
                          props.reload();
                        }),
                    }),
                    isOpen &&
                      batchPage &&
                      batchPage.batchId === item.batchId &&
                      h(
                        "div",
                        { className: "seal-stack seal-divider" },
                        h(
                          "div",
                          { className: "seal-slice-layout" },
                          h(
                            "div",
                            { className: "seal-stack-sm" },
                            h(
                              "div",
                              { className: "seal-slice-list" },
                              ...batchPage.candidates.map((cand: any) =>
                                h(
                                  "button",
                                  {
                                    key: cand.id,
                                    type: "button",
                                    className: "seal-slice-row",
                                    "aria-current":
                                      selectedCandidateId === cand.id
                                        ? "true"
                                        : undefined,
                                    onClick: () => {
                                      void selectCandidate(cand.id);
                                    },
                                  },
                                  h(
                                    "div",
                                    {
                                      className: "seal-row seal-between",
                                      style: { width: "100%" },
                                    },
                                    h(
                                      "strong",
                                      null,
                                      cand.title || t("pendingUnnamed"),
                                    ),
                                    h(
                                      "div",
                                      { className: "seal-row" },
                                      cand.sourceType &&
                                        h(
                                          "span",
                                          { className: "seal-badge" },
                                          sourceTypeLabel(cand.sourceType),
                                        ),
                                      cand.imageCount > 0 &&
                                        h(
                                          "span",
                                          {
                                            className:
                                              "seal-badge seal-badge-info",
                                          },
                                          `${cand.imageCount} ${t("imagesCount")}`,
                                        ),
                                      cand.processed &&
                                        h(
                                          "span",
                                          {
                                            className:
                                              "seal-badge seal-badge-ok",
                                          },
                                          t("sliceProcessed"),
                                        ),
                                    ),
                                  ),
                                  formatCandidateLocation(
                                    cand.source,
                                    cand.location,
                                  ) &&
                                    h(
                                      "span",
                                      { className: "seal-small" },
                                      formatCandidateLocation(
                                        cand.source,
                                        cand.location,
                                      ),
                                    ),
                                ),
                              ),
                            ),
                            (afterHistory.length > 0 || batchPage.nextAfter) &&
                              h(
                                "div",
                                { className: "seal-row" },
                                h(
                                  "button",
                                  {
                                    type: "button",
                                    className: "seal-btn-sm",
                                    disabled:
                                      action.busy || afterHistory.length === 0,
                                    onClick: () =>
                                      action.run(async () => {
                                        const prevHistory = afterHistory.slice(
                                          0,
                                          -1,
                                        );
                                        const prevCursor = afterHistory.at(-1);
                                        await loadBatchSlicePage(
                                          item.batchId,
                                          prevCursor,
                                          prevHistory,
                                        );
                                      }),
                                  },
                                  t("previous"),
                                ),
                                h(
                                  "button",
                                  {
                                    type: "button",
                                    className: "seal-btn-sm",
                                    disabled:
                                      action.busy || !batchPage.nextAfter,
                                    onClick: () =>
                                      action.run(async () => {
                                        await loadBatchSlicePage(
                                          item.batchId,
                                          batchPage.nextAfter,
                                          [...afterHistory, batchAfter],
                                        );
                                      }),
                                  },
                                  t("next"),
                                ),
                              ),
                          ),
                          h(
                            "div",
                            { className: "seal-slice-preview" },
                            candidateLoading
                              ? h("p", { className: "seal-muted" }, t("loading"))
                              : candidateError
                                ? h(
                                    "p",
                                    { className: "seal-error", role: "alert" },
                                    candidateError,
                                  )
                                : candidateDetail &&
                                    candidateDetail.id === selectedCandidateId
                                  ? (() => {
                                      const previewText =
                                        formatCandidatePreviewBody(
                                          candidateDetail.body ?? "",
                                        );
                                      return h(
                                        React.Fragment,
                                        null,
                                        h(
                                          "div",
                                          { className: "seal-row seal-between" },
                                          h(
                                            "h3",
                                            null,
                                            candidateDetail.fields?.title ??
                                              t("pendingUnnamed"),
                                          ),
                                          candidateDetail.fields?.sourceType &&
                                            h(
                                              "span",
                                              { className: "seal-badge" },
                                              sourceTypeLabel(
                                                candidateDetail.fields.sourceType,
                                              ),
                                            ),
                                        ),
                                        formatCandidateLocation(
                                          candidateDetail.fields?.source,
                                          candidateDetail.fields?.location,
                                        ) &&
                                          h(
                                            "span",
                                            { className: "seal-small" },
                                            formatCandidateLocation(
                                              candidateDetail.fields.source,
                                              candidateDetail.fields.location,
                                            ),
                                          ),
                                        candidateImages(candidateDetail).length >
                                          0 &&
                                          h(
                                            "div",
                                            { className: "seal-thumb-grid" },
                                            ...candidateImages(
                                              candidateDetail,
                                            ).map(
                                              (
                                                imgPath: string,
                                                index: number,
                                              ) => {
                                                const href = `/api/seal/kb-file?${new URLSearchParams({ vaultId, kind: "candidate", id: candidateDetail.id, index: String(index) })}`;
                                                return h(
                                                  "a",
                                                  {
                                                    key: `${imgPath}:${index}`,
                                                    className: "seal-thumb-card",
                                                    href,
                                                    target: "_blank",
                                                    rel: "noreferrer",
                                                  },
                                                  h("img", {
                                                    src: href,
                                                    className: "seal-thumb-img",
                                                    loading: "lazy",
                                                    alt:
                                                      imgPath
                                                        .split("/")
                                                        .at(-1) ??
                                                      t("imagesCount"),
                                                  }),
                                                  h(
                                                    "span",
                                                    null,
                                                    imgPath.split("/").at(-1),
                                                  ),
                                                );
                                              },
                                            ),
                                          ),
                                        previewText &&
                                          h("pre", null, previewText),
                                      );
                                    })()
                                  : h(
                                      "p",
                                      { className: "seal-muted" },
                                      t("selectSliceHint"),
                                    ),
                          ),
                        ),
                      ),
                  );
                }),
              ),

            !selectedVault?.error &&
              h(
                "div",
                { className: "seal-stack" },
                h(
                  "div",
                  { className: "seal-row seal-between" },
                  h(
                    "nav",
                    { className: "seal-segmented", role: "tablist" },
                    ...[
                      ["subject", t("tabSubject")],
                      ["evidence", `${t("tabEvidence")} (${evidenceCount})`],
                      ["materials", `${t("tabMaterials")} (${materialCount})`],
                    ].map(([key, label]) =>
                      h(
                        "button",
                        {
                          key,
                          type: "button",
                          role: "tab",
                          "aria-selected": subTab === key,
                          onClick: () =>
                            switchSubTab(
                              key as "subject" | "evidence" | "materials",
                            ),
                        },
                        label,
                      ),
                    ),
                  ),
                  shouldShowReferenceDateHint(subTab) &&
                    h("span", { className: "seal-small" }, t("referenceDate")),
                ),
                resourceStatus(resource),
                subTab === "subject" &&
                  h(KnowledgeDetail, {
                    key: `${vaultId}:subject:subject`,
                    vaultId,
                    kind: "subject",
                    id: "subject",
                    issues: catalog?.issues ?? [],
                    overviewSubjectVerified: selectedVault?.subjectVerified,
                    refreshTick: props.refreshTick,
                    reload: () => {
                      resource.reload();
                      props.reload();
                    },
                  }),
                subTab === "evidence" &&
                  catalog &&
                  (catalog.evidenceCount === 0
                    ? h(
                        "div",
                        { className: "seal-empty-hero" },
                        h("h3", null, t("evidenceEmptyTitle")),
                        h("p", { className: "seal-muted" }, t("evidenceEmptyDesc")),
                        h(
                          "button",
                          {
                            type: "button",
                            className: "seal-btn-primary",
                            onClick: () => setShowIngest(true),
                          },
                          t("importMaterials"),
                        ),
                      )
                    : h(
                        "div",
                        { className: "seal-stack" },
                        h(
                          "div",
                          { className: "seal-toolbar" },
                          h("input", {
                            className: "seal-toolbar-search",
                            value: query,
                            placeholder: t("search"),
                            "aria-label": t("search"),
                            onChange: (event: any) => {
                              setQuery(event.target.value);
                              setOffset(0);
                            },
                          }),
                          h(
                            "button",
                            {
                              type: "button",
                              className: `seal-section-chip`,
                              "aria-pressed": verified === "no",
                              onClick: () => {
                                setVerified((value) =>
                                  value === "no" ? "" : "no",
                                );
                                setOffset(0);
                              },
                            },
                            t("onlyUnverified"),
                          ),
                          h(
                            "select",
                            {
                              className: "seal-toolbar-select",
                              value: validity,
                              "aria-label": t("allValidity"),
                              onChange: (event: any) => {
                                setValidity(event.target.value);
                                setOffset(0);
                              },
                            },
                            h("option", { value: "" }, t("allValidity")),
                            ...[
                              "valid",
                              "expiring_soon",
                              "expired",
                              "unknown",
                              "not_applicable",
                            ].map((key) =>
                              h(
                                "option",
                                { key, value: key },
                                t(key as DictionaryKey),
                              ),
                            ),
                          ),
                        ),
                        evidenceTypes.length > 0 &&
                          h(
                            "div",
                            { className: "seal-section-bar", role: "group" },
                            h(
                              "button",
                              {
                                type: "button",
                                className: "seal-section-chip",
                                "aria-pressed": type === "",
                                onClick: () => {
                                  setType("");
                                  setOffset(0);
                                },
                              },
                              t("allTypes"),
                            ),
                            ...evidenceTypes.map((value: string) =>
                              h(
                                "button",
                                {
                                  key: value,
                                  type: "button",
                                  className: "seal-section-chip",
                                  "aria-pressed": type === value,
                                  onClick: () => {
                                    setType(value);
                                    setOffset(0);
                                  },
                                },
                                value,
                              ),
                            ),
                          ),
                        !catalog.items.length
                          ? h("p", { className: "seal-muted" }, t("empty"))
                          : h(
                              "div",
                              { className: "seal-stack-sm" },
                              ...catalog.items.map((item: any) => {
                                const hasThumb =
                                  (item.imageCount ?? 0) > 0 &&
                                  item.firstImageIndex !== undefined;
                                const thumbSrc = hasThumb
                                  ? `/api/seal/kb-file?${new URLSearchParams({ vaultId, kind: item.kind, id: item.id, index: String(item.firstImageIndex) })}`
                                  : "";
                                const isSelected =
                                  detail?.kind === item.kind &&
                                  detail?.id === item.id;
                                return h(
                                  "article",
                                  {
                                    key: item.id,
                                    className: isSelected
                                      ? "seal-evidence-card seal-row-selected"
                                      : "seal-evidence-card",
                                    "aria-current": isSelected
                                      ? "true"
                                      : undefined,
                                  },
                                  hasThumb
                                    ? h("img", {
                                        src: thumbSrc,
                                        className: "seal-evidence-thumb",
                                        loading: "lazy",
                                        alt: item.title,
                                      })
                                    : h(
                                        "div",
                                        { className: "seal-evidence-thumb-empty" },
                                        t("noImages"),
                                      ),
                                  h(
                                    "div",
                                    { className: "seal-evidence-main" },
                                    h(
                                      "div",
                                      { className: "seal-row seal-between" },
                                      h("h3", null, item.title),
                                      h(
                                        "button",
                                        {
                                          type: "button",
                                          className: "seal-btn-sm",
                                          "aria-pressed": isSelected,
                                          onClick: () =>
                                            navigate(() => {
                                              if (isSelected) {
                                                scrollDetailIntoView();
                                              } else {
                                                setDetail({
                                                  kind: item.kind,
                                                  id: item.id,
                                                });
                                              }
                                            }),
                                        },
                                        t("details"),
                                      ),
                                    ),
                                    h(
                                      "div",
                                      { className: "seal-row" },
                                      item.type &&
                                        h(
                                          "span",
                                          { className: "seal-badge" },
                                          item.type,
                                        ),
                                      item.number &&
                                        h(
                                          "span",
                                          { className: "seal-badge" },
                                          item.number,
                                        ),
                                      h(
                                        "span",
                                        {
                                          className: validityBadgeClass(
                                            item.validity,
                                          ),
                                        },
                                        item.validUntil &&
                                          item.validUntil !== "长期" &&
                                          item.validUntil !== "不适用"
                                          ? `${t(item.validity as DictionaryKey)} · ${item.validUntil}`
                                          : t(item.validity as DictionaryKey),
                                      ),
                                      h(
                                        "span",
                                        {
                                          className: `seal-badge ${item.verified ? "seal-badge-ok" : "seal-badge-warn"}`,
                                        },
                                        t(
                                          item.verified
                                            ? "verified"
                                            : "unverified",
                                        ),
                                      ),
                                      (item.imageCount ?? 0) > 0 &&
                                        h(
                                          "span",
                                          {
                                            className:
                                              "seal-badge seal-badge-info",
                                          },
                                          `${item.imageCount} ${t("imagesCount")}`,
                                        ),
                                    ),
                                  ),
                                );
                              }),
                            ),
                        (offset > 0 || catalog.nextOffset !== null) &&
                          h(
                            "div",
                            { className: "seal-row" },
                            h(
                              "button",
                              {
                                className: "seal-btn-sm",
                                disabled: offset === 0,
                                onClick: () =>
                                  setOffset((value) => Math.max(0, value - 25)),
                              },
                              t("previous"),
                            ),
                            h(
                              "button",
                              {
                                className: "seal-btn-sm",
                                disabled: catalog.nextOffset === null,
                                onClick: () => setOffset(catalog.nextOffset),
                              },
                              t("next"),
                            ),
                          ),
                        detail &&
                          detail.kind === "record" &&
                          h(
                            "div",
                            {
                              ref: detailPanelRef,
                              className: "seal-detail-panel",
                            },
                            h(KnowledgeDetail, {
                              key: `${vaultId}:${detail.kind}:${detail.id}`,
                              vaultId,
                              ...detail,
                              refreshTick: props.refreshTick,
                              onClose: () => setDetail(null),
                              onLoaded: () => scrollDetailIntoView(),
                              reload: () => {
                                resource.reload();
                                props.reload();
                              },
                            }),
                          ),
                      )),
                subTab === "materials" &&
                  catalog &&
                  h(
                    "div",
                    { className: "seal-stack" },
                    h(
                      "div",
                      { className: "seal-callout" },
                      h("span", { className: "seal-small" }, t("materialsNotice")),
                    ),
                    catalog.materialCount === 0
                      ? h(
                          "div",
                          { className: "seal-empty-hero" },
                          h("h3", null, t("materialsEmptyTitle")),
                          h(
                            "p",
                            { className: "seal-muted" },
                            t("materialsEmptyDesc"),
                          ),
                          h(
                            "button",
                            {
                              type: "button",
                              className: "seal-btn-primary",
                              onClick: () => setShowIngest(true),
                            },
                            t("importMaterials"),
                          ),
                        )
                      : h(
                          React.Fragment,
                          null,
                          h(
                            "div",
                            { className: "seal-toolbar" },
                            h("input", {
                              className: "seal-toolbar-search",
                              value: query,
                              placeholder: t("search"),
                              "aria-label": t("search"),
                              onChange: (event: any) => {
                                setQuery(event.target.value);
                                setOffset(0);
                              },
                            }),
                          ),
                          !catalog.items.length
                            ? h("p", { className: "seal-muted" }, t("empty"))
                            : h(
                                "div",
                                { className: "seal-stack-sm" },
                                ...catalog.items.map((item: any) => {
                                  const isSelected =
                                    detail?.kind === item.kind &&
                                    detail?.id === item.id;
                                  return h(
                                    "article",
                                    {
                                      key: item.id,
                                      className: isSelected
                                        ? "seal-card-compact seal-row-selected"
                                        : "seal-card-compact",
                                      "aria-current": isSelected
                                        ? "true"
                                        : undefined,
                                    },
                                    h(
                                      "div",
                                      { className: "seal-row seal-between" },
                                      h(
                                        "div",
                                        { className: "seal-stack-sm" },
                                        h("h3", null, item.title),
                                        h(
                                          "div",
                                          { className: "seal-row" },
                                          h(
                                            "span",
                                            { className: "seal-badge" },
                                            t("material"),
                                          ),
                                          h(
                                            "span",
                                            { className: "seal-badge" },
                                            t("verificationNotRequired"),
                                          ),
                                          (item.imageCount ?? 0) > 0 &&
                                            h(
                                              "span",
                                              {
                                                className:
                                                  "seal-badge seal-badge-info",
                                              },
                                              `${item.imageCount} ${t("imagesCount")}`,
                                            ),
                                        ),
                                      ),
                                      h(
                                        "button",
                                        {
                                          type: "button",
                                          className: "seal-btn-sm",
                                          "aria-pressed": isSelected,
                                          onClick: () =>
                                            navigate(() => {
                                              if (isSelected) {
                                                scrollDetailIntoView();
                                              } else {
                                                setDetail({
                                                  kind: item.kind,
                                                  id: item.id,
                                                });
                                              }
                                            }),
                                        },
                                        t("details"),
                                      ),
                                    ),
                                  );
                                }),
                              ),
                          (offset > 0 || catalog.nextOffset !== null) &&
                            h(
                              "div",
                              { className: "seal-row" },
                              h(
                                "button",
                                {
                                  className: "seal-btn-sm",
                                  disabled: offset === 0,
                                  onClick: () =>
                                    setOffset((value) =>
                                      Math.max(0, value - 25),
                                    ),
                                },
                                t("previous"),
                              ),
                              h(
                                "button",
                                {
                                  className: "seal-btn-sm",
                                  disabled: catalog.nextOffset === null,
                                  onClick: () => setOffset(catalog.nextOffset),
                                },
                                t("next"),
                              ),
                            ),
                          detail &&
                            detail.kind === "material" &&
                            h(
                              "div",
                              {
                                ref: detailPanelRef,
                                className: "seal-detail-panel",
                              },
                              h(KnowledgeDetail, {
                                key: `${vaultId}:${detail.kind}:${detail.id}`,
                                vaultId,
                                ...detail,
                                refreshTick: props.refreshTick,
                                onClose: () => setDetail(null),
                                onLoaded: () => scrollDetailIntoView(),
                                reload: () => {
                                  resource.reload();
                                  props.reload();
                                },
                              }),
                            ),
                        ),
                  ),
                catalog &&
                  catalog.issueCount > 0 &&
                  h(
                    "details",
                    null,
                    h(
                      "summary",
                      null,
                      `${t("healthIssues")} · ${catalog.issueCount}`,
                    ),
                    h(
                      "div",
                      { className: "seal-stack-sm", style: { marginTop: 8 } },
                      ...catalog.issues.map((issue: any, index: number) =>
                        h(
                          "div",
                          { key: index, className: "seal-row" },
                          h(
                            "button",
                            {
                              type: "button",
                              className: "seal-btn-sm",
                              onClick: () => {
                                if (issue.kind === "subject") {
                                  switchSubTab("subject");
                                } else if (issue.kind === "record") {
                                  navigate(() => {
                                    setSubTab("evidence");
                                    setOffset(0);
                                    setDetail({
                                      kind: "record",
                                      id: issue.id,
                                    });
                                  });
                                } else if (issue.kind === "material") {
                                  navigate(() => {
                                    setSubTab("materials");
                                    setOffset(0);
                                    setDetail({
                                      kind: "material",
                                      id: issue.id,
                                    });
                                  });
                                }
                              },
                            },
                            issue.field
                              ? issue.field in zh
                                ? t(issue.field as DictionaryKey)
                                : kbFieldLabel(issue.field, uiLocale)
                              : issue.kind === "subject"
                                ? t("tabSubject")
                                : t("details"),
                          ),
                          h(
                            "span",
                            { className: "seal-small" },
                            formatHealthIssueMessage(issue, uiLocale),
                          ),
                        ),
                      ),
                      (issueOffset > 0 || catalog.nextIssueOffset !== null) &&
                        h(
                          "div",
                          { className: "seal-row" },
                          h(
                            "button",
                            {
                              className: "seal-btn-sm",
                              disabled: issueOffset === 0,
                              onClick: () =>
                                setIssueOffset(Math.max(0, issueOffset - 25)),
                            },
                            t("previous"),
                          ),
                          h(
                            "button",
                            {
                              className: "seal-btn-sm",
                              disabled: catalog.nextIssueOffset === null,
                              onClick: () =>
                                setIssueOffset(catalog.nextIssueOffset),
                            },
                            t("next"),
                          ),
                        ),
                    ),
                  ),
              ),
            actionStatus(action),
          );
        }

        function OutlineEditor(props: {
          projectId: string;
          focusNodeId: string | null;
          onBackToProjects(): void;
          onReloadOverview(): void;
        }) {
          const [reloadTick, setReloadTick] = React.useState(0);
          const resource = useResource<OutlineGetResponse>(
            (signal) =>
              api("outline_get", { projectId: props.projectId }, signal),
            [props.projectId, reloadTick],
          );
          const action = useAction();
          const deleteConfirm = useInlineDelete();
          const [draftOutline, setDraftOutline] =
            React.useState<OutlineDocument | null>(null);
          const [baselineOutline, setBaselineOutline] =
            React.useState<OutlineDocument | null>(null);
          const [serverRevision, setServerRevision] = React.useState("");
          const [undoStack, setUndoStack] = React.useState<OutlineDocument[]>(
            [],
          );
          const [redoStack, setRedoStack] = React.useState<OutlineDocument[]>(
            [],
          );
          const [activeVolume, setActiveVolume] = React.useState("");
          const [filter, setFilter] = React.useState<OutlineRowFilter>("all");
          const [query, setQuery] = React.useState("");
          const [selectedNodeId, setSelectedNodeId] = React.useState<
            string | null
          >(props.focusNodeId);
          const [collapsedIds, setCollapsedIds] = React.useState<string[]>([]);
          const [showAddVolume, setShowAddVolume] = React.useState(false);
          const [newVolumeName, setNewVolumeName] = React.useState("");
          const [confirmMissing, setConfirmMissing] = React.useState(false);
          const [conflictError, setConflictError] = React.useState("");
          const [selectedKbId, setSelectedKbId] = React.useState("");
          const [uploadFiles, setUploadFiles] = React.useState<
            Array<{ path: string; name: string }>
          >([]);
          const [uploadPath, setUploadPath] = React.useState("");
          const [aiInstruction, setAiInstruction] = React.useState("");
          const [titleDraft, setTitleDraft] = React.useState<{
            id: string;
            value: string;
          } | null>(null);
          const loadedRevisionRef = React.useRef("");
          const localEditSeqRef = React.useRef(0);

          const payload =
            resource.state.kind === "value" &&
            "projectKind" in resource.state.value
              ? resource.state.value
              : null;

          const syncFromPayload = (nextPayload: Extract<
            OutlineGetResponse,
            { projectKind: "project" }
          >) => {
            setServerRevision(nextPayload.revision);
            loadedRevisionRef.current = nextPayload.revision;
            if (nextPayload.outline.kind === "value") {
              setBaselineOutline(nextPayload.outline.outline);
              setDraftOutline(nextPayload.outline.outline);
              setActiveVolume((prev) =>
                nextPayload.outline.kind === "value" &&
                nextPayload.outline.outline.volumes.some((v) => v.name === prev)
                  ? prev
                  : (nextPayload.outline.kind === "value"
                      ? nextPayload.outline.outline.volumes[0]?.name
                      : undefined) ?? "",
              );
            } else {
              setBaselineOutline(null);
              setDraftOutline(null);
            }
            setUndoStack([]);
            setRedoStack([]);
            setConflictError("");
            setConfirmMissing(false);
          };

          React.useEffect(() => {
            if (!payload) return;
            if (loadedRevisionRef.current === payload.revision) return;
            syncFromPayload(payload);
          }, [payload]);

          React.useEffect(() => {
            setUploadFiles([]);
            setUploadPath("");
            setSelectedKbId("");
            setAiInstruction("");
            setTitleDraft(null);
            deleteConfirm.reset();
          }, [selectedNodeId]);

          React.useEffect(() => {
            if (props.focusNodeId && draftOutline) {
              const target = draftOutline.nodes.find(
                (node) => node.id === props.focusNodeId,
              );
              if (target) {
                setSelectedNodeId(target.id);
                setActiveVolume(target.volume);
              }
            }
          }, [props.focusNodeId, draftOutline?.nodes.length]);

          const isDirty = Boolean(
            draftOutline &&
              (!baselineOutline ||
                canonicalOutlineDigest(baselineOutline) !==
                  canonicalOutlineDigest(draftOutline)),
          );

          React.useEffect(() => {
            try {
              if (isDirty) sessionStorage.setItem("seal:outline-dirty", "1");
              else sessionStorage.removeItem("seal:outline-dirty");
            } catch {
              /* Ignore storage errors. */
            }
            const warn = (event: BeforeUnloadEvent) => {
              if (isDirty) {
                event.preventDefault();
                event.returnValue = "";
              }
            };
            window.addEventListener("beforeunload", warn);
            return () => {
              window.removeEventListener("beforeunload", warn);
              try {
                sessionStorage.removeItem("seal:outline-dirty");
              } catch {
                /* Ignore storage errors. */
              }
            };
          }, [isDirty]);

          const commitEdit = (next: OutlineDocument) => {
            if (!draftOutline) return;
            localEditSeqRef.current += 1;
            setUndoStack((prev) => [...prev.slice(-49), draftOutline]);
            setRedoStack([]);
            setDraftOutline(next);
            setConflictError("");
            setConfirmMissing(false);
            deleteConfirm.reset();
          };

          const undo = () => {
            if (!draftOutline || undoStack.length === 0) return;
            localEditSeqRef.current += 1;
            const prev = undoStack[undoStack.length - 1];
            setUndoStack((stack) => stack.slice(0, -1));
            setRedoStack((stack) => [...stack, draftOutline]);
            setDraftOutline(prev);
            deleteConfirm.reset();
          };

          const redo = () => {
            if (!draftOutline || redoStack.length === 0) return;
            localEditSeqRef.current += 1;
            const next = redoStack[redoStack.length - 1];
            setRedoStack((stack) => stack.slice(0, -1));
            setUndoStack((stack) => [...stack, draftOutline]);
            setDraftOutline(next);
            deleteConfirm.reset();
          };

          if (resource.state.kind !== "value") return resourceStatus(resource);
          if ("kind" in resource.state.value && resource.state.value.kind === "not_project") {
            return h(
              "div",
              { className: "seal-card seal-stack" },
              h("p", { className: "seal-muted" }, t("noProject")),
              h(
                "button",
                { type: "button", onClick: props.onBackToProjects },
                t("backToProjects"),
              ),
            );
          }
          if (!payload) return null;

          const leaveWithGuard = (fn: () => void) => {
            if (!isDirty || window.confirm(t("leave"))) {
              try {
                sessionStorage.removeItem("seal:outline-dirty");
              } catch {
                /* Ignore storage errors. */
              }
              fn();
            }
          };

          const createBlankOutline = () => {
            localEditSeqRef.current += 1;
            const initial: OutlineDocument = {
              format: "seal-outline-1",
              volumes: [{ name: "投标文件" }],
              nodes: [],
            };
            setDraftOutline(initial);
            setActiveVolume("投标文件");
            setUndoStack([]);
            setRedoStack([]);
          };

          if (!draftOutline) {
            return h(
              "section",
              { className: "seal-stack" },
              h(
                "div",
                { className: "seal-outline-topbar" },
                h(
                  "div",
                  { className: "seal-row" },
                  payload.binding?.sessionId &&
                    h(
                      "button",
                      {
                        type: "button",
                        className: "seal-btn-sm",
                        onClick: () =>
                          void openReview(payload.binding!.sessionId!),
                      },
                      t("backToSession"),
                    ),
                  h(
                    "button",
                    {
                      type: "button",
                      className: "seal-btn-sm",
                      onClick: props.onBackToProjects,
                    },
                    t("backToProjects"),
                  ),
                  h("strong", null, payload.project.name),
                ),
                h(
                  "button",
                  {
                    type: "button",
                    className: "seal-btn-sm",
                    onClick: () => {
                      loadedRevisionRef.current = "";
                      setReloadTick((v) => v + 1);
                    },
                  },
                  t("refresh"),
                ),
              ),
              payload.outline.kind === "error" &&
                h(
                  "p",
                  { className: "seal-error", role: "alert" },
                  payload.outline.reason,
                ),
              h(
                "div",
                { className: "seal-empty-hero" },
                h("h2", null, t("outlineEditorTitle")),
                h("p", { className: "seal-muted" }, t("outlineNoOutlineYet")),
                h(
                  "button",
                  {
                    type: "button",
                    className: "seal-btn-primary",
                    onClick: createBlankOutline,
                  },
                  t("outlineCreateBlank"),
                ),
              ),
            );
          }

          const liveConfirmationStatus: OutlineConfirmationStatus =
            isDirty && payload.view.confirmationStatus === "confirmed"
              ? "stale"
              : payload.view.confirmationStatus;
          const liveView = buildOutlineView({
            outlineState: { kind: "value", outline: draftOutline },
            confirmationStatus: liveConfirmationStatus,
            confirmedAt:
              liveConfirmationStatus === "confirmed"
                ? payload.view.confirmedAt
                : null,
            baselineOutline,
            requirements: payload.requirements,
            kbRecords: payload.kbRecords,
            materials: payload.materials,
            c17Issues: payload.view.c17Issues,
          });
          const volumeName = draftOutline.volumes.some(
            (v) => v.name === activeVolume,
          )
            ? activeVolume
            : (draftOutline.volumes[0]?.name ?? "");
          const filterCounts = outlineFilterCounts(liveView.rows, volumeName);
          const filteredRows = filterOutlineRows(liveView.rows, {
            query,
            filter,
            volume: volumeName,
          });
          const collapsedSet = new Set(collapsedIds);
          const filteringActive = Boolean(query.trim()) || filter !== "all";
          const visibleRows = filteringActive
            ? filteredRows
            : (() => {
                const rowMap = new Map(
                  filteredRows.map((row) => [row.id, row]),
                );
                return filteredRows.filter((row) => {
                  let parentId = row.parentId;
                  while (parentId !== null) {
                    if (collapsedSet.has(parentId)) return false;
                    parentId = rowMap.get(parentId)?.parentId ?? null;
                  }
                  return true;
                });
              })();
          const navRows = filterOutlineRows(liveView.rows, {
            query,
            filter: "all",
            volume: volumeName,
          });
          const selectedRow: OutlineRowView | null =
            selectedNodeId !== null
              ? (liveView.rows.find((row) => row.id === selectedNodeId) ?? null)
              : null;

          const statusMeta = outlineStatusMeta({
            kind: "value",
            confirmationStatus: liveView.confirmationStatus,
            confirmedAt: liveView.confirmedAt,
            ...liveView.summary,
          });

          const saveDraftOutline = async (): Promise<
            Extract<OutlineGetResponse, { projectKind: "project" }>
          > => {
            const sentSeq = localEditSeqRef.current;
            try {
              const saved = await api<
                Extract<OutlineGetResponse, { projectKind: "project" }>
              >("outline_save", {
                projectId: props.projectId,
                expectedRevision: serverRevision,
                volumes: draftOutline.volumes,
                nodes: draftOutline.nodes,
              });
              const reconciled = reconcileOutlineSaveResult(
                {
                  serverRevision,
                  baselineOutline,
                  draftOutline,
                  undoStack,
                  redoStack,
                  conflictError,
                  confirmMissing,
                },
                saved,
                sentSeq,
                localEditSeqRef.current,
              );
              if (reconciled.syncedDraft) {
                syncFromPayload(saved);
              } else {
                setServerRevision(reconciled.state.serverRevision);
                loadedRevisionRef.current = reconciled.state.serverRevision;
                setBaselineOutline(reconciled.state.baselineOutline);
                setConflictError(reconciled.state.conflictError);
              }
              props.onReloadOverview();
              return saved;
            } catch (error) {
              const msg = error instanceof Error ? error.message : String(error);
              if (msg.includes("版本冲突")) setConflictError(msg);
              throw error;
            }
          };

          const executeConfirmOutline = () =>
            action.run(
              () =>
                runOutlineConfirmFlow({
                  getEditSeq: () => localEditSeqRef.current,
                  isDirty,
                  initialRevision: serverRevision,
                  saveDraft: saveDraftOutline,
                  confirmOutline: (expectedRevision) =>
                    api<{
                      confirmed: boolean;
                      digest: string;
                      confirmedAt: string;
                      prompt: string;
                    }>("outline_confirm", {
                      projectId: props.projectId,
                      expectedRevision,
                    }),
                  onConfirmFinished: () => setConfirmMissing(false),
                  onClearDirty: () => {
                    try {
                      sessionStorage.removeItem("seal:outline-dirty");
                    } catch {
                      /* Ignore storage errors. */
                    }
                  },
                  onReloadOverview: props.onReloadOverview,
                  sessionId: payload.binding?.sessionId ?? null,
                  sendPrompt: (sid, prompt) => send(sid, prompt),
                  openReview: (sid) => openReview(sid),
                  onReloadUnbound: () => {
                    loadedRevisionRef.current = "";
                    setReloadTick((v) => v + 1);
                  },
                }),
              t("sent"),
            );

          const levelLabel = (level: number) =>
            t(`outlineLevel${Math.min(6, Math.max(1, level))}` as DictionaryKey);

          const kindLabel = (kind: OutlineNodeKind) =>
            kind === "template"
              ? t("outlineKindTemplate")
              : kind === "authored"
                ? t("outlineKindAuthored")
                : t("outlineKindAttachment");

          const addNodeHelper = (opts: {
            parentId: string | null;
            level: number;
            afterNodeId?: string;
            title?: string;
            kind?: OutlineNodeKind;
            requirementIds?: string[];
          }) => {
            const existingIds = new Set(draftOutline.nodes.map((n) => n.id));
            const newId = createOutlineNodeId(existingIds, "sec");
            const targetVolume =
              volumeName || draftOutline.volumes[0]?.name || "投标文件";
            const volumes =
              draftOutline.volumes.length > 0
                ? draftOutline.volumes
                : [{ name: targetVolume }];
            const newNode: OutlineNode = {
              id: newId,
              volume: targetVolume,
              parentId: opts.parentId,
              level: Math.min(6, Math.max(1, opts.level)),
              title: opts.title ?? "新增章节",
              kind: opts.kind ?? "authored",
              included: true,
              ...(opts.requirementIds
                ? { requirementIds: opts.requirementIds }
                : {}),
            };
            const next = addOutlineNode(
              { ...draftOutline, volumes },
              newNode,
              {
                parentId: opts.parentId,
                ...(opts.afterNodeId ? { afterNodeId: opts.afterNodeId } : {}),
                updatedBy: "human",
              },
            );
            commitEdit(next);
            setSelectedNodeId(newId);
            if (opts.parentId) {
              setCollapsedIds((prev) =>
                prev.filter((id) => id !== opts.parentId),
              );
            }
          };

          const allRequirements =
            payload.requirements.kind === "value"
              ? [...payload.requirements.items].sort(
                  (a, b) => Number(b.mustRespond) - Number(a.mustRespond),
                )
              : [];
          const coveredReqIds = new Set<string>();
          for (const node of draftOutline.nodes) {
            if (!node.included) continue;
            for (const reqId of node.requirementIds ?? []) {
              coveredReqIds.add(reqId);
            }
          }

          const uploadTargets = [
            ...uploadFiles.map((f) => f.path),
            ...(uploadPath.trim() ? [uploadPath.trim()] : []),
          ];

          const handleUploadMaterial = (nodeId: string) =>
            action.run(async () => {
              const targetFile = uploadTargets[0];
              if (!targetFile) throw new Error("请选择或输入本地材料文件路径");
              const nodeOnDisk = Boolean(
                baselineOutline?.nodes.some((node) => node.id === nodeId),
              );
              const persistDirectly = !isDirty && nodeOnDisk;
              try {
                const res = await api<
                  { binding: OutlineEvidenceBinding } & Extract<
                    OutlineGetResponse,
                    { projectKind: "project" }
                  >
                >("outline_upload_material", {
                  projectId: props.projectId,
                  expectedRevision: serverRevision,
                  filePath: targetFile,
                  ...(persistDirectly ? { nodeId } : {}),
                });
                setUploadFiles([]);
                setUploadPath("");
                if (persistDirectly) {
                  syncFromPayload(res);
                } else {
                  setServerRevision(res.revision);
                  loadedRevisionRef.current = res.revision;
                  if (res.outline.kind === "value") {
                    setBaselineOutline(res.outline.outline);
                  }
                  const updatedLocal = bindEvidenceToNode(
                    draftOutline,
                    nodeId,
                    res.binding,
                    { updatedBy: "human" },
                  );
                  commitEdit(updatedLocal);
                }
                props.onReloadOverview();
              } catch (error) {
                const msg =
                  error instanceof Error ? error.message : String(error);
                if (msg.includes("版本冲突")) setConflictError(msg);
                throw error;
              }
            }, t("processed"));

          const handleAddVolume = () => {
            const trimmed = newVolumeName.trim();
            if (!trimmed) return;
            if (draftOutline.volumes.some((v) => v.name === trimmed)) return;
            commitEdit({
              ...draftOutline,
              volumes: [...draftOutline.volumes, { name: trimmed }],
            });
            setActiveVolume(trimmed);
            setNewVolumeName("");
            setShowAddVolume(false);
          };

          const nowIso = new Date().toISOString();
          const selectedLocked = Boolean(
            selectedRow?.lockedTemplate && !selectedRow?.optional,
          );
          const missingRows = liveView.rows.filter(
            (r) => r.included && r.resolvedMaterialStatus === "missing",
          );

          return h(
            "section",
            { className: "seal-stack" },
            h(
              "div",
              { className: "seal-outline-topbar" },
              h(
                "div",
                { className: "seal-row" },
                payload.binding?.sessionId &&
                  h(
                    "button",
                    {
                      type: "button",
                      className: "seal-btn-sm",
                      onClick: () =>
                        leaveWithGuard(
                          () => void openReview(payload.binding!.sessionId!),
                        ),
                    },
                    t("backToSession"),
                  ),
                h(
                  "button",
                  {
                    type: "button",
                    className: "seal-btn-sm",
                    onClick: () => leaveWithGuard(props.onBackToProjects),
                  },
                  t("backToProjects"),
                ),
                h("strong", null, payload.project.name),
                h("span", { className: statusMeta.className }, statusMeta.label),
                h(
                  "span",
                  { className: "seal-badge" },
                  t("outlineSafeNotice"),
                ),
              ),
              h(
                "div",
                { className: "seal-row" },
                isDirty &&
                  h(
                    "span",
                    { className: "seal-badge seal-badge-warn" },
                    t("outlineUnsaved"),
                  ),
                h(
                  "button",
                  {
                    type: "button",
                    className: "seal-btn-sm",
                    disabled: undoStack.length === 0 || action.busy,
                    onClick: undo,
                  },
                  t("outlineUndo"),
                ),
                h(
                  "button",
                  {
                    type: "button",
                    className: "seal-btn-sm",
                    disabled: redoStack.length === 0 || action.busy,
                    onClick: redo,
                  },
                  t("outlineRedo"),
                ),
                h(
                  "button",
                  {
                    type: "button",
                    className: "seal-btn-sm",
                    disabled: !isDirty || action.busy,
                    onClick: () =>
                      action.run(() => saveDraftOutline(), t("outlineSaved")),
                  },
                  t("outlineSave"),
                ),
                h(
                  "button",
                  {
                    type: "button",
                    className: "seal-btn-primary seal-btn-sm",
                    disabled:
                      action.busy || liveView.summary.includedNodes === 0,
                    onClick: () => {
                      if (liveView.summary.missingMaterials > 0) {
                        setConfirmMissing(true);
                      } else {
                        void executeConfirmOutline();
                      }
                    },
                  },
                  t(
                    payload.project.drafts.length > 0
                      ? "outlineReconfirm"
                      : "outlineConfirmStart",
                  ),
                ),
              ),
            ),
            conflictError &&
              h(
                "div",
                { className: "seal-callout seal-callout-warn", role: "alert" },
                h(
                  "div",
                  { className: "seal-callout-body" },
                  h("strong", null, conflictError),
                  h("span", { className: "seal-small" }, t("outlineConflictBanner")),
                ),
                h(
                  "button",
                  {
                    type: "button",
                    className: "seal-btn-sm",
                    onClick: () => {
                      loadedRevisionRef.current = "";
                      setReloadTick((v) => v + 1);
                    },
                  },
                  t("outlineReloadLatest"),
                ),
              ),
            confirmMissing &&
              h(
                "div",
                { className: "seal-confirm-inline", role: "region" },
                h(
                  "span",
                  { className: "seal-confirm-inline-text" },
                  `${t("outlineConfirmMissingWarn")}（${liveView.summary.missingMaterials} ${t("count")}）`,
                ),
                h(
                  "div",
                  { className: "seal-row" },
                  h(
                    "button",
                    {
                      type: "button",
                      className: "seal-btn-primary seal-btn-sm",
                      disabled: action.busy,
                      onClick: () => void executeConfirmOutline(),
                    },
                    t("outlineConfirmAnyway"),
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      className: "seal-btn-sm",
                      disabled: action.busy,
                      onClick: () => {
                        setConfirmMissing(false);
                        setFilter("missing_material");
                      },
                    },
                    t("cancelDelete"),
                  ),
                ),
              ),
            h(
              "div",
              { className: "seal-row seal-between" },
              h(
                "div",
                { className: "seal-segmented", role: "tablist" },
                ...draftOutline.volumes.map((vol) =>
                  h(
                    "button",
                    {
                      key: vol.name,
                      type: "button",
                      role: "tab",
                      "aria-selected": volumeName === vol.name,
                      onClick: () => {
                        setActiveVolume(vol.name);
                        setSelectedNodeId(null);
                      },
                    },
                    vol.name,
                  ),
                ),
              ),
              h(
                "div",
                { className: "seal-row" },
                showAddVolume
                  ? h(
                      "div",
                      { className: "seal-row" },
                      h("input", {
                        value: newVolumeName,
                        placeholder: t("outlineVolumePlaceholder"),
                        style: { width: 200 },
                        onChange: (e: any) => setNewVolumeName(e.target.value),
                      }),
                      h(
                        "button",
                        {
                          type: "button",
                          className: "seal-btn-primary seal-btn-sm",
                          disabled: !newVolumeName.trim(),
                          onClick: handleAddVolume,
                        },
                        t("outlineAddVolumeConfirm"),
                      ),
                      h(
                        "button",
                        {
                          type: "button",
                          className: "seal-btn-ghost seal-btn-sm",
                          onClick: () => setShowAddVolume(false),
                        },
                        t("cancelDelete"),
                      ),
                    )
                  : h(
                      "button",
                      {
                        type: "button",
                        className: "seal-btn-sm",
                        onClick: () => setShowAddVolume(true),
                      },
                      t("outlineAddVolume"),
                    ),
              ),
            ),
            h(
              "div",
              { className: "seal-outline-filters", role: "group" },
              ...(
                [
                  ["all", t("outlineFilterAll")],
                  ["missing_material", t("outlineFilterMissing")],
                  ["needs_review", t("outlineFilterNeedsReview")],
                  ["uncovered_req", t("outlineFilterUncovered")],
                  ["template", t("outlineFilterTemplate")],
                  ["authored", t("outlineFilterAuthored")],
                  ["attachment", t("outlineFilterAttachment")],
                  ["excluded", t("outlineFilterExcluded")],
                  ...(filterCounts.c17 > 0
                    ? ([["c17", t("outlineFilterC17")]] as const)
                    : []),
                ] as ReadonlyArray<readonly [OutlineRowFilter, string]>
              ).map(([key, label]) =>
                h(
                  "button",
                  {
                    key,
                    type: "button",
                    className: "seal-section-chip",
                    "aria-pressed": filter === key,
                    onClick: () => setFilter(key),
                  },
                  `${label} (${filterCounts[key]})`,
                ),
              ),
            ),
            actionStatus(action),
            h(
              "div",
              { className: "seal-outline-grid" },
              h(
                "aside",
                { className: "seal-outline-nav" },
                h(
                  "div",
                  { className: "seal-row seal-between" },
                  h("h3", null, t("outlineNavTitle")),
                  selectedNodeId &&
                    h(
                      "button",
                      {
                        type: "button",
                        className: "seal-btn-ghost seal-btn-sm",
                        onClick: () => setSelectedNodeId(null),
                      },
                      t("outlineDetailOverview"),
                    ),
                ),
                h("input", {
                  value: query,
                  placeholder: t("outlineSearchPlaceholder"),
                  "aria-label": t("outlineSearchPlaceholder"),
                  onChange: (e: any) => setQuery(e.target.value),
                }),
                h(
                  "div",
                  { className: "seal-outline-nav-list" },
                  ...navRows.map((row) =>
                    h(
                      "button",
                      {
                        key: row.id,
                        type: "button",
                        className: "seal-outline-nav-item",
                        "aria-current":
                          selectedNodeId === row.id ? "true" : undefined,
                        style: {
                          paddingLeft: `${8 + row.depth * 12}px`,
                          textDecoration: row.included ? "none" : "line-through",
                        },
                        onClick: () => setSelectedNodeId(row.id),
                      },
                      `${row.number ? `${row.number} ` : ""}${row.title}`,
                    ),
                  ),
                ),
                h(
                  "div",
                  { className: "seal-outline-stat-grid" },
                  h(
                    "div",
                    { className: "seal-outline-stat-cell" },
                    h("span", { className: "seal-small" }, t("outlineStatChanges")),
                    h("strong", null, liveView.summary.changesCount),
                  ),
                  h(
                    "div",
                    { className: "seal-outline-stat-cell" },
                    h("span", { className: "seal-small" }, t("outlineStatExcluded")),
                    h("strong", null, liveView.summary.excludedNodes),
                  ),
                  h(
                    "div",
                    { className: "seal-outline-stat-cell" },
                    h("span", { className: "seal-small" }, t("outlineStatMissing")),
                    h("strong", null, liveView.summary.missingMaterials),
                  ),
                  h(
                    "div",
                    { className: "seal-outline-stat-cell" },
                    h("span", { className: "seal-small" }, t("outlineStatUncovered")),
                    h("strong", null, liveView.summary.uncoveredRequirements),
                  ),
                ),
              ),
              h(
                "section",
                { className: "seal-outline-main" },
                h(
                  "div",
                  { className: "seal-row seal-between" },
                  h(
                    "h2",
                    { style: { margin: 0 } },
                    `${t("outlineTreeTitle")} · ${liveView.summary.includedNodes}`,
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      className: "seal-btn-primary seal-btn-sm",
                      onClick: () =>
                        addNodeHelper({ parentId: null, level: 1 }),
                    },
                    t("outlineAddRoot"),
                  ),
                ),
                visibleRows.length === 0
                  ? h("p", { className: "seal-muted" }, t("outlineEmptyTreeHint"))
                  : visibleRows.map((row) => {
                      const isSelected = selectedNodeId === row.id;
                      const isLocked = Boolean(
                        row.lockedTemplate && !row.optional,
                      );
                      const isCollapsed = collapsedSet.has(row.id);
                      return h(
                        "article",
                        {
                          key: row.id,
                          className: `seal-outline-row${isSelected ? " seal-outline-row-selected" : ""}${row.included ? "" : " seal-outline-row-excluded"}`,
                          style: { marginLeft: `${row.depth * 18}px` },
                          "data-seal-outline-node": row.id,
                        },
                        h(
                          "div",
                          { className: "seal-outline-row-head" },
                          row.hasChildren && !filteringActive
                            ? h(
                                "button",
                                {
                                  type: "button",
                                  className: "seal-btn-ghost seal-outline-collapse",
                                  "aria-label": row.title,
                                  onClick: () =>
                                    setCollapsedIds((prev) =>
                                      isCollapsed
                                        ? prev.filter((id) => id !== row.id)
                                        : [...prev, row.id],
                                    ),
                                },
                                isCollapsed ? "▸" : "▾",
                              )
                            : null,
                          h(
                            "span",
                            { className: "seal-outline-level" },
                            levelLabel(row.level),
                          ),
                          isSelected && !isLocked
                            ? h(
                                "div",
                                {
                                  className: "seal-row",
                                  style: { flex: "1 1 220px" },
                                },
                                h("input", {
                                  value: row.number ?? "",
                                  placeholder: t("outlineNodeNumber"),
                                  style: { width: 84, flex: "0 0 84px" },
                                  onChange: (e: any) =>
                                    commitEdit(
                                      updateOutlineNode(
                                        draftOutline,
                                        row.id,
                                        {
                                          number: e.target.value || undefined,
                                        },
                                        { updatedAt: nowIso, updatedBy: "human" },
                                      ),
                                    ),
                                }),
                                h("input", {
                                  value:
                                    titleDraft?.id === row.id
                                      ? titleDraft.value
                                      : row.title,
                                  style: { flex: "1 1 140px" },
                                  onChange: (e: any) => {
                                    const nextVal = String(e.target.value);
                                    setTitleDraft({ id: row.id, value: nextVal });
                                    if (nextVal.trim()) {
                                      commitEdit(
                                        updateOutlineNode(
                                          draftOutline,
                                          row.id,
                                          { title: nextVal },
                                          { updatedAt: nowIso, updatedBy: "human" },
                                        ),
                                      );
                                    }
                                  },
                                  onBlur: () => setTitleDraft(null),
                                }),
                              )
                            : h(
                                "span",
                                {
                                  className: "seal-outline-row-title",
                                  style: {
                                    textDecoration: row.included
                                      ? "none"
                                      : "line-through",
                                  },
                                  onClick: () => setSelectedNodeId(row.id),
                                },
                                `${row.number ? `${row.number} ` : ""}${row.title}`,
                              ),
                          h(
                            "div",
                            {
                              className: "seal-row",
                              onClick: () => setSelectedNodeId(row.id),
                            },
                            h(
                              "span",
                              { className: "seal-badge" },
                              isLocked
                                ? t("outlineLockedTemplate")
                                : kindLabel(row.kind),
                            ),
                            row.resolvedMaterialStatus === "missing" &&
                              h(
                                "span",
                                { className: "seal-badge seal-badge-warn" },
                                t("outlineMatMissing"),
                              ),
                            row.resolvedMaterialStatus === "needs_review" &&
                              h(
                                "span",
                                { className: "seal-badge seal-badge-warn" },
                                t("outlineMatNeedsReview"),
                              ),
                            row.resolvedMaterialStatus === "ready" &&
                              h(
                                "span",
                                { className: "seal-badge seal-badge-ok" },
                                t("outlineMatReady"),
                              ),
                            (row.requirementIds?.length ?? 0) > 0 &&
                              h(
                                "span",
                                { className: "seal-badge seal-badge-info" },
                                `${row.requirementIds!.length} ${t("outlineReqCountSuffix")}`,
                              ),
                            row.c17Issues.length > 0 &&
                              h(
                                "span",
                                { className: "seal-badge seal-badge-error" },
                                `C17 (${row.c17Issues.length})`,
                              ),
                          ),
                        ),
                        isSelected &&
                          h(
                            "div",
                            { className: "seal-stack-sm" },
                            h(
                              "div",
                              { className: "seal-row" },
                              h(
                                "button",
                                {
                                  type: "button",
                                  className: "seal-btn-sm",
                                  onClick: () =>
                                    addNodeHelper({
                                      parentId: row.parentId,
                                      level: row.level,
                                      afterNodeId: row.id,
                                    }),
                                },
                                t("outlineAddSibling"),
                              ),
                              h(
                                "button",
                                {
                                  type: "button",
                                  className: "seal-btn-sm",
                                  disabled: row.level >= 6,
                                  onClick: () =>
                                    addNodeHelper({
                                      parentId: row.id,
                                      level: Math.min(6, row.level + 1),
                                      afterNodeId: row.id,
                                    }),
                                },
                                t("outlineAddChild"),
                              ),
                              h(
                                "button",
                                {
                                  type: "button",
                                  className: "seal-btn-sm",
                                  disabled: !canMoveOutlineNode(
                                    draftOutline,
                                    row.id,
                                    "up",
                                  ),
                                  onClick: () =>
                                    commitEdit(
                                      moveOutlineNode(
                                        draftOutline,
                                        row.id,
                                        "up",
                                        { updatedAt: nowIso, updatedBy: "human" },
                                      ),
                                    ),
                                },
                                `↑ ${t("outlineMoveUp")}`,
                              ),
                              h(
                                "button",
                                {
                                  type: "button",
                                  className: "seal-btn-sm",
                                  disabled: !canMoveOutlineNode(
                                    draftOutline,
                                    row.id,
                                    "down",
                                  ),
                                  onClick: () =>
                                    commitEdit(
                                      moveOutlineNode(
                                        draftOutline,
                                        row.id,
                                        "down",
                                        { updatedAt: nowIso, updatedBy: "human" },
                                      ),
                                    ),
                                },
                                `↓ ${t("outlineMoveDown")}`,
                              ),
                              h(
                                "button",
                                {
                                  type: "button",
                                  className: "seal-btn-sm",
                                  disabled: !canOutdentOutlineNode(
                                    draftOutline,
                                    row.id,
                                  ),
                                  onClick: () =>
                                    commitEdit(
                                      outdentOutlineNode(draftOutline, row.id, {
                                        updatedAt: nowIso,
                                        updatedBy: "human",
                                      }),
                                    ),
                                },
                                `← ${t("outlineOutdent")}`,
                              ),
                              h(
                                "button",
                                {
                                  type: "button",
                                  className: "seal-btn-sm",
                                  disabled:
                                    row.level >= 6 ||
                                    !canIndentOutlineNode(draftOutline, row.id),
                                  onClick: () =>
                                    commitEdit(
                                      indentOutlineNode(draftOutline, row.id, {
                                        updatedAt: nowIso,
                                        updatedBy: "human",
                                      }),
                                    ),
                                },
                                `→ ${t("outlineIndent")}`,
                              ),
                              h(
                                "button",
                                {
                                  type: "button",
                                  className: "seal-btn-sm",
                                  disabled: isLocked,
                                  onClick: () =>
                                    commitEdit(
                                      updateOutlineNode(
                                        draftOutline,
                                        row.id,
                                        { included: !row.included },
                                        { updatedAt: nowIso, updatedBy: "human" },
                                      ),
                                    ),
                                },
                                t(
                                  row.included
                                    ? "outlineSkip"
                                    : "outlineInclude",
                                ),
                              ),
                              h(
                                "button",
                                {
                                  type: "button",
                                  className: "seal-btn-danger seal-btn-sm",
                                  disabled: !canDeleteOutlineNode(
                                    draftOutline,
                                    row.id,
                                  ),
                                  onClick: () => deleteConfirm.open(row.id),
                                },
                                t("outlineDeleteNode"),
                              ),
                            ),
                            deleteConfirm.targetKey === row.id &&
                              h(
                                "div",
                                { className: "seal-confirm-inline" },
                                h(
                                  "span",
                                  { className: "seal-confirm-inline-text" },
                                  `${t("outlineDeleteConfirm")}（${row.title}）`,
                                ),
                                h(
                                  "div",
                                  { className: "seal-row" },
                                  h(
                                    "button",
                                    {
                                      type: "button",
                                      className:
                                        "seal-btn-danger-solid seal-btn-sm",
                                      onClick: () => {
                                        deleteConfirm.close();
                                        commitEdit(
                                          deleteOutlineNode(
                                            draftOutline,
                                            row.id,
                                            {
                                              updatedAt: nowIso,
                                              updatedBy: "human",
                                            },
                                          ),
                                        );
                                        setSelectedNodeId(null);
                                      },
                                    },
                                    t("confirmDelete"),
                                  ),
                                  h(
                                    "button",
                                    {
                                      type: "button",
                                      className: "seal-btn-sm",
                                      onClick: deleteConfirm.close,
                                    },
                                    t("cancelDelete"),
                                  ),
                                ),
                              ),
                          ),
                      );
                    }),
              ),
              h(
                "aside",
                { className: "seal-outline-drawer" },
                selectedRow
                  ? h(
                      React.Fragment,
                      null,
                      h(
                        "div",
                        { className: "seal-row seal-between" },
                        h("h3", null, t("outlineDetailTitle")),
                        h(
                          "button",
                          {
                            type: "button",
                            className: "seal-btn-ghost seal-btn-sm",
                            onClick: () => setSelectedNodeId(null),
                          },
                          t("closeDetail"),
                        ),
                      ),
                      h(
                        "label",
                        null,
                        t("outlineNodeNumber"),
                        h("input", {
                          value: selectedRow.number ?? "",
                          onChange: (e: any) =>
                            commitEdit(
                              updateOutlineNode(
                                draftOutline,
                                selectedRow.id,
                                { number: e.target.value || undefined },
                                { updatedAt: nowIso, updatedBy: "human" },
                              ),
                            ),
                        }),
                      ),
                      h(
                        "label",
                        null,
                        t("outlineNodeTitle"),
                        h("input", {
                          value:
                            titleDraft?.id === selectedRow.id
                              ? titleDraft.value
                              : selectedRow.title,
                          disabled: selectedLocked,
                          onChange: (e: any) => {
                            const nextVal = String(e.target.value);
                            setTitleDraft({
                              id: selectedRow.id,
                              value: nextVal,
                            });
                            if (nextVal.trim()) {
                              commitEdit(
                                updateOutlineNode(
                                  draftOutline,
                                  selectedRow.id,
                                  { title: nextVal },
                                  { updatedAt: nowIso, updatedBy: "human" },
                                ),
                              );
                            }
                          },
                          onBlur: () => setTitleDraft(null),
                        }),
                      ),
                      h(
                        "label",
                        null,
                        t("outlineNodeKind"),
                        h(
                          "select",
                          {
                            value: selectedRow.kind,
                            disabled: selectedLocked,
                            onChange: (e: any) =>
                              commitEdit(
                                updateOutlineNode(
                                  draftOutline,
                                  selectedRow.id,
                                  { kind: e.target.value as OutlineNodeKind },
                                  { updatedAt: nowIso, updatedBy: "human" },
                                ),
                              ),
                          },
                          h("option", { value: "template" }, t("outlineKindTemplate")),
                          h("option", { value: "authored" }, t("outlineKindAuthored")),
                          h(
                            "option",
                            { value: "attachment" },
                            t("outlineKindAttachment"),
                          ),
                        ),
                      ),
                      h(
                        "div",
                        { className: "seal-row" },
                        h("input", {
                          id: `inc-${selectedRow.id}`,
                          type: "checkbox",
                          checked: selectedRow.included,
                          disabled: selectedLocked,
                          onChange: (e: any) =>
                            commitEdit(
                              updateOutlineNode(
                                draftOutline,
                                selectedRow.id,
                                { included: Boolean(e.target.checked) },
                                { updatedAt: nowIso, updatedBy: "human" },
                              ),
                            ),
                        }),
                        h(
                          "span",
                          { className: "seal-small" },
                          t("outlineIncludedToggle"),
                        ),
                      ),
                      selectedRow.kind === "template" &&
                        h(
                          "div",
                          { className: "seal-row" },
                          h("input", {
                            id: `opt-${selectedRow.id}`,
                            type: "checkbox",
                            checked: Boolean(selectedRow.optional),
                            disabled: selectedLocked,
                            onChange: (e: any) =>
                              commitEdit(
                                updateOutlineNode(
                                  draftOutline,
                                  selectedRow.id,
                                  { optional: Boolean(e.target.checked) },
                                  { updatedAt: nowIso, updatedBy: "human" },
                                ),
                              ),
                          }),
                          h(
                            "span",
                            { className: "seal-small" },
                            t("outlineNodeOptional"),
                          ),
                        ),
                      h(
                        "label",
                        null,
                        t("outlineNodeExpectedHeading"),
                        h("input", {
                          value: selectedRow.expectedHeading ?? "",
                          placeholder: selectedRow.title,
                          onChange: (e: any) =>
                            commitEdit(
                              updateOutlineNode(
                                draftOutline,
                                selectedRow.id,
                                {
                                  expectedHeading: e.target.value || undefined,
                                },
                                { updatedAt: nowIso, updatedBy: "human" },
                              ),
                            ),
                        }),
                      ),
                      h(
                        "label",
                        null,
                        t("outlineNodeNote"),
                        h("textarea", {
                          value: selectedRow.note ?? "",
                          placeholder: t("outlineNodeNotePlaceholder"),
                          onChange: (e: any) =>
                            commitEdit(
                              updateOutlineNode(
                                draftOutline,
                                selectedRow.id,
                                { note: e.target.value || undefined },
                                { updatedAt: nowIso, updatedBy: "human" },
                              ),
                            ),
                        }),
                      ),
                      h(
                        "div",
                        { className: "seal-stack-sm seal-divider" },
                        h("h3", null, t("outlineEvidenceSection")),
                        ...selectedRow.resolvedEvidence.map((ev) => {
                          const materialHref =
                            ev.source === "material"
                              ? `/api/seal/file?${new URLSearchParams({ projectId: props.projectId, material: ev.ref })}`
                              : "";
                          const isImg =
                            ev.source === "material" &&
                            /\.(png|jpe?g|webp|bmp|tif|tiff|gif|svg)$/i.test(
                              ev.ref,
                            );
                          return h(
                            "div",
                            {
                              key: `${ev.source}:${ev.ref}`,
                              className: "seal-card-compact seal-stack-sm",
                            },
                            h(
                              "div",
                              { className: "seal-row seal-between" },
                              h(
                                "strong",
                                { className: "seal-small" },
                                ev.title ?? ev.label ?? ev.ref,
                              ),
                              h(
                                "button",
                                {
                                  type: "button",
                                  className: "seal-btn-ghost seal-btn-sm",
                                  onClick: () =>
                                    commitEdit(
                                      unbindEvidenceFromNode(
                                        draftOutline,
                                        selectedRow.id,
                                        ev.source,
                                        ev.ref,
                                        { updatedAt: nowIso, updatedBy: "human" },
                                      ),
                                    ),
                                },
                                t("outlineUnbind"),
                              ),
                            ),
                            h(
                              "div",
                              { className: "seal-row" },
                              h(
                                "span",
                                {
                                  className: `seal-badge ${ev.status === "ready" ? "seal-badge-ok" : ev.status === "unverified" ? "seal-badge-warn" : "seal-badge-error"}`,
                                },
                                ev.source === "kb"
                                  ? ev.status === "ready"
                                    ? t("verified")
                                    : ev.status === "unverified"
                                      ? t("unverified")
                                      : t("outlineMatMissing")
                                  : ev.status === "ready"
                                    ? t("outlineMatReady")
                                    : t("outlineMatMissing"),
                              ),
                              ev.renderedPages &&
                                ev.renderedPages.length > 0 &&
                                h(
                                  "span",
                                  { className: "seal-badge seal-badge-info" },
                                  `${t("outlinePdfPagesCount")} ${ev.renderedPages.length} 页`,
                                ),
                              materialHref &&
                                h(
                                  "a",
                                  {
                                    className: "seal-link seal-btn-sm",
                                    href: materialHref,
                                    target: "_blank",
                                    rel: "noreferrer",
                                  },
                                  t("outlinePreviewFile"),
                                ),
                            ),
                            isImg &&
                              h("img", {
                                src: materialHref,
                                className: "seal-outline-preview-thumb",
                                alt: ev.label ?? ev.ref,
                              }),
                            ev.renderedPages &&
                              ev.renderedPages.length > 0 &&
                              h(
                                "div",
                                { className: "seal-row" },
                                ...ev.renderedPages.slice(0, 4).map((page, idx) =>
                                  h("img", {
                                    key: page,
                                    src: `/api/seal/file?${new URLSearchParams({ projectId: props.projectId, material: page })}`,
                                    className: "seal-outline-preview-thumb",
                                    alt: `${ev.label ?? ev.ref} · ${idx + 1}`,
                                  }),
                                ),
                              ),
                          );
                        }),
                        payload.kbRecords.length > 0 &&
                          h(
                            "div",
                            { className: "seal-stack-sm" },
                            h(
                              "label",
                              null,
                              t("outlineBindKbLabel"),
                              h(
                                "select",
                                {
                                  value: selectedKbId,
                                  onChange: (e: any) =>
                                    setSelectedKbId(e.target.value),
                                },
                                h("option", { value: "" }, t("outlineSelectKbOption")),
                                ...payload.kbRecords.map((rec) =>
                                  h(
                                    "option",
                                    { key: rec.id, value: rec.id },
                                    `${rec.title ?? rec.id}${rec.type ? ` (${rec.type})` : ""} · ${t(rec.verified ? "verified" : "unverified")}`,
                                  ),
                                ),
                              ),
                            ),
                            h(
                              "button",
                              {
                                type: "button",
                                className: "seal-btn-sm",
                                disabled: !selectedKbId,
                                onClick: () => {
                                  const rec = payload.kbRecords.find(
                                    (r) => r.id === selectedKbId,
                                  );
                                  if (!rec) return;
                                  commitEdit(
                                    bindEvidenceToNode(
                                      draftOutline,
                                      selectedRow.id,
                                      {
                                        source: "kb",
                                        ref: rec.id,
                                        ...(rec.title
                                          ? { label: rec.title }
                                          : {}),
                                      },
                                      { updatedAt: nowIso, updatedBy: "human" },
                                    ),
                                  );
                                  setSelectedKbId("");
                                },
                              },
                              t("outlineBindKbBtn"),
                            ),
                          ),
                        h(
                          "div",
                          { className: "seal-stack-sm" },
                          h("span", { className: "seal-small" }, t("outlineUploadTitle")),
                          h(FilePicker, {
                            label: t("outlineUploadHint"),
                            accept:
                              ".png,.jpg,.jpeg,.webp,.bmp,.tif,.tiff,.gif,.pdf,.docx,.txt,.md",
                            allowAny: true,
                            onFiles: setUploadFiles,
                          }),
                          uploadFiles.length > 0 &&
                            h(
                              "div",
                              { className: "seal-chips" },
                              ...uploadFiles.map((file, idx) =>
                                h(
                                  "span",
                                  { key: `${file.path}:${idx}`, className: "seal-chip" },
                                  h(
                                    "span",
                                    { className: "seal-chip-text", title: file.name },
                                    file.name,
                                  ),
                                  h(
                                    "button",
                                    {
                                      type: "button",
                                      className: "seal-chip-remove",
                                      "aria-label": file.name,
                                      onClick: () =>
                                        setUploadFiles((prev) =>
                                          prev.filter((_, i) => i !== idx),
                                        ),
                                    },
                                    "×",
                                  ),
                                ),
                              ),
                            ),
                          h(
                            "label",
                            null,
                            t("outlineUploadPathLabel"),
                            h("input", {
                              value: uploadPath,
                              placeholder: t("outlineUploadPathPlaceholder"),
                              onChange: (e: any) =>
                                setUploadPath(e.target.value),
                            }),
                          ),
                          h(
                            "button",
                            {
                              type: "button",
                              className: "seal-btn-primary seal-btn-sm",
                              disabled:
                                action.busy || uploadTargets.length === 0,
                              onClick: () =>
                                void handleUploadMaterial(selectedRow.id),
                            },
                            t("outlineUploadBtn"),
                          ),
                        ),
                        h(
                          "div",
                          { className: "seal-row" },
                          h("input", {
                            id: `missing-${selectedRow.id}`,
                            type: "checkbox",
                            checked: Boolean(selectedRow.materialMissing),
                            onChange: (e: any) =>
                              commitEdit(
                                updateOutlineNode(
                                  draftOutline,
                                  selectedRow.id,
                                  { materialMissing: Boolean(e.target.checked) },
                                  { updatedAt: nowIso, updatedBy: "human" },
                                ),
                              ),
                          }),
                          h(
                            "span",
                            { className: "seal-small" },
                            t("outlineMaterialMissingLabel"),
                          ),
                        ),
                        h(
                          "label",
                          null,
                          t("outlineMaterialNoteLabel"),
                          h("input", {
                            value: selectedRow.materialNote ?? "",
                            placeholder: t("outlineMaterialNotePlaceholder"),
                            onChange: (e: any) =>
                              commitEdit(
                                updateOutlineNode(
                                  draftOutline,
                                  selectedRow.id,
                                  { materialNote: e.target.value || undefined },
                                  { updatedAt: nowIso, updatedBy: "human" },
                                ),
                              ),
                          }),
                        ),
                      ),
                      h(
                        "div",
                        { className: "seal-stack-sm seal-divider" },
                        h("h3", null, t("outlineReqsSection")),
                        allRequirements.length === 0
                          ? h("p", { className: "seal-small" }, t("outlineReqsNone"))
                          : h(
                              "div",
                              { className: "seal-outline-req-list" },
                              ...allRequirements.map((req) => {
                                const checked = (
                                  selectedRow.requirementIds ?? []
                                ).includes(req.id);
                                const uncovered =
                                  req.mustRespond && !coveredReqIds.has(req.id);
                                return h(
                                  "label",
                                  {
                                    key: req.id,
                                    className: "seal-outline-req-item",
                                  },
                                  h("input", {
                                    type: "checkbox",
                                    checked,
                                    onChange: () => {
                                      const current =
                                        selectedRow.requirementIds ?? [];
                                      const nextIds = checked
                                        ? current.filter((id) => id !== req.id)
                                        : [...current, req.id];
                                      commitEdit(
                                        updateOutlineNode(
                                          draftOutline,
                                          selectedRow.id,
                                          { requirementIds: nextIds },
                                          { updatedAt: nowIso, updatedBy: "human" },
                                        ),
                                      );
                                    },
                                  }),
                                  h(
                                    "div",
                                    { className: "seal-stack-sm" },
                                    h(
                                      "div",
                                      { className: "seal-row" },
                                      h("strong", { className: "seal-small" }, req.id),
                                      req.mustRespond &&
                                        h(
                                          "span",
                                          { className: "seal-badge" },
                                          t("mustRespond"),
                                        ),
                                      uncovered &&
                                        h(
                                          "span",
                                          { className: "seal-badge seal-badge-warn" },
                                          t("outlineReqUncoveredTag"),
                                        ),
                                    ),
                                    h("span", { className: "seal-small" }, req.text),
                                  ),
                                );
                              }),
                            ),
                      ),
                      h(
                        "div",
                        { className: "seal-stack-sm seal-divider" },
                        h("h3", null, t("outlineAiSection")),
                        !payload.binding?.sessionId
                          ? h(
                              "p",
                              { className: "seal-small" },
                              t("outlineNoSessionHint"),
                            )
                          : h(
                              React.Fragment,
                              null,
                              h("textarea", {
                                value: aiInstruction,
                                placeholder: t("outlineAiPlaceholder"),
                                onChange: (e: any) =>
                                  setAiInstruction(e.target.value),
                              }),
                              h(
                                "button",
                                {
                                  type: "button",
                                  className: "seal-btn-sm",
                                  disabled:
                                    action.busy || !aiInstruction.trim(),
                                  onClick: () =>
                                    action.run(async () => {
                                      const prompt = buildOutlineRevisionPrompt(
                                        { name: payload.project.name },
                                        selectedRow,
                                        aiInstruction,
                                      );
                                      await send(
                                        payload.binding!.sessionId!,
                                        prompt,
                                      );
                                      setAiInstruction("");
                                    }, t("sent")),
                                },
                                t("outlineAiSendBtn"),
                              ),
                            ),
                      ),
                    )
                  : h(
                      React.Fragment,
                      null,
                      h("h3", null, t("outlineDetailOverview")),
                      h("h4", { style: { margin: "4px 0" } }, t("outlineMissingOverviewTitle")),
                      missingRows.length === 0
                        ? h("p", { className: "seal-small" }, t("noIssues"))
                        : missingRows.map((row) =>
                            h(
                              "button",
                              {
                                key: row.id,
                                type: "button",
                                className: "seal-btn-sm",
                                style: { justifyContent: "space-between" },
                                onClick: () => {
                                  setActiveVolume(row.volume);
                                  setSelectedNodeId(row.id);
                                },
                              },
                              h("span", null, row.title),
                              h(
                                "span",
                                { className: "seal-badge seal-badge-warn" },
                                t("outlineMatMissing"),
                              ),
                            ),
                          ),
                      h(
                        "h4",
                        { style: { margin: "8px 0 4px" } },
                        t("outlineUncoveredOverviewTitle"),
                      ),
                      liveView.uncoveredRequirementList.length === 0
                        ? h("p", { className: "seal-small" }, t("noIssues"))
                        : liveView.uncoveredRequirementList.map((req) =>
                            h(
                              "div",
                              {
                                key: req.id,
                                className: "seal-card-compact seal-stack-sm",
                              },
                              h("strong", { className: "seal-small" }, `${req.id} · ${req.kind}`),
                              h("span", { className: "seal-small" }, req.text),
                              h(
                                "button",
                                {
                                  type: "button",
                                  className: "seal-btn-sm",
                                  onClick: () =>
                                    addNodeHelper({
                                      parentId: null,
                                      level: 1,
                                      title: req.text.slice(0, 40),
                                      kind: "authored",
                                      requirementIds: [req.id],
                                    }),
                                },
                                t("outlineAddResponseSection"),
                              ),
                            ),
                          ),
                      h(
                        "div",
                        { className: "seal-stack-sm seal-divider" },
                        h("h3", null, t("outlineAiSection")),
                        !payload.binding?.sessionId
                          ? h(
                              "p",
                              { className: "seal-small" },
                              t("outlineNoSessionHint"),
                            )
                          : h(
                              React.Fragment,
                              null,
                              h("textarea", {
                                value: aiInstruction,
                                placeholder: t("outlineAiGlobalPlaceholder"),
                                onChange: (e: any) =>
                                  setAiInstruction(e.target.value),
                              }),
                              h(
                                "button",
                                {
                                  type: "button",
                                  className: "seal-btn-sm",
                                  disabled:
                                    action.busy || !aiInstruction.trim(),
                                  onClick: () =>
                                    action.run(async () => {
                                      const prompt = buildOutlineRevisionPrompt(
                                        { name: payload.project.name },
                                        null,
                                        aiInstruction,
                                      );
                                      await send(
                                        payload.binding!.sessionId!,
                                        prompt,
                                      );
                                      setAiInstruction("");
                                    }, t("sent")),
                                },
                                t("outlineAiSendBtn"),
                              ),
                            ),
                      ),
                    ),
              ),
            ),
          );
        }

        function GlobalPage() {
          const resource = useResource<Overview>(
            (signal) => api("overview", {}, signal),
            [],
          );
          const [refreshTick, setRefreshTick] = React.useState(0);
          const reloadOverview = () => {
            resource.reload();
            setRefreshTick((value) => value + 1);
          };
          const [tab, setTabState] = React.useState(() => {
            try {
              const saved = sessionStorage.getItem("seal:global-tab");
              const savedProj = sessionStorage.getItem("seal:outline-project-id");
              if (saved === "outline" && savedProj) return "outline";
              return saved === "start" || saved === "projects" || saved === "kb"
                ? saved
                : "start";
            } catch {
              return "start";
            }
          });
          const [outlineProjectId, setOutlineProjectId] = React.useState<
            string | null
          >(() => {
            try {
              return sessionStorage.getItem("seal:outline-project-id");
            } catch {
              return null;
            }
          });
          const [outlineFocusNodeId, setOutlineFocusNodeId] = React.useState<
            string | null
          >(() => {
            try {
              return sessionStorage.getItem("seal:outline-focus-node");
            } catch {
              return null;
            }
          });
          React.useEffect(() => {
            const onOpenOutline = (event: Event) => {
              const detail = (
                event as CustomEvent<{
                  projectId?: string;
                  focusNodeId?: string;
                }>
              ).detail;
              if (!detail?.projectId) return;
              navigate(() => {
                setOutlineProjectId(detail.projectId!);
                setOutlineFocusNodeId(detail.focusNodeId ?? null);
                setTab("outline");
              });
            };
            window.addEventListener("seal:open-outline", onOpenOutline);
            return () =>
              window.removeEventListener("seal:open-outline", onOpenOutline);
          }, []);
          const [libreOfficeDismissed, setLibreOfficeDismissed] =
            React.useState(() => {
              try {
                return (
                  sessionStorage.getItem("seal:dismiss-libreoffice-banner") ===
                  "1"
                );
              } catch {
                return false;
              }
            });
          const dismissLibreOfficeBanner = () => {
            try {
              sessionStorage.setItem("seal:dismiss-libreoffice-banner", "1");
            } catch {
              /* Ignore storage errors. */
            }
            setLibreOfficeDismissed(true);
          };
          const setTab = (nextTab: string) => {
            try {
              sessionStorage.setItem("seal:global-tab", nextTab);
            } catch {
              /* Ignore storage errors. */
            }
            setTabState(nextTab);
          };
          const overview =
            resource.state.kind === "value" ? resource.state.value : null;
          const libreOfficeMissing =
            overview?.environment?.libreOffice?.available === false;
          const projectCount = overview?.projects.length ?? 0;
          const vaultCount = overview?.vaults.length ?? 0;
          const isOutlineEditor = tab === "outline" && Boolean(outlineProjectId);
          return h(
            "main",
            { className: "seal-ui seal-page" },
            h("style", null, clientStyle),
            h(
              "div",
              { className: isOutlineEditor ? "seal-content-wide" : "seal-content" },
              h(
                "header",
                { className: "seal-header" },
                h(
                  "div",
                  { className: "seal-brand" },
                  h(
                    "div",
                    { className: "seal-brand-title" },
                    h("h1", null, t("panel")),
                    h(
                      "span",
                      { className: "seal-version-pill" },
                      `v${__SEAL_VERSION__}`,
                    ),
                  ),
                  h("span", { className: "seal-small" }, t("intro")),
                ),
                h(
                  "button",
                  { className: "seal-btn-sm", onClick: reloadOverview },
                  t("refresh"),
                ),
              ),
              libreOfficeMissing &&
                !libreOfficeDismissed &&
                h(
                  "div",
                  {
                    className: "seal-callout seal-callout-warn seal-env-banner",
                    role: "status",
                  },
                  h(
                    "div",
                    { className: "seal-callout-body" },
                    h("strong", null, t("libreOfficeMissingTitle")),
                    h(
                      "span",
                      { className: "seal-small" },
                      t("libreOfficeMissingDesc"),
                    ),
                  ),
                  h(
                    "div",
                    { className: "seal-row" },
                    h(
                      "a",
                      {
                        className: "seal-link seal-btn-sm",
                        href: "https://www.libreoffice.org/download/download-libreoffice/",
                        target: "_blank",
                        rel: "noopener noreferrer",
                      },
                      t("libreOfficeDownload"),
                    ),
                    h(
                      "button",
                      {
                        type: "button",
                        className: "seal-btn-ghost seal-btn-sm",
                        onClick: dismissLibreOfficeBanner,
                      },
                      t("dismissNotice"),
                    ),
                  ),
                ),
              h(
                "nav",
                { className: "seal-tabs", "aria-label": t("panel") },
                ...[
                  ["start", t("start")],
                  [
                    "projects",
                    projectCount > 0
                      ? `${t("ongoing")} (${projectCount})`
                      : t("ongoing"),
                  ],
                  [
                    "kb",
                    vaultCount > 0
                      ? `${t("knowledge")} (${vaultCount})`
                      : t("knowledge"),
                  ],
                ].map(([id, label]) =>
                  h(
                    "button",
                    {
                      key: id,
                      role: "tab",
                      "aria-selected": tab === id,
                      onClick: () => navigate(() => setTab(id)),
                    },
                    label,
                  ),
                ),
              ),
              resourceStatus({ state: resource.state, reload: reloadOverview }),
              overview &&
                (isOutlineEditor
                  ? h(OutlineEditor, {
                      key: outlineProjectId!,
                      projectId: outlineProjectId!,
                      focusNodeId: outlineFocusNodeId,
                      onBackToProjects: () => setTab("projects"),
                      onReloadOverview: reloadOverview,
                    })
                  : tab === "start"
                    ? h(Start, {
                        overview,
                        reload: reloadOverview,
                        onGoKnowledge: () => navigate(() => setTab("kb")),
                      })
                    : tab === "projects"
                      ? h(ProjectList, {
                          overview,
                          reload: reloadOverview,
                          onGoStart: () => navigate(() => setTab("start")),
                          onOpenOutline: (projectId: string) =>
                            openGlobalOutlineEditor(projectId),
                        })
                      : h(Knowledge, {
                          overview,
                          refreshTick,
                          reload: reloadOverview,
                        })),
            ),
          );
        }

        // Registrations below retain the host-owned React and slot lifecycles.
        ctx.slots.inject("shell.overlay", () =>
          ctx.slots.register(
            { name: "shell.overlay", id: "seal-navigation", locale: NS },
            NavigationCommit,
          ),
        );
        ctx.slots.inject("sidebar.panellist", () =>
          ctx.slots.register(
            {
              name: "sidebar.panellist",
              id: PANEL_ID,
              locale: NS,
              label: () => t("panel"),
            },
            Icon,
          ),
        );
        ctx.slots.inject("main", () =>
          ctx.slots.register(
            { name: "main", key: PANEL_ID, locale: NS },
            GlobalPage,
          ),
        );
        ctx.effect(() =>
          ctx.sidebarRightTabs.register({
            id: TAB_ID,
            kind: "seal",
            title: () => t("panel"),
            keepMounted: true,
          }),
        );
        ctx.slots.inject("sidebar.right.pane.tab", () =>
          ctx.slots.register(
            {
              name: "sidebar.right.pane.tab",
              key: TAB_ID,
              locale: NS,
              inject: (sessionId: string) => ({
                sealSessionId: sessionId,
              }),
            },
            ReviewPanel,
          ),
        );
        ctx.effect(() =>
          ctx.commandUi.register({
            name: "seal",
            label: () => t("panel"),
            description: () => t("review"),
            available: () => true,
            ui: {
              kind: "action",
              run: () => {
                ctx.sidebarRight.openTab("seal");
              },
            },
          }),
        );
      },
    };
  },
});
