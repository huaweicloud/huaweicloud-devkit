# Full-Stack on the Sandbox: PostgreSQL 16 + PostgREST + Nginx

A REST API over a real database, fully inside the sandbox: PostgREST generates
a RESTful API from the PostgreSQL schema; nginx serves a frontend and
reverse-proxies `/api` to PostgREST on a single origin (no CORS needed).
All values below are **measured** on HCE 2.0 (aarch64, no systemd, dnf) in the
2026-10 test. Nginx templates: see `nginx-templates.md`. Tunnel exposure:
see `tunnel-persistence.md`.

## Architecture

```
browser → tunnel URL → nginx :8080
                        ├─ /       → static frontend (index.html)
                        └─ /api/   → proxy_pass http://127.0.0.1:3000 (PostgREST)
                                       └─ PostgreSQL 16 :5432 → schema api
```

## Step 1: PostgreSQL 16 on HCE 2.0 (the hard part)

The OS repo only ships PostgreSQL 13, but PostgREST 16.x **requires PG ≥ 14**
(it refuses with "Cannot run in this PostgreSQL version, PostgREST needs at
least 14.0"). PGDG is the source for PG 16 — but HCE is NOT el8-lib-compatible:

```bash
# PGDG repo RPM fails on HCE ("nothing provides /etc/redhat-release") — write the repo file by hand.
# The el8 path is rhel-8-aarch64 WITH A HYPHEN: rhel8-aarch64 (no hyphen) 404s.
# Use the Aliyun mirror: download.postgresql.org / repo.almalinux.org measure ~8KB/s from
# sandbox CN egress (a 6.8MB server RPM times out inside 240s); the mirror returns in seconds.
cat > /etc/yum.repos.d/pgdg16.repo << 'PGDG_EOF'
[pgdg16]
name=PostgreSQL 16 for RHEL8 aarch64 (Aliyun mirror)
baseurl=https://mirrors.aliyun.com/postgresql/repos/yum/16/redhat/rhel-8-aarch64/
enabled=1
gpgcheck=0
PGDG_EOF
```

The PGDG el8 RPMs need RHEL-8-era libraries HCE does not have. el9 RPMs fail
differently (they want `libldap-2.5.so.0`). Install the el8 RPMs with
`--nodeps` and shim the sonames:

```bash
# Aliyun mirror (measured 2026-10: seconds per RPM vs ~8KB/s timeouts on the official source).
# Download with resume (--max-time + -C -) WITHIN THE SAME MIRROR only: a partial file
# resumed from a DIFFERENT mirror fails rpm verification ("Payload SHA256 digest: BAD") —
# when switching sources, rm the partial file and re-download in full (see field notes).
# A corrupt RPM also ABORTS the whole transaction, silently skipping the other RPMs in the
# same rpm -ivh call. Install one RPM per call.
BASE="https://mirrors.aliyun.com/postgresql/repos/yum/16/redhat/rhel-8-aarch64"
curl -fsSL --http1.1 --max-time 240 -C - "$BASE/postgresql16-libs-16.15-1PGDG.rhel8.10.aarch64.rpm" -o /tmp/pg16-libs.rpm
rpm -ivh --nodeps /tmp/pg16-libs.rpm
curl -fsSL --http1.1 --max-time 240 -C - "$BASE/postgresql16-16.15-1PGDG.rhel8.10.aarch64.rpm" -o /tmp/pg16.rpm
rpm -ivh --nodeps /tmp/pg16.rpm
curl -fsSL --http1.1 --max-time 240 -C - "$BASE/postgresql16-server-16.15-1PGDG.rhel8.10.aarch64.rpm" -o /tmp/pg16-server.rpm
rpm -ivh --nodeps /tmp/pg16-server.rpm
```

Soname shims (measured 2026-10):

```bash
# ICU: versioned symbols (u_strToLower_60) make symlinks IMPOSSIBLE — a
# libicu.so.60 -> .69 symlink loads but crashes with "undefined symbol".
# Install the REAL el8 libicu60 (different sonames, coexists with HCE's icu69);
# AlmaLinux official repo is also ~8KB/s from the sandbox — use the Aliyun mirror:
curl -fsSL --http1.1 --max-time 240 -C - \
  "https://mirrors.aliyun.com/almalinux/8/BaseOS/aarch64/os/Packages/libicu-60.3-2.el8_1.aarch64.rpm" -o /tmp/libicu60.rpm
rpm -ivh --nodeps --force /tmp/libicu60.rpm   # --force: license file conflicts with icu69

# LDAP: postgres only uses it for LDAP auth (not needed here) — symlinks suffice.
ln -sf /usr/lib64/libldap.so.2.0.200 /usr/lib64/libldap-2.4.so.2
ln -sf /usr/lib64/libldap.so.2.0.200 /usr/lib64/libldap_r-2.4.so.2   # initdb needs the _r soname
ln -sf /usr/lib64/liblber.so.2.0.200  /usr/lib64/liblber-2.4.so.2

# readline: psql links libreadline.so.7 (el8); HCE has .8 — API-compatible, symlink fine.
ln -sf /usr/lib64/libreadline.so.8 /usr/lib64/libreadline.so.7

ldconfig   # registers /usr/pgsql-16/lib (libpq.so.5)
```

Init and start (PG refuses root; no systemd on HCE). **The data directory
MUST live on the data disk** (`/workspace`), not `/var/lib/pgsql` —
`/var/lib/pgsql` is on the 系统盘 (system disk) and a sandbox reboot rolls it
back to the image state, destroying all databases. `/workspace` is the data
disk and survives reboots (#999):

```bash
mkdir -p /workspace/pgsql/16/data && chown postgres:postgres /workspace/pgsql/16/data
su - postgres -c "/usr/pgsql-16/bin/initdb -D /workspace/pgsql/16/data"
su - postgres -c "/usr/pgsql-16/bin/pg_ctl -D /workspace/pgsql/16/data -l /workspace/pgsql/16/logfile start"
```

## Step 2: PostgREST (static build) + schema

PostgREST 16.4 `linux-static-aarch64` runs on HCE out of the box (musl
static). **Dynamic Ubuntu builds do NOT work** — HCE glibc 2.34 is older than
Ubuntu 22.04's 2.35 and the binaries fail on load.

```bash
# Asset name has NO patch version: it is postgrest-v16.5-linux-static-aarch64.tar.xz
# (v16.4 likewise) — writing "v16.5.0" 404s and is easily misdiagnosed as a broken proxy.
# Verify the real asset name via the GitHub API before downloading:
curl -fsSL https://api.github.com/repos/PostgREST/postgrest/releases \
  | grep -o '"name": *"postgrest-v16[^"]*aarch64[^"]*"'
# GitHub direct is slow from the sandbox; prefix proxies measure ~500KB/s (2026-10):
#   https://ghfast.top/https://github.com/...   or   https://gh-proxy.com/https://github.com/...
# ⚠️ Those proxies are THIRD-PARTY: never extract their bytes unverified (supply-chain
# risk). Pull the official asset sha256 digest from the GitHub releases API, download
# through the proxy, and verify with sha256sum BEFORE extracting — this also catches
# partial downloads (a truncated tar.xz fails the check instead of a cryptic tar error).
PGRST_SHA256="$(curl -fsSL https://api.github.com/repos/PostgREST/postgrest/releases/tags/v16.5 \
  | grep -A30 '"name": *"postgrest-v16.5-linux-static-aarch64.tar.xz"' \
  | grep -o '"digest": *"sha256:[a-f0-9]*"' | head -1 \
  | sed 's/.*sha256://; s/"$//')"
# ⚠️ The sed strips both the `sha256:` prefix and the closing quote.
# Using `cut` by delimiter instead would leave a trailing double-quote on the
# hash, making `sha256sum -c -` fail with "no properly formatted checksum
# lines found" even when the download is correct.
test -n "$PGRST_SHA256"   # empty digest = API lookup failed; do NOT proceed unverified
curl -fsSL --http1.1 --max-time 240 -C - -o /tmp/pgrst.tar.xz \
  "https://ghfast.top/https://github.com/PostgREST/postgrest/releases/download/v16.5/postgrest-v16.5-linux-static-aarch64.tar.xz"
echo "$PGRST_SHA256  /tmp/pgrst.tar.xz" | sha256sum -c -   # must print ": OK" before tar
mkdir -p /opt/postgrest && tar -xJf /tmp/pgrst.tar.xz -C /opt/postgrest

cat > /opt/postgrest/pgrst.conf << 'PGRST_EOF'
db-uri = "postgres://api_user:<db-password>@localhost:5432/postgres"
db-schemas = "api"
db-anon-role = "api_user"
server-host = "127.0.0.1"
server-port = 3000
PGRST_EOF
# ⚠️ Via the MCP exec channel, do NOT build pgrst.conf / SQL inline (escaping breaks
# them — see field notes below): write the file locally and huaweicloud_sandbox_upload_file it.

# Schema + read-only API role (the anon role gates all writes).
# Same escaping trap: prefer a local schema.sql → upload_file → psql -f (field notes).
su - postgres -c "/usr/pgsql-16/bin/psql -c \"CREATE SCHEMA api; CREATE TABLE api.todos (id serial primary key, done boolean not null default false, task text not null); CREATE ROLE api_user LOGIN PASSWORD '<db-password>'; GRANT USAGE ON SCHEMA api TO api_user; GRANT SELECT ON ALL TABLES IN SCHEMA api TO api_user;\""

setsid nohup /opt/postgrest/postgrest /opt/postgrest/pgrst.conf > /tmp/pgrst.log 2>&1 < /dev/null &
disown
curl -s http://127.0.0.1:3000/todos          # [{"id":1,...}]
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/   # OpenAPI root, 200
```

PostgREST allows all CORS origins by default (`Access-Control-Allow-Origin: *`).

## Step 3: Nginx single-origin (frontend + /api)

```bash
cat > /etc/nginx/conf.d/app.conf << 'NGINX_EOF'
server {
    listen <port>;
    root /var/www/<app>;
    index index.html;
    location /api/ {
        proxy_pass http://127.0.0.1:3000/;   # trailing slashes strip the /api prefix
        proxy_set_header Host $host;
    }
}
NGINX_EOF
nginx -t && nginx -s reload 2>/dev/null || nginx
```

TRAP (measured 2026-10): nginx runs as the `nginx` user but the frontend dir is
root-owned — `/` returns **403** until the traverse bit is set on the whole
path chain: `chmod o+x /var/www /var/www/<app>` (and `o+r` on the files).
This mirrors the deploy_nginx project-path permission fix.

Frontend pages fetch backend data same-origin: `fetch('/api/todos?order=id.asc')`
— no CORS, no absolute URLs, no CDN dependencies (keep pages self-contained;
CN-region CDNs stall sandbox egress).

## Step 4: Expose + keep alive

```bash
# Port on the tunnel must be the ACTUAL nginx port
devbridge host -p <port> -e 720
# Then install the watchdog (renewal + host re-attach + health check)
# → huaweicloud_sandbox_keepalive_watchdog / references/tunnel-persistence.md
```

Verify end-to-end through the public URL: `GET /` (page, 200), `GET /api/todos`
(data, 200), `POST /api/todos` (**401 by default** — the anon role has SELECT
only). To enable writes on one table, `GRANT INSERT ON api.todos TO api_user`
(never a broad grant to anon); after that targeted grant the same POST returns
**201**.

## Field notes (2026-10 retest): 5 measured traps

Re-measured 2026-10-23 on HCE 2.0 (aarch64, no systemd) with PG 16.15 +
PostgREST 16.5; all five traps reproduced and solved, end-to-end verified
(page 200 / API 200 / POST 401 anon-default, 201 after `GRANT INSERT` on
`api.todos`).

### 1. RPM sources: use the Aliyun mirror

`download.postgresql.org` and `repo.almalinux.org` measure **~8KB/s** from the
sandbox CN egress (the 6.8MB server RPM times out mid-transfer at 240s). The
Aliyun mirror completes in seconds:

- PG 16: `https://mirrors.aliyun.com/postgresql/repos/yum/16/redhat/rhel-8-aarch64/`
- libicu60: `https://mirrors.aliyun.com/almalinux/8/BaseOS/aarch64/os/Packages/`
- PostgREST: `ghfast.top` / `gh-proxy.com` prefix proxies (~500KB/s) — but see
  trap 3 first: the asset name must be exact, and the proxy is third-party:
  fetch the official GitHub asset digest and `sha256sum -c` the tarball before
  extracting (see the Step 2 download block).

### 2. Cross-mirror resume corrupts RPMs

Resuming a partial download with `-C -` **from a different mirror** produces a
file that fails rpm verification (`Payload SHA256 digest: BAD`). When switching
sources, `rm` the partial file and re-download it in full — never resume across
mirrors.

### 3. PostgREST 404 is usually the asset name, not the proxy

The release asset is `postgrest-v16.5-linux-static-aarch64.tar.xz` — the version
has **no patch number** (v16.4 likewise); guessing `v16.5.0` returns 404 and
gets misdiagnosed as "proxy broken". Check the real name first:

```bash
curl -fsSL https://api.github.com/repos/PostgREST/postgrest/releases \
  | grep -o '"name": *"postgrest-v16[^"]*aarch64[^"]*"'
```

### 4. `upload_file` lands as 640 → silent schema failure → PGRST002

Files uploaded by root via `huaweicloud_sandbox_upload_file` arrive as
`rw-r-----` (640). `su - postgres -c "psql -f /tmp/schema.sql"` then fails with
`Permission denied`, the schema/role are **silently not created**, and
PostgREST starts but keeps logging
`PGRST002: Could not query the database for the schema cache`.

Fix: `chmod o+r` the uploaded file before `psql -f`. When troubleshooting
PGRST002, first confirm the schema/role actually exist (`\dn`, `\du`) — the
`psql -f` error may have scrolled out of the output tail you looked at.

### 5. MCP exec channel mangles nested quotes — upload files instead

Nested quotes / inline JSON (pgrst.conf, `psql -c` SQL, `curl -d '{...}'`) get
corrupted by the exec channel's multi-layer escaping (symptoms: POST 400, SQL
written wrong). The heredoc/inline `printf` snippets above are for a direct
shell; over MCP, always use the file-upload pattern:

```bash
# locally: write schema.sql / pgrst.conf / payload.json, then upload_file them, then on the sandbox:
chmod o+r /tmp/schema.sql && su - postgres -c "/usr/pgsql-16/bin/psql -f /tmp/schema.sql"
curl -s -X POST -H "Content-Type: application/json" -d @/tmp/payload.json http://127.0.0.1:3000/todos
```

## Sandbox Restart Recovery Checklist (2026-10)

A sandbox reboot rolls the **系统盘 (system disk)** back to the image state —
everything installed under `/`, `/usr`, `/etc`, `$HOME` is lost. Only
`/workspace` (the data disk) survives. Below is the measured recovery
checklist, assuming PG data was initialized on `/workspace/pgsql/16/data` per
Step 1 above.

### Lost on reboot (系统盘 — must rebuild)

| Component              | Location                  | Recovery action                                                                  |
| ---------------------- | ------------------------- | -------------------------------------------------------------------------------- |
| PostgreSQL 16 RPMs     | `/usr/pgsql-16/`          | Re-run the Step 1 `rpm -ivh --nodeps` block                                      |
| Soname shims           | `/usr/lib64/lib*.so.*`    | Re-run the Step 1 symlink + `ldconfig` block                                     |
| `postgres` user        | `/etc/passwd` entry       | `useradd -r -m postgres` then `chown postgres:postgres /workspace/pgsql/16/data` |
| PostgREST binary       | `/opt/postgrest/`         | Re-download + sha256-verify + extract (Step 2)                                   |
| pgrst.conf             | `/opt/postgrest/`         | Re-upload via `huaweicloud_sandbox_upload_file`                                  |
| nginx config           | `/etc/nginx/conf.d/`      | Re-create via `huaweicloud_sandbox_deploy_nginx`                                 |
| DevBridge 0.2.x binary | `~/.huawei/bin/` (系统盘) | Re-install to `/workspace/.local/bin` (see #999)                                 |
| DevBridge tunnel       | in-memory                 | Re-run `huaweicloud_sandbox_expose_tunnel`                                       |
| `/tmp` credentials     | `/tmp/hw_creds.sh` etc.   | Re-run `huaweicloud_sandbox_credentials`                                         |

### Survives reboot (/workspace — no rebuild needed)

| Component              | Location                   | Notes                                        |
| ---------------------- | -------------------------- | -------------------------------------------- |
| Frontend pages         | `/workspace/<repo>/`       | Uploaded project persists                    |
| PG data directory      | `/workspace/pgsql/16/data` | Schema, roles, tables, seed data ALL survive |
| DevBridge 0.2.x binary | `/workspace/.local/bin/`   | If installed per #999 guidance               |

Because PG data lives on `/workspace`, a restart does **NOT** require rebuilding
the schema (`schema.sql`) or re-seeding data — `initdb` is also unnecessary.
Only the PG server RPMs and the `postgres` user need rebuilding; then
`pg_ctl -D /workspace/pgsql/16/data start` resumes the surviving cluster
immediately.

### Write-permission GRANT rollback trap (POST 401 → GRANT → 201)

The `postgres` system user and PG RPMs live on the 系统盘, so after a reboot
you must recreate the user and re-install PG before `pg_ctl` can start the
surviving data directory. Once PG starts against the surviving
`/workspace/pgsql/16/data`, all roles and grants in the PG catalog are intact
— no re-grant is needed.

**However**, if you rebuild the schema from a `schema.sql` that only contains
`GRANT SELECT` (the read-only anon default), writes are blocked: `POST
/api/todos` returns **401**. The write grant (`GRANT INSERT, UPDATE, DELETE`)
was stored in the PG catalog; re-running a SELECT-only script overwrites it.
The measured fix (2026-10):

```sql
GRANT INSERT, UPDATE, DELETE ON api.todos TO api_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA api TO api_user;
```

After this targeted re-grant the same `POST /api/todos` returns **201**
(measured 2026-10: POST 401 → `GRANT INSERT, UPDATE, DELETE` → POST 201).
This mirrors the Step 4 anon-role gating: `db-anon-role` is read-only by
default; targeted write grants must be re-applied after any schema rebuild.
Never grant broad write access to the anon role.
