# Deployment Guide

This guide covers running BusyChat (F261Agent) as a long-lived production service:
Docker Compose, systemd, TLS reverse proxies, environment overrides, backups,
upgrades, and the security checklist.

The application requires **Node.js >= 22** (see `.nvmrc` and `engines.node`).
Both `package-lock.json` files are committed; always install with `npm ci`.

## Environment variables

These are the only supported overrides. They are applied on top of `config.json`
at startup; `config.json` remains the source of truth for everything else.

| Variable | Default | Purpose |
|---|---|---|
| `BUSYCHAT_CONFIG` | `./config.json` | Path to the root config file. |
| `BUSYCHAT_DATA_DIR` | `settings.dataDir` (`data`) | Overrides the data directory. Holds `f261agent.db` (SQLite: events, summaries, knowledge base, plugin storage/config) and the `plugins/` mirror. |
| `BUSYCHAT_HOST` | `settings.host` (`127.0.0.1`) | Listener address. Use `0.0.0.0` inside a container. |
| `BUSYCHAT_PORT` | `settings.port` (`3000`) | Listener port. |
| `BUSYCHAT_TRUST_PROXY` | `settings.trustProxy` (`false`) | Trust `X-Forwarded-For` / `X-Forwarded-Proto`. Set to `1` (or `true`) **only** behind a reverse proxy. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `silent`. |

Do not expose the process directly to the internet. Terminate TLS at a reverse
proxy (nginx/Caddy) and keep the app on loopback, or bind `0.0.0.0` only inside a
container whose port is published to `127.0.0.1` on the host.

## Docker Compose

1. Prepare host directories and config:

   ```bash
   cp config.example.json config.json
   mkdir -p data
   # 容器内以 uid/gid 10001 运行，绑定目录需要匹配
   sudo chown -R 10001:10001 data
   sudo chown 10001:10001 config.json
   chmod 0600 config.json
   ```

2. Start:

   ```bash
   docker compose up -d --build
   docker compose logs -f
   ```

The compose file:

- builds from the local `Dockerfile` (multi-stage; dev dependencies and frontend
  toolchain never reach the runtime image),
- publishes `127.0.0.1:3000:3000` only,
- mounts `./data:/app/data` and `./config.json:/app/config.json`,
- sets `BUSYCHAT_HOST=0.0.0.0`, `BUSYCHAT_DATA_DIR=/app/data`, `BUSYCHAT_CONFIG=/app/config.json`,
  `LOG_LEVEL=info`,
- has a `node fetch` based healthcheck against `/health`.

`config.json` is mounted **read-write** because the WebUI saves changes in place.
If you mount it read-only, configuration changes from the dashboard will fail.

The image creates uid/gid `10001` and runs as that user. If the bind-mounted
`./data` is not owned by `10001`, the process cannot write the database and will
fail closed at startup.

Without Compose:

```bash
docker build -t busychat:latest .
docker run -d --name busychat --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  -e BUSYCHAT_HOST=0.0.0.0 \
  -e BUSYCHAT_DATA_DIR=/app/data \
  -e BUSYCHAT_CONFIG=/app/config.json \
  -e LOG_LEVEL=info \
  -v "$PWD/data:/app/data" \
  -v "$PWD/config.json:/app/config.json" \
  busychat:latest
```

## systemd

Use [`deploy/busychat.service`](../deploy/busychat.service) as the starting point.
It expects the code in `/opt/busychat`, config in `/etc/busychat/config.json`, and
data in `/var/lib/busychat`:

```bash
sudo useradd --system --home /opt/busychat --shell /usr/sbin/nologin busychat
sudo install -d -o busychat -g busychat /var/lib/busychat /etc/busychat
sudo cp config.example.json /etc/busychat/config.json
sudo chown busychat:busychat /etc/busychat/config.json
sudo chmod 0600 /etc/busychat/config.json
sudo cp deploy/busychat.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now busychat
sudo systemctl status busychat
journalctl -u busychat -f
```

Build the application before the first start:

```bash
cd /opt/busychat
npm ci
npm --prefix webui ci
npm run build
```

The unit runs `node dist/index.js` as `busychat` with `Restart=always`, and sets
`ProtectSystem=strict` with `ReadWritePaths=/etc/busychat /var/lib/busychat`, so
only the config directory and data directory are writable.

## Reverse proxy and TLS

Examples:

- [`deploy/nginx.conf`](../deploy/nginx.conf) — TLS termination, WebSocket
  `Upgrade` headers for the reverse WS path, `X-Forwarded-*`, and a login
  rate-limit zone.
- [`deploy/Caddyfile`](../deploy/Caddyfile) — automatic TLS and WebSocket
  proxying; use a rate-limit plugin or an upstream WAF for extra login limiting.

Both examples assume the app listens on `127.0.0.1:3000`. Keep that true so
clients cannot bypass the proxy and spoof forwarding headers.

### trustProxy

`settings.trustProxy` (or `BUSYCHAT_TRUST_PROXY=1`) tells the app to read the
client address from `X-Forwarded-For`/`X-Forwarded-Proto` for login throttling,
audit logging, and secure-cookie decisions.

- **Behind nginx/Caddy:** set `BUSYCHAT_TRUST_PROXY=1` and make the proxy
  overwrite (not blindly append) `X-Forwarded-For`.
- **Direct or port-published access:** keep it `false`. Trusting the header while
  clients can reach the app directly lets anyone forge their source IP.

The reverse WebSocket path defaults to `/onebot/ws`; if you change
`runtime.onebot.webSocket.reversePath`, update the proxy location to match.

## First run and files

On first startup the application creates `config.json` from its built-in
defaults (`createDefaultAppConfig`) when the file is missing. `config.example.json`
is a documented template, not the literal bootstrap source. Runtime state lives
in `data/f261agent.db`; plugin business configuration is stored in the same
database (`plugin_kv`), mirrored to `data/plugins/<name>.json`.

### Authentication defaults (fail-closed)

- **No WebUI password**: the admin API and dashboard are reachable only from
  loopback *direct* requests (loopback peer, loopback `Host`, no proxy headers).
  Remote requests get `401`, including requests forwarded by a reverse proxy.
  DNS-rebinding is rejected because a non-loopback `Host` is not accepted.
  Open the dashboard from the machine itself to set a password.
- **No OneBot `accessToken`**: the HTTP event path and the reverse WebSocket only
  accept loopback direct peers. Remote OneBot implementations are rejected until
  a token is configured; the startup log prints a multi-line error explaining this.
- **`settings.trustProxy`** defaults to `false`; only enable it (`1`) when the
  process is reachable exclusively through a trusted reverse proxy, and configure
  the same proxy to strip client-supplied `X-Forwarded-*` headers.
- Passwords set through the dashboard or `config.json` are stored as an scrypt
  hash (`runtime.ui.passwordHash`); legacy plaintext `runtime.ui.password` is
  migrated on startup and removed. Passwords shorter than 6 characters are not
  migrated.

## Backup and restore

The authoritative state is two things:

- `data/f261agent.db` (single SQLite file; events, summaries, knowledge base,
  plugin config/storage, and the database backup `f261agent.db.bak` if present)
- `config.json`

For a consistent backup, **stop the process first**:

```bash
sudo systemctl stop busychat
cp -a /etc/busychat/config.json /backup/config.json
cp -a /var/lib/busychat/f261agent.db /backup/f261agent.db
sudo systemctl start busychat
```

The database is a normal SQLite file, so with SQLite tooling you can also take a
consistent online snapshot:

```bash
sqlite3 /var/lib/busychat/f261agent.db ".backup '/backup/f261agent.db'"
```

Do not copy the file while the application is writing it — the driver rewrites
the whole file on checkpoint, so a naive live `cp` can produce a torn database.

Restore:

```bash
sudo systemctl stop busychat
sudo install -o busychat -g busychat -m 0600 /backup/f261agent.db /var/lib/busychat/f261agent.db
sudo install -o busychat -g busychat -m 0600 /backup/config.json /etc/busychat/config.json
sudo systemctl start busychat
```

For Docker, stop the container or run the same commands against the bind-mounted
`./data` and `./config.json`.

## Upgrade procedure

1. Back up `f261agent.db` and `config.json` (see above).
2. Stop the service.
3. Fetch the new revision and install exact dependencies:

   ```bash
   git pull
   npm ci
   npm --prefix webui ci
   npm run build
   ```

   `npm run build` clears `dist/` via `clean:server`, builds the frontend into
   `webui-dist/`, then compiles the backend.
4. Start the service and check `/health` and the logs.
5. Config migrations (legacy plugin config, password hashing, etc.) run
   automatically on startup and are idempotent.

Docker: `docker compose build --pull && docker compose up -d`.

## Health and readiness

- `GET /health` returns `{"ok":true,"service":"f261agent"}` and stays available
  even when the WebUI is disabled. Use it for container healthchecks and
  systemd/uptime monitors.
- The OneBot HTTP event path (`settings.eventPath`, default `/onebot/event`)
  remains available independent of the WebUI.
- `GET /health/ready` is the readiness probe. It returns `200` when storage is
  healthy and `503` when the database cannot be written. The body carries checks
  for storage (`lastSaveError`, `sizeBytes`), OneBot transport (mode, connection
  state, last pong), whether only fallback models are configured, and summary
  worker status. A `degraded` status (still `200`) means the process is serving
  but something (fallback-only models, configured transport disconnected) needs
  attention.

Do not point TLS/health monitors at an unauthenticated admin API. `/health` is
the public probe; everything under `/api/*` requires a session.

## Security checklist

- [ ] Set a WebUI password (Settings → Security) immediately after first login.
      Without one, remote admin access is denied by design (local-only mode).
- [ ] Set `runtime.onebot.accessToken` whenever the event path or reverse WS is
      reachable off-host (non-loopback). Without it those endpoints fail closed.
- [ ] Keep `config.json` at mode `0600`, owned by the service user; it contains
      API keys and the WebUI password hash.
- [ ] Keep the data directory at `0700`; `f261agent.db` contains message history.
- [ ] Bind the app to loopback and terminate TLS at nginx/Caddy (or publish the
      container port to `127.0.0.1` only).
- [ ] Enable `BUSYCHAT_TRUST_PROXY=1` only behind a proxy; otherwise leave `0`.
- [ ] Restrict `/onebot/event` and `/onebot/ws` to your OneBot implementation via
      firewall rules where possible.
- [ ] Run as a non-root user (uid `10001` in Docker, `busychat` under systemd).
- [ ] Back up before every upgrade and store backups encrypted.
- [ ] Keep Node.js on a supported LTS line (>= 22) and rebuild after upgrades.
