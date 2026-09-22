export const DEVKIT_DEBUG_ENV = 'HUAWEICLOUD_DEVKIT_DEBUG';

export function isDebugEnv(value = process.env[DEVKIT_DEBUG_ENV]) {
  return value === '1' || value === 'true';
}
