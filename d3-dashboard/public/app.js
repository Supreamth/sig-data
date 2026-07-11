'use strict';

// ── State ──────────────────────────────────────────────────────────────────
const REFRESH_MS = 15000;
let currentRange = '2h';
let refreshTimer = null;

const COLORS = {
  pv_power:          '#3fb950',
  load_power:        '#58a6ff',
  grid_flow_power:   '#e3b341',
  battery_power:     '#bc8cff',
  battery_soc:       '#bc8cff',
};

const OPTIONAL_DEVICES = [
  { key: 'ac_power',        label: 'AC Coupled',  color: '#06b6d4' },
  { key: 'ev_power',        label: 'EV Charger',  color: '#22d3ee' },
  { key: 'generator_power', label: 'Generator',   color: '#f97316' },
  { key: 'heat_pump_power', label: 'Heat Pump',   color: '#ef4444' },
  { key: 'third_pv_power',  label: '3rd PV',      color: '#84cc16' },
];

// ── Helpers ────────────────────────────────────────────────────────────────
function fmt(v, dec = 1) {
  if (v === null || v === undefined) return '—';
  return (+v).toFixed(dec);
}

function showError(msg) {
  const el = document.getElementById('error-container');
  el.innerHTML = msg ? `<div class="error-msg">${msg}</div>` : '';
}

function setStatus(ok) {
  const el = document.getElementById('status-badge');
  el.textContent = ok ? 'live' : 'error';
  el.className = ok ? 'ok' : 'error';
}

function updateLastUpdated() {
  document.getElementById('last-updated').textContent =
    'Updated ' + new Date().toLocaleTimeString();
}

function dot(id, state) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = 'status-dot ' + (state === 'on' ? 'on' : state === 'warn' ? 'warn' : 'off');
}

// ── KPI update ─────────────────────────────────────────────────────────────
function updateKPIs(data) {
  const e = data.energy || {};
  const d = data.daily || {};

  // PV
  const pv = document.getElementById('kpi-pv');
  pv.innerHTML = `${fmt(e.pv_power)}<span class="kpi-unit">kW</span>`;
  document.getElementById('kpi-pv-day').textContent =
    `Today: ${fmt(e.pv_day_nrg, 1)} kWh`;

  // Load
  document.getElementById('kpi-load').innerHTML =
    `${fmt(e.load_power)}<span class="kpi-unit">kW</span>`;

  // Battery
  const soc = e.battery_soc;
  document.getElementById('kpi-soc').innerHTML =
    `${fmt(soc, 0)}<span class="kpi-unit">%</span>`;
  const battDir = e.battery_power > 0 ? 'Discharging' : e.battery_power < 0 ? 'Charging' : 'Idle';
  document.getElementById('kpi-batt-sub').textContent =
    `${battDir} ${fmt(Math.abs(e.battery_power))} kW`;

  // Grid
  const gf = e.grid_flow_power;
  document.getElementById('kpi-grid').innerHTML =
    `${fmt(Math.abs(gf))}<span class="kpi-unit">kW</span>`;
  document.getElementById('kpi-grid-sub').textContent =
    gf > 0 ? 'Exporting' : gf < 0 ? 'Importing' : 'Idle';

  // Energy today
  const pvNrg = d.pv_generation_kwh ?? e.pv_day_nrg;
  document.getElementById('kpi-energy').innerHTML =
    `${fmt(pvNrg, 1)}<span class="kpi-unit">kWh</span>`;

  // Station status
  const ss = e.station_status;
  const stEl = document.getElementById('kpi-status');
  stEl.innerHTML = ss !== undefined ? `${ss}<span class="kpi-unit"></span>` : '—';
  document.getElementById('kpi-status-sub').textContent =
    e.on_grid !== undefined ? (e.on_grid ? 'On-grid' : 'Off-grid') : '';

  // Status strip
  const gridOn = !!e.on_grid;
  document.getElementById('val-grid').textContent = gridOn ? 'Connected' : 'Disconnected';
  dot('dot-grid', gridOn ? 'on' : 'warn');

  const stationOk = ss === 1 || ss === 2 || ss === '1' || ss === '2';
  document.getElementById('val-station').textContent =
    ss !== undefined ? `Code ${ss}` : '—';
  dot('dot-station', stationOk ? 'on' : 'off');
}

// ── Weather update ─────────────────────────────────────────────────────────
function updateWeather(data) {
  const w = data.weather || {};
  const hasWeather = w.temperature !== undefined && w.temperature !== null;
  const card = document.getElementById('weather-card');
  const strip = document.getElementById('weather-strip');

  if (!hasWeather) { card.style.display = 'none'; strip.style.display = 'none'; return; }

  card.style.display = 'flex';
  strip.style.display = 'flex';
  document.getElementById('weather-temp').textContent = `${fmt(w.temperature, 1)}°C`;
  document.getElementById('val-weather').textContent =
    `${fmt(w.temperature, 1)}°C · wind ${fmt(w.windspeed, 0)} km/h`;

  const meta = document.getElementById('weather-meta');
  const fields = [
    ['Wind', `${fmt(w.windspeed, 0)} km/h`],
    ['Direction', w.winddirection !== undefined ? `${fmt(w.winddirection, 0)}°` : '—'],
    ['Code', w.weathercode !== undefined ? String(w.weathercode) : '—'],
  ];
  meta.innerHTML = fields.map(([label, val]) =>
    `<div class="weather-field"><span>${label}</span><span>${val}</span></div>`
  ).join('');
}

// ── Optional Devices ───────────────────────────────────────────────────────
function updateOptionalDevices(energy) {
  const e = energy || {};
  const section = document.getElementById('optional-devices');
  const grid = document.getElementById('device-grid');

  const present = OPTIONAL_DEVICES.filter(d => e[d.key] !== undefined && e[d.key] !== null);
  if (present.length === 0) { section.style.display = 'none'; return; }

  section.style.display = 'block';
  grid.innerHTML = present.map(d => {
    const val = e[d.key];
    const active = Math.abs(val) > 0.05;
    return `<div class="device-card${active ? ' active' : ''}" style="--device-color:${d.color}">
  <div class="device-header">
    <div class="device-indicator"></div>
    <div class="device-label">${d.label}</div>
  </div>
  <div class="device-value">${fmt(Math.abs(val))}<span class="device-unit">kW</span></div>
  <div class="device-state">${active ? 'Active' : 'Idle'}</div>
</div>`;
  }).join('');
}

// ── D3 power flow chart ────────────────────────────────────────────────────
function drawPowerChart(series) {
  const container = document.getElementById('chart-power');
  container.innerHTML = '';

  const keys = ['pv_power', 'load_power', 'grid_flow_power', 'battery_power'];
  const available = keys.filter(k => series[k] && series[k].length > 0);
  if (available.length === 0) {
    container.innerHTML = '<div class="loading-overlay">No data</div>';
    return;
  }

  const W = container.clientWidth || 700;
  const H = 220;
  const margin = { top: 10, right: 20, bottom: 30, left: 48 };
  const iW = W - margin.left - margin.right;
  const iH = H - margin.top - margin.bottom;

  const allTimes = available.flatMap(k => series[k].map(d => new Date(d.time)));
  const allVals  = available.flatMap(k => series[k].map(d => d.value));

  const xScale = d3.scaleTime()
    .domain(d3.extent(allTimes))
    .range([0, iW]);

  const yMax = Math.max(Math.abs(d3.min(allVals)), d3.max(allVals), 0.5);
  const yScale = d3.scaleLinear()
    .domain([-yMax * 1.1, yMax * 1.1])
    .range([iH, 0])
    .nice();

  const svg = d3.select(container).append('svg')
    .attr('width', W).attr('height', H);

  const g = svg.append('g')
    .attr('transform', `translate(${margin.left},${margin.top})`);

  // Grid
  g.append('g').attr('class', 'grid')
    .call(d3.axisLeft(yScale).tickSize(-iW).tickFormat(''))
    .selectAll('line').classed('grid-line', true);
  g.select('.grid .domain').remove();

  // Zero line
  g.append('line')
    .attr('x1', 0).attr('x2', iW)
    .attr('y1', yScale(0)).attr('y2', yScale(0))
    .attr('stroke', '#30363d').attr('stroke-width', 1);

  // Axes
  g.append('g').attr('class', 'axis')
    .attr('transform', `translate(0,${iH})`)
    .call(d3.axisBottom(xScale).ticks(6).tickFormat(d3.timeFormat('%H:%M')));

  g.append('g').attr('class', 'axis')
    .call(d3.axisLeft(yScale).ticks(5).tickFormat(v => `${v}kW`));

  // Lines
  const line = d3.line()
    .x(d => xScale(new Date(d.time)))
    .y(d => yScale(d.value))
    .curve(d3.curveMonotoneX);

  const tooltip = document.getElementById('tooltip');

  available.forEach(key => {
    const path = g.append('path')
      .datum(series[key])
      .attr('fill', 'none')
      .attr('stroke', COLORS[key] || '#888')
      .attr('stroke-width', 2)
      .attr('d', line);

    // Hover dots (invisible, for tooltip)
    g.selectAll(`.dot-${key}`)
      .data(series[key])
      .enter().append('circle')
      .attr('class', `dot-${key}`)
      .attr('cx', d => xScale(new Date(d.time)))
      .attr('cy', d => yScale(d.value))
      .attr('r', 4)
      .attr('fill', 'transparent')
      .on('mouseover', function(event, d) {
        tooltip.style.display = 'block';
        tooltip.innerHTML = `<b>${key}</b>: ${d.value.toFixed(2)} kW<br>${new Date(d.time).toLocaleTimeString()}`;
      })
      .on('mousemove', function(event) {
        tooltip.style.left = (event.pageX + 12) + 'px';
        tooltip.style.top  = (event.pageY - 28) + 'px';
      })
      .on('mouseout', function() { tooltip.style.display = 'none'; });
  });
}

// ── D3 SOC area chart ──────────────────────────────────────────────────────
function drawSocChart(series) {
  const container = document.getElementById('chart-soc');
  container.innerHTML = '';

  const data = series.battery_soc;
  if (!data || data.length === 0) {
    container.innerHTML = '<div class="loading-overlay">No data</div>';
    return;
  }

  const W = container.clientWidth || 340;
  const H = 180;
  const margin = { top: 10, right: 16, bottom: 28, left: 40 };
  const iW = W - margin.left - margin.right;
  const iH = H - margin.top - margin.bottom;

  const xScale = d3.scaleTime()
    .domain(d3.extent(data, d => new Date(d.time)))
    .range([0, iW]);

  const yScale = d3.scaleLinear()
    .domain([0, 100])
    .range([iH, 0]);

  const svg = d3.select(container).append('svg')
    .attr('width', W).attr('height', H);

  const g = svg.append('g')
    .attr('transform', `translate(${margin.left},${margin.top})`);

  // Grid
  g.append('g').attr('class', 'grid')
    .call(d3.axisLeft(yScale).tickSize(-iW).tickFormat(''))
    .selectAll('line').classed('grid-line', true);
  g.select('.grid .domain').remove();

  // Area
  const area = d3.area()
    .x(d => xScale(new Date(d.time)))
    .y0(iH)
    .y1(d => yScale(d.value))
    .curve(d3.curveMonotoneX);

  g.append('defs').append('linearGradient')
    .attr('id', 'soc-grad')
    .attr('x1', '0').attr('y1', '0').attr('x2', '0').attr('y2', '1')
    .selectAll('stop')
    .data([
      { offset: '0%',   color: '#bc8cff', opacity: 0.35 },
      { offset: '100%', color: '#bc8cff', opacity: 0.02 },
    ])
    .enter().append('stop')
    .attr('offset', d => d.offset)
    .attr('stop-color', d => d.color)
    .attr('stop-opacity', d => d.opacity);

  g.append('path').datum(data)
    .attr('fill', 'url(#soc-grad)')
    .attr('d', area);

  const line = d3.line()
    .x(d => xScale(new Date(d.time)))
    .y(d => yScale(d.value))
    .curve(d3.curveMonotoneX);

  g.append('path').datum(data)
    .attr('fill', 'none')
    .attr('stroke', '#bc8cff')
    .attr('stroke-width', 2)
    .attr('d', line);

  g.append('g').attr('class', 'axis')
    .attr('transform', `translate(0,${iH})`)
    .call(d3.axisBottom(xScale).ticks(5).tickFormat(d3.timeFormat('%H:%M')));

  g.append('g').attr('class', 'axis')
    .call(d3.axisLeft(yScale).ticks(5).tickFormat(v => `${v}%`));
}

// ── D3 donut gauge ─────────────────────────────────────────────────────────
function drawGauge(soc) {
  const container = document.getElementById('chart-gauge');
  container.innerHTML = '';

  const val = (soc !== null && soc !== undefined) ? +soc : 0;
  const size = 180;
  const r = size / 2;
  const tau = 2 * Math.PI;

  const arc = d3.arc()
    .innerRadius(r * 0.65)
    .outerRadius(r * 0.88)
    .startAngle(0);

  const color = val > 60 ? '#3fb950' : val > 25 ? '#e3b341' : '#f85149';

  const svg = d3.select(container).append('svg')
    .attr('width', size).attr('height', size);

  const g = svg.append('g').attr('transform', `translate(${r},${r})`);

  // Background track
  g.append('path')
    .datum({ endAngle: tau })
    .attr('fill', '#1c2128')
    .attr('d', arc);

  // Value arc
  g.append('path')
    .datum({ endAngle: (val / 100) * tau })
    .attr('fill', color)
    .attr('d', arc);

  // Center text
  g.append('text')
    .attr('text-anchor', 'middle')
    .attr('dy', '0.35em')
    .attr('font-size', 28)
    .attr('font-weight', '700')
    .attr('fill', color)
    .text(soc !== null && soc !== undefined ? `${Math.round(val)}%` : '—');

  g.append('text')
    .attr('text-anchor', 'middle')
    .attr('dy', '2em')
    .attr('font-size', 11)
    .attr('fill', '#8b949e')
    .text('Battery SOC');
}

// ── Data fetching ──────────────────────────────────────────────────────────
async function fetchLatest() {
  const res = await fetch('/api/latest');
  if (!res.ok) throw new Error(`/api/latest: ${res.status}`);
  return res.json();
}

async function fetchHistory(range) {
  const res = await fetch(`/api/history?range=${range}`);
  if (!res.ok) throw new Error(`/api/history: ${res.status}`);
  return res.json();
}

async function refresh() {
  try {
    const [latest, history] = await Promise.all([
      fetchLatest(),
      fetchHistory(currentRange),
    ]);

    showError('');
    setStatus(true);
    updateKPIs(latest);
    updateWeather(latest);
    updateOptionalDevices(latest.energy);

    const soc = latest.energy && latest.energy.battery_soc !== undefined
      ? latest.energy.battery_soc : null;
    drawGauge(soc);

    if (history.series) {
      drawPowerChart(history.series);
      drawSocChart(history.series);
    }

    updateLastUpdated();
  } catch (err) {
    setStatus(false);
    showError(`Refresh failed: ${err.message}`);
  }
}

// ── Range selector ─────────────────────────────────────────────────────────
document.querySelectorAll('.range-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentRange = btn.dataset.range;
    refresh();
  });
});

// ── Auto-refresh ───────────────────────────────────────────────────────────
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refresh().then(scheduleRefresh);
  }, REFRESH_MS);
}

// ── Init ───────────────────────────────────────────────────────────────────
(function init() {
  // Show loading states
  document.getElementById('chart-power').innerHTML =
    '<div class="loading-overlay"><div class="spinner"></div>Loading…</div>';
  document.getElementById('chart-soc').innerHTML =
    '<div class="loading-overlay"><div class="spinner"></div>Loading…</div>';

  refresh().then(scheduleRefresh);

  // Handle resize
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(refresh, 200);
  });
})();
