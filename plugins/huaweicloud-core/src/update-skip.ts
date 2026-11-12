// Skip-state (dismiss) persistence for the update machinery: the plugin-local
// skip file with per-session suffixing (#607), the writable-state-tree
// fallback, and the atomic read/write pair. Part of the src/update-* family
// behind the src/update-check.ts re-export face.
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

import { asText } from './lib/as-text.ts';
import { devkitStateBase } from './lib/pack-state.ts';
import { selfDir } from './update-installed.ts';

const COOLDOWN_DAYS = 3;

export interface SkipState {
  dismissedVersion: string;
  dismissedAt: string;
  expireAt: string;
}

export function skipFilePath(): string {
  return join(resolve(selfDir(), '..'), '.update-skip.json');
}

export function fallbackSkipFilePath(): string {
  return join(devkitStateBase(), 'devkit-skip.json');
}

// 会话化 skip 文件：remote 多会话按 sessionId 拆分，stdio/默认保持原文件(向后兼容)。
function sanitizeSessionId(sessionId: unknown): string {
  return asText(sessionId || '').replace(/[^0-9a-zA-Z-]/g, '_');
}

// A1 定稿: 标准 agent 用插件目录副本(有 package.json); codex 等无副本时回退共享文件
export function resolveSkipFilePath(sessionId: string | null = null): string {
  let base: string;
  try {
    if (existsSync(join(dirname(skipFilePath()), 'package.json'))) {
      base = skipFilePath();
    } else {
      base = fallbackSkipFilePath();
    }
  } catch {
    base = fallbackSkipFilePath();
  }
  // stdio / 默认 / 无 session → 原文件（保持向后兼容）
  if (!sessionId || sessionId === 'default' || sessionId === 'stdin') return base;
  return `${base}.${sanitizeSessionId(sessionId)}`;
}

export function readSkipState(file: string): SkipState | null {
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.dismissedVersion !== 'string' ||
      typeof record.dismissedAt !== 'string' ||
      typeof record.expireAt !== 'string'
    ) {
      return null;
    }
    return {
      dismissedVersion: record.dismissedVersion,
      dismissedAt: record.dismissedAt,
      expireAt: record.expireAt,
    };
  } catch {
    return null;
  }
}

export function writeSkipState(
  file: string,
  dismissedVersion: unknown,
  { at = Date.now(), days = COOLDOWN_DAYS }: { at?: number; days?: number } = {},
): SkipState {
  const state: SkipState = {
    dismissedVersion: String(dismissedVersion),
    dismissedAt: new Date(at).toISOString(),
    expireAt: new Date(at + days * 24 * 60 * 60 * 1000).toISOString(),
  };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  try {
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  return state;
}
