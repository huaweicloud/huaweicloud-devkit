export const name: string;
export const inject: string[];

export interface HookClassification {
  key: string;
  value: string;
  capability: string;
}

export function classifyHcloud(text: string): HookClassification | null;

export interface HookPluginContext {
  on(
    event: string,
    handler: (exec: { name: string; arguments?: { command?: string } }, next: () => void) => void,
  ): void;
}

export function apply(ctx: HookPluginContext): void;
