export function detectAgentHarness() {
  if (process.env.AGENT_HARNESS) return process.env.AGENT_HARNESS;

  if (process.env.OPENCODE_SESSION_ID || process.env.OPENCODE_CONFIG_PATH) return 'opencode';
  if (process.env.CODEX_SESSION_ID || process.env.CODEX_CLI_VERSION) return 'codex';
  if (process.env.CODEX_DESKTOP || process.env.CODEX_ELECTRON) return 'codex-desktop';
  if (process.env.CURSOR_SESSION_ID || process.env.CURSOR_GIT_WORKDIR) return 'cursor';
  if (process.env.CLAUDE_CODE_SESSION_ID) return 'claude-code';
  if (process.env.CODE_ARTS_HARNESS || process.env.CODEARTS_PROJECT_DIR) return 'codearts';
  if (process.env.WORK_BUDDY_SESSION_ID || process.env.WORKBUDDY_SESSION) return 'workbuddy';
  if (process.env.DSH_SESSION_ID || process.env.DSH_HOME) return 'dsh';
  if (process.env.HERMES_SESSION_ID || process.env.HERMES_HOME) return 'hermes';
  if (process.env.OFFICEACE_SESSION_ID || process.env.OFFICE_CLAW_CONFIG_ROOT) return 'officeace';
  if (process.env.ATOM_CODE_SESSION_ID || process.env.ATOMCODE_HOME) return 'atomcode';
  if (process.env.OPENCLAW_SESSION_ID || process.env.OPENCLAW_CONFIG_ROOT) return 'openclaw';

  if (process.env.TERM_PROGRAM === 'vscode' || process.env.VSCODE_PID) return 'vscode';

  return 'unknown';
}