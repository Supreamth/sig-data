'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const express = require('express');
const fetch = require('node-fetch');

const app = express();
const PORT = Number(process.env.POWER_FLOW_DASHBOARD_PORT || 3300);

const INFLUXDB_URL = process.env.INFLUXDB_URL || 'http://influxdb:8086';
const INFLUXDB_TOKEN = process.env.INFLUXDB_TOKEN;
const INFLUXDB_ORG = process.env.INFLUXDB_ORG || 'sigorg';
const INFLUXDB_BUCKET = process.env.INFLUXDB_BUCKET || 'energy_metrics';
const STATION_ID = process.env.SIGEN_STATION_ID || '';

const ALLOWED_RANGES = ['30m', '2h', '6h', '24h'];
const HISTORY_FIELDS = [
  'pv_power',
  'load_power',
  'grid_flow_power',
  'battery_power',
  'battery_soc',
  'pv_day_nrg',
  'on_grid',
  'station_status',
  'ac_power',
  'ev_power',
  'generator_power',
  'heat_pump_power',
  'third_pv_power',
];

async function queryInflux(flux) {
  if (!INFLUXDB_TOKEN) throw new Error('INFLUXDB_TOKEN is not configured');
  const res = await fetch(`${INFLUXDB_URL}/api/v2/query?org=${encodeURIComponent(INFLUXDB_ORG)}`, {
    method: 'POST',
    headers: {
      Authorization: 'Token ' + INFLUXDB_TOKEN,
      'Content-Type': 'application/vnd.flux',
      Accept: 'application/csv',
    },
    body: flux,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`InfluxDB ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.text();
}

function parseCsv(csv) {
  const lines = String(csv || '').split('\n').filter(line => line && !line.startsWith('#'));
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).map(line => {
    const vals = line.split(',');
    const row = {};
    headers.forEach((h, i) => { row[h] = vals[i] ? vals[i].trim() : ''; });
    return row;
  }).filter(row => row._value !== undefined && row._value !== '');
}

function toNumber(value) {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function latestFlux(measurement, lookback, keepTime = true) {
  const keep = keepTime ? '["_field", "_value", "_time"]' : '["_field", "_value"]';
  return `
from(bucket: "${INFLUXDB_BUCKET}")
  |> range(start: -${lookback})
  |> filter(fn: (r) => r._measurement == "${measurement}" and r.station_id == "${STATION_ID}")
  |> last()
  |> keep(columns: ${keep})
`;
}

async function getLatestPayload() {
  const pvStringFlux = `
from(bucket: "${INFLUXDB_BUCKET}")
  |> range(start: -15m)
  |> filter(fn: (r) => r._measurement == "pv_string_metrics" and r.station_id == "${STATION_ID}")
  |> last()
  |> keep(columns: ["_field", "_value", "_time", "device_sn", "source"])
`;

  const [energyCsv, weatherCsv, dailyCsv, pvStringCsv] = await Promise.all([
    queryInflux(latestFlux('energy_metrics', '15m')).catch(() => ''),
    queryInflux(latestFlux('weather_current', '2h', false)).catch(() => ''),
    queryInflux(latestFlux('sigen_daily_summary', '25h', false)).catch(() => ''),
    queryInflux(pvStringFlux).catch(() => ''),
  ]);

  const energy = {};
  let timestamp = null;
  parseCsv(energyCsv).forEach(row => {
    const n = toNumber(row._value);
    energy[row._field] = n !== null ? n : row._value;
    if (!timestamp && row._time) timestamp = row._time;
  });

  const weather = {};
  parseCsv(weatherCsv).forEach(row => {
    const n = toNumber(row._value);
    weather[row._field] = n !== null ? n : row._value;
  });

  const daily = {};
  parseCsv(dailyCsv).forEach(row => {
    const n = toNumber(row._value);
    daily[row._field] = n !== null ? n : row._value;
  });

  const pv_strings = { timestamp: null, device_sn: null, source: null };
  parseCsv(pvStringCsv).forEach(row => {
    const n = toNumber(row._value);
    if (n !== null && row._field) pv_strings[row._field] = n;
    if (!pv_strings.timestamp && row._time) pv_strings.timestamp = row._time;
    if (!pv_strings.device_sn && row.device_sn) pv_strings.device_sn = row.device_sn;
    if (!pv_strings.source && row.source) pv_strings.source = row.source;
  });
  if (toNumber(pv_strings.pv_total_power) !== null) energy.pv_string_total_power = pv_strings.pv_total_power;

  return { timestamp, energy, weather, daily, pv_strings };
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/vendor/power-flow-card-plus.js', (req, res) => {
  res.type('application/javascript').sendFile(path.join(__dirname, 'vendor/power-flow-card-plus.js'));
});

app.get('/api/health', async (req, res) => {
  try {
    let latestDbTimestamp = null;
    try {
      const csv = await queryInflux(`
from(bucket: "${INFLUXDB_BUCKET}")
  |> range(start: -1h)
  |> filter(fn: (r) => r._measurement == "energy_metrics" and r.station_id == "${STATION_ID}")
  |> filter(fn: (r) => r._field == "battery_soc")
  |> last()
  |> keep(columns: ["_time", "_value"])
  |> limit(n: 1)
`);
      const rows = parseCsv(csv);
      latestDbTimestamp = rows[0] ? rows[0]._time : null;
    } catch (_) {}

    res.json({
      status: 'ok',
      card: 'flixlix/power-flow-card-plus v0.3.7',
      station_id: STATION_ID,
      bucket: INFLUXDB_BUCKET,
      org: INFLUXDB_ORG,
      latest_db_timestamp: latestDbTimestamp,
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.get('/api/latest', async (req, res) => {
  try {
    res.json(await getLatestPayload());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/history', async (req, res) => {
  try {
    let range = req.query.range || '2h';
    if (!ALLOWED_RANGES.includes(range)) range = '2h';

    const windowMap = { '30m': '15s', '2h': '30s', '6h': '5m', '24h': '15m' };
    const window = windowMap[range] || '30s';
    const fieldFilter = HISTORY_FIELDS.map(f => `r._field == "${f}"`).join(' or ');
    const csv = await queryInflux(`
from(bucket: "${INFLUXDB_BUCKET}")
  |> range(start: -${range})
  |> filter(fn: (r) => r._measurement == "energy_metrics" and r.station_id == "${STATION_ID}")
  |> filter(fn: (r) => ${fieldFilter})
  |> aggregateWindow(every: ${window}, fn: mean, createEmpty: false)
  |> keep(columns: ["_time", "_field", "_value"])
`);

    const series = {};
    parseCsv(csv).forEach(row => {
      const v = toNumber(row._value);
      if (v === null) return;
      if (!series[row._field]) series[row._field] = [];
      series[row._field].push({ time: row._time, value: v });
    });

    res.json({ range, window, series });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Power Flow Card Plus dashboard listening on port ${PORT}`);
  console.log(`InfluxDB: ${INFLUXDB_URL}, org: ${INFLUXDB_ORG}, bucket: ${INFLUXDB_BUCKET}`);
});
