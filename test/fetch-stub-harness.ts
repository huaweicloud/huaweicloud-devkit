import fs from 'node:fs';

import { fixtureDir } from './fixture-dir.ts';

// Shared prelude for test files that stub global.fetch against the hdkit
// direct branch. Ambient proxy configuration — either env spelling (the
// resolver reads process.env.HTTPS_PROXY || process.env.https_proxy; the
// https_proxy spelling routes these https:// endpoints) or a developer's
// proxy.json — routes the request through the undici dispatcher instead and
// bypasses the stub entirely. isolateDirectFetchEnv() establishes "no proxy"
// from every source the resolver reads and points HUAWEICLOUD_HOME at a
// hermetic home (no proxy.json, no telemetry state), returning the restore
// function for the file's after() hook.
const PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'] as const;

export function isolateDirectFetchEnv(): () => void {
  const savedProxyEnv: Record<string, string | undefined> = {};
  for (const key of PROXY_ENV_KEYS) {
    savedProxyEnv[key] = process.env[key];
    delete process.env[key];
  }
  const savedHermeticHome = process.env.HUAWEICLOUD_HOME;
  const hermeticHome = fixtureDir('fetch-stub-home');
  process.env.HUAWEICLOUD_HOME = hermeticHome;
  return () => {
    for (const key of PROXY_ENV_KEYS) {
      if (savedProxyEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedProxyEnv[key];
    }
    if (savedHermeticHome === undefined) delete process.env.HUAWEICLOUD_HOME;
    else process.env.HUAWEICLOUD_HOME = savedHermeticHome;
    fs.rmSync(hermeticHome, { recursive: true, force: true });
  };
}
