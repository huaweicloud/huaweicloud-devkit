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
cat > /etc/yum.repos.d/pgdg16.repo << 'PGDG_EOF'
[pgdg16]
name=PostgreSQL 16 for RHEL8 aarch64
baseurl=https://download.postgresql.org/pub/repos/yum/16/redhat/rhel-8-aarch64/
enabled=1
gpgcheck=0
PGDG_EOF
```

The PGDG el8 RPMs need RHEL-8-era libraries HCE does not have. el9 RPMs fail
differently (they want `libldap-2.5.so.0`). Install the el8 RPMs with
`--nodeps` and shim the sonames:

```bash
BASE="https://download.postgresql.org/pub/repos/yum/16/redhat/rhel-8-aarch64"
# Download with resume (--max-time + -C -): GitHub/pgdn downloads from the CN
# region stall; a partial RPM fails rpm verification and ABORTS the whole transaction,
# silently skipping the other RPMs in the same rpm -ivh call. Install one RPM per call.
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
# Install the REAL el8 libicu60 (different sonames, coexists with HCE's icu69):
curl -fsSL --http1.1 --max-time 240 -C - \
  "https://repo.almalinux.org/almalinux/8/BaseOS/aarch64/os/Packages/libicu-60.3-2.el8_1.aarch64.rpm" -o /tmp/libicu60.rpm
rpm -ivh --nodeps --force /tmp/libicu60.rpm   # --force: license file conflicts with icu69

# LDAP: postgres only uses it for LDAP auth (not needed here) — symlinks suffice.
ln -sf /usr/lib64/libldap.so.2.0.200 /usr/lib64/libldap-2.4.so.2
ln -sf /usr/lib64/libldap.so.2.0.200 /usr/lib64/libldap_r-2.4.so.2   # initdb needs the _r soname
ln -sf /usr/lib64/liblber.so.2.0.200  /usr/lib64/liblber-2.4.so.2

# readline: psql links libreadline.so.7 (el8); HCE has .8 — API-compatible, symlink fine.
ln -sf /usr/lib64/libreadline.so.8 /usr/lib64/libreadline.so.7

ldconfig   # registers /usr/pgsql-16/lib (libpq.so.5)
```

Init and start (PG refuses root; no systemd on HCE):

```bash
mkdir -p /var/lib/pgsql/16/data && chown postgres:postgres /var/lib/pgsql/16/data
su - postgres -c "/usr/pgsql-16/bin/initdb -D /var/lib/pgsql/16/data"
su - postgres -c "/usr/pgsql-16/bin/pg_ctl -D /var/lib/pgsql/16/data -l /var/lib/pgsql/16/logfile start"
```

## Step 2: PostgREST (static build) + schema

PostgREST 16.4 `linux-static-aarch64` runs on HCE out of the box (musl
static). **Dynamic Ubuntu builds do NOT work** — HCE glibc 2.34 is older than
Ubuntu 22.04's 2.35 and the binaries fail on load.

```bash
# https://github.com/PostgREST/postgrest/releases → postgrest-v16.4.0-linux-static-aarch64.tar.xz
mkdir -p /opt/postgrest && tar -xJf postgrest-*.tar.xz -C /opt/postgrest

cat > /opt/postgrest/pgrst.conf << 'PGRST_EOF'
db-uri = "postgres://api_user:<db-password>@localhost:5432/postgres"
db-schemas = "api"
db-anon-role = "api_user"
server-host = "127.0.0.1"
server-port = 3000
PGRST_EOF

# Schema + read-only API role (the anon role gates all writes)
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
(data, 200), `POST /api/todos` (401 — the anon role has SELECT only; if a write
API is wanted, grant INSERT/UPDATE on the specific table, never to anon broadly).
