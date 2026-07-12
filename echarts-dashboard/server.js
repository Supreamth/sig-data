'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const express = require('express');
const fetch = require('node-fetch');
const SunCalc = require('suncalc');

const app = express();
const PORT = 3200;

const INFLUXDB_URL = process.env.INFLUXDB_URL || 'http://influxdb:8086';
const INFLUXDB_TOKEN = process.env.INFLUXDB_TOKEN;
const INFLUXDB_ORG = process.env.INFLUXDB_ORG || 'sigorg';
const INFLUXDB_BUCKET = process.env.INFLUXDB_BUCKET || 'energy_metrics';
const STATION_ID = process.env.SIGEN_STATION_ID || '';
const TIMEZONE = process.env.TIMEZONE || 'Asia/Bangkok';
const WEATHER_LATITUDE = process.env.WEATHER_LATITUDE || '';
const WEATHER_LONGITUDE = process.env.WEATHER_LONGITUDE || '';
const WEATHER_TIMEZONE = process.env.WEATHER_TIMEZONE || TIMEZONE;
const OPEN_METEO_API_KEY = process.env.OPEN_METEO_API_KEY || '';
const SLEEP_INTERVAL_S = parseInt(process.env.SLEEP_INTERVAL || '15', 10);
const BATTERY_TOTAL_CAPACITY_KWH = parseFloat(process.env.BATTERY_TOTAL_CAPACITY_KWH || '18.08');
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const TELEGRAM_PARSE_MODE = process.env.TELEGRAM_PARSE_MODE || '';
const TELEGRAM_REPORT_ENABLED = String(process.env.TELEGRAM_REPORT_ENABLED || 'true').toLowerCase() !== 'false';
const TELEGRAM_REPORT_INTERVAL_MS = Math.max(60_000, parseInt(process.env.TELEGRAM_REPORT_INTERVAL_MS || '3600000', 10));
const TELEGRAM_REPORT_STARTUP_DELAY_MS = Math.max(5_000, parseInt(process.env.TELEGRAM_REPORT_STARTUP_DELAY_MS || '60000', 10));
const TELEGRAM_ALERTS_ENABLED = String(process.env.TELEGRAM_ALERTS_ENABLED || 'true').toLowerCase() !== 'false';
const TELEGRAM_ALERT_INTERVAL_MS = Math.max(15_000, parseInt(process.env.TELEGRAM_ALERT_INTERVAL_MS || '60000', 10));
const BATTERY_FULL_SOC = parseFloat(process.env.BATTERY_FULL_SOC || '99');
const BATTERY_LOW_SOC = parseFloat(process.env.BATTERY_LOW_SOC || '10');
const PV_ACTIVE_THRESHOLD_KW = parseFloat(process.env.PV_ACTIVE_THRESHOLD_KW || '0.05');
const GRID_IDLE_THRESHOLD_KW = parseFloat(process.env.GRID_IDLE_THRESHOLD_KW || '0.05');
const DASHBOARD_AUTH_ENABLED = String(process.env.DASHBOARD_AUTH_ENABLED || 'false').toLowerCase() === 'true';
const DASHBOARD_USERNAME = process.env.DASHBOARD_USERNAME || '';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const DATA_STALE_THRESHOLD_MS = parseInt(process.env.DATA_STALE_THRESHOLD_MS || '120000', 10);
const COLLECTOR_FAILURE_THRESHOLD = parseInt(process.env.COLLECTOR_FAILURE_THRESHOLD || '3', 10);
const GRID_COST_RATE_THB_PER_KWH = 4.22;

const SITE_LATITUDE = parseFloat(process.env.SITE_LATITUDE || '13.7875');
const SITE_LONGITUDE = parseFloat(process.env.SITE_LONGITUDE || '100.385833');
const SITE_TIMEZONE = process.env.SITE_TIMEZONE || 'Asia/Bangkok';
const DEFAULT_PANEL_TILT_DEG = parseFloat(process.env.DEFAULT_PANEL_TILT_DEG || '15');

const _DEFAULT_PV_ARRAYS = [
  { id: 'pv1', name: 'PV1 · S 157°', azimuth: 157, tilt: DEFAULT_PANEL_TILT_DEG, color: '#35d07f' },
  { id: 'pv2', name: 'PV2 · NE 66°', azimuth: 66, tilt: DEFAULT_PANEL_TILT_DEG, color: '#22d3ee' },
  { id: 'pv3', name: 'PV3 · W 256°', azimuth: 256, tilt: DEFAULT_PANEL_TILT_DEG, color: '#f59e0b' },
  { id: 'pv4', name: 'PV4 · NW 334°', azimuth: 334, tilt: DEFAULT_PANEL_TILT_DEG, color: '#60a5fa' },
];
const PV_ARRAYS = (() => {
  try {
    const v = process.env.PV_ARRAYS_JSON;
    if (v) {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch (_) {}
  return _DEFAULT_PV_ARRAYS;
})();

const ALLOWED_RANGES = ['30m', '2h', '6h', '24h'];
const telegramState = {
  last_send_time: null,
  last_status: 'idle',
  last_message: null,
};

const alertState = {
  baselined: false,
  battery_full: false,
  battery_low: false,
  pv_active: false,
  grid_state: 'idle',
  data_stale: false,
  collector_failed: false,
  last_alert_event: null,
  last_alert_time: null,
  last_alert_message: null,
  last_alert_error: null,
};

function isDashboardAuthConfigured() {
  return DASHBOARD_AUTH_ENABLED && DASHBOARD_USERNAME && DASHBOARD_PASSWORD;
}

function basicAuth(req, res, next) {
  if (!isDashboardAuthConfigured()) return next();
  if (req.path === '/api/health') return next();

  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    const user = decoded.slice(0, idx);
    const pass = decoded.slice(idx + 1);
    if (user === DASHBOARD_USERNAME && pass === DASHBOARD_PASSWORD) return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="Sigen Energy Dashboard", charset="UTF-8"');
  res.status(401).send('Authentication required');
}

function apiError(res, err, status = 503) {
  res.status(status).json({
    status: 'offline',
    error: err.message,
    reconnect: true,
    timestamp: new Date().toISOString(),
  });
}

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

function safeNumber(v, fallback = 0) {
  const n = toNumber(v);
  return n === null ? fallback : n;
}

function fmtNumber(v, unit = '', decimals = 1) {
  const n = toNumber(v);
  return n === null ? '—' : `${n.toFixed(decimals)}${unit}`;
}

function formatGridFlow(v) {
  const grid = safeNumber(v, 0);
  if (Math.abs(grid) <= 0.05) return 'idle 0.00 kW';
  return grid > 0 ? `export ${Math.abs(grid).toFixed(2)} kW` : `import ${Math.abs(grid).toFixed(2)} kW`;
}

function formatBatteryPower(v) {
  const power = safeNumber(v, 0);
  if (Math.abs(power) <= 0.05) return 'idle 0.00 kW';
  return power > 0 ? `charging ${power.toFixed(2)} kW` : `discharging ${Math.abs(power).toFixed(2)} kW`;
}

function formatMinutes(minutes) {
  const total = Math.max(0, Math.round(safeNumber(minutes, 0)));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h > 0) return m ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

function formatSignedMinutes(minutes) {
  const n = toNumber(minutes);
  if (n === null) return '—';
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  return `${sign}${formatMinutes(Math.abs(n))}`;
}

function formatLocalTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-GB', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' });
}

function localDateKey(isoOrDate) {
  const date = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  return new Intl.DateTimeFormat('sv-SE', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function minutesBetween(laterIso, earlierIso) {
  if (!laterIso || !earlierIso) return null;
  const diff = (new Date(laterIso).getTime() - new Date(earlierIso).getTime()) / 60000;
  return Number.isFinite(diff) ? Math.round(diff) : null;
}

function truncToHour(iso) {
  return new Date(Math.floor(new Date(iso).getTime() / 3600000) * 3600000).toISOString();
}

function localTimeToDate(localDateStr, hour, minute, tz) {
  const guess = new Date(`${localDateStr}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
  const parts = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false,
  }).formatToParts(guess).forEach(({ type, value }) => {
    if (type !== 'literal') parts[type] = parseInt(value, 10);
  });
  const localMs = Date.UTC(parts.year, parts.month - 1, parts.day,
    parts.hour === 24 ? 0 : parts.hour, parts.minute, parts.second);
  const wantedMs = Date.UTC(
    parseInt(localDateStr.slice(0, 4), 10),
    parseInt(localDateStr.slice(5, 7), 10) - 1,
    parseInt(localDateStr.slice(8, 10), 10),
    hour, minute, 0,
  );
  return new Date(guess.getTime() + (wantedMs - localMs));
}

function localDayUtcBounds(dateKey, tz) {
  const start = localTimeToDate(dateKey, 0, 0, tz);
  const [y, m, d] = dateKey.split('-').map(Number);
  const nextKey = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  const end = localTimeToDate(nextKey, 0, 0, tz);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

function parseLocalDate(dateStr, tz) {
  if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    const [, m, d] = dateStr.split('-').map(Number);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return dateStr;
  }
  return new Intl.DateTimeFormat('sv-SE', { timeZone: tz || TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function sunCalcAzToNorth(rad) {
  return ((rad * 180 / Math.PI) + 180 + 360) % 360;
}
function incidenceForPanel(sunAzNorthDeg, sunAltRad, panelAzNorthDeg, panelTiltDeg = DEFAULT_PANEL_TILT_DEG) {
  const diff = Math.abs(sunAzNorthDeg - panelAzNorthDeg);
  const diffDeg = diff > 180 ? 360 - diff : diff;
  const sunAboveHorizon = sunAltRad > 0;
  const tiltRad = (Number.isFinite(panelTiltDeg) ? panelTiltDeg : DEFAULT_PANEL_TILT_DEG) * Math.PI / 180;
  const diffRad = diffDeg * Math.PI / 180;
  const rawCos = Math.sin(sunAltRad) * Math.cos(tiltRad) + Math.cos(sunAltRad) * Math.sin(tiltRad) * Math.cos(diffRad);
  const cosTheta = sunAboveHorizon ? clamp(rawCos, 0, 1) : 0;
  const incidenceAngleDeg = sunAboveHorizon
    ? parseFloat((Math.acos(clamp(rawCos, -1, 1)) * 180 / Math.PI).toFixed(1))
    : null;
  return {
    azimuth_diff_deg: parseFloat(diffDeg.toFixed(1)),
    incidence_angle_deg: incidenceAngleDeg,
    cos_incidence: parseFloat(cosTheta.toFixed(4)),
  };
}

function panelExposure(sunAzNorthDeg, sunAltRad, panelAzNorthDeg, panelTiltDeg = DEFAULT_PANEL_TILT_DEG) {
  const inc = incidenceForPanel(sunAzNorthDeg, sunAltRad, panelAzNorthDeg, panelTiltDeg);
  const score = inc.cos_incidence * 100;
  const status = score >= 70 ? 'Excellent' : score >= 35 ? 'Good' : score > 5 ? 'Weak' : 'Back side';
  return {
    ...inc,
    exposure_score: parseFloat(score.toFixed(1)),
    in_front: sunAltRad > 0 && inc.azimuth_diff_deg <= 90,
    status,
  };
}

function panelIrradianceFromGhi(ghiWm2, sunAzNorthDeg, sunAltRad) {
  const ghi = toNumber(ghiWm2);
  return PV_ARRAYS.map(arr => {
    const inc = incidenceForPanel(sunAzNorthDeg, sunAltRad, arr.azimuth, arr.tilt);
    const plane = ghi === null ? null : parseFloat((ghi * inc.cos_incidence).toFixed(1));
    return {
      id: arr.id,
      name: arr.name,
      color: arr.color,
      panel_azimuth_deg: arr.azimuth,
      panel_tilt_deg: Number.isFinite(arr.tilt) ? arr.tilt : DEFAULT_PANEL_TILT_DEG,
      ...inc,
      irradiance_wm2: plane,
    };
  });
}

function isTelegramConfigured() {
  return Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);
}

function telegramStatusPayload() {
  return {
    configured: isTelegramConfigured(),
    enabled: TELEGRAM_REPORT_ENABLED,
    interval_ms: TELEGRAM_REPORT_INTERVAL_MS,
    startup_delay_ms: TELEGRAM_REPORT_STARTUP_DELAY_MS,
    parse_mode: TELEGRAM_PARSE_MODE || 'plain',
    last_send_time: telegramState.last_send_time,
    last_status: telegramState.last_status,
    last_message: telegramState.last_message,
    alerts: {
      enabled: TELEGRAM_ALERTS_ENABLED,
      interval_ms: TELEGRAM_ALERT_INTERVAL_MS,
      thresholds: {
        battery_full_soc: BATTERY_FULL_SOC,
        battery_low_soc: BATTERY_LOW_SOC,
        pv_active_threshold_kw: PV_ACTIVE_THRESHOLD_KW,
        grid_idle_threshold_kw: GRID_IDLE_THRESHOLD_KW,
        data_stale_threshold_ms: DATA_STALE_THRESHOLD_MS,
        collector_failure_threshold: COLLECTOR_FAILURE_THRESHOLD,
      },
      baselined: alertState.baselined,
      current_state: {
        battery_full: alertState.battery_full,
        battery_low: alertState.battery_low,
        pv_active: alertState.pv_active,
        grid_state: alertState.grid_state,
        data_stale: alertState.data_stale,
        collector_failed: alertState.collector_failed,
      },
      last_alert_event: alertState.last_alert_event,
      last_alert_time: alertState.last_alert_time,
      last_alert_message: alertState.last_alert_message,
      last_alert_error: alertState.last_alert_error,
    },
  };
}

function forecastSummary(forecast) {
  if (!forecast.length) return { text: 'ไม่มีข้อมูล forecast', averages: {} };
  const avg = key => forecast.reduce((sum, row) => sum + safeNumber(row[key], 0), 0) / forecast.length;
  const max = key => Math.max(...forecast.map(row => safeNumber(row[key], 0)));
  const source = (forecast[0] && forecast[0].source) || 'unknown';
  const averages = {
    temperature_2m: avg('temperature_2m'),
    precipitation_probability: avg('precipitation_probability'),
    cloud_cover: avg('cloud_cover'),
    shortwave_radiation: avg('shortwave_radiation'),
    direct_radiation: avg('direct_radiation'),
    diffuse_radiation: avg('diffuse_radiation'),
    direct_normal_irradiance: avg('direct_normal_irradiance'),
    wind_speed_10m: avg('wind_speed_10m'),
    max_rain_probability: max('precipitation_probability'),
    max_shortwave_radiation: max('shortwave_radiation'),
    source,
  };
  return {
    averages,
    text: `6h avg ${averages.temperature_2m.toFixed(1)}°C · rain ${averages.precipitation_probability.toFixed(0)}% (max ${averages.max_rain_probability.toFixed(0)}%) · cloud ${averages.cloud_cover.toFixed(0)}% · GHI ${averages.shortwave_radiation.toFixed(0)} W/m² (peak ${averages.max_shortwave_radiation.toFixed(0)}) · ${source}`,
  };
}

function buildRecommendations(latest, forecast) {
  const e = latest.energy || {};
  const d = latest.daily || {};
  const summary = forecastSummary(forecast);
  const avg = summary.averages || {};
  const recs = [];
  const soc = safeNumber(e.battery_soc, null);
  const pv = safeNumber(e.pv_power, 0);
  const load = safeNumber(e.load_power, 0);
  const grid = safeNumber(e.grid_flow_power, 0);
  const battery = safeNumber(e.battery_power, 0);

  if (!e.on_grid || !(e.station_status == 1 || e.station_status == 2)) {
    recs.push('สถานะระบบไม่ปกติ: ตรวจสอบ Sigen / grid / internet monitoring');
  }
  if (avg.max_rain_probability >= 70 || avg.cloud_cover >= 80) {
    recs.push('ฝน/เมฆสูงใน 6 ชม.หน้า: เลี่ยงโหลดหนักและกันแบตไว้ใช้ช่วงแดดอ่อน');
  } else if (avg.shortwave_radiation >= 450 && soc !== null && soc < 90) {
    recs.push('แดดดีและแบตยังไม่เต็ม: เหมาะกับการชาร์จแบตหรือเปิดโหลดที่เลื่อนได้');
  }
  if (soc !== null && soc < 25) recs.push('แบตต่ำกว่า 25%: ลดโหลดที่ไม่จำเป็นจนกว่า PV หรือ grid จะช่วยชาร์จ');
  if (grid < -1.5) recs.push(`กำลัง import grid ${Math.abs(grid).toFixed(1)} kW: พิจารณาลดโหลดทันที`);
  if (grid > 1 && soc !== null && soc < 95) recs.push('มี export เข้า grid แต่แบตยังไม่เต็ม: ตรวจสอบโหมดชาร์จ/ตั้งค่า self-consumption');
  if (pv > load && battery > 0 && Math.abs(grid) <= 0.1) recs.push('ระบบ balance ดี: PV ครอบคลุมโหลดและกำลังชาร์จแบตโดยแทบไม่ใช้ grid');
  if (safeNumber(d.grid_idle_minutes, 0) >= 180) recs.push('วันนี้ลดการพึ่ง grid ได้ดีแล้ว รักษาโหลดช่วงแดดให้ต่อเนื่อง');
  if (!recs.length) recs.push('ระบบทำงานปกติ: ติดตาม SOC และ forecast ต่อเนื่องทุกชั่วโมง');
  return recs.slice(0, 5);
}

function classifyPvOutlook(maxGhi, avgCloud, maxRain, pvNow) {
  if (maxGhi < 80 && pvNow < 0.08) return 'night';
  if (maxGhi >= 550 && avgCloud < 65 && maxRain < 60) return 'high';
  if (maxGhi >= 250 && maxRain < 75) return 'medium';
  if (maxGhi === 0 && avgCloud === 0 && maxRain === 0) return 'no-data';
  return 'low';
}

function findBestForecastWindow(forecast) {
  const rows = forecast
    .filter(row => row && row.time)
    .map(row => ({
      ...row,
      t: new Date(row.time).getTime(),
      ghi: safeNumber(row.shortwave_radiation, 0),
      rain: safeNumber(row.precipitation_probability, 0),
      cloud: safeNumber(row.cloud_cover, 0),
    }))
    .filter(row => Number.isFinite(row.t))
    .sort((a, b) => a.t - b.t);
  if (!rows.length) return { label: '—', score: 0, start: null, end: null };

  let best = null;
  for (let i = 0; i < rows.length; i++) {
    const group = rows.slice(i, Math.min(rows.length, i + 3));
    const score = group.reduce((sum, row) => sum + row.ghi - row.cloud * 2 - row.rain * 3, 0) / group.length;
    if (!best || score > best.score) best = { rows: group, score };
  }
  const start = best.rows[0];
  const end = best.rows[best.rows.length - 1];
  const endTime = new Date(end.t + 60 * 60 * 1000).toISOString();
  return {
    label: `${formatLocalTime(start.time)}–${formatLocalTime(endTime)}`,
    score: best.score,
    start: start.time,
    end: endTime,
  };
}

function buildTodayRecommendation(latest, forecast) {
  const e = latest.energy || {};
  const summary = forecastSummary(forecast);
  const avg = summary.averages || {};
  const soc = safeNumber(e.battery_soc, null);
  const pv = safeNumber(e.pv_power, 0);
  const load = safeNumber(e.load_power, 0);
  const grid = safeNumber(e.grid_flow_power, 0);
  const battery = safeNumber(e.battery_power, 0);
  const ev = safeNumber(e.ev_power, 0);
  const avgCloud = safeNumber(avg.cloud_cover, 0);
  const maxRain = safeNumber(avg.max_rain_probability, 0);
  const maxGhi = safeNumber(avg.max_shortwave_radiation, 0);
  const outlook = classifyPvOutlook(maxGhi, avgCloud, maxRain, pv);
  const bestWindow = findBestForecastWindow(forecast);

  const bulletsTh = [];
  const bulletsEn = [];
  const reasonsTh = [];
  const reasonsEn = [];

  let batteryStrategy = 'normal';
  let dcCharger = 'optional';
  let confidence = forecast.length >= 3 ? 'high' : forecast.length ? 'medium' : 'low';
  let titleTh = 'จัดโหลดตามแดดวันนี้';
  let titleEn = 'Match usage with today’s sun';

  if (outlook === 'high') {
    bulletsTh.push(`ช่วงเหมาะใช้ไฟหนักคือ ${bestWindow.label}`);
    bulletsEn.push(`Best heavy-load window is ${bestWindow.label}`);
    bulletsTh.push('เหมาะกับเครื่องซักผ้า/อบผ้า/โหลดที่เลื่อนได้');
    bulletsEn.push('Good for washing/drying or other flexible loads');
    titleTh = 'แดดดี ใช้ไฟช่วงกลางวันให้คุ้ม';
    titleEn = 'Strong sun: use flexible loads midday';
  } else if (outlook === 'medium') {
    bulletsTh.push(`ใช้โหลดหนักในช่วงแดดดีที่สุด ${bestWindow.label}`);
    bulletsEn.push(`Run heavy loads during the best sun window ${bestWindow.label}`);
    bulletsTh.push('หลีกเลี่ยงเริ่มโหลดใหญ่ช่วงเมฆ/ฝนหนา');
    bulletsEn.push('Avoid starting large loads during cloudy/rainy hours');
  } else if (outlook === 'night') {
    bulletsTh.push('ตอนนี้ไม่มีแดดแล้ว ให้ใช้ Battery อย่างระวัง');
    bulletsEn.push('Solar is off now; use battery carefully');
    bulletsTh.push('เลื่อนโหลดที่ไม่ด่วนไปรอแดดรอบถัดไป');
    bulletsEn.push('Delay non-urgent loads until the next solar window');
    titleTh = 'หลังแดดหมด เน้นรักษา Battery';
    titleEn = 'After solar hours: preserve battery';
  } else {
    bulletsTh.push('แดด/สภาพอากาศไม่ดีนัก ให้ลดโหลดที่เลื่อนได้');
    bulletsEn.push('Weather is weak; reduce shiftable loads');
    bulletsTh.push('เก็บ Battery ไว้สำหรับช่วงเย็นและกลางคืน');
    bulletsEn.push('Keep battery reserve for evening and night');
    titleTh = 'เมฆ/ฝนสูง เน้นประหยัดและสำรอง Battery';
    titleEn = 'Cloud/rain risk: save energy and battery';
  }

  if (soc !== null && soc < 40) {
    batteryStrategy = 'preserve';
    bulletsTh.push(`Battery ${soc.toFixed(0)}%: เลี่ยงโหลดหนักจนกว่า PV จะดีขึ้น`);
    bulletsEn.push(`Battery ${soc.toFixed(0)}%: avoid heavy loads until PV improves`);
  } else if (soc !== null && soc > 85 && (outlook === 'high' || outlook === 'medium')) {
    batteryStrategy = 'use_freely';
    bulletsTh.push(`Battery ${soc.toFixed(0)}% และ forecast ยังพอมีแดด: ใช้โหลดที่จำเป็นได้`);
    bulletsEn.push(`Battery ${soc.toFixed(0)}% with usable forecast: normal flexible usage is OK`);
  } else if (soc !== null && soc < 65 && outlook === 'high') {
    batteryStrategy = 'charge_priority';
  } else if (outlook === 'low' || outlook === 'night') {
    batteryStrategy = 'preserve';
  }

  if ((outlook === 'high' || outlook === 'medium') && soc !== null && soc >= 70 && grid > -1) {
    dcCharger = 'recommended';
    bulletsTh.push('DC Charger ใช้ได้ถ้าต้องการ โดยควรเริ่มในช่วงแดดดีที่สุด');
    bulletsEn.push('DC Charger is OK if needed; start during the best sun window');
  } else if (outlook === 'low' || (soc !== null && soc < 50) || grid < -1) {
    dcCharger = 'avoid';
    bulletsTh.push('หลีกเลี่ยง DC Charger วันนี้ถ้าไม่จำเป็น');
    bulletsEn.push('Avoid DC charging today unless necessary');
  }

  if (grid < -1) {
    bulletsTh.push(`ตอนนี้กำลังซื้อ Grid ${Math.abs(grid).toFixed(1)} kW: ลดโหลดทันทีถ้าเลื่อนได้`);
    bulletsEn.push(`Currently importing ${Math.abs(grid).toFixed(1)} kW from grid: reduce shiftable load now`);
  } else if (grid > 0.5) {
    bulletsTh.push(`มีไฟเหลือส่ง Grid ${grid.toFixed(1)} kW: เหมาะเริ่มโหลดเล็ก/กลางตอนนี้`);
    bulletsEn.push(`Exporting ${grid.toFixed(1)} kW: good time for small/medium flexible loads`);
  }

  reasonsTh.push(`Forecast: เมฆเฉลี่ย ${avgCloud.toFixed(0)}%, โอกาสฝนสูงสุด ${maxRain.toFixed(0)}%, GHI สูงสุด ${maxGhi.toFixed(0)} W/m²`);
  reasonsEn.push(`Forecast: avg cloud ${avgCloud.toFixed(0)}%, max rain chance ${maxRain.toFixed(0)}%, peak GHI ${maxGhi.toFixed(0)} W/m²`);
  reasonsTh.push(`ตอนนี้ PV ${pv.toFixed(2)} kW, Load ${load.toFixed(2)} kW, Grid ${formatGridFlow(grid)}, Battery ${soc === null ? '—' : soc.toFixed(0) + '%'}`);
  reasonsEn.push(`Now PV ${pv.toFixed(2)} kW, load ${load.toFixed(2)} kW, grid ${formatGridFlow(grid)}, battery ${soc === null ? '—' : soc.toFixed(0) + '%'}`);
  if (ev > 0.05) {
    reasonsTh.push(`DC Charger ใช้อยู่ ${ev.toFixed(2)} kW`);
    reasonsEn.push(`DC Charger is currently using ${ev.toFixed(2)} kW`);
  }

  const labels = {
    pv_outlook: outlook,
    battery_strategy: batteryStrategy,
    dc_charger: dcCharger,
    confidence,
  };

  return {
    generated_at: new Date().toISOString(),
    timezone: TIMEZONE,
    title: titleTh,
    title_th: titleTh,
    title_en: titleEn,
    pv_outlook: outlook,
    best_usage_window: bestWindow.label,
    battery_strategy: batteryStrategy,
    dc_charger: dcCharger,
    confidence,
    labels,
    bullets_th: bulletsTh.slice(0, 5),
    bullets_en: bulletsEn.slice(0, 5),
    reasons_th: reasonsTh,
    reasons_en: reasonsEn,
    evidence: {
      soc_pct: soc,
      pv_kw: pv,
      load_kw: load,
      grid_kw: grid,
      battery_kw: battery,
      ev_kw: ev,
      avg_cloud_pct: avgCloud,
      max_rain_pct: maxRain,
      max_ghi_wm2: maxGhi,
      forecast_source: avg.source || 'unknown',
      forecast_points: forecast.length,
    },
  };
}

async function fetchTodayRecommendation() {
  const [latest, forecast] = await Promise.all([fetchLatestSnapshot(), fetchForecastHours()]);
  return buildTodayRecommendation(latest, forecast);
}

async function fetchDailyEnergySourceMix() {
  const fields = ['pv_power', 'grid_flow_power', 'battery_power', 'generator_power', 'ac_power', 'third_pv_power'];
  const fieldFilter = fields.map(f => `r._field == "${f}"`).join(' or ');
  const flux = `
import "timezone"
import "date"
option location = timezone.location(name: "${TIMEZONE}")

from(bucket: "${INFLUXDB_BUCKET}")
  |> range(start: date.truncate(t: now(), unit: 1d))
  |> filter(fn: (r) => r._measurement == "energy_metrics" and r.station_id == "${STATION_ID}")
  |> filter(fn: (r) => ${fieldFilter})
  |> aggregateWindow(every: 1m, fn: mean, createEmpty: false)
  |> keep(columns: ["_time", "_field", "_value"])
`;
  const csv = await queryInflux(flux);
  const rows = parseCsv(csv);

  const byField = {};
  let startTime = null;
  let endTime = null;
  rows.forEach(r => {
    if (!r._field || !r._time) return;
    const v = toNumber(r._value);
    if (v === null) return;
    if (!byField[r._field]) byField[r._field] = [];
    byField[r._field].push({ time: new Date(r._time).getTime(), value: v });
    if (!startTime || r._time < startTime) startTime = r._time;
    if (!endTime || r._time > endTime) endTime = r._time;
  });

  for (const f of Object.keys(byField)) {
    byField[f].sort((a, b) => a.time - b.time);
  }

  const MAX_INTERVAL_H = 5 / 60;

  function integrateKwh(samples, filterFn) {
    let total = 0;
    for (let i = 1; i < samples.length; i++) {
      const dtH = Math.min((samples[i].time - samples[i - 1].time) / 3600000, MAX_INTERVAL_H);
      if (dtH <= 0) continue;
      const v1 = filterFn(samples[i - 1].value);
      const v2 = filterFn(samples[i].value);
      total += dtH * (v1 + v2) / 2;
    }
    return Math.max(0, total);
  }

  const pvKwh = integrateKwh(byField.pv_power || [], v => Math.max(0, v));
  const gridImportKwh = integrateKwh(byField.grid_flow_power || [], v => Math.max(0, -v));
  const batteryDischargeKwh = integrateKwh(byField.battery_power || [], v => Math.max(0, -v));
  const generatorKwh = byField.generator_power
    ? integrateKwh(byField.generator_power, v => Math.max(0, v))
    : null;
  const acKwh = byField.ac_power
    ? integrateKwh(byField.ac_power, v => Math.max(0, v))
    : null;
  const thirdPvKwh = byField.third_pv_power
    ? integrateKwh(byField.third_pv_power, v => Math.max(0, v))
    : null;

  const sources = {
    pv_solar: parseFloat(pvKwh.toFixed(3)),
    grid_import: parseFloat(gridImportKwh.toFixed(3)),
    battery_discharge: parseFloat(batteryDischargeKwh.toFixed(3)),
  };
  if (generatorKwh !== null) sources.generator = parseFloat(generatorKwh.toFixed(3));
  const acTotal = (acKwh || 0) + (thirdPvKwh || 0);
  if (acKwh !== null || thirdPvKwh !== null) sources.ac_third_pv = parseFloat(acTotal.toFixed(3));

  return {
    period: 'today_so_far',
    unit: 'kWh',
    start_time: startTime,
    end_time: endTime,
    sample_count: rows.length,
    sources,
  };
}

async function fetchEnergySourceMixForDate(dateKey) {
  const tz = TIMEZONE;
  const todayKey = new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const { startIso, endIso } = localDayUtcBounds(dateKey, tz);
  const fields = ['pv_power', 'grid_flow_power', 'battery_power', 'generator_power', 'ac_power', 'third_pv_power'];
  const fieldFilter = fields.map(f => `r._field == "${f}"`).join(' or ');
  const flux = `
from(bucket: "${INFLUXDB_BUCKET}")
  |> range(start: ${startIso}, stop: ${endIso})
  |> filter(fn: (r) => r._measurement == "energy_metrics" and r.station_id == "${STATION_ID}")
  |> filter(fn: (r) => ${fieldFilter})
  |> aggregateWindow(every: 1m, fn: mean, createEmpty: false)
  |> keep(columns: ["_time", "_field", "_value"])
`;
  const csv = await queryInflux(flux);
  const rows = parseCsv(csv);

  const byField = {};
  let startTime = null, endTime = null;
  rows.forEach(r => {
    if (!r._field || !r._time) return;
    const v = toNumber(r._value);
    if (v === null) return;
    if (!byField[r._field]) byField[r._field] = [];
    byField[r._field].push({ time: new Date(r._time).getTime(), value: v });
    if (!startTime || r._time < startTime) startTime = r._time;
    if (!endTime || r._time > endTime) endTime = r._time;
  });
  for (const f of Object.keys(byField)) byField[f].sort((a, b) => a.time - b.time);

  const MAX_INTERVAL_H = 5 / 60;
  function integrateKwh(samples, filterFn) {
    let total = 0;
    for (let i = 1; i < samples.length; i++) {
      const dtH = Math.min((samples[i].time - samples[i - 1].time) / 3600000, MAX_INTERVAL_H);
      if (dtH <= 0) continue;
      total += dtH * (filterFn(samples[i - 1].value) + filterFn(samples[i].value)) / 2;
    }
    return Math.max(0, total);
  }

  const pvKwh = integrateKwh(byField.pv_power || [], v => Math.max(0, v));
  const gridImportKwh = integrateKwh(byField.grid_flow_power || [], v => Math.max(0, -v));
  const batteryDischargeKwh = integrateKwh(byField.battery_power || [], v => Math.max(0, -v));
  const generatorKwh = byField.generator_power ? integrateKwh(byField.generator_power, v => Math.max(0, v)) : null;
  const acKwh = byField.ac_power ? integrateKwh(byField.ac_power, v => Math.max(0, v)) : null;
  const thirdPvKwh = byField.third_pv_power ? integrateKwh(byField.third_pv_power, v => Math.max(0, v)) : null;

  const sources = {
    pv_solar: parseFloat(pvKwh.toFixed(3)),
    grid_import: parseFloat(gridImportKwh.toFixed(3)),
    battery_discharge: parseFloat(batteryDischargeKwh.toFixed(3)),
  };
  if (generatorKwh !== null) sources.generator = parseFloat(generatorKwh.toFixed(3));
  const acTotal = (acKwh || 0) + (thirdPvKwh || 0);
  if (acKwh !== null || thirdPvKwh !== null) sources.ac_third_pv = parseFloat(acTotal.toFixed(3));

  return {
    period: dateKey === todayKey ? 'today_so_far' : 'full_day',
    unit: 'kWh',
    date: dateKey,
    start_time: startTime,
    end_time: endTime,
    sample_count: rows.length,
    sources,
  };
}

async function fetchLatestSnapshot() {
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
  const gridIdleFlux = `
import "timezone"
import "date"
option location = timezone.location(name: "${TIMEZONE}")

from(bucket: "${INFLUXDB_BUCKET}")
  |> range(start: date.truncate(t: now(), unit: 1d))
  |> filter(fn: (r) => r._measurement == "energy_metrics" and r.station_id == "${STATION_ID}")
  |> filter(fn: (r) => r._field == "grid_flow_power")
  |> keep(columns: ["_time", "_value"])
`;
  const pvStringFlux = `
from(bucket: "${INFLUXDB_BUCKET}")
  |> range(start: -15m)
  |> filter(fn: (r) => r._measurement == "pv_string_metrics" and r.station_id == "${STATION_ID}")
  |> last()
  |> keep(columns: ["_field", "_value", "_time", "device_sn", "source"])
`;
  const batteryModuleFlux = `
from(bucket: "${INFLUXDB_BUCKET}")
  |> range(start: -30m)
  |> filter(fn: (r) => r._measurement == "battery_module_metrics" and r.station_id == "${STATION_ID}")
  |> group(columns: ["battery_index", "device_sn", "source", "_field"])
  |> last()
  |> keep(columns: ["_field", "_value", "_time", "battery_index", "device_sn", "source"])
`;

  const [energyCsv, weatherCsv, dailyCsv, gridIdleCsv, energySourceMix, pvStringCsv, batteryModuleCsv] = await Promise.all([
    queryInflux(energyFlux).catch(() => ''),
    queryInflux(weatherFlux).catch(() => ''),
    queryInflux(dailyFlux).catch(() => ''),
    queryInflux(gridIdleFlux).catch(() => ''),
    fetchDailyEnergySourceMix().catch(() => null),
    queryInflux(pvStringFlux).catch(() => ''),
    queryInflux(batteryModuleFlux).catch(() => ''),
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

  const gridIdleRows = parseCsv(gridIdleCsv);
  const totalSamples = gridIdleRows.length;
  const MAX_GAP_MS = 300_000; // cap 5 min per interval so outages don't fabricate idle time
  const nowMs = Date.now();
  const timedRows = gridIdleRows
    .map(r => ({ t: new Date(r._time).getTime(), v: toNumber(r._value) }))
    .filter(r => isFinite(r.t) && r.v !== null)
    .sort((a, b) => a.t - b.t);
  let idleMs = 0;
  for (let i = 0; i < timedRows.length; i++) {
    const { t, v } = timedRows[i];
    const nextT = i + 1 < timedRows.length ? timedRows[i + 1].t : nowMs;
    const intervalMs = nextT - t;
    if (!isFinite(intervalMs) || intervalMs <= 0) continue;
    if (Math.abs(v) <= GRID_IDLE_THRESHOLD_KW) {
      idleMs += Math.min(intervalMs, MAX_GAP_MS);
    }
  }
  let gridIdleMinutes;
  if (totalSamples > 0) {
    gridIdleMinutes = Math.min(idleMs / 60000, 1440);
  } else {
    const currentGrid = toNumber(energy.grid_flow_power);
    gridIdleMinutes = (currentGrid !== null && Math.abs(currentGrid) <= GRID_IDLE_THRESHOLD_KW) ? SLEEP_INTERVAL_S / 60 : 0;
  }
  daily.grid_idle_minutes = parseFloat(gridIdleMinutes.toFixed(2));
  daily.grid_idle_hours = parseFloat((gridIdleMinutes / 60).toFixed(4));
  daily.grid_idle_sample_count = totalSamples;
  daily.grid_idle_window = 'today';
  daily.grid_idle_threshold_kw = GRID_IDLE_THRESHOLD_KW;
  if (energySourceMix) {
    daily.energy_sources_today = energySourceMix;
    const gridImportKwhToday = parseFloat(((energySourceMix.sources && energySourceMix.sources.grid_import) || 0).toFixed(3));
    daily.grid_import_kwh_today = gridImportKwhToday;
    daily.grid_cost_thb_today = parseFloat((gridImportKwhToday * GRID_COST_RATE_THB_PER_KWH).toFixed(2));
    daily.grid_cost_rate_thb_per_kwh = GRID_COST_RATE_THB_PER_KWH;
  }

  const pvStrings = { timestamp: null, device_sn: null, source: null };
  parseCsv(pvStringCsv).forEach(r => {
    const v = toNumber(r._value);
    if (v !== null && r._field) pvStrings[r._field] = v;
    if (!pvStrings.timestamp && r._time) pvStrings.timestamp = r._time;
    if (!pvStrings.device_sn && r.device_sn) pvStrings.device_sn = r.device_sn;
    if (!pvStrings.source && r.source) pvStrings.source = r.source;
  });
  const pvStringTotal = toNumber(pvStrings.pv_total_power);
  if (pvStringTotal !== null) energy.pv_string_total_power = pvStringTotal;

  const batteryModuleMap = new Map();
  parseCsv(batteryModuleCsv).forEach(r => {
    const key = r.battery_index || r.device_sn || `battery-${batteryModuleMap.size + 1}`;
    if (!batteryModuleMap.has(key)) {
      batteryModuleMap.set(key, {
        battery_index: r.battery_index || String(batteryModuleMap.size + 1),
        device_sn: r.device_sn || null,
        source: r.source || null,
        timestamp: r._time || null,
      });
    }
    const module = batteryModuleMap.get(key);
    const v = toNumber(r._value);
    if (r._field && v !== null) module[r._field] = v;
    if (!module.timestamp && r._time) module.timestamp = r._time;
    if (!module.device_sn && r.device_sn) module.device_sn = r.device_sn;
    if (!module.source && r.source) module.source = r.source;
  });
  const batteryModules = [...batteryModuleMap.values()]
    .sort((a, b) => (parseInt(a.battery_index, 10) || 0) - (parseInt(b.battery_index, 10) || 0));

  return {
    timestamp: lastTime,
    energy,
    weather,
    daily,
    battery: {
      total_capacity_kwh: Number.isFinite(BATTERY_TOTAL_CAPACITY_KWH) ? BATTERY_TOTAL_CAPACITY_KWH : 18.08,
      telemetry_scope: batteryModules.length ? 'module_pack_info' : 'aggregate',
      modules: batteryModules,
    },
    battery_modules: batteryModules,
    pv_strings: pvStrings,
  };
}

async function fetchOpenMeteoForecast() {
  if (!WEATHER_LATITUDE || !WEATHER_LONGITUDE) return null;

  const hourlyVars = [
    'temperature_2m', 'precipitation_probability', 'cloud_cover',
    'weather_code', 'wind_speed_10m', 'shortwave_radiation',
    'direct_radiation', 'diffuse_radiation', 'direct_normal_irradiance', 'is_day',
  ].join(',');

  const currentVars = [
    'temperature_2m', 'weather_code', 'wind_speed_10m', 'wind_direction_10m',
    'is_day', 'shortwave_radiation', 'direct_radiation', 'diffuse_radiation',
    'direct_normal_irradiance',
  ].join(',');

  const baseUrl = OPEN_METEO_API_KEY
    ? 'https://customer-api.open-meteo.com/v1/forecast'
    : 'https://api.open-meteo.com/v1/forecast';

  const buildParams = (withCurrent) => {
    const p = new URLSearchParams({
      latitude: WEATHER_LATITUDE,
      longitude: WEATHER_LONGITUDE,
      hourly: hourlyVars,
      timezone: WEATHER_TIMEZONE,
      forecast_days: '2',
    });
    if (withCurrent) p.set('current', currentVars);
    if (OPEN_METEO_API_KEY) p.set('apikey', OPEN_METEO_API_KEY);
    return p;
  };

  let data;
  const res = await fetch(`${baseUrl}?${buildParams(true)}`);
  if (res.ok) {
    data = await res.json();
  } else {
    const res2 = await fetch(`${baseUrl}?${buildParams(false)}`);
    if (!res2.ok) {
      const text = await res2.text();
      throw new Error(`Open-Meteo ${res2.status}: ${text.slice(0, 200)}`);
    }
    data = await res2.json();
  }

  const utcOffsetSec = typeof data.utc_offset_seconds === 'number' ? data.utc_offset_seconds : 0;
  const localToIso = (localStr) =>
    new Date(new Date(localStr + 'Z').getTime() - utcOffsetSec * 1000).toISOString();

  const hourly = data.hourly || {};
  const times = hourly.time || [];
  const now = Date.now();
  const rows = [];
  for (let i = 0; i < times.length && rows.length < 6; i++) {
    const utcIso = localToIso(times[i]);
    if (new Date(utcIso).getTime() < now - 30 * 60 * 1000) continue;
    rows.push({
      time: utcIso,
      temperature_2m: toNumber(hourly.temperature_2m && hourly.temperature_2m[i]),
      precipitation_probability: toNumber(hourly.precipitation_probability && hourly.precipitation_probability[i]),
      cloud_cover: toNumber(hourly.cloud_cover && hourly.cloud_cover[i]),
      weather_code: toNumber(hourly.weather_code && hourly.weather_code[i]),
      wind_speed_10m: toNumber(hourly.wind_speed_10m && hourly.wind_speed_10m[i]),
      shortwave_radiation: toNumber(hourly.shortwave_radiation && hourly.shortwave_radiation[i]),
      direct_radiation: toNumber(hourly.direct_radiation && hourly.direct_radiation[i]),
      diffuse_radiation: toNumber(hourly.diffuse_radiation && hourly.diffuse_radiation[i]),
      direct_normal_irradiance: toNumber(hourly.direct_normal_irradiance && hourly.direct_normal_irradiance[i]),
      is_day: toNumber(hourly.is_day && hourly.is_day[i]),
      source: 'open-meteo',
    });
  }
  return rows;
}

async function fetchForecastHours() {
  // Prefer direct Open-Meteo; fall back to InfluxDB on error or missing coords
  try {
    const rows = await fetchOpenMeteoForecast();
    if (rows && rows.length > 0) return rows;
  } catch (err) {
    console.warn(`Open-Meteo forecast fetch failed, falling back to InfluxDB: ${err.message}`);
  }

  const flux = `
from(bucket: "${INFLUXDB_BUCKET}")
  |> range(start: -1h, stop: 7h)
  |> filter(fn: (r) => r._measurement == "weather_forecast_hourly" and r.station_id == "${STATION_ID}")
  |> filter(fn: (r) => r._field == "temperature_2m" or r._field == "precipitation_probability" or r._field == "cloud_cover" or r._field == "shortwave_radiation" or r._field == "direct_radiation" or r._field == "weather_code" or r._field == "wind_speed_10m")
  |> keep(columns: ["_time", "_field", "_value"])
`;
  const csv = await queryInflux(flux).catch(() => '');
  const byTime = new Map();
  parseCsv(csv).forEach(r => {
    if (!r._time) return;
    if (!byTime.has(r._time)) byTime.set(r._time, { time: r._time, source: 'influxdb' });
    byTime.get(r._time)[r._field] = toNumber(r._value) !== null ? toNumber(r._value) : r._value;
  });
  return Array.from(byTime.values())
    .sort((a, b) => new Date(a.time) - new Date(b.time))
    .filter(row => new Date(row.time).getTime() >= Date.now() - 60 * 60 * 1000)
    .slice(0, 6);
}

function utcYmd(date) {
  return date.toISOString().slice(0, 10);
}

function yyyymmdd(date) {
  return utcYmd(date).replace(/-/g, '');
}

function addUtcDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function mean(values) {
  const valid = values.filter(v => Number.isFinite(v));
  return valid.length ? valid.reduce((sum, v) => sum + v, 0) / valid.length : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function dateKeyForTimezone(iso, timezoneName) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezoneName,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso));
}

function aggregateHourlyWm2ToDailyKwh(hourlyTimes, hourlyIrradiance, timezoneName) {
  const daily = {};
  for (let i = 0; i < hourlyTimes.length; i++) {
    const v = toNumber(hourlyIrradiance && hourlyIrradiance[i]);
    if (v === null || v < 0) continue;
    const date = dateKeyForTimezone(new Date(hourlyTimes[i]).toISOString(), timezoneName);
    daily[date] = (daily[date] || 0) + v / 1000;
  }
  return daily;
}

async function fetchSolarHybridInsight() {
  const lat = WEATHER_LATITUDE || String(SITE_LATITUDE);
  const lon = WEATHER_LONGITUDE || String(SITE_LONGITUDE);
  const tz = WEATHER_TIMEZONE || SITE_TIMEZONE || TIMEZONE;
  const lookbackDays = 7;
  const baseUrl = OPEN_METEO_API_KEY
    ? 'https://customer-api.open-meteo.com/v1/forecast'
    : 'https://api.open-meteo.com/v1/forecast';
  const omParams = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    timezone: tz,
    past_days: String(lookbackDays),
    forecast_days: '2',
    current: 'temperature_2m,cloud_cover,weather_code,is_day,shortwave_radiation',
    hourly: 'temperature_2m,cloud_cover,weather_code,is_day,shortwave_radiation',
  });
  if (OPEN_METEO_API_KEY) omParams.set('apikey', OPEN_METEO_API_KEY);

  const today = new Date();
  const nasaEnd = addUtcDays(today, -1);
  const nasaStart = addUtcDays(nasaEnd, -(lookbackDays - 1));
  const nasaParams = new URLSearchParams({
    parameters: 'ALLSKY_SFC_SW_DWN',
    community: 'RE',
    longitude: lon,
    latitude: lat,
    start: yyyymmdd(nasaStart),
    end: yyyymmdd(nasaEnd),
    format: 'JSON',
  });

  const [omRes, nasaRes] = await Promise.all([
    fetch(`${baseUrl}?${omParams}`),
    fetch(`https://power.larc.nasa.gov/api/temporal/daily/point?${nasaParams}`),
  ]);
  if (!omRes.ok) throw new Error(`Open-Meteo ${omRes.status}: ${(await omRes.text()).slice(0, 160)}`);
  if (!nasaRes.ok) throw new Error(`NASA POWER ${nasaRes.status}: ${(await nasaRes.text()).slice(0, 160)}`);

  const openMeteo = await omRes.json();
  const nasa = await nasaRes.json();
  const hourly = openMeteo.hourly || {};
  const times = hourly.time || [];
  const offsetSec = typeof openMeteo.utc_offset_seconds === 'number' ? openMeteo.utc_offset_seconds : 0;
  const localToIso = localStr => new Date(new Date(localStr + 'Z').getTime() - offsetSec * 1000).toISOString();
  const isoTimes = times.map(localToIso);
  const omDaily = aggregateHourlyWm2ToDailyKwh(isoTimes, hourly.shortwave_radiation || [], tz);

  const nasaRaw = (nasa.properties && nasa.properties.parameter && nasa.properties.parameter.ALLSKY_SFC_SW_DWN) || {};
  const nasaDaily = {};
  Object.entries(nasaRaw).forEach(([dateRaw, value]) => {
    const date = `${dateRaw.slice(0, 4)}-${dateRaw.slice(4, 6)}-${dateRaw.slice(6, 8)}`;
    const v = toNumber(value);
    nasaDaily[date] = v !== null && v > -900 ? v : null;
  });

  const commonDates = Object.keys(nasaDaily).sort().filter(d => Number.isFinite(nasaDaily[d]) && Number.isFinite(omDaily[d]) && omDaily[d] > 0);
  const nasaAvg = mean(commonDates.map(d => nasaDaily[d]));
  const omAvg = mean(commonDates.map(d => omDaily[d]));
  const rawFactor = nasaAvg !== null && omAvg !== null && omAvg > 0 ? nasaAvg / omAvg : 1;
  const factor = clamp(rawFactor, 0.6, 1.4);
  const currentOriginal = toNumber(openMeteo.current && openMeteo.current.shortwave_radiation);
  const currentCorrected = currentOriginal === null ? null : parseFloat((currentOriginal * factor).toFixed(1));
  const currentIso = openMeteo.current && openMeteo.current.time ? localToIso(openMeteo.current.time) : new Date().toISOString();
  const currentSunPos = SunCalc.getPosition(new Date(currentIso), parseFloat(lat), parseFloat(lon));
  const currentSunAz = sunCalcAzToNorth(currentSunPos.azimuth);
  const currentPanelIrradiance = panelIrradianceFromGhi(currentCorrected, currentSunAz, currentSunPos.altitude);
  const now = Date.now();
  const nextHours = [];
  for (let i = 0; i < isoTimes.length && nextHours.length < 12; i++) {
    const t = new Date(isoTimes[i]).getTime();
    if (t < now - 30 * 60 * 1000) continue;
    const original = toNumber(hourly.shortwave_radiation && hourly.shortwave_radiation[i]);
    const corrected = original === null ? null : parseFloat((original * factor).toFixed(1));
    const sunPos = SunCalc.getPosition(new Date(isoTimes[i]), parseFloat(lat), parseFloat(lon));
    const sunAz = sunCalcAzToNorth(sunPos.azimuth);
    nextHours.push({
      time: isoTimes[i],
      open_meteo_wm2: original,
      corrected_wm2: corrected,
      sun_azimuth_deg: parseFloat(sunAz.toFixed(1)),
      sun_altitude_deg: parseFloat((sunPos.altitude * 180 / Math.PI).toFixed(1)),
      panel_irradiance: panelIrradianceFromGhi(corrected, sunAz, sunPos.altitude),
      cloud_cover: toNumber(hourly.cloud_cover && hourly.cloud_cover[i]),
    });
  }

  const analysisHours = [];
  const todayLocalKey = dateKeyForTimezone(new Date().toISOString(), tz);
  for (let i = 0; i < isoTimes.length; i++) {
    if (dateKeyForTimezone(isoTimes[i], tz) !== todayLocalKey) continue;
    const localHour = parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(new Date(isoTimes[i])), 10);
    if (localHour < 5 || localHour > 19) continue;
    const original = toNumber(hourly.shortwave_radiation && hourly.shortwave_radiation[i]);
    const corrected = original === null ? null : parseFloat((original * factor).toFixed(1));
    const sunPos = SunCalc.getPosition(new Date(isoTimes[i]), parseFloat(lat), parseFloat(lon));
    const sunAz = sunCalcAzToNorth(sunPos.azimuth);
    analysisHours.push({
      time: isoTimes[i],
      open_meteo_wm2: original,
      corrected_wm2: corrected,
      sun_azimuth_deg: parseFloat(sunAz.toFixed(1)),
      sun_altitude_deg: parseFloat((sunPos.altitude * 180 / Math.PI).toFixed(1)),
      panel_irradiance: panelIrradianceFromGhi(corrected, sunAz, sunPos.altitude),
      cloud_cover: toNumber(hourly.cloud_cover && hourly.cloud_cover[i]),
    });
  }

  const timeShiftAnalysis = (() => {
    const sourceRows = analysisHours.length ? analysisHours : nextHours;
    const profile = sourceRows.map(row => {
      const panels = Array.isArray(row.panel_irradiance) ? row.panel_irradiance : [];
      const values = panels.map(p => toNumber(p.irradiance_wm2)).filter(v => v !== null);
      const avg = values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
      const bestPanel = panels.reduce((best, p) => {
        const value = toNumber(p.irradiance_wm2);
        if (value === null || value <= 0) return best;
        if (!best || value > best.irradiance_wm2) {
          return {
            id: p.id,
            name: p.name,
            color: p.color,
            irradiance_wm2: value,
            cos_incidence: p.cos_incidence,
            incidence_angle_deg: p.incidence_angle_deg,
          };
        }
        return best;
      }, null);
      return {
        time: row.time,
        sun_azimuth_deg: row.sun_azimuth_deg,
        sun_altitude_deg: row.sun_altitude_deg,
        best_aligned_pv: bestPanel,
        average_wm2: avg === null ? null : parseFloat(avg.toFixed(1)),
        pv: panels.reduce((acc, p) => {
          acc[p.id] = p.irradiance_wm2;
          return acc;
        }, {}),
        pv_cos: panels.reduce((acc, p) => {
          acc[p.id] = p.cos_incidence == null ? null : parseFloat((p.cos_incidence * 100).toFixed(1));
          return acc;
        }, {}),
      };
    });

    const peaks = PV_ARRAYS.map(arr => {
      let best = null;
      for (const row of sourceRows) {
        const p = Array.isArray(row.panel_irradiance) ? row.panel_irradiance.find(x => x.id === arr.id) : null;
        const value = p ? toNumber(p.irradiance_wm2) : null;
        if (value === null) continue;
        if (!best || value > best.irradiance_wm2) best = {
          time: row.time,
          irradiance_wm2: value,
          sun_azimuth_deg: row.sun_azimuth_deg,
          sun_altitude_deg: row.sun_altitude_deg,
        };
      }
      return {
        id: arr.id,
        name: arr.name,
        azimuth_deg: arr.azimuth,
        color: arr.color,
        peak_time: best ? best.time : null,
        peak_irradiance_wm2: best ? best.irradiance_wm2 : null,
        peak_sun_azimuth_deg: best ? best.sun_azimuth_deg : null,
        peak_sun_altitude_deg: best ? best.sun_altitude_deg : null,
      };
    });

    const avgPeak = profile.reduce((best, row) => {
      const value = toNumber(row.average_wm2);
      if (value === null) return best;
      if (!best || value > best.average_wm2) return { time: row.time, average_wm2: value };
      return best;
    }, null);

    const peakText = id => {
      const p = peaks.find(x => x.id === id);
      return p && p.peak_time ? new Date(p.peak_time).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }) : '—';
    };

    return {
      basis: 'today 05:00-19:00 local cosine-corrected irradiance potential, not actual per-string kW',
      source: analysisHours.length ? 'open-meteo today hourly + NASA bias + SunCalc cosine correction' : 'next forecast hours fallback',
      profile,
      peaks,
      average_peak: avgPeak,
      insight: `PV2 ฝั่งตะวันออก/NE ควร peak เร็วกว่าช่วงบ่าย (${peakText('pv2')}); PV3/PV4 ฝั่งตะวันตกควรเลื่อนไปบ่าย-เย็น (${peakText('pv3')} / ${peakText('pv4')}). ค่าเฉลี่ยทั้ง 4 ทิศคือ profile รวมโดยประมาณของบ้านจากมุมรับแสง`,
    };
  })();

  return {
    generated_at: new Date().toISOString(),
    location: { latitude: parseFloat(lat), longitude: parseFloat(lon), timezone: tz },
    sources: {
      current_forecast: 'open-meteo',
      historical_baseline: 'nasa-power:ALLSKY_SFC_SW_DWN',
    },
    units: { open_meteo: 'W/m²', nasa_daily: 'kWh/m²/day', panel_irradiance: 'W/m²' },
    cosine_correction: {
      enabled: true,
      formula: 'panel_irradiance = corrected_GHI * max(0, cos(theta)); cos(theta)=sin(alt)*cos(tilt)+cos(alt)*sin(tilt)*cos(sunAz-panelAz)',
      default_panel_tilt_deg: DEFAULT_PANEL_TILT_DEG,
      note: 'Tilt can be overridden per PV array through PV_ARRAYS_JSON; current default is used for all arrays unless configured.',
    },
    bias_correction: {
      enabled: nasaAvg !== null && omAvg !== null && omAvg > 0,
      method: 'nasa_7d_mean_factor',
      lookback_days: lookbackDays,
      matched_days: commonDates.length,
      nasa_avg_kwh_m2_day: nasaAvg === null ? null : parseFloat(nasaAvg.toFixed(3)),
      open_meteo_avg_kwh_m2_day: omAvg === null ? null : parseFloat(omAvg.toFixed(3)),
      raw_factor: parseFloat(rawFactor.toFixed(4)),
      factor: parseFloat(factor.toFixed(4)),
      factor_clamped: Math.abs(rawFactor - factor) > 0.0001,
    },
    current: {
      timestamp: currentIso,
      open_meteo_wm2: currentOriginal,
      corrected_wm2: currentCorrected,
      sun_azimuth_deg: parseFloat(currentSunAz.toFixed(1)),
      sun_altitude_deg: parseFloat((currentSunPos.altitude * 180 / Math.PI).toFixed(1)),
      panel_irradiance: currentPanelIrradiance,
      cloud_cover: toNumber(openMeteo.current && openMeteo.current.cloud_cover),
      temperature_c: toNumber(openMeteo.current && openMeteo.current.temperature_2m),
      is_day: openMeteo.current && openMeteo.current.is_day === 1,
    },
    daily_baseline: commonDates.map(date => ({
      date,
      nasa_kwh_m2_day: nasaDaily[date],
      open_meteo_kwh_m2_day: parseFloat(omDaily[date].toFixed(3)),
    })),
    forecast_hours: nextHours,
    time_shift_analysis: timeShiftAnalysis,
    insight: currentCorrected === null
      ? 'ยังไม่มีค่า irradiance ปัจจุบันจาก Open-Meteo'
      : (() => {
          const bestPanel = currentPanelIrradiance.slice().sort((a, b) => (b.irradiance_wm2 || 0) - (a.irradiance_wm2 || 0))[0];
          const bestText = bestPanel ? ` หลังทำ Cosine Correction แผงที่รับแสงบนระนาบแผงสูงสุดคือ ${bestPanel.name} ≈ ${bestPanel.irradiance_wm2} W/m² (cosθ=${bestPanel.cos_incidence}).` : '';
          return `Open-Meteo ปัจจุบัน ${currentOriginal} W/m² ถูกปรับด้วย NASA 7-day factor ×${factor.toFixed(2)} เป็น ${currentCorrected} W/m².${bestText}`;
        })(),
  };
}

async function fetchWeatherVsActual(dateKey) {
  const tz = WEATHER_TIMEZONE;
  const todayKey = new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const isPast = dateKey < todayKey;
  const { startIso, endIso } = localDayUtcBounds(dateKey, tz);

  const fetchWxForecast = async () => {
    if (isPast || !WEATHER_LATITUDE || !WEATHER_LONGITUDE) return null;
    const baseUrl = OPEN_METEO_API_KEY
      ? 'https://customer-api.open-meteo.com/v1/forecast'
      : 'https://api.open-meteo.com/v1/forecast';
    const params = new URLSearchParams({
      latitude: WEATHER_LATITUDE,
      longitude: WEATHER_LONGITUDE,
      hourly: 'cloud_cover,shortwave_radiation',
      timezone: WEATHER_TIMEZONE,
      forecast_days: '2',
    });
    if (OPEN_METEO_API_KEY) params.set('apikey', OPEN_METEO_API_KEY);
    const res = await fetch(`${baseUrl}?${params}`);
    if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
    const data = await res.json();
    const utcOffsetSec = typeof data.utc_offset_seconds === 'number' ? data.utc_offset_seconds : 0;
    const localToIso = (localStr) =>
      new Date(new Date(localStr + 'Z').getTime() - utcOffsetSec * 1000).toISOString();
    const hourly = data.hourly || {};
    const times = hourly.time || [];
    return times
      .map((t, i) => ({
        time: localToIso(t),
        cloud_cover: toNumber(hourly.cloud_cover && hourly.cloud_cover[i]),
        shortwave_radiation: toNumber(hourly.shortwave_radiation && hourly.shortwave_radiation[i]),
        source: 'open-meteo',
      }))
      .filter(fc => localDateKey(fc.time) === dateKey);
  };

  const pvFlux = `
from(bucket: "${INFLUXDB_BUCKET}")
  |> range(start: ${startIso}, stop: ${endIso})
  |> filter(fn: (r) => r._measurement == "energy_metrics" and r.station_id == "${STATION_ID}")
  |> filter(fn: (r) => r._field == "pv_power")
  |> aggregateWindow(every: 1h, fn: mean, createEmpty: false, timeSrc: "_start")
  |> keep(columns: ["_time", "_value"])
`;

  const pvStringFlux = `
from(bucket: "${INFLUXDB_BUCKET}")
  |> range(start: ${startIso}, stop: ${endIso})
  |> filter(fn: (r) => r._measurement == "pv_string_metrics" and r.station_id == "${STATION_ID}")
  |> filter(fn: (r) => r._field == "pv1_power" or r._field == "pv2_power" or r._field == "pv3_power" or r._field == "pv4_power" or r._field == "pv_total_power")
  |> aggregateWindow(every: 1h, fn: mean, createEmpty: false, timeSrc: "_start")
  |> keep(columns: ["_time", "_field", "_value"])
`;

  const storedWxFlux = `
from(bucket: "${INFLUXDB_BUCKET}")
  |> range(start: ${startIso}, stop: ${endIso})
  |> filter(fn: (r) => r._measurement == "weather_forecast_hourly" and r.station_id == "${STATION_ID}")
  |> filter(fn: (r) => r._field == "cloud_cover" or r._field == "shortwave_radiation")
  |> aggregateWindow(every: 1h, fn: mean, createEmpty: false, timeSrc: "_start")
  |> keep(columns: ["_time", "_field", "_value"])
`;

  const solarEventsFlux = `
from(bucket: "${INFLUXDB_BUCKET}")
  |> range(start: ${startIso}, stop: ${endIso})
  |> filter(fn: (r) => r._measurement == "solar_events" and r.station_id == "${STATION_ID}")
  |> keep(columns: ["_time", "event_type", "date_local", "_value"])
`;

  const [pvCsv, pvStringCsv, wxResult, solarEventsCsv, storedWxCsv] = await Promise.all([
    queryInflux(pvFlux).catch(() => ''),
    queryInflux(pvStringFlux).catch(() => ''),
    fetchWxForecast().catch(() => null),
    queryInflux(solarEventsFlux).catch(() => ''),
    isPast ? queryInflux(storedWxFlux).catch(() => '') : Promise.resolve(''),
  ]);

  let wxRows, wxSource;
  if (!isPast && wxResult && wxResult.length > 0) {
    wxRows = wxResult;
    wxSource = 'open-meteo';
  } else if (isPast) {
    const byHour = new Map();
    parseCsv(storedWxCsv).forEach(r => {
      if (!r._time || !r._field) return;
      const hourKey = truncToHour(r._time);
      if (!byHour.has(hourKey)) byHour.set(hourKey, { time: hourKey, cloud_cover: null, shortwave_radiation: null, source: 'stored' });
      const v = toNumber(r._value);
      if (v !== null) byHour.get(hourKey)[r._field] = v;
    });
    wxRows = Array.from(byHour.values()).sort((a, b) => a.time.localeCompare(b.time));
    wxSource = wxRows.length ? 'stored' : 'none';
  } else {
    wxRows = await fetchForecastHours().catch(() => []);
    wxSource = 'fallback';
  }

  const rowMap = new Map();

  parseCsv(pvCsv).forEach(r => {
    if (!r._time) return;
    const v = toNumber(r._value);
    if (v === null) return;
    const hourKey = truncToHour(r._time);
    rowMap.set(hourKey, { time: hourKey, cloud_cover: null, shortwave_radiation: null, pv_power: v, source: null });
  });

  const pvStringByHour = new Map();
  parseCsv(pvStringCsv).forEach(r => {
    if (!r._time || !r._field) return;
    const v = toNumber(r._value);
    if (v === null) return;
    const hourKey = truncToHour(r._time);
    if (!pvStringByHour.has(hourKey)) pvStringByHour.set(hourKey, {});
    const fieldName = r._field === 'pv_total_power' ? 'pv_string_total_power' : r._field;
    pvStringByHour.get(hourKey)[fieldName] = v;
  });

  pvStringByHour.forEach((stringData, hourKey) => {
    if (!rowMap.has(hourKey)) {
      rowMap.set(hourKey, { time: hourKey, cloud_cover: null, shortwave_radiation: null, pv_power: null, source: null });
    }
    Object.assign(rowMap.get(hourKey), stringData);
  });

  for (const fc of wxRows) {
    const hourKey = truncToHour(fc.time);
    const row = rowMap.get(hourKey) || { time: hourKey, cloud_cover: null, shortwave_radiation: null, pv_power: null, source: null };
    if (fc.cloud_cover != null) row.cloud_cover = fc.cloud_cover;
    if (fc.shortwave_radiation != null) row.shortwave_radiation = fc.shortwave_radiation;
    row.source = fc.source || row.source;
    rowMap.set(hourKey, row);
  }

  const rows = Array.from(rowMap.values()).sort((a, b) => a.time.localeCompare(b.time));

  let sunriseIso = null, sunsetIso = null;
  parseCsv(solarEventsCsv).forEach(row => {
    const dateLocal = row.date_local || localDateKey(row._time);
    if (dateLocal !== dateKey) return;
    if (row.event_type === 'sunrise') sunriseIso = row._time;
    if (row.event_type === 'sunset') sunsetIso = row._time;
  });

  return { timezone: WEATHER_TIMEZONE, local_date: dateKey, source: wxSource, rows, sunrise: sunriseIso, sunset: sunsetIso };
}

async function fetchSolarDayStats(days = 8) {
  const safeDays = Math.max(1, Math.min(30, parseInt(days, 10) || 8));
  const thresholdKw = 0.05;
  const solarFlux = `
from(bucket: "${INFLUXDB_BUCKET}")
  |> range(start: -${safeDays}d, stop: 24h)
  |> filter(fn: (r) => r._measurement == "solar_events" and r.station_id == "${STATION_ID}")
  |> keep(columns: ["_time", "event_type", "date_local", "_field", "_value"])
`;
  const pvFlux = `
from(bucket: "${INFLUXDB_BUCKET}")
  |> range(start: -${safeDays}d)
  |> filter(fn: (r) => r._measurement == "energy_metrics" and r.station_id == "${STATION_ID}")
  |> filter(fn: (r) => r._field == "pv_power")
  |> aggregateWindow(every: 1m, fn: mean, createEmpty: false)
  |> keep(columns: ["_time", "_value"])
`;

  const [solarCsv, pvCsv] = await Promise.all([
    queryInflux(solarFlux).catch(() => ''),
    queryInflux(pvFlux).catch(() => ''),
  ]);

  const byDate = new Map();
  const ensure = dateLocal => {
    if (!dateLocal) return null;
    if (!byDate.has(dateLocal)) byDate.set(dateLocal, { date_local: dateLocal });
    return byDate.get(dateLocal);
  };

  parseCsv(solarCsv).forEach(row => {
    const dateLocal = row.date_local || localDateKey(row._time);
    const entry = ensure(dateLocal);
    if (!entry) return;
    if (row.event_type === 'sunrise') {
      entry.sunrise_time = row._time;
      entry.sunrise_local = row._value || formatLocalTime(row._time);
    } else if (row.event_type === 'sunset') {
      entry.sunset_time = row._time;
      entry.sunset_local = row._value || formatLocalTime(row._time);
    }
  });

  let latestPvPower = null;
  let latestPvTime = null;
  parseCsv(pvCsv).forEach(row => {
    const value = toNumber(row._value);
    if (value === null || !row._time) return;
    latestPvPower = value;
    latestPvTime = row._time;
    if (value <= thresholdKw) return;
    const dateLocal = localDateKey(row._time);
    const entry = ensure(dateLocal);
    if (!entry) return;
    if (!entry.pv_start_time) entry.pv_start_time = row._time;
    entry.pv_stop_time = row._time;
  });

  const todayKey = localDateKey(new Date());
  const rows = Array.from(byDate.values()).map(entry => {
    const producingNow = entry.date_local === todayKey && latestPvPower !== null && latestPvPower > thresholdKw && latestPvTime === entry.pv_stop_time;
    return {
      ...entry,
      pv_start_local: entry.pv_start_time ? formatLocalTime(entry.pv_start_time) : null,
      pv_stop_local: entry.pv_stop_time ? formatLocalTime(entry.pv_stop_time) : null,
      start_after_sunrise_min: minutesBetween(entry.pv_start_time, entry.sunrise_time),
      stop_after_sunset_min: producingNow ? null : minutesBetween(entry.pv_stop_time, entry.sunset_time),
      daylight_production_minutes: entry.pv_start_time && entry.pv_stop_time ? minutesBetween(entry.pv_stop_time, entry.pv_start_time) : null,
      producing_now: producingNow,
      threshold_kw: thresholdKw,
    };
  }).sort((a, b) => b.date_local.localeCompare(a.date_local));

  return {
    threshold_kw: thresholdKw,
    today: rows.find(row => row.date_local === todayKey) || { date_local: todayKey, threshold_kw: thresholdKw },
    history: rows.slice(0, safeDays),
  };
}

function integrateGridImportKwhFromSamples(samples) {
  const MAX_INTERVAL_H = 5 / 60;
  let total = 0;
  for (let i = 1; i < samples.length; i++) {
    const dtH = Math.min((samples[i].time - samples[i - 1].time) / 3600000, MAX_INTERVAL_H);
    if (dtH <= 0) continue;
    total += dtH * (Math.max(0, -samples[i - 1].value) + Math.max(0, -samples[i].value)) / 2;
  }
  return Math.max(0, total);
}

function integratePvKwhFromSamples(samples) {
  const MAX_INTERVAL_H = 5 / 60;
  let total = 0;
  for (let i = 1; i < samples.length; i++) {
    const dtH = Math.min((samples[i].time - samples[i - 1].time) / 3600000, MAX_INTERVAL_H);
    if (dtH <= 0) continue;
    total += dtH * (Math.max(0, samples[i - 1].value) + Math.max(0, samples[i].value)) / 2;
  }
  return Math.max(0, total);
}

function integrateEvKwhFromSamples(samples) {
  const MAX_INTERVAL_H = 5 / 60;
  let total = 0;
  for (let i = 1; i < samples.length; i++) {
    const dtH = Math.min((samples[i].time - samples[i - 1].time) / 3600000, MAX_INTERVAL_H);
    if (dtH <= 0) continue;
    total += dtH * (Math.max(0, samples[i - 1].value) + Math.max(0, samples[i].value)) / 2;
  }
  return Math.max(0, total);
}

async function fetchDcChargerCostStats() {
  const tz = TIMEZONE;
  const EV_ACTIVE_THRESHOLD = 0.05;
  const SESSION_IDLE_GAP_MS = 10 * 60 * 1000;
  const SESSION_DATA_GAP_MS = 15 * 60 * 1000;

  // Compute start of current calendar month in TIMEZONE
  const now = new Date();
  const localParts = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(now).forEach(({ type, value }) => {
    if (type !== 'literal') localParts[type] = parseInt(value, 10);
  });
  const monthStart = localTimeToDate(
    `${localParts.year}-${String(localParts.month).padStart(2, '0')}-01`,
    0, 0, tz
  );
  const monthStartIso = monthStart.toISOString();

  const sessionFlux = `
from(bucket: "${INFLUXDB_BUCKET}")
  |> range(start: -7d)
  |> filter(fn: (r) => r._measurement == "energy_metrics" and r.station_id == "${STATION_ID}")
  |> filter(fn: (r) => r._field == "ev_power")
  |> aggregateWindow(every: 1m, fn: mean, createEmpty: false)
  |> keep(columns: ["_time", "_value"])
`;
  const monthFlux = `
from(bucket: "${INFLUXDB_BUCKET}")
  |> range(start: ${monthStartIso})
  |> filter(fn: (r) => r._measurement == "energy_metrics" and r.station_id == "${STATION_ID}")
  |> filter(fn: (r) => r._field == "ev_power")
  |> aggregateWindow(every: 1m, fn: mean, createEmpty: false)
  |> keep(columns: ["_time", "_value"])
`;
  const totalFlux = `
from(bucket: "${INFLUXDB_BUCKET}")
  |> range(start: 1970-01-01T00:00:00Z)
  |> filter(fn: (r) => r._measurement == "energy_metrics" and r.station_id == "${STATION_ID}")
  |> filter(fn: (r) => r._field == "ev_power")
  |> aggregateWindow(every: 5m, fn: mean, createEmpty: false)
  |> keep(columns: ["_time", "_value"])
`;

  const [sessionCsv, monthCsv, totalCsv] = await Promise.all([
    queryInflux(sessionFlux).catch(() => ''),
    queryInflux(monthFlux).catch(() => ''),
    queryInflux(totalFlux).catch(() => ''),
  ]);

  function parseSortedSamples(csv) {
    return parseCsv(csv)
      .map(r => ({ time: new Date(r._time).getTime(), value: toNumber(r._value) }))
      .filter(r => isFinite(r.time) && r.value !== null)
      .sort((a, b) => a.time - b.time);
  }

  function buildStats(samples) {
    if (!samples.length) return { kwh: null, cost_thb: null, start_time: null, end_time: null, sample_count: 0 };
    const kwh = parseFloat(integrateEvKwhFromSamples(samples).toFixed(3));
    return {
      kwh,
      cost_thb: parseFloat((kwh * GRID_COST_RATE_THB_PER_KWH).toFixed(2)),
      start_time: new Date(samples[0].time).toISOString(),
      end_time: new Date(samples[samples.length - 1].time).toISOString(),
      sample_count: samples.length,
    };
  }

  // Session detection from 7d samples
  const sessionSamples = parseSortedSamples(sessionCsv);
  const sessions = [];
  let sesStart = null;
  let lastActiveTime = null;
  let sesSamples = [];
  let prevTime = null;

  for (const s of sessionSamples) {
    const isActive = s.value > EV_ACTIVE_THRESHOLD;
    const dataGap = prevTime !== null && (s.time - prevTime) > SESSION_DATA_GAP_MS;

    if (dataGap && sesStart !== null) {
      sessions.push({ start: sesStart, end: lastActiveTime, samples: sesSamples });
      sesStart = null; lastActiveTime = null; sesSamples = [];
    }

    if (isActive) {
      if (sesStart === null) { sesStart = s.time; sesSamples = []; }
      sesSamples.push(s);
      lastActiveTime = s.time;
    } else if (sesStart !== null && lastActiveTime !== null) {
      if ((s.time - lastActiveTime) >= SESSION_IDLE_GAP_MS) {
        sessions.push({ start: sesStart, end: lastActiveTime, samples: sesSamples });
        sesStart = null; lastActiveTime = null; sesSamples = [];
      }
    }
    prevTime = s.time;
  }
  if (sesStart !== null) {
    sessions.push({ start: sesStart, end: lastActiveTime || sesStart, samples: sesSamples });
  }

  const latestSample = sessionSamples.length ? sessionSamples[sessionSamples.length - 1] : null;
  const isCurrentlyActive = latestSample !== null && latestSample.value > EV_ACTIVE_THRESHOLD;

  let sessionResult;
  if (sessions.length === 0) {
    sessionResult = { status: 'none', kwh: null, cost_thb: null, start_time: null, end_time: null, sample_count: null };
  } else {
    const last = sessions[sessions.length - 1];
    const stats = buildStats(last.samples);
    sessionResult = {
      status: isCurrentlyActive ? 'current' : 'last',
      ...stats,
      start_time: new Date(last.start).toISOString(),
      end_time: new Date(last.end).toISOString(),
    };
  }

  const monthSamples = parseSortedSamples(monthCsv);
  const totalSamples = parseSortedSamples(totalCsv);

  const monthResult = monthSamples.length
    ? buildStats(monthSamples)
    : { kwh: null, cost_thb: null, start_time: null, end_time: null, sample_count: 0 };
  const totalResult = totalSamples.length
    ? buildStats(totalSamples)
    : { kwh: null, cost_thb: null, start_time: null, end_time: null, sample_count: 0 };

  // Per-day history for last 7 local days
  const todayKey = localDateKey(new Date());
  const [tyH, tmH, tdH] = todayKey.split('-').map(Number);
  const histDateKeys = [];
  for (let i = 6; i >= 0; i--) {
    histDateKeys.push(localDateKey(new Date(Date.UTC(tyH, tmH - 1, tdH - i))));
  }
  const history = await Promise.all(histDateKeys.map(async (dateKey) => {
    const { startIso, endIso } = localDayUtcBounds(dateKey, tz);
    const isToday = dateKey === todayKey;
    const hFlux = `
from(bucket: "${INFLUXDB_BUCKET}")
  |> range(start: ${startIso}, stop: ${isToday ? 'now()' : endIso})
  |> filter(fn: (r) => r._measurement == "energy_metrics" and r.station_id == "${STATION_ID}")
  |> filter(fn: (r) => r._field == "ev_power")
  |> aggregateWindow(every: 1m, fn: mean, createEmpty: false)
  |> keep(columns: ["_time", "_value"])
`;
    const hCsv = await queryInflux(hFlux).catch(() => '');
    const hSamples = parseCsv(hCsv)
      .map(r => ({ time: new Date(r._time).getTime(), value: toNumber(r._value) }))
      .filter(r => isFinite(r.time) && r.value !== null)
      .sort((a, b) => a.time - b.time);
    const kwh = parseFloat(integrateEvKwhFromSamples(hSamples).toFixed(3));
    return {
      date: dateKey,
      kwh,
      cost_thb: parseFloat((kwh * GRID_COST_RATE_THB_PER_KWH).toFixed(2)),
      period: isToday ? 'today_so_far' : 'full_day',
      start_time: hSamples.length ? new Date(hSamples[0].time).toISOString() : null,
      end_time: hSamples.length ? new Date(hSamples[hSamples.length - 1].time).toISOString() : null,
      sample_count: hSamples.length,
    };
  }));

  return {
    rate_thb_per_kwh: GRID_COST_RATE_THB_PER_KWH,
    session: sessionResult,
    month: monthResult,
    total: totalResult,
    history,
  };
}

async function fetchTeslaLatest() {
  const flux = `
from(bucket: "${INFLUXDB_BUCKET}")
  |> range(start: -30d)
  |> filter(fn: (r) => r._measurement == "tesla_charge_state" or r._measurement == "tesla_vehicle_state" or r._measurement == "tesla_collector_health")
  |> last()
  |> keep(columns: ["_measurement", "_field", "_value", "_time", "vin_suffix", "vehicle_name", "source"])
`;
  const csv = await queryInflux(flux);
  const rows = parseCsv(csv);
  const latest = {
    configured: Boolean(INFLUXDB_URL && INFLUXDB_TOKEN && INFLUXDB_ORG && INFLUXDB_BUCKET),
    has_data: rows.length > 0,
    latest_time: null,
    vehicle: {},
    charge: {},
    health: {},
  };
  const fieldSelections = {};
  let metadataSelection = null;

  function hasKnownVin(row) {
    return Boolean(row.vin_suffix && row.vin_suffix.toLowerCase() !== 'unknown');
  }

  function shouldUseRow(candidate, current) {
    if (!current) return true;
    if (candidate.timeMs > current.timeMs) return true;
    return candidate.timeMs === current.timeMs && candidate.hasKnownVin && !current.hasKnownVin;
  }

  rows.forEach(row => {
    const targetName = row._measurement === 'tesla_charge_state'
      ? 'charge'
      : row._measurement === 'tesla_vehicle_state'
        ? 'vehicle'
        : row._measurement === 'tesla_collector_health'
          ? 'health'
          : null;
    const target = targetName ? latest[targetName] : null;
    const timeMs = Date.parse(row._time);
    const candidate = { timeMs, hasKnownVin: hasKnownVin(row) };

    if (Number.isFinite(timeMs) && (!latest.latest_time || timeMs > Date.parse(latest.latest_time))) {
      latest.latest_time = row._time;
    }

    if (Number.isFinite(timeMs) && candidate.hasKnownVin && shouldUseRow(candidate, metadataSelection)) {
      latest.vehicle.vin_suffix = row.vin_suffix;
      if (row.vehicle_name) latest.vehicle.vehicle_name = row.vehicle_name;
      else delete latest.vehicle.vehicle_name;
      if (row.source) latest.vehicle.source = row.source;
      else delete latest.vehicle.source;
      metadataSelection = candidate;
    }

    if (!target || !row._field) return;
    const value = toNumber(row._value);
    const selectionKey = `${targetName}.${row._field}`;
    if (Number.isFinite(timeMs) && shouldUseRow(candidate, fieldSelections[selectionKey])) {
      target[row._field] = value;
      fieldSelections[selectionKey] = candidate;
    }
  });

  return latest;
}

async function fetchTeslaHistory(range) {
  const windowMap = { '24h': '5m', '7d': '30m', '30d': '2h' };
  const window = windowMap[range];
  if (!window) {
    const err = new Error('Invalid range. Valid values: 24h, 7d, 30d');
    err.status = 400;
    throw err;
  }
  const flux = `
from(bucket: "${INFLUXDB_BUCKET}")
  |> range(start: -${range})
  |> filter(fn: (r) => r._measurement == "tesla_charge_state")
  |> filter(fn: (r) => r._field == "battery_level_pct" or r._field == "charger_power_kw")
  |> aggregateWindow(every: ${window}, fn: mean, createEmpty: false)
  |> keep(columns: ["_time", "_field", "_value"])
`;
  const csv = await queryInflux(flux);
  const rows = parseCsv(csv);
  const series = { battery_level_pct: [], charger_power_kw: [] };
  rows.forEach(row => {
    if (!series[row._field]) series[row._field] = [];
    const value = toNumber(row._value);
    if (value !== null) series[row._field].push({ time: row._time, value });
  });
  return { range, window, series };
}

async function fetchTeslaSessionContext() {
  const [teslaLatest, dcChargerCost] = await Promise.all([
    fetchTeslaLatest().catch(err => ({ configured: true, has_data: false, error: err.message })),
    fetchDcChargerCostStats().catch(err => ({ error: err.message })),
  ]);
  return {
    tesla_latest: teslaLatest,
    dc_charger_cost: dcChargerCost,
    note: 'allocation estimates combine Tesla charge state with DC charger energy inferred from home energy samples',
  };
}

async function fetchBatteryFullTimeStats(days = 7) {
  const safeDays = Math.max(1, Math.min(30, parseInt(days, 10) || 7));
  const THRESHOLD_SOC = 100;
  const PV_THRESHOLD_KW = 0.05;
  const tz = TIMEZONE;

  const todayKey = localDateKey(new Date());
  const [ty, tm, td] = todayKey.split('-').map(Number);

  const dateKeys = [];
  for (let i = safeDays - 1; i >= 0; i--) {
    dateKeys.push(localDateKey(new Date(Date.UTC(ty, tm - 1, td - i))));
  }

  const { startIso: rangeStart } = localDayUtcBounds(dateKeys[0], tz);

  const energyFlux = `
from(bucket: "${INFLUXDB_BUCKET}")
  |> range(start: ${rangeStart})
  |> filter(fn: (r) => r._measurement == "energy_metrics" and r.station_id == "${STATION_ID}")
  |> filter(fn: (r) => r._field == "battery_soc" or r._field == "pv_power")
  |> aggregateWindow(every: 1m, fn: mean, createEmpty: false)
  |> keep(columns: ["_time", "_field", "_value"])
`;

  const solarFlux = `
from(bucket: "${INFLUXDB_BUCKET}")
  |> range(start: ${rangeStart}, stop: 24h)
  |> filter(fn: (r) => r._measurement == "solar_events" and r.station_id == "${STATION_ID}")
  |> keep(columns: ["_time", "event_type", "date_local", "_value"])
`;

  const [energyCsv, solarCsv] = await Promise.all([
    queryInflux(energyFlux).catch(() => ''),
    queryInflux(solarFlux).catch(() => ''),
  ]);

  const byDate = new Map();
  dateKeys.forEach(dateKey => {
    byDate.set(dateKey, {
      date: dateKey,
      first_full_time: null,
      first_full_local: null,
      pv_start_time: null,
      pv_start_local: null,
      sunrise_time: null,
      sunrise_local: null,
      sunset_time: null,
      sunset_local: null,
      sample_count: 0,
    });
  });

  parseCsv(energyCsv).forEach(row => {
    if (!row._time || !row._field) return;
    const value = toNumber(row._value);
    if (value === null) return;
    const dateKey = localDateKey(row._time);
    if (!byDate.has(dateKey)) return;
    const entry = byDate.get(dateKey);
    if (row._field === 'battery_soc') {
      entry.sample_count++;
      if (entry.first_full_time === null && value >= THRESHOLD_SOC) {
        entry.first_full_time = row._time;
        entry.first_full_local = formatLocalTime(row._time);
      }
    } else if (row._field === 'pv_power') {
      if (entry.pv_start_time === null && value > PV_THRESHOLD_KW) {
        entry.pv_start_time = row._time;
        entry.pv_start_local = formatLocalTime(row._time);
      }
    }
  });

  parseCsv(solarCsv).forEach(row => {
    if (!row._time) return;
    const dateKey = row.date_local || localDateKey(row._time);
    if (!byDate.has(dateKey)) return;
    const entry = byDate.get(dateKey);
    if (row.event_type === 'sunrise') {
      entry.sunrise_time = row._time;
      entry.sunrise_local = row._value || formatLocalTime(row._time);
    } else if (row.event_type === 'sunset') {
      entry.sunset_time = row._time;
      entry.sunset_local = row._value || formatLocalTime(row._time);
    }
  });

  const history = dateKeys.map(dateKey => {
    const entry = byDate.get(dateKey);
    const reached_full = entry.first_full_time !== null;
    let minutes_since_midnight = null;
    if (reached_full) {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date(entry.first_full_time));
      const h = parseInt(parts.find(p => p.type === 'hour').value, 10);
      const m = parseInt(parts.find(p => p.type === 'minute').value, 10);
      minutes_since_midnight = h * 60 + m;
    }
    return {
      date: entry.date,
      period: dateKey === todayKey ? 'today_so_far' : 'full_day',
      first_full_time: entry.first_full_time,
      first_full_local: entry.first_full_local,
      pv_start_time: entry.pv_start_time,
      pv_start_local: entry.pv_start_local,
      sunrise_time: entry.sunrise_time,
      sunrise_local: entry.sunrise_local,
      sunset_time: entry.sunset_time,
      sunset_local: entry.sunset_local,
      minutes_from_sunrise_to_full: reached_full ? minutesBetween(entry.first_full_time, entry.sunrise_time) : null,
      minutes_from_pv_start_to_full: reached_full ? minutesBetween(entry.first_full_time, entry.pv_start_time) : null,
      minutes_since_midnight,
      reached_full,
      sample_count: entry.sample_count,
    };
  });

  return {
    timezone: tz,
    threshold_soc: THRESHOLD_SOC,
    pv_threshold_kw: PV_THRESHOLD_KW,
    today: history.find(r => r.date === todayKey) || null,
    history,
  };
}

async function fetchGridCostStats(days) {
  const safeDays = parseInt(days, 10) === 30 ? 30 : 7;
  const tz = TIMEZONE;
  const todayKey = localDateKey(new Date());
  const [ty, tm, td] = todayKey.split('-').map(Number);

  const dateKeys = [];
  for (let i = safeDays - 1; i >= 0; i--) {
    dateKeys.push(localDateKey(new Date(Date.UTC(ty, tm - 1, td - i))));
  }
  const uniqueKeys = [...new Set(dateKeys)].sort();

  const history = await Promise.all(uniqueKeys.map(async (dateKey) => {
    const { startIso, endIso } = localDayUtcBounds(dateKey, tz);
    const isToday = dateKey === todayKey;
    const flux = `
from(bucket: "${INFLUXDB_BUCKET}")
  |> range(start: ${startIso}, stop: ${isToday ? 'now()' : endIso})
  |> filter(fn: (r) => r._measurement == "energy_metrics" and r.station_id == "${STATION_ID}")
  |> filter(fn: (r) => r._field == "grid_flow_power" or r._field == "pv_power")
  |> aggregateWindow(every: 1m, fn: mean, createEmpty: false)
  |> keep(columns: ["_time", "_field", "_value"])
`;
    const csv = await queryInflux(flux).catch(() => '');
    const gridSamples = [];
    const pvSamples = [];
    parseCsv(csv).forEach(r => {
      const time = new Date(r._time).getTime();
      const value = toNumber(r._value);
      if (!isFinite(time) || value === null) return;
      if (r._field === 'grid_flow_power') gridSamples.push({ time, value });
      else if (r._field === 'pv_power') pvSamples.push({ time, value });
    });
    gridSamples.sort((a, b) => a.time - b.time);
    pvSamples.sort((a, b) => a.time - b.time);
    const grid_import_kwh = parseFloat(integrateGridImportKwhFromSamples(gridSamples).toFixed(3));
    const grid_cost_thb = parseFloat((grid_import_kwh * GRID_COST_RATE_THB_PER_KWH).toFixed(2));
    const pv_generation_kwh = parseFloat(integratePvKwhFromSamples(pvSamples).toFixed(3));
    const pv_value_thb = parseFloat((pv_generation_kwh * GRID_COST_RATE_THB_PER_KWH).toFixed(2));
    return {
      date: dateKey,
      period: isToday ? 'today_so_far' : 'full_day',
      grid_import_kwh,
      grid_cost_thb,
      pv_generation_kwh,
      pv_value_thb,
      rate_thb_per_kwh: GRID_COST_RATE_THB_PER_KWH,
      sample_count: gridSamples.length,
      start_time: gridSamples.length ? new Date(gridSamples[0].time).toISOString() : null,
      end_time: gridSamples.length ? new Date(gridSamples[gridSamples.length - 1].time).toISOString() : null,
    };
  }));

  history.sort((a, b) => a.date.localeCompare(b.date));
  return {
    timezone: TIMEZONE,
    days: safeDays,
    rate_thb_per_kwh: GRID_COST_RATE_THB_PER_KWH,
    history,
    today: history.find(r => r.date === todayKey) || null,
  };
}

function escapeLineProtocol(value) {
  return String(value).replace(/ /g, '\\ ').replace(/,/g, '\\,').replace(/=/g, '\\=');
}

async function writeSolarStatsSnapshot(solarStats) {
  const today = solarStats && solarStats.today;
  if (!today || !today.date_local || !today.sunrise_time) return;
  const fields = [];
  const addFloat = (key, value) => {
    const n = toNumber(value);
    if (n !== null) fields.push(`${key}=${n}`);
  };
  const addInt = (key, value) => {
    if (!value) return;
    const n = Math.floor(new Date(value).getTime() / 1000);
    if (Number.isFinite(n)) fields.push(`${key}=${n}i`);
  };
  addFloat('start_after_sunrise_min', today.start_after_sunrise_min);
  addFloat('stop_after_sunset_min', today.stop_after_sunset_min);
  addFloat('daylight_production_minutes', today.daylight_production_minutes);
  addFloat('pv_threshold_kw', today.threshold_kw || solarStats.threshold_kw);
  fields.push(`producing_now=${today.producing_now ? 'true' : 'false'}`);
  addInt('sunrise_unix', today.sunrise_time);
  addInt('sunset_unix', today.sunset_time);
  addInt('pv_start_unix', today.pv_start_time);
  addInt('pv_stop_unix', today.pv_stop_time);
  if (!fields.length) return;
  const line = `solar_production_stats,station_id=${escapeLineProtocol(STATION_ID)},date_local=${escapeLineProtocol(today.date_local)} ${fields.join(',')} ${Math.floor(Date.now() / 1000)}`;
  const res = await fetch(`${INFLUXDB_URL}/api/v2/write?org=${encodeURIComponent(INFLUXDB_ORG)}&bucket=${encodeURIComponent(INFLUXDB_BUCKET)}&precision=s`, {
    method: 'POST',
    headers: {
      Authorization: 'Token ' + INFLUXDB_TOKEN,
      'Content-Type': 'text/plain; charset=utf-8',
    },
    body: line,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`InfluxDB write solar stats ${res.status}: ${text.slice(0, 200)}`);
  }
}


function normalizeSummaryPeriod(periodRaw) {
  const p = String(periodRaw || 'day').toLowerCase();
  if (['day', 'daily', 'today'].includes(p)) return 'day';
  if (['week', 'weekly'].includes(p)) return 'week';
  if (['month', 'monthly'].includes(p)) return 'month';
  if (['year', 'yearly'].includes(p)) return 'year';
  if (['all', 'alltime', 'all-time'].includes(p)) return 'all';
  return 'day';
}

function addLocalDays(dateKey, days) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function localMonthStartKey(dateKey) {
  return `${dateKey.slice(0, 7)}-01`;
}

function localYearStartKey(dateKey) {
  return `${dateKey.slice(0, 4)}-01-01`;
}

function localWeekStartKey(dateKey) {
  // Monday-start week from the local date key. For Asia/Bangkok date-only keys,
  // UTC noon is safely inside the same local date and avoids DST boundary issues.
  const [y, m, day] = dateKey.split('-').map(Number);
  const noon = new Date(Date.UTC(y, m - 1, day, 12));
  const jsDow = noon.getUTCDay();
  const daysSinceMonday = (jsDow + 6) % 7;
  return addLocalDays(dateKey, -daysSinceMonday);
}

function summaryBounds(period) {
  const todayKey = localDateKey(new Date());
  if (period === 'day') {
    const b = localDayUtcBounds(todayKey, TIMEZONE);
    return { startIso: b.startIso, endIso: new Date().toISOString(), label: todayKey, aggregateWindow: '1m', gapCapMinutes: 5 };
  }
  if (period === 'week') {
    const startKey = localWeekStartKey(todayKey);
    const b = localDayUtcBounds(startKey, TIMEZONE);
    return { startIso: b.startIso, endIso: new Date().toISOString(), label: `${startKey}→${todayKey}`, aggregateWindow: '30m', gapCapMinutes: 45 };
  }
  if (period === 'month') {
    const startKey = localMonthStartKey(todayKey);
    const b = localDayUtcBounds(startKey, TIMEZONE);
    return { startIso: b.startIso, endIso: new Date().toISOString(), label: todayKey.slice(0, 7), aggregateWindow: '1h', gapCapMinutes: 90 };
  }
  if (period === 'year') {
    const startKey = localYearStartKey(todayKey);
    const b = localDayUtcBounds(startKey, TIMEZONE);
    return { startIso: b.startIso, endIso: new Date().toISOString(), label: todayKey.slice(0, 4), aggregateWindow: '6h', gapCapMinutes: 420 };
  }
  return { startIso: '1970-01-01T00:00:00Z', endIso: new Date().toISOString(), label: 'all-time', aggregateWindow: '6h', gapCapMinutes: 420 };
}

function parseSortedSamplesForField(rows, field) {
  return rows
    .filter(r => r._field === field && r._time)
    .map(r => ({ time: new Date(r._time).getTime(), iso: r._time, value: toNumber(r._value) }))
    .filter(r => Number.isFinite(r.time) && r.value !== null)
    .sort((a, b) => a.time - b.time);
}

function integrateSamplesKwh(samples, mapper, gapCapMinutes) {
  let total = 0;
  const capH = Math.max(1, gapCapMinutes || 5) / 60;
  for (let i = 1; i < samples.length; i++) {
    const dtH = Math.min((samples[i].time - samples[i - 1].time) / 3600000, capH);
    if (!Number.isFinite(dtH) || dtH <= 0) continue;
    const a = mapper(samples[i - 1].value, samples[i - 1]);
    const b = mapper(samples[i].value, samples[i]);
    total += dtH * (a + b) / 2;
  }
  return Math.max(0, total);
}

function summarizeNumericSamples(samples) {
  const values = samples.map(s => s.value).filter(Number.isFinite);
  if (!values.length) return { min: null, max: null, avg: null };
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    avg: values.reduce((sum, v) => sum + v, 0) / values.length,
  };
}

function findPeakWindow(samples, mapper, timezoneName) {
  const buckets = new Map();
  for (let i = 1; i < samples.length; i++) {
    const dtH = Math.min((samples[i].time - samples[i - 1].time) / 3600000, 1);
    if (!Number.isFinite(dtH) || dtH <= 0) continue;
    const mid = new Date((samples[i].time + samples[i - 1].time) / 2);
    const hour = new Intl.DateTimeFormat('en-GB', { timeZone: timezoneName, hour: '2-digit', hour12: false }).format(mid);
    const key = `${hour}:00–${String((parseInt(hour, 10) + 1) % 24).padStart(2, '0')}:00`;
    const value = dtH * (mapper(samples[i - 1].value) + mapper(samples[i].value)) / 2;
    buckets.set(key, (buckets.get(key) || 0) + Math.max(0, value));
  }
  let best = null;
  for (const [window, kwh] of buckets.entries()) {
    if (!best || kwh > best.kwh) best = { window, kwh };
  }
  if (!best || best.kwh <= 0.001) return null;
  return { window: best.window, kwh: parseFloat(best.kwh.toFixed(3)) };
}

function calcDataQuality(samplesByField, startIso, endIso, gapCapMinutes) {
  const allTimes = [];
  Object.values(samplesByField).forEach(samples => samples.forEach(s => allTimes.push(s.time)));
  const unique = [...new Set(allTimes)].sort((a, b) => a - b);
  if (unique.length < 2) {
    return { coverage_pct: unique.length ? 1 : 0, sample_count: unique.length, largest_gap_minutes: null, latest_timestamp: unique.length ? new Date(unique[unique.length - 1]).toISOString() : null };
  }
  let largestGapMs = 0;
  let coveredMs = 0;
  const capMs = Math.max(1, gapCapMinutes || 5) * 60000;
  for (let i = 1; i < unique.length; i++) {
    const gap = unique[i] - unique[i - 1];
    if (gap > largestGapMs) largestGapMs = gap;
    coveredMs += Math.min(gap, capMs);
  }
  const expectedMs = Math.max(1, new Date(endIso).getTime() - new Date(startIso).getTime());
  return {
    coverage_pct: parseFloat(clamp((coveredMs / expectedMs) * 100, 0, 100).toFixed(1)),
    sample_count: unique.length,
    largest_gap_minutes: parseFloat((largestGapMs / 60000).toFixed(1)),
    latest_timestamp: new Date(unique[unique.length - 1]).toISOString(),
  };
}

function thaiStatusFromScore(score) {
  if (score >= 85) return 'ดีมาก';
  if (score >= 70) return 'ดี';
  if (score >= 50) return 'ยังมีโอกาสปรับ';
  return 'ควรปรับ schedule/load';
}

function englishStatusFromScore(score) {
  if (score >= 85) return 'Excellent';
  if (score >= 70) return 'Good';
  if (score >= 50) return 'Optimization opportunity';
  return 'Action needed';
}

function translateSummaryActionToEnglish(title, message, evidence) {
  const titleMap = {
    'เพิ่มการใช้ Solar เองช่วงกลางวัน': 'Increase daytime solar self-consumption',
    'ลดการซื้อไฟช่วง Peak Load': 'Reduce grid import during peak load',
    'Battery เต็มแล้วแต่ยังมี Solar เหลือ': 'Battery is full while solar surplus remains',
    'Battery ต่ำช่วงกลางคืน/เช้า': 'Battery is low overnight / early morning',
    'เลื่อน DC Charger ไปช่วง PV Surplus': 'Move DC charging to PV surplus hours',
    'ตรวจสอบ PV เมื่อแดดดีแต่กำลังผลิตต่ำ': 'Check PV output when irradiance is good',
    'ระบบโดยรวมทำงานสมดุล': 'Overall system is balanced',
  };
  const messageEn = String(message || '')
    .replace('มีไฟส่งออก Grid', 'Grid export was')
    .replace('ในช่วงนี้ หากย้ายโหลดที่เลื่อนได้มาใช้ช่วงแดด จะลดการซื้อไฟได้มากขึ้น', 'in this period. Moving shiftable loads to sunny hours can reduce grid import.')
    .replace('ช่วงที่ซื้อไฟจาก Grid สูงสุดคือ', 'The highest grid-import window is')
    .replace('แนะนำหลีกเลี่ยงโหลดหนักช่วงนี้ หรือเตรียม Battery SOC ก่อนพระอาทิตย์ตก', 'Avoid heavy loads in this window or prepare battery SOC before sunset.')
    .replace('Battery เต็มครั้งแรกเวลา', 'Battery first reached full at')
    .replace('และหลังจากนั้นยังส่งออก', 'and exported')
    .replace('เหมาะกับการตั้งเวลา DC Charger/โหลดหนักหลังแบตเต็ม', 'afterwards; schedule DC charging/heavy loads after battery full.')
    .replace('SOC ต่ำสุด', 'Minimum SOC')
    .replace('แนะนำลด base load กลางคืน หรือรักษา SOC ก่อนพระอาทิตย์ตกให้สูงขึ้น', 'Reduce overnight base load or keep higher SOC before sunset.')
    .replace('พบ DC Charger ใช้ไฟทับกับช่วงซื้อ Grid ประมาณ', 'DC charger overlapped grid import by about')
    .replace('ควรเลื่อนไปช่วง', 'Move it to')
    .replace('แดดแรง', 'sunny hours')
    .replace('หากทำได้', 'if possible.')
    .replace('ค่าแดดค่อนข้างดีแต่ PV peak ต่ำกว่าที่ควร อาจเกิดจาก shading, ฝุ่น, clipping หรือ string ใด string หนึ่งตก', 'Irradiance is good but PV peak is lower than expected; check shading, dust, clipping, or a weak string.')
    .replace('ยังไม่พบโอกาสประหยัดเด่นชัดจากข้อมูลช่วงนี้ ให้ติดตาม self-use, grid import และ battery SOC ต่อเนื่อง', 'No major saving opportunity was detected for this period. Continue monitoring self-use, grid import, and battery SOC.');
  const evidenceEn = String(evidence || '')
    .replace('ช่วงไฟเหลือเด่น', 'Surplus window')
    .replace('Export รวม', 'Total export')
    .replace('Grid import รวม', 'Total grid import')
    .replace('ในช่วง peak', 'during peak')
    .replace('Export after full', 'Export after full')
    .replace('Min SOC', 'Min SOC')
    .replace('EV/Grid overlap', 'EV/Grid overlap');
  return {
    title_en: titleMap[title] || title,
    message_en: messageEn,
    evidence_en: evidenceEn,
  };
}

function pushAction(actions, priority, title, message, evidence, savingThb = 0) {
  const en = translateSummaryActionToEnglish(title, message, evidence);
  actions.push({
    priority,
    title,
    message,
    evidence,
    title_th: title,
    message_th: message,
    evidence_th: evidence,
    title_en: en.title_en,
    message_en: en.message_en,
    evidence_en: en.evidence_en,
    potential_saving_thb: parseFloat((savingThb || 0).toFixed(2)),
  });
}

async function fetchSummary(periodRaw = 'day') {
  const period = normalizeSummaryPeriod(periodRaw);
  const bounds = summaryBounds(period);
  const stopExpr = bounds.endIso;
  const energyFields = ['pv_power', 'load_power', 'grid_flow_power', 'battery_power', 'battery_soc', 'ev_power'];
  const energyFilter = energyFields.map(f => `r._field == "${f}"`).join(' or ');
  const pvStringFields = ['pv1_power', 'pv2_power', 'pv3_power', 'pv4_power', 'pv_total_power'];
  const pvStringFilter = pvStringFields.map(f => `r._field == "${f}"`).join(' or ');

  const energyFlux = `
from(bucket: "${INFLUXDB_BUCKET}")
  |> range(start: ${bounds.startIso}, stop: ${stopExpr})
  |> filter(fn: (r) => r._measurement == "energy_metrics" and r.station_id == "${STATION_ID}")
  |> filter(fn: (r) => ${energyFilter})
  |> aggregateWindow(every: ${bounds.aggregateWindow}, fn: mean, createEmpty: false)
  |> keep(columns: ["_time", "_field", "_value"])
`;
  const pvStringFlux = `
from(bucket: "${INFLUXDB_BUCKET}")
  |> range(start: ${bounds.startIso}, stop: ${stopExpr})
  |> filter(fn: (r) => r._measurement == "pv_string_metrics" and r.station_id == "${STATION_ID}")
  |> filter(fn: (r) => ${pvStringFilter})
  |> aggregateWindow(every: ${bounds.aggregateWindow}, fn: mean, createEmpty: false)
  |> keep(columns: ["_time", "_field", "_value"])
`;
  const weatherFlux = `
from(bucket: "${INFLUXDB_BUCKET}")
  |> range(start: ${bounds.startIso}, stop: ${stopExpr})
  |> filter(fn: (r) => (r._measurement == "weather_forecast_hourly" or r._measurement == "weather_current") and r.station_id == "${STATION_ID}")
  |> filter(fn: (r) => r._field == "shortwave_radiation" or r._field == "cloud_cover" or r._field == "temperature_2m" or r._field == "temperature" or r._field == "rain" or r._field == "precipitation")
  |> aggregateWindow(every: ${bounds.aggregateWindow}, fn: mean, createEmpty: false)
  |> keep(columns: ["_time", "_field", "_value"])
`;

  const [energyCsv, pvStringCsv, weatherCsv] = await Promise.all([
    queryInflux(energyFlux).catch(() => ''),
    queryInflux(pvStringFlux).catch(() => ''),
    queryInflux(weatherFlux).catch(() => ''),
  ]);
  const energyRows = parseCsv(energyCsv);
  const pvStringRows = parseCsv(pvStringCsv);
  const weatherRows = parseCsv(weatherCsv);

  const samples = {};
  energyFields.forEach(f => { samples[f] = parseSortedSamplesForField(energyRows, f); });
  const pvStringSamples = {};
  pvStringFields.forEach(f => { pvStringSamples[f] = parseSortedSamplesForField(pvStringRows, f); });

  let pvSamples = samples.pv_power || [];
  const stringTotalSamples = pvStringSamples.pv_total_power || [];
  const pvStringHasRealTotal = stringTotalSamples.length >= Math.max(2, Math.floor((pvSamples.length || 1) * 0.2));
  if (pvStringHasRealTotal) pvSamples = stringTotalSamples;

  const gap = bounds.gapCapMinutes;
  const pvKwh = integrateSamplesKwh(pvSamples, v => Math.max(0, v), gap);
  const loadKwh = integrateSamplesKwh(samples.load_power || [], v => Math.max(0, v), gap);
  const gridImportKwh = integrateSamplesKwh(samples.grid_flow_power || [], v => Math.max(0, -v), gap);
  const gridExportKwh = integrateSamplesKwh(samples.grid_flow_power || [], v => Math.max(0, v), gap);
  const battChargeKwh = integrateSamplesKwh(samples.battery_power || [], v => Math.max(0, v), gap);
  const battDischargeKwh = integrateSamplesKwh(samples.battery_power || [], v => Math.max(0, -v), gap);
  const evKwh = integrateSamplesKwh(samples.ev_power || [], v => Math.max(0, v), gap);
  const battStats = summarizeNumericSamples(samples.battery_soc || []);
  const pvStats = summarizeNumericSamples(pvSamples);
  const loadStats = summarizeNumericSamples(samples.load_power || []);

  const solarUsedKwh = Math.max(0, pvKwh - gridExportKwh);
  const selfConsumption = pvKwh > 0 ? clamp((solarUsedKwh / pvKwh) * 100, 0, 100) : null;
  const selfSufficiency = loadKwh > 0 ? clamp((1 - (gridImportKwh / loadKwh)) * 100, 0, 100) : null;
  const gridDependency = loadKwh > 0 ? clamp((gridImportKwh / loadKwh) * 100, 0, 100) : null;

  const cloudStats = summarizeNumericSamples(parseSortedSamplesForField(weatherRows, 'cloud_cover'));
  const ghiSamples = parseSortedSamplesForField(weatherRows, 'shortwave_radiation');
  const tempSamples = parseSortedSamplesForField(weatherRows, 'temperature_2m').concat(parseSortedSamplesForField(weatherRows, 'temperature')).sort((a, b) => a.time - b.time);
  const tempStats = summarizeNumericSamples(tempSamples);
  const ghiStats = summarizeNumericSamples(ghiSamples);
  const ghiKwhM2 = integrateSamplesKwh(ghiSamples, v => Math.max(0, v) / 1000, gap);

  const bestSolarExportWindow = findPeakWindow(samples.grid_flow_power || [], v => Math.max(0, v), TIMEZONE);
  const bestPvProductionWindow = findPeakWindow(pvSamples, v => Math.max(0, v), TIMEZONE);
  const bestSolarWindow = bestSolarExportWindow
    ? {
      ...bestSolarExportWindow,
      type: 'surplus_export',
      source: 'grid_flow_power_export',
      label: 'Solar surplus/export',
    }
    : (bestPvProductionWindow ? {
      ...bestPvProductionWindow,
      type: 'pv_production',
      source: pvStringHasRealTotal ? 'pv_string_metrics.pv_total_power' : 'energy_metrics.pv_power',
      label: 'PV production',
    } : null);
  const importPeakWindow = findPeakWindow(samples.grid_flow_power || [], v => Math.max(0, -v), TIMEZONE);
  let batteryFullTime = null;
  const fullSample = (samples.battery_soc || []).find(s => s.value >= BATTERY_FULL_SOC);
  if (fullSample) batteryFullTime = new Date(fullSample.time).toISOString();
  const exportAfterFullKwh = fullSample
    ? integrateSamplesKwh((samples.grid_flow_power || []).filter(s => s.time >= fullSample.time), v => Math.max(0, v), gap)
    : 0;
  const evImportOverlapKwh = integrateSamplesKwh((samples.ev_power || []).map(ev => {
    const gridSamples = samples.grid_flow_power || [];
    let nearest = null;
    for (const g of gridSamples) {
      if (!nearest || Math.abs(g.time - ev.time) < Math.abs(nearest.time - ev.time)) nearest = g;
    }
    return { ...ev, value: nearest && nearest.value < -0.05 ? ev.value : 0 };
  }), v => Math.max(0, v), gap);

  const actions = [];
  if (gridExportKwh > Math.max(1, pvKwh * 0.15)) {
    const saving = Math.min(gridExportKwh, Math.max(0, loadKwh * 0.25)) * GRID_COST_RATE_THB_PER_KWH;
    pushAction(actions, 'high', 'เพิ่มการใช้ Solar เองช่วงกลางวัน',
      `มีไฟส่งออก Grid ${gridExportKwh.toFixed(1)} kWh ในช่วงนี้ หากย้ายโหลดที่เลื่อนได้มาใช้ช่วงแดด จะลดการซื้อไฟได้มากขึ้น`,
      bestSolarWindow ? `ช่วงไฟเหลือเด่น: ${bestSolarWindow.window} ≈ ${bestSolarWindow.kwh.toFixed(1)} kWh` : `Export รวม ${gridExportKwh.toFixed(1)} kWh`, saving);
  }
  if (importPeakWindow && gridImportKwh > Math.max(1, loadKwh * 0.12)) {
    pushAction(actions, 'medium', 'ลดการซื้อไฟช่วง Peak Load',
      `ช่วงที่ซื้อไฟจาก Grid สูงสุดคือ ${importPeakWindow.window} แนะนำหลีกเลี่ยงโหลดหนักช่วงนี้ หรือเตรียม Battery SOC ก่อนพระอาทิตย์ตก`,
      `Grid import รวม ${gridImportKwh.toFixed(1)} kWh · peak window ${importPeakWindow.kwh.toFixed(1)} kWh`, Math.min(gridImportKwh, 3) * GRID_COST_RATE_THB_PER_KWH);
  }
  if (fullSample && exportAfterFullKwh > 1) {
    pushAction(actions, 'medium', 'Battery เต็มแล้วแต่ยังมี Solar เหลือ',
      `Battery เต็มครั้งแรกเวลา ${formatLocalTime(batteryFullTime)} และหลังจากนั้นยังส่งออก ${exportAfterFullKwh.toFixed(1)} kWh เหมาะกับการตั้งเวลา DC Charger/โหลดหนักหลังแบตเต็ม`,
      `Export after full ${exportAfterFullKwh.toFixed(1)} kWh`, exportAfterFullKwh * GRID_COST_RATE_THB_PER_KWH);
  }
  if (battStats.min !== null && battStats.min < 20) {
    pushAction(actions, 'medium', 'Battery ต่ำช่วงกลางคืน/เช้า',
      `SOC ต่ำสุด ${battStats.min.toFixed(0)}% แนะนำลด base load กลางคืน หรือรักษา SOC ก่อนพระอาทิตย์ตกให้สูงขึ้น`,
      `Min SOC ${battStats.min.toFixed(0)}%`, 0);
  }
  if (evImportOverlapKwh > 0.5) {
    pushAction(actions, 'high', 'เลื่อน DC Charger ไปช่วง PV Surplus',
      `พบ DC Charger ใช้ไฟทับกับช่วงซื้อ Grid ประมาณ ${evImportOverlapKwh.toFixed(1)} kWh ควรเลื่อนไปช่วง ${bestSolarWindow ? bestSolarWindow.window : 'แดดแรง'} หากทำได้`,
      `EV/Grid overlap ${evImportOverlapKwh.toFixed(1)} kWh`, evImportOverlapKwh * GRID_COST_RATE_THB_PER_KWH);
  }
  if (ghiStats.avg !== null && ghiStats.avg > 450 && cloudStats.avg !== null && cloudStats.avg < 45 && pvStats.max !== null && pvStats.max < 2) {
    pushAction(actions, 'low', 'ตรวจสอบ PV เมื่อแดดดีแต่กำลังผลิตต่ำ',
      'ค่าแดดค่อนข้างดีแต่ PV peak ต่ำกว่าที่ควร อาจเกิดจาก shading, ฝุ่น, clipping หรือ string ใด string หนึ่งตก',
      `Avg GHI ${ghiStats.avg.toFixed(0)} W/m² · PV peak ${pvStats.max.toFixed(1)} kW`, 0);
  }
  if (!actions.length) {
    pushAction(actions, 'info', 'ระบบโดยรวมทำงานสมดุล',
      'ยังไม่พบโอกาสประหยัดเด่นชัดจากข้อมูลช่วงนี้ ให้ติดตาม self-use, grid import และ battery SOC ต่อเนื่อง',
      `Self-use ${selfConsumption === null ? '—' : selfConsumption.toFixed(0) + '%'} · Grid import ${gridImportKwh.toFixed(1)} kWh`, 0);
  }

  let score = 100;
  if (selfConsumption !== null) score -= Math.max(0, 85 - selfConsumption) * 0.35;
  if (gridDependency !== null) score -= gridDependency * 0.35;
  if (pvKwh > 0) score -= clamp((gridExportKwh / pvKwh) * 100, 0, 100) * 0.18;
  if (battStats.min !== null && battStats.min < 20) score -= (20 - battStats.min) * 0.6;
  if (evImportOverlapKwh > 0) score -= clamp(evImportOverlapKwh * 2, 0, 8);
  score = Math.round(clamp(score, 0, 100));
  const potentialSavingThb = actions.reduce((sum, a) => sum + (a.potential_saving_thb || 0), 0);

  return {
    period,
    label: bounds.label,
    timezone: TIMEZONE,
    start: bounds.startIso,
    end: bounds.endIso,
    data_quality: calcDataQuality(samples, bounds.startIso, bounds.endIso, gap),
    energy: {
      pv_source: pvStringHasRealTotal ? 'pv_string_metrics.pv_total_power' : 'energy_metrics.pv_power',
      pv_generation_kwh: parseFloat(pvKwh.toFixed(3)),
      home_consumption_kwh: parseFloat(loadKwh.toFixed(3)),
      grid_import_kwh: parseFloat(gridImportKwh.toFixed(3)),
      grid_export_kwh: parseFloat(gridExportKwh.toFixed(3)),
      battery_charge_kwh: parseFloat(battChargeKwh.toFixed(3)),
      battery_discharge_kwh: parseFloat(battDischargeKwh.toFixed(3)),
      ev_charging_kwh: parseFloat(evKwh.toFixed(3)),
      peak_pv_kw: pvStats.max === null ? null : parseFloat(pvStats.max.toFixed(3)),
      peak_load_kw: loadStats.max === null ? null : parseFloat(loadStats.max.toFixed(3)),
      min_battery_soc: battStats.min === null ? null : parseFloat(battStats.min.toFixed(1)),
      max_battery_soc: battStats.max === null ? null : parseFloat(battStats.max.toFixed(1)),
      avg_battery_soc: battStats.avg === null ? null : parseFloat(battStats.avg.toFixed(1)),
    },
    cost: {
      rate_thb_per_kwh: GRID_COST_RATE_THB_PER_KWH,
      grid_cost_thb: parseFloat((gridImportKwh * GRID_COST_RATE_THB_PER_KWH).toFixed(2)),
      solar_value_thb: parseFloat((solarUsedKwh * GRID_COST_RATE_THB_PER_KWH).toFixed(2)),
      ev_cost_thb: parseFloat((evKwh * GRID_COST_RATE_THB_PER_KWH).toFixed(2)),
    },
    efficiency: {
      self_consumption_pct: selfConsumption === null ? null : parseFloat(selfConsumption.toFixed(1)),
      self_sufficiency_pct: selfSufficiency === null ? null : parseFloat(selfSufficiency.toFixed(1)),
      grid_dependency_pct: gridDependency === null ? null : parseFloat(gridDependency.toFixed(1)),
    },
    weather: {
      avg_cloud_cover_pct: cloudStats.avg === null ? null : parseFloat(cloudStats.avg.toFixed(1)),
      avg_ghi_wm2: ghiStats.avg === null ? null : parseFloat(ghiStats.avg.toFixed(1)),
      ghi_kwh_m2: ghiSamples.length ? parseFloat(ghiKwhM2.toFixed(3)) : null,
      avg_temperature_c: tempStats.avg === null ? null : parseFloat(tempStats.avg.toFixed(1)),
    },
    optimization: {
      score,
      status: thaiStatusFromScore(score),
      status_th: thaiStatusFromScore(score),
      status_en: englishStatusFromScore(score),
      best_solar_window: bestSolarWindow,
      grid_import_peak_window: importPeakWindow,
      solar_surplus_kwh: parseFloat(gridExportKwh.toFixed(3)),
      potential_saving_thb: parseFloat(potentialSavingThb.toFixed(2)),
      shiftable_load_opportunity_kwh: parseFloat(Math.min(gridExportKwh, Math.max(0, loadKwh * 0.3)).toFixed(3)),
      battery_full_time: batteryFullTime,
      export_after_battery_full_kwh: parseFloat(exportAfterFullKwh.toFixed(3)),
      ev_grid_charging_kwh: parseFloat(evImportOverlapKwh.toFixed(3)),
      actions: actions.slice(0, 5),
    },
    recommendations: actions.slice(0, 5).map(a => ({
      priority: a.priority,
      title_th: a.title_th,
      message_th: a.message_th,
      evidence_th: a.evidence_th,
      title_en: a.title_en,
      message_en: a.message_en,
      evidence_en: a.evidence_en,
      potential_saving_thb: a.potential_saving_thb,
    })),
  };
}

async function fetchDataHealth() {
  const now = Date.now();

  const energyFlux = `
from(bucket: "${INFLUXDB_BUCKET}")
  |> range(start: -30m)
  |> filter(fn: (r) => r._measurement == "energy_metrics" and r.station_id == "${STATION_ID}")
  |> filter(fn: (r) => r._field == "battery_soc")
  |> last()
  |> keep(columns: ["_time", "_value"])
`;
  const collectorFlux = `
from(bucket: "${INFLUXDB_BUCKET}")
  |> range(start: -30m)
  |> filter(fn: (r) => r._measurement == "mysigen_collector_health" and r.station_id == "${STATION_ID}")
  |> filter(fn: (r) => r._field == "cycle_ok" or r._field == "failure_count" or r._field == "last_success_ts")
  |> last()
  |> keep(columns: ["_field", "_value", "_time"])
`;
  const rawFlux = `
from(bucket: "${INFLUXDB_BUCKET}")
  |> range(start: -30m)
  |> filter(fn: (r) => r._measurement == "mysigen_raw_snapshots" and r.station_id == "${STATION_ID}")
  |> filter(fn: (r) => r._field == "payload_json")
  |> last()
  |> keep(columns: ["_time", "_value"])
`;
  const stationFlux = `
from(bucket: "${INFLUXDB_BUCKET}")
  |> range(start: -2h)
  |> filter(fn: (r) => r._measurement == "station_info" and r.station_id == "${STATION_ID}")
  |> filter(fn: (r) => r._field == "status" or r._field == "statusDesc" or r._field == "stationName" or r._field == "pvCapacity" or r._field == "batteryCapacity" or r._field == "timeZoneName")
  |> last()
  |> keep(columns: ["_field", "_value", "_time"])
`;

  const [energyCsv, collectorCsv, rawCsv, stationCsv] = await Promise.all([
    queryInflux(energyFlux).catch(() => ''),
    queryInflux(collectorFlux).catch(() => ''),
    queryInflux(rawFlux).catch(() => ''),
    queryInflux(stationFlux).catch(() => ''),
  ]);

  const energyRows = parseCsv(energyCsv);
  const energyTs = energyRows.length > 0 ? (energyRows[0]._time || null) : null;
  const energyAgeS = energyTs ? Math.round((now - new Date(energyTs).getTime()) / 1000) : null;
  const energyStale = energyAgeS === null || energyAgeS * 1000 > DATA_STALE_THRESHOLD_MS;

  const collectorFields = {};
  parseCsv(collectorCsv).forEach(r => { if (r._field) collectorFields[r._field] = r._value; });
  const cycleOkRaw = collectorFields.cycle_ok;
  const cycleOk = cycleOkRaw !== undefined ? (cycleOkRaw === 'true' || cycleOkRaw === '1') : null;
  const failureCount = toNumber(collectorFields.failure_count);
  const lastSuccessTs = toNumber(collectorFields.last_success_ts);
  const collectorFailed = failureCount !== null && failureCount >= COLLECTOR_FAILURE_THRESHOLD;

  const rawRows = parseCsv(rawCsv);
  const rawTs = rawRows.length > 0 ? (rawRows[0]._time || null) : null;
  const rawAgeS = rawTs ? Math.round((now - new Date(rawTs).getTime()) / 1000) : null;
  const rawStale = rawAgeS === null || rawAgeS * 1000 > DATA_STALE_THRESHOLD_MS;

  const stationFields = {};
  parseCsv(stationCsv).forEach(r => {
    if (r._field) stationFields[r._field] = toNumber(r._value) !== null ? toNumber(r._value) : r._value;
  });
  const hasStationMeta = Object.keys(stationFields).length > 0;

  let status;
  if (collectorFailed || (energyStale && rawStale)) {
    status = 'error';
  } else if (energyStale || rawStale || (failureCount !== null && failureCount > 0)) {
    status = 'warn';
  } else {
    status = 'ok';
  }

  return {
    status,
    checked_at: new Date(now).toISOString(),
    energy_metrics: { latest_ts: energyTs, age_s: energyAgeS, stale: energyStale },
    collector_health: { cycle_ok: cycleOk, failure_count: failureCount, last_success_ts: lastSuccessTs, failed: collectorFailed },
    raw_snapshots: { latest_ts: rawTs, age_s: rawAgeS, stale: rawStale },
    station_info: { available: hasStationMeta, ...stationFields },
    thresholds: { data_stale_ms: DATA_STALE_THRESHOLD_MS, collector_failure: COLLECTOR_FAILURE_THRESHOLD },
  };
}

async function buildReport() {
  const [latest, forecast, solarStats, dataHealth] = await Promise.all([fetchLatestSnapshot(), fetchForecastHours(), fetchSolarDayStats(8), fetchDataHealth().catch(() => null)]);
  const summary = forecastSummary(forecast);
  const recommendations = buildRecommendations(latest, forecast);
  return {
    generated_at: new Date().toISOString(),
    timezone: TIMEZONE,
    station_id: STATION_ID,
    latest,
    forecast: {
      next_hours: forecast,
      summary: summary.text,
      averages: summary.averages,
    },
    solar_stats: solarStats,
    recommendations,
    data_health: dataHealth,
    telegram: telegramStatusPayload(),
  };
}

function buildTelegramMessage(report) {
  const latest = report.latest || {};
  const e = latest.energy || {};
  const w = latest.weather || {};
  const d = latest.daily || {};
  const forecast = report.forecast || {};
  const lines = [
    'Sigen Solar Report',
    `เวลา: ${new Date(report.generated_at).toLocaleString('th-TH', { timeZone: TIMEZONE })}`,
    '',
    `PV: ${fmtNumber(e.pv_power, ' kW')} | Load: ${fmtNumber(e.load_power, ' kW')}`,
    `Battery: ${fmtNumber(e.battery_soc, '%', 0)} (${formatBatteryPower(e.battery_power)})`,
    `Grid: ${formatGridFlow(e.grid_flow_power)} | ${e.on_grid ? 'on-grid' : 'off-grid'}`,
    `Station: ${e.station_status === undefined ? '—' : 'code ' + e.station_status}`,
    `Weather: ${fmtNumber(w.temperature, '°C')} | wind ${fmtNumber(w.windspeed, ' km/h', 0)}`,
    `Today: PV ${fmtNumber(e.pv_day_nrg, ' kWh')} | grid idle ${formatMinutes(d.grid_idle_minutes)}`,
    report.solar_stats && report.solar_stats.today
      ? `Sun/PV: rise ${formatLocalTime(report.solar_stats.today.sunrise_time)} → PV ${formatLocalTime(report.solar_stats.today.pv_start_time)} (${formatSignedMinutes(report.solar_stats.today.start_after_sunrise_min)}), set ${formatLocalTime(report.solar_stats.today.sunset_time)} → stop ${report.solar_stats.today.producing_now ? 'producing now' : formatLocalTime(report.solar_stats.today.pv_stop_time)}`
      : 'Sun/PV: no data yet',
    '',
    `Forecast: ${forecast.summary || 'ไม่มีข้อมูล forecast'}`,
    '',
    'Recommendation:',
    ...((report.recommendations || []).map((rec, idx) => `${idx + 1}. ${rec}`)),
    '',
    'Dashboard: http://72.62.199.163:3200/',
  ];
  return lines.join('\n').slice(0, 3900);
}

async function sendTelegramReport(source = 'scheduler') {
  if (!isTelegramConfigured()) {
    const message = 'Telegram not configured: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env';
    telegramState.last_status = 'not_configured';
    telegramState.last_message = message;
    throw new Error(message);
  }
  const report = await buildReport();
  await writeSolarStatsSnapshot(report.solar_stats).catch(err => console.warn(`Solar stats snapshot write failed: ${err.message}`));
  const body = {
    chat_id: TELEGRAM_CHAT_ID,
    text: buildTelegramMessage(report),
    disable_web_page_preview: true,
  };
  if (TELEGRAM_PARSE_MODE) body.parse_mode = TELEGRAM_PARSE_MODE;
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await res.json().catch(() => ({}));
  telegramState.last_send_time = new Date().toISOString();
  telegramState.last_status = res.ok ? 'sent' : 'error';
  telegramState.last_message = res.ok ? `${source}: sent` : `${source}: Telegram HTTP ${res.status}`;
  if (!res.ok) throw new Error(`Telegram HTTP ${res.status}: ${result.description || 'send failed'}`);
  return { ok: true, message_id: result.result && result.result.message_id, report, status: telegramStatusPayload() };
}

function msUntilNextHour() {
  const now = new Date();
  const next = new Date(now);
  next.setMinutes(0, 0, 0);
  next.setHours(next.getHours() + 1);
  return Math.max(60_000, next.getTime() - now.getTime());
}

function buildAlertMessage(event, snapshot, health) {
  const e = snapshot.energy || {};
  const soc = toNumber(e.battery_soc);
  const pv = safeNumber(e.pv_power, 0);
  const load = safeNumber(e.load_power, 0);
  const now = new Date().toLocaleTimeString('th-TH', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' });
  const titles = {
    battery_full: '🔋 แบตเตอรี่เต็มแล้ว',
    battery_low: '⚠️ แบตเตอรี่เหลือน้อย',
    pv_started: '☀️ PV เริ่มผลิตไฟแล้ว',
    pv_stopped: '🌙 PV หยุดผลิตไฟแล้ว',
    grid_importing: '🔌 เริ่มใช้ไฟจากการไฟฟ้า',
    grid_idle: '✅ ระบบไม่พึ่ง grid แล้ว',
    collector_failed: '🔴 Collector หยุดทำงาน / Collector Stopped',
    collector_recovered: '✅ Collector กลับมาทำงาน / Collector Recovered',
    data_stale: '⏰ ข้อมูลเก่าเกินกำหนด / Data Stale',
    data_recovered: '✅ ข้อมูลสดกลับมา / Data Recovered',
  };

  const healthEvents = ['collector_failed', 'collector_recovered', 'data_stale', 'data_recovered'];
  if (healthEvents.includes(event) && health) {
    const ch = health.collector_health || {};
    const em = health.energy_metrics || {};
    const thresholdS = Math.round(DATA_STALE_THRESHOLD_MS / 1000);
    const ageStr = em.age_s !== null ? `${em.age_s}s` : '—';
    const failStr = ch.failure_count !== null ? String(ch.failure_count) : '—';
    let lastSuccessStr = '—';
    if (ch.last_success_ts) {
      try { lastSuccessStr = new Date(ch.last_success_ts * 1000).toLocaleTimeString('en-GB', { timeZone: TIMEZONE }); } catch (_) {}
    }
    const lines = [
      titles[event] || `แจ้งเตือน: ${event}`,
      `เวลา: ${now}`,
      '',
      `Data Age: ${ageStr} (threshold ${thresholdS}s)`,
      `Failure Count: ${failStr} (threshold ${COLLECTOR_FAILURE_THRESHOLD})`,
      `Last Success: ${lastSuccessStr}`,
      '',
      `SOC: ${soc !== null ? soc.toFixed(0) + '%' : '—'} | PV: ${pv.toFixed(2)} kW`,
      '',
      'Dashboard: http://72.62.199.163:3200/',
    ];
    return lines.join('\n').slice(0, 1000);
  }

  const lines = [
    titles[event] || `แจ้งเตือน: ${event}`,
    `เวลา: ${now}`,
    '',
    `SOC: ${soc !== null ? soc.toFixed(0) + '%' : '—'} | PV: ${pv.toFixed(2)} kW`,
    `Load: ${load.toFixed(2)} kW | Grid: ${formatGridFlow(e.grid_flow_power)}`,
    `⚡ Battery: ${formatBatteryPower(e.battery_power)}`,
    '',
    'Dashboard: http://72.62.199.163:3200/',
  ];
  return lines.join('\n').slice(0, 1000);
}

async function sendTelegramAlert(event, snapshot, health) {
  if (!isTelegramConfigured()) throw new Error('Telegram not configured');
  const message = buildAlertMessage(event, snapshot, health);
  const body = {
    chat_id: TELEGRAM_CHAT_ID,
    text: message,
    disable_web_page_preview: true,
  };
  if (TELEGRAM_PARSE_MODE) body.parse_mode = TELEGRAM_PARSE_MODE;
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await res.json().catch(() => ({}));
  alertState.last_alert_event = event;
  alertState.last_alert_time = new Date().toISOString();
  alertState.last_alert_message = message;
  alertState.last_alert_error = res.ok ? null : `Telegram HTTP ${res.status}: ${result.description || 'send failed'}`;
  if (!res.ok) throw new Error(alertState.last_alert_error);
  return { ok: true, message_id: result.result && result.result.message_id };
}

async function checkAndSendAlerts(snapshot) {
  const e = snapshot.energy || {};
  if (Object.keys(e).length === 0) {
    console.warn('Alert poll: empty energy data, skipping');
    return;
  }
  const soc = toNumber(e.battery_soc);
  const pv = safeNumber(e.pv_power, 0);
  const grid = safeNumber(e.grid_flow_power, 0);
  const isBatteryFull = soc !== null && soc >= BATTERY_FULL_SOC;
  const isBatteryLow = soc !== null && soc <= BATTERY_LOW_SOC;
  const isPvActive = pv > PV_ACTIVE_THRESHOLD_KW;
  const isGridImporting = grid < -GRID_IDLE_THRESHOLD_KW;
  const isGridIdle = Math.abs(grid) <= GRID_IDLE_THRESHOLD_KW;
  const newGridState = isGridImporting ? 'importing' : isGridIdle ? 'idle' : 'exporting';

  const health = await fetchDataHealth().catch(() => null);
  const isDataStale = health ? health.energy_metrics.stale : false;
  const isCollectorFailed = health ? health.collector_health.failed : false;

  if (!alertState.baselined) {
    alertState.battery_full = isBatteryFull;
    alertState.battery_low = isBatteryLow;
    alertState.pv_active = isPvActive;
    alertState.grid_state = newGridState;
    alertState.data_stale = isDataStale;
    alertState.collector_failed = isCollectorFailed;
    alertState.baselined = true;
    console.log(`Alert state baselined — SOC: ${soc}, PV: ${pv.toFixed(2)} kW, grid: ${newGridState}, data_stale: ${isDataStale}, collector_failed: ${isCollectorFailed}`);
    return;
  }

  const pendingAlerts = [];
  if (isBatteryFull && !alertState.battery_full) pendingAlerts.push({ event: 'battery_full', health: null });
  alertState.battery_full = isBatteryFull;
  if (isBatteryLow && !alertState.battery_low) pendingAlerts.push({ event: 'battery_low', health: null });
  alertState.battery_low = isBatteryLow;
  if (isPvActive && !alertState.pv_active) pendingAlerts.push({ event: 'pv_started', health: null });
  if (!isPvActive && alertState.pv_active) pendingAlerts.push({ event: 'pv_stopped', health: null });
  alertState.pv_active = isPvActive;
  if (isGridImporting && alertState.grid_state !== 'importing') pendingAlerts.push({ event: 'grid_importing', health: null });
  if (isGridIdle && alertState.grid_state !== 'idle') pendingAlerts.push({ event: 'grid_idle', health: null });
  alertState.grid_state = newGridState;
  if (isCollectorFailed && !alertState.collector_failed) pendingAlerts.push({ event: 'collector_failed', health });
  if (!isCollectorFailed && alertState.collector_failed) pendingAlerts.push({ event: 'collector_recovered', health });
  alertState.collector_failed = isCollectorFailed;
  if (isDataStale && !alertState.data_stale) pendingAlerts.push({ event: 'data_stale', health });
  if (!isDataStale && alertState.data_stale) pendingAlerts.push({ event: 'data_recovered', health });
  alertState.data_stale = isDataStale;

  for (const { event, health: h } of pendingAlerts) {
    await sendTelegramAlert(event, snapshot, h).catch(err => {
      console.warn(`Alert send failed [${event}]: ${err.message}`);
    });
  }
}

function startAlertScheduler() {
  if (!TELEGRAM_ALERTS_ENABLED) {
    console.log('Telegram event alerts disabled; set TELEGRAM_ALERTS_ENABLED=true to enable.');
    return;
  }
  if (!isTelegramConfigured()) {
    console.log('Telegram event alerts not configured; set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to enable.');
    return;
  }
  const run = () => fetchLatestSnapshot()
    .then(snapshot => checkAndSendAlerts(snapshot))
    .catch(err => console.warn(`Alert poll failed: ${err.message}`));
  run();
  setInterval(run, TELEGRAM_ALERT_INTERVAL_MS);
  console.log(`Telegram event alert scheduler started, polling every ${Math.round(TELEGRAM_ALERT_INTERVAL_MS / 1000)}s.`);
}

function startTelegramScheduler() {
  if (!TELEGRAM_REPORT_ENABLED) {
    telegramState.last_status = 'disabled';
    telegramState.last_message = 'Hourly Telegram report disabled';
    return;
  }
  if (!isTelegramConfigured()) {
    telegramState.last_status = 'not_configured';
    telegramState.last_message = 'Telegram scheduler waiting for TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID';
    console.log('Telegram hourly report not configured; set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to enable.');
    return;
  }
  const run = () => sendTelegramReport('scheduler').catch(err => console.warn(`Telegram hourly report failed: ${err.message}`));
  const firstDelayMs = msUntilNextHour();
  setTimeout(() => {
    run();
    setInterval(run, TELEGRAM_REPORT_INTERVAL_MS);
  }, firstDelayMs);
  telegramState.last_status = 'scheduled';
  telegramState.last_message = `Hourly Telegram report scheduled for next clock hour, then every ${Math.round(TELEGRAM_REPORT_INTERVAL_MS / 60000)} minutes`;
  console.log(`Telegram hourly report scheduled in ${Math.round(firstDelayMs / 60000)} minutes, then every ${Math.round(TELEGRAM_REPORT_INTERVAL_MS / 60000)} minutes.`);
}

// ── Cockpit helpers ─────────────────────────────────────────────────────────

function deriveCockpitIntent(e) {
  const pv = toNumber(e.pv_power);
  const grid = toNumber(e.grid_flow_power);
  const battery = toNumber(e.battery_power);
  const ev = toNumber(e.ev_power);
  const THRESH = 0.05;

  if (pv === null && grid === null && battery === null) {
    return { primary: 'Waiting for fresh telemetry', secondary: [], state: 'no_data' };
  }

  const pvActive = pv !== null && pv > THRESH;
  const gridImporting = grid !== null && grid < -THRESH;
  const gridExporting = grid !== null && grid > THRESH;
  const battCharging = battery !== null && battery > THRESH;
  const battDischarging = battery !== null && battery < -THRESH;
  const evActive = ev !== null && ev > THRESH;

  const secondary = [];
  let primary, state;

  if (pvActive) {
    if (battCharging && !gridExporting) {
      primary = 'Charging battery from solar';
      state = 'solar_charging_battery';
    } else if (gridExporting) {
      primary = 'Exporting solar surplus to grid';
      state = 'solar_export';
    } else {
      primary = 'Using solar for home load';
      state = 'solar_to_home';
    }
    if (battCharging) secondary.push('Battery charging');
    if (gridImporting) secondary.push(`Importing ${Math.abs(grid).toFixed(2)} kW from grid`);
  } else if (battDischarging) {
    primary = 'Battery supporting home load';
    state = 'battery_to_home';
    if (gridImporting) secondary.push(`Importing ${Math.abs(grid).toFixed(2)} kW from grid`);
  } else if (gridImporting) {
    primary = 'Importing from grid for home load';
    state = 'grid_to_home';
  } else if (gridExporting) {
    primary = 'Exporting to grid';
    state = 'grid_export';
  } else {
    primary = 'System idle';
    state = 'idle';
  }

  if (evActive) secondary.push('EV charging from load bus');
  return { primary, secondary, state };
}

function buildCockpitFlows(e) {
  const THRESH = 0.05;
  const flows = [];

  const pv = toNumber(e.pv_power);
  const grid = toNumber(e.grid_flow_power);
  const battery = toNumber(e.battery_power);
  const ev = toNumber(e.ev_power);

  if (pv !== null) {
    flows.push({ from: 'PV', to: 'Home', kw: parseFloat(Math.max(0, pv).toFixed(3)), active: pv > THRESH, type: 'solar' });
  }

  if (grid !== null) {
    if (grid < -THRESH) {
      flows.push({ from: 'Grid', to: 'Home', kw: parseFloat(Math.abs(grid).toFixed(3)), active: true, type: 'grid_import' });
    } else if (grid > THRESH) {
      flows.push({ from: 'Home', to: 'Grid', kw: parseFloat(grid.toFixed(3)), active: true, type: 'grid_export' });
    } else {
      flows.push({ from: 'Grid', to: 'Home', kw: 0, active: false, type: 'grid_idle' });
    }
  }

  if (battery !== null) {
    if (battery > THRESH) {
      flows.push({ from: 'Home', to: 'Battery', kw: parseFloat(battery.toFixed(3)), active: true, type: 'battery_charge' });
    } else if (battery < -THRESH) {
      flows.push({ from: 'Battery', to: 'Home', kw: parseFloat(Math.abs(battery).toFixed(3)), active: true, type: 'battery_discharge' });
    } else {
      flows.push({ from: 'Battery', to: 'Home', kw: 0, active: false, type: 'battery_idle' });
    }
  }

  if (ev !== null && ev > THRESH) {
    flows.push({ from: 'Home', to: 'DC Charger', kw: parseFloat(ev.toFixed(3)), active: true, type: 'ev_charging' });
  }

  return flows;
}

function buildCockpitBattery(snapshot) {
  const e = snapshot.energy || {};
  const batMeta = snapshot.battery || {};
  const power = toNumber(e.battery_power);
  const soc = toNumber(e.battery_soc);
  const THRESH = 0.05;

  let mode = 'unknown';
  if (power !== null) {
    if (power > THRESH) mode = 'charging';
    else if (power < -THRESH) mode = 'discharging';
    else mode = 'idle';
  }

  const totalKwh = toNumber(batMeta.total_capacity_kwh);
  const storedKwh = (soc !== null && totalKwh !== null)
    ? parseFloat(((soc / 100) * totalKwh).toFixed(2))
    : null;

  let time_estimate = null;
  if (power !== null && Math.abs(power) > THRESH && storedKwh !== null && totalKwh !== null) {
    if (mode === 'discharging') {
      const h = storedKwh / Math.abs(power);
      time_estimate = `${Math.floor(h)}h ${Math.round((h % 1) * 60)}m remaining`;
    } else if (mode === 'charging') {
      const h = (totalKwh - storedKwh) / power;
      if (h > 0) time_estimate = `${Math.floor(h)}h ${Math.round((h % 1) * 60)}m to full`;
    }
  }

  const modules = (snapshot.battery_modules || []).map(m => {
    const entry = { battery_index: m.battery_index, device_sn: m.device_sn || null };
    const mSoc = toNumber(m.battery_soc);
    const mVolt = toNumber(m.voltage);
    const mTemp = toNumber(m.temperature);
    if (mSoc !== null) entry.soc = parseFloat(mSoc.toFixed(1));
    if (mVolt !== null) entry.voltage = parseFloat(mVolt.toFixed(2));
    if (mTemp !== null) entry.temperature = parseFloat(mTemp.toFixed(1));
    return entry;
  });

  return { mode, soc, power_kw: power, stored_kwh: storedKwh, time_estimate, modules };
}

function buildCockpitDcCharger(e) {
  const ev = toNumber(e.ev_power);
  let status = 'no_data';
  if (ev !== null) status = ev > 0.05 ? 'charging' : 'idle';
  return {
    status,
    power_kw: ev,
    route: 'Home / Load Bus → DC Charger → Tesla Model Y',
  };
}

function buildCockpitTesla(teslaData) {
  if (!teslaData || !teslaData.has_data) {
    return { status: 'no_data', vehicle_name: null, soc_pct: null, charge_state: null, charger_power_kw: null, latest_time: null };
  }
  const charge = teslaData.charge || {};
  const vehicle = teslaData.vehicle || {};
  return {
    status: 'ok',
    vehicle_name: vehicle.vehicle_name || null,
    soc_pct: toNumber(charge.battery_level_pct),
    charge_state: charge.charging_state || null,
    charger_power_kw: toNumber(charge.charger_power_kw),
    latest_time: teslaData.latest_time || null,
  };
}

function buildCockpitWeather(weather) {
  if (!weather || !Object.keys(weather).length) {
    return { status: 'no_data', temperature_c: null, humidity_pct: null, wind_speed_kmh: null, condition_code: null };
  }
  const temp = toNumber(weather.temperature);
  const hum = toNumber(weather.humidity);
  const wind = toNumber(weather.windspeed);
  const code = toNumber(weather.weathercode);
  return {
    status: 'ok',
    temperature_c: temp !== null ? parseFloat(temp.toFixed(1)) : null,
    humidity_pct: hum !== null ? parseFloat(hum.toFixed(1)) : null,
    wind_speed_kmh: wind !== null ? parseFloat(wind.toFixed(1)) : null,
    condition_code: code,
  };
}

function buildCockpitDataQuality(snapshot) {
  const ts = snapshot.timestamp || null;
  const age_seconds = ts ? Math.round((Date.now() - new Date(ts).getTime()) / 1000) : null;
  const stale = age_seconds === null || age_seconds * 1000 > DATA_STALE_THRESHOLD_MS;
  return { latest_time: ts, age_seconds, stale };
}

// ── End cockpit helpers ──────────────────────────────────────────────────────

app.use(express.json({ limit: '64kb' }));
app.use(basicAuth);
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '5m',
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    const base = path.basename(filePath);
    if (base === 'index.html' || base === 'app.js' || base === 'styles.css') {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  },
}));

// Serve Apache ECharts from node_modules; no browser CDN and no token exposure.
app.get('/vendor/echarts.min.js', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
  res.sendFile(path.join(__dirname, 'node_modules/echarts/dist/echarts.min.js'));
});

app.get('/image.png', (req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="430"><defs><radialGradient id="a" cx="50%" cy="20%" r="65%"><stop offset="0%" stop-color="#35d07f" stop-opacity=".14"/><stop offset="100%" stop-color="#070b12" stop-opacity="0"/></radialGradient><radialGradient id="b" cx="17%" cy="65%" r="48%"><stop offset="0%" stop-color="#f7c948" stop-opacity=".11"/><stop offset="100%" stop-color="#070b12" stop-opacity="0"/></radialGradient><radialGradient id="c" cx="83%" cy="65%" r="48%"><stop offset="0%" stop-color="#b47cff" stop-opacity=".13"/><stop offset="100%" stop-color="#070b12" stop-opacity="0"/></radialGradient></defs><rect width="800" height="430" fill="#080d16"/><rect width="800" height="430" fill="url(#a)"/><rect width="800" height="430" fill="url(#b)"/><rect width="800" height="430" fill="url(#c)"/></svg>');
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


app.get('/api/summary', async (req, res) => {
  try {
    res.json(await fetchSummary(req.query.period || req.query.range || 'day'));
  } catch (err) {
    apiError(res, err);
  }
});

app.get('/api/latest', async (req, res) => {
  try {
    res.json(await fetchLatestSnapshot());
  } catch (err) {
    apiError(res, err);
  }
});

app.get('/api/today-recommendation', async (req, res) => {
  try {
    res.json(await fetchTodayRecommendation());
  } catch (err) {
    apiError(res, err);
  }
});

app.get('/api/realtime-energy', async (req, res) => {
  try {
    const fields = ['pv_power', 'load_power', 'grid_flow_power', 'battery_soc', 'battery_power'];
    const fieldFilter = fields.map(f => `r._field == "${f}"`).join(' or ');
    const flux = `
from(bucket: "${INFLUXDB_BUCKET}")
  |> range(start: -15m)
  |> filter(fn: (r) => r._measurement == "energy_metrics" and r.station_id == "${STATION_ID}")
  |> filter(fn: (r) => ${fieldFilter})
  |> last()
  |> keep(columns: ["_field", "_value", "_time"])
`;
    const csv = await queryInflux(flux);
    const rows = parseCsv(csv);
    const raw = {};
    let timestamp = null;
    rows.forEach(r => {
      raw[r._field] = toNumber(r._value);
      if (!timestamp && r._time) timestamp = r._time;
    });
    res.json({
      timestamp,
      pv: { value: raw.pv_power ?? null, unit: 'kW' },
      homeLoad: { value: raw.load_power ?? null, unit: 'kW' },
      grid: { value: raw.grid_flow_power ?? null, unit: 'kW' },
      batterySoc: { value: raw.battery_soc ?? null, unit: '%' },
      batteryPower: { value: raw.battery_power ?? null, unit: 'kW' },
      raw,
    });
  } catch (err) {
    apiError(res, err);
  }
});

app.get('/api/cockpit', async (req, res) => {
  try {
    const [snapshot, teslaData] = await Promise.all([
      fetchLatestSnapshot(),
      fetchTeslaLatest().catch(() => ({ has_data: false })),
    ]);

    const e = snapshot.energy || {};
    const dataQuality = buildCockpitDataQuality(snapshot);
    const intent = dataQuality.stale
      ? { primary: 'Waiting for fresh telemetry', secondary: [], state: 'stale' }
      : deriveCockpitIntent(e);

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      refresh_interval_seconds: SLEEP_INTERVAL_S,
      latest: {
        pv_power: toNumber(e.pv_power),
        load_power: toNumber(e.load_power),
        grid_flow_power: toNumber(e.grid_flow_power),
        battery_power: toNumber(e.battery_power),
        battery_soc: toNumber(e.battery_soc),
        ev_power: toNumber(e.ev_power),
      },
      intent,
      flows: buildCockpitFlows(e),
      battery: buildCockpitBattery(snapshot),
      dc_charger: buildCockpitDcCharger(e),
      tesla: buildCockpitTesla(teslaData),
      weather: buildCockpitWeather(snapshot.weather || {}),
      data_quality: dataQuality,
    });
  } catch (err) {
    apiError(res, err);
  }
});

app.get('/api/report', async (req, res) => {
  try {
    res.json(await buildReport());
  } catch (err) {
    apiError(res, err);
  }
});

app.get('/api/data-health', async (req, res) => {
  try {
    res.json(await fetchDataHealth());
  } catch (err) {
    apiError(res, err);
  }
});

app.get('/api/solar-stats', async (req, res) => {
  try {
    res.json(await fetchSolarDayStats(req.query.days || 8));
  } catch (err) {
    apiError(res, err);
  }
});

app.get('/api/weather-vs-actual', async (req, res) => {
  try {
    const dateKey = parseLocalDate(req.query.date, WEATHER_TIMEZONE);
    res.json(await fetchWeatherVsActual(dateKey));
  } catch (err) {
    apiError(res, err);
  }
});

app.get('/api/energy-source-mix', async (req, res) => {
  try {
    const dateKey = parseLocalDate(req.query.date, TIMEZONE);
    res.json(await fetchEnergySourceMixForDate(dateKey));
  } catch (err) {
    apiError(res, err);
  }
});

app.get('/api/grid-cost', async (req, res) => {
  try {
    const days = parseInt(req.query.days, 10) === 30 ? 30 : 7;
    res.json(await fetchGridCostStats(days));
  } catch (err) {
    apiError(res, err);
  }
});

app.get('/api/battery-full-time', async (req, res) => {
  try {
    const days = parseInt(req.query.days, 10) || 7;
    res.json(await fetchBatteryFullTimeStats(days));
  } catch (err) {
    apiError(res, err);
  }
});

app.get('/api/dc-charger-cost', async (req, res) => {
  try {
    res.json(await fetchDcChargerCostStats());
  } catch (err) {
    apiError(res, err);
  }
});

app.get('/api/tesla/latest', async (req, res) => {
  try {
    res.json(await fetchTeslaLatest());
  } catch (err) {
    apiError(res, err);
  }
});

app.get('/api/tesla/history', async (req, res) => {
  try {
    const range = req.query.range || '24h';
    res.json(await fetchTeslaHistory(range));
  } catch (err) {
    apiError(res, err, err.status || 503);
  }
});

app.get('/api/tesla/session-context', async (req, res) => {
  try {
    res.json(await fetchTeslaSessionContext());
  } catch (err) {
    apiError(res, err);
  }
});

app.get('/api/solar-hybrid-insight', async (req, res) => {
  try {
    res.json(await fetchSolarHybridInsight());
  } catch (err) {
    apiError(res, err);
  }
});

app.get('/api/telegram/status', (req, res) => {
  res.json(telegramStatusPayload());
});

app.post('/api/telegram/send-test', async (req, res) => {
  try {
    const result = await sendTelegramReport('manual-test');
    res.json({ ok: true, message_id: result.message_id, status: result.status });
  } catch (err) {
    const status = isTelegramConfigured() ? 502 : 400;
    res.status(status).json({ ok: false, error: err.message, status: telegramStatusPayload() });
  }
});

app.post('/api/telegram/send-alert-test', async (req, res) => {
  try {
    if (!isTelegramConfigured()) {
      return res.status(400).json({ ok: false, error: 'Telegram not configured: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env' });
    }
    const validEvents = ['battery_full', 'battery_low', 'pv_started', 'pv_stopped', 'grid_importing', 'grid_idle', 'collector_failed', 'collector_recovered', 'data_stale', 'data_recovered'];
    const healthEvents = ['collector_failed', 'collector_recovered', 'data_stale', 'data_recovered'];
    const event = (req.body && req.body.event) || 'battery_full';
    if (!validEvents.includes(event)) {
      return res.status(400).json({ ok: false, error: `Invalid event. Valid: ${validEvents.join(', ')}` });
    }
    const snapshot = await fetchLatestSnapshot();
    const health = healthEvents.includes(event) ? await fetchDataHealth().catch(() => null) : null;
    const result = await sendTelegramAlert(event, snapshot, health);
    res.json({ ok: true, message_id: result.message_id, status: telegramStatusPayload() });
  } catch (err) {
    const httpStatus = isTelegramConfigured() ? 502 : 400;
    res.status(httpStatus).json({ ok: false, error: err.message, status: telegramStatusPayload() });
  }
});

app.get('/api/history', async (req, res) => {
  try {
    const fields = ['pv_power', 'load_power', 'grid_flow_power', 'battery_power',
      'battery_soc', 'pv_day_nrg', 'on_grid', 'station_status', 'grid_idle'];
    const fieldFilter = fields.map(f => `r._field == "${f}"`).join(' or ');

    if (req.query.date) {
      const dateKey = parseLocalDate(req.query.date, TIMEZONE);
      const { startIso, endIso } = localDayUtcBounds(dateKey, TIMEZONE);
      const flux = `
from(bucket: "${INFLUXDB_BUCKET}")
  |> range(start: ${startIso}, stop: ${endIso})
  |> filter(fn: (r) => r._measurement == "energy_metrics" and r.station_id == "${STATION_ID}")
  |> filter(fn: (r) => ${fieldFilter})
  |> aggregateWindow(every: 15m, fn: mean, createEmpty: false)
  |> keep(columns: ["_time", "_field", "_value"])
`;
      const csv = await queryInflux(flux);
      const rows = parseCsv(csv);
      const series = {};
      rows.forEach(r => {
        if (!series[r._field]) series[r._field] = [];
        const v = toNumber(r._value);
        if (v !== null) series[r._field].push({ time: r._time, value: v });
      });
      return res.json({ date: dateKey, window: '15m', series });
    }

    let range = req.query.range || '2h';
    if (!ALLOWED_RANGES.includes(range)) range = '2h';
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
    const series = {};
    rows.forEach(r => {
      if (!series[r._field]) series[r._field] = [];
      const v = toNumber(r._value);
      if (v !== null) series[r._field].push({ time: r._time, value: v });
    });
    res.json({ range, window, series });
  } catch (err) {
    apiError(res, err);
  }
});

app.get('/api/sun-path', (req, res) => {
  try {
    const lat = SITE_LATITUDE;
    const lng = SITE_LONGITUDE;
    const tz = SITE_TIMEZONE;
    const now = new Date();

    const fmtEvent = (d) => d instanceof Date && !isNaN(d)
      ? { iso: d.toISOString(), local: d.toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit' }) }
      : null;

    const allArraysExposure = (sunAzDeg, sunAltRad) =>
      PV_ARRAYS.map(arr => ({
        id: arr.id,
        name: arr.name,
        color: arr.color,
        panel_azimuth_deg: arr.azimuth,
        panel_tilt_deg: Number.isFinite(arr.tilt) ? arr.tilt : DEFAULT_PANEL_TILT_DEG,
        ...panelExposure(sunAzDeg, sunAltRad, arr.azimuth, arr.tilt),
      }));

    const buildSamples = (dateStr) => {
      const samples = [];
      for (let totalMin = 5 * 60; totalMin <= 19 * 60; totalMin += 15) {
        const h = Math.floor(totalMin / 60);
        const m = totalMin % 60;
        const d = localTimeToDate(dateStr, h, m, tz);
        const p = SunCalc.getPosition(d, lat, lng);
        const azDeg = sunCalcAzToNorth(p.azimuth);
        samples.push({
          time_local: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
          datetime_iso: d.toISOString(),
          azimuth_deg: parseFloat(azDeg.toFixed(2)),
          altitude_deg: parseFloat((p.altitude * 180 / Math.PI).toFixed(2)),
          arrays: allArraysExposure(azDeg, p.altitude).map(a => ({
            id: a.id, exposure_score: a.exposure_score, status: a.status, in_front: a.in_front,
          })),
        });
      }
      return samples;
    };

    // Current sun position
    const pos = SunCalc.getPosition(now, lat, lng);
    const curAzDeg = sunCalcAzToNorth(pos.azimuth);
    const current = {
      timestamp: now.toISOString(),
      azimuth_deg: parseFloat(curAzDeg.toFixed(2)),
      altitude_deg: parseFloat((pos.altitude * 180 / Math.PI).toFixed(2)),
      is_day: pos.altitude > 0,
      arrays: allArraysExposure(curAzDeg, pos.altitude),
    };

    // Today's events
    const todayDateStr = new Intl.DateTimeFormat('sv-SE', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now);
    const todayTimes = SunCalc.getTimes(localTimeToDate(todayDateStr, 12, 0, tz), lat, lng);
    const daylightMinutes = (todayTimes.sunset instanceof Date && todayTimes.sunrise instanceof Date)
      ? Math.round((todayTimes.sunset.getTime() - todayTimes.sunrise.getTime()) / 60000)
      : null;
    const events = {
      sunrise: fmtEvent(todayTimes.sunrise),
      solar_noon: fmtEvent(todayTimes.solarNoon),
      sunset: fmtEvent(todayTimes.sunset),
      dawn: fmtEvent(todayTimes.dawn),
      dusk: fmtEvent(todayTimes.dusk),
      daylight_minutes: daylightMinutes,
    };

    // Today path samples and ranked exposure
    const pathSamples = buildSamples(todayDateStr);
    const summarizeTodayArray = (arr) => {
      const merged = pathSamples.map(s => ({ ...s, ...s.arrays.find(a => a.id === arr.id) }));
      const frontWin = merged.filter(s => s.in_front);
      const usefulWin = merged.filter(s => s.exposure_score > 5);
      const best = merged.reduce((b, s) => s.exposure_score > (b ? b.exposure_score : -Infinity) ? s : b, null);
      return {
        front_window: frontWin.length ? { start: frontWin[0].time_local, end: frontWin[frontWin.length - 1].time_local, count: frontWin.length } : null,
        useful_window: usefulWin.length ? { start: usefulWin[0].time_local, end: usefulWin[usefulWin.length - 1].time_local, count: usefulWin.length } : null,
        best_sample: best ? {
          time_local: best.time_local,
          exposure_score: best.exposure_score,
          altitude_deg: best.altitude_deg,
          azimuth_deg: best.azimuth_deg,
          status: best.status,
        } : null,
      };
    };
    const arrayExposure = allArraysExposure(curAzDeg, pos.altitude)
      .map(a => ({ ...a, ...summarizeTodayArray(PV_ARRAYS.find(arr => arr.id === a.id) || a) }))
      .sort((a, b) => b.exposure_score - a.exposure_score);

    // Seasonal: spring equinox, summer solstice, autumn equinox, winter solstice
    const yr = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric' }).format(now), 10);
    const seasonal = [
      { label: 'spring_equinox', date: `${yr}-03-20` },
      { label: 'summer_solstice', date: `${yr}-06-21` },
      { label: 'autumn_equinox', date: `${yr}-09-22` },
      { label: 'winter_solstice', date: `${yr}-12-21` },
    ].map(({ label, date }) => {
      const anchor = localTimeToDate(date, 12, 0, tz);
      const dayTimes = SunCalc.getTimes(anchor, lat, lng);
      const daySamples = buildSamples(date);

      const arrays = PV_ARRAYS.map(arr => {
        const merged = daySamples.map(s => ({ ...s, ...s.arrays.find(a => a.id === arr.id) }));
        const frontWin = merged.filter(s => s.in_front);
        const usefulWin = merged.filter(s => s.exposure_score > 5);
        const best = merged.reduce((b, s) => s.exposure_score > (b ? b.exposure_score : -Infinity) ? s : b, null);
        return {
          id: arr.id, name: arr.name, color: arr.color,
          front_window: frontWin.length
            ? { start: frontWin[0].time_local, end: frontWin[frontWin.length - 1].time_local, count: frontWin.length }
            : null,
          useful_window: usefulWin.length
            ? { start: usefulWin[0].time_local, end: usefulWin[usefulWin.length - 1].time_local, count: usefulWin.length }
            : null,
          best_sample: best ? {
            time_local: best.time_local, exposure_score: best.exposure_score,
            altitude_deg: best.altitude_deg, azimuth_deg: best.azimuth_deg, status: best.status,
          } : null,
        };
      });

      return {
        label, date,
        events: {
          sunrise: fmtEvent(dayTimes.sunrise),
          solar_noon: fmtEvent(dayTimes.solarNoon),
          sunset: fmtEvent(dayTimes.sunset),
        },
        path_samples: daySamples,
        arrays,
      };
    });

    res.json({
      generated_at: now.toISOString(),
      site: { latitude: lat, longitude: lng, timezone: tz },
      pv_arrays: PV_ARRAYS,
      current,
      events,
      array_exposure: arrayExposure,
      path_samples: pathSamples,
      seasonal,
    });
  } catch (err) {
    apiError(res, err);
  }
});

app.listen(PORT, () => {
  console.log(`Apache ECharts dashboard listening on port ${PORT}`);
  console.log(`InfluxDB: ${INFLUXDB_URL}, org: ${INFLUXDB_ORG}, bucket: ${INFLUXDB_BUCKET}`);
  startTelegramScheduler();
  startAlertScheduler();
});
