// hdkit 门禁/耗尽钉共用夹具（round 24 建，jscpd 去重）：立着访问器对与
// 吞写单读谎代理在 gate-retry 与 devbridge-auth-gate 两文件的钉里反复出现
// ——同一份实现，两文件共用。

// 立着访问器对（getter/setter，模块闭包存值）：装饰写经 setter 合作、回读
// 诚实，循环后的访问器立着判定（round 21）据此挣得拒绝与登记。吞写型 set
// 传入 swallow: true 时写入静默吞下（访问器仍立着）。
export function standingAccessor(carrier: object, key: string, swallow = false): void {
  let stored: unknown;
  Object.defineProperty(carrier, key, {
    configurable: true,
    enumerable: true,
    get() {
      return stored;
    },
    set(v: unknown) {
      if (!swallow) stored = v;
    },
  });
}

// 吞写单读谎代理（round 13/24 共用形态）：set 陷阱把写入收进 pending（不落
// 目标）、get 陷阱首次奉上 pending 值后转交 serve 回退——回读匹配而目标上
// 无自有定义，落定证明（round 24/MUST 3）据此判写未落。gOPD 恒诚实。
export function swallowOnceProxy(real: Error, serve: (key: string | symbol) => unknown): object {
  const pending = new Map<string | symbol, unknown>();
  return new Proxy(real, {
    set(_t: unknown, k: string | symbol, v: unknown) {
      pending.set(k, v);
      return true;
    },
    get(_t: unknown, k: string | symbol) {
      if (pending.has(k)) {
        const v = pending.get(k);
        pending.delete(k);
        return v;
      }
      return serve(k);
    },
    getOwnPropertyDescriptor: (t: object, k: string | symbol) => Object.getOwnPropertyDescriptor(t, k) ?? undefined,
  });
}
