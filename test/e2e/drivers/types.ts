// The agent-switching seam. Three adapters ship today (opencode, codex,
// hermes);
// the interface exists because switchability is a stated hard constraint,
// and every case stays written against it. Drivers own exactly the agent
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
  // Parsed agent binary version when obtainable; surfaced in the run report
  // so drift between the verified pin and a local binary is visible.
  version: string | null;
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

// The closed driver vocabulary: the runner's registry literal is keyed by
// it (a missing driver is a compile error). Env-string selection still
// carries the runtime unknown-driver guard in the runner.
export type DriverId = 'opencode' | 'codex' | 'hermes';

export interface AgentDriver {
  readonly id: DriverId;
  readonly installTarget: string;
  // The model wire the agent's CLI speaks — codex 0.162.1 removed the chat
  // wire (responses only), opencode rides chat/completions. The runner uses
  // it for the mid-suite wire re-probe; probe() uses it for the pre-flight.
  readonly modelWire: 'responses' | 'chat';
  // Whether `install --packs` can reach this target. The codex target is
  // managed by the codex CLI and has no packs write path (installCodex
  // documents this), so the runner records a skip for installPacks cases
  // instead of letting them run with a silently unapplied posture.
  readonly supportsInstallPacks: boolean;
  // Async because the readiness check authorizes one live request against
  // the model gateway: a dead key or a missing route must abort the run
  // before any case spends budget (the all-red dead-agent signature it
  // prevents was measured on the 2026-10-22 CI codex leg).
  probe(): Promise<DriverProbe>;
  // Pre-install hook: some agents refuse to resolve a home that does not
  // exist yet (codex never creates CODEX_HOME). The runner calls this before
  // install so install-time agent spawns see a valid home; returned vars are
  // merged into the INSTALL env (the run env gets prepare()'s vars instead).
  prepareHome?(home: string): NodeJS.ProcessEnv | void;
  // Called after the runner installed devkit into ctx.home. Merges the
  // agent's model/provider config into the installer-written config and
  // returns agent-specific env vars (auth via env, never copied files).
  prepare(ctx: DriverContext): NodeJS.ProcessEnv;
  runPrompt(req: RunRequest): Promise<RunResult>;
}
