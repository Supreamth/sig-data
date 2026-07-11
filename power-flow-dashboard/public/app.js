(() => {
  'use strict';

  const REFRESH_MS = 15000;
  let currentRange = '2h';
  let refreshTimer = null;
  let cardElement = null;

  const ENTITY_IDS = {
    solar: 'sensor.sigen_pv_power',
    load: 'sensor.sigen_home_load',
    grid: 'sensor.sigen_grid_power',
    battery: 'sensor.sigen_battery_power',
    batterySoc: 'sensor.sigen_battery_soc',
    pvToday: 'sensor.sigen_pv_today',
    gridConnected: 'binary_sensor.sigen_grid_connected',
    stationStatus: 'sensor.sigen_station_status',
    ev: 'sensor.sigen_ev_power',
    heatPump: 'sensor.sigen_heat_pump_power',
  };

  const COLORS = {
    pv_power: '#22c55e',
    load_power: '#60a5fa',
    grid_flow_power: '#facc15',
    battery_power: '#a78bfa',
  };

  class HaCard extends HTMLElement {}
  class HaIcon extends HTMLElement {}
  if (!customElements.get('ha-card')) customElements.define('ha-card', HaCard);
  if (!customElements.get('ha-icon')) customElements.define('ha-icon', HaIcon);

  function n(value) {
    const x = Number(value);
    return Number.isFinite(x) ? x : null;
  }

  function round(value, decimals = 2) {
    const x = n(value);
    return x === null ? 0 : Number(x.toFixed(decimals));
  }

  function fmt(value, unit = '', decimals = 1) {
    const x = n(value);
    return x === null ? '—' : `${x.toFixed(decimals)}${unit}`;
  }

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function setBadge(ok) {
    const el = document.getElementById('status-badge');
    el.textContent = ok ? 'live' : 'error';
    el.className = ok ? 'live' : 'error';
  }

  function showError(message) {
    const el = document.getElementById('error-container');
    el.innerHTML = message ? `<div class="error-msg">${escapeHtml(message)}</div>` : '';
  }

  function setDot(id, state) {
    const el = document.getElementById(id);
    if (el) el.className = `dot ${state}`;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
  }

  function entity(state, unit, friendlyName, extra = {}) {
    const value = n(state);
    return {
      entity_id: extra.entity_id,
      state: value === null ? String(state ?? 'unknown') : String(round(value, 3)),
      attributes: {
        friendly_name: friendlyName,
        unit_of_measurement: unit,
        device_class: unit === '%' ? 'battery' : 'power',
        state_class: 'measurement',
        ...extra.attributes,
      },
      last_changed: extra.timestamp || new Date().toISOString(),
      last_updated: extra.timestamp || new Date().toISOString(),
      context: { id: 'standalone', parent_id: null, user_id: null },
    };
  }

  function buildHass(latest) {
    const e = latest.energy || {};
    const timestamp = latest.timestamp || new Date().toISOString();

    // flixlix/power-flow-card-plus follows HA convention: grid/battery positive = consumption,
    // negative = production. Sigen fields in this collector are opposite for grid and battery.
    const cardGridPower = -round(e.grid_flow_power, 3);
    const cardBatteryPower = -round(e.battery_power, 3);

    const states = {
      [ENTITY_IDS.solar]: entity(round(e.pv_power, 3), 'kW', 'Solar production', { entity_id: ENTITY_IDS.solar, timestamp }),
      [ENTITY_IDS.load]: entity(round(e.load_power, 3), 'kW', 'Home load', { entity_id: ENTITY_IDS.load, timestamp }),
      [ENTITY_IDS.grid]: entity(cardGridPower, 'kW', 'Grid flow', { entity_id: ENTITY_IDS.grid, timestamp }),
      [ENTITY_IDS.battery]: entity(cardBatteryPower, 'kW', 'Battery flow', { entity_id: ENTITY_IDS.battery, timestamp }),
      [ENTITY_IDS.batterySoc]: entity(round(e.battery_soc, 0), '%', 'Battery state of charge', { entity_id: ENTITY_IDS.batterySoc, timestamp }),
      [ENTITY_IDS.pvToday]: entity(round(e.pv_day_nrg, 2), 'kWh', 'PV today', { entity_id: ENTITY_IDS.pvToday, timestamp, attributes: { device_class: 'energy' } }),
      [ENTITY_IDS.gridConnected]: entity(e.on_grid ? 'on' : 'off', '', 'Grid connected', { entity_id: ENTITY_IDS.gridConnected, timestamp, attributes: { device_class: 'connectivity' } }),
      [ENTITY_IDS.stationStatus]: entity(e.station_status ?? 'unknown', '', 'Station status', { entity_id: ENTITY_IDS.stationStatus, timestamp, attributes: { device_class: null } }),
      [ENTITY_IDS.ev]: entity(round(Math.abs(n(e.ev_power) || 0), 3), 'kW', 'EV charger', { entity_id: ENTITY_IDS.ev, timestamp }),
      [ENTITY_IDS.heatPump]: entity(round(Math.abs(n(e.heat_pump_power) || 0), 3), 'kW', 'Heat pump', { entity_id: ENTITY_IDS.heatPump, timestamp }),
    };

    return {
      states,
      themes: { darkMode: true, theme: 'default' },
      language: 'en',
      locale: { language: 'en', number_format: 'language', time_format: '24' },
      localize: key => String(key || '').split('.').pop().replace(/_/g, ' '),
      formatEntityState: stateObj => stateObj ? `${stateObj.state}${stateObj.attributes?.unit_of_measurement ? ' ' + stateObj.attributes.unit_of_measurement : ''}` : '—',
      formatEntityAttributeValue: (_stateObj, _attr, value) => String(value ?? ''),
      callService: () => Promise.resolve(),
      fireEvent: () => {},
      connection: { subscribeEvents: () => Promise.resolve(() => {}) },
    };
  }

  function powerCardConfig() {
    return {
      type: 'custom:power-flow-card-plus',
      title: 'Live Sigen Power Flow',
      clickable_entities: false,
      use_new_flow_rate_model: true,
      min_expected_power: 0.05,
      max_expected_power: 8,
      min_flow_rate: 0.8,
      max_flow_rate: 7,
      kilo_threshold: 0,
      kilo_decimals: 2,
      display_zero_lines: { mode: 'transparency', transparency: 65 },
      entities: {
        solar: {
          entity: ENTITY_IDS.solar,
          name: 'Solar',
          icon: 'mdi:solar-power-variant',
          color: '#22c55e',
          color_icon: true,
          color_value: true,
          secondary_info: { entity: ENTITY_IDS.pvToday, unit_of_measurement: 'kWh', decimals: 1, display_zero: true },
        },
        battery: {
          entity: ENTITY_IDS.battery,
          state_of_charge: ENTITY_IDS.batterySoc,
          name: 'Battery',
          icon: 'mdi:battery-heart-variant',
          display_state: 'one_way_no_zero',
          color_circle: 'color_dynamically',
          color_icon: 'color_dynamically',
          color_state_of_charge_value: 'color_dynamically',
          color: { consumption: '#a78bfa', production: '#38bdf8' },
        },
        grid: {
          entity: ENTITY_IDS.grid,
          name: 'Grid',
          icon: 'mdi:transmission-tower',
          display_state: 'one_way_no_zero',
          color_circle: 'color_dynamically',
          color_icon: 'color_dynamically',
          color: { consumption: '#facc15', production: '#fb923c' },
          power_outage: { entity: ENTITY_IDS.gridConnected, state_alert: 'off', label_alert: 'Outage' },
        },
        home: {
          entity: ENTITY_IDS.load,
          name: 'Home',
          icon: 'mdi:home-lightning-bolt',
          override_state: true,
          color_icon: 'solar',
          color_value: true,
        },
        individual: [
          { entity: ENTITY_IDS.ev, name: 'EV', icon: 'mdi:car-electric', color: '#22d3ee', display_zero_tolerance: 0.05, decimals: 2, color_icon: true },
          { entity: ENTITY_IDS.heatPump, name: 'Heat', icon: 'mdi:heat-pump', color: '#fb7185', display_zero_tolerance: 0.05, decimals: 2, color_icon: true },
        ],
      },
      style_ha_card: 'background: rgba(8,15,23,.82); border-radius: 28px; border: 1px solid rgba(255,255,255,.12); box-shadow: none;',
      style_card_content: 'padding: 10px 8px 16px;',
    };
  }

  async function ensurePowerCard() {
    if (cardElement) return cardElement;
    await customElements.whenDefined('power-flow-card-plus');
    const shell = document.getElementById('power-card-shell');
    shell.querySelector('.card-loading')?.remove();
    cardElement = document.createElement('power-flow-card-plus');
    cardElement.setConfig(powerCardConfig());
    shell.appendChild(cardElement);
    return cardElement;
  }

  function updatePvStringNodes(latest) {
    const pvStrings = latest.pv_strings || {};
    [1, 2, 3, 4].forEach(i => {
      const power = n(pvStrings[`pv${i}_power`]);
      const today = n(pvStrings[`pv${i}_today_kwh`]);
      const node = document.querySelector(`.pv-string-node.pv${i}`);
      if (node) {
        node.classList.toggle('active', power !== null && power > 0.05);
        node.classList.toggle('muted', power === null || power <= 0.05);
      }
      setText(`pv${i}-node-power`, power === null ? '— kW' : fmt(power, ' kW', 2));
      setText(`pv${i}-node-sub`, power === null ? 'No string data' : `Today ${today === null ? '—' : fmt(today, ' kWh', 2)}`);
    });
  }

  function updateMetrics(latest) {
    const e = latest.energy || {};
    const grid = n(e.grid_flow_power);
    const batt = n(e.battery_power);

    updatePvStringNodes(latest);
    setText('m-pv', fmt(e.pv_power, ' kW'));
    setText('m-pv-sub', `Today ${fmt(e.pv_day_nrg, ' kWh')}`);
    setText('m-load', fmt(e.load_power, ' kW'));
    setText('m-soc', fmt(e.battery_soc, '%', 0));
    setText('m-batt-sub', batt === null ? '—' : `${batt > 0 ? 'Discharging' : batt < 0 ? 'Charging' : 'Idle'} ${fmt(Math.abs(batt), ' kW')}`);
    setText('m-grid', grid === null ? '—' : fmt(Math.abs(grid), ' kW'));
    setText('m-grid-sub', grid === null ? '—' : grid > 0 ? 'Exporting' : grid < 0 ? 'Importing' : 'Idle');
    setText('grid-state', e.on_grid ? 'Connected' : 'Disconnected');
    setText('station-state', e.station_status === undefined ? '—' : `Code ${e.station_status}`);
    setText('db-ts', latest.timestamp ? new Date(latest.timestamp).toLocaleTimeString() : '—');
    setDot('grid-dot', e.on_grid ? 'on' : 'warn');
    setDot('station-dot', e.station_status == 1 || e.station_status == 2 ? 'on' : 'warn');
    setText('last-updated', `Updated ${new Date().toLocaleTimeString()}`);
  }

  function drawSparkline(series) {
    const el = document.getElementById('sparkline');
    const keys = ['pv_power', 'load_power', 'grid_flow_power', 'battery_power'];
    const points = keys.flatMap(key => (series[key] || []).map(p => ({ key, time: +new Date(p.time), value: Math.abs(n(p.value) || 0) })));
    if (!points.length) {
      el.innerHTML = '<div class="card-loading">No history yet</div>';
      return;
    }

    const width = Math.max(el.clientWidth, 600);
    const height = Math.max(el.clientHeight, 240);
    const pad = { top: 24, right: 28, bottom: 32, left: 46 };
    const minT = Math.min(...points.map(p => p.time));
    const maxT = Math.max(...points.map(p => p.time));
    const maxV = Math.max(1, ...points.map(p => p.value));
    const x = time => pad.left + ((time - minT) / Math.max(1, maxT - minT)) * (width - pad.left - pad.right);
    const y = value => height - pad.bottom - (value / maxV) * (height - pad.top - pad.bottom);
    const pathFor = key => (series[key] || []).map((p, i) => `${i ? 'L' : 'M'}${x(+new Date(p.time)).toFixed(1)},${y(Math.abs(n(p.value) || 0)).toFixed(1)}`).join(' ');
    const gridLines = [0, .25, .5, .75, 1].map(t => {
      const yy = pad.top + t * (height - pad.top - pad.bottom);
      return `<line class="axis" x1="${pad.left}" x2="${width - pad.right}" y1="${yy}" y2="${yy}"/>`;
    }).join('');

    el.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Power history">
      <defs>
        <filter id="glow"><feGaussianBlur stdDeviation="2.6" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      </defs>
      ${gridLines}
      <text x="${pad.left}" y="18" fill="#9eb2c3" font-size="11">kW · max ${maxV.toFixed(1)}</text>
      ${keys.map(key => `<path d="${pathFor(key)}" fill="none" stroke="${COLORS[key]}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" filter="url(#glow)"/>`).join('')}
    </svg>`;
  }

  async function getJson(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${url} returned ${res.status}`);
    return res.json();
  }

  async function refresh() {
    try {
      setBadge(true);
      const [latest, history] = await Promise.all([getJson('/api/latest'), getJson(`/api/history?range=${currentRange}`)]);
      showError('');
      updateMetrics(latest);
      drawSparkline(history.series || {});
      const card = await ensurePowerCard();
      card.hass = buildHass(latest);
    } catch (err) {
      setBadge(false);
      showError(err.message || String(err));
    }
  }

  function schedule() {
    clearInterval(refreshTimer);
    refreshTimer = setInterval(refresh, REFRESH_MS);
  }

  document.querySelectorAll('.range-btn').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentRange = btn.dataset.range || '2h';
    setText('range-label', currentRange);
    refresh();
    schedule();
  }));

  window.addEventListener('resize', () => {
    getJson(`/api/history?range=${currentRange}`).then(history => drawSparkline(history.series || {})).catch(() => {});
  });

  refresh();
  schedule();
})();
