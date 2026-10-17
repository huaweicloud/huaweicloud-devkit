import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { probeHcloud } from '../../hcloud-probe.ts';
import { getKooCliVersion, kooCliDownloadBase, KOO_CLI_BASE } from '../../koocli-version.ts';
import { detectCodeartsSandbox, printSandboxWarning } from '../../codearts-sandbox.ts';
import {
  recordInstallReceipt,
  removeReceipt,
  type DepReceipt,
  type DepUninstallResult,
  type ResolvedUninstallContext,
} from '../receipts.ts';
import { DEPENDENCIES } from '../../lib/dependency-model.ts';

// The hcloud (KooCLI) installer module: everything the host may do to one
// dependency's lifecycle — install (download/extract/place/PATH), the
// privacy-agreement step, non-interactive manual instructions, and the
// receipt-gated uninstall with its sudo landing-site whitelist. One module
// per installable dependency; the composition table that dispatches to
// these lives in installers/table.ts, the policy loop and the uninstall
// decision core in ../provision.ts. This module must stay zod-free: it
// compiles into the unbundled dist/setup-cli.js graph, where only undici
// exists at runtime.

const HCLOUD_ESCAPE_HATCH = 'Escape hatch: npx huaweicloud-devkit uninstall --target all --clean-kocli';

// The pinned manual instructions, today's wording, shared by the installer's
// failure paths and the non-interactive provisioning path (a non-TTY session
// never downloads: it prints exactly what to run).
export function printKooCliManualInstructions(log: (_line: string) => void = console.log): void {
  const kooCliVersion = getKooCliVersion();
  const baseUrl = kooCliDownloadBase();
  const latestUrl = `${KOO_CLI_BASE}/latest`;
  if (process.platform === 'win32') {
    const url = `${baseUrl}/huaweicloud-cli-windows-amd64.zip`;
    const installDir = join(homedir(), 'hcloud');
    log(`  Manual: download ${url}, unzip to ${installDir}, add to PATH`);
    log(`  Guide: https://support.huaweicloud.com/qs-hcli/hcli_02_003_01.html`);
    return;
  }
  if (process.platform === 'linux' || process.platform === 'darwin') {
    const label = process.platform === 'linux' ? 'Linux' : 'macOS';
    const arch = process.arch;
    const pkg =
      process.platform === 'linux'
        ? arch === 'arm64'
          ? 'linux-arm64'
          : 'linux-amd64'
        : arch === 'arm64'
          ? 'mac-arm64'
          : 'mac-amd64';
    const url = `${baseUrl}/huaweicloud-cli-${pkg}.tar.gz`;
    const binDir = process.platform === 'linux' ? join(homedir(), '.local', 'bin') : '/usr/local/bin';
    log(`\n[${label}] Manual install (pinned to KooCLI ${kooCliVersion || ''}):`);
    log(`  curl -LO "${url}"`);
    log(`  tar -zxvf huaweicloud-cli-${pkg}.tar.gz`);
    log(`  mv hcloud ${binDir}/`);
    log(`  hcloud version`);
    log(`\n  Or one-liner (installs LATEST, may differ from pinned ${kooCliVersion || ''}):`);
    log(`  curl -sSL ${latestUrl}/hcloud_install.sh -o ./hcloud_install.sh && bash ./hcloud_install.sh -y`);
    log(
      `  \x1b[33m⚠️  The one-liner installs the latest KooCLI. If \`hcloud version\` != ${kooCliVersion}, doctor/check_cli will warn — use the pinned download above instead.\x1b[0m`,
    );
    log(
      `\nFull guide: https://support.huaweicloud.com/qs-hcli/hcli_02_003_0${process.platform === 'linux' ? '2' : '3'}.html`,
    );
  }
}

// Privacy agreement flow, install → probe → prompt: the classification can
// only observe privacy_pending after the binary exists, so the probe runs
// after install (an already-accepted agreement must not re-prompt on
// reinstalls). Gated on the tty flag on BOTH platforms — the readline
// question hangs forever on a non-TTY stdin. Non-TTY prints the manual
// privacy command instead.
async function offerPrivacyAcceptance(executable: string, tty: boolean): Promise<void> {
  const probe = probeHcloud({ executable });
  if (probe.status === 'ok') {
    console.log('  \x1b[32mKooCLI ready (privacy agreement already accepted).\x1b[0m');
    return;
  }
  if (!tty) {
    console.log('  \x1b[33m非交互会话：请稍后在终端运行 hcloud version 并按提示接受隐私协议\x1b[0m');
    return;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const agree = await new Promise<boolean>((resolve) => {
    rl.question('\n  KooCLI requires accepting its privacy agreement. Do you accept? (y/N) ', (answer) => {
      rl.close();
      resolve(/^\s*y\s*$/i.test(answer));
    });
  });
  if (!agree) {
    console.log('  \x1b[33m请手动接受隐私协议：在终端运行 hcloud version 并按提示操作\x1b[0m');
    return;
  }
  const r = spawnSync(executable, ['version'], { input: 'y\n', encoding: 'utf8', timeout: 15000, windowsHide: true });
  console.log(
    r.status === 0
      ? '  \x1b[32mPrivacy agreement accepted. KooCLI ready.\x1b[0m'
      : process.platform === 'win32'
        ? '  \x1b[33m无法写入配置目录。请在普通终端运行: echo "y" | hcloud version\x1b[0m'
        : '  \x1b[33m无法写入配置目录。请在终端运行: hcloud version 并按提示操作\x1b[0m',
  );
}

export async function installKooCli(opts: { tty: boolean }): Promise<boolean> {
  console.log('Installing KooCLI (hcloud)...\n');

  const baseUrl = kooCliDownloadBase();
  const installDir = process.platform === 'win32' ? join(homedir(), 'hcloud') : join(homedir(), '.local', 'bin');

  if (process.platform === 'win32') {
    const url = `${baseUrl}/huaweicloud-cli-windows-amd64.zip`;
    // Scratch dir per run: a fixed hcloud.zip path in the install dir
    // collides across concurrent installs, and install-time auto-provisioning
    // makes concurrent installs normal.
    const scratch = mkdtempSync(join(tmpdir(), 'huaweicloud-devkit-'));
    const zipPath = join(scratch, 'hcloud.zip');

    console.log(`[Windows] Auto-installing to ${installDir}...`);

    try {
      mkdirSync(installDir, { recursive: true });

      // Download
      console.log(`  Downloading ${url}...`);
      const psCmd = `[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '${url}' -OutFile '${zipPath}' -UseBasicParsing`;
      const dl = spawnSync('powershell', ['-NoProfile', '-Command', psCmd], {
        stdio: 'inherit',
        windowsHide: true,
        timeout: 180000,
      });
      if (dl.status !== 0) throw new Error(`下载失败 (PowerShell exit ${dl.status})`);

      // Extract
      console.log('  Extracting...');
      const ex = spawnSync(
        'powershell',
        ['-NoProfile', '-Command', `Expand-Archive -Path '${zipPath}' -DestinationPath '${installDir}' -Force`],
        { stdio: 'inherit', windowsHide: true, timeout: 60000 },
      );
      if (ex.status !== 0) throw new Error(`解压失败 (PowerShell exit ${ex.status})`);
      if (!existsSync(join(installDir, 'hcloud.exe'))) throw new Error('hcloud.exe 未生成，可能已被安全软件拦截');

      // Clean up zip
      rmSync(zipPath, { force: true });

      // Add to user PATH (append + dedupe within the User scope only; never copy
      // session/system entries into the user PATH, and never use setx PATH which
      // overwrites the whole variable and truncates at 1024 chars).
      console.log('  Adding to user PATH...');
      const pathPs = [
        '$ErrorActionPreference = "Stop"',
        `$target = '${installDir.replace(/'/g, "''")}'`,
        '$cur = [Environment]::GetEnvironmentVariable("Path", "User")',
        'if (-not $cur) { $cur = "" }',
        '$parts = @($cur -split ";" | Where-Object { $_ -ne "" })',
        'if ($parts -notcontains $target) {',
        '  [Environment]::SetEnvironmentVariable("Path", (@($parts) + $target) -join ";", "User")',
        '  Write-Output "  Added to user PATH (deduped): $target"',
        '} else {',
        '  Write-Output "  Already in user PATH: $target"',
        '}',
      ].join('; ');
      spawnSync('powershell', ['-NoProfile', '-Command', pathPs], {
        stdio: 'inherit',
        windowsHide: true,
        timeout: 30000,
      });

      console.log(`\n\x1b[32mInstall complete.\x1b[0m`);
      console.log(`  Verify: ${join(installDir, 'hcloud.exe')} version`);

      await offerPrivacyAcceptance(join(installDir, 'hcloud.exe'), opts.tty);

      if (existsSync(join(installDir, 'hcloud.exe'))) {
        recordInstallReceipt({
          binary: 'hcloud',
          provisioner: 'devkit',
          path: join(installDir, 'hcloud.exe'),
          installedAt: new Date().toISOString(),
        });
      }

      console.log('  Or restart terminal and: hcloud version');
      return true;
    } catch (error) {
      console.log(`\n\x1b[33mAuto-install failed: ${error instanceof Error ? error.message : String(error)}\x1b[0m`);
      printKooCliManualInstructions();
      if (detectCodeartsSandbox() === 'sandbox') {
        printSandboxWarning('沙箱模式拦截了 KooCLI 自动安装（无法创建/写入安装目录）。');
      }
      return false;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  if (process.platform === 'linux' || process.platform === 'darwin') {
    const label = process.platform === 'linux' ? 'Linux' : 'macOS';
    const arch = process.arch;
    const pkg =
      process.platform === 'linux'
        ? arch === 'arm64'
          ? 'linux-arm64'
          : 'linux-amd64'
        : arch === 'arm64'
          ? 'mac-arm64'
          : 'mac-amd64';
    const url = `${baseUrl}/huaweicloud-cli-${pkg}.tar.gz`;
    const binDir = process.platform === 'linux' ? join(homedir(), '.local', 'bin') : '/usr/local/bin';
    const binPath = join(binDir, 'hcloud');

    if (detectCodeartsSandbox() === 'sandbox') {
      printSandboxWarning('沙箱模式拦截了 KooCLI 自动安装（无法创建/写入安装目录）。');
      printKooCliManualInstructions();
      return false;
    }

    console.log(`[${label}] Auto-installing to ${binDir}...`);
    // Scratch dir per run: the fixed tmpdir()/huaweicloud-cli-<pkg>.tar.gz
    // path (and its extracted hcloud) collides across concurrent installs.
    const scratch = mkdtempSync(join(tmpdir(), 'huaweicloud-devkit-'));
    try {
      const tmpTar = join(scratch, `huaweicloud-cli-${pkg}.tar.gz`);
      console.log(`  Downloading ${url}...`);
      const dl = spawnSync('curl', ['-fL', url, '-o', tmpTar], { stdio: 'inherit', timeout: 180000 });
      if (dl.status !== 0) throw new Error(`下载失败 (curl exit ${dl.status})`);

      console.log('  Extracting...');
      const ex = spawnSync('tar', ['-xzf', tmpTar, '-C', scratch], { stdio: 'inherit', timeout: 60000 });
      if (ex.status !== 0) throw new Error(`解压失败 (tar exit ${ex.status})`);
      const extracted = join(scratch, 'hcloud');
      if (!existsSync(extracted)) throw new Error('hcloud 二进制未生成，可能已被安全软件拦截');

      try {
        mkdirSync(binDir, { recursive: true });
      } catch {
        // best-effort mkdir: an unwritable target dir is reported by the mv failure handling below
      }
      console.log('  Installing...');
      let mv = spawnSync('mv', [extracted, binPath], { stdio: 'inherit', timeout: 30000 });
      if (mv.status !== 0) {
        if (opts.tty) {
          // The user is present: today's interactive sudo works.
          console.log('  目标目录需要权限，尝试 sudo mv...');
          mv = spawnSync('sudo', ['mv', extracted, binPath], { stdio: 'inherit', timeout: 30000 });
          if (mv.status !== 0) throw new Error(`安装失败 (mv exit ${mv.status})`);
        } else {
          // Non-interactive: sudo -n never blocks on a password prompt; on
          // failure print the manual instructions instead of hanging.
          console.log('  目标目录需要权限，尝试 sudo -n mv...');
          const sudoMv = spawnSync('sudo', ['-n', 'mv', extracted, binPath], { stdio: 'inherit', timeout: 30000 });
          if (sudoMv.status !== 0) {
            printKooCliManualInstructions();
            return false;
          }
        }
      }

      console.log(`\n\x1b[32mInstall complete.\x1b[0m`);
      console.log(`  Verify: ${binPath} version`);

      await offerPrivacyAcceptance(binPath, opts.tty);

      if (existsSync(binPath)) {
        recordInstallReceipt({
          binary: 'hcloud',
          provisioner: 'devkit',
          path: binPath,
          installedAt: new Date().toISOString(),
        });
      }
      return true;
    } catch (error) {
      console.log(`\n\x1b[33mAuto-install failed: ${error instanceof Error ? error.message : String(error)}\x1b[0m`);
      printKooCliManualInstructions();
      if (detectCodeartsSandbox() === 'sandbox') {
        printSandboxWarning('沙箱模式拦截了 KooCLI 自动安装（无法创建/写入安装目录）。');
      }
      return false;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  return false;
}

// The only paths the uninstall side may ever hand to sudo: the catalog's
// platform candidates for hcloud (expanded with the same HOME rule the
// resolution chain uses) plus the installer's computed binPath. The receipt
// is user-writable JSON, so its recorded path is untrusted input at this
// boundary — a forged receipt must never aim sudo at an arbitrary file.
function hcloudInstallLandingSites(env: NodeJS.ProcessEnv): ReadonlySet<string> {
  const home = process.platform === 'win32' ? homedir() : env.HOME || homedir();
  const sites = new Set<string>();
  const candidates =
    process.platform === 'win32'
      ? DEPENDENCIES.hcloud.resolution.candidates.win32
      : DEPENDENCIES.hcloud.resolution.candidates.unix;
  for (const candidate of candidates) {
    sites.add(candidate.startsWith('~') ? join(home, candidate.slice(1)) : candidate);
  }
  sites.add(
    process.platform === 'win32'
      ? join(homedir(), 'hcloud', 'hcloud.exe')
      : process.platform === 'linux'
        ? join(homedir(), '.local', 'bin', 'hcloud')
        : '/usr/local/bin/hcloud',
  );
  return sites;
}

export function uninstallHcloud(receipt: DepReceipt, dir: string, ctx: ResolvedUninstallContext): DepUninstallResult {
  const env = ctx.env;
  const resolve = ctx.resolveDependency;
  // The receipt's path is the attribution: devkit deletes exactly that file.
  // When the receipt lacks one (a hand-edited receipt) the currently resolved
  // binary stands in — except an env-tier resolution: HCLOUD_BIN is the
  // user's explicit override, not devkit's placement, and a user-placed
  // binary is never touched.
  let target: string | null;
  if (receipt.path) {
    target = receipt.path;
  } else {
    const resolved = resolve('hcloud', env);
    if (resolved && resolved.tier === 'env') {
      return {
        ok: false,
        message: `Refusing to uninstall hcloud: the receipt records no path and the resolved binary is the user's HCLOUD_BIN override (${resolved.command}). ${HCLOUD_ESCAPE_HATCH}`,
      };
    }
    target = resolved ? resolved.command : null;
  }
  if (!target || !existsSync(target)) {
    removeReceipt('hcloud', dir);
    return {
      ok: true,
      message: `hcloud was already gone (nothing at ${target ?? 'the resolved location'}); removed the stale receipt.`,
    };
  }
  try {
    rmSync(target);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const errno = (error as NodeJS.ErrnoException).code;
    if (errno === 'ENOENT') {
      // A concurrent removal won the race between existsSync and rmSync:
      // converge to the already-gone outcome instead of reporting failure.
      removeReceipt('hcloud', dir);
      return {
        ok: true,
        message: `hcloud was already gone (nothing at ${target}); removed the stale receipt.`,
      };
    }
    // Only permission errors escalate, and never on win32 (sudo does not
    // exist there); every other errno reports failure without escalation.
    const escalates = (errno === 'EACCES' || errno === 'EPERM') && process.platform !== 'win32';
    if (escalates && !hcloudInstallLandingSites(env).has(target)) {
      return {
        ok: false,
        message: `Refusing to remove ${target}: the receipt path is not a known devkit install location, so sudo was not attempted. Remove it manually only if you are certain devkit placed it, then re-run dep uninstall hcloud to clear the receipt.`,
      };
    }
    if (escalates) {
      // /usr/local/bin on default macOS: the installer placed the binary via
      // `sudo mv`, so a bare rmSync fails EACCES. Mirror that discipline
      // without ever blocking on a password prompt — sudo -n only, through
      // the same runCommand seam the tier uninstall uses.
      const escalated = ctx.runCommand('sudo', ['-n', 'rm', target]);
      if (escalated.status === 0) {
        removeReceipt('hcloud', dir);
        return {
          ok: true,
          message: `Removed the devkit-installed hcloud binary: ${target} (via sudo -n rm)`,
          detail: [
            '~/.hcloud credentials and config were not touched; those are removed only by: npx huaweicloud-devkit uninstall --target all --clean-kocli',
          ],
        };
      }
      return {
        ok: false,
        message: `Failed to remove ${target}: ${reason}. Remove it manually (sudo rm ${target}), then re-run dep uninstall hcloud to clear the receipt.`,
      };
    }
    return {
      ok: false,
      message: `Failed to remove ${target}: ${reason}. Remove it manually, then re-run dep uninstall hcloud to clear the receipt.`,
    };
  }
  removeReceipt('hcloud', dir);
  return {
    ok: true,
    message: `Removed the devkit-installed hcloud binary: ${target}`,
    detail: [
      '~/.hcloud credentials and config were not touched; those are removed only by: npx huaweicloud-devkit uninstall --target all --clean-kocli',
    ],
  };
}

export { HCLOUD_ESCAPE_HATCH };
