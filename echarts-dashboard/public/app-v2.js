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

  function fmtMode(mode) {
    if (mode === 'charging') return 'Charging';
    if (mode === 'discharging') return 'Discharging';
    if (mode === 'idle') return 'Idle';
    if (mode === 'unknown') return 'Unknown';
    if (mode === 'no_data') return 'No telemetry';
    return mode ? String(mode) : '—';
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
      setText('kpi-soc-sub', fmtMode((data.battery || {}).mode));
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

    // Grid Idle 24h
    const kpis = data.kpis || {};
    if (isNullish(kpis.grid_idle_hours)) {
      setText('kpi-grid-idle', '—');
      setText('kpi-grid-idle-sub', 'No data');
    } else {
      setText('kpi-grid-idle', kpis.grid_idle_hours.toFixed(1) + 'h');
      setText('kpi-grid-idle-sub', !isNullish(kpis.grid_idle_minutes)
        ? Math.round(kpis.grid_idle_minutes) + ' min idle today'
        : 'of 24h idle today');
    }

    // Grid Cost Today
    if (isNullish(kpis.grid_cost_thb)) {
      setText('kpi-grid-cost', '—');
      setText('kpi-grid-cost-sub', 'No data');
    } else {
      setText('kpi-grid-cost', kpis.grid_cost_thb.toFixed(2));
      setText('kpi-grid-cost-sub', !isNullish(kpis.grid_cost_rate_thb_per_kwh)
        ? '฿ at ฿' + kpis.grid_cost_rate_thb_per_kwh.toFixed(2) + '/kWh'
        : 'No data');
    }

    // Self-use
    if (isNullish(kpis.self_use_pct)) {
      setText('kpi-self-use', '—');
      setText('kpi-self-use-sub', 'No data');
    } else {
      setText('kpi-self-use', kpis.self_use_pct.toFixed(1) + '%');
      setText('kpi-self-use-sub', 'Self-consumption rate');
    }
  }

  // ── Energy Intent card ───────────────────────────────────────────────────────

  function safeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function applyIntent(data) {
    const intent = data.intent || {};
    const primary = intent.primary || 'Waiting for telemetry…';
    const state = (intent.state || '').replace(/_/g, ' ');
    const secondary = Array.isArray(intent.secondary) ? intent.secondary : [];
    const reasons = Array.isArray(intent.reasons) ? intent.reasons : [];

    setText('intent-primary', primary);
    setText('intent-chip', state || '—');

    const bullets = el('intent-bullets');
    if (bullets) {
      if (secondary.length > 0) {
        bullets.innerHTML = secondary.map(function(s) {
          return '<li>' + safeHtml(s) + '</li>';
        }).join('');
      } else {
        bullets.innerHTML = '<li>—</li>';
      }
    }

    const reasonsEl = el('intent-reasons');
    if (reasonsEl) {
      if (reasons.length > 0) {
        reasonsEl.innerHTML = reasons.map(function(r) {
          return '<li>' + safeHtml(r) + '</li>';
        }).join('');
        reasonsEl.hidden = false;
      } else {
        reasonsEl.innerHTML = '';
        reasonsEl.hidden = true;
      }
    }
  }

  // ── Battery side card ────────────────────────────────────────────────────────

  function applyBattery(data) {
    const batt = data.battery || {};

    const modeRaw = batt.mode;
    setText('battery-mode-badge', (!modeRaw || modeRaw === 'no_data') ? 'No telemetry' : fmtMode(modeRaw));

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

  const ACTIVE_THRESH = 0.05;

  const TOPO_NODES = ['dev-pv1', 'dev-pv2', 'dev-pv3', 'dev-pv4', 'node-pvtotal', 'node-grid', 'node-home', 'node-battery', 'node-dc', 'node-tesla'];
  const TOPO_LINKS = ['link-pv', 'link-total-home', 'link-home-dc'];

  function resetFlowMap() {
    TOPO_NODES.forEach(function(id) {
      const node = el(id);
      if (node) node.classList.remove('active', 'idle');
    });
    TOPO_LINKS.forEach(function(id) {
      const link = el(id);
      if (link) link.classList.remove('active');
    });
  }

  function setNodeState(id, active, idle) {
    const node = el(id);
    if (!node) return;
    node.classList.toggle('active', !!active);
    node.classList.toggle('idle', !!idle && !active);
  }

  function setLinkState(id, active) {
    const link = el(id);
    if (link) link.classList.toggle('active', !!active);
  }

  function flowValueText(val) {
    return isNullish(val) ? '—' : val.toFixed(2) + ' kW';
  }

  const PV_STRINGS = [
    { key: 'pv1_power', dev: 'dev-pv1', val: 'pv1-value', sub: 'pv1-sub', label: 'PV1' },
    { key: 'pv2_power', dev: 'dev-pv2', val: 'pv2-value', sub: 'pv2-sub', label: 'PV2' },
    { key: 'pv3_power', dev: 'dev-pv3', val: 'pv3-value', sub: 'pv3-sub', label: 'PV3' },
    { key: 'pv4_power', dev: 'dev-pv4', val: 'pv4-value', sub: 'pv4-sub', label: 'PV4' },
  ];

  // Render each PV string device from real per-string telemetry. Missing values
  // show 'No data' (never fabricated). Returns the list of active strings.
  function applyPvStrings(data) {
    const ps = data.pv_strings || {};
    const activeStrings = [];

    PV_STRINGS.forEach(function(s) {
      const v = ps[s.key];
      if (isNullish(v)) {
        setText(s.val, '—');
        setText(s.sub, 'No data');
        setNodeState(s.dev, false, false);
      } else {
        const kw = Math.max(0, v);
        const active = kw > ACTIVE_THRESH;
        setText(s.val, kw.toFixed(2) + ' kW');
        setText(s.sub, active ? 'Producing' : 'Idle');
        setNodeState(s.dev, active, !active);
        if (active) activeStrings.push({ label: s.label, kw: kw });
      }
    });

    // PV Total hub — prefer the real string total; preserve null when absent.
    const total = !isNullish(ps.pv_string_total_power) ? ps.pv_string_total_power
      : (!isNullish(ps.pv_total_power) ? ps.pv_total_power : null);
    if (isNullish(total)) {
      setText('flow-pvtotal-value', '—');
      setText('pvtotal-sub', 'No data');
      setNodeState('node-pvtotal', false, false);
    } else {
      const kw = Math.max(0, total);
      const active = kw > ACTIVE_THRESH;
      setText('flow-pvtotal-value', kw.toFixed(2) + ' kW');
      setText('pvtotal-sub', active ? 'PV producing' : 'Idle');
      setNodeState('node-pvtotal', active, !active);
      setLinkState('link-pv', active);
    }

    return activeStrings;
  }

  // Battery aggregate modules (Battery 1/2 …) from battery.modules when present.
  function applyBatteryModules(data) {
    const modules = ((data.battery || {}).modules) || [];
    const wrap = el('battery-modules');
    if (!wrap) return;
    if (!modules.length) {
      wrap.innerHTML = '';
      wrap.hidden = true;
      return;
    }
    wrap.hidden = false;
    wrap.innerHTML = modules.map(function(m, i) {
      const idx = m.battery_index || (i + 1);
      const soc = isNullish(m.soc) ? 'No data' : Math.round(m.soc) + '%';
      return '<span class="batt-module">B' + safeHtml(idx) + ' · ' + safeHtml(soc) + '</span>';
    }).join('');
  }

  function applyFlows(data) {
    const flows = Array.isArray(data.flows) ? data.flows : [];
    const canvas = el('flow-canvas');
    const lat = data.latest || {};
    if (!canvas) return;

    resetFlowMap();

    // PV strings + total hub first (drives the solar links & chips).
    const activeStrings = applyPvStrings(data);
    applyBatteryModules(data);

    setText('flow-home-value', flowValueText(lat.load_power));
    setText('flow-grid-value', flowValueText(lat.grid_flow_power));
    setText('flow-battery-value', isNullish(lat.battery_power) ? '—' : flowValueText(Math.abs(lat.battery_power)));
    setText('flow-dc-value', flowValueText(lat.ev_power));

    // Index flows by type for direct lookup.
    const byType = {};
    flows.forEach(function(f) { byType[f.type] = f; });

    // ── Grid node + sublabel: Import / Export / Idle / No data ────────────────
    const gridImport = byType.grid_import;
    const gridExport = byType.grid_export;
    if (gridImport && gridImport.active) {
      setNodeState('node-grid', true, false);
      setText('grid-sub', 'Import');
    } else if (gridExport && gridExport.active) {
      setNodeState('node-grid', true, false);
      setText('grid-sub', 'Export');
    } else if (byType.grid_idle || gridImport || gridExport) {
      setNodeState('node-grid', false, true);
      setText('grid-sub', 'Idle');
    } else {
      setNodeState('node-grid', false, false);
      setText('grid-sub', 'No data');
    }

    // ── Battery node + sublabel: Charging / Discharging / Idle / No data ──────
    const battCharge = byType.battery_charge;
    const battDischarge = byType.battery_discharge;
    if (battCharge && battCharge.active) {
      setNodeState('node-battery', true, false);
      setText('battery-sub', 'Charging');
    } else if (battDischarge && battDischarge.active) {
      setNodeState('node-battery', true, false);
      setText('battery-sub', 'Discharging');
    } else if (byType.battery_idle || battCharge || battDischarge) {
      setNodeState('node-battery', false, true);
      setText('battery-sub', 'Idle');
    } else {
      setNodeState('node-battery', false, false);
      setText('battery-sub', 'No data');
    }

    // ── Home / Load bus + PV Total -> Home link ──────────────────────────────
    const solar = byType.solar;
    const anyActive = flows.some(function(f) { return f.active; });
    setNodeState('node-home', anyActive, !anyActive);
    setLinkState('link-total-home', !!(solar && solar.active));

    // ── DC Charger -> Tesla (contextual): Charging / Idle / No data ──────────
    const ev = byType.ev_charging;
    if (ev && ev.active) {
      setNodeState('node-dc', true, false);
      setNodeState('node-tesla', true, false);
      setLinkState('link-home-dc', true);
      setText('dc-sub', 'Charging');
      setText('tesla-sub', 'Charging context');
    } else if (!isNullish(lat.ev_power)) {
      setNodeState('node-dc', false, true);
      setNodeState('node-tesla', false, true);
      setText('dc-sub', 'Idle');
      setText('tesla-sub', 'Contextual');
    } else {
      setNodeState('node-dc', false, false);
      setNodeState('node-tesla', false, false);
      setText('dc-sub', 'No data');
      setText('tesla-sub', 'Contextual');
    }

    const existing = el('flow-chips');
    if (existing) existing.remove();

    const chips = [];
    activeStrings.forEach(function(s) {
      chips.push({ label: s.label + ' → PV Total', kw: s.kw, type: 'solar' });
    });
    flows.filter(function(f) { return f.active && f.type !== 'solar'; }).forEach(function(f) {
      chips.push({ label: f.from + ' → ' + f.to, kw: f.kw, type: f.type });
    });

    const empty = el('flow-empty');
    if (empty) empty.hidden = chips.length > 0;
    if (chips.length === 0) return;

    const wrap = document.createElement('div');
    wrap.id = 'flow-chips';
    wrap.className = 'flow-chips';

    chips.forEach(function(f) {
      const chip = document.createElement('span');
      const cls = FLOW_TYPE_CLASSES[f.type] || 'chip-muted';
      const kw = isNullish(f.kw) ? '—' : f.kw.toFixed(2);
      chip.className = 'flow-chip ' + cls;
      chip.textContent = f.label + ' · ' + kw + ' kW';
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

  // ── Weather VS Actual PV chart ───────────────────────────────────────────────

  let weatherChart = null;
  let weatherTimer = null;

  const WX_COLORS = {
    panel: '#101722', border: '#273347', text: '#edf4ff', muted: '#91a4bd',
    cloud: '#60a5fa', ghi: '#fbbf24', pvAgg: '#35d07f',
    pv1_power: '#35d07f', pv2_power: '#22d3ee', pv3_power: '#f59e0b', pv4_power: '#60a5fa',
  };
  const PV_FIELDS = ['pv1_power', 'pv2_power', 'pv3_power', 'pv4_power'];

  // Keep null as null (no telemetry); never coerce missing points to 0.
  function nullableNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const x = Number(value);
    return Number.isFinite(x) ? x : null;
  }

  function initWeatherChart() {
    const node = el('weather-actual-chart-v2');
    if (!node || typeof echarts === 'undefined') return;
    weatherChart = echarts.init(node);
    window.addEventListener('resize', function() {
      if (weatherChart) weatherChart.resize();
    });
  }

  function showWeatherEmpty(subtext) {
    if (!weatherChart) return;
    weatherChart.clear();
    weatherChart.setOption({
      backgroundColor: 'transparent',
      title: {
        text: 'Weather VS Actual PV',
        subtext: subtext || 'No data available',
        left: 'center', top: 'center',
        textStyle: { color: WX_COLORS.muted, fontSize: 14 },
        subtextStyle: { color: WX_COLORS.muted, fontSize: 12 },
      },
    });
  }

  function renderWeatherActual(payload) {
    if (!weatherChart) return;
    const rows = Array.isArray(payload && payload.rows) ? payload.rows : [];
    if (!rows.length) { showWeatherEmpty('No data available'); return; }

    const tz = (payload && payload.timezone) || 'Asia/Bangkok';
    const fmtTz = function(iso) {
      if (!iso) return '';
      try { return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz }); }
      catch (_) { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
    };

    // Per-string PV (clamped ≥0, null preserved) + aggregate fallback.
    const pvStringData = {};
    PV_FIELDS.forEach(function(f) {
      pvStringData[f] = rows.map(function(r) {
        const v = nullableNumber(r[f]);
        return v !== null ? Math.max(0, v) : null;
      });
    });
    const hasStringData = PV_FIELDS.some(function(f) {
      return pvStringData[f].some(function(v) { return v !== null; });
    });
    const pvAggData = rows.map(function(r) {
      const v = nullableNumber(r.pv_power);
      return v !== null ? Math.max(0, v) : null;
    });

    const cloudData = rows.map(function(r) { return [r.time, nullableNumber(r.cloud_cover)]; });
    const ghiData = rows.map(function(r) { return [r.time, nullableNumber(r.shortwave_radiation)]; });
    const xLabels = rows.map(function(r) { return fmtTz(r.time); });

    const validGhi = ghiData.map(function(d) { return d[1]; }).filter(function(v) { return v !== null; });
    const maxGhi = validGhi.length ? Math.max.apply(null, validGhi) : 200;
    const validPv = (hasStringData
      ? rows.map(function(r, i) {
          const vals = PV_FIELDS.map(function(f) { return pvStringData[f][i]; }).filter(function(v) { return v !== null; });
          return vals.length ? vals.reduce(function(a, b) { return a + b; }, 0) : null;
        })
      : pvAggData).filter(function(v) { return v !== null; });
    const maxPv = validPv.length ? Math.max.apply(null, validPv) : 5;

    // Note the real data source so aggregate fallback is never mistaken for per-string data.
    const note = el('weather-actual-note');
    if (note) {
      note.textContent = hasStringData
        ? 'Real PV1–PV4 string telemetry (stacked kW) · GHI · cloud cover'
        : 'Aggregate PV power only — no per-string telemetry (' + ((payload && payload.source) || 'sigen') + ') · GHI · cloud cover';
    }

    const pvSeries = hasStringData
      ? PV_FIELDS.map(function(f, idx) {
          return {
            name: f.slice(0, 3).toUpperCase(),
            type: 'bar',
            stack: 'pv_actual',
            yAxisIndex: 2,
            data: rows.map(function(r, i) { return [r.time, pvStringData[f][i]]; }),
            barMaxWidth: 28,
            itemStyle: {
              color: WX_COLORS[f],
              borderRadius: idx === PV_FIELDS.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0],
            },
            z: 2,
          };
        })
      : [{
          name: 'PV (agg kW)',
          type: 'bar',
          stack: 'pv_actual',
          yAxisIndex: 2,
          data: rows.map(function(r, i) { return [r.time, pvAggData[i]]; }),
          barMaxWidth: 28,
          itemStyle: { color: WX_COLORS.pvAgg, borderRadius: [4, 4, 0, 0] },
          z: 2,
        }];

    const legendData = ['Cloud Cover (%)', 'GHI (W/m²)'].concat(
      hasStringData ? PV_FIELDS.map(function(f) { return f.slice(0, 3).toUpperCase(); }) : ['PV (agg kW)']
    );

    weatherChart.setOption({
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        appendToBody: true,
        confine: false,
        backgroundColor: WX_COLORS.panel,
        borderColor: WX_COLORS.border,
        borderWidth: 1,
        textStyle: { color: WX_COLORS.text, fontSize: 12 },
        extraCssText: 'z-index:9999;max-width:280px;padding:9px 12px;border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,.55);',
        formatter: function(params) {
          const cc = params.find(function(p) { return p.seriesName === 'Cloud Cover (%)'; });
          const i = cc ? cc.dataIndex : (params[0] ? params[0].dataIndex : null);
          if (i == null) return '';
          const r = rows[i] || {};
          const dot = function(c) { return '<span style="display:inline-block;width:9px;height:9px;background:' + c + ';border-radius:50%;margin-right:5px;"></span>'; };
          const line = function(d, label, val) {
            return '<div style="display:flex;justify-content:space-between;gap:14px;">' + d +
              '<span style="color:#91a4bd;">' + label + '</span><span style="font-weight:600;">' + val + '</span></div>';
          };
          const na = '<span style="color:#91a4bd;font-style:italic;">No data</span>';
          let tip = '<div style="margin-bottom:5px;font-weight:700;">' + (xLabels[i] || '') + '</div>';
          const ghi = nullableNumber(r.shortwave_radiation);
          tip += line(dot(WX_COLORS.ghi), 'GHI (W/m²)', ghi !== null ? ghi.toFixed(0) : '—');
          const cloud = nullableNumber(r.cloud_cover);
          tip += line(dot(WX_COLORS.cloud), 'Cloud (%)', cloud !== null ? cloud.toFixed(0) : '—');
          if (hasStringData) {
            let total = null;
            PV_FIELDS.forEach(function(f) {
              const v = pvStringData[f][i];
              if (v !== null) total = (total || 0) + v;
              tip += line(dot(WX_COLORS[f]), f.slice(0, 3).toUpperCase() + ' (kW)', v !== null ? v.toFixed(2) : na);
            });
            tip += line(dot('#ffffff'), 'Total PV (kW)', total !== null ? '<b>' + total.toFixed(2) + '</b>' : na);
          } else {
            const v = nullableNumber(r.pv_power);
            tip += line(dot(WX_COLORS.pvAgg), 'PV agg (kW)', v !== null ? Math.max(0, v).toFixed(2) : na);
          }
          return tip;
        },
      },
      legend: {
        bottom: 2, left: 'center',
        textStyle: { color: WX_COLORS.muted, fontSize: 11 },
        itemGap: 12,
        data: legendData,
      },
      grid: { left: 46, right: 52, top: 16, bottom: 46 },
      xAxis: {
        type: 'time',
        boundaryGap: false,
        axisLabel: {
          color: WX_COLORS.muted, fontSize: 10,
          formatter: function(value) {
            try { return new Date(value).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz }); }
            catch (_) { return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
          },
        },
        axisLine: { lineStyle: { color: WX_COLORS.border } },
        splitLine: { show: false },
      },
      yAxis: [
        {
          type: 'value', name: '%', min: 0, max: 100, position: 'left',
          axisLabel: { color: WX_COLORS.muted, formatter: '{value}%', fontSize: 10 },
          axisLine: { lineStyle: { color: WX_COLORS.border } },
          splitLine: { lineStyle: { color: WX_COLORS.border, type: 'dashed' } },
          nameTextStyle: { color: WX_COLORS.muted, fontSize: 10 },
        },
        {
          type: 'value', name: 'W/m²', min: 0,
          max: Math.max(200, Math.ceil(maxGhi * 1.25 / 100) * 100), position: 'right',
          axisLabel: { color: WX_COLORS.ghi, fontSize: 9 },
          axisLine: { show: true, lineStyle: { color: WX_COLORS.ghi, opacity: 0.4 } },
          splitLine: { show: false },
          nameTextStyle: { color: WX_COLORS.ghi, fontSize: 9 },
        },
        {
          type: 'value', name: 'kW', min: 0,
          max: Math.max(1, Math.ceil(maxPv * 1.3)), position: 'right', offset: 40,
          axisLabel: { color: WX_COLORS.pvAgg, fontSize: 9 },
          axisLine: { show: true, lineStyle: { color: WX_COLORS.pvAgg, opacity: 0.4 } },
          splitLine: { show: false },
          nameTextStyle: { color: WX_COLORS.pvAgg, fontSize: 9 },
        },
      ],
      series: [
        {
          name: 'Cloud Cover (%)', type: 'line', yAxisIndex: 0, data: cloudData,
          smooth: 0.4, symbol: 'none', lineStyle: { color: WX_COLORS.cloud, width: 2 },
          areaStyle: {
            color: {
              type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(96,165,250,0.32)' },
                { offset: 1, color: 'rgba(96,165,250,0.03)' },
              ],
            },
          },
          z: 1,
        },
        {
          name: 'GHI (W/m²)', type: 'line', yAxisIndex: 1, data: ghiData,
          smooth: 0.3, symbol: 'circle', showSymbol: false, symbolSize: 4,
          lineStyle: { color: WX_COLORS.ghi, width: 2.5 },
          itemStyle: { color: WX_COLORS.ghi }, z: 1,
        },
      ].concat(pvSeries),
    }, true);
  }

  function fetchWeatherActual() {
    if (!weatherChart) return Promise.resolve();
    return fetch('/api/weather-vs-actual')
      .then(function(res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
      .then(function(data) { renderWeatherActual(data); })
      .catch(function() { /* keep last good render; slow poll retries */ });
  }

  function scheduleWeatherRefresh() {
    clearInterval(weatherTimer);
    weatherTimer = setInterval(fetchWeatherActual, 60000);
  }

  // ── 24h Energy Story chart ───────────────────────────────────────────────────

  let storyChart = null;
  let storyTimer = null;

  const STORY_TZ = 'Asia/Bangkok';
  const STORY_COLORS = {
    panel: '#101722', border: '#273347', text: '#edf4ff', muted: '#91a4bd',
    pv: '#35d07f', load: '#f59e0b', gridImport: '#ef4444', gridExport: '#22d3ee',
    battCharge: '#a78bfa', battDischarge: '#60a5fa', ev: '#ec4899',
  };

  function initStoryChart() {
    const node = el('story-24h-chart');
    if (!node || typeof echarts === 'undefined') return;
    storyChart = echarts.init(node);
    window.addEventListener('resize', function() {
      if (storyChart) storyChart.resize();
    });
  }

  function showStoryEmpty(subtext) {
    if (!storyChart) return;
    storyChart.clear();
    storyChart.setOption({
      backgroundColor: 'transparent',
      title: {
        text: '24h Energy Story',
        subtext: subtext || 'No data available',
        left: 'center', top: 'center',
        textStyle: { color: STORY_COLORS.muted, fontSize: 14 },
        subtextStyle: { color: STORY_COLORS.muted, fontSize: 12 },
      },
    });
  }

  // Map a signed-power series into a split, clamped [time, value] series.
  // Missing points are simply absent (server drops nulls); measured 0 stays 0.
  function splitSeries(points, transform) {
    return (points || []).map(function(p) {
      const v = nullableNumber(p.value);
      return [p.time, v !== null ? transform(v) : null];
    });
  }

  function storyFmtTime(iso) {
    try { return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: STORY_TZ }); }
    catch (_) { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  }

  function renderStory(payload) {
    if (!storyChart) return;
    const series = (payload && payload.series) || {};

    const pvData = splitSeries(series.pv_power, function(v) { return Math.max(0, v); });
    const loadData = splitSeries(series.load_power, function(v) { return Math.max(0, v); });
    // Sign convention (matches server integrations): grid_flow_power < 0 → import, > 0 → export.
    const gridImportData = splitSeries(series.grid_flow_power, function(v) { return Math.max(0, -v); });
    const gridExportData = splitSeries(series.grid_flow_power, function(v) { return Math.max(0, v); });
    // battery_power > 0 → charging, < 0 → discharging.
    const battChargeData = splitSeries(series.battery_power, function(v) { return Math.max(0, v); });
    const battDischargeData = splitSeries(series.battery_power, function(v) { return Math.max(0, -v); });

    // EV only when a real, non-null, non-zero series exists — never fabricated.
    const evPoints = series.ev_power || [];
    const hasEv = Array.isArray(evPoints) && evPoints.some(function(p) {
      const v = nullableNumber(p.value);
      return v !== null && v !== 0;
    });
    const evData = hasEv ? splitSeries(evPoints, function(v) { return Math.max(0, v); }) : null;

    const hasAny = [pvData, loadData, gridImportData, battChargeData].some(function(d) {
      return d.some(function(pt) { return pt[1] !== null; });
    });
    if (!hasAny) { showStoryEmpty('No data in the last 24 hours'); return; }

    const lineSeries = function(name, data, color, area) {
      const s = {
        name: name, type: 'line', data: data,
        smooth: 0.25, symbol: 'none', connectNulls: false,
        lineStyle: { color: color, width: 2 },
        itemStyle: { color: color }, z: 2,
      };
      if (area) {
        s.areaStyle = {
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: color + '55' },
              { offset: 1, color: color + '05' },
            ],
          },
        };
        s.z = 1;
      }
      return s;
    };

    const allSeries = [
      lineSeries('PV (kW)', pvData, STORY_COLORS.pv, true),
      lineSeries('Home Load (kW)', loadData, STORY_COLORS.load, false),
      lineSeries('Grid Import (kW)', gridImportData, STORY_COLORS.gridImport, false),
      lineSeries('Grid Export (kW)', gridExportData, STORY_COLORS.gridExport, false),
      lineSeries('Battery Charge (kW)', battChargeData, STORY_COLORS.battCharge, false),
      lineSeries('Battery Discharge (kW)', battDischargeData, STORY_COLORS.battDischarge, false),
    ];
    if (hasEv) allSeries.push(lineSeries('EV (kW)', evData, STORY_COLORS.ev, false));

    const legendData = allSeries.map(function(s) { return s.name; });

    storyChart.setOption({
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        appendToBody: true,
        confine: true,
        backgroundColor: STORY_COLORS.panel,
        borderColor: STORY_COLORS.border,
        borderWidth: 1,
        textStyle: { color: STORY_COLORS.text, fontSize: 12 },
        extraCssText: 'z-index:9999;max-width:260px;padding:9px 12px;border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,.55);',
        formatter: function(params) {
          if (!params || !params.length) return '';
          const dot = function(c) { return '<span style="display:inline-block;width:9px;height:9px;background:' + c + ';border-radius:50%;margin-right:5px;"></span>'; };
          let tip = '<div style="margin-bottom:5px;font-weight:700;">' + storyFmtTime(params[0].axisValue) + '</div>';
          params.forEach(function(p) {
            const v = p.value && p.value.length > 1 ? p.value[1] : null;
            const txt = (v === null || v === undefined) ? '<span style="color:#91a4bd;font-style:italic;">No data</span>' : v.toFixed(2);
            tip += '<div style="display:flex;justify-content:space-between;gap:14px;">' + dot(p.color) +
              '<span style="color:#91a4bd;">' + p.seriesName + '</span><span style="font-weight:600;">' + txt + '</span></div>';
          });
          return tip;
        },
      },
      legend: {
        bottom: 2, left: 'center',
        textStyle: { color: STORY_COLORS.muted, fontSize: 11 },
        itemGap: 10,
        data: legendData,
      },
      grid: { left: 46, right: 18, top: 16, bottom: 52 },
      xAxis: {
        type: 'time',
        boundaryGap: false,
        axisLabel: {
          color: STORY_COLORS.muted, fontSize: 10,
          formatter: function(value) { return storyFmtTime(value); },
        },
        axisLine: { lineStyle: { color: STORY_COLORS.border } },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value', name: 'kW', min: 0, position: 'left',
        axisLabel: { color: STORY_COLORS.muted, fontSize: 10 },
        axisLine: { lineStyle: { color: STORY_COLORS.border } },
        splitLine: { lineStyle: { color: STORY_COLORS.border, type: 'dashed' } },
        nameTextStyle: { color: STORY_COLORS.muted, fontSize: 10 },
      },
      series: allSeries,
    }, true);
  }

  function fetchStory() {
    if (!storyChart) return Promise.resolve();
    return fetch('/api/history?range=24h')
      .then(function(res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
      .then(function(data) { renderStory(data); })
      .catch(function() { /* keep last good render; slow poll retries */ });
  }

  function scheduleStoryRefresh() {
    clearInterval(storyTimer);
    storyTimer = setInterval(fetchStory, 60000);
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

    initWeatherChart();
    initStoryChart();
    fetchHealthMeta();
    fetchCockpit().then(scheduleRefresh);
    fetchWeatherActual().then(scheduleWeatherRefresh);
    fetchStory().then(scheduleStoryRefresh);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
