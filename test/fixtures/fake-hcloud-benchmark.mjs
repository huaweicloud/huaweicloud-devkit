#!/usr/bin/env node
'use strict';

/**
 * Fake hcloud for Harbor benchmark tests — simulates KooCLI subprocess execution.
 *
 * This is a SEPARATE fixture from test/fixtures/fake-hcloud.mjs (which is shared
 * by auth/credential tests). Harbor benchmark tests use this file via HCLOUD_BIN
 * to avoid interfering with other test suites.
 *
 * Usage: Set HCLOUD_BIN to point to this file.
 *   node test/fixtures/fake-hcloud-benchmark.mjs version
 *   node test/fixtures/fake-hcloud-benchmark.mjs ECS ListServersDetails --cli-region=cn-north-4
 */

const args = process.argv.slice(2);

if (args[0] === 'version') {
  process.stdout.write('KooCLI 7.2.12\nCurrent version: 7.2.12\n');
  process.exit(0);
}

if (args[0] === '--help') {
  process.stdout.write('Available services: ECS, OBS, VPC, RDS, IAM, ...\n');
  process.exit(0);
}

const service = args[0] || '';
const operation = args[1] || '';

const MOCK = {
  'ECS ListServersDetails': {
    exitCode: 0,
    stdout: JSON.stringify({
      servers: [
        { name: 'ecs-benchmark-01', status: 'ACTIVE', id: '1d4e1234567890abcdef', flavor: 's6.large.2' },
        { name: 'ecs-benchmark-02', status: 'STOPPED', id: '2e5f2345678901abcdef0', flavor: 's6.medium.2' },
      ],
      count: 2,
    }),
  },
  'ECS NovaListServers': {
    exitCode: 0,
    stdout: JSON.stringify({
      servers: [{ name: 'ecs-01', status: 'ACTIVE', id: 'abc123' }],
      count: 1,
    }),
  },
  'ECS CreateServers': {
    exitCode: 0,
    stdout: JSON.stringify({ server: { id: 'new-ecs-benchmark', status: 'BUILD' } }),
  },
  'ECS DeleteServers': {
    exitCode: 0,
    stdout: JSON.stringify({ job_id: 'ff8080821234567890' }),
  },
  'VPC ListSecurityGroups': {
    exitCode: 0,
    stdout: JSON.stringify({
      security_groups: [{ id: 'sg-001', name: 'default-sg', vpc_id: 'vpc-001' }],
    }),
  },
  'OBS ls': {
    exitCode: 0,
    stdout: 'obs://benchmark-bucket-01\nobs://benchmark-bucket-02\n',
  },
  'OBS mb': {
    exitCode: 0,
    stdout: 'Created bucket obs://benchmark-bucket-01\n',
  },
};

const key = `${service} ${operation}`;
const mock = MOCK[key];

if (mock) {
  process.stdout.write(mock.stdout);
  process.exit(mock.exitCode);
}

process.stdout.write('{}');
process.exit(0);
