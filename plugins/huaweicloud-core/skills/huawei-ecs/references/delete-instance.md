# Delete an ECS Instance: EIP and Volume Retention

`hcloud ECS DeleteServers` is asynchronous, and its two optional delete flags do **not** mean "false by default, so everything is kept". The retention result depends on the flag value **and** on each attached resource's `delete_on_termination` policy.

Official semantics:

- [DeleteServers API](https://support.huaweicloud.com/api-ecs/ecs_02_0103.html)
- [ECS delete / reboot FAQ](https://support.huaweicloud.com/ecs_faq/ecs_faq_0412.html) (system disk, delete methods)
- [ECS recycle bin](https://support.huaweicloud.com/usermanual-ecs/ecs_07_0101.html)
- [Billing usage time](https://support.huaweicloud.com/billing_faq/billing_faq_5100018.html)

## 1. Flag semantics

### EIP: `delete_publicip`

| Command form              | Result                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------- |
| omit the flag             | Follows the EIP's binding-time `delete_on_termination`: `true` → delete, `false` → keep |
| `--delete_publicip=false` | Always unbind and **keep** the EIP (even when `delete_on_termination=true`)             |
| `--delete_publicip=true`  | Always **delete** the EIP (even when `delete_on_termination=false`)                     |

Omitting the flag is **not** the same as passing `false`: omission follows the binding policy; `false` always keeps the EIP. An unbound EIP still bills until it is released.

### Data disk: `delete_volume`

`delete_volume` applies to **data disks only**. It is OR-ed with each disk's own `delete_on_termination`:

| Disk `delete_on_termination` | `delete_volume` | Result             |
| ---------------------------- | --------------- | ------------------ |
| `true`                       | `false`         | **Still deleted**  |
| `true`                       | `true`          | Deleted            |
| `false`                      | `true`          | Deleted            |
| `false`                      | `false`         | Unmounted and kept |
| `false`                      | omitted         | Unmounted and kept |

Key trap: passing `--delete_volume=false` **cannot** preserve a data disk whose `delete_on_termination=true`. To keep such a disk, detach it first (or change its policy) before deleting the instance. Never promise retention based on the flag alone.

With mixed data-disk policies, `delete_volume=true` deletes every data disk; `false` / omitted still deletes the disks marked `delete_on_termination=true`. Detach the disks that must be kept, then re-check the plan.

### System disk

- Immediate delete: the system disk is released with the instance by default. `delete_volume` does not apply to it.
- Recycle bin rules may change recoverability; check the recycle-bin policy before deletion when the user expects to restore it.

## 2. Before approval: list the expected fate by resource ID

Never submit a blanket command. Build an explicit plan first:

```bash
# 1. Instance details, attached volume IDs, and each attachment's delete_on_termination
hcloud ECS ListServersDetails --cli-region=<region> --server_id=<instance-id>

# 2. EIP bound to the instance (filter client-side by associate_instance_id / port ID)
hcloud EIP ListPublicips --cli-region=<region> --limit=<n>

# 3. Volumes still associated with the instance (query by recorded volume IDs if needed)
hcloud EVS ListVolumes --cli-region=<region> --server_id=<instance-id>
```

`ListPublicips` and `ListVolumes` are paginated; a short page is not proof that a resource is absent. Use the `id` / `ids` filter or paginate before concluding.

Show the user a table like this and get explicit approval:

| Resource    | ID      | `delete_on_termination` | Flag to pass | Expected after delete             |
| ----------- | ------- | ----------------------- | ------------ | --------------------------------- |
| EIP         | eip-... | `true`                  | omit         | deleted                           |
| EIP         | eip-... | `false`                 | omit / false | unbound, kept, may keep billing   |
| System disk | vol-... | n/a                     | n/a          | released with the instance        |
| Data disk   | vol-... | `true`                  | any          | deleted                           |
| Data disk   | vol-... | `false`                 | false / omit | unmounted, kept, may keep billing |

If a policy is **unknown** (the API does not return it, permission is missing, or the resource cannot be queried) or the computed fate **conflicts with user intent**:

1. Resolve it first — query the resource, change the policy, detach the disk, or get explicit user consent for the alternative.
2. Record the decision in the plan.
3. Only then submit the delete.

Typical conflicts: the user wants to keep a data disk with `delete_on_termination=true` (detach first); the user wants to keep an EIP that is marked for deletion (pass `--delete_publicip=false`); the user wants an EIP deleted but its policy says keep (pass `true`).

## 3. Command forms (choose from the approved plan)

Keep the EIP and data disks (unbind / unmount):

```bash
hcloud ECS DeleteServers --servers.1.id=<instance-id> --delete_publicip=false --delete_volume=false
```

Delete the EIP and data disks:

```bash
hcloud ECS DeleteServers --servers.1.id=<instance-id> --delete_publicip=true --delete_volume=true
```

Follow the binding policies for both (only when that is what the plan says):

```bash
hcloud ECS DeleteServers --servers.1.id=<instance-id>
```

Do not append `--delete_publicip=true --delete_volume=true` by reflex. It deletes the EIP and every data disk that is not already protected, which is exactly the wrong outcome when the user wants to keep any of them.

## 4. After the job: verify each resource by ID

Wait for the delete job to finish (the API returns a `job_id`):

```bash
hcloud ECS ShowJob --cli-region=<region> --job_id=<job-id>
```

Then check every resource independently:

```bash
hcloud ECS ListServersDetails --cli-region=<region> --server_id=<instance-id>
hcloud EIP ListPublicips --cli-region=<region> --limit=<n>
hcloud EVS ListVolumes --cli-region=<region> --id=<volume-id>
```

Classification:

- Resource absent, or an explicit 404 / not-found for that ID → **deleted**.
- Resource still present → **retained** (unbound / unmounted); it may still bill.
- Query failed (timeout, permission, 5xx) or the instance is no longer queryable → **unverified**, never "deleted". Retry, use another read path, or check the console, and report the uncertainty.

After instance deletion the `--server_id` volume filter may no longer resolve; query the recorded volume IDs explicitly instead of treating the empty result as proof.

## 5. Residual charges

Check the billing **usage time** (`计费使用时间`) for each resource ID. An invoice issue date or the absence of a new invoice line is not evidence that billing stopped — billing periods and invoice dates can lag the actual release time. Check EIP and EVS bills separately, per resource ID.

## 6. Wrong assumptions seen in the wild

- "Both flags default to false, so the EIP and system disk survive." — Wrong: the system disk is released with the instance; an omitted EIP flag follows `delete_on_termination`.
- "Data disks are deleted by default, unlike the system disk." — Wrong framing: data-disk fate depends on its own `delete_on_termination`; `--delete_volume=false` does not save a disk marked `true`.
- "The instance list no longer shows it, so everything is deleted." — Wrong: check the EIP and each volume by ID.
- "The query failed, so it must be gone." — Wrong: record it as unverified.
- "No invoice this month, so billing stopped." — Wrong: compare billing usage time.
