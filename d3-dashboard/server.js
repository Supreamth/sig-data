'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const express = require('express');
const fetch = require('node-fetch');

const app = express();
const PORT = 3100;

const INFLUXDB_URL = process.env.INFLUXDB_URL || 'http://influxdb:8086';
const INFLUXDB_TOKEN = process.env.INFLUXDB_TOKEN;
const INFLUXDB_ORG = process.env.INFLUXDB_ORG || 'sigorg';
const INFLUXDB_BUCKET = process.env.INFLUXDB_BUCKET || 'energy_metrics';
const STATION_ID = process.env.SIGEN_STATION_ID || '';

const ALLOWED_RANGES = ['30m', '2h', '6h', '24h'];

async function queryInflux(flux) {
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
    throw new Error(`InfluxDB ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.text();
}

function parseCsv(csv) {
  const lines = csv.split('\n').filter(l => l && !l.startsWith('#'));
  if (lines.length < 2) return [];
  const headers = lines[0].split(',');
  return lines.slice(1).map(line => {
    const vals = line.split(',');
    const obj = {};
    headers.forEach((h, i) => { obj[h.trim()] = vals[i] ? vals[i].trim() : ''; });
    return obj;
  }).filter(r => r._value !== undefined && r._value !== '');
}

function toNumber(v) {
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

app.use(express.static(path.join(__dirname, 'public')));

// Serve d3 from node_modules
app.get('/vendor/d3.min.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules/d3/dist/d3.min.js'));
});

app.get('/api/health', async (req, res) => {
  try {
    const flux = `
from(bucket: "${INFLUXDB_BUCKET}")
  |> range(start: -1h)
  |> filter(fn: (r) => r._measurement == "energy_metrics" and r.station_id == "${STATION_ID}")
  |> filter(fn: (r) => r._field == "battery_soc")
  |> last()
  |> keep(columns: ["_time", "_value"])
  |> limit(n: 1)
`;
    let lastTs = null;
    try {
      const csv = await queryInflux(flux);
      const rows = parseCsv(csv);
      if (rows.length > 0) lastTs = rows[0]._time || null;
    } catch (_) {}

    res.json({
      status: 'ok',
      station_id: STATION_ID,
      bucket: INFLUXDB_BUCKET,
      org: INFLUXDB_ORG,
      latest_db_timestamp: lastTs,
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.get('/api/latest', async (req, res) => {
  try {
    const energyFlux = `
from(bucket: "${INFLUXDB_BUCKET}")
  |> range(start: -15m)
  |> filter(fn: (r) => r._measurement == "energy_metrics" and r.station_id == "${STATION_ID}")
  |> last()
  |> keep(columns: ["_field", "_value", "_time"])
`;
    const weatherFlux = `
from(bucket: "${INFLUXDB_BUCKET}")
  |> range(start: -2h)
  |> filter(fn: (r) => r._measurement == "weather_current" and r.station_id == "${STATION_ID}")
  |> last()
  |> keep(columns: ["_field", "_value"])
`;
    const dailyFlux = `
from(bucket: "${INFLUXDB_BUCKET}")
  |> range(start: -25h)
  |> filter(fn: (r) => r._measurement == "sigen_daily_summary" and r.station_id == "${STATION_ID}")
  |> last()
  |> keep(columns: ["_field", "_value"])
`;

    const [energyCsv, weatherCsv, dailyCsv] = await Promise.all([
      queryInflux(energyFlux).catch(() => ''),
      queryInflux(weatherFlux).catch(() => ''),
      queryInflux(dailyFlux).catch(() => ''),
    ]);

    const energy = {};
    let lastTime = null;
    parseCsv(energyCsv).forEach(r => {
      energy[r._field] = toNumber(r._value) !== null ? toNumber(r._value) : r._value;
      if (!lastTime && r._time) lastTime = r._time;
    });

    const weather = {};
    parseCsv(weatherCsv).forEach(r => {
      weather[r._field] = toNumber(r._value) !== null ? toNumber(r._value) : r._value;
    });

    const daily = {};
    parseCsv(dailyCsv).forEach(r => {
      daily[r._field] = toNumber(r._value) !== null ? toNumber(r._value) : r._value;
    });

    res.json({ timestamp: lastTime, energy, weather, daily });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/history', async (req, res) => {
  try {
    let range = req.query.range || '2h';
    if (!ALLOWED_RANGES.includes(range)) range = '2h';

    const fields = ['pv_power', 'load_power', 'grid_flow_power', 'battery_power',
      'battery_soc', 'pv_day_nrg', 'on_grid', 'station_status'];

    const fieldFilter = fields.map(f => `r._field == "${f}"`).join(' or ');

    // Determine window based on range
    const windowMap = { '30m': '15s', '2h': '30s', '6h': '5m', '24h': '15m' };
    const window = windowMap[range] || '2m';

    const flux = `
from(bucket: "${INFLUXDB_BUCKET}")
  |> range(start: -${range})
  |> filter(fn: (r) => r._measurement == "energy_metrics" and r.station_id == "${STATION_ID}")
  |> filter(fn: (r) => ${fieldFilter})
  |> aggregateWindow(every: ${window}, fn: mean, createEmpty: false)
  |> keep(columns: ["_time", "_field", "_value"])
`;

    const csv = await queryInflux(flux);
    const rows = parseCsv(csv);

    // Group by field
    const series = {};
    rows.forEach(r => {
      if (!series[r._field]) series[r._field] = [];
      const v = toNumber(r._value);
      if (v !== null) series[r._field].push({ time: r._time, value: v });
    });

    res.json({ range, window, series });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`D3 dashboard listening on port ${PORT}`);
  console.log(`InfluxDB: ${INFLUXDB_URL}, org: ${INFLUXDB_ORG}, bucket: ${INFLUXDB_BUCKET}`);
});
