// The agent-switching seam. One adapter (opencode) ships today; the
// interface exists because switchability is a stated hard constraint, and
// every case stays written against it. Drivers own exactly the agent
// knowledge: binary resolution, config/env shape, spawn shape, final-text
// extraction. The runner owns install, seams, evaluation — drivers cannot
// shadow seams (env-policy merge order).

export interface DriverContext {
  home: string;
  workdir: string;
  platform: NodeJS.Platform;
}

export interface DriverProbe {
  ok: boolean;
  detail: string;
  command: string | null;
}

export interface RunRequest {
  prompt: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  // The driver must spawn in its own process group and kill the whole tree
  // (agent → MCP server → fake children) when this fires, then resolve.
  signal: AbortSignal;
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  finalText: string | null;
}

export interface AgentDriver {
  readonly id: string;
  readonly installTarget: string;
  probe(): DriverProbe;
  // Called after the runner installed devkit into ctx.home. Merges the
  // agent's model/provider config into the installer-written config and
  // returns agent-specific env vars (auth via env, never copied files).
  prepare(ctx: DriverContext): NodeJS.ProcessEnv;
  runPrompt(req: RunRequest): Promise<RunResult>;
}
