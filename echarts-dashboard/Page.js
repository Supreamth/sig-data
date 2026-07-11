'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const REFRESH_MS = 5000;
const HISTORY_MS = 15000;

const theme = {
  bg: '#070b12',
  panel: 'rgba(16,23,34,.76)',
  border: 'rgba(145,164,189,.22)',
  text: '#edf4ff',
  muted: '#91a4bd',
  solar: '#39f58b',
  load: '#5db7ff',
  grid: '#ffd166',
  battery: '#c084fc',
  dc: '#22d3ee',
};

const metricDefs = [
  ['pv', 'PV Now', 'solar'],
  ['homeLoad', 'Home Load', 'load'],
  ['grid', 'Grid Flow', 'grid'],
  ['batterySoc', 'Battery SOC', 'battery'],
];

function num(value, digits = 2) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '—';
}

function kw(value) {
  return Number.isFinite(Number(value)) ? `${Math.abs(Number(value)).toFixed(2)} kW` : '—';
}

function Card({ title, value, unit, sub, tone = 'solar' }) {
  return (
    <article className={`metric ${tone}`}>
      <span>{title}</span>
      <strong>{value}{unit ? ` ${unit}` : ''}</strong>
      <small>{sub}</small>
    </article>
  );
}

export default function Page() {
  const flowRef = useRef(null);
  const trendRef = useRef(null);
  const flowChart = useRef(null);
  const trendChart = useRef(null);
  const echartsRef = useRef(null);
  const [energy, setEnergy] = useState(null);
  const [history, setHistory] = useState(null);
  const [lastUpdated, setLastUpdated] = useState('connecting…');
  const [error, setError] = useState('');
  const [online, setOnline] = useState(true);
  const [failures, setFailures] = useState(0);

  const values = useMemo(() => {
    const raw = energy?.raw || {};
    const grid = energy?.grid?.value ?? raw.grid_flow_power;
    const batteryPower = energy?.batteryPower?.value ?? raw.battery_power;
    return {
      pv: energy?.pv?.value ?? raw.pv_power,
      homeLoad: energy?.homeLoad?.value ?? raw.load_power,
      grid,
      batterySoc: energy?.batterySoc?.value ?? raw.battery_soc,
      batteryPower,
      gridSub: grid > 0.05 ? 'Exporting to grid' : grid < -0.05 ? 'Importing from grid' : 'Grid idle',
      batterySub: batteryPower > 0.05 ? `Charging ${kw(batteryPower)}` : batteryPower < -0.05 ? `Discharging ${kw(batteryPower)}` : 'Idle 0.00 kW',
    };
  }, [energy]);

  const retryDelay = useMemo(() => Math.min(60000, 1000 * (2 ** Math.min(failures, 5))), [failures]);

  const getJson = useCallback(async (url) => {
    const cleanUrl = new URL(url, `${window.location.protocol}//${window.location.host}`);
    const res = await fetch(cleanUrl.href, { cache: 'no-store' });
    if (!res.ok) {
      let message = `${url} returned ${res.status}`;
      try {
        const payload = await res.json();
        message = payload.error || payload.message || message;
      } catch (_) {}
      throw new Error(message);
    }
    return res.json();
  }, []);

  const refreshRealtime = useCallback(async () => {
    try {
      const data = await getJson('/api/realtime-energy');
      setEnergy(data);
      setOnline(true);
      setFailures(0);
      setError('');
      setLastUpdated(`Updated ${new Date().toLocaleTimeString()}`);
    } catch (err) {
      setOnline(false);
      setFailures(v => v + 1);
      setLastUpdated('Offline');
      setError(`${err.message || 'API / InfluxDB offline'} · reconnecting automatically`);
      throw err;
    }
  }, [getJson]);

  const refreshHistory = useCallback(async () => {
    const data = await getJson('/api/history?range=24h');
    setHistory(data.series || {});
  }, [getJson]);

  useEffect(() => {
    let alive = true;
    let realtimeTimer;
    let historyTimer;

    import('echarts').then(echarts => {
      if (!alive) return;
      echartsRef.current = echarts;
      if (flowRef.current && !flowChart.current) flowChart.current = echarts.init(flowRef.current);
      if (trendRef.current && !trendChart.current) trendChart.current = echarts.init(trendRef.current);
      refreshRealtime().catch(err => setError(err.message));
      refreshHistory().catch(err => setError(err.message));
      const poll = () => refreshRealtime().catch(() => {}).finally(() => {
        realtimeTimer = setTimeout(poll, online ? REFRESH_MS : retryDelay);
      });
      realtimeTimer = setTimeout(poll, REFRESH_MS);
      historyTimer = setInterval(() => refreshHistory().catch(err => setError(err.message)), HISTORY_MS);
    });

    const onResize = () => {
      flowChart.current?.resize();
      trendChart.current?.resize();
    };
    window.addEventListener('resize', onResize);

    return () => {
      alive = false;
      clearTimeout(realtimeTimer);
      clearInterval(historyTimer);
      window.removeEventListener('resize', onResize);
      flowChart.current?.dispose();
      trendChart.current?.dispose();
      flowChart.current = null;
      trendChart.current = null;
    };
  }, [online, refreshHistory, refreshRealtime, retryDelay]);

  useEffect(() => {
    if (!flowChart.current) return;
    const pv = Number(values.pv) || 0;
    const load = Number(values.homeLoad) || 0;
    const grid = Number(values.grid) || 0;
    const battery = Number(values.batteryPower) || 0;
    const soc = Number(values.batterySoc);
    const threshold = 0.05;
    const gridMode = grid < -threshold ? 'importing' : grid > threshold ? 'exporting' : 'idle';
    const batteryMode = battery > threshold ? 'charging' : battery < -threshold ? 'discharging' : 'idle';
    const nodes = {
      solar: { p: [50, 16], label: 'Solar', value: kw(pv), icon: '☀️', color: theme.solar },
      grid: { p: [18, 58], label: 'Grid', value: kw(grid), icon: '⚡', color: theme.grid },
      home: { p: [50, 52], label: 'Home', value: kw(load), icon: '🏠', color: theme.load },
      battery: { p: [78, 58], label: 'Battery', value: Number.isFinite(soc) ? `${soc.toFixed(0)}%` : kw(battery), icon: '🔋', color: theme.battery },
      dc: { p: [78, 84], label: 'DC Charger', value: '0.00 kW', icon: '🔌', color: theme.dc },
    };
    const line = (name, from, to, color, active) => ({
      name,
      type: 'lines',
      coordinateSystem: 'cartesian2d',
      data: [{ coords: [from, to] }],
      lineStyle: { color, width: active ? 5 : 2, opacity: active ? .82 : .18, curveness: .18, type: active ? 'solid' : 'dashed' },
      effect: { show: active, period: 2.2, trailLength: .34, symbol: 'arrow', symbolSize: 13, color },
    });
    const graphics = Object.values(nodes).map(node => ({
      type: 'group', z: 20, left: `${node.p[0]}%`, top: `${node.p[1]}%`, bounding: 'raw',
      children: [
        { type: 'rect', left: -68, top: -38, shape: { width: 136, height: 76, r: 38 }, style: { fill: 'rgba(12,18,28,.9)', stroke: node.color, lineWidth: 1.5, shadowBlur: 18, shadowColor: 'rgba(0,0,0,.45)' } },
        { type: 'text', left: -50, top: -12, style: { text: node.icon, fontSize: 22 } },
        { type: 'text', left: -18, top: -20, style: { text: node.label.toUpperCase(), fill: theme.muted, fontSize: 10, fontWeight: 700 } },
        { type: 'text', left: -18, top: 0, style: { text: node.value, fill: theme.text, fontSize: 19, fontWeight: 900, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' } },
      ],
    }));

    flowChart.current.setOption({
      backgroundColor: 'transparent',
      grid: { left: 0, right: 0, top: 0, bottom: 0 },
      xAxis: { min: 0, max: 100, show: false, type: 'value' },
      yAxis: { min: 0, max: 100, inverse: true, show: false, type: 'value' },
      graphic: [
        { type: 'image', left: 0, top: 0, right: 0, bottom: 0, silent: true, z: 0, style: { image: '/image.png', opacity: .28 } },
        { type: 'text', right: 18, top: 14, z: 30, style: { text: `Grid ${gridMode} · Battery ${batteryMode}`, fill: theme.muted, fontSize: 12, fontWeight: 700, backgroundColor: 'rgba(7,11,18,.55)', borderColor: theme.border, borderWidth: 1, borderRadius: 14, padding: [7, 10] } },
        ...graphics,
      ],
      series: [
        line('PV → Home', nodes.solar.p, nodes.home.p, theme.solar, pv > threshold),
        line('Grid → Home', nodes.grid.p, nodes.home.p, theme.grid, grid < -threshold),
        line('Home → Grid', nodes.home.p, nodes.grid.p, theme.grid, grid > threshold),
        line('Battery → Home', nodes.battery.p, nodes.home.p, theme.battery, battery < -threshold),
        line('Home → Battery', nodes.home.p, nodes.battery.p, theme.battery, battery > threshold),
        line('Battery → DC Charger', nodes.battery.p, nodes.dc.p, theme.dc, false),
      ],
    }, true);
  }, [values]);

  useEffect(() => {
    if (!trendChart.current || !history) return;
    const labels = { pv_power: 'PV Solar', load_power: 'Home Load', grid_flow_power: 'Grid', battery_power: 'Battery', battery_soc: 'Battery SOC' };
    const colors = { pv_power: theme.solar, load_power: theme.load, grid_flow_power: theme.grid, battery_power: theme.battery, battery_soc: '#a78bfa' };
    const keys = Object.keys(labels);
    trendChart.current.setOption({
      color: keys.map(k => colors[k]),
      tooltip: { trigger: 'axis', backgroundColor: '#101722', borderColor: theme.border, textStyle: { color: theme.text } },
      legend: { top: 0, textStyle: { color: theme.muted }, data: keys.map(k => labels[k]) },
      grid: { left: 54, right: 54, top: 48, bottom: 36 },
      xAxis: { type: 'time', axisLabel: { color: theme.muted }, axisLine: { lineStyle: { color: theme.border } } },
      yAxis: [
        { type: 'value', name: 'kW', axisLabel: { color: theme.muted }, splitLine: { lineStyle: { color: theme.border, type: 'dashed' } } },
        { type: 'value', name: '%', min: 0, max: 100, axisLabel: { color: theme.muted }, splitLine: { show: false } },
      ],
      dataZoom: [{ type: 'inside' }],
      series: keys.map(k => ({ name: labels[k], type: 'line', yAxisIndex: k === 'battery_soc' ? 1 : 0, smooth: true, symbol: 'none', lineStyle: { width: k === 'battery_soc' ? 2 : 3, type: k === 'battery_soc' ? 'dashed' : 'solid' }, data: (history[k] || []).map(p => [p.time, p.value]) })),
    }, true);
  }, [history]);

  return (
    <main className="dashboard">
      <header className="topbar">
        <div><p>APACHE ECHARTS · SIGEN APAC · INFLUXDB</p><h1>Sigen Realtime Energy Flow</h1></div>
        <div className="status">{lastUpdated}<b className={online ? 'live' : 'offline'}>{online ? 'LIVE' : 'OFFLINE'}</b></div>
      </header>
      {error && <div className="error">{error}</div>}
      <section className="grid12">
        <aside className="sidebar">
          <Card title="PV Now" value={num(values.pv)} unit="kW" sub="Real-time PV" tone="solar" />
          <Card title="Home Load" value={num(values.homeLoad)} unit="kW" sub="Current demand" tone="load" />
          <Card title="Grid Flow" value={num(Math.abs(values.grid))} unit="kW" sub={values.gridSub} tone="grid" />
        </aside>
        <section className="stage card">
          <div className="head"><h2>Power Flow</h2><p>Animated ECharts lines over image.png</p></div>
          <div ref={flowRef} className="flowChart" />
        </section>
        <aside className="sidebar">
          <Card title="Battery SOC" value={num(values.batterySoc, 0)} unit="%" sub={values.batterySub} tone="battery" />
          <Card title="Self-use" value={values.homeLoad ? '100' : '—'} unit="%" sub="Local supply" tone="load" />
          <Card title="Updated" value={lastUpdated.replace('Updated ', '')} sub="5s polling" tone="grid" />
        </aside>
        <section className="bottom card">
          <div className="head"><h2>24h Energy Time-series</h2><p>InfluxDB /api/history?range=24h</p></div>
          <div ref={trendRef} className="trendChart" />
        </section>
      </section>
      <style jsx>{`
        .dashboard { min-height: 100vh; padding: 20px; background: radial-gradient(circle at 15% 0%, rgba(57,245,139,.13), transparent 24rem), radial-gradient(circle at 88% 8%, rgba(93,183,255,.16), transparent 26rem), ${theme.bg}; color: ${theme.text}; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
        .topbar { display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; }
        .topbar p { margin:0 0 4px; color:${theme.solar}; font-size:11px; letter-spacing:.18em; }
        h1,h2 { margin:0; } .status { color:${theme.muted}; display:flex; gap:12px; align-items:center; } .status b { border-radius:999px; padding:6px 10px; } .status b.live { color:${theme.solar}; border:1px solid ${theme.solar}; } .status b.offline { color:#ff5c5c; border:1px solid #ff5c5c; }
        .grid12 { display:grid; grid-template-columns:3fr 6fr 3fr; gap:16px; max-width:1500px; margin:auto; }
        .sidebar { display:flex; flex-direction:column; gap:12px; } .card,.metric { background:${theme.panel}; border:1px solid ${theme.border}; border-radius:18px; box-shadow:0 16px 50px rgba(0,0,0,.24); backdrop-filter:blur(12px); }
        .metric { padding:16px; min-height:118px; border-top:3px solid currentColor; } .metric span,.metric small,.head p { color:${theme.muted}; } .metric span { font-size:12px; letter-spacing:.08em; text-transform:uppercase; }
        .metric strong { display:block; margin:10px 0 6px; font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace; font-size:32px; font-weight:900; font-variant-numeric:tabular-nums; letter-spacing:-.04em; text-shadow:0 0 18px currentColor; } .solar{color:${theme.solar}} .load{color:${theme.load}} .grid{color:${theme.grid}} .battery{color:${theme.battery}}
        .stage { padding:16px; } .head { display:flex; justify-content:space-between; gap:12px; margin-bottom:8px; } .flowChart { height:490px; width:100%; } .bottom { grid-column:1 / -1; padding:16px; } .trendChart { height:390px; width:100%; } .error { border:1px solid #ff5c5c; background:rgba(255,92,92,.1); color:#ffd5d5; padding:12px; border-radius:12px; margin-bottom:14px; }
        @media (max-width:1100px){ .grid12{grid-template-columns:1fr}.stage{order:-1}.sidebar{display:grid;grid-template-columns:repeat(2,1fr)} } @media(max-width:760px){.topbar{align-items:flex-start;flex-direction:column}.sidebar{grid-template-columns:1fr}.flowChart{height:560px}}
      `}</style>
    </main>
  );
}
