# Sigenergy Developer OpenAPI PV String Collector

This collector uses the official Sigenergy Developer OpenAPI to collect PV string-level telemetry when it is exposed by your authorized system/device. It does not use Modbus.

It writes normalized points into the existing InfluxDB bucket used by Grafana.

## What it collects

The collector normalizes available data into the InfluxDB measurement:

`pv_string_metrics`

Tags:

- `station_id`
- `device_sn`
- `source` (`device_realtime`, `system_energy_flow`, `web_fallback`, etc.)

Fields:

- `pv1_voltage`
- `pv1_current`
- `pv1_power`
- `pv2_voltage`
- `pv2_current`
- `pv2_power`
- `pv3_voltage`
- `pv3_current`
- `pv3_power`
- `pv4_voltage`
- `pv4_current`
- `pv4_power`
- `pv_total_power`

If Sigenergy returns voltage and current but not per-string power, the collector derives:

`pvN_power = pvN_voltage * pvN_current / 1000`

because voltage is V, current is A, and power is stored as kW.

## Official OpenAPI endpoints used

Authentication:

- `POST /openapi/auth/login/key`

Inventory/discovery:

- `GET /openapi/system`
- `GET /openapi/system/{systemId}/devices`

Realtime/system/device data:

- `GET /openapi/systems/{systemId}/summary`
- `GET /openapi/systems/{systemId}/energyFlow`
- `GET /openapi/systems/{systemId}/devices/{serialNumber}/realtimeInfo`

According to Sigenergy docs, `Device Realtime Data` for AIO/Inverter devices can expose:

- `pv1Voltage`, `pv1Current`
- `pv2Voltage`, `pv2Current`
- `pv3Voltage`, `pv3Current`
- `pv4Voltage`, `pv4Current`
- `pvPower`, `pvTotalPower`

The collector also inspects for future/list-style fields:

- `pvStringList`
- `stringList`
- `mpptList`
- `dcInputList`

## Required configuration

Add these to `.env`:

```env
SIGEN_APP_KEY="your developer app key"
SIGEN_APP_SECRET="your developer app secret"
SIGEN_REGION="apac"
SIGEN_SYSTEM_ID="your system id"
SIGEN_DEVICE_SN="your inverter/AIO device serial number"
```

`SIGEN_SYSTEM_ID` and `SIGEN_DEVICE_SN` are strongly recommended. If omitted, the collector will try to discover systems/devices and choose the first inverter/AIO-like device, but explicit values are safer.

Optional:

```env
# Override if Sigenergy gives you a different regional OpenAPI host.
SIGEN_OPENAPI_BASE_URL="https://api-apac.sigencloud.com"

# Official OpenAPI endpoints are rate-limited. Five minutes matches the docs.
SIGEN_OPENAPI_PV_INTERVAL=300
```

InfluxDB settings are reused from the existing stack:

```env
INFLUXDB_URL="http://influxdb:8086"
INFLUXDB_TOKEN="..."
INFLUXDB_ORG="sigorg"
INFLUXDB_BUCKET="energy_metrics"
```

## MySigen Web fallback

The official Developer OpenAPI is preferred. The MySigen Web internal endpoint is disabled by default and only used if official responses do not expose PV1-PV4/string fields.

Fallback endpoint:

`GET /device/pvPanel/realTimeInfo?stationId=...&snCode=...`

Enable only when needed:

```env
SIGEN_ENABLE_WEB_FALLBACK=true
SIGEN_WEB_BASE_URL="https://api-apac.sigencloud.com"
SIGEN_WEB_ACCESS_TOKEN="Bearer token or raw access token"
# or, if token auth is not enough:
SIGEN_WEB_COOKIE="cookie string from your own session"
```

Never hardcode a Web token or cookie in source files. Keep them in `.env` only.

## Commands

Check required env vars:

```bash
docker compose --profile stack run --rm sigen-openapi-pv-collector python sigen_openapi_pv_collector.py --check-env
```

Discover authorized systems/devices without writing to DB:

```bash
docker compose --profile stack run --rm sigen-openapi-pv-collector python sigen_openapi_pv_collector.py --discover-only
```

Run one dry-run collection cycle without writing:

```bash
docker compose --profile stack run --rm sigen-openapi-pv-collector python sigen_openapi_pv_collector.py --once --dry-run
```

Run one collection cycle and write to InfluxDB:

```bash
docker compose --profile stack run --rm sigen-openapi-pv-collector python sigen_openapi_pv_collector.py --once
```

Start the long-running collector:

```bash
docker compose --profile stack up -d --build sigen-openapi-pv-collector
```

View logs:

```bash
docker logs --tail 120 sigen-openapi-pv-collector
```

## Verify data in InfluxDB

```bash
docker exec influxdb sh -lc 'cat >/tmp/pv_strings.flux <<"EOF"
from(bucket: "energy_metrics")
  |> range(start: -30m)
  |> filter(fn: (r) => r._measurement == "pv_string_metrics")
  |> last()
EOF
influx query --org sigorg --file /tmp/pv_strings.flux'
```

## Telemetry Push note

If `Device Realtime Data` does not expose PV1-PV4 for your device/account, Sigenergy's docs say telemetry push content is customizable through Data Subscription / Telemetry. In that case, check the Developer Control Center data subscription topics and ask Sigenergy support to include PV string / MPPT / DC input voltage-current-power signals.

The collector logs the interesting keys found in official responses so you can confirm whether PV string data is currently exposed.
