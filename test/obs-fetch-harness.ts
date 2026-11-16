import { clearProxyDispatcherCache } from '../plugins/huaweicloud-core/src/proxy/proxy-agent.ts';

// The obs handlers sign REST calls through global fetch; the batteries swap
// it for a recorder and inject env-tier credentials so the signed context
// resolves without file probing (the #1003 battery's pattern, extracted
// once the PR-3c approval battery needed the same mock).

// Force the no-dispatcher branch (plain global fetch) so it is mockable, and
// pin the env credential tier so resolveCredentials finds credentials
// without file probing. Split out of withMockedFetch for the callers that
// run inside withTempAuthHome (whose isolation strips the env again AFTER
// the outer mock wrapper set it).
export function pinObsMockEnv(): void {
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) delete process.env[key];
  process.env.NO_PROXY = '*';
  process.env.HW_ACCESS_KEY = 'test-ak';
  process.env.HW_SECRET_KEY = 'test-sk';
  process.env.HW_SECURITY_TOKEN = '';
  clearProxyDispatcherCache();
}

export function withMockedFetch(
  handler: (url: unknown, opts: unknown) => Promise<{ status: number; text: () => Promise<string> }>,
  fn: () => Promise<unknown>,
): Promise<unknown> {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  pinObsMockEnv();
  globalThis.fetch = handler as unknown as typeof globalThis.fetch;
  return Promise.resolve(fn()).finally(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
    clearProxyDispatcherCache();
  });
}
