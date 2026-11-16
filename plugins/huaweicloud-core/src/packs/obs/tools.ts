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
import { approvalTokenArg, approvedByUserArg } from '../../lib/tool-schema-parts.ts';
import { asRecord } from '../../lib/as-record.ts';

// Handlers migrated verbatim from src/tools.ts. setupObsConfig syncs the
// global credential vault (or the hcloud profile) into ~/.obsutilconfig;
// handleObsWebsiteConfig signs OBS REST calls with AWS4 — the recommended
// website-config path (no XML file juggling) over KooCLI 7.3.12+'s
// `OBS website -method=put -localfile=<xml>` command (7.2.x had neither).

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

// Shared preamble for the AWS4-signed bucket-config handlers (website/CORS):
// credential resolution (with the auth_init pointer) and the bucket endpoint.
function obsSignedContext(bucket: string, region: string, what: string) {
  // Propagating consumers fold the strict S1 seam (AGENTS.md doctrine): a
  // broken vault ref surfaces with its remediation shape, not a raw throw.
  let creds: ReturnType<typeof asCredentialRecord>;
  try {
    creds = asCredentialRecord(resolveCredentialsWithRuntime({}));
  } catch (error) {
    throw new Error(
      `OBS ${what} could not resolve credentials: ${error instanceof Error ? error.message : String(error)}. ` +
        'Fix the S1 credential vault (or re-run huaweicloud_auth_init) and retry.',
      { cause: error },
    );
  }
  const obsAk = creds?.ak;
  const obsSk = creds?.sk;
  if (!obsAk || !obsSk) {
    throw new Error(`OBS ${what} requires AK/SK credentials. Run huaweicloud_auth_init first.`);
  }
  const signedCreds = { ak: obsAk, sk: obsSk, securityToken: creds?.securityToken };
  const host = `${bucket}.obs.${region}.myhuaweicloud.com`;
  return { signedCreds, host, endpoint: `https://${host}` };
}

// ── OBS Static Website Hosting (AWS4 signed REST API) ──

async function handleObsWebsiteConfig(args: ToolArgs, _opts: CallToolOptions = {}) {
  const { action, bucket, region, indexDocument, errorDocument } = args;
  if (!bucket || !region) {
    throw new Error('bucket and region are required');
  }
  const { signedCreds, endpoint } = obsSignedContext(bucket, region, 'website config');

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

// #1003: same-structure extension of handleObsWebsiteConfig — before the
// 7.3.12 pin there was no CORS MCP path (7.2.x lacked the cors subcommand;
// 7.3.12 materialized it — the U0 A/B logs hold the live evidence), so agents
// fell back to installing a Python SDK in the sandbox just to configure CORS.
// This reuses obsSignedRequest (AWS4, s3 service) against /?cors.
async function handleObsCorsConfig(args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  const { action, bucket, region, rules } = args;
  if (!bucket || !region) {
    throw new Error('bucket and region are required');
  }
  const { signedCreds, host, endpoint } = obsSignedContext(bucket, region, 'CORS config');
  const preflightHint =
    'Verify with an OPTIONS preflight before declaring success: ' +
    `curl -i -X OPTIONS --noproxy '*' 'https://${host}/<object-key>' -H 'Origin: <your-app-origin>' -H 'Access-Control-Request-Method: HEAD' ` +
    'must return HTTP 200 with an Access-Control-Allow-Origin header (200 without CORS headers = config not effective; ' +
    '403 = rule missing the requested method). See the huawei-obs skill common-pitfalls.md p05.';

  if (action === 'get') {
    const res = await obsSignedRequest('GET', endpoint, '/?cors', '', signedCreds, region, 'cors');
    return { ok: res.status === 200, status: res.status, body: res.body, verify: preflightHint };
  }

  if (action === 'delete') {
    const res = await obsSignedRequest('DELETE', endpoint, '/?cors', '', signedCreds, region, 'cors');
    return { ok: res.status === 204, status: res.status };
  }

  if (action === 'set') {
    if (!Array.isArray(rules) || rules.length === 0) {
      throw new Error('rules array is required for action=set (allowedOrigin + allowedMethod, HEAD included)');
    }
    const VALID_METHODS = new Set(['GET', 'PUT', 'POST', 'DELETE', 'HEAD']);
    for (const rule of rules as Array<Record<string, unknown>>) {
      const allowedOrigin = rule?.allowedOrigin;
      const allowedMethod = rule?.allowedMethod;
      if (
        typeof allowedOrigin !== 'string' ||
        !allowedOrigin ||
        !Array.isArray(allowedMethod) ||
        allowedMethod.length === 0
      ) {
        throw new Error('each CORS rule needs allowedOrigin and a non-empty allowedMethod array');
      }
      for (const method of allowedMethod) {
        if (typeof method !== 'string' || !VALID_METHODS.has(method)) {
          throw new Error(
            `allowedMethod entries must be one of GET/PUT/POST/DELETE/HEAD (got ${JSON.stringify(method)})`,
          );
        }
      }
      if (!(allowedMethod as unknown[]).includes('HEAD')) {
        // p01: the BrowserJS SDK's HEAD ?apiversion probe gets swallowed by the
        // browser when HEAD is missing — the exact failure this tool exists to
        // prevent, so reject it at the input boundary instead of at runtime.
        throw new Error(
          "allowedMethod must include 'HEAD' — the BrowserJS SDK sends a HEAD ?apiversion probe before every " +
            'operation, and a CORS rule without HEAD makes the browser swallow it as Network Error (p01).',
        );
      }
    }
    const escapeXml = (s: unknown) =>
      String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const xmlParts = ['<CORSConfiguration>'];
    for (const rule of rules as Array<Record<string, unknown>>) {
      xmlParts.push('  <CORSRule>');
      xmlParts.push(`    <AllowedOrigin>${escapeXml(rule.allowedOrigin)}</AllowedOrigin>`);
      for (const method of (rule.allowedMethod as unknown[]) ?? []) {
        xmlParts.push(`    <AllowedMethod>${escapeXml(method)}</AllowedMethod>`);
      }
      const headers = rule?.allowedHeader;
      if (headers != null && !Array.isArray(headers)) {
        throw new Error(`allowedHeader must be an array (got ${JSON.stringify(headers)})`);
      }
      for (const header of (headers as unknown[] | undefined) ?? ['*']) {
        xmlParts.push(`    <AllowedHeader>${escapeXml(header)}</AllowedHeader>`);
      }
      const maxAge = rule.maxAgeSeconds;
      if (maxAge != null) {
        const n = Number(maxAge);
        if (!Number.isSafeInteger(n) || n < 0) {
          throw new Error(`maxAgeSeconds must be a non-negative integer (got ${JSON.stringify(maxAge)})`);
        }
        xmlParts.push(`    <MaxAgeSeconds>${n}</MaxAgeSeconds>`);
      } else {
        // The documented default (schema description) — omitting the element
        // would leave the preflight cache to browser defaults, not 3000.
        xmlParts.push('    <MaxAgeSeconds>3000</MaxAgeSeconds>');
      }
      xmlParts.push('  </CORSRule>');
    }
    xmlParts.push('</CORSConfiguration>');
    const body = xmlParts.join('\n');
    const res = await obsSignedRequest('PUT', endpoint, '/?cors', body, signedCreds, region, 'cors');
    return {
      ok: res.status === 200,
      status: res.status,
      message:
        res.status === 200
          ? `CORS configured for ${bucket} (${rules.length} rule(s)).`
          : `Failed to configure CORS: HTTP ${res.status}`,
      errorDetail: res.status === 200 ? undefined : res.body.slice(0, 400),
      verify: preflightHint,
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
  // #1003: the bucket subresource being addressed — 'website' for
  // PUT/GET/DELETE /?website, 'cors' for /?cors. Credential scope uses the
  // s3 service name (OBS is S3-compatible).
  subresource: 'website' | 'cors' = 'website',
): Promise<{ status: number; body: string }> {
  const now = new Date();
  const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, '');
  const amzDate = dateStamp + 'T' + now.toISOString().slice(11, 19).replace(/:/g, '') + 'Z';
  const payloadHash = createHash('sha256').update(body).digest('hex');

  const url = new URL(endpoint + pathAndQuery);
  const canonicalUri = '/';
  const canonicalQueryString = `${subresource}=`;
  // SigV4 requires every sent x-amz-* header to be signed — an unsigned
  // x-amz-security-token 403s for STS-credential calls. The header list stays
  // sorted (host, x-amz-content-sha256, x-amz-date, x-amz-security-token).
  const tokenHeader = creds.securityToken ? `x-amz-security-token:${creds.securityToken}\n` : '';
  const canonicalHeaders =
    `host:${url.host}\n` + `x-amz-content-sha256:${payloadHash}\n` + `x-amz-date:${amzDate}\n` + tokenHeader;
  const signedHeaders = creds.securityToken
    ? 'host;x-amz-content-sha256;x-amz-date;x-amz-security-token'
    : 'host;x-amz-content-sha256;x-amz-date';
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
  approvalToken: approvalTokenArg,
  approvedByUser: approvedByUserArg,
});

const obsCorsConfigSchema = z.looseObject({
  action: z.enum(['set', 'get', 'delete']).describe('操作类型：set=配置 CORS 规则，get=查询当前规则，delete=删除规则'),
  bucket: z.string().describe('OBS 桶名称'),
  region: z.string().describe('OBS 桶所在区域，如 cn-north-4'),
  approvalToken: approvalTokenArg,
  approvedByUser: approvedByUserArg,
  rules: z
    .array(
      z.looseObject({
        allowedOrigin: z.string().describe('允许的来源，如 https://your-app.example.com 或 *'),
        allowedMethod: z
          .array(z.string())
          .describe('允许的 HTTP 方法（GET/PUT/POST/DELETE/HEAD，必须含 HEAD — BrowserJS SDK 探测依赖）'),
        allowedHeader: z.array(z.string()).optional().describe('允许的请求头，默认 ["*"]'),
        maxAgeSeconds: z.number().int().min(0).optional().describe('预检结果缓存秒数，默认 3000'),
      }),
    )
    .optional()
    .describe('CORS 规则数组（action=set 时必填）；allowedMethod 必须含 HEAD'),
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
      '配置 OBS 桶的静态网站托管（推荐路径：无需手写 XML，此工具内部实现 AWS4 签名调用 OBS REST API，屏蔽签名细节）。支持 set（配置）、get（查询）、delete（删除）三种操作。审批门把关（PR-3c）：set 与 delete 是对线上桶的签名 PUT/DELETE，无 token 调用返回 USER_CONFIRMATION_REQUIRED 供用户在终端确认，DEVKIT_APPROVAL_MODE=ask 时由服务器弹出确认；get 是签名只读，从不确认、直接执行。KooCLI 7.3.12+ 另有 `hcloud OBS website -method=put -localfile=<xml>`（XML 文件方式；7.2.x 无此 CLI 命令）。操作前需确保桶已创建且已设置 public-read ACL。',
    schema: obsWebsiteConfigSchema,
    handler: handleObsWebsiteConfig,
  },
  {
    name: 'huaweicloud_obs_set_cors',
    // U0-informed wording: KooCLI 7.3.12 (the pinned version) DOES expose the
    // cors subcommand (live-measured: OBS help cors exit 0, -method=get on a
    // nonexistent bucket returns OBS-side NoSuchBucket) — main's description
    // claimed the CLI lacks it, measured on its 7.2.x sandbox. The tool stays
    // the recommended path (no XML file, no --noproxy traps); the CLI is the
    // scripted alternative for 7.3.12+ environments.
    description:
      '配置 OBS 桶的 CORS 规则（浏览器直传前置条件；推荐路径：此工具内部实现 AWS4 签名调用 OBS REST API（PUT/GET/DELETE /?cors），无需手写 XML，屏蔽签名细节）。支持 set（配置）、get（查询）、delete（删除）三种操作。审批门把关（PR-3c）：set 与 delete 是对线上桶的签名 PUT/DELETE，无 token 调用返回 USER_CONFIRMATION_REQUIRED 供用户在终端确认，DEVKIT_APPROVAL_MODE=ask 时由服务器弹出确认；get 是签名只读，从不确认、直接执行。allowedMethod 必须含 HEAD（BrowserJS SDK 每次操作前发 HEAD ?apiversion 探测，缺 HEAD 时浏览器吞掉探测请求报 Network Error）。KooCLI 7.3.12+ 另有 `hcloud OBS cors obs://<bucket> -method=put -localfile=<xml>`（XML 文件方式；7.2.x 无此 CLI 命令）。配置成功后用返回体中的 verify 命令做 OPTIONS 预检验证（200 + Access-Control-Allow-Origin 才算成功）。',
    schema: obsCorsConfigSchema,
    handler: handleObsCorsConfig,
  },
] as const satisfies readonly PackToolDefinition[];

export type ObsToolName = (typeof OBS_TOOLS)[number]['name'];

// Schema map keyed by tool name for src/tool-schemas.ts: TOOL_SCHEMAS spreads
// it in place, keeping the satisfies Record<ToolName, LooseToolSchema>
// completeness check over every ToolName key.
export const OBS_TOOL_SCHEMAS: Readonly<Record<ObsToolName, LooseToolSchema>> = {
  huaweicloud_setup_obs_config: setupObsConfigSchema,
  huaweicloud_obs_set_website_config: obsWebsiteConfigSchema,
  huaweicloud_obs_set_cors: obsCorsConfigSchema,
};

// Dispatch map merged into PACK_TOOL_HANDLERS in packs/registry.ts. Typed over
// ObsToolName, so a tool added to OBS_TOOLS without a handler entry
// here — or the reverse — fails to compile instead of failing at runtime.
export const OBS_TOOL_HANDLERS: Readonly<Record<ObsToolName, PackToolDefinition['handler']>> = {
  huaweicloud_setup_obs_config: handleSetupObsConfig,
  huaweicloud_obs_set_website_config: handleObsWebsiteConfig,
  huaweicloud_obs_set_cors: handleObsCorsConfig,
};
