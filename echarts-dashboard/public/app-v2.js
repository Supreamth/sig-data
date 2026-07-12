(() => {
  'use strict';

  const BASE_MS = 15000;
  const MAX_BACKOFF_MS = 120000;
  let refreshTimer = null;
  let consecutiveErrors = 0;

  function el(id) { return document.getElementById(id); }

  function setText(id, val) {
    const n = el(id);
    if (n) n.textContent = val;
  }

  function localTime(isoStr) {
    const d = isoStr ? new Date(isoStr) : new Date();
    return d.toLocaleTimeString('th-TH', {
      timeZone: 'Asia/Bangkok',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  }

  function setDot(id, state) {
    const n = el(id);
    if (n) n.className = 'dot ' + (state || '');
  }

  function setLiveBadge(state) {
    const badge = el('live-badge');
    if (!badge) return;
    badge.className = 'live-badge ' + state;
    badge.textContent = state === 'live' ? 'LIVE' : state === 'offline' ? 'OFFLINE' : 'syncing';
  }

  // null/undefined → true (no telemetry). real 0 → false (has telemetry).
  function isNullish(val) { return val === null || val === undefined; }

  function fmtKw(val, decimals) {
    if (isNullish(val)) return '—';
    return val.toFixed(decimals !== undefined ? decimals : 2);
  }

  // ── Live / offline state ─────────────────────────────────────────────────────

  function applyLiveState(data) {
    const dq = data.data_quality || {};
    const stale = dq.stale;
    const isLive = data.status === 'ok' && !stale;

    setLiveBadge(isLive ? 'live' : stale ? 'syncing' : 'offline');
    document.body.classList.toggle('is-offline', !isLive);

    setText('cb-updated', localTime(null));

    if (dq.latest_time) {
      const ts = localTime(dq.latest_time);
      setText('db-ts', ts);
      setText('dh-db-ts', ts);
      setDot('db-dot', stale ? 'warn' : 'on');
    } else {
      setDot('db-dot', 'off');
    }

    const ageStr = !isNullish(dq.age_seconds) ? dq.age_seconds + 's ago' : '—';
    const statusLabel = data.status !== 'ok' ? 'ERROR' : stale ? 'STALE' : 'OK';
    setText('dh-status', statusLabel);
    setText('dh-checked', 'Freshness: ' + ageStr);

    const healthCard = el('health-v2');
    if (healthCard) {
      healthCard.classList.remove('health-ok', 'health-warn', 'health-err');
      healthCard.classList.add(
        data.status !== 'ok' ? 'health-err' : stale ? 'health-warn' : 'health-ok'
      );
    }
  }

  // ── KPI ribbon ───────────────────────────────────────────────────────────────

  function applyKpis(data) {
    const lat = data.latest || {};

    // PV Now
    if (isNullish(lat.pv_power)) {
      setText('kpi-pv', '—');
      setText('kpi-pv-sub', 'No telemetry');
    } else {
      setText('kpi-pv', lat.pv_power.toFixed(2));
      setText('kpi-pv-sub', 'kW solar production');
    }

    // Home Load
    setText('kpi-load', isNullish(lat.load_power) ? '—' : lat.load_power.toFixed(2));

    // Grid Flow + grid-state chip
    if (isNullish(lat.grid_flow_power)) {
      setText('kpi-grid', '—');
      setText('kpi-grid-sub', '—');
      setText('grid-state', '—');
      setDot('grid-dot', '');
    } else {
      const gf = lat.grid_flow_power;
      setText('kpi-grid', gf.toFixed(2));
      if (gf > 0.05) {
        setText('kpi-grid-sub', 'kW exporting');
        setText('grid-state', 'Export');
        setDot('grid-dot', 'on');
      } else if (gf < -0.05) {
        setText('kpi-grid-sub', 'kW importing');
        setText('grid-state', 'Import');
        setDot('grid-dot', 'warn');
      } else {
        setText('kpi-grid-sub', 'Grid idle');
        setText('grid-state', 'Idle');
        setDot('grid-dot', 'on');
      }
    }

    // Battery SOC
    if (isNullish(lat.battery_soc)) {
      setText('kpi-soc', '—');
      setText('kpi-soc-sub', '—');
    } else {
      setText('kpi-soc', Math.round(lat.battery_soc) + '%');
      const mode = (data.battery || {}).mode;
      setText('kpi-soc-sub', mode || '—');
    }

    // Weather
    const wx = data.weather || {};
    if (wx.status === 'ok' && !isNullish(wx.temperature_c)) {
      setText('kpi-weather', wx.temperature_c.toFixed(0) + '°C');
      setText('kpi-weather-sub',
        !isNullish(wx.humidity_pct) ? Math.round(wx.humidity_pct) + '% humidity' : '—');
    } else {
      setText('kpi-weather', '—');
      setText('kpi-weather-sub', 'No data');
    }
    // Grid idle, grid cost, self-use: not in cockpit response — leave at dash
  }

  // ── Energy Intent card ───────────────────────────────────────────────────────

  function applyIntent(data) {
    const intent = data.intent || {};
    const primary = intent.primary || 'Waiting for telemetry…';
    const state = (intent.state || '').replace(/_/g, ' ');
    const secondary = Array.isArray(intent.secondary) ? intent.secondary : [];

    setText('intent-primary', primary);
    setText('intent-chip', state || '—');

    const bullets = el('intent-bullets');
    if (bullets) {
      if (secondary.length > 0) {
        bullets.innerHTML = secondary.map(function(s) {
          return '<li>' + s.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</li>';
        }).join('');
      } else {
        bullets.innerHTML = '<li>—</li>';
      }
    }
  }

  // ── Battery side card ────────────────────────────────────────────────────────

  function applyBattery(data) {
    const batt = data.battery || {};

    setText('battery-mode-badge', batt.mode || '—');

    const soc = batt.soc;
    const ring = el('soc-ring');
    if (!isNullish(soc)) {
      setText('side-soc', Math.round(soc) + '%');
      if (ring) ring.style.setProperty('--soc', soc);
    } else {
      setText('side-soc', '—');
      if (ring) ring.style.setProperty('--soc', 0);
    }

    setText('side-batt-power',
      isNullish(batt.power_kw) ? '—' : fmtKw(batt.power_kw) + ' kW');
    setText('side-batt-stored',
      isNullish(batt.stored_kwh) ? '—' : batt.stored_kwh.toFixed(1) + ' kWh');
    setText('side-batt-time', batt.time_estimate || '—');
  }

  // ── DC Charger / Tesla side card ─────────────────────────────────────────────

  function applyDcCharger(data) {
    const dc = data.dc_charger || {};
    const status = dc.status || 'no_data';

    const badgeLabel = status === 'no_data' ? 'No data'
      : status === 'charging' ? 'Charging'
      : status === 'idle' ? 'Idle' : status;
    setText('dc-status-badge', badgeLabel);

    const badge = el('dc-status-badge');
    if (badge) {
      badge.classList.remove('badge-charging', 'badge-idle', 'badge-nodata');
      badge.classList.add(
        status === 'charging' ? 'badge-charging' :
        status === 'idle' ? 'badge-idle' : 'badge-nodata'
      );
    }

    setText('side-dc-power',
      isNullish(dc.power_kw) ? '—' : fmtKw(dc.power_kw) + ' kW');
    setText('side-dc-status',
      status === 'no_data' ? 'No telemetry' : badgeLabel);
  }

  // ── Flow chips (text summary of active flows) ────────────────────────────────

  const FLOW_TYPE_CLASSES = {
    solar:            'chip-solar',
    grid_import:      'chip-grid',
    grid_export:      'chip-grid',
    grid_idle:        'chip-muted',
    battery_charge:   'chip-battery',
    battery_discharge:'chip-battery',
    battery_idle:     'chip-muted',
    ev_charging:      'chip-dc',
  };

  function applyFlows(data) {
    const flows = Array.isArray(data.flows) ? data.flows : [];
    const canvas = el('flow-canvas');
    if (!canvas) return;

    const existing = el('flow-chips');
    if (existing) existing.remove();

    const active = flows.filter(function(f) { return f.active; });
    if (active.length === 0) return;

    const wrap = document.createElement('div');
    wrap.id = 'flow-chips';
    wrap.className = 'flow-chips';

    active.forEach(function(f) {
      const chip = document.createElement('span');
      const cls = FLOW_TYPE_CLASSES[f.type] || 'chip-muted';
      chip.className = 'flow-chip ' + cls;
      chip.textContent = f.from + ' → ' + f.to + ' · ' + f.kw.toFixed(2) + ' kW';
      wrap.appendChild(chip);
    });

    canvas.appendChild(wrap);
  }

  // ── Offline / error state ────────────────────────────────────────────────────

  function applyOffline() {
    setLiveBadge('offline');
    document.body.classList.add('is-offline');
    setText('cb-updated', localTime(null));
    setText('dh-status', 'OFFLINE');
    setText('dh-checked', 'Failed ' + localTime(null));
    setDot('station-dot', 'off');
    setDot('db-dot', 'off');
    setDot('grid-dot', 'off');

    const healthCard = el('health-v2');
    if (healthCard) {
      healthCard.classList.remove('health-ok', 'health-warn');
      healthCard.classList.add('health-err');
    }
  }

  // ── Fetch loop ───────────────────────────────────────────────────────────────

  function fetchCockpit() {
    return fetch('/api/cockpit')
      .then(function(res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function(data) {
        consecutiveErrors = 0;
        applyLiveState(data);
        applyKpis(data);
        applyIntent(data);
        applyBattery(data);
        applyDcCharger(data);
        applyFlows(data);
      })
      .catch(function() {
        consecutiveErrors++;
        applyOffline();
      });
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    const backoff = consecutiveErrors > 0
      ? Math.min(BASE_MS * Math.pow(2, consecutiveErrors - 1), MAX_BACKOFF_MS)
      : BASE_MS;
    refreshTimer = setTimeout(function() {
      fetchCockpit().then(scheduleRefresh);
    }, backoff);
  }

  // One-time fetch of station metadata (station_id, bucket, org) from /api/health.
  // This data doesn't change during a session; cockpit endpoint doesn't include it.
  function fetchHealthMeta() {
    fetch('/api/health')
      .then(function(res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
      .then(function(data) {
        if (!data) return;
        if (data.station_id) {
          setText('station-state', data.station_id.slice(-6));
          setText('dh-station', 'OK');
          setText('dh-station-id', data.station_id);
          setDot('station-dot', 'on');
        }
        if (data.bucket) setText('dh-bucket', data.bucket);
        if (data.org) setText('dh-org', data.org);
      })
      .catch(function() {
        setDot('station-dot', 'off');
      });
  }

  function init() {
    setText('intent-primary', 'Waiting for telemetry…');
    setText('side-soc', '—');
    setText('side-batt-power', '—');
    setText('side-batt-stored', '—');
    setText('side-batt-time', '—');
    setText('side-dc-power', '—');
    setText('side-dc-status', 'No data');
    setText('station-state', '—');
    setText('grid-state', '—');

    fetchHealthMeta();
    fetchCockpit().then(scheduleRefresh);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
