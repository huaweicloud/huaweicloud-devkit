'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// ── Detect DSH profile context ──
const cwd = process.cwd();
const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const profilesRoot = path.join(dshHome, 'profiles');

if (!cwd.startsWith(profilesRoot)) {
  // Not inside a DSH profile — traditional install, just print message
  console.log('\nHuaweiCloud DevKit installed. Run: npx huaweicloud-devkit install\n');
  process.exit(0);
}

// ── Inside a DSH profile: copy skills to ~/.dsh/skills/ ──
const packageRoot = path.resolve(__dirname, '..');

// Rewrite the bundled patch's relative MCP server path to the absolute package
// path. Relative paths resolve against the DSH process cwd and break when DSH
// is started outside the profile directory. Idempotent: absolute paths are kept.
const bundledPatch = path.join(packageRoot, 'cordis.patch.yml');
if (fs.existsSync(bundledPatch)) {
  const relativeArg = './node_modules/huaweicloud-devkit/plugins/huaweicloud-core/dist/mcp-server.js';
  const absoluteArg = path
    .join(packageRoot, 'plugins', 'huaweicloud-core', 'dist', 'mcp-server.js')
    .replace(/\\/g, '/')
    .replace(/'/g, "''");
  const patch = fs.readFileSync(bundledPatch, 'utf8');
  const updated = patch.split(`'${relativeArg}'`).join(`'${absoluteArg}'`);
  if (updated !== patch) {
    fs.writeFileSync(bundledPatch, updated);
    console.log('HuaweiCloud DevKit: rewrote DSH patch MCP path to absolute package path');
  }
}

const skillsSrc = path.join(packageRoot, 'plugins', 'huaweicloud-core', 'skills');
const skillsDest = path.join(dshHome, 'skills');

if (!fs.existsSync(skillsSrc)) {
  console.log('HuaweiCloud DevKit: skills source not found, skipping auto-setup');
  process.exit(0);
}

fs.mkdirSync(skillsDest, { recursive: true });

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

let count = 0;
for (const entry of fs.readdirSync(skillsSrc, { withFileTypes: true })) {
  if (entry.isDirectory()) {
    copyDir(path.join(skillsSrc, entry.name), path.join(skillsDest, entry.name));
    count++;
  }
}

console.log(`\nHuaweiCloud DevKit: ${count} skills installed to ~/.dsh/skills/`);
console.log('MCP server will be available after DSH restart.');
console.log('\n\u001b[1m\u001b[36m  首次使用请配置环境：\u001b[0m');
console.log('  1. 安装 KooCLI：npx huaweicloud-devkit install-hcloud');
console.log('  2. 配置凭证：  npx huaweicloud-devkit auth init');
console.log('  3. 重启 DSH 会话后即可使用');
console.log('  或者直接在 DSH 中对 Agent 说：帮我安装华为云 KooCLI 并配置凭证\n');
