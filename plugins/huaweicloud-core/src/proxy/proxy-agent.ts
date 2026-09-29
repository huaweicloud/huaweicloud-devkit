import type { Dispatcher } from 'undici';

import { getProxyUrlForTarget } from './proxy-config.ts';

type UndiciModule = typeof import('undici');

let cachedDispatcher: Dispatcher | undefined = undefined;
let cachedDispatcherProxyUrl: string | null = null;

// Enterprise MITM proxies re-sign TLS on BOTH legs: the proxy's own certificate
// (`proxyTls`) and the tunneled connection to the target server (`requestTls`).
// Both must be relaxed for such environments. Note `requestTls` is NOT the proxy
// cert — it is the target-server cert seen through the tunnel. This relaxation is
// scoped to proxied connections only; direct connections keep strict certificate
// verification (see the non-proxy branch of `fetchWithProxy`).
export const PROXY_TLS_OPTIONS = {
  proxyTls: { rejectUnauthorized: false },
  requestTls: { rejectUnauthorized: false },
};

const NODE_UNDICI_SPECIFIER = 'node:undici';

async function importUndici(): Promise<UndiciModule> {
  try {
    // Node exposes the bundled client as `node:undici`; fall back to the npm package.
    return (await import(NODE_UNDICI_SPECIFIER)) as UndiciModule;
  } catch {
    return await import('undici');
  }
}

export async function getProxyDispatcher(targetUrl?: string | URL): Promise<Dispatcher | undefined> {
  const proxyUrl = getProxyUrlForTarget(targetUrl);
  if (!proxyUrl) return undefined;

  if (cachedDispatcher && cachedDispatcherProxyUrl === proxyUrl) {
    return cachedDispatcher;
  }

  const { ProxyAgent } = await importUndici();
  cachedDispatcher = new ProxyAgent({ uri: proxyUrl, ...PROXY_TLS_OPTIONS });
  cachedDispatcherProxyUrl = proxyUrl;
  return cachedDispatcher;
}

export async function fetchWithProxy(url: string | URL, options: RequestInit = {}) {
  const dispatcher = await getProxyDispatcher(url);
  if (!dispatcher) return fetch(url, options);
  const { fetch: undiciFetch } = await importUndici();
  // Bridge the duplicated undici type packages (@types/node's undici-types vs
  // the undici npm package); both describe the same runtime RequestInit.
  const init = { ...options, dispatcher } as unknown as Parameters<typeof undiciFetch>[1];
  return undiciFetch(url, init);
}

export function clearProxyDispatcherCache(): void {
  cachedDispatcher = undefined;
  cachedDispatcherProxyUrl = null;
}

export async function createProxyWebSocket(url: string | URL, protocols?: string | string[]) {
  const proxyUrl = getProxyUrlForTarget(url);
  if (!proxyUrl) {
    return new globalThis.WebSocket(url, protocols);
  }

  const dispatcher = await getProxyDispatcher(url);
  const { WebSocket: UndiciWebSocket } = await importUndici();

  const wsOptions: { dispatcher?: Dispatcher; protocols?: string | string[] } = { dispatcher };
  if (protocols) {
    if (Array.isArray(protocols)) {
      wsOptions.protocols = protocols;
    } else {
      wsOptions.protocols = [protocols];
    }
  }

  return new UndiciWebSocket(url, wsOptions);
}

export async function getWebSocketImpl(targetUrl?: string) {
  const proxyUrl = getProxyUrlForTarget(targetUrl);
  if (!proxyUrl) return globalThis.WebSocket;

  const dispatcher = await getProxyDispatcher(targetUrl);
  const { WebSocket: UndiciWebSocket } = await importUndici();

  class ProxyWebSocket extends UndiciWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      const options: { dispatcher?: Dispatcher; protocols?: string | string[] } = { dispatcher };
      if (protocols) {
        options.protocols = Array.isArray(protocols) ? protocols : [protocols];
      }
      super(url, options);
    }
  }

  return ProxyWebSocket;
}
