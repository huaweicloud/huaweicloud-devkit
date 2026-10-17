import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// CodeArts sandbox detection, shared by the doctor output (setup-cli.ts) and
// the KooCLI installer (dep/installers/hcloud.ts). Extracted from setup-cli.ts
// when the installer moved: both consumers need the same bash_mode probe and
// the same remediation text, and a local copy in each would drift.

// Detect CodeArts sandbox mode (bash_mode in permission config).
export function detectCodeartsSandbox(): string | null {
  try {
    const configPath = join(homedir(), '.codeartsdoer', 'codearts-data', 'storage', 'permission', 'config.json');
    if (!existsSync(configPath)) return null;
    const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const bashMode = (parsed as Record<string, unknown>).bash_mode;
    return typeof bashMode === 'string' ? bashMode : null;
  } catch {
    return null;
  }
}

export function printSandboxWarning(reason: string): void {
  console.log(`\n\x1b[1m\x1b[31m⚠ 检测到码道沙箱模式 (bash_mode: sandbox)\x1b[0m`);
  console.log(`\x1b[31m  ${reason}\x1b[0m`);
  console.log(`\x1b[31m  请任选其一继续:\x1b[0m`);
  console.log(`\x1b[31m  A. 在码道外的终端安装并使用 KooCLI (推荐):`);
  console.log(`\x1b[31m     https://support.huaweicloud.com/qs-hcli/hcli_02_003.html`);
  console.log(`\x1b[31m  B. 在码道设置中关闭沙箱模式后重试 (设置 → 对话流 → 智能体 终端命令运行模式 → 自动运行)`);
  console.log(`\x1b[31m  关闭沙箱后重新运行: npx huaweicloud-devkit install-hcloud\x1b[0m`);
}
