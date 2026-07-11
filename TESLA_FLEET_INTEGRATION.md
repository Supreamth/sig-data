# Tesla Fleet Integration

This integration is read-only. It polls Tesla Fleet vehicle state and charge
state and writes numeric metrics to InfluxDB for the ECharts dashboard APIs.

## Runtime

- Token file: `/data/tesla_oauth_token.json` in Docker, backed by `./data/tesla_oauth_token.json` on the host.
- Fleet API host: `https://fleet-api.prd.eu.vn.cloud.tesla.com`.
- Public key endpoint: already hosted for Tesla Fleet virtual key registration.
- Wake and vehicle commands: not used. `wake_up` is not called even when `TESLA_WAKE_ALLOWED=true`.
- Full VINs are not written as tags or logs. The collector uses only the last six VIN characters.

## OAuth Refresh

The collector reads `TESLA_TOKEN_FILE` on each poll. If the current access token
is still valid outside the refresh skew, it is used as-is. If it is expired or
near expiry, the collector refreshes it with the token file's `refresh_token`
and server-side OAuth client credentials.

Required server-side environment variables:

- `TESLA_CLIENT_ID`
- `TESLA_CLIENT_SECRET`

Optional refresh environment variables:

- `TESLA_TOKEN_URL`, default `https://auth.tesla.com/oauth2/v3/token`
- `TESLA_REFRESH_SKEW_SECONDS`, default `300`
- `TESLA_OAUTH_SCOPE`, default `openid offline_access vehicle_device_data`

The token file records token age with `obtained_at`, `expires_in`, and
`expires_at`; the collector also accepts `created_at` for compatibility. Refresh
writes are atomic and protected by a lock file next to the token file, so
parallel collector starts do not double-refresh the same token. If Tesla omits a
replacement `refresh_token`, the previous refresh token is preserved. The
existing `audience` value is also preserved when Tesla omits it in the refresh
response.

If refresh cannot run because the client ID, client secret, or token-file
`refresh_token` is missing, the collector logs a sanitized error and keeps the
old token file. Refresh failures never delete the previous token file.

Token file permissions should be limited to the collector runtime user. In
Docker Compose, keep `./data/tesla_oauth_token.json` and any private key files
out of git and avoid broad host permissions on `./data`.

## Docker Compose

Validate configuration:

```bash
docker compose --profile stack config >/tmp/compose-stack.out
```

Run the stack with the collector:

```bash
docker compose --profile stack up -d influxdb echarts-dashboard tesla-fleet-collector
```

View collector logs:

```bash
docker logs -f tesla-fleet-collector
```

Stop the collector:

```bash
docker compose --profile stack stop tesla-fleet-collector
```

## Dashboard APIs

Test from the host running the dashboard:

```bash
curl http://127.0.0.1:3200/api/tesla/latest
curl "http://127.0.0.1:3200/api/tesla/history?range=24h"
curl "http://127.0.0.1:3200/api/tesla/history?range=7d"
curl "http://127.0.0.1:3200/api/tesla/history?range=30d"
curl http://127.0.0.1:3200/api/tesla/session-context
```

## Security

Rotate Tesla OAuth client secrets on a regular schedule and immediately after
any suspected exposure. When rotating, update the server-side secret value and
restart the collector; do not edit documentation, compose files, logs, or
dashboard responses with literal secrets. Do not store Tesla tokens, refresh
tokens, client secrets, private keys, or full VINs in git history or logs.
