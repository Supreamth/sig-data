# Sigen Energy Cockpit V2 — Baseline Snapshot

> Captured: 2026-07-12  
> Branch: `feature/sigen-energy-cockpit-v2`  
> Repo: `/root/projects/sig-data`

---

## 1. Git State

```
Branch: feature/sigen-energy-cockpit-v2 (created from main)
Latest main commits before branch:
  22715dd docs: record v1.0.1 production dry-run
  0aecf17 docs: record v1.0.1 staging deploy
  e0ec0a1 docs: record v1.0.1 staging dry-run
  46ae3b6 docs: record v1.0.1 gate 1 completion
  7253db7 feat: add v1.0.1 candidate marker
Existing tags: v1.0.1, v1.0.0
```

---

## 2. Syntax Checks

```
node --check echarts-dashboard/server.js  → OK
node --check echarts-dashboard/public/app.js → OK
docker compose --profile stack config    → OK (no validation errors)
```

---

## 3. Service State at Baseline

Dashboard service `echarts-dashboard` is **running** on `http://localhost:3200`.

### /api/health

```json
{
  "status": "ok",
  "station_id": "72026051000002",
  "bucket": "energy_metrics",
  "org": "sigorg",
  "latest_db_timestamp": "2026-07-12T03:41:19.028215Z"
}
```

No credentials or secrets present in this output.

---

## 4. Live Telemetry Snapshot (/api/latest)

Captured at `2026-07-12T03:41:32.982468Z`.

### Energy

| Metric | Value | Unit |
|--------|-------|------|
| pv_power | 9.0 | kW (aggregate) |
| pv_string_total_power | 10.05 | kW (4-string sum) |
| load_power | 8.3 | kW |
| grid_flow_power | 0 | kW (idle) |
| battery_power | 0.7 | kW (charging) |
| battery_soc | 75.8 | % |
| ev_power | 0 | kW |
| on_grid | 1 | boolean |
| grid_idle | 1 | boolean |
| pv_day_nrg | 24.36 | kWh today |

### PV Strings (4 strings available)

| String | Power (kW) | Voltage (V) | Current (A) | Today (kWh) | Lifetime (kWh) |
|--------|-----------|-------------|-------------|-------------|----------------|
| PV1 | 3.82 | 597.3 | 6.39 | 9.35 | 1231.79 |
| PV2 | 1.53 | 213.6 | 7.16 | 4.09 | 514.94 |
| PV3 | 2.02 | 304.2 | 6.64 | 4.98 | 621.46 |
| PV4 | 2.68 | 429.4 | 6.23 | 5.81 | 762.21 |

### Battery Modules (2 modules, 18.08 kWh total capacity)

| Module | SN | Avg Cell Temp (°C) | Avg Cell Voltage (V) | Safeguard Score | Total Discharge (kWh) |
|--------|----|--------------------|----------------------|-----------------|-----------------------|
| 1 | 110B143N0260 | 39.4 | 3.355 | 20 | 568.6 |
| 2 | 110B143N0258 | 40.5 | 3.357 | 48 | 565.45 |

### Daily Summary

| Metric | Value |
|--------|-------|
| grid_idle_hours (today) | 3.69 h |
| grid_idle_minutes (today) | 221.45 min |
| grid_cost_thb_today | 33.35 THB |
| grid_import_kwh_today | 7.902 kWh |
| grid_cost_rate | 4.22 THB/kWh |
| pv_solar today | 24.623 kWh |
| battery_discharge today | 0.098 kWh |

### Weather

| Metric | Value |
|--------|-------|
| temperature | 30.1 °C |
| weathercode | 51 (drizzle) |
| windspeed | 12.7 km/h |
| winddirection | 216° |
| is_day | 1 |

### DC Charger (/api/dc-charger-cost)

| Metric | Value |
|--------|-------|
| rate_thb_per_kwh | 4.22 |
| last session kWh | 0.67 |
| last session cost_thb | 2.83 THB |
| last session end | 2026-07-11T08:47:00Z |
| month kWh | 69.54 |
| month cost_thb | 293.45 THB |

---

## 5. Existing API Endpoints

All endpoints below exist in `echarts-dashboard/server.js`:

```
GET /api/health
GET /api/summary
GET /api/latest
GET /api/today-recommendation
GET /api/realtime-energy
GET /api/report
GET /api/data-health
GET /api/solar-stats
GET /api/weather-vs-actual
GET /api/energy-source-mix
GET /api/grid-cost
GET /api/battery-full-time
GET /api/dc-charger-cost
GET /api/tesla/latest
GET /api/tesla/history
GET /api/tesla/session-context
GET /api/solar-hybrid-insight
GET /api/telegram/status
GET /api/history?range=<range>
GET /api/sun-path
```

---

## 6. V1 Dashboard Files

```
echarts-dashboard/server.js        — Express API proxy and telemetry aggregation
echarts-dashboard/public/index.html — V1 dashboard markup and inline CSS
echarts-dashboard/public/app.js    — V1 ECharts rendering, i18n, refresh logic
echarts-dashboard/public/styles.css — V1 global styling
docker-compose.yml                 — service wiring for echarts-dashboard
```

---

## 7. Design Observations (V1 Issues to Address in V2)

These are structural observations for the revamp. The current dashboard is not broken; these are UX improvement targets.

1. **Power Flow canvas is not the hero** — current layout gives equal weight to multiple panels; the flow diagram is one of many, not the centerpiece.
2. **No LIVE/OFFLINE/freshness indicator** — no explicit signal if data is stale.
3. **Dense card layout** — many panels compete for attention at the same visual weight.
4. **PV string breakdown** — the individual PV1–PV4 telemetry exists but may not be cleanly surfaced in V1 in a way that avoids confusion with aggregate.
5. **Grid Idle Time / Grid Cost** not in a first-tier KPI position.
6. **Energy Intent** — no plain-language "what is the system doing now" card.
7. **DC Charger / Tesla** context not prominent.
8. **Tablet/mobile layout** — layout may be tight at 760–860px.
9. **24h Energy Story** — range-linked history; fixed 24h view would be cleaner.
10. **Tooltip clipping** — ECharts tooltips may be cut off at panel edges.

---

## 8. Revamp Plan Reference

Implementation plan: `.hermes/plans/2026-07-12_033852-sigen-realtime-energy-flow-v2-revamp.md`

Target product name: **Sigen Energy Cockpit V2**  
Feature branch: `feature/sigen-energy-cockpit-v2`  
V1 root preserved throughout. V2 routes added on separate files before any root switch.
