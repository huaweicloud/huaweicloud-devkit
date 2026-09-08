# CSMS Usage Guide

## Create Secret

hcloud CSMS CreateSecret --name=prod-db-password --secret_string='{"password":"CHANGE_ME"}'

## List Secrets (metadata only)

hcloud CSMS ListSecrets

## Describe Secret

hcloud CSMS ShowSecret --secret_name=prod-db-password

## List Versions

hcloud CSMS ListSecretVersions --secret_name=prod-db-password

## Runtime Injection (Terraform)

data "huaweicloud_csms_secret" "db" {
secret_name = "prod-db-password"
}
Use: data.huaweicloud_csms_secret.db.secret_string

## Rotation

- Enable auto-rotation: `hcloud CSMS UpdateSecret --secret_name=<name> --auto_rotation=true --rotation_period=<days> --rotation_func_urn=<fn>` (or set at CreateSecret time)
- Trigger rotation now: `hcloud CSMS RotateSecret --secret_name=<name>`
- Rotation function ARN: provide a FunctionGraph rotation function to generate new secret values

## Policy Rules

- hcloud CSMS DownloadSecretBlob -> BLOCKED (use runtime injection)
- hcloud CSMS ShowSecretVersion -> BLOCKED
- hcloud CSMS ListSecrets -> ALLOWED (metadata only)
- hcloud CSMS ShowSecret -> ALLOWED (metadata only)
