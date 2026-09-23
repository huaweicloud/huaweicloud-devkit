# Expose a DevBox Port via DevBridge

DevBox has no port-expose API of its own (unlike `getHost` in the E2B reference). To publish a sandbox port to a public URL, install the DevBridge CLI inside the sandbox and create a tunnel. This is the same CLI the DevStation sandbox uses; it requires a separate `devbridge_...` API Key.

## Precondition: the sandbox must have internet

DevBridge installs by downloading from GitHub/GitCode. If the sandbox currently has no DNS/egress (an early DevBox test build shipped `nameserver 68.0.0.0`), the install cannot run. Check first:

```bash
cat /etc/resolv.conf          # must show a real resolver, not 68.0.0.0
curl -sS -m 10 -o /dev/null -w "%{http_code}" https://www.baidu.com   # expect 200
```

If DNS is broken, DevBridge exposure is not possible — report a generic error, do not attempt a local install.

## 1. Install DevBridge (0.2.x required)

```bash
export PATH="$HOME/.huawei/bin:$PATH"   # PREPEND — a stale image binary in /usr/local/bin would win otherwise

# Official installer (GitHub can be flaky — retry all errors)
curl -fsSL --http1.1 --retry 3 --max-time 120 \
  https://github.com/huaweicloud/devspace-devbridge/releases/latest/download/install.sh \
  -o /tmp/devbridge-install.sh

# Install from the GitCode mirror (domestic, faster). Repo is spelled "devbrige" (missing 'd') — not a typo.
DB_TARGET=$(grep -m1 'DEFAULT_VERSION=' /tmp/devbridge-install.sh | cut -d'"' -f2)
bash /tmp/devbridge-install.sh -s -u "https://gitcode.com/CloudDeveloperDepartment/devbrige/releases/download/${DB_TARGET}" -v "${DB_TARGET}"

devbridge version   # must print 0.2.x-release
```

## 2. Authenticate with the API Key (0.2.x removed AK/SK login)

The key is a `devbridge_...` account-level credential, created once at `https://devstation.connect.huaweicloud.com/space/devbridge/apikey` (value shown only at creation). Store it in the sandbox at `/tmp/hw_api_key` mode 0600 — never echo it into logs or the conversation.

```bash
devbridge auth login --api-key "$(cat /tmp/hw_api_key)"   # → "Login successful"
devbridge auth status                                       # → "Logged in (Huawei Cloud IAM)"
```

## 3. Host a port

Run the web server and the tunnel in the background, then read the URL from the log:

```bash
# serve the site (example)
cd /srv/site && nohup python3 -m http.server 8080 >/tmp/serve.log 2>&1 </dev/null &

# clear stale tunnels, then host the port
devbridge delete-all
nohup devbridge host -p 8080 -e 8 >/tmp/host.log 2>&1 </dev/null &
sleep 12
cat /tmp/host.log
```

The log contains `Tunnel URL: https://<id>-<port>.devbridge-s2.hwtunnel.com`. Extract it and verify before returning it to the developer.

## Gotchas (learned from real failures)

1. **`pkill -f "devbridge host"` kills itself.** The shell's own command line contains `devbridge host`, so `pkill -f` matches and kills the shell before the later commands run. Run cleanup and start as *separate* `exec` calls, or drop `pkill` entirely and rely on `devbridge delete-all`.
2. **Background with `</dev/null &`.** A plain `nohup ... &` may be torn down when the exec shell exits. Redirect stdin from `/dev/null` so the detached process survives.
3. **Installer needs `-s` (silent).** Without it the installer blocks reading `/dev/tty`.
4. **Never return an unverified URL.** A stale tunnel silently fails (and a migrated gateway can return a placeholder page with HTTP 200). Always `curl` the URL inside the sandbox first, then hand over the link.
5. **Quota**: `10006: quota exceeded` means stale tunnels accumulated past the limit — `devbridge list` then `devbridge delete-all` and retry.

## Teardown

```bash
devbridge delete-all          # drop the tunnel
# then kill the DevBox sandbox itself:
#   huaweicloud_devbox_connect {action:"kill"}
```