import assert from 'node:assert/strict';
import test from 'node:test';

import { callTool } from '../plugins/huaweicloud-core/src/tools.mjs';

const EXP_CASES = [
  { id: 'EXP-E01', intent: '帮我查一下我账号在华北北京四有哪些云主机', expect: ['ECS'] },
  { id: 'EXP-E02', intent: '创建一台 2C4G 的 Ubuntu 云服务器', expect: ['ECS'] },
  { id: 'EXP-E03', intent: '把本地 dist 目录部署成一个公网静态网站', expect: ['OBS'] },
  { id: 'EXP-E04', intent: '给这台服务器绑定一个弹性公网IP', expect: ['EIP'] },
  { id: 'EXP-E05', intent: '看一下我的云数据库MySQL实例的状态', expect: ['RDS'] },
  { id: 'EXP-E07', intent: '给生产环境的服务器配置一个每日备份策略', expect: ['CBR'] },
  { id: 'EXP-E10', intent: '部署一个函数处理图片自动压缩', expect: ['FunctionGraph'] },
  { id: 'EXP-E11', intent: '查一下我账号这个月的费用情况', expect: ['BSS'] },
  { id: 'EXP-E12', intent: '把应用日志指标推送到云监控告警', expect: ['CES'] },
  { id: 'EXP-E13', intent: '申请HTTPS证书并配置到我的域名', expect: ['ELB'] },
  { id: 'EXP-E14', intent: '我账号下的用户都有哪些权限 帮我审计一下', expect: ['IAM'] },
];

test('EXP-E01~E14 (except E08 N/A) all route to expected services (#857)', async () => {
  let hits = 0;
  for (const c of EXP_CASES) {
    const result = await callTool('huaweicloud_service_catalog', { intent: c.intent });
    const ok = c.expect.every((s) => result.recommendedServices.includes(s));
    assert.equal(ok, true, `${c.id} ('${c.intent}') should route to ${c.expect.join('/')}, got [${result.recommendedServices.join(',')}]`);
    if (ok) hits += 1;
  }
  const accuracy = hits / EXP_CASES.length;
  assert.ok(accuracy >= 0.9, `Chinese-intent routing accuracy ${(accuracy * 100).toFixed(1)}% < 90%`);
});

test('EXP-E03: public static website prefers OBS over sandbox (#857)', async () => {
  const result = await callTool('huaweicloud_service_catalog', {
    intent: '把本地 dist 目录部署成一个公网静态网站',
  });
  assert.equal(result.recommendedSkills[0], 'huawei-obs');
  assert.ok(result.recommendedServices.includes('OBS'));
});

test('preview/webapp intent still routes to sandbox first (no regression, #857)', async () => {
  const en = await callTool('huaweicloud_service_catalog', { intent: 'host a web app for preview' });
  assert.equal(en.recommendedSkills[0], 'huawei-sandbox');
  const zh = await callTool('huaweicloud_service_catalog', { intent: '部署一个网页应用用于预览' });
  assert.equal(zh.recommendedSkills[0], 'huawei-sandbox');
});

test('static website in English prefers OBS (#857)', async () => {
  const result = await callTool('huaweicloud_service_catalog', {
    intent: 'deploy a static website to object storage',
  });
  assert.equal(result.recommendedSkills[0], 'huawei-obs');
});
