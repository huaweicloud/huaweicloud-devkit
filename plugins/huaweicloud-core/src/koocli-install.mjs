import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { getKooCliVersion, kooCliDownloadBase } from './koocli-version.mjs';

// Programmatic KooCLI (hcloud) install — downloadable from inside the MCP server
// process via Node (fetch + tar via child_process), so it does NOT depend on the
// agent's bash tool (which is unavailable in CodeArts with OPENCODE_CONFIG
// unset — experience-report #3.5). Returns a structured result for the
// `huaweicloud_install_hcloud` MCP tool.
export async function installKooCli(options = {}) {
  const os = process.platform;
  const arch = process.arch;

  // Windows auto-install needs PowerShell specifics — keep it on the CLI path.
  if (os === 'win32') {
    return { ok: false, error: 'Windows 环境请使用 CLI: npx huaweicloud-devkit install-hcloud' };
  }
  if (os !== 'linux' && os !== 'darwin') {
    return { ok: false, error: `不支持的操作系统: ${os}` };
  }

  const installDir = options.binDir || (os === 'linux' ? join(homedir(), '.local', 'bin') : '/usr/local/bin');
  const pkg =
    os === 'linux' ? (arch === 'arm64' ? 'linux-arm64' : 'linux-amd64') : arch === 'arm64' ? 'mac-arm64' : 'mac-amd64';
  const url = `${kooCliDownloadBase()}/huaweicloud-cli-${pkg}.tar.gz`;
  const binPath = join(installDir, 'hcloud');

  try {
    mkdirSync(installDir, { recursive: true });

    const tmpTar = join(installDir, `huaweicloud-cli-${pkg}.tar.gz`);
    const resp = await fetch(url);
    if (!resp.ok) {
      return { ok: false, error: `下载失败 (HTTP ${resp.status}): ${url}` };
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    writeFileSync(tmpTar, buf);

    const ex = spawnSync('tar', ['-xzf', tmpTar, '-C', installDir], { stdio: 'pipe', timeout: 60000 });
    rmSync(tmpTar, { force: true });
    if (ex.status !== 0) {
      return { ok: false, error: `解压失败 (tar exit ${ex.status}): ${(ex.stderr || '').toString().slice(0, 200)}` };
    }

    if (!existsSync(binPath)) {
      return { ok: false, error: `hcloud 二进制未生成于 ${binPath}` };
    }
    chmodSync(binPath, 0o755);

    return { ok: true, binPath, version: getKooCliVersion() };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}
