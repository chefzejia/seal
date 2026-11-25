declare module "@deepseek-ai/dsh-tools" {
  export class ToolArgsError extends Error {
    readonly code: string;
    constructor(violations: string[]);
  }
  export function defineTool<Args>(options: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    output: {
      schema: unknown;
      render(args: unknown, value: { json: string }): Array<{ type: "text"; text: string }>;
    };
    execute(args: Args, execution: { signal: AbortSignal; agent?: unknown }): Promise<{ json: string }>;
  }): unknown;
}
