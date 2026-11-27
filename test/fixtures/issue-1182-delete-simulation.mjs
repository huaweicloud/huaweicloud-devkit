// Simulated records for Issue #1182 — no real cloud resources are touched.
//
// The resolver encodes the DeleteServers semantics documented in
// plugins/huaweicloud-core/skills/huawei-ecs/references/delete-instance.md:
//   - delete_publicip omitted  -> follow the EIP's delete_on_termination
//   - delete_publicip = false  -> always unbind + keep
//   - delete_publicip = true   -> always delete
//   - delete_volume = true     -> delete data disks
//   - delete_volume = false    -> keep only disks with delete_on_termination=false
//   - system disk              -> released with the instance

export function planDeleteRetention(record) {
  const params = record.params ?? {};
  const conflicts = [];
  const unknown = [];

  let eip = null;
  if (record.eip) {
    let state;
    if (params.deletePublicip === true) {
      state = 'deleted';
    } else if (params.deletePublicip === false) {
      state = 'kept';
    } else if (record.eip.deleteOnTermination === true) {
      state = 'deleted';
    } else if (record.eip.deleteOnTermination === false) {
      state = 'kept';
    } else {
      state = 'unknown';
      unknown.push(`eip:${record.eip.id}`);
    }
    eip = { id: record.eip.id, state };
    if (record.eip.intent && state !== 'unknown' && record.eip.intent !== state) {
      conflicts.push(`eip:${record.eip.id}:wanted-${record.eip.intent}-got-${state}`);
    }
  }

  const systemDisk = record.systemDisk ? { id: record.systemDisk.id, state: 'released' } : null;

  const dataDisks = (record.dataDisks ?? []).map((disk) => {
    let state;
    if (params.deleteVolume === true) {
      state = 'deleted';
    } else if (disk.deleteOnTermination === true) {
      state = 'deleted';
    } else if (disk.deleteOnTermination === false) {
      state = 'kept';
    } else {
      state = 'unknown';
      unknown.push(`volume:${disk.id}`);
    }
    if (disk.intent && state !== 'unknown' && disk.intent !== state) {
      conflicts.push(`volume:${disk.id}:wanted-${disk.intent}-got-${state}`);
    }
    return { id: disk.id, state };
  });

  return {
    eip,
    systemDisk,
    dataDisks,
    unknown,
    conflicts,
    requiresConfirmation: unknown.length > 0 || conflicts.length > 0,
  };
}

export function classifyPostDeleteQuery(results) {
  const classify = (result) => {
    if (result?.status === 'absent') return 'deleted';
    if (result?.status === 'present') return 'retained';
    return 'unverified'; // error / timeout / permission / no longer queryable
  };
  return {
    ecs: classify(results.ecs),
    eip: results.eip ? classify(results.eip) : null,
    dataDisks: (results.dataDisks ?? []).map((disk) => ({ id: disk.id, state: classify(disk) })),
  };
}

export const DELETE_SCENARIOS = [
  {
    name: 'EIP omitted + delete_on_termination=true -> deleted',
    record: {
      eip: { id: 'eip-omit-true', deleteOnTermination: true },
      systemDisk: { id: 'vol-sys' },
      dataDisks: [],
      params: {},
    },
    expect: { eip: 'deleted', systemDisk: 'released', dataDisks: [], requiresConfirmation: false },
  },
  {
    name: 'EIP omitted + delete_on_termination=false -> kept',
    record: {
      eip: { id: 'eip-omit-false', deleteOnTermination: false },
      systemDisk: { id: 'vol-sys' },
      dataDisks: [],
      params: {},
    },
    expect: { eip: 'kept', systemDisk: 'released', dataDisks: [], requiresConfirmation: false },
  },
  {
    name: 'EIP explicit false + delete_on_termination=true -> kept',
    record: {
      eip: { id: 'eip-explicit-false', deleteOnTermination: true },
      systemDisk: { id: 'vol-sys' },
      dataDisks: [],
      params: { deletePublicip: false },
    },
    expect: { eip: 'kept', systemDisk: 'released', dataDisks: [], requiresConfirmation: false },
  },
  {
    name: 'EIP policy unknown -> confirmation required',
    record: {
      eip: { id: 'eip-unknown' },
      systemDisk: { id: 'vol-sys' },
      dataDisks: [],
      params: {},
    },
    expect: { eip: 'unknown', systemDisk: 'released', dataDisks: [], requiresConfirmation: true },
  },
  {
    name: 'data disk delete_on_termination=true + delete_volume=false -> still deleted',
    record: {
      eip: { id: 'eip-1', deleteOnTermination: false },
      systemDisk: { id: 'vol-sys' },
      dataDisks: [{ id: 'vol-data-true', deleteOnTermination: true, intent: 'deleted' }],
      params: { deleteVolume: false },
    },
    expect: {
      eip: 'kept',
      systemDisk: 'released',
      dataDisks: [{ id: 'vol-data-true', state: 'deleted' }],
      requiresConfirmation: false,
    },
  },
  {
    name: 'data disk delete_on_termination=true + intent keep -> conflict',
    record: {
      eip: { id: 'eip-1', deleteOnTermination: false },
      systemDisk: { id: 'vol-sys' },
      dataDisks: [{ id: 'vol-data-true', deleteOnTermination: true, intent: 'kept' }],
      params: { deleteVolume: false },
    },
    expect: {
      eip: 'kept',
      systemDisk: 'released',
      dataDisks: [{ id: 'vol-data-true', state: 'deleted' }],
      requiresConfirmation: true,
      conflicts: ['volume:vol-data-true:wanted-kept-got-deleted'],
    },
  },
  {
    name: 'data disk delete_on_termination=false + delete_volume=false -> kept',
    record: {
      eip: { id: 'eip-1', deleteOnTermination: false },
      systemDisk: { id: 'vol-sys' },
      dataDisks: [{ id: 'vol-data-false', deleteOnTermination: false, intent: 'kept' }],
      params: { deleteVolume: false },
    },
    expect: {
      eip: 'kept',
      systemDisk: 'released',
      dataDisks: [{ id: 'vol-data-false', state: 'kept' }],
      requiresConfirmation: false,
    },
  },
  {
    name: 'data disk policy unknown -> confirmation required',
    record: {
      eip: { id: 'eip-1', deleteOnTermination: false },
      systemDisk: { id: 'vol-sys' },
      dataDisks: [{ id: 'vol-data-unknown' }],
      params: { deleteVolume: false },
    },
    expect: {
      eip: 'kept',
      systemDisk: 'released',
      dataDisks: [{ id: 'vol-data-unknown', state: 'unknown' }],
      requiresConfirmation: true,
    },
  },
];

export const POST_DELETE_SCENARIOS = [
  {
    name: 'all resources absent -> deleted',
    results: {
      ecs: { status: 'absent' },
      eip: { status: 'absent' },
      dataDisks: [
        { id: 'vol-sys', status: 'absent' },
        { id: 'vol-data', status: 'absent' },
      ],
    },
    expect: {
      ecs: 'deleted',
      eip: 'deleted',
      dataDisks: [
        { id: 'vol-sys', state: 'deleted' },
        { id: 'vol-data', state: 'deleted' },
      ],
    },
  },
  {
    name: 'ECS query error -> unverified, never deleted',
    results: { ecs: { status: 'error' }, eip: { status: 'error' }, dataDisks: [] },
    expect: { ecs: 'unverified', eip: 'unverified', dataDisks: [] },
  },
  {
    name: 'EIP / volume query failure -> unverified while ECS is deleted',
    results: {
      ecs: { status: 'absent' },
      eip: { status: 'timeout' },
      dataDisks: [{ id: 'vol-data', status: 'forbidden' }],
    },
    expect: {
      ecs: 'deleted',
      eip: 'unverified',
      dataDisks: [{ id: 'vol-data', state: 'unverified' }],
    },
  },
  {
    name: 'still listed -> retained (may keep billing)',
    results: {
      ecs: { status: 'absent' },
      eip: { status: 'present' },
      dataDisks: [{ id: 'vol-data', status: 'present' }],
    },
    expect: {
      ecs: 'deleted',
      eip: 'retained',
      dataDisks: [{ id: 'vol-data', state: 'retained' }],
    },
  },
];
