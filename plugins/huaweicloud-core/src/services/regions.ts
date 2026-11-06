// Service region descriptor, migrated verbatim from the inline `known` table
// in the former tools.ts getRegionalAvailability (the handler now lives in
// services/availability.ts). TS-as-data, same as PACK_IDS/PACK_OF.
//
// Guarantee scope, stated honestly:
//   - the `satisfies` check pins only the VALUE shape (every entry is a
//     readonly string array); Record<string, ...> has open keys, so a missing
//     or extra service still compiles;
//   - KEY-set completeness is pinned by test/service-regions.test.ts, which
//     hardcodes the 17-service list and fails when the table drifts (unlike
//     PACK_OF there is no closed key union to lean on — do not borrow that
//     pattern here);
//   - what the compiler does catch is a use-site typo: SERVICE_REGIONS.ecs is
//     a property access on this object, so a misspelled key fails the build.
//
// regions is the only field: it is the one service-metadata consumer that
// exists today (getRegionalAvailability). operations, risk hints, and icons
// stay in their current homes until a consumer exists.
export const SERVICE_REGIONS = {
  ecs: [
    'cn-south-1',
    'cn-north-4',
    'cn-north-1',
    'cn-east-3',
    'cn-east-2',
    'ap-southeast-3',
    'ap-southeast-2',
    'ap-southeast-1',
    'ap-southeast-4',
    'af-south-1',
    'tr-west-1',
    'sa-brazil-1',
    'la-north-2',
    'na-mexico-1',
    'me-east-1',
  ],
  obs: [
    'cn-south-1',
    'cn-north-4',
    'cn-north-1',
    'cn-east-3',
    'cn-east-2',
    'ap-southeast-3',
    'ap-southeast-2',
    'ap-southeast-1',
    'af-south-1',
  ],
  vpc: [
    'cn-south-1',
    'cn-north-4',
    'cn-north-1',
    'cn-east-3',
    'cn-east-2',
    'ap-southeast-3',
    'ap-southeast-2',
    'ap-southeast-1',
    'ap-southeast-4',
    'af-south-1',
    'tr-west-1',
    'sa-brazil-1',
    'la-north-2',
    'me-east-1',
  ],
  iam: ['global'],
  rds: [
    'cn-south-1',
    'cn-north-4',
    'cn-north-1',
    'cn-east-3',
    'cn-east-2',
    'ap-southeast-3',
    'ap-southeast-2',
    'ap-southeast-1',
  ],
  gaussdb: ['cn-south-1', 'cn-north-4', 'cn-east-3'],
  cce: [
    'cn-south-1',
    'cn-north-4',
    'cn-north-1',
    'cn-east-3',
    'cn-east-2',
    'ap-southeast-3',
    'ap-southeast-2',
    'ap-southeast-1',
  ],
  modelarts: ['cn-south-1', 'cn-north-4', 'cn-east-3'],
  functiongraph: [
    'cn-south-1',
    'cn-north-4',
    'cn-north-1',
    'cn-east-3',
    'cn-east-2',
    'ap-southeast-3',
    'ap-southeast-2',
    'ap-southeast-1',
  ],
  dew: ['cn-south-1', 'cn-north-4', 'cn-east-3', 'ap-southeast-3'],
  // KMS answers under the DEW umbrella (key management lives in DEW); the
  // alias mirrors dew's region list so a `kms` lookup no longer reports a
  // cache miss while the same-family `dew` entry answers available:true
  // (2026-11-05 UX report #2 follow-up probe).
  kms: ['cn-south-1', 'cn-north-4', 'cn-east-3', 'ap-southeast-3'],
  smn: ['cn-south-1', 'cn-north-4', 'cn-east-3', 'ap-southeast-3'],
  ces: ['cn-south-1', 'cn-north-4', 'cn-east-3', 'ap-southeast-3'],
  cts: ['cn-south-1', 'cn-north-4', 'cn-east-3', 'ap-southeast-3'],
  apig: ['cn-south-1', 'cn-north-4', 'cn-east-3', 'ap-southeast-3'],
  cbr: ['cn-south-1', 'cn-north-4', 'cn-east-3', 'ap-southeast-3'],
  dds: ['cn-south-1', 'cn-north-4', 'cn-east-3', 'ap-southeast-3'],
  dcs: ['cn-south-1', 'cn-north-4', 'cn-east-3', 'ap-southeast-3'],
} as const satisfies Record<string, readonly string[]>;
