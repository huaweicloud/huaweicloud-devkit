# EVS Cloud Disk

## Create Volume

```bash
hcloud EVS CreateVolume --help
# Required: --volume.availability_zone, --volume.size, --volume.volume_type
```

```bash
hcloud EVS CreateVolume \
  --volume.availability_zone=<az> \
  --volume.size=<size> \
  --volume.volume_type=<type> \
  --volume.name=<name>
```

## Attach to ECS

```bash
hcloud ECS AttachServerVolume --server_id=<ecs-id> --volumeAttachment.volumeId=<vol-id>
```

> The attach operation lives under `ECS` (not `EVS`), and the volume id uses the nested `--volumeAttachment.volumeId` parameter.

## List / Delete

```bash
hcloud EVS ListVolumes
hcloud EVS DeleteVolume --volume_id=<id>
```

> Deleting an ECS instance does NOT automatically delete attached EVS volumes unless `--delete_volume=true` is set during instance deletion.
