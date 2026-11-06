# Tunnel Persistence: Renewal, Re-attach, and the Keepalive Watchdog

DevBridge tunnel URLs are bound to the tunnel ID, not to the host process. The
URL `https://<tunnel-id>-<port>.devbridge-s2.hwtunnel.com` keeps working as long
as (a) the tunnel has lifetime left and (b) a `devbridge host` process is
attached. Persistence is therefore about **preventing expiry, not recovering
URLs** — a tunnel whose record is lost cannot be recovered with the same URL.

All values below are **measured** (2026-10 tunnel-persistence test), not
inferred. Plugin automation: `huaweicloud_sandbox_renew_tunnel` and
`huaweicloud_sandbox_keepalive_watchdog`.

## Rolling-window expiry (measured)

The `-e <hours>` expiry is a **rolling window**: renewal sets
`expiration = now + hours` regardless of remaining time.

```bash
# 14:15Z: create with a 1-hour window
devbridge host -p 8080 -e 1          # Tunnel URL: https://nv2dvv6w-8080...
# 14:25Z: renew 10 minutes later
devbridge update nv2dvv6w -e 1
# expiration = 15:25Z = renewal time + 1h (NOT original expiry + 1h)
```

Consequences:

- Renewing **before** expiry keeps the same URL alive indefinitely — the
  "permanent link" pattern is daily renewal, never URL recovery.
- `-e` accepts **1..720** hours (720 = 30 days, exact `+2592001s`). Larger
  values are rejected.

## Reading the absolute expiration

Non-verbose `show` prints a relative value only; `-v` surfaces the Unix
timestamp:

```bash
devbridge show nv2dvv6w -v | grep -oE 'tunnelExpiration[^0-9]+[0-9]+'
# tunnelExpiration":1795022391  (UTC seconds; ~30 days after a 720h renew)
```

## Host re-attach: same tunnel, same URL

If the host process dies (sandbox restart, session teardown), re-attach with the
tunnel ID — the URL does **not** change:

```bash
devbridge host <tunnel-id>
```

Always launch in the session-detached form so the host survives the exec
session: `setsid nohup devbridge host <id> ... < /dev/null &` + `disown`
(see the expose flow for why all three matter).

## Three-layer keepalive watchdog (the proven pattern)

Layer 1 keeps the host process alive, layer 2 keeps the lifetime topped up
daily (29 days of tolerance if renewal ever stops firing), layer 3 detects a
dead URL within 5 minutes. Install via
`huaweicloud_sandbox_keepalive_watchdog`, or by hand:

```bash
cat > /tmp/tunnel-keepalive.sh << 'KEEPALIVE_EOF'
#!/bin/bash
# /workspace/.local/bin FIRST — it survives sandbox reboots; ~/.huawei/bin is
# on the system disk and is wiped back to the image state on reboot (#999).
export PATH="/workspace/.local/bin:$HOME/.huawei/bin:$PATH"
# entries: tunnelId:url — URLs HARDCODED, never derived from port list (see trap 2)
TUNNELS="<tunnel-id>:https://<tunnel-id>-<port>.devbridge-s2.hwtunnel.com"
declare -A LAST_RENEW
while true; do
  NOW=$(date -u +%s); TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  for entry in $TUNNELS; do
    ID="${entry%%:*}"; URL="${entry#*:}"
    # Layer 1: host watchdog — re-attach keeps the URL (bound to tunnel ID)
    if ! pgrep -f "devbridge host $ID" > /dev/null 2>&1; then
      setsid nohup devbridge host "$ID" > "/tmp/host-$ID.log" 2>&1 < /dev/null &
      echo "$TS host $ID restarted" >> /tmp/tunnel-keepalive.log; sleep 8
    fi
    # Layer 2: daily renewal (86400s) — rolling window keeps the URL alive
    if [ $((${LAST_RENEW[$ID]:-0})) -eq 0 ] || [ $((NOW - ${LAST_RENEW[$ID]})) -ge 86400 ]; then
      devbridge update "$ID" -e 720 >> /tmp/tunnel-keepalive.log 2>&1 \
        && echo "$TS renew $ID ok (720h)" >> /tmp/tunnel-keepalive.log \
        || echo "$TS renew $ID FAILED" >> /tmp/tunnel-keepalive.log
      LAST_RENEW[$ID]=$NOW
    fi
    # Layer 3: health check every 5 min (loop sleep), log on non-200/304
    HC=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$URL/" 2>/dev/null || echo "000")
    [ "$HC" != "200" ] && [ "$HC" != "304" ] \
      && echo "$TS health $ID WARN http=$HC" >> /tmp/tunnel-keepalive.log
  done
  sleep 300
done
KEEPALIVE_EOF
chmod +x /tmp/tunnel-keepalive.sh
setsid nohup /tmp/tunnel-keepalive.sh > /dev/null 2>&1 < /dev/null &
disown
```

The pgrep pattern MUST be tunnel-specific (`devbridge host $ID`) — a bare
`pgrep -f "devbridge host"` matches _any_ tunnel's host and silently skips
re-attaching the dead one (measured 2026-10).

## Traps (all measured)

1. **Health-check URL must match the served content.** The watchdog checks
   `$URL/` — checking `$URL/todos` against a static page server logs a false
   404 WARN on every tick. Use the path that actually returns 200/304.
2. **Never build the health URL from `devbridge port list` output.** The table
   lines are wrapped in OSC escape sequences, so anchored greps
   (`^\S+ \K[0-9]+`) silently fail and the constructed URL 404s. Hardcode the
   URL per tunnel — tunnel IDs never change, so the URL is stable.
3. **The management plane can lose a tunnel record while the data plane still
   serves.** `devbridge show <id>` / `devbridge update <id>` return
   `10002 tunnel not found` even though the URL keeps working (host attached).
   The tunnel then cannot be renewed or inspected — treat it as disposable and
   create a fresh tunnel for anything that must survive.
4. **Renewal success = exit 0 AND absolute expiration visible.** A bare exit
   code from a still-running host process says nothing about the management
   record. Verify with `show <id> -v` (see `huaweicloud_sandbox_renew_tunnel`).
