import { NodeHostPort } from "../node-host.js";
import { registerProjectTools, type ToolContext } from "./project-tools.js";
import { SEAL_BID_SKILL } from "./seal-bid-skill.js";
import { SEAL_KB_SKILL } from "./seal-kb-skill.js";
import {
  WorkbenchHost,
  registerWorkbenchRoutes,
  type OwnerConnection,
} from "./workbench-host.js";

export const name = "seal-workbench";
export const inject = ["tools", "workingDirectory"];

interface SkillsRegistry {
  register(skill: typeof SEAL_BID_SKILL): () => void;
}

export function apply(
  ctx: ToolContext & {
    inject(
      dependencies: ["connection"],
      operation: (context: {
        connection: OwnerConnection;
        effect(operation: () => () => Promise<void>): unknown;
      }) => void,
    ): unknown;
    inject(
      dependencies: ["skills"],
      operation: (context: {
        skills: SkillsRegistry;
        effect(operation: () => () => void): unknown;
      }) => void,
    ): unknown;
  },
): void {
  const host = new NodeHostPort();
  registerProjectTools(ctx, host);
  ctx.inject(["connection"], (context) => {
    const routes = registerWorkbenchRoutes(
      context.connection,
      new WorkbenchHost(host),
    );
    for (const dispose of routes) context.effect(() => dispose);
  });
  ctx.inject(["skills"], (context) => {
    const disposeBid = context.skills.register(SEAL_BID_SKILL);
    const disposeKb = context.skills.register(SEAL_KB_SKILL);
    context.effect(() => () => {
      disposeBid();
      disposeKb();
    });
  });
}
