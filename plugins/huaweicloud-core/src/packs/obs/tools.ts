import { existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';

import { readGlobalCredentialsStrict, writeObsConfig, resolveCredentialsWithRuntime } from '../../auth/credentials.ts';
import { runHcloud } from '../../hcloud-cli.ts';
import { fetchWithProxy } from '../../proxy/proxy-agent.ts';
import { asCredentialRecord, type CredentialLike } from '../../lib/credentials.ts';
import type { PackToolDefinition, LooseToolSchema } from '../../lib/pack-types.ts';
import type { CallToolOptions, ToolArgs } from '../../tools.ts';

// Handlers migrated verbatim from src/tools.ts. setupObsConfig syncs the
// global credential vault (or the hcloud profile) into ~/.obsutilconfig;
// handleObsWebsiteConfig signs OBS REST calls with AWS4 (KooCLI OBS has no
// SetBucketWebsite operation).

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

// Mirrors the JS `a || b || ''` chain for string fields: the first non-empty
// string wins, everything else falls through.
function pickString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value) return value;
  }
  return '';
}

async function setupObsConfig(profile?: string) {
  // Strict resolved read through the shared seam: a literal secret:// string
  // written into ~/.obsutilconfig would break every obsutil call.
  const strict = readGlobalCredentialsStrict();
  if (!strict.ok) {
    return { ok: false, error: strict.error, nextStep: strict.nextStep };
  }
  const stored = asCredentialRecord(strict.credentials);
  if (stored?.ak && stored?.sk) {
    try {
      const obs: { path: string; endpoint: string } = writeObsConfig(stored);
      return {
        ok: true,
        existed: false,
        created: true,
        path: obs.path,
        region: stored.region,
        endpoint: obs.endpoint,
        source: 'global-credentials',
        note: 'OBS credentials synced from the global credential vault. OBS commands (hcloud OBS ls, mb, cp, etc.) should now work.',
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        nextStep: 'Run "npx huaweicloud-devkit auth init" to refresh credentials and region.',
      };
    }
  }

  return setupObsConfigFromHcloud(profile);
}

async function setupObsConfigFromHcloud(profile?: string) {
  const obsConfigPath = join(homedir(), '.obsutilconfig');
  if (existsSync(obsConfigPath)) {
    return {
      ok: true,
      existed: true,
      path: obsConfigPath,
      note: 'OBS config already exists. Delete ~/.obsutilconfig first if you need to re-sync.',
    };
  }

  const args = ['configure', 'show'];
  if (profile) args.push('--cli-profile', String(profile));
  const result = await runHcloud(args, { allowWrites: false, allowCredentialRead: true });

  if (!result.ok) {
    return {
      ok: false,
      error: 'Failed to read hcloud profile.',
      detail: result.error || result.stderr || 'hcloud not installed or not configured',
      nextStep: 'Run "npx huaweicloud-devkit auth init" outside agent chat, then retry.',
    };
  }

  let accessKeyId: string;
  let secretAccessKey: string;
  let region: string;

  try {
    const parsed: unknown = typeof result.stdout === 'string' ? JSON.parse(result.stdout) : result.stdout;
    const cred = asRecord(asRecord(parsed).currentCredential);
    accessKeyId = pickString(cred.accessKeyId, cred.ak, cred.access_key);
    secretAccessKey = pickString(cred.secretAccessKey, cred.sk, cred.secret_key);
    region = pickString(asRecord(parsed).currentRegion, asRecord(parsed).region);
  } catch {
    return {
      ok: false,
      error: 'Failed to parse hcloud profile output.',
      detail: 'hcloud configure show returned unexpected format',
    };
  }

  if (!accessKeyId || !secretAccessKey) {
    return {
      ok: false,
      error: 'No credentials found in hcloud profile.',
      nextStep: 'Run "npx huaweicloud-devkit auth init" outside agent chat to set up credentials first.',
    };
  }

  if (!region) {
    return {
      ok: false,
      error: 'No region found in hcloud profile.',
      nextStep: 'Run "npx huaweicloud-devkit auth init" outside agent chat to configure credentials and region.',
    };
  }

  const endpoint = `https://obs.${region}.myhuaweicloud.com`;
  // Flat key=value format (no [default] section) as written by KooCLI 7.x `hcloud OBS config`.
  const configContent = `endpoint=${endpoint}\nak=${accessKeyId}\nsk=${secretAccessKey}\n`;

  try {
    writeFileSync(obsConfigPath, configContent, { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    return {
      ok: false,
      error: 'Failed to write OBS config file.',
      detail: error instanceof Error ? error.message : String(error),
      path: obsConfigPath,
    };
  }

  return {
    ok: true,
    existed: false,
    created: true,
    path: obsConfigPath,
    region,
    endpoint,
    note: 'OBS credentials synced from hcloud profile. OBS commands (hcloud OBS ls, mb, cp, etc.) should now work.',
  };
}

// ── OBS Static Website Hosting (AWS4 signed REST API) ──

async function handleObsWebsiteConfig(args: ToolArgs, _opts: CallToolOptions = {}) {
  const { action, bucket, region, indexDocument, errorDocument } = args;
  if (!bucket || !region) {
    throw new Error('bucket and region are required');
  }
  const creds = asCredentialRecord(resolveCredentialsWithRuntime({}));
  const obsAk = creds?.ak;
  const obsSk = creds?.sk;
  if (!obsAk || !obsSk) {
    throw new Error('OBS website config requires AK/SK credentials. Run huaweicloud_auth_init first.');
  }
  const signedCreds = { ak: obsAk, sk: obsSk, securityToken: creds?.securityToken };

  const host = `${bucket}.obs.${region}.myhuaweicloud.com`;
  const endpoint = `https://${host}`;

  if (action === 'get') {
    const res = await obsSignedRequest('GET', endpoint, '/?website', '', signedCreds, region);
    return { ok: res.status === 200, status: res.status, body: res.body };
  }

  if (action === 'delete') {
    const res = await obsSignedRequest('DELETE', endpoint, '/?website', '', signedCreds, region);
    return { ok: res.status === 204, status: res.status };
  }

  if (action === 'set') {
    if (!indexDocument) {
      throw new Error('indexDocument is required for action=set');
    }
    const xmlParts = ['<WebsiteConfiguration>', `  <IndexDocument><Suffix>${indexDocument}</Suffix></IndexDocument>`];
    if (errorDocument) {
      xmlParts.push(`  <ErrorDocument><Key>${errorDocument}</Key></ErrorDocument>`);
    }
    xmlParts.push('</WebsiteConfiguration>');
    const body = xmlParts.join('\n');
    const res = await obsSignedRequest('PUT', endpoint, '/?website', body, signedCreds, region);
    const websiteUrl = `http://${bucket}.obs-website.${region}.myhuaweicloud.com`;
    return {
      ok: res.status === 200,
      status: res.status,
      websiteUrl,
      message:
        res.status === 200
          ? `Static website hosting configured. Website URL: ${websiteUrl} (may take ~1 min to propagate)`
          : `Failed to configure website: HTTP ${res.status}`,
    };
  }

  throw new Error(`Unknown action: ${action}. Use set, get, or delete.`);
}

async function obsSignedRequest(
  method: string,
  endpoint: string,
  pathAndQuery: string,
  body: string,
  // Callers throw unless ak and sk are present, so they are required here.
  creds: CredentialLike & { ak: string; sk: string },
  region: string,
): Promise<{ status: number; body: string }> {
  const now = new Date();
  const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, '');
  const amzDate = dateStamp + 'T' + now.toISOString().slice(11, 19).replace(/:/g, '') + 'Z';
  const payloadHash = createHash('sha256').update(body).digest('hex');

  const url = new URL(endpoint + pathAndQuery);
  const canonicalUri = '/';
  const canonicalQueryString = 'website=';
  const canonicalHeaders = `host:${url.host}\n` + `x-amz-content-sha256:${payloadHash}\n` + `x-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');

  const kDate = createHmac('sha256', 'AWS4' + creds.sk)
    .update(dateStamp)
    .digest();
  const kRegion = createHmac('sha256', kDate).update(region).digest();
  const kService = createHmac('sha256', kRegion).update('s3').digest();
  const kSigning = createHmac('sha256', kService).update('aws4_request').digest();
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${creds.ak}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const headers: Record<string, string> = {
    Host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    Authorization: authorization,
  };
  if (body) headers['Content-Type'] = 'application/xml';
  if (creds.securityToken) headers['x-amz-security-token'] = creds.securityToken;

  const res = await fetchWithProxy(endpoint + pathAndQuery, {
    method,
    headers,
    body: body || undefined,
  });
  const resBody = await res.text();
  return { status: res.status, body: resBody };
}

const setupObsConfigSchema = z.looseObject({
  profile: z.string().optional().describe('Optional KooCLI profile name. Uses the active profile by default.'),
});

const obsWebsiteConfigSchema = z.looseObject({
  action: z
    .enum(['set', 'get', 'delete'])
    .describe('操作类型：set=配置静态网站托管，get=查询当前配置，delete=删除配置'),
  bucket: z.string().describe('OBS 桶名称'),
  region: z.string().describe('OBS 桶所在区域，如 cn-north-4'),
  indexDocument: z.string().optional().describe('首页文件名（action=set 时必填），如 index.html'),
  errorDocument: z.string().optional().describe('错误页面文件名（action=set 时可选），如 404.html 或 error.html'),
});

async function handleSetupObsConfig(args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  return setupObsConfig(args.profile);
}

export const OBS_TOOLS = [
  {
    name: 'huaweicloud_setup_obs_config',
    description:
      'Synchronize KooCLI credentials to OBS config (~/.obsutilconfig). KooCLI and OBS use separate credential stores — hcloud commands work fine but OBS commands fail with "Please set ak, sk" unless this sync is done. Run this once to enable OBS operations; re-run after changing hcloud credentials.',
    schema: setupObsConfigSchema,
    handler: handleSetupObsConfig,
  },
  {
    name: 'huaweicloud_obs_set_website_config',
    description:
      '配置 OBS 桶的静态网站托管。KooCLI OBS 不支持 SetBucketWebsite API，此工具内部实现 AWS4 签名调用 OBS REST API，屏蔽签名细节。支持 set（配置）、get（查询）、delete（删除）三种操作。操作前需确保桶已创建且已设置 public-read ACL。',
    schema: obsWebsiteConfigSchema,
    handler: handleObsWebsiteConfig,
  },
] as const satisfies readonly PackToolDefinition[];

export type ObsToolName = (typeof OBS_TOOLS)[number]['name'];

// Schema map keyed by tool name for src/tool-schemas.ts: TOOL_SCHEMAS spreads
// it in place, keeping the satisfies Record<ToolName, LooseToolSchema>
// completeness check over every ToolName key.
export const OBS_TOOL_SCHEMAS: Readonly<Record<ObsToolName, LooseToolSchema>> = {
  huaweicloud_setup_obs_config: setupObsConfigSchema,
  huaweicloud_obs_set_website_config: obsWebsiteConfigSchema,
};

// Dispatch map merged into PACK_TOOL_HANDLERS in packs/registry.ts. Typed over
// ObsToolName, so a tool added to OBS_TOOLS without a handler entry
// here — or the reverse — fails to compile instead of failing at runtime.
export const OBS_TOOL_HANDLERS: Readonly<Record<ObsToolName, PackToolDefinition['handler']>> = {
  huaweicloud_setup_obs_config: handleSetupObsConfig,
  huaweicloud_obs_set_website_config: handleObsWebsiteConfig,
};
