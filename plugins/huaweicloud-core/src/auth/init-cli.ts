// The interactive `auth init` flow, extracted from setup-cli.ts: the
// AK/SK acquisition script, the S1 vault + OBS mirror writes, and the
// KooCLI profile write with its #920 purge/verify semantics. The dispatch
// lives in auth/cli.ts; the profile helpers in auth/hcloud-profile.ts.

import { resolveAndApplyProjectId } from './project-id.ts';
import { readKooCliProfiles, runHcloudProfileDelete } from './reconcile.ts';
import { readGlobalCredentials, writeGlobalCredentials, writeObsConfig } from './credentials.ts';
import { findHcloudBin } from '../hcloud-probe.ts';
import { readLineQuestion, readSecret } from '../lib/cli-io.ts';
import { resolveSecretValue } from '../lib/secret-vault/store.ts';
import { preserveRefForm } from '../lib/credentials.ts';
import { errorMessage } from '../install-payload.ts';
import { BANNER } from '../lib/banner.ts';
import { configureHcloud, configuredProfileName, verifyHcloudIdentity } from './hcloud-profile.ts';

export async function cmdAuthInit(): Promise<void> {
  console.log(BANNER);
  console.log('HuaweiCloud DevKit Unified Authentication Setup\n');
  console.log('\x1b[1m获取 AK/SK（如果还没有）：\x1b[0m');
  console.log('  1. 打开华为云"访问密钥"页签：');
  console.log('     https://console.huaweicloud.com/iam/?region=cn-north-4#/mine/accessKey');
  console.log('  2. 点击"新增访问密钥"，完成身份验证');
  console.log('  3. 下载凭证文件（内含 AK 和 SK）。');
  console.log('     注意：SK 只在创建密钥时显示一次，请妥善保存该文件。\n');

  try {
    const kooCli = readKooCliProfiles();
    if (!('error' in kooCli)) {
      const currentProfile = kooCli.profiles.find((p) => p.name === kooCli.current);
      if (currentProfile?.accessKeyId) {
        console.log(
          `\x1b[33m检测到 KooCLI 已配置 profile "${currentProfile.name}"（AK 已存储）。SK 为加密存储无法导出，请直接输入或通过环境变量提供凭据。\x1b[0m\n`,
        );
      }
    }
  } catch {
    // best-effort hint: unreadable KooCLI config skips the existing-profile notice
  }

  let ak = process.env.HW_ACCESS_KEY || '';
  let sk = process.env.HW_SECRET_KEY || '';
  let securityToken = process.env.HW_SECURITY_TOKEN || '';
  let region = process.env.HUAWEICLOUD_REGION || process.env.HW_REGION || '';

  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  if (!interactive && (!ak || !sk)) {
    console.error(
      '\x1b[31mNon-interactive session detected. Provide credentials via environment variables instead:\x1b[0m',
    );
    console.error(
      '  export HW_ACCESS_KEY=<ak> HW_SECRET_KEY=<sk>   then re-run "npx huaweicloud-devkit auth init" to continue',
    );
    console.error(
      '  (Agents: prefer huaweicloud_auth_switch mode=import — reads ~/.config/huaweicloud/creds-import.json and wipes it, so the SK never enters the conversation.)',
    );
    console.error('  (Or run "npx huaweicloud-devkit auth init" in a real terminal.)');
    process.exitCode = 1;
    return;
  }

  if (!ak) ak = await readLineQuestion('Access Key ID (AK): ');
  if (!sk) sk = await readSecret('Secret Access Key (SK): ');
  if (interactive && !securityToken)
    securityToken = await readLineQuestion('Security Token (optional, press Enter to skip): ');
  if (!region) region = 'cn-north-4';

  if (!ak || !sk) {
    console.error('\nAK and SK are required.');
    process.exitCode = 1;
    return;
  }

  // Incoming values may be secret:// refs (env-delivered or typed). Resolve
  // for the mirrors, keep the ref representation in S1 when the resolved
  // value matches — same preserveRefForm contract as auth_switch persist.
  const akValue = resolveSecretValue(ak) ?? ak;
  const skValue = resolveSecretValue(sk) ?? sk;
  const rawStored = readGlobalCredentials();
  writeGlobalCredentials({
    ak: preserveRefForm(akValue, rawStored?.ak),
    sk: preserveRefForm(skValue, rawStored?.sk),
    securityToken,
    region,
  });

  try {
    writeObsConfig({ ak: akValue, sk: skValue, securityToken, region });
  } catch (error) {
    console.log(`OBS config sync failed: ${errorMessage(error)}`);
  }

  if (findHcloudBin()) {
    // #920: `configure set` refuses empty --cli-security-token values, so a
    // stale token already in the profile survives the write. When auth init
    // runs WITHOUT a token, delete the profile first (documented manual
    // bypass, shared seam with the auth_switch persist path) so the recreated
    // profile cannot keep poisoning calls with APIGW.0301. A missing profile
    // ("nothing to clean") is not an error.
    if (!securityToken) {
      const purge = runHcloudProfileDelete(configuredProfileName());
      if (!purge.ok && !/not (exist|found)/i.test(purge.error || '')) {
        console.error(`KooCLI profile reset skipped: ${purge.error || 'unknown error'}`);
      }
    }
    const result = configureHcloud({ ak: akValue, sk: skValue, region });
    if (!result.ok) console.log(`KooCLI update failed: ${result.error || result.code}`);
    else {
      const proj = resolveAndApplyProjectId({ region });
      if (proj.ok) {
        console.log(`  Project ID auto-set: ${proj.projectId}`);
      } else {
        // #920: an unconfigured project_id is an ERROR, not a warning — most
        // hcloud calls fail with APIGW.0301 until it is set.
        console.error(
          `\x1b[31m  ERROR: Project ID not auto-set (${proj.reason}). hcloud API calls (ECS/VPC/OBS API paths, sandbox exec) will fail with APIGW.0301 Incorrect IAM authentication information until it is configured. Recover with:\x1b[0m`,
        );
        console.error(`    hcloud IAM KeystoneListProjects --cli-region=${region} --name=${region}`);
        console.error(`    hcloud configure set --cli-project-id=<project_id>`);
        console.error(`    (or re-run "npx huaweicloud-devkit auth init", which auto-sets it)`);
      }

      // #920: verify the profile can actually authenticate before claiming
      // success — a poisoned profile must never print "synchronized".
      // Temporary-credential inputs skip the probe: the profile deliberately
      // carries no security token (tokens are not written at rest), so
      // GetCallerIdentity with the AK/SK alone cannot succeed — verifying
      // would deterministically fail and the recovery text would mislead.
      const identity = securityToken ? null : verifyHcloudIdentity(region);
      if (identity === null) {
        console.log(
          '\nCredentials written. Temporary tokens are never written to the KooCLI profile, so identity verification was skipped (a pre-existing profile token, if any, is left in place this run).',
        );
      } else if (identity.ok) {
        console.log('\nCredentials synchronized.');
      } else {
        console.error(
          `\x1b[31m  ERROR: credentials were written but the KooCLI profile FAILED the hcloud STS GetCallerIdentity verification (exit ${identity.code}). hcloud calls will fail with APIGW.0301 — "Credentials synchronized" is NOT confirmed. Typical cause: a stale/expired security token in the profile or wrong AK/SK. Recover with:\x1b[0m`,
        );
        console.error(`    hcloud configure delete --cli-profile=${configuredProfileName()}`);
        console.error(`    then re-run "npx huaweicloud-devkit auth init" with AK/SK only (no token)`);
        console.error(`    Last error: ${identity.error || 'unknown'}`);
        process.exitCode = 1;
      }
    }
  } else {
    console.log('KooCLI not found. Run "npx huaweicloud-devkit install-hcloud" and then "auth sync".');
  }

  if (process.exitCode !== 1) {
    console.log('\nNext steps:');
    console.log('  npx huaweicloud-devkit install --target all');
    console.log('  Restart your agent sessions.');
  }
}
