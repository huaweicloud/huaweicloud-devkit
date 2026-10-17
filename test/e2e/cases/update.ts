import type { E2eCase } from '../types.ts';

export const updateCases: E2eCase[] = [
  {
    id: 'update-check-registry-seam',
    pack: 'update',
    prompt: '调用 huaweicloud_check_update 检查 huaweicloud-devkit 有没有新版本,把检查结果告诉我。只检查,不要升级。',
    fixtures: {
      updateCheck: true,
      http: {
        responses: [
          {
            path: '/-/package/huaweicloud-devkit/dist-tags',
            method: 'GET',
            status: 200,
            // Static 0.0.1 (< current, zero-decoration nondeterminism) —
            // up_to_date means no update hint decorates any tool result.
            body: { latest: '0.0.1', next: '0.0.1' },
          },
        ],
      },
    },
    expect: [
      // The gate. The boot prewarm (runStdioServer) fires the single
      // registry query BEFORE any tool call; the tool then reads the 1h
      // cache — so the GET count, not a toolCall→http order, is the
      // assertion (cross-channel ordering is off-limits anyway).
      {
        kind: 'http',
        method: 'GET',
        path: '/-/package/huaweicloud-devkit/dist-tags',
        times: { min: 1, max: 2 },
      },
      // Liveness only: a failed query yields result:'check_failed' with
      // ok:true, so toolCall-ok cannot gate the mechanism.
      { kind: 'toolCall', name: 'huaweicloud_check_update', ok: true },
      // Interception-failure cascade guard: a missed seam means the REAL
      // registry's latest decorates the session's first tool result and an
      // agent may "helpfully" run a real npx upgrade — a real download
      // inside a supposedly hermetic session. Forbidden outright.
      { kind: 'noToolCall', name: 'huaweicloud_upgrade' },
    ],
    softExpect: [{ kind: 'agentSays', text: { any: ['已是最新', '最新版本', 'up.to.date', '0.0.1'] } }],
    budget: { timeoutMs: 240_000, attempts: 2 },
  },
];
