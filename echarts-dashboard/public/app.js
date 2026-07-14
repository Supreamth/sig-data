(() => {
  'use strict';

  const REFRESH_MS = 15000;
  const REALTIME_MS = 5000;
  let currentRange = '2h';
  let refreshTimer = null;
  let realtimeTimer = null;
  let latestSnapshot = null;
  let latestTodayRecommendation = null;
  let latestTeslaContext = null;
  let realtimeFailures = 0;
  let dashboardOnline = true;
  let lastFlowSignature = '';
  let lastTrendSignature = '';
  let weatherActualSolarMarkerCache = null;
  let weatherActualMarkerSig = null;

  function todayLocalDate() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
  }

  let selectedHistoryDate = todayLocalDate();
  let selectedGridCostDays = 7;
  let selectedSummaryPeriod = 'day';
  let lastSummaryFetch = 0;
  let lastGridCostFetch = 0;
  let lastDcCostFetch = 0;
  let lastTeslaContextFetch = 0;
  let lastBatteryFullFetch = 0;
  const ANALYTICS_REFRESH_MS = 60000;
  const BATTERY_FULL_REFRESH_MS = 300000;

  const colors = {
    pv_power: '#35d07f',
    load_power: '#58a6ff',
    grid_flow_power: '#f7c948',
    battery_power: '#b47cff',
    battery_soc: '#b47cff',
    inverter: '#2dd4bf',
    ac_power: '#06b6d4',
    ev_power: '#22d3ee',
    generator_power: '#f97316',
    heat_pump_power: '#ef4444',
    third_pv_power: '#84cc16',
    danger: '#ff5c5c',
    text: '#edf4ff',
    muted: '#91a4bd',
    border: '#273347',
    panel: '#101722',
    grid_cost: '#f97316'
  };

  const labels = {
    pv_power: 'PV Solar',
    load_power: 'Home Load',
    grid_flow_power: 'Grid',
    battery_power: 'Battery',
    battery_soc: 'Battery SOC',
    ac_power: 'AC Coupled',
    ev_power: 'DC Charger',
    generator_power: 'Generator',
    heat_pump_power: 'Heat Pump',
    third_pv_power: '3rd PV'
  };


  const i18n = {
    th: {
      'top.realtime': 'เรียลไทม์ · รีเฟรชอัตโนมัติ 15 วินาที',
      'app.title': 'Sigen Realtime Energy Flow',
      'health.title': 'สุขภาพระบบและคุณภาพข้อมูล',
      'health.subtitle': 'สถานะ Collector, ความสดของข้อมูล และสถานะสถานี',
      'health.dataStatus': 'สถานะข้อมูล', 'health.energyAge': 'อายุข้อมูลพลังงาน', 'health.stationInfo': 'ข้อมูลสถานี',
      'todayRec.eyebrow': 'Weather + Sigen Telemetry', 'todayRec.title': 'คำแนะนำวันนี้', 'todayRec.pvOutlook': 'PV Outlook', 'todayRec.bestWindow': 'ช่วงเหมาะใช้ไฟ', 'todayRec.batteryStrategy': 'Battery Strategy', 'todayRec.dcCharger': 'DC Charger', 'todayRec.confidence': 'Confidence',
      'todayRec.outlook.high': 'สูง', 'todayRec.outlook.medium': 'กลาง', 'todayRec.outlook.low': 'ต่ำ', 'todayRec.outlook.night': 'กลางคืน', 'todayRec.outlook.no-data': 'ไม่มีข้อมูล',
      'todayRec.battery.use_freely': 'ใช้ได้ตามปกติ', 'todayRec.battery.preserve': 'สำรอง Battery', 'todayRec.battery.charge_priority': 'เน้นชาร์จ', 'todayRec.battery.normal': 'ปกติ',
      'todayRec.dc.recommended': 'แนะนำ', 'todayRec.dc.optional': 'ตามความจำเป็น', 'todayRec.dc.avoid': 'หลีกเลี่ยง',
      'todayRec.conf.high': 'สูง', 'todayRec.conf.medium': 'กลาง', 'todayRec.conf.low': 'ต่ำ', 'todayRec.loading': 'กำลังวิเคราะห์ forecast และข้อมูลพลังงานจริง…', 'todayRec.updated': 'อัปเดต',
      'status.db': 'เวลาในฐานข้อมูล', 'status.grid': 'Grid', 'status.station': 'Station',
      'metric.pvNow': 'PV ตอนนี้', 'metric.homeLoad': 'โหลดบ้าน', 'metric.gridFlow': 'การไหล Grid', 'metric.gridIdle': 'เวลาไม่ใช้ Grid', 'metric.gridCost': 'ค่าไฟวันนี้', 'metric.batterySoc': 'Battery SOC', 'metric.weather': 'อากาศ', 'metric.selfUse': 'Self-use',
      'metric.todayKwh': 'วันนี้ — kWh', 'metric.currentDemand': 'โหลดปัจจุบัน', 'metric.gridIdleSub': 'ไม่ใช้ Grid วันนี้',
      'flow.title': 'Power Flow', 'flow.subtitle': 'PV, โหลด, Grid และ Battery — อัปเดตใกล้เรียลไทม์',
      'history.title': 'วันที่ย้อนหลัง', 'history.note': 'การ์ดเรียลไทม์ (KPI · Power Flow · Battery Details) ยังเป็นข้อมูลสด',
      'common.today': 'วันนี้', 'common.status': 'สถานะ', 'common.localTime': 'เวลาท้องถิ่น', 'common.noData': 'ไม่มีข้อมูล',
      'weatherActual.title': 'อากาศ VS กำลังผลิต PV จริง', 'source.title': 'แหล่งพลังงานวันนี้', 'source.subtitle': 'วันนี้ / 00:00 → ข้อมูลล่าสุด',
      'battery.title': 'รายละเอียด Battery', 'battery.subtitle': 'ค่า Battery รวมจาก telemetry ปัจจุบันของ Sigen', 'battery.note': 'Gauge ย้ายไปที่ Battery node ใน Power Flow', 'battery.capacity': 'ความจุรวม', 'battery.stored': 'พลังงานคงเหลือโดยประมาณ', 'battery.power': 'กำลังปัจจุบัน', 'battery.time': 'เวลาประมาณ', 'battery.reserveEta': 'Reserve ETA (สำรอง 10%)',
      'bft.title': 'เวลา Battery เต็ม', 'bft.first': '100% ครั้งแรกวันนี้', 'bft.sunrise': 'จาก Sunrise', 'bft.pvStart': 'จากเริ่ม PV', 'bft.afterSunrise': 'หลัง sunrise', 'bft.afterPv': 'หลังเริ่ม PV',
      'gridCost.title': 'แนวโน้มค่าไฟ Grid และมูลค่า Solar', 'gridCost.subtitle': 'ค่าไฟ Grid รายวัน, มูลค่า Solar โดยประมาณ และพลังงาน', 'trend.title': 'แนวโน้ม Battery SOC', 'trend.subtitle': 'ข้อมูลย้อนหลัง 24 ชั่วโมงจาก InfluxDB',
      'dc.title': 'DC Charger', 'dc.route': 'Home / Load Bus → DC Charger', 'dc.rate': 'Rate: ฿4.22/kWh', 'dc.noTelemetry': 'ไม่มีข้อมูล charger', 'dc.loadSide': 'อุปกรณ์ฝั่งโหลด', 'dc.realTelemetry': 'ข้อมูลจริง ev_power', 'dc.lastCharge': 'ชาร์จล่าสุด', 'dc.month': 'เดือนนี้', 'dc.total': 'รวมที่บันทึก', 'dc.stat': 'สถิติ DC Charging',
      'summary.title': 'สรุปพลังงาน · คำแนะนำ · Energy Optimization', 'summary.subtitle': 'คำนวณจากข้อมูลจริงทั้งหมดใน InfluxDB ตามช่วงเวลาที่เลือก', 'summary.loading': 'กำลังโหลดสรุปพลังงาน…',
      'summary.period.day': 'วันนี้', 'summary.period.week': 'สัปดาห์', 'summary.period.month': 'เดือน', 'summary.period.year': 'ปี', 'summary.period.all': 'ทั้งหมด',
      'summary.kpi.pv': 'ผลิต Solar', 'summary.kpi.load': 'ใช้ไฟบ้าน', 'summary.kpi.import': 'ซื้อ Grid', 'summary.kpi.export': 'ส่งออก', 'summary.kpi.cost': 'ค่าไฟ', 'summary.kpi.self': 'Self-use', 'summary.kpi.score': 'Optimization Score',
      'summary.opt.title': 'Energy Optimization', 'summary.opt.solarWindow': 'ช่วงเหมาะใช้ไฟหนัก', 'summary.opt.importWindow': 'ช่วงซื้อไฟสูงสุด', 'summary.opt.saving': 'โอกาสประหยัด', 'summary.opt.battery': 'Battery Strategy', 'summary.recs.title': 'คำแนะนำจากข้อมูลจริง', 'summary.recs.loading': 'กำลังวิเคราะห์ข้อมูล…',
      'status.live': 'live', 'status.offline': 'offline', 'status.connecting': 'กำลังเชื่อมต่อ…', 'status.updated': 'อัปเดต',
      'connected': 'Connected', 'disconnected': 'Disconnected', 'grid.exporting': 'Exporting to grid', 'grid.importing': 'Importing from grid', 'grid.idle': 'Grid idle',
      'battery.charging': 'Charging', 'battery.discharging': 'Discharging', 'battery.idle': 'Idle',
      'summary.periodText.day': 'วันนี้', 'summary.periodText.week': 'สัปดาห์นี้', 'summary.periodText.month': 'เดือนนี้', 'summary.periodText.year': 'ปีนี้', 'summary.periodText.all': 'ทั้งหมด',
      'summary.dataQuality': 'คุณภาพข้อมูล', 'summary.coverage': 'coverage', 'summary.samples': 'samples', 'summary.maxGap': 'gap สูงสุด', 'summary.latest': 'latest',
      'summary.computed': 'คำนวณจาก time-series จริง', 'summary.selfSuff': 'Self-sufficiency', 'summary.source': 'source', 'summary.rate': 'ที่ rate ฿4.22/kWh', 'summary.noPeak': 'ไม่มีข้อมูล peak', 'summary.shiftable': 'โหลดที่น่าย้ายได้', 'summary.exportAfterFull': 'Export หลังแบตเต็ม', 'summary.notFull': 'ยังไม่เต็ม/ไม่มีข้อมูล', 'summary.noRecs': 'ยังไม่มีคำแนะนำจากข้อมูลช่วงนี้', 'summary.approxSaving': 'ประหยัดได้ประมาณ', 'summary.solarSurplusWindow': 'Solar surplus/export', 'summary.pvProductionWindow': 'ผลิต PV',
      'summary.chart.pv': 'Solar ผลิต', 'summary.chart.load': 'ใช้ไฟบ้าน', 'summary.chart.import': 'ซื้อ Grid', 'summary.chart.export': 'ส่งออก', 'summary.chart.battCharge': 'Battery Charge', 'summary.chart.battDischarge': 'Battery Discharge'
    },
    en: {
      'top.realtime': 'Realtime · Auto refresh 15s',
      'app.title': 'Sigen Realtime Energy Flow',
      'health.title': 'System Health & Data Quality', 'health.subtitle': 'Collector status, data freshness, and station availability', 'health.dataStatus': 'Data Status', 'health.energyAge': 'Energy Data Age', 'health.stationInfo': 'Station Info',
      'todayRec.eyebrow': 'Weather + Sigen Telemetry', 'todayRec.title': 'Today Recommendation', 'todayRec.pvOutlook': 'PV Outlook', 'todayRec.bestWindow': 'Best Usage Window', 'todayRec.batteryStrategy': 'Battery Strategy', 'todayRec.dcCharger': 'DC Charger', 'todayRec.confidence': 'Confidence',
      'todayRec.outlook.high': 'High', 'todayRec.outlook.medium': 'Medium', 'todayRec.outlook.low': 'Low', 'todayRec.outlook.night': 'Night', 'todayRec.outlook.no-data': 'No data',
      'todayRec.battery.use_freely': 'Use freely', 'todayRec.battery.preserve': 'Preserve', 'todayRec.battery.charge_priority': 'Charge priority', 'todayRec.battery.normal': 'Normal',
      'todayRec.dc.recommended': 'Recommended', 'todayRec.dc.optional': 'Optional', 'todayRec.dc.avoid': 'Avoid',
      'todayRec.conf.high': 'High', 'todayRec.conf.medium': 'Medium', 'todayRec.conf.low': 'Low', 'todayRec.loading': 'Analyzing forecast and real energy telemetry…', 'todayRec.updated': 'Updated',
      'status.db': 'DB Timestamp', 'status.grid': 'Grid', 'status.station': 'Station',
      'metric.pvNow': 'PV Now', 'metric.homeLoad': 'Home Load', 'metric.gridFlow': 'Grid Flow', 'metric.gridIdle': 'Grid Idle Time', 'metric.gridCost': 'Grid Cost Today', 'metric.batterySoc': 'Battery SOC', 'metric.weather': 'Weather', 'metric.selfUse': 'Self-use',
      'metric.todayKwh': 'Today — kWh', 'metric.currentDemand': 'Current demand', 'metric.gridIdleSub': 'not using grid today',
      'flow.title': 'Power Flow', 'flow.subtitle': 'PV, load, grid, and battery — near real-time cadence',
      'history.title': 'History Date', 'history.note': 'Realtime cards (KPI · Power Flow · Battery Details) remain live',
      'common.today': 'Today', 'common.status': 'Status', 'common.localTime': 'local time', 'common.noData': 'No data',
      'weatherActual.title': 'Weather VS Actual PV Power', 'source.title': 'Energy Sources Today', 'source.subtitle': 'Today / 00:00 → latest actual',
      'battery.title': 'Battery Details', 'battery.subtitle': 'Aggregate battery values from current Sigen telemetry', 'battery.note': 'Gauge moved to Power Flow battery node', 'battery.capacity': 'Total Capacity', 'battery.stored': 'Estimated Stored', 'battery.power': 'Current Power', 'battery.time': 'Estimated Time', 'battery.reserveEta': 'Reserve ETA (10%)',
      'bft.title': 'Battery Full Time', 'bft.first': 'First 100% Today', 'bft.sunrise': 'From Sunrise', 'bft.pvStart': 'From PV Start', 'bft.afterSunrise': 'after sunrise', 'bft.afterPv': 'after PV started',
      'gridCost.title': 'Grid Cost & Solar Value Trend', 'gridCost.subtitle': 'Daily grid cost, estimated solar value and energy', 'trend.title': 'Battery SOC Trend', 'trend.subtitle': '24-hour time-series from InfluxDB',
      'dc.title': 'DC Charger', 'dc.route': 'Home / Load Bus → DC Charger', 'dc.rate': 'Rate: ฿4.22/kWh', 'dc.noTelemetry': 'No charger telemetry', 'dc.loadSide': 'Load-side device', 'dc.realTelemetry': 'Real ev_power telemetry', 'dc.lastCharge': 'Last charge', 'dc.month': 'This month', 'dc.total': 'Total recorded', 'dc.stat': 'DC Charging Stat',
      'summary.title': 'Energy Summary · Recommendations · Energy Optimization', 'summary.subtitle': 'Calculated from all collected InfluxDB data for the selected period', 'summary.loading': 'Loading energy summary…',
      'summary.period.day': 'Today', 'summary.period.week': 'Week', 'summary.period.month': 'Month', 'summary.period.year': 'Year', 'summary.period.all': 'All',
      'summary.kpi.pv': 'Solar Generation', 'summary.kpi.load': 'Home Consumption', 'summary.kpi.import': 'Grid Import', 'summary.kpi.export': 'Grid Export', 'summary.kpi.cost': 'Grid Cost', 'summary.kpi.self': 'Self-use', 'summary.kpi.score': 'Optimization Score',
      'summary.opt.title': 'Energy Optimization', 'summary.opt.solarWindow': 'Best solar window', 'summary.opt.importWindow': 'Grid import peak', 'summary.opt.saving': 'Saving opportunity', 'summary.opt.battery': 'Battery Strategy', 'summary.recs.title': 'Data-driven recommendations', 'summary.recs.loading': 'Analyzing data…',
      'status.live': 'live', 'status.offline': 'offline', 'status.connecting': 'connecting…', 'status.updated': 'Updated',
      'connected': 'Connected', 'disconnected': 'Disconnected', 'grid.exporting': 'Exporting to grid', 'grid.importing': 'Importing from grid', 'grid.idle': 'Grid idle',
      'battery.charging': 'Charging', 'battery.discharging': 'Discharging', 'battery.idle': 'Idle',
      'summary.periodText.day': 'Today', 'summary.periodText.week': 'This week', 'summary.periodText.month': 'This month', 'summary.periodText.year': 'This year', 'summary.periodText.all': 'All time',
      'summary.dataQuality': 'Data quality', 'summary.coverage': 'coverage', 'summary.samples': 'samples', 'summary.maxGap': 'largest gap', 'summary.latest': 'latest',
      'summary.computed': 'calculated from real time-series', 'summary.selfSuff': 'Self-sufficiency', 'summary.source': 'source', 'summary.rate': 'at ฿4.22/kWh', 'summary.noPeak': 'no peak data', 'summary.shiftable': 'shiftable load', 'summary.exportAfterFull': 'Export after battery full', 'summary.notFull': 'not full / no data', 'summary.noRecs': 'No recommendations for this period yet', 'summary.approxSaving': 'estimated saving', 'summary.solarSurplusWindow': 'Solar surplus/export', 'summary.pvProductionWindow': 'PV production',
      'summary.chart.pv': 'Solar Generation', 'summary.chart.load': 'Home Load', 'summary.chart.import': 'Grid Import', 'summary.chart.export': 'Grid Export', 'summary.chart.battCharge': 'Battery Charge', 'summary.chart.battDischarge': 'Battery Discharge'
    }
  };

  let currentLang = localStorage.getItem('dashboardLang') || 'th';
  if (!i18n[currentLang]) currentLang = 'th';
  function t(key) { return (i18n[currentLang] && i18n[currentLang][key]) || (i18n.th && i18n.th[key]) || key; }
  function applyLanguage() {
    document.documentElement.lang = currentLang === 'th' ? 'th' : 'en';
    document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll('.lang-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.lang === currentLang));
  }
  function setLanguage(lang) {
    if (!i18n[lang]) return;
    currentLang = lang;
    localStorage.setItem('dashboardLang', lang);
    applyLanguage();
    if (latestSnapshot) updateMetrics(latestSnapshot);
    if (latestTodayRecommendation) updateTodayRecommendation(latestTodayRecommendation);
    refresh();
  }

  const optionalDevices = [
    ['ev_power', 'DC Charger', colors.ev_power]
  ];

  const chartTheme = {
    textStyle: { color: colors.text, fontFamily: 'Inter, system-ui, sans-serif' },
    grid: { borderColor: colors.border }
  };

  const charts = {
    source: echarts.init(document.getElementById('source-chart'), chartTheme),
    trend: echarts.init(document.getElementById('trend-chart'), chartTheme),
    devices: document.getElementById('devices-chart') ? echarts.init(document.getElementById('devices-chart'), chartTheme) : null,
    flow: echarts.init(document.getElementById('flow-chart'), chartTheme),
    weatherForecast: document.getElementById('weather-forecast-chart') ? echarts.init(document.getElementById('weather-forecast-chart'), chartTheme) : null,
    sunArc: document.getElementById('sun-arc-chart') ? echarts.init(document.getElementById('sun-arc-chart'), chartTheme) : null,
    weatherActual: echarts.init(document.getElementById('weather-actual-chart'), chartTheme),
    sunPath: document.getElementById('sun-path-chart') ? echarts.init(document.getElementById('sun-path-chart'), chartTheme) : null,
    hybridSolar: document.getElementById('hybrid-solar-chart') ? echarts.init(document.getElementById('hybrid-solar-chart'), chartTheme) : null,
    timeShift: document.getElementById('time-shift-chart') ? echarts.init(document.getElementById('time-shift-chart'), chartTheme) : null,
    timeShiftGeometry: document.getElementById('time-shift-geometry-chart') ? echarts.init(document.getElementById('time-shift-geometry-chart'), chartTheme) : null,
    gridCost: document.getElementById('grid-cost-chart') ? echarts.init(document.getElementById('grid-cost-chart'), chartTheme) : null,
    dcChargingStat: document.getElementById('dc-charging-stat-chart') ? echarts.init(document.getElementById('dc-charging-stat-chart'), chartTheme) : null,
    batteryFullTime: document.getElementById('battery-full-time-chart') ? echarts.init(document.getElementById('battery-full-time-chart'), chartTheme) : null,
    summaryEnergy: document.getElementById('summary-energy-chart') ? echarts.init(document.getElementById('summary-energy-chart'), chartTheme) : null
  };

  function n(v) {
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  }

  function fmt(v, unit = '', dec = 1) {
    const x = n(v);
    return x === null ? '—' : `${x.toFixed(dec)}${unit}`;
  }

  function abs(v) { return Math.abs(n(v) || 0); }
  function kw(v) { return `${abs(v).toFixed(2)} kW`; }
  function formatDurationHours(hours) {
    const x = n(hours);
    if (x === null || x < 0) return '—';
    const totalMinutes = Math.round(x * 60);
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
    return `${m}m`;
  }

  function formatMinutesValue(minutes) {
    const x = n(minutes);
    if (x === null) return '—';
    const sign = x > 0 ? '+' : x < 0 ? '-' : '';
    const total = Math.abs(Math.round(x));
    const h = Math.floor(total / 60);
    const m = total % 60;
    const body = h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
    return `${sign}${body}`;
  }

  function timeOrDash(value) {
    return value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
  }

  function setText(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }
  function setHtml(id, html) { const el = document.getElementById(id); if (el) el.innerHTML = html; }
  function escapeHtml(value) {
    return String(value ?? '—')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function setDot(id, state) { const el = document.getElementById(id); if (el) el.className = `dot ${state}`; }
  function showError(msg) {
    const el = document.getElementById('error-container');
    if (el) el.innerHTML = msg ? `<div class="error-msg">${msg}</div>` : '';
  }
  function setBadge(ok, label) {
    const el = document.getElementById('status-badge');
    if (!el) return;
    el.textContent = label || (ok ? t('status.live') : t('status.offline'));
    el.className = ok ? 'live' : 'error';
  }
  function setConnectivity(ok, message = '') {
    dashboardOnline = ok;
    realtimeFailures = ok ? 0 : realtimeFailures;
    setBadge(ok, ok ? t('status.live') : t('status.offline'));
    document.body.classList.toggle('is-offline', !ok);
    const retry = realtimeFailures ? ` · reconnect in ${Math.min(60, 2 ** Math.min(realtimeFailures, 5))}s` : '';
    showError(ok ? '' : `${message || 'API / InfluxDB offline'}${retry}`);
    if (!ok) setText('last-updated', t('status.offline'));
  }
  function nextRealtimeDelay() {
    return dashboardOnline ? REALTIME_MS : Math.min(60000, 1000 * (2 ** Math.min(realtimeFailures, 5)));
  }

  function historyDayBounds(dateKey) {
    if (!dateKey || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return { start: null, end: null, endMs: null };
    const [y, m, d] = dateKey.split('-').map(Number);
    const nextKey = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
    const start = new Date(dateKey + 'T00:00:00+07:00').toISOString();
    const end = new Date(nextKey + 'T00:00:00+07:00').toISOString();
    return { start, end, endMs: new Date(end).getTime() };
  }

  function axisStyle() {
    return {
      axisLabel: { color: colors.muted },
      axisLine: { lineStyle: { color: colors.border } },
      splitLine: { lineStyle: { color: colors.border, type: 'dashed' } }
    };
  }

  function updateMetrics(latest) {
    latestSnapshot = latest;
    const e = latest.energy || {};
    const w = latest.weather || {};
    const pv = n(e.pv_power) || 0;
    const load = n(e.load_power) || 0;
    const battery = n(e.battery_power) || 0;
    const grid = n(e.grid_flow_power) || 0;
    const selfUse = load > 0 ? Math.max(0, Math.min(100, ((load - Math.max(0, -grid)) / load) * 100)) : null;
    const d = latest.daily || {};
    const gridIdleMin = n(d.grid_idle_minutes) || 0;
    const gridIdleStr = (() => {
      if (gridIdleMin >= 60) {
        const h = Math.floor(gridIdleMin / 60);
        const m = Math.round(gridIdleMin % 60);
        return m > 0 ? `${h}h ${m}m` : `${h}h`;
      }
      return `${Math.round(gridIdleMin)}m`;
    })();

    setText('m-pv', fmt(e.pv_power, ' kW'));
    setText('m-pv-sub', `${t('common.today')} ${fmt(e.pv_day_nrg, ' kWh')}`);
    setText('m-load', fmt(e.load_power, ' kW'));
    setText('m-soc', fmt(e.battery_soc, '%', 0));
    setText('m-batt-sub', `${battery > 0 ? t('battery.charging') : battery < 0 ? t('battery.discharging') : t('battery.idle')} ${kw(battery)}`);
    setText('m-grid', fmt(Math.abs(grid), ' kW'));
    setText('m-grid-sub', grid > 0 ? t('grid.exporting') : grid < 0 ? t('grid.importing') : t('grid.idle'));
    setText('m-grid-idle', gridIdleStr);
    setText('m-grid-idle-sub', currentLang === 'th' ? 'ไม่ใช้ Grid วันนี้ (00:00–ตอนนี้)' : 'not using grid today (00:00–now)');
    const gridCostToday = n(d.grid_cost_thb_today);
    const gridImportToday = n(d.grid_import_kwh_today);
    const gridRate = n(d.grid_cost_rate_thb_per_kwh);
    setText('m-grid-cost', gridCostToday !== null ? `฿${gridCostToday.toFixed(2)}` : '—');
    setText('m-grid-cost-sub', gridImportToday !== null ? `${gridImportToday.toFixed(2)} kWh${gridRate !== null ? ` · ฿${gridRate.toFixed(2)}/kWh` : ''}` : '—');
    setText('m-weather', w.temperature === undefined ? '—' : fmt(w.temperature, '°C'));
    setText('m-weather-sub', w.windspeed === undefined ? '—' : `wind ${fmt(w.windspeed, ' km/h', 0)} · ${fmt(w.winddirection, '°', 0)}`);
    setText('m-self-use', selfUse === null ? '—' : `${selfUse.toFixed(0)}%`);
    setText('m-self-use-sub', `${fmt(load - Math.max(0, -grid), ' kW')} local supply`);
    setText('grid-state', e.on_grid ? t('connected') : t('disconnected'));
    setText('station-state', e.station_status === undefined ? '—' : `Code ${e.station_status}`);
    setText('db-ts', latest.timestamp ? new Date(latest.timestamp).toLocaleTimeString() : '—');
    setDot('grid-dot', e.on_grid ? 'on' : 'warn');
    setDot('station-dot', e.station_status == 1 || e.station_status == 2 ? 'on' : 'warn');
    setText('last-updated', `Updated ${new Date().toLocaleTimeString()}`);
  }

  function drawFlow(latest) {
    const el = document.getElementById('flow-chart');
    if (!el || !charts.flow) return;
    const e = latest.energy || {};
    const pvStrings = latest.pv_strings || {};
    const batteryModules = Array.isArray(latest.battery_modules) ? latest.battery_modules : ((latest.battery && latest.battery.modules) || []);
    const pv = n(e.pv_power) || 0;
    const load = n(e.load_power) || 0;
    const battery = n(e.battery_power) || 0;
    const grid = n(e.grid_flow_power) || 0;
    const dcCharger = n(e.ev_power) || 0;
    const soc = n(e.battery_soc);
    const pvDay = n(e.pv_day_nrg);
    const threshold = 0.05;
    const pvStringItems = [1, 2, 3, 4].map(i => {
      const power = n(pvStrings[`pv${i}_power`]);
      const today = n(pvStrings[`pv${i}_today_kwh`]);
      return { id: `pv${i}`, label: `PV${i}`, power, today };
    });
    const selfUse = load > 0 ? Math.max(0, Math.min(100, ((load - Math.max(0, -grid)) / load) * 100)) : null;
    const gridMode = grid < -threshold ? 'Importing' : grid > threshold ? 'Exporting' : 'Idle';
    const batteryMode = battery > threshold ? 'Charging' : battery < -threshold ? 'Discharging' : 'Idle';
    const w = Math.max(el.clientWidth, 640);
    const h = Math.max(el.clientHeight, 420);
    const teslaLatest = latestTeslaContext && (latestTeslaContext.tesla_latest || latestTeslaContext);
    const hasTeslaData = Boolean(teslaLatest && teslaLatest.has_data !== false && (teslaLatest.charge || teslaLatest.vehicle || teslaLatest.health));
    const teslaCharge = hasTeslaData ? (teslaLatest.charge || {}) : {};
    const teslaSoc = nNullable(teslaCharge.battery_level_pct);
    const teslaChargerPower = nNullable(teslaCharge.charger_power_kw);
    const teslaChargingCode = nNullable(teslaCharge.charging_state_code);
    const teslaCharging = hasTeslaData && (teslaChargingCode === 2 || (teslaChargerPower !== null && teslaChargerPower > threshold));
    const teslaState = hasTeslaData
      ? (teslaCharging ? 'Charging' : 'Idle')
      : 'No data';
    const teslaLinkActive = teslaCharging && dcCharger > threshold;
    const teslaLinkLabel = hasTeslaData
      ? (teslaChargerPower === null ? 'Tesla telemetry' : `Tesla ${fmtTeslaKw(teslaChargerPower)}`)
      : 'No Tesla data';

    const signature = [
      pv, load, battery, grid, dcCharger, soc, pvDay,
      hasTeslaData, teslaSoc, teslaChargerPower, teslaChargingCode,
      ...pvStringItems.flatMap(item => [item.power, item.today]),
      ...batteryModules.flatMap(module => [
        module.battery_index, module.device_sn, module.average_cell_voltage,
        module.average_cell_temperature, module.total_discharge_kwh, module.safe_guard_score
      ])
    ].map(v => Number.isFinite(v) ? Number(v).toFixed(3) : String(v)).join('|');
    if (signature === lastFlowSignature) return;
    lastFlowSignature = signature;

    const flowColors = {
      solar: '#39f58b',
      grid: '#ffd166',
      home: '#5db7ff',
      battery: '#c084fc',
      dc: '#22d3ee',
      pv1: '#35d07f',
      pv2: '#22d3ee',
      pv3: '#f59e0b',
      pv4: '#60a5fa',
      batteryModule: '#d8b4fe',
      tesla: '#ff4f9a'
    };
    const iconBase = '/assets/power-flow-icons/';
    const pvNodePositions = { pv1: [16, 9], pv2: [37, 9], pv3: [58, 9], pv4: [78, 9] };
    const pvNodes = Object.fromEntries(pvStringItems.map(item => {
      const power = item.power;
      const hasData = power !== null;
      const active = hasData && power > threshold;
      return [item.id, {
        p: pvNodePositions[item.id],
        icon: '▣',
        iconUrl: iconBase + 'pv-string.svg',
        label: item.label,
        value: hasData ? kw(power) : '— kW',
        sub: hasData ? (item.today === null ? 'Today —' : `${item.today.toFixed(2)} kWh`) : 'No string data',
        color: active ? flowColors[item.id] : 'rgba(145,164,189,0.55)',
        small: true,
        muted: !active
      }];
    }));
    const batteryModuleItems = [0, 1].map(i => {
      const module = batteryModules[i] || {};
      const voltage = n(module.average_cell_voltage);
      const temp = n(module.average_cell_temperature);
      const discharge = n(module.total_discharge_kwh);
      const hasData = voltage !== null || temp !== null || discharge !== null;
      const label = `Battery ${module.battery_index || i + 1}`;
      const socValue = soc === null ? null : `${soc.toFixed(0)}% SOC`;
      const subParts = [];
      if (voltage !== null) subParts.push(`${voltage.toFixed(3)}V`);
      if (temp !== null) subParts.push(`${temp.toFixed(1)}°C`);
      return {
        id: `batteryModule${i + 1}`,
        module,
        hasData,
        p: i === 0 ? [90, 47] : [90, 65],
        icon: '▣',
        iconUrl: iconBase + 'battery-module.svg',
        label,
        value: socValue || 'SOC —',
        sub: hasData ? `${batteryMode}${subParts.length ? ' · ' + subParts.join(' · ') : ''}` : `${batteryMode} · No module data`,
        color: hasData ? flowColors.batteryModule : 'rgba(145,164,189,0.55)',
        small: true,
        muted: !hasData
      };
    });
    const batteryModuleNodes = Object.fromEntries(batteryModuleItems.map(item => [item.id, item]));
    const nodes = {
      ...pvNodes,
      ...batteryModuleNodes,
      solar: { p: [50, 29], icon: '☀️', iconUrl: iconBase + 'solar-panel.svg', label: 'Solar', value: kw(pv), sub: pvDay === null ? 'Today — kWh' : `Today ${pvDay.toFixed(2)} kWh`, color: flowColors.solar },
      grid: { p: [18, 61], icon: '⚡', iconUrl: iconBase + 'grid-tower.svg', label: 'Grid', value: kw(grid), sub: gridMode, color: flowColors.grid },
      home: { p: [48, 57], icon: '🏠', iconUrl: iconBase + 'home.svg', label: 'Home', value: kw(load), sub: selfUse === null ? 'Self-use —' : `Self-use ${selfUse.toFixed(0)}%`, color: flowColors.home },
      battery: { p: [72, 56], icon: '🔋', iconUrl: iconBase + 'battery.svg', label: 'Battery', value: kw(battery), sub: soc === null ? batteryMode : `${batteryMode} · ${soc.toFixed(0)}%`, color: flowColors.battery },
      dc: { p: [48, 80], icon: '🔌', iconUrl: iconBase + 'dc-charger.svg', label: 'DC Charger', value: kw(dcCharger), sub: dcCharger > threshold ? 'Active / charging' : 'Idle / not in use', color: flowColors.dc },
      tesla: {
        p: [82, 80],
        icon: '🚗',
        label: 'Tesla Model Y',
        value: hasTeslaData ? (teslaSoc === null ? 'SOC —' : `${Math.round(teslaSoc)}% SOC`) : 'No Tesla data',
        sub: hasTeslaData ? (teslaCharging ? `Charging${teslaChargerPower === null ? '' : ' · ' + fmtTeslaKw(teslaChargerPower)}` : 'Idle') : 'No Tesla data',
        color: hasTeslaData ? (teslaCharging ? flowColors.tesla : 'rgba(248,113,113,0.62)') : 'rgba(145,164,189,0.55)',
        width: 158,
        muted: !hasTeslaData
      }
    };

    const activeLine = (name, from, to, color, active, valueText) => ({
      name,
      type: 'lines',
      coordinateSystem: 'cartesian2d',
      zlevel: 0,
      z: 1,
      silent: false,
      polyline: false,
      data: [{ coords: [from, to], valueText }],
      lineStyle: {
        color,
        width: active ? 5 : 2,
        opacity: active ? 0.78 : 0.16,
        curveness: 0.18,
        type: active ? 'solid' : 'dashed'
      },
      effect: {
        show: active,
        period: 2.2,
        trailLength: 0.34,
        symbol: 'arrow',
        symbolSize: 13,
        color
      }
    });

    // Box pixel sizes mirror nodeGraphic; convert to chart-coord half-extents on demand.
    const BOX_WIDTHS = { pv1: 110, pv2: 110, pv3: 110, pv4: 110, batteryModule1: 110, batteryModule2: 110, solar: 136, grid: 136, home: 150, battery: 136, dc: 136, tesla: 158 };
    const BOX_HEIGHTS = { pv1: 56, pv2: 56, pv3: 56, pv4: 56, batteryModule1: 56, batteryModule2: 56, solar: 78, grid: 78, home: 78, battery: 78, dc: 78, tesla: 78 };
    // Returns [fromEdgePt, toEdgePt] in chart (0-100) coords so lines stop at card faces.
    const edgeToEdge = (fromKey, toKey) => {
      const [cx1, cy1] = nodes[fromKey].p;
      const [cx2, cy2] = nodes[toKey].p;
      const dx = cx2 - cx1, dy = cy2 - cy1;
      if (Math.abs(dx) + Math.abs(dy) < 1e-9) return [nodes[fromKey].p, nodes[toKey].p];
      const hw1 = (BOX_WIDTHS[fromKey] || 136) * 50 / w, hh1 = (BOX_HEIGHTS[fromKey] || 78) * 50 / h;
      const hw2 = (BOX_WIDTHS[toKey] || 136)  * 50 / w, hh2 = (BOX_HEIGHTS[toKey] || 78) * 50 / h;
      // t where ray exits FROM box
      const t0 = Math.min(
        Math.abs(dx) > 1e-9 ? hw1 / Math.abs(dx) : Infinity,
        Math.abs(dy) > 1e-9 ? hh1 / Math.abs(dy) : Infinity
      );
      // t where ray enters TO box (measured from FROM center, full line = t=1)
      const t1 = Math.max(
        Math.abs(dx) > 1e-9 ? 1 - hw2 / Math.abs(dx) : -Infinity,
        Math.abs(dy) > 1e-9 ? 1 - hh2 / Math.abs(dy) : -Infinity
      );
      return [
        [cx1 + t0 * dx, cy1 + t0 * dy],
        [cx1 + t1 * dx, cy1 + t1 * dy]
      ];
    };

    const flowLines = [
      ...pvStringItems.map(item => activeLine(
        `${item.label} → Solar`,
        ...edgeToEdge(item.id, 'solar'),
        flowColors[item.id],
        item.power !== null && item.power > threshold,
        item.power === null ? 'No string data' : kw(item.power)
      )),
      activeLine('PV → Home',           ...edgeToEdge('solar',   'home'),    flowColors.solar,   pv > threshold,          kw(pv)),
      activeLine('Grid → Home',         ...edgeToEdge('grid',    'home'),    flowColors.grid,    grid < -threshold,        kw(grid)),
      activeLine('Home → Grid',         ...edgeToEdge('home',    'grid'),    flowColors.grid,    grid > threshold,         kw(grid)),
      activeLine('Battery → Home',      ...edgeToEdge('battery', 'home'),    flowColors.battery, battery < -threshold,    kw(battery)),
      activeLine('Home → Battery',      ...edgeToEdge('home',    'battery'), flowColors.battery, battery > threshold,     kw(battery)),
      activeLine('Home → DC Charger',    ...edgeToEdge('home',    'dc'),      flowColors.dc,      dcCharger > threshold,   kw(dcCharger)),
      {
        ...activeLine('DC Charger → Tesla Model Y', ...edgeToEdge('dc', 'tesla'), flowColors.tesla, teslaLinkActive, teslaLinkLabel),
        z: teslaLinkActive ? 8 : 1,
        lineStyle: {
          color: flowColors.tesla,
          width: teslaLinkActive ? 8 : 2,
          opacity: hasTeslaData ? (teslaCharging ? 0.94 : 0.22) : 0.12,
          curveness: 0.18,
          type: teslaLinkActive ? 'solid' : 'dashed',
          shadowBlur: teslaLinkActive ? 14 : 0,
          shadowColor: 'rgba(255,79,154,0.72)'
        },
        effect: {
          show: teslaLinkActive,
          period: 1.8,
          trailLength: 0.46,
          symbol: 'arrow',
          symbolSize: 18,
          color: flowColors.tesla
        },
        label: {
          show: hasTeslaData,
          position: 'middle',
          distance: 18,
          formatter: p => p.data && p.data.valueText ? p.data.valueText : teslaState,
          color: '#ffe4ee',
          fontSize: teslaLinkActive ? 12 : 11,
          fontWeight: 800,
          backgroundColor: 'rgba(15,23,42,0.92)',
          borderColor: 'rgba(255,79,154,0.64)',
          borderWidth: 1,
          borderRadius: 10,
          padding: [5, 8],
          textShadowBlur: 8,
          textShadowColor: 'rgba(255,79,154,0.45)'
        }
      },
      ...batteryModuleItems.map(item => {
        const discharging = battery < -threshold;
        const charging = battery > threshold;
        const valueText = item.hasData
          ? `${batteryMode} · ${item.value}${item.sub ? ' · ' + item.sub.replace(`${batteryMode} · `, '') : ''}`
          : `${batteryMode} · No module data`;
        if (discharging) {
          return activeLine(
            `${item.label} → Battery`,
            ...edgeToEdge(item.id, 'battery'),
            flowColors.batteryModule,
            item.hasData,
            valueText
          );
        }
        // charging: subtle synchronized animation battery→module; idle: static dashed line
        const [from, to] = edgeToEdge('battery', item.id);
        return {
          name: charging ? `Battery → ${item.label}` : `Battery ↔ ${item.label}`,
          type: 'lines',
          coordinateSystem: 'cartesian2d',
          zlevel: 0,
          z: 1,
          silent: false,
          polyline: false,
          data: [{ coords: [from, to], valueText }],
          lineStyle: {
            color: flowColors.batteryModule,
            width: charging ? 3 : 2,
            opacity: charging ? 0.52 : 0.16,
            curveness: 0.18,
            type: charging ? 'solid' : 'dashed'
          },
          effect: {
            show: charging,
            period: 2.2,
            trailLength: 0.22,
            symbol: 'arrow',
            symbolSize: 9,
            color: flowColors.batteryModule
          }
        };
      })
    ];

    const nodeGraphic = node => {
      const boxW = node.width || (node.small ? 110 : (node.label === 'Home' ? 150 : 136));
      const boxH = node.height || (node.small ? 56 : 78);
      const x = (node.p[0] / 100) * w - boxW / 2;
      const y = (node.p[1] / 100) * h - boxH / 2;
      const opacity = node.muted ? 0.72 : 1;
      return {
        type: 'group',
        zlevel: 2,
        z: 20,
        left: x,
        top: y,
        children: [
          { type: 'rect', shape: { width: boxW, height: boxH, r: node.small ? 18 : 38 }, style: { fill: '#0c121c', stroke: 'none', opacity } },
          { type: 'rect', shape: { width: boxW, height: boxH, r: node.small ? 18 : 38 }, style: { fill: 'rgba(12,18,28,0.88)', stroke: node.color, lineWidth: node.small ? 1.1 : 1.4, shadowBlur: node.small ? 10 : 18, shadowColor: 'rgba(0,0,0,0.38)', opacity } },
          { type: 'circle', shape: { cx: node.small ? 20 : 30, cy: boxH / 2, r: node.small ? 14 : 22 }, style: { fill: 'rgba(255,255,255,0.08)', stroke: 'rgba(255,255,255,0.16)', opacity } },
          ...(node.iconUrl
            ? [{ type: 'image', left: node.small ? 7 : 13, top: node.small ? 8 : 16, style: { image: node.iconUrl, width: node.small ? 26 : 34, height: node.small ? 26 : 34, opacity } }]
            : [{ type: 'text', left: node.small ? 13 : 17, top: node.small ? 15 : 23, style: { text: node.icon, fontSize: node.small ? 15 : 22, align: 'center', verticalAlign: 'middle', opacity } }]),
          { type: 'text', left: node.small ? 40 : 60, top: node.small ? 7 : 12, style: { text: node.label.toUpperCase(), fill: colors.muted, fontSize: node.small ? 9 : 10, fontWeight: 700, letterSpacing: 1, opacity } },
          { type: 'text', left: node.small ? 40 : 60, top: node.small ? 23 : 30, style: { text: node.value, fill: colors.text, fontSize: node.small ? 14 : 19, fontWeight: 800, opacity } },
          { type: 'text', left: node.small ? 40 : 60, top: node.small ? 40 : 56, style: { text: node.sub, fill: colors.muted, fontSize: node.small ? 8 : 10, opacity } }
        ]
      };
    };

    charts.flow.setOption({
      animation: true,
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'item',
        formatter: p => p.data && p.data.valueText ? `${p.seriesName}: ${p.data.valueText}` : p.seriesName,
        backgroundColor: colors.panel,
        borderColor: colors.border,
        textStyle: { color: colors.text }
      },
      grid: { left: 0, right: 0, top: 0, bottom: 0 },
      xAxis: { min: 0, max: 100, show: false, type: 'value' },
      yAxis: { min: 0, max: 100, inverse: true, show: false, type: 'value' },
      graphic: [
        { type: 'image', left: 0, top: 0, z: 0, silent: true, style: { image: '/image.png', width: w, height: h, opacity: 0.28 } },
        { type: 'text', left: 18, bottom: 14, zlevel: 1, z: 30, style: { text: `Grid ${gridMode.toLowerCase()} · Battery ${batteryMode.toLowerCase()}`, fill: '#b8c7da', fontSize: 12, fontWeight: 700, backgroundColor: 'rgba(7,11,18,.55)', borderColor: 'rgba(145,164,189,.22)', borderWidth: 1, borderRadius: 14, padding: [7, 10] } },
        ...Object.values(nodes).map(nodeGraphic)
      ],
      series: flowLines
    }, true);
  }

  function drawSource(energySourceMix, dateKey) {
    const todayKey = todayLocalDate();
    const isToday = !dateKey || dateKey === todayKey;
    setText('source-title', isToday ? 'Energy Sources Today' : `Energy Sources ${dateKey}`);

    const mix = energySourceMix;
    const unit = 'kWh';
    let data = [];
    let subtitleText;

    if (mix && mix.unit === 'kWh' && mix.sources && mix.sample_count !== 0) {
      const s = mix.sources;
      data = [
        { name: 'PV Solar', value: s.pv_solar || 0, itemStyle: { color: colors.pv_power } },
        { name: 'Grid Import', value: s.grid_import || 0, itemStyle: { color: colors.grid_flow_power } },
        { name: 'Battery Discharge', value: s.battery_discharge || 0, itemStyle: { color: colors.battery_power } },
        { name: 'Generator', value: s.generator || 0, itemStyle: { color: colors.generator_power } },
        { name: 'AC / 3rd PV', value: s.ac_third_pv || 0, itemStyle: { color: colors.ac_power } }
      ].filter(d => d.value > 0.001);
      const endLabel = mix.end_time
        ? new Date(mix.end_time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' })
        : 'latest';
      subtitleText = isToday ? `Today / 00:00 → ${endLabel}` : `${dateKey} / 00:00 → 24:00`;
    } else if (mix && mix.sample_count === 0) {
      subtitleText = isToday ? 'Today / No samples yet' : `${dateKey} / No data`;
    } else {
      subtitleText = isToday ? 'Today / 00:00 → latest actual' : `${dateKey} / 00:00 → 24:00`;
    }
    setText('source-subtitle', subtitleText);

    const safeData = data.length ? data : [{ name: 'Idle / No Data', value: 1, itemStyle: { color: '#2a3547' } }];

    charts.source.setOption({
      tooltip: { trigger: 'item', formatter: p => `${p.name}: ${p.value.toFixed(3)} ${unit} (${p.percent}%)`, backgroundColor: colors.panel, borderColor: colors.border, textStyle: { color: colors.text } },
      legend: { bottom: 0, textStyle: { color: colors.muted } },
      series: [{
        type: 'pie',
        radius: ['45%', '72%'],
        center: ['50%', '42%'],
        avoidLabelOverlap: true,
        itemStyle: { borderColor: '#0b111b', borderWidth: 4 },
        label: { color: colors.text, formatter: '{b}\n{c} ' + unit },
        emphasis: { scale: true, scaleSize: 8 },
        data: safeData
      }]
    }, true);
  }

  function drawTrend(series, dateKey) {
    const keys = ['pv_power', 'load_power', 'grid_flow_power', 'battery_power', 'battery_soc'];
    const signature = (dateKey || '') + '|' + keys.map(k => `${k}:${(series[k] || []).length}:${(series[k] || []).at(-1)?.time || ''}:${(series[k] || []).at(-1)?.value ?? ''}`).join('|');
    if (signature === lastTrendSignature) return;
    lastTrendSignature = signature;

    const todayKey = todayLocalDate();
    const isToday = !dateKey || dateKey === todayKey;
    setText('trend-subtitle', isToday ? 'Today / 24-hour time-series from InfluxDB' : `History for ${dateKey} · 00:00 → 24:00 from InfluxDB`);

    const bounds = dateKey ? historyDayBounds(dateKey) : { start: null, end: null, endMs: null };
    const xAxisBoundsOpts = bounds.start && bounds.end ? {
      min: bounds.start,
      max: bounds.end,
      interval: 2 * 3600 * 1000,
      axisLabel: {
        color: colors.muted,
        showMaxLabel: true,
        formatter(value) {
          if (bounds.endMs && Math.abs(Number(value) - bounds.endMs) < 60000) return '24:00';
          try {
            return new Date(value).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' });
          } catch (_) {
            return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          }
        }
      }
    } : {};

    charts.trend.setOption({
      backgroundColor: 'transparent',
      color: keys.map(k => colors[k]),
      tooltip: { trigger: 'axis', backgroundColor: colors.panel, borderColor: colors.border, textStyle: { color: colors.text } },
      legend: { top: 0, textStyle: { color: colors.muted }, data: keys.map(k => labels[k]) },
      grid: { left: 50, right: 48, top: 46, bottom: 36 },
      xAxis: { type: 'time', ...axisStyle(), ...xAxisBoundsOpts },
      yAxis: [
        { type: 'value', name: 'kW', ...axisStyle() },
        { type: 'value', name: '%', min: 0, max: 100, axisLabel: { color: colors.muted }, splitLine: { show: false } }
      ],
      dataZoom: [{ type: 'inside' }],
      series: keys.map(k => ({
        name: labels[k],
        type: 'line',
        yAxisIndex: k === 'battery_soc' ? 1 : 0,
        smooth: true,
        symbol: 'none',
        lineStyle: { width: k === 'battery_soc' ? 2 : 3, type: k === 'battery_soc' ? 'dashed' : 'solid' },
        areaStyle: k === 'load_power' ? { opacity: 0.10 } : undefined,
        data: (series[k] || []).map(p => [p.time, p.value])
      }))
    }, true);
  }

  function updateBatteryDetails(latest) {
    const energy = latest.energy || {};
    const batteryMeta = latest.battery || {};
    const soc = Math.max(0, Math.min(100, n(energy.battery_soc) || 0));
    const capacity = n(batteryMeta.total_capacity_kwh) || 18.08;
    const stored = capacity * soc / 100;
    const power = n(energy.battery_power) || 0;
    const mode = power > 0 ? 'Charging' : power < 0 ? 'Discharging' : 'Idle';
    const estimatedHours = power > 0
      ? (capacity - stored) / power
      : power < 0
        ? stored / Math.abs(power)
        : null;

    setText('battery-capacity', `${capacity.toFixed(2)} kWh`);
    setText('battery-detail-soc', `${soc.toFixed(0)}%`);
    setText('battery-stored', `${stored.toFixed(1)} kWh`);
    setText('battery-power-detail', `${Math.abs(power).toFixed(2)} kW`);
    setText('battery-mode-detail', mode);
    setText('battery-est-time', estimatedHours === null || !Number.isFinite(estimatedHours) ? '—' : formatDurationHours(estimatedHours));
    setText('battery-est-time-sub', power > 0 ? 'to full at current charge rate' : power < 0 ? 'to empty at current discharge rate' : 'battery idle');

    const reserveStatus = batteryMeta.reserve_status;
    const reserveMessage = batteryMeta.reserve_message;
    const reserveSocPct = batteryMeta.reserve_soc_pct !== undefined ? batteryMeta.reserve_soc_pct : 10;
    let reserveText = '—';
    let reserveSub = '';
    if (reserveStatus === 'discharging' && reserveMessage) {
      reserveText = reserveMessage;
      reserveSub = currentLang === 'th' ? `ถึง ${reserveSocPct}% สำรอง` : `to ${reserveSocPct}% reserve`;
    } else if (reserveStatus === 'reserve_reached') {
      reserveText = currentLang === 'th' ? `ถึง reserve ${reserveSocPct}% แล้ว` : `Reserve ${reserveSocPct}% reached`;
      reserveSub = '';
    } else if (reserveStatus === 'not_discharging') {
      reserveText = reserveMessage || '—';
      reserveSub = currentLang === 'th' ? 'ETA คำนวณขณะ Discharging' : 'ETA available while discharging';
    }
    setText('battery-reserve-eta', reserveText);
    setText('battery-reserve-eta-sub', reserveSub);
  }

  // Like the global n() but treats null/undefined/"" as no-data rather than 0.
  function nNullable(v) {
    if (v === null || v === undefined || v === '') return null;
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  }

  function updateDcCharger(latest, costData) {
    const e = latest.energy || {};
    const evPower = nNullable(e.ev_power);
    const evDayKwh = nNullable(e.ev_day_nrg);
    const threshold = 0.05;
    const card = document.getElementById('dc-charger-card');
    const badge = document.getElementById('dc-charger-badge');
    const kwEl = document.getElementById('dc-charger-kw');
    const stateEl = document.getElementById('dc-charger-state-text');
    const kwhEl = document.getElementById('dc-charger-kwh');

    if (evPower === null) {
      if (card) card.setAttribute('data-state', 'none');
      if (badge) { badge.textContent = 'No data'; badge.setAttribute('data-badge', 'none'); }
      if (kwEl) kwEl.textContent = '—';
      if (stateEl) stateEl.textContent = 'No charger telemetry';
      if (kwhEl) kwhEl.textContent = '';
      if (charts.devices) charts.devices.clear();
      if (costData !== undefined) {
        updateDcCostGrid(costData);
        drawDcChargingStat(costData && costData.history);
      }
      return;
    }

    const isCharging = evPower > threshold;
    const state = isCharging ? 'charging' : 'idle';
    if (card) card.setAttribute('data-state', state);
    if (badge) { badge.textContent = isCharging ? 'Charging' : 'Idle'; badge.setAttribute('data-badge', state); }
    if (kwEl) kwEl.textContent = evPower.toFixed(2);
    if (stateEl) stateEl.textContent = isCharging ? 'Active — drawing from load bus' : 'Idle — not in use';
    if (kwhEl) kwhEl.textContent = evDayKwh !== null ? 'Today ' + evDayKwh.toFixed(2) + ' kWh' : '';

    if (costData !== undefined) {
      updateDcCostGrid(costData);
      drawDcChargingStat(costData && costData.history);
    }

    if (!charts.devices) return;
    const barColor = isCharging
      ? { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(34,211,238,.82)' }, { offset: 1, color: 'rgba(34,211,238,.14)' }] }
      : 'rgba(34,211,238,.18)';
    charts.devices.setOption({
      backgroundColor: 'transparent',
      grid: { left: 8, right: 8, top: 6, bottom: 6 },
      xAxis: { show: false, type: 'category', data: ['EV'] },
      yAxis: { show: false, type: 'value', min: 0, max: Math.max(evPower * 1.5, 7.4) },
      series: [{
        type: 'bar',
        barMaxWidth: 48,
        showBackground: true,
        backgroundStyle: { color: 'rgba(34,211,238,.07)', borderRadius: [6, 6, 0, 0] },
        data: [{ value: evPower, itemStyle: { color: barColor, borderRadius: [6, 6, 0, 0] } }],
        label: { show: isCharging, position: 'top', color: '#22d3ee', fontSize: 13, fontWeight: 700, formatter: p => p.value.toFixed(1) + ' kW' }
      }]
    }, true);
  }

  function updateDcCostGrid(costData) {
    function fmtKwh(v) { return v !== null && v !== undefined ? v.toFixed(2) + ' kWh' : '—'; }
    function fmtThb(v) { return v !== null && v !== undefined ? '฿' + v.toFixed(2) : '—'; }
    const session = costData && costData.session;
    const month = costData && costData.month;
    const total = costData && costData.total;
    const sessionStatus = session && session.status;
    const sessionLabel = document.getElementById('dc-cost-session-label');
    if (sessionLabel) sessionLabel.textContent = sessionStatus === 'current' ? 'Current charge' : 'Last charge';
    setText('dc-cost-session-kwh', fmtKwh(session && session.kwh !== null ? session.kwh : null));
    setText('dc-cost-session-thb', fmtThb(session && session.cost_thb !== null ? session.cost_thb : null));
    setText('dc-cost-month-kwh', fmtKwh(month && month.kwh !== null ? month.kwh : null));
    setText('dc-cost-month-thb', fmtThb(month && month.cost_thb !== null ? month.cost_thb : null));
    setText('dc-cost-total-kwh', fmtKwh(total && total.kwh !== null ? total.kwh : null));
    setText('dc-cost-total-thb', fmtThb(total && total.cost_thb !== null ? total.cost_thb : null));
  }

  function teslaChargingText(code) {
    const x = nNullable(code);
    const labels = {
      0: 'Disconnected',
      1: 'Complete',
      2: 'Charging',
      3: 'Starting',
      4: 'Stopped',
      5: 'No power',
      '-1': 'Unknown'
    };
    return x === null ? '—' : (labels[x] || 'Unknown');
  }

  function fmtTeslaPct(v) {
    const x = nNullable(v);
    return x === null ? '—' : `${Math.round(x)}%`;
  }

  function fmtTeslaKwh(v) {
    const x = nNullable(v);
    return x === null ? '—' : `${x.toFixed(2)} kWh`;
  }

  function fmtTeslaKw(v) {
    const x = nNullable(v);
    return x === null ? '—' : `${x.toFixed(2)} kW`;
  }

  function fmtTeslaCost(v) {
    const x = nNullable(v);
    return x === null ? '—' : `฿${x.toFixed(2)}`;
  }

  function fmtTeslaRange(v) {
    const x = nNullable(v);
    return x === null ? '—' : `${x.toFixed(0)} mi`;
  }

  function fmtLastSeen(value) {
    if (!value) return 'Last seen —';
    const d = new Date(value);
    if (!Number.isFinite(d.getTime())) return 'Last seen —';
    return `Last seen ${d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
  }

  function updateTeslaCardFromContext(context) {
    if (!context) {
      updateTeslaCard(null, null);
      return;
    }
    updateTeslaCard(context.tesla_latest || context, context.dc_charger_cost || null);
  }

  function updateTeslaCard(teslaLatest, dcCostData) {
    const card = document.getElementById('tesla-card');
    const badge = document.getElementById('tesla-badge');
    const gauge = document.getElementById('tesla-battery-gauge');
    const hasTeslaData = Boolean(teslaLatest && teslaLatest.has_data !== false && (teslaLatest.charge || teslaLatest.vehicle || teslaLatest.health));
    const charge = hasTeslaData ? (teslaLatest.charge || {}) : {};
    const vehicle = hasTeslaData ? (teslaLatest.vehicle || {}) : {};
    const health = hasTeslaData ? (teslaLatest.health || {}) : {};
    const session = dcCostData && dcCostData.session;

    if (!hasTeslaData) {
      if (card) card.setAttribute('data-state', 'none');
      if (badge) { badge.textContent = 'No data'; badge.setAttribute('data-badge', 'none'); }
      if (gauge) gauge.style.setProperty('--soc', '0');
      setText('tesla-battery-level', '—');
      setText('tesla-charging-state', 'No Tesla data yet');
      setText('tesla-charger-power', '—');
      setText('tesla-charge-limit', '—');
      setText('tesla-energy-added', '—');
      setText('tesla-time-full', '—');
      setText('tesla-range', '—');
      setText('tesla-session-kwh', session ? fmtTeslaKwh(session.kwh) : '—');
      setText('tesla-session-cost', session ? fmtTeslaCost(session.cost_thb) : '—');
      setText('tesla-health', '—');
      setText('tesla-health-failures', '—');
      setText('tesla-last-seen', 'Last seen —');
      setText('tesla-vin-suffix', '');
      return;
    }

    const batteryLevel = nNullable(charge.battery_level_pct);
    const chargerPower = nNullable(charge.charger_power_kw);
    const chargingCode = nNullable(charge.charging_state_code);
    const chargingText = teslaChargingText(chargingCode);
    const isCharging = chargingCode === 2 || (chargerPower !== null && chargerPower > 0.05);
    const cardState = isCharging ? 'charging' : 'idle';
    const cycleOk = nNullable(health.cycle_ok);
    const failureCount = nNullable(health.failure_count);
    const sessionLabel = session && session.status === 'current' ? 'Current' : session && session.status === 'last' ? 'Last' : 'Session';

    if (card) card.setAttribute('data-state', cardState);
    if (badge) {
      badge.textContent = isCharging ? 'Charging' : chargingText;
      badge.setAttribute('data-badge', isCharging ? 'charging' : 'idle');
    }
    if (gauge) gauge.style.setProperty('--soc', String(Math.max(0, Math.min(100, batteryLevel || 0))));

    setText('tesla-battery-level', batteryLevel === null ? '—' : `${Math.round(batteryLevel)}%`);
    setText('tesla-charging-state', chargingText);
    setText('tesla-charger-power', fmtTeslaKw(charge.charger_power_kw));
    setText('tesla-charge-limit', fmtTeslaPct(charge.charge_limit_soc_pct));
    setText('tesla-energy-added', fmtTeslaKwh(charge.charge_energy_added_kwh));
    setText('tesla-time-full', formatDurationHours(charge.time_to_full_hours));
    setText('tesla-range', fmtTeslaRange(charge.estimated_range_mi));
    setText('tesla-session-kwh', session ? `${sessionLabel} ${fmtTeslaKwh(session.kwh)}` : '—');
    setText('tesla-session-cost', session ? fmtTeslaCost(session.cost_thb) : '—');
    setText('tesla-health', cycleOk === null ? '—' : (cycleOk === 1 ? 'cycle ok' : 'cycle failed'));
    setText('tesla-health-failures', failureCount === null ? 'failures —' : `failures ${failureCount}`);
    setText('tesla-last-seen', fmtLastSeen(teslaLatest.latest_time));
    setText('tesla-vin-suffix', vehicle.vin_suffix ? `VIN suffix ${vehicle.vin_suffix}` : '');
  }

  function drawDcChargingStat(history) {
    if (!charts.dcChargingStat) return;
    if (!Array.isArray(history) || !history.length) {
      charts.dcChargingStat.clear();
      return;
    }
    const today = todayLocalDate();
    const dates = history.map(function(r) { return r.date; });
    const kwhs = history.map(function(r) { return r.kwh || 0; });
    const thbs = history.map(function(r) { return r.cost_thb || 0; });

    function barColor(dateKey) {
      if (dateKey === today) {
        return {
          type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [{ offset: 0, color: '#22d3ee' }, { offset: 1, color: 'rgba(34,211,238,0.22)' }]
        };
      }
      return {
        type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
        colorStops: [{ offset: 0, color: 'rgba(34,211,238,0.52)' }, { offset: 1, color: 'rgba(34,211,238,0.10)' }]
      };
    }

    charts.dcChargingStat.setOption({
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        appendToBody: true,
        backgroundColor: colors.panel,
        borderColor: colors.border,
        textStyle: { color: colors.text, fontSize: 12 },
        extraCssText: 'z-index:9999;border-radius:8px;padding:8px 12px;',
        formatter: function(params) {
          var i = params[0] ? params[0].dataIndex : 0;
          var r = history[i] || {};
          var label = r.date || dates[i] || '';
          var kwhVal = (r.kwh || 0).toFixed(3);
          var thbVal = (r.cost_thb || 0).toFixed(2);
          var period = r.period === 'today_so_far' ? ' (so far)' : '';
          return label + period + '<br>' + kwhVal + ' kWh · ฿' + thbVal;
        }
      },
      grid: { left: 32, right: 8, top: 14, bottom: 22 },
      xAxis: {
        type: 'category',
        data: dates.map(function(d) { return d ? d.slice(5) : ''; }),
        axisLabel: { color: colors.muted, fontSize: 9, interval: 0 },
        axisLine: { lineStyle: { color: colors.border } },
        splitLine: { show: false }
      },
      yAxis: {
        type: 'value',
        name: 'kWh',
        nameTextStyle: { color: colors.muted, fontSize: 9, padding: [0, 0, 0, -8] },
        axisLabel: { color: colors.muted, fontSize: 9 },
        splitLine: { lineStyle: { color: colors.border, type: 'dashed', opacity: 0.5 } },
        minInterval: 1
      },
      series: [{
        type: 'bar',
        barMaxWidth: 22,
        data: kwhs.map(function(v, i) {
          return { value: v, itemStyle: { color: barColor(dates[i]), borderRadius: [3, 3, 0, 0] } };
        }),
        label: {
          show: false
        }
      }]
    }, true);
  }

  function drawWeatherForecast(report) {
    if (!charts.weatherForecast) return;
    const forecast = report && report.forecast ? report.forecast : {};
    const hours = Array.isArray(forecast.next_hours) ? forecast.next_hours : [];

    const solar = report && report.solar_stats ? report.solar_stats : {};
    const today = (Array.isArray(solar.daily) && solar.daily[0]) ? solar.daily[0] : (solar.today || {});
    const sunriseTs = today.sunrise_time ? new Date(today.sunrise_time).getTime() : null;
    const sunsetTs  = today.sunset_time  ? new Date(today.sunset_time).getTime()  : null;

    function isDaytime(isoTime) {
      if (!sunriseTs || !sunsetTs) return true;
      const t = new Date(isoTime).getTime();
      return t >= sunriseTs && t < sunsetTs;
    }

    function weatherIconName(h) {
      const code = h.weather_code;
      const rain  = n(h.precipitation_probability) || 0;
      const cloud = n(h.cloud_cover) || 0;
      const dn = (h.is_day !== undefined && h.is_day !== null) ? (h.is_day ? 'd' : 'n') : (isDaytime(h.time) ? 'd' : 'n');
      if (code === 0)                  return '01' + dn;
      if (code != null && code <= 2)   return '02' + dn;
      if (code != null && code <= 3)   return '04' + dn;
      if (code != null && code <= 48)  return '50' + dn;
      if (code != null && code <= 67)  return '10' + dn;
      if (code != null && code <= 77)  return '13' + dn;
      if (code != null && code <= 82)  return '09' + dn;
      if (code != null)                return '11' + dn;
      if (rain > 50)                   return '10' + dn;
      if (cloud > 70)                  return '04' + dn;
      if (cloud > 30)                  return '02' + dn;
      return '01' + dn;
    }

    // Update hero section with 6-hour averages
    if (hours.length) {
      const heroIcon = document.getElementById('weather-hero-icon');
      if (heroIcon) heroIcon.src = '/weather-icons/animated/' + weatherIconName(hours[0]) + '.svg';

      const validN = arr => arr.filter(v => v !== null);
      const avg = arr => { const v = validN(arr); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

      const avgTemp  = avg(hours.map(h => n(h.temperature_2m)));
      const avgRain  = avg(hours.map(h => n(h.precipitation_probability)));
      const avgCloud = avg(hours.map(h => n(h.cloud_cover)));
      const avgSolar = avg(hours.map(h => n(h.shortwave_radiation)));

      setText('weather-hero-temp', avgTemp !== null ? avgTemp.toFixed(1) + '°C' : '—°C');
      setText('weather-hero-rain', '💧 ' + (avgRain  !== null ? Math.round(avgRain)  + '%'    : '—'));
      setText('weather-hero-cloud','☁ '  + (avgCloud !== null ? Math.round(avgCloud) + '%'    : '—'));
      setText('weather-hero-solar','☀ GHI '  + (avgSolar !== null ? Math.round(avgSolar) + ' W/m²': '—'));

      const avgDirect = avg(hours.map(h => n(h.direct_radiation)));
      const avgDiff   = avg(hours.map(h => n(h.diffuse_radiation)));
      const avgDni    = avg(hours.map(h => n(h.direct_normal_irradiance)));
      setText('weather-hero-ghi-val', avgSolar !== null ? Math.round(avgSolar) + ' W/m²' : '— W/m²');
      const ghiParts = [];
      if (avgDirect !== null) ghiParts.push('Direct ' + Math.round(avgDirect));
      if (avgDiff   !== null) ghiParts.push('Diffuse ' + Math.round(avgDiff));
      if (avgDni    !== null) ghiParts.push('DNI ' + Math.round(avgDni));
      setText('weather-hero-ghi-detail', ghiParts.length ? ghiParts.join(' · ') + ' W/m²' : '');
    }

    if (!hours.length) { charts.weatherForecast.clear(); return; }

    const iconNames   = hours.map(weatherIconName);
    const xLabels     = hours.map(h => new Date(h.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    const temps       = hours.map(h => n(h.temperature_2m));
    const validTemps  = temps.filter(v => v !== null);
    const minT = validTemps.length ? Math.min(...validTemps) : 20;
    const maxT = validTemps.length ? Math.max(...validTemps) : 35;
    const pad  = Math.max(3, (maxT - minT) * 0.5);

    const solars      = hours.map(h => n(h.shortwave_radiation));
    const validSolars = solars.filter(v => v !== null);
    const maxSolar    = validSolars.length ? Math.max(...validSolars) : 200;

    const ICON_SIZE   = 38;
    const ICON_OFFSET_Y = 4;
    const RECT_PAD    = 4;

    charts.weatherForecast.setOption({
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        appendToBody: true,
        confine: false,
        backgroundColor: colors.panel,
        borderColor: colors.border,
        borderWidth: 1,
        textStyle: { color: colors.text, fontSize: 12 },
        extraCssText: 'z-index:9999;max-width:220px;line-height:1.7;padding:10px 13px;box-shadow:0 4px 20px rgba(0,0,0,.55);border-radius:10px;pointer-events:none;',
        formatter(params) {
          const i = params[0] ? params[0].dataIndex : null;
          if (i == null || !hours[i]) return '';
          const h = hours[i];
          const imgTag = `<img src="/weather-icons/animated/${iconNames[i]}.svg" width="22" height="22" style="vertical-align:middle;margin-right:5px;">`;
          const direct = n(h.direct_radiation);
          const diffuse = n(h.diffuse_radiation);
          const dni = n(h.direct_normal_irradiance);
          const src = h.source || null;
          const row = (icon, label, val) => `<div style="display:flex;justify-content:space-between;gap:12px;"><span style="color:#91a4bd;">${icon} ${label}</span><span style="font-weight:500;">${val}</span></div>`;
          let tip = `<div style="margin-bottom:6px;">${imgTag}<strong style="font-size:13px;">${xLabels[i]}</strong></div>`;
          tip += row('\u{1F321}', 'Temp', fmt(h.temperature_2m, '°C'));
          tip += row('\u{1F327}', 'Rain', fmt(h.precipitation_probability, '%', 0));
          tip += row('☁', 'Cloud', fmt(h.cloud_cover, '%', 0));
          tip += row('☀', 'GHI', fmt(h.shortwave_radiation, ' W/m²', 0));
          if (direct !== null) tip += row('↕', 'Direct', fmt(direct, ' W/m²', 0));
          if (diffuse !== null) tip += row('≈', 'Diffuse', fmt(diffuse, ' W/m²', 0));
          if (dni !== null) tip += row('⊙', 'DNI', fmt(dni, ' W/m²', 0));
          tip += row('💨', 'Wind', fmt(h.wind_speed_10m, ' km/h', 0));
          if (src) tip += `<div style="margin-top:5px;color:#91a4bd;font-size:10px;">${src}</div>`;
          return tip;
        }
      },
      grid: { left: 44, right: 58, top: 62, bottom: 28 },
      xAxis: {
        type: 'category',
        data: xLabels,
        axisLabel: { color: colors.muted, fontSize: 11 },
        axisLine: { lineStyle: { color: colors.border } },
        splitLine: { show: false }
      },
      yAxis: [
        {
          type: 'value',
          name: '°C',
          min: Math.floor(minT - pad),
          max: Math.ceil(maxT + pad),
          axisLabel: { color: colors.muted, formatter: '{value}°', fontSize: 11 },
          axisLine: { lineStyle: { color: colors.border } },
          splitLine: { lineStyle: { color: 'rgba(39,51,71,.55)', type: 'dashed' } }
        },
        {
          type: 'value',
          name: 'W/m²',
          min: 0,
          max: Math.max(200, Math.ceil(maxSolar * 1.3 / 100) * 100),
          position: 'right',
          axisLabel: { color: '#fbbf24', fontSize: 10, formatter: '{value}' },
          axisLine: { show: true, lineStyle: { color: '#fbbf24', opacity: 0.40 } },
          splitLine: { show: false },
          nameTextStyle: { color: '#fbbf24', fontSize: 10 }
        }
      ],
      series: [
        {
          name: 'Solar GHI',
          type: 'bar',
          yAxisIndex: 1,
          data: solars,
          barMaxWidth: 32,
          itemStyle: {
            color: {
              type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(251,191,36,0.52)' },
                { offset: 1, color: 'rgba(251,191,36,0.06)' }
              ]
            },
            borderRadius: [4, 4, 0, 0]
          },
          z: 1
        },
        {
          name: 'Temp',
          type: 'line',
          yAxisIndex: 0,
          data: temps,
          smooth: 0.4,
          symbol: 'circle',
          symbolSize: 6,
          lineStyle: { color: '#f97316', width: 2.5 },
          itemStyle: { color: '#f97316', borderColor: '#fff', borderWidth: 1.5 },
          areaStyle: {
            color: {
              type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(249,115,22,0.30)' },
                { offset: 1, color: 'rgba(249,115,22,0.02)' }
              ]
            }
          },
          z: 2
        },
        {
          name: 'Icons',
          type: 'custom',
          yAxisIndex: 0,
          z: 3,
          renderItem(params, api) {
            const idx  = params.dataIndex;
            const iconName = iconNames[idx] || '01d';
            const pt   = api.coord([idx, api.value(1)]);
            const cx   = pt[0];
            const cy   = params.coordSys.y + ICON_OFFSET_Y;
            const half = ICON_SIZE / 2;
            return {
              type: 'group',
              children: [
                {
                  type: 'rect',
                  shape: { x: cx - half - RECT_PAD, y: cy - RECT_PAD, width: ICON_SIZE + RECT_PAD * 2, height: ICON_SIZE + RECT_PAD * 2, r: 8 },
                  style: {
                    fill: 'rgba(237,244,255,0.92)',
                    stroke: 'rgba(255,255,255,0.40)',
                    lineWidth: 1,
                    shadowBlur: 10,
                    shadowColor: 'rgba(0,0,0,0.22)',
                    shadowOffsetY: 2
                  }
                },
                {
                  type: 'image',
                  style: { image: '/weather-icons/animated/' + iconName + '.svg', x: cx - half, y: cy, width: ICON_SIZE, height: ICON_SIZE }
                }
              ]
            };
          },
          data: hours.map((_, i) => [i, temps[i]])
        }
      ]
    }, true);
  }

  function drawSunArc(report) {
    if (!charts.sunArc) return;
    const solar = report && report.solar_stats ? report.solar_stats : {};
    const today = solar.today || {};

    const sunriseTs = today.sunrise_time ? new Date(today.sunrise_time).getTime() : null;
    const sunsetTs  = today.sunset_time  ? new Date(today.sunset_time).getTime()  : null;
    const nowTs = Date.now();

    const sunriseLabel = today.sunrise_local ||
      (sunriseTs ? new Date(sunriseTs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—');
    const sunsetLabel  = today.sunset_local  ||
      (sunsetTs  ? new Date(sunsetTs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })  : '—');

    let progress   = 0;
    let statusText = 'Night';
    let isDaytime  = false;

    if (sunriseTs && sunsetTs) {
      if (nowTs < sunriseTs) {
        progress   = 0;
        statusText = 'Before sunrise';
      } else if (nowTs > sunsetTs) {
        progress   = 100;
        statusText = 'After sunset';
      } else {
        progress   = ((nowTs - sunriseTs) / (sunsetTs - sunriseTs)) * 100;
        isDaytime  = true;
        statusText = new Date(nowTs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
    }

    const daylightMs  = sunriseTs && sunsetTs ? sunsetTs - sunriseTs : null;
    const daylightStr = daylightMs ? formatDurationHours(daylightMs / 3600000) : '—';

    const pvStartLabel = today.pv_start_local || timeOrDash(today.pv_start_time);
    const pvStopLabel  = today.producing_now ? 'Active' : (today.pv_stop_local || timeOrDash(today.pv_stop_time));

    const arcFill = isDaytime
      ? { type: 'linear', x: 0, y: 0, x2: 1, y2: 0, colorStops: [
          { offset: 0,   color: '#f97316' },
          { offset: 0.5, color: '#fbbf24' },
          { offset: 1,   color: '#f7c948' }
        ] }
      : 'rgba(39,51,71,0.45)';

    charts.sunArc.setOption({
      backgroundColor: 'transparent',
      series: [
        {
          type: 'gauge',
          center: ['50%', '80%'],
          radius: '90%',
          startAngle: 180,
          endAngle: 0,
          min: 0, max: 100,
          z: 1,
          pointer: { show: false },
          progress: { show: false },
          axisLine: { lineStyle: { width: 16, color: [[1, 'rgba(39,51,71,0.55)']] } },
          axisTick: { show: false },
          splitLine: { show: false },
          axisLabel: { show: false },
          detail: { show: false }
        },
        {
          type: 'gauge',
          center: ['50%', '80%'],
          radius: '90%',
          startAngle: 180,
          endAngle: 0,
          min: 0, max: 100,
          z: 2,
          pointer: { show: false },
          progress: { show: true, width: 16, itemStyle: { color: arcFill } },
          data: [{ value: progress }],
          axisLine: { show: false },
          axisTick: { show: false },
          splitLine: { show: false },
          axisLabel: { show: false },
          detail: {
            show: true,
            offsetCenter: [0, '-26%'],
            formatter: (isDaytime ? '☀ ' : '\u{1F319} ') + statusText,
            color: isDaytime ? '#fbbf24' : '#91a4bd',
            fontSize: 14,
            fontWeight: 700
          }
        }
      ],
      graphic: (() => {
        const cw = charts.sunArc.getWidth();
        const ch = charts.sunArc.getHeight();
        const cx = cw * 0.5;
        const cy = ch * 0.80;
        const arcR = Math.min(cw, ch) * 0.90 / 2;
        const markerAngle = (180 - progress * 1.8) * Math.PI / 180;
        const mx = cx + arcR * Math.cos(markerAngle);
        const my = cy - arcR * Math.sin(markerAngle);

        const elems = [
          // dashed horizon line
          {
            type: 'line',
            shape: { x1: cx - arcR - 10, y1: cy, x2: cx + arcR + 10, y2: cy },
            style: { stroke: 'rgba(145,164,189,0.22)', lineWidth: 1, lineDash: [4, 4] }
          },
          // sunrise label (left of horizon)
          {
            type: 'text',
            style: {
              text: '↑ ' + sunriseLabel,
              x: cx - arcR,
              y: cy + 7,
              fill: '#f97316',
              fontSize: 11,
              fontWeight: 600,
              textAlign: 'left'
            }
          },
          // sunset label (right of horizon)
          {
            type: 'text',
            style: {
              text: sunsetLabel + ' ↓',
              x: cx + arcR,
              y: cy + 7,
              fill: '#f97316',
              fontSize: 11,
              fontWeight: 600,
              textAlign: 'right'
            }
          },
          // daylight duration — top center, above the arc
          {
            type: 'text',
            style: {
              text: daylightStr + ' daylight',
              x: cx,
              y: 12,
              fill: isDaytime ? 'rgba(251,191,36,0.80)' : 'rgba(145,164,189,0.65)',
              fontSize: 12,
              fontWeight: 600,
              textAlign: 'center'
            }
          },
          // sun/moon position marker
          {
            type: 'circle',
            shape: { cx: mx, cy: my, r: isDaytime ? 9 : 7 },
            style: {
              fill:   isDaytime ? '#fbbf24' : '#334155',
              stroke: isDaytime ? 'rgba(255,255,255,0.90)' : '#64748b',
              lineWidth: 2.5,
              shadowColor: isDaytime ? '#f97316' : 'transparent',
              shadowBlur:  isDaytime ? 16 : 0
            },
            z: 10
          }
        ];

        // PV production window (if available)
        if (pvStartLabel !== '—') {
          elems.push({
            type: 'text',
            style: {
              text: 'PV  ' + pvStartLabel + ' → ' + pvStopLabel,
              x: cx,
              y: ch - 8,
              fill: 'rgba(145,164,189,0.65)',
              fontSize: 10,
              textAlign: 'center'
            }
          });
        }

        return elems;
      })()
    }, true);
  }

  function drawWeatherVsActual(payload) {
    if (!charts.weatherActual) return;
    const rows = Array.isArray(payload && payload.rows) ? payload.rows : [];

    if (!rows.length) {
      charts.weatherActual.clear();
      charts.weatherActual.setOption({
        title: {
          text: 'Weather VS Actual PV Power',
          subtext: 'No data available',
          left: 'center',
          top: 'center',
          textStyle: { color: colors.muted, fontSize: 15 },
          subtextStyle: { color: colors.muted }
        }
      });
      return;
    }

    function nullableNumber(value) {
      if (value === null || value === undefined || value === '') return null;
      const x = Number(value);
      return Number.isFinite(x) ? x : null;
    }

    const pvColors = { pv1: '#35d07f', pv2: '#22d3ee', pv3: '#f59e0b', pv4: '#60a5fa' };
    const pvIds = ['pv1', 'pv2', 'pv3', 'pv4'];

    const cloudData  = rows.map(r => [r.time, nullableNumber(r.cloud_cover)]);
    const ghiData    = rows.map(r => [r.time, nullableNumber(r.shortwave_radiation)]);

    const pvStringData = {};
    pvIds.forEach(id => {
      pvStringData[id] = rows.map(r => { const v = nullableNumber(r[id + '_power']); return v !== null ? Math.max(0, v) : null; });
    });
    const pvStringTotalData = rows.map((r, i) => {
      const raw = nullableNumber(r.pv_string_total_power);
      if (raw !== null && raw >= 0) return raw;
      const vals = pvIds.map(id => pvStringData[id][i]).filter(v => v !== null);
      return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
    });
    const pvFallbackData = rows.map(r => { const v = nullableNumber(r.pv_power); return v !== null ? Math.max(0, v) : null; });

    const hasStringData = pvIds.some(id => pvStringData[id].some(v => v !== null));

    const tz = payload.timezone || 'Asia/Bangkok';
    const sunriseIso = typeof payload.sunrise === 'string' ? payload.sunrise : null;
    const sunsetIso  = typeof payload.sunset  === 'string' ? payload.sunset  : null;

    // Resolve sunrise/sunset: cache by date+tz so values survive polls that omit them.
    let effectiveSunrise = sunriseIso;
    let effectiveSunset  = sunsetIso;
    let localDate = typeof payload.local_date === 'string' ? payload.local_date : null;
    if (rows.length && !localDate) {
      try { localDate = new Date(rows[0].time).toLocaleDateString('en-CA', { timeZone: tz }); }
      catch (_) { localDate = new Date(rows[0].time).toLocaleDateString('en-CA'); }
    }
    if (localDate) {
      if (weatherActualSolarMarkerCache &&
          weatherActualSolarMarkerCache.date === localDate &&
          weatherActualSolarMarkerCache.tz === tz) {
        if (!weatherActualSolarMarkerCache.sunrise && sunriseIso) weatherActualSolarMarkerCache.sunrise = sunriseIso;
        if (!weatherActualSolarMarkerCache.sunset  && sunsetIso)  weatherActualSolarMarkerCache.sunset  = sunsetIso;
        effectiveSunrise = weatherActualSolarMarkerCache.sunrise;
        effectiveSunset  = weatherActualSolarMarkerCache.sunset;
      } else {
        weatherActualSolarMarkerCache = { date: localDate, tz, sunrise: sunriseIso, sunset: sunsetIso };
      }
    }

    function localDayBounds(dateKey, timezoneName) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey || '')) return { start: null, end: null, endMs: null };
      const offsets = { 'Asia/Bangkok': '+07:00' };
      const offset = offsets[timezoneName] || '+00:00';
      const parts = dateKey.split('-').map(Number);
      const nextKey = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]) + 86400000).toISOString().slice(0, 10);
      const start = new Date(dateKey + 'T00:00:00' + offset).toISOString();
      const end = new Date(nextKey + 'T00:00:00' + offset).toISOString();
      return { start, end, endMs: new Date(end).getTime() };
    }
    const dayBounds = localDayBounds(localDate, tz);

    // Only rebuild markers (and trigger a full notMerge reset) when the signature changes.
    // On plain data refreshes the signature is stable, so we use ECharts merge mode and
    // omit markArea/markLine from the series — merge preserves the existing overlay.
    const newMarkerSig = (localDate || '') + '|' + tz + '|' + (effectiveSunrise || '') + '|' + (effectiveSunset || '');
    const markersDirty = newMarkerSig !== weatherActualMarkerSig;

    function fmtTz(isoStr) {
      if (!isoStr) return '';
      try { return new Date(isoStr).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz }); }
      catch (_) { return new Date(isoStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
    }

    const xLabels    = rows.map(r => fmtTz(r.time));
    const sunriseTime  = fmtTz(effectiveSunrise);
    const sunsetTime   = fmtTz(effectiveSunset);

    // Sun path curve overlay — dashed arc mapped onto the cloud-cover % axis (0–100)
    const _srMs  = effectiveSunrise ? new Date(effectiveSunrise).getTime() : null;
    const _ssMs  = effectiveSunset  ? new Date(effectiveSunset).getTime()  : null;
    const _nowMs = Date.now();

    const sunArcData = (_srMs && _ssMs && _ssMs > _srMs) ? (function() {
      var pts = [];
      for (var _i = 0; _i <= 60; _i++) {
        var _t = _i / 60;
        pts.push([_srMs + _t * (_ssMs - _srMs), Math.sin(Math.PI * _t) * 83 + 5]);
      }
      return pts;
    }()) : [];

    const sunDotData = (_srMs && _ssMs && _ssMs > _srMs && _nowMs > _srMs && _nowMs < _ssMs)
      ? (function() {
          var _t = (_nowMs - _srMs) / (_ssMs - _srMs);
          return [[_nowMs, Math.sin(Math.PI * _t) * 83 + 5]];
        }())
      : [];

    const validGhi     = ghiData.map(d => d[1]).filter(v => v !== null);
    const maxGhi       = validGhi.length ? Math.max(...validGhi) : 200;
    const validTotals  = (hasStringData ? pvStringTotalData : pvFallbackData).filter(v => v !== null);
    const maxPv        = validTotals.length ? Math.max(...validTotals) : 5;

    const pvSeries = hasStringData
      ? pvIds.map(id => ({
          name: id.toUpperCase(),
          type: 'bar',
          stack: 'pv_actual',
          yAxisIndex: 2,
          data: rows.map((r, i) => [r.time, pvStringData[id][i]]),
          barMaxWidth: 32,
          itemStyle: {
            color: pvColors[id],
            borderRadius: id === 'pv4' ? [4, 4, 0, 0] : [0, 0, 0, 0]
          },
          z: 2
        }))
      : [{
          name: 'PV (kW)',
          type: 'bar',
          stack: 'pv_actual',
          yAxisIndex: 2,
          data: rows.map((r, i) => [r.time, pvFallbackData[i]]),
          barMaxWidth: 32,
          itemStyle: { color: colors.pv_power, borderRadius: [4, 4, 0, 0] },
          z: 2
        }];

    charts.weatherActual.setOption({
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        appendToBody: true,
        confine: false,
        backgroundColor: colors.panel,
        borderColor: colors.border,
        borderWidth: 1,
        textStyle: { color: colors.text, fontSize: 12 },
        extraCssText: 'z-index:9999;max-width:290px;padding:10px 13px;border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,.55);',
        formatter(params) {
          const _ccParam = params.find(function(p) { return p.seriesName === 'Cloud Cover (%)'; });
          const i = _ccParam ? _ccParam.dataIndex : (params[0] ? params[0].dataIndex : null);
          if (i == null) return '';
          const r = rows[i] || {};
          const row = (dot, label, val) =>
            `<div style="display:flex;justify-content:space-between;gap:14px;">${dot}<span style="color:#91a4bd;">${label}</span><span style="font-weight:600;">${val}</span></div>`;
          const dot = (color) => `<span style="display:inline-block;width:10px;height:10px;background:${color};border-radius:50%;margin-right:4px;flex-shrink:0;"></span>`;
          const noActual = '<span style="color:#91a4bd;font-style:italic;">No data</span>';
          let tip = `<div style="margin-bottom:5px;font-weight:700;">${xLabels[i]}</div>`;
          const ghi = nullableNumber(r.shortwave_radiation);
          tip += row(dot('#fbbf24'), 'GHI (W/m²)', ghi !== null ? ghi.toFixed(0) : '—');
          const cloud = nullableNumber(r.cloud_cover);
          tip += row(dot('#60a5fa'), 'Cloud (%)', cloud !== null ? cloud.toFixed(0) : '—');
          if (hasStringData) {
            const clampedPvVals = {};
            pvIds.forEach(id => {
              const v = nullableNumber(r[id + '_power']);
              clampedPvVals[id] = v !== null ? Math.max(0, v) : null;
              tip += row(dot(pvColors[id]), id.toUpperCase() + ' (kW)', clampedPvVals[id] !== null ? clampedPvVals[id].toFixed(2) : noActual);
            });
            const rawTotal = nullableNumber(r.pv_string_total_power);
            let displayedTotal;
            if (rawTotal !== null && rawTotal >= 0) {
              displayedTotal = rawTotal;
            } else {
              const tVals = pvIds.map(id => clampedPvVals[id]).filter(v => v !== null);
              displayedTotal = tVals.length ? tVals.reduce((a, b) => a + b, 0) : null;
            }
            tip += row(dot('#ffffff'), 'Total PV (kW)', displayedTotal !== null ? `<b>${displayedTotal.toFixed(2)}</b>` : noActual);
          } else {
            const pv = nullableNumber(r.pv_power);
            tip += row(dot(colors.pv_power), 'PV (kW)', pv !== null ? Math.max(0, pv).toFixed(2) : noActual);
          }
          return tip;
        }
      },
      legend: {
        bottom: 4, left: 'center', orient: 'horizontal', textStyle: { color: colors.muted }, itemGap: 14,
        data: ['Cloud Cover (%)', 'GHI (W/m²)'].concat(hasStringData ? pvIds.map(function(id) { return id.toUpperCase(); }) : ['PV (kW)'])
      },
      grid: { left: 54, right: 38, top: 42, bottom: 60 },
      xAxis: {
        type: 'time',
        boundaryGap: false,
        ...(dayBounds.start && dayBounds.end ? {
          min: dayBounds.start,
          max: dayBounds.end,
          interval: 2 * 3600 * 1000
        } : {}),
        axisLabel: {
          color: colors.muted,
          fontSize: 11,
          showMaxLabel: true,
          hideOverlap: false,
          formatter: function(value) {
            if (dayBounds.endMs && Math.abs(Number(value) - dayBounds.endMs) < 60000) return '24:00';
            try {
              return new Date(value).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz });
            } catch(_) {
              return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            }
          }
        },
        axisLine: { lineStyle: { color: colors.border } },
        splitLine: { show: false }
      },
      yAxis: [
        {
          type: 'value',
          name: '%',
          min: 0,
          max: 100,
          position: 'left',
          axisLabel: { color: colors.muted, formatter: '{value}%', fontSize: 11 },
          axisLine: { lineStyle: { color: colors.border } },
          splitLine: { lineStyle: { color: colors.border, type: 'dashed' } },
          nameTextStyle: { color: colors.muted, fontSize: 11 }
        },
        {
          type: 'value',
          name: 'W/m²',
          min: 0,
          max: Math.max(200, Math.ceil(maxGhi * 1.25 / 100) * 100),
          position: 'right',
          axisLabel: { color: '#fbbf24', fontSize: 10 },
          axisLine: { show: true, lineStyle: { color: '#fbbf24', opacity: 0.4 } },
          splitLine: { show: false },
          nameTextStyle: { color: '#fbbf24', fontSize: 10 }
        },
        {
          type: 'value',
          name: 'kW',
          min: 0,
          max: Math.max(1, Math.ceil(maxPv * 1.3)),
          position: 'right',
          offset: 64,
          axisLabel: { color: colors.pv_power, fontSize: 10 },
          axisLine: { show: true, lineStyle: { color: colors.pv_power, opacity: 0.4 } },
          splitLine: { show: false },
          nameTextStyle: { color: colors.pv_power, fontSize: 10 }
        }
      ],
      series: [
        {
          name: 'Cloud Cover (%)',
          type: 'line',
          yAxisIndex: 0,
          data: cloudData,
          smooth: 0.4,
          symbol: 'none',
          lineStyle: { color: '#60a5fa', width: 2 },
          areaStyle: {
            color: {
              type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(96,165,250,0.38)' },
                { offset: 1, color: 'rgba(96,165,250,0.04)' }
              ]
            }
          },
          // Markers only when signature changed; merge mode preserves them otherwise.
          ...(markersDirty && effectiveSunrise && effectiveSunset ? {
            markArea: {
              silent: true,
              animation: false,
              data: [[{ xAxis: effectiveSunrise }, { xAxis: effectiveSunset }]],
              itemStyle: { color: 'rgba(251,191,36,0.07)' }
            }
          } : {}),
          ...(markersDirty && (effectiveSunrise || effectiveSunset) ? {
            markLine: {
              silent: true,
              animation: false,
              symbol: 'none',
              data: [
                ...(effectiveSunrise ? [{
                  name: 'Sunrise',
                  xAxis: effectiveSunrise,
                  label: {
                    show: true,
                    position: 'insideEndTop',
                    formatter: '☀️ Sunrise\n' + sunriseTime,
                    color: '#fbbf24',
                    fontSize: 10,
                    lineHeight: 16
                  },
                  lineStyle: { color: '#fbbf24', type: 'dashed', width: 1.5, opacity: 0.7 }
                }] : []),
                ...(effectiveSunset ? [{
                  name: 'Sunset',
                  xAxis: effectiveSunset,
                  label: {
                    show: true,
                    position: 'insideEndTop',
                    formatter: '🌙 Sunset\n' + sunsetTime,
                    color: '#93c5fd',
                    fontSize: 10,
                    lineHeight: 16
                  },
                  lineStyle: { color: '#93c5fd', type: 'dashed', width: 1.5, opacity: 0.7 }
                }] : [])
              ]
            }
          } : {})
        },
        {
          name: 'GHI (W/m²)',
          type: 'line',
          yAxisIndex: 1,
          data: ghiData,
          smooth: 0.3,
          symbol: 'circle',
          showSymbol: true,
          symbolSize: 5,
          lineStyle: { color: '#fbbf24', width: 2.5 },
          itemStyle: { color: '#fbbf24', borderColor: '#fff', borderWidth: 1.5 },
          z: 1
        },
        ...pvSeries,
        {
          id: 'sun_arc',
          name: 'sun_arc',
          type: 'line',
          yAxisIndex: 0,
          data: sunArcData,
          symbol: 'none',
          smooth: false,
          lineStyle: { color: 'rgba(251,191,36,0.22)', width: 1.5, type: 'dashed' },
          tooltip: { show: false },
          silent: true,
          animation: false,
          z: 0,
          legendHoverLink: false
        },
        {
          id: 'sun_dot',
          name: 'sun_dot',
          type: 'scatter',
          yAxisIndex: 0,
          data: sunDotData,
          symbolSize: 7,
          itemStyle: { color: 'rgba(253,230,138,0.80)', borderColor: 'rgba(251,191,36,0.40)', borderWidth: 2 },
          tooltip: { show: false },
          silent: true,
          animation: false,
          z: 1,
          legendHoverLink: false
        }
      ]
    }, markersDirty);

    if (markersDirty) weatherActualMarkerSig = newMarkerSig;
  }

  function windowText(win) {
    return win && win.start && win.end ? `${win.start}–${win.end}` : '—';
  }

  function drawSunPath(payload) {
    if (!payload || !charts.sunPath) return;
    const current = payload.current || {};
    const arrays = Array.isArray(payload.array_exposure) ? payload.array_exposure : [];
    const pathSamples = Array.isArray(payload.path_samples) ? payload.path_samples : [];
    const pvArrays = Array.isArray(payload.pv_arrays) ? payload.pv_arrays : [];
    const daytimeSamples = pathSamples.filter(s => n(s.altitude_deg) !== null && n(s.altitude_deg) > 0);
    const pointFor = (azDeg, altitudeDeg) => {
      const radius = Math.max(8, 88 - Math.max(0, Math.min(90, n(altitudeDeg) || 0)) * 0.72);
      const rad = ((n(azDeg) || 0) - 90) * Math.PI / 180;
      return [50 + radius * Math.cos(rad), 50 + radius * Math.sin(rad)];
    };
    const rayEnd = (azDeg, length = 45) => {
      const rad = ((n(azDeg) || 0) - 90) * Math.PI / 180;
      return [50 + length * Math.cos(rad), 50 + length * Math.sin(rad)];
    };
    const pathData = daytimeSamples.map(s => pointFor(s.azimuth_deg, s.altitude_deg));
    const nowPoint = pointFor(current.azimuth_deg, current.altitude_deg);
    const best = arrays[0];

    const rankingHtml = arrays.length ? arrays.map((a, idx) => `
      <div class="sun-rank-chip" style="--array-color:${escapeHtml(a.color || '#91a4bd')}">
        <span class="rank-no">${idx + 1}</span>
        <div><b>${escapeHtml(a.name || a.id)}</b><small>${escapeHtml(a.status || '—')} · ${fmt(a.exposure_score, '%', 0)} · diff ${fmt(a.azimuth_diff_deg, '°', 0)}</small></div>
      </div>`).join('') : '<span class="sun-empty">Sun path unavailable</span>';
    setHtml('sun-array-ranking', rankingHtml);

    const windowHtml = arrays.length ? arrays
      .slice()
      .sort((a, b) => (a.panel_azimuth_deg || 0) - (b.panel_azimuth_deg || 0))
      .map(a => `
        <div class="sun-window-row">
          <span style="--array-color:${escapeHtml(a.color || '#91a4bd')}">${escapeHtml(a.name || a.id)}</span>
          <b>${escapeHtml(windowText(a.useful_window))}</b>
          <small>front ${escapeHtml(windowText(a.front_window))} · best ${escapeHtml(a.best_sample ? `${a.best_sample.time_local} (${Math.round(a.best_sample.exposure_score)}%)` : '—')}</small>
        </div>`).join('') : '<div class="sun-window-row"><span>No data</span><b>—</b><small>API offline</small></div>';
    setHtml('sun-window-list', windowHtml);

    const month = new Date().getMonth() + 1;
    const seasonalNote = (month >= 5 && month <= 8)
      ? 'ช่วง พ.ค.–ก.ค./ส.ค. ดวงอาทิตย์ที่กรุงเทพฯ อ้อมไปทางเหนือ จึงมักทำให้ชุด NE/NW เด่นกว่าชุด South ตอนกลางวัน'
      : (month >= 11 || month <= 2)
        ? 'ช่วงปลายปีถึงต้นปี ดวงอาทิตย์อยู่ด้านใต้มากขึ้น ชุด South 157° จึงควรเป็นตัวหลัก และชุด W ช่วยช่วงบ่าย'
        : 'ช่วง equinox ดวงอาทิตย์ผ่านใกล้ทิศใต้ตอนเที่ยง ชุด South และ West มักมี geometry ดี';
    const insight = best
      ? `ตอนนี้แผงที่ geometry ดีสุดคือ ${best.name} (${Math.round(best.exposure_score)}%, ${best.status}) ดวงอาทิตย์อยู่ az ${fmt(current.azimuth_deg, '°', 0)} / alt ${fmt(current.altitude_deg, '°', 0)}. ${seasonalNote}. หมายเหตุ: dashboard นี้แสดง exposure score จากทิศแผงเท่านั้น ไม่ใช่ kW รายแผง เพราะ telemetry ปัจจุบันเป็น PV รวม.`
      : `ยังไม่มีข้อมูล Sun Path. หมายเหตุ: ระบบไม่แบ่ง PV รวมเป็นรายแผงปลอม หากยังไม่มี telemetry PV1–PV4 จริง.`;
    setText('sun-path-insight', insight);

    const raySeries = pvArrays.map(arr => ({
      name: arr.name,
      type: 'lines',
      coordinateSystem: 'cartesian2d',
      silent: false,
      data: [{ coords: [[50, 50], rayEnd(arr.azimuth, 43)], valueText: `${arr.name} · ${arr.azimuth}°` }],
      lineStyle: { color: arr.color || colors.muted, width: 3, opacity: 0.85, type: 'solid' },
      effect: { show: arrays.find(a => a.id === arr.id && a.exposure_score >= 35), period: 3, symbol: 'arrow', symbolSize: 10, color: arr.color || colors.muted },
      z: 3
    }));

    charts.sunPath.setOption({
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'item',
        backgroundColor: colors.panel,
        borderColor: colors.border,
        textStyle: { color: colors.text },
        formatter(p) {
          if (p.seriesName === 'Sun path' && daytimeSamples[p.dataIndex]) {
            const s = daytimeSamples[p.dataIndex];
            return `${s.time_local}<br>Az ${fmt(s.azimuth_deg, '°', 0)} · Alt ${fmt(s.altitude_deg, '°', 0)}`;
          }
          if (p.seriesName === 'Current sun') return `Current sun<br>Az ${fmt(current.azimuth_deg, '°', 0)} · Alt ${fmt(current.altitude_deg, '°', 0)}`;
          return p.data && p.data.valueText ? p.data.valueText : p.seriesName;
        }
      },
      grid: { left: 12, right: 12, top: 12, bottom: 12 },
      xAxis: { min: 0, max: 100, show: false, type: 'value' },
      yAxis: { min: 0, max: 100, inverse: true, show: false, type: 'value' },
      graphic: [
        { type: 'circle', left: 'center', top: 'middle', shape: { r: 160 }, style: { fill: 'rgba(7,11,18,.15)', stroke: 'rgba(145,164,189,.22)', lineWidth: 1 } },
        { type: 'circle', left: 'center', top: 'middle', shape: { r: 105 }, style: { fill: 'transparent', stroke: 'rgba(145,164,189,.12)', lineWidth: 1, lineDash: [5, 8] } },
        { type: 'text', left: '50%', top: 6, style: { text: 'N', fill: colors.muted, fontWeight: 800, fontSize: 13 } },
        { type: 'text', right: 16, top: '50%', style: { text: 'E', fill: colors.muted, fontWeight: 800, fontSize: 13 } },
        { type: 'text', left: '50%', bottom: 6, style: { text: 'S', fill: colors.muted, fontWeight: 800, fontSize: 13 } },
        { type: 'text', left: 16, top: '50%', style: { text: 'W', fill: colors.muted, fontWeight: 800, fontSize: 13 } },
        { type: 'text', left: 16, top: 12, style: { text: current.is_day ? '☀ day' : '🌙 night', fill: current.is_day ? colors.pv_power : colors.muted, fontSize: 12, fontWeight: 700 } }
      ],
      series: [
        {
          name: 'Sun path', type: 'line', data: pathData, symbol: 'circle', symbolSize: 4,
          smooth: true, lineStyle: { color: '#fbbf24', width: 3 }, itemStyle: { color: '#fbbf24' }, z: 2
        },
        ...raySeries,
        {
          name: 'Current sun', type: 'scatter', data: [nowPoint], symbolSize: 16,
          itemStyle: { color: '#fde68a', borderColor: '#fff7ed', borderWidth: 2, shadowBlur: 16, shadowColor: 'rgba(251,191,36,.9)' }, z: 5
        }
      ]
    }, true);
  }

  function updateSunPath(payload) {
    try {
      if (payload && payload.error) throw new Error(payload.error);
      drawSunPath(payload);
    } catch (err) {
      if (charts.sunPath) charts.sunPath.clear();
      setHtml('sun-array-ranking', `<span class="sun-empty">Sun path error: ${escapeHtml(err.message || String(err))}</span>`);
      setHtml('sun-window-list', '');
      setText('sun-path-insight', 'ไม่สามารถโหลดข้อมูล Sun Path ได้ชั่วคราว');
    }
  }

  function updateHybridSolar(payload) {
    try {
      if (payload && payload.error) throw new Error(payload.error);
      const correction = payload.bias_correction || {};
      const current = payload.current || {};
      const rows = Array.isArray(payload.forecast_hours) ? payload.forecast_hours : [];
      setText('hybrid-corrected', current.corrected_wm2 == null ? '—' : `${Math.round(current.corrected_wm2)} W/m²`);
      setText('hybrid-original', current.open_meteo_wm2 == null ? 'Open-Meteo —' : `Open-Meteo ${Math.round(current.open_meteo_wm2)} W/m²`);
      setText('hybrid-nasa-avg', correction.nasa_avg_kwh_m2_day == null ? '—' : correction.nasa_avg_kwh_m2_day.toFixed(2));
      setText('hybrid-factor', correction.factor == null ? '—' : `×${Number(correction.factor).toFixed(2)}`);
      setText('hybrid-factor-sub', `${correction.matched_days || 0} matched days${correction.factor_clamped ? ' · clamped' : ''}`);
      const currentPanels = Array.isArray(current.panel_irradiance) ? current.panel_irradiance : [];
      const panelHtml = currentPanels.length ? currentPanels
        .slice()
        .sort((a, b) => (b.irradiance_wm2 || 0) - (a.irradiance_wm2 || 0))
        .map(p => `
          <div class="hybrid-panel-chip" style="--panel-color:${escapeHtml(p.color || '#91a4bd')}">
            <span>${escapeHtml(p.name || p.id)}</span>
            <b>${fmt(p.irradiance_wm2, ' W/m²', 0)}</b>
            <small>θ ${p.incidence_angle_deg == null ? '—' : Math.round(p.incidence_angle_deg) + '°'} · cos ${p.cos_incidence == null ? '—' : Number(p.cos_incidence).toFixed(2)} · tilt ${p.panel_tilt_deg || '—'}°</small>
          </div>`).join('') : '<div class="hybrid-panel-chip"><span>Panel irradiance</span><b>—</b><small>No cosine data</small></div>';
      setHtml('hybrid-panel-list', panelHtml);
      setText('hybrid-insight', payload.insight || 'Hybrid solar analysis unavailable.');
      if (!charts.hybridSolar) return;
      const labels = rows.map(r => new Date(r.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      const panelSeries = currentPanels.map(panel => ({
        name: panel.id.toUpperCase(),
        type: 'line',
        data: rows.map(r => {
          const match = Array.isArray(r.panel_irradiance) ? r.panel_irradiance.find(p => p.id === panel.id) : null;
          return match ? match.irradiance_wm2 : null;
        }),
        smooth: true,
        symbol: 'none',
        lineStyle: { color: panel.color || colors.muted, width: 2, opacity: 0.9 },
        emphasis: { focus: 'series' }
      }));
      charts.hybridSolar.setOption({
        backgroundColor: 'transparent',
        tooltip: {
          trigger: 'axis', appendToBody: true, backgroundColor: colors.panel, borderColor: colors.border,
          textStyle: { color: colors.text },
          formatter(params) {
            const i = params[0] ? params[0].dataIndex : 0;
            const r = rows[i] || {};
            let panelLines = '';
            if (Array.isArray(r.panel_irradiance)) {
              panelLines = r.panel_irradiance.map(p => `${escapeHtml(p.id.toUpperCase())}: ${fmt(p.irradiance_wm2, ' W/m²', 0)} (cos ${p.cos_incidence == null ? '—' : Number(p.cos_incidence).toFixed(2)})`).join('<br>');
            }
            return `<b>${labels[i] || '—'}</b><br>Open-Meteo GHI: ${fmt(r.open_meteo_wm2, ' W/m²', 0)}<br>NASA-corrected GHI: ${fmt(r.corrected_wm2, ' W/m²', 0)}<br>${panelLines}<br>Cloud: ${fmt(r.cloud_cover, '%', 0)}`;
          }
        },
        legend: { top: 0, textStyle: { color: colors.muted }, data: ['Open-Meteo GHI', 'Corrected GHI', ...currentPanels.map(p => p.id.toUpperCase())] },
        grid: { left: 54, right: 24, top: 42, bottom: 34 },
        xAxis: { type: 'category', data: labels, axisLabel: { color: colors.muted }, axisLine: { lineStyle: { color: colors.border } } },
        yAxis: { type: 'value', name: 'W/m²', min: 0, axisLabel: { color: colors.muted }, splitLine: { lineStyle: { color: colors.border, type: 'dashed' } } },
        series: [
          { name: 'Open-Meteo GHI', type: 'line', data: rows.map(r => r.open_meteo_wm2), smooth: true, symbol: 'none', lineStyle: { color: '#38bdf8', width: 2.5 }, areaStyle: { opacity: 0.08 } },
          { name: 'Corrected GHI', type: 'line', data: rows.map(r => r.corrected_wm2), smooth: true, symbol: 'circle', symbolSize: 5, lineStyle: { color: '#fbbf24', width: 3 }, itemStyle: { color: '#fbbf24' } },
          ...panelSeries
        ]
      }, true);
    } catch (err) {
      setText('hybrid-corrected', '—');
      setText('hybrid-original', 'Open-Meteo offline');
      setText('hybrid-nasa-avg', '—');
      setText('hybrid-factor', '—');
      setText('hybrid-factor-sub', 'API error');
      setHtml('hybrid-panel-list', '');
      setText('hybrid-insight', `ไม่สามารถโหลด Open-Meteo/NASA analysis ได้: ${err.message || String(err)}`);
      if (charts.hybridSolar) charts.hybridSolar.clear();
    }
  }

  function updateTimeShift(payload) {
    try {
      if (payload && payload.error) throw new Error(payload.error);
      const analysis = payload.time_shift_analysis || {};
      const profile = Array.isArray(analysis.profile) ? analysis.profile : [];
      const peaks = Array.isArray(analysis.peaks) ? analysis.peaks : [];
      const labels = profile.map(r => new Date(r.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      const colorsById = peaks.reduce((acc, p) => { acc[p.id] = p.color; return acc; }, {});
      const peakHtml = peaks.length ? peaks.map(p => `
        <div class="time-shift-peak" style="--pv-color:${escapeHtml(p.color || '#91a4bd')}">
          <span>${escapeHtml((p.id || '').toUpperCase())}</span>
          <b>${p.peak_time ? escapeHtml(new Date(p.peak_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) : '—'}</b>
          <small>${fmt(p.peak_irradiance_wm2, ' W/m²', 0)} · sun az ${fmt(p.peak_sun_azimuth_deg, '°', 0)} / alt ${fmt(p.peak_sun_altitude_deg, '°', 0)}</small>
          <small>${escapeHtml(p.name || '')}</small>
        </div>`).join('') : '<div class="time-shift-peak"><span>Peaks</span><b>—</b><small>No time-shift data</small></div>';
      setHtml('time-shift-peaks', peakHtml);
      setText('time-shift-insight', analysis.insight || 'Time-shift analysis unavailable.');
      if (!charts.timeShift) return;
      const panelIds = ['pv1', 'pv2', 'pv3', 'pv4'];
      charts.timeShift.setOption({
        backgroundColor: 'transparent',
        tooltip: {
          trigger: 'axis', appendToBody: true, backgroundColor: colors.panel, borderColor: colors.border,
          textStyle: { color: colors.text },
          formatter(params) {
            const i = params[0] ? params[0].dataIndex : 0;
            const row = profile[i] || {};
            const lines = panelIds.map(id => `${id.toUpperCase()}: ${fmt(row.pv && row.pv[id], ' W/m²', 0)}`).join('<br>');
            const best = row.best_aligned_pv;
            const bestLine = best ? `<br>Best aligned: <b style="color:${escapeHtml(best.color || '#fff')}">${escapeHtml((best.id || '').toUpperCase())}</b> ${fmt(best.irradiance_wm2, ' W/m²', 0)} · cos ${best.cos_incidence == null ? '—' : Number(best.cos_incidence).toFixed(2)}` : '';
            return `<b>${labels[i] || '—'}</b><br>Sun path: az ${fmt(row.sun_azimuth_deg, '°', 0)} · alt ${fmt(row.sun_altitude_deg, '°', 0)}<br>${lines}<br><b>Average: ${fmt(row.average_wm2, ' W/m²', 0)}</b>${bestLine}`;
          }
        },
        legend: { top: 0, textStyle: { color: colors.muted }, data: ['PV1', 'PV2', 'PV3', 'PV4', 'Average profile', 'Sun altitude'] },
        grid: { left: 54, right: 52, top: 42, bottom: 34 },
        xAxis: { type: 'category', data: labels, axisLabel: { color: colors.muted }, axisLine: { lineStyle: { color: colors.border } } },
        yAxis: [
          { type: 'value', name: 'W/m²', min: 0, axisLabel: { color: colors.muted }, splitLine: { lineStyle: { color: colors.border, type: 'dashed' } } },
          { type: 'value', name: 'Sun °', min: 0, max: 90, position: 'right', axisLabel: { color: '#fbbf24', formatter: '{value}°' }, splitLine: { show: false }, axisLine: { lineStyle: { color: 'rgba(251,191,36,.45)' } } }
        ],
        series: [
          ...panelIds.map(id => ({
            name: id.toUpperCase(), type: 'line', smooth: true, symbol: 'none', yAxisIndex: 0,
            data: profile.map(r => r.pv ? r.pv[id] : null),
            lineStyle: { width: id === 'pv2' || id === 'pv3' || id === 'pv4' ? 2.6 : 2, color: colorsById[id] || colors.muted, opacity: 0.88 },
            emphasis: { focus: 'series' }
          })),
          { name: 'Average profile', type: 'line', smooth: true, yAxisIndex: 0, data: profile.map(r => r.average_wm2), symbol: 'circle', symbolSize: 5, lineStyle: { color: '#ffffff', width: 4 }, itemStyle: { color: '#ffffff', borderColor: '#111827', borderWidth: 1.5 }, z: 5 },
          { name: 'Sun altitude', type: 'line', smooth: true, yAxisIndex: 1, data: profile.map(r => r.sun_altitude_deg), symbol: 'none', lineStyle: { color: '#fbbf24', width: 2, type: 'dashed', opacity: 0.75 }, emphasis: { focus: 'series' } }
        ]
      }, true);

      if (charts.timeShiftGeometry) {
        charts.timeShiftGeometry.setOption({
          backgroundColor: 'transparent',
          tooltip: {
            trigger: 'axis', appendToBody: true, backgroundColor: colors.panel, borderColor: colors.border,
            textStyle: { color: colors.text },
            formatter(params) {
              const i = params[0] ? params[0].dataIndex : 0;
              const row = profile[i] || {};
              const lines = panelIds.map(id => `${id.toUpperCase()}: ${fmt(row.pv_cos && row.pv_cos[id], '%', 1)}`).join('<br>');
              return `<b>${labels[i] || '—'}</b><br>Sun path: az ${fmt(row.sun_azimuth_deg, '°', 0)} · alt ${fmt(row.sun_altitude_deg, '°', 0)}<br>${lines}<br><small>Geometry-only = cosθ × 100, ไม่รวม GHI/เมฆ</small>`;
            }
          },
          legend: { top: 0, textStyle: { color: colors.muted }, data: ['PV1 geometry', 'PV2 geometry', 'PV3 geometry', 'PV4 geometry'] },
          grid: { left: 48, right: 22, top: 38, bottom: 28 },
          xAxis: { type: 'category', data: labels, axisLabel: { color: colors.muted }, axisLine: { lineStyle: { color: colors.border } } },
          yAxis: { type: 'value', name: 'cosθ %', min: 0, max: 100, axisLabel: { color: colors.muted, formatter: '{value}%' }, splitLine: { lineStyle: { color: colors.border, type: 'dashed' } } },
          series: panelIds.map(id => ({
            name: `${id.toUpperCase()} geometry`, type: 'line', smooth: true, symbol: 'none',
            data: profile.map(r => r.pv_cos ? r.pv_cos[id] : null),
            lineStyle: { width: id === 'pv2' || id === 'pv3' || id === 'pv4' ? 2.8 : 2.2, color: colorsById[id] || colors.muted, opacity: 0.95 },
            emphasis: { focus: 'series' }
          }))
        }, true);
      }
    } catch (err) {
      setHtml('time-shift-peaks', '');
      setText('time-shift-insight', `ไม่สามารถโหลด Time-Shift Analysis ได้: ${err.message || String(err)}`);
      if (charts.timeShift) charts.timeShift.clear();
      if (charts.timeShiftGeometry) charts.timeShiftGeometry.clear();
    }
  }

  function updateReport(report, telegram) {
    const forecast = report && report.forecast ? report.forecast : {};
    setText('forecast-summary', forecast.summary || 'ไม่มีข้อมูล forecast');
    const hours = Array.isArray(forecast.next_hours) ? forecast.next_hours : [];
    const hourHtml = hours.length ? hours.map(row => {
      const label = row.time ? new Date(row.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
      return `<div class="forecast-pill"><strong>${escapeHtml(label)}</strong><small>${escapeHtml(fmt(row.temperature_2m, '°C'))} · rain ${escapeHtml(fmt(row.precipitation_probability, '%', 0))}</small><small>cloud ${escapeHtml(fmt(row.cloud_cover, '%', 0))} · sun ${escapeHtml(fmt(row.shortwave_radiation, 'W/m²', 0))}</small></div>`;
    }).join('') : '<div class="forecast-pill"><strong>—</strong><small>No forecast data</small></div>';
    setHtml('forecast-hours', hourHtml);

    const recs = Array.isArray(report && report.recommendations) ? report.recommendations : [];
    setHtml('recommendation-list', recs.length
      ? recs.map(rec => `<li>${escapeHtml(rec)}</li>`).join('')
      : '<li>No recommendation yet</li>');

    const status = telegram || (report && report.telegram) || {};
    const interval = status.interval_ms ? `${Math.round(status.interval_ms / 60000)}m` : '—';
    const last = status.last_send_time ? ` · last ${new Date(status.last_send_time).toLocaleTimeString()}` : '';
    setText('telegram-status', `Telegram: ${status.configured ? 'configured' : 'not configured'} · ${status.last_status || 'idle'} · interval ${interval}${last}`);

    const solar = report && report.solar_stats ? report.solar_stats : {};
    const today = solar.today || {};
    const todaySunrise = today.sunrise_local || timeOrDash(today.sunrise_time);
    const todaySunset = today.sunset_local || timeOrDash(today.sunset_time);
    const todayPvStart = today.pv_start_local || timeOrDash(today.pv_start_time);
    const pvStopText = today.producing_now ? 'กำลังผลิตอยู่' : (today.pv_stop_local || timeOrDash(today.pv_stop_time));
    const stopDiff = today.producing_now ? 'ยังไม่สรุป' : formatMinutesValue(today.stop_after_sunset_min);
    setText('solar-summary', `วันนี้: sunrise ${todaySunrise} → เริ่มผลิต ${todayPvStart} (${formatMinutesValue(today.start_after_sunrise_min)}), sunset ${todaySunset} → หยุดผลิต ${pvStopText} (${stopDiff})`);
    const history = Array.isArray(solar.history) ? solar.history.slice(0, 7) : [];
    const historyHtml = history.length ? history.map(row => {
      const rise = row.sunrise_local || timeOrDash(row.sunrise_time);
      const set = row.sunset_local || timeOrDash(row.sunset_time);
      const start = row.pv_start_local || timeOrDash(row.pv_start_time);
      const stop = row.producing_now ? 'now' : (row.pv_stop_local || timeOrDash(row.pv_stop_time));
      const stopDelta = row.producing_now ? 'active' : formatMinutesValue(row.stop_after_sunset_min);
      return `<div class="forecast-pill"><strong>${escapeHtml(row.date_local || '—')}</strong><small>rise ${escapeHtml(rise)} · PV ${escapeHtml(start)} (${escapeHtml(formatMinutesValue(row.start_after_sunrise_min))})</small><small>set ${escapeHtml(set)} · stop ${escapeHtml(stop)} (${escapeHtml(stopDelta)})</small></div>`;
    }).join('') : '<div class="forecast-pill"><strong>—</strong><small>No solar stats yet</small></div>';
    setHtml('solar-history', historyHtml);

    // Populate sun-stats row
    const srTs   = today.sunrise_time ? new Date(today.sunrise_time).getTime() : null;
    const ssTs   = today.sunset_time  ? new Date(today.sunset_time).getTime()  : null;
    const nowMs  = Date.now();
    const dlMs   = srTs && ssTs ? ssTs - srTs : null;
    setText('sun-stat-rise',   todaySunrise);
    setText('sun-stat-set',    todaySunset);
    setText('sun-stat-day',    dlMs ? formatDurationHours(dlMs / 3600000) : '—');
    setText('sun-stat-status', srTs && ssTs && nowMs >= srTs && nowMs < ssTs ? '☀ Day' : '🌙 Night');

    drawWeatherForecast(report);
    drawSunArc(report);
  }

  function updateDataHealth(health) {
    if (!health) return;
    const statusLabels = { ok: '✅ OK', warn: '⚠ Warning', error: '🔴 Error' };
    setText('health-status', statusLabels[health.status] || health.status || '—');
    if (health.checked_at) setText('health-checked-at', `Checked ${new Date(health.checked_at).toLocaleTimeString()}`);
    const card = document.getElementById('health-card');
    if (card) {
      card.classList.remove('health-ok', 'health-warn', 'health-error');
      if (health.status) card.classList.add(`health-${health.status}`);
    }
    const em = health.energy_metrics || {};
    setText('health-energy-age', em.age_s !== null && em.age_s !== undefined ? `${em.age_s}s ago` : '—');
    setText('health-energy-ts', em.latest_ts ? new Date(em.latest_ts).toLocaleTimeString() : 'No data');
    const ch = health.collector_health || {};
    setText('health-collector-status', ch.failed ? '🔴 Failed' : ch.cycle_ok === true ? '✅ OK' : ch.cycle_ok === false ? '⚠ Error' : '—');
    setText('health-collector-failures', ch.failure_count !== null && ch.failure_count !== undefined ? `${ch.failure_count} failures` : '—');
    const rw = health.raw_snapshots || {};
    setText('health-raw-age', rw.age_s !== null && rw.age_s !== undefined ? `${rw.age_s}s ago` : '—');
    setText('health-raw-ts', rw.latest_ts ? new Date(rw.latest_ts).toLocaleTimeString() : 'No data');
    const si = health.station_info || {};
    setText('health-station-name', si.stationName || (si.available ? 'Available' : '—'));
    const pvCap = si.pvCapacity ? `PV ${si.pvCapacity} kW` : '';
    const batCap = si.batteryCapacity ? ` · Bat ${si.batteryCapacity} kWh` : '';
    setText('health-station-capacity', (pvCap + batCap).trim() || (si.status !== undefined ? `Status ${si.status}` : '—'));
  }

  function recLabel(group, value) {
    return t(`todayRec.${group}.${value}`) || value || '—';
  }

  function updateTodayRecommendation(payload) {
    latestTodayRecommendation = payload || latestTodayRecommendation;
    const rec = payload || latestTodayRecommendation;
    const card = document.getElementById('today-recommendation-card');
    if (!card) return;
    card.classList.remove('outlook-high', 'outlook-medium', 'outlook-low', 'outlook-night', 'outlook-no-data');

    if (!rec) {
      setText('today-rec-title', t('todayRec.loading'));
      setText('today-rec-updated', '—');
      setText('today-rec-outlook', '—');
      setText('today-rec-window', '—');
      setText('today-rec-battery', '—');
      setText('today-rec-dc', '—');
      setText('today-rec-confidence', '—');
      setHtml('today-rec-bullets', '<li>—</li>');
      setText('today-rec-reason', '—');
      return;
    }

    if (rec.pv_outlook) card.classList.add(`outlook-${rec.pv_outlook}`);
    const title = currentLang === 'en' ? (rec.title_en || rec.title) : (rec.title_th || rec.title);
    const bullets = currentLang === 'en' ? (rec.bullets_en || rec.bullets_th || []) : (rec.bullets_th || rec.bullets_en || []);
    const reasons = currentLang === 'en' ? (rec.reasons_en || rec.reasons_th || []) : (rec.reasons_th || rec.reasons_en || []);
    setText('today-rec-title', title || t('todayRec.loading'));
    setText('today-rec-updated', rec.generated_at ? `${t('todayRec.updated')} ${new Date(rec.generated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '—');
    setText('today-rec-outlook', recLabel('outlook', rec.pv_outlook));
    setText('today-rec-window', rec.best_usage_window || '—');
    setText('today-rec-battery', recLabel('battery', rec.battery_strategy));
    setText('today-rec-dc', recLabel('dc', rec.dc_charger));
    setText('today-rec-confidence', recLabel('conf', rec.confidence));
    const list = Array.isArray(bullets) && bullets.length ? bullets : ['—'];
    setHtml('today-rec-bullets', list.map(item => `<li>${escapeHtml(item)}</li>`).join(''));
    setText('today-rec-reason', Array.isArray(reasons) && reasons.length ? reasons.join(' · ') : '—');
  }

  async function getJson(url) {
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
  }

  function drawGridCost(payload) {
    if (!charts.gridCost) return;
    const history = Array.isArray(payload && payload.history) ? payload.history : [];
    if (!history.length) { charts.gridCost.clear(); return; }
    const days = history.map(r => r.date || r.day || '');
    const costs = history.map(r => n(r.grid_cost_thb));
    const pvValues = history.map(r => n(r.pv_value_thb));
    const imports = history.map(r => n(r.grid_import_kwh));
    const pvGen = history.map(r => n(r.pv_generation_kwh));
    const subtitle = document.getElementById('grid-cost-subtitle');
    if (subtitle && payload.days) subtitle.textContent = `Grid cost, estimated solar value and energy over the last ${payload.days} days`;
    charts.gridCost.setOption({
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        backgroundColor: colors.panel,
        borderColor: colors.border,
        textStyle: { color: colors.text },
        formatter(params) {
          const i = params[0] ? params[0].dataIndex : 0;
          const gridCost = costs[i] || 0;
          const pvVal = pvValues[i] || 0;
          const net = pvVal - gridCost;
          const netStr = (net >= 0 ? '+' : '') + net.toFixed(2);
          return [
            days[i],
            `Grid Import: ${(imports[i] || 0).toFixed(2)} kWh`,
            `PV Generation: ${(pvGen[i] || 0).toFixed(2)} kWh`,
            `Grid Cost: ฿${gridCost.toFixed(2)}`,
            `Estimated PV Value: ฿${pvVal.toFixed(2)}`,
            `Net (Solar − Grid): ฿${netStr}`,
          ].join('<br>');
        }
      },
      legend: {
        top: 0,
        textStyle: { color: colors.muted },
        data: ['Grid Cost (฿)', 'Estimated PV Value (฿)', 'Grid Import (kWh)', 'PV Generation (kWh)']
      },
      grid: { left: 54, right: 54, top: 42, bottom: 36 },
      xAxis: {
        type: 'category',
        data: days,
        axisLabel: { color: colors.muted, rotate: 25 },
        axisLine: { lineStyle: { color: colors.border } },
        splitLine: { show: false }
      },
      yAxis: [
        { type: 'value', name: '฿', min: 0, ...axisStyle() },
        { type: 'value', name: 'kWh', min: 0, position: 'right', axisLabel: { color: colors.grid_cost }, axisLine: { show: true, lineStyle: { color: colors.grid_cost, opacity: 0.4 } }, splitLine: { show: false } }
      ],
      series: [
        {
          name: 'Grid Cost (฿)',
          type: 'bar',
          stack: 'thb',
          yAxisIndex: 0,
          data: costs,
          barMaxWidth: 40,
          itemStyle: {
            color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(249,115,22,0.82)' }, { offset: 1, color: 'rgba(249,115,22,0.22)' }] },
            borderRadius: [0, 0, 0, 0]
          }
        },
        {
          name: 'Estimated PV Value (฿)',
          type: 'bar',
          stack: 'thb',
          yAxisIndex: 0,
          data: pvValues,
          barMaxWidth: 40,
          itemStyle: {
            color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(53,208,127,0.82)' }, { offset: 1, color: 'rgba(53,208,127,0.22)' }] },
            borderRadius: [4, 4, 0, 0]
          }
        },
        {
          name: 'Grid Import (kWh)',
          type: 'line',
          yAxisIndex: 1,
          data: imports,
          smooth: true,
          symbol: 'circle',
          symbolSize: 6,
          lineStyle: { color: colors.grid_flow_power, width: 2.5 },
          itemStyle: { color: colors.grid_flow_power, borderColor: '#fff', borderWidth: 1.5 }
        },
        {
          name: 'PV Generation (kWh)',
          type: 'line',
          yAxisIndex: 1,
          data: pvGen,
          smooth: true,
          symbol: 'circle',
          symbolSize: 6,
          lineStyle: { color: colors.pv_power, width: 2.5 },
          itemStyle: { color: colors.pv_power, borderColor: '#fff', borderWidth: 1.5 }
        }
      ]
    }, true);
  }

  function drawBatteryFullTime(payload) {
    const today = payload && payload.today ? payload.today : null;
    const history = Array.isArray(payload && payload.history) ? payload.history : [];

    function fmtMinutes(v) {
      if (v === null || v === undefined) return '—';
      return formatDurationHours(v / 60);
    }

    if (today) {
      setText('bft-today-time', today.first_full_local || (today.reached_full ? '—' : 'Not full yet'));
      setText('bft-today-sub', today.reached_full ? 'local time' : 'battery not full today');
      setText('bft-from-sunrise', fmtMinutes(today.minutes_from_sunrise_to_full));
      setText('bft-from-pv', fmtMinutes(today.minutes_from_pv_start_to_full));
      setText('bft-status', today.reached_full ? 'Full ✓' : (today.status || 'Not full'));
      setText('bft-samples', today.sample_count !== null && today.sample_count !== undefined ? `${today.sample_count} samples` : '—');
    }

    if (!charts.batteryFullTime) return;

    if (!history.length) {
      charts.batteryFullTime.clear();
      const listEl = document.getElementById('battery-full-history');
      if (listEl) listEl.innerHTML = '<div class="bft-history-empty">No history available</div>';
      return;
    }

    const todayKey = todayLocalDate();
    const dates = history.map(function(r) { return r.date ? r.date.slice(5) : ''; });
    const minutesData = history.map(function(r) {
      return (r.reached_full && r.minutes_since_midnight !== null && r.minutes_since_midnight !== undefined)
        ? r.minutes_since_midnight : null;
    });

    charts.batteryFullTime.setOption({
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        appendToBody: true,
        backgroundColor: colors.panel,
        borderColor: colors.border,
        textStyle: { color: colors.text, fontSize: 12 },
        extraCssText: 'z-index:9999;border-radius:8px;padding:8px 12px;',
        formatter: function(params) {
          var i = params[0] ? params[0].dataIndex : 0;
          var r = history[i] || {};
          var date = r.date || dates[i] || '';
          if (!r.reached_full || r.first_full_local == null) {
            return '<b>' + date + '</b><br><span style="color:#91a4bd;font-style:italic;">Not full yet</span><br>Samples: ' + (r.sample_count || 0);
          }
          var rows = [
            '<b>' + date + '</b>',
            'First 100%: <b style="color:#b47cff">' + (r.first_full_local || '—') + '</b>',
            'From sunrise (' + (r.sunrise_local || '—') + '): ' + fmtMinutes(r.minutes_from_sunrise_to_full),
            'From PV start (' + (r.pv_start_local || '—') + '): ' + fmtMinutes(r.minutes_from_pv_start_to_full),
            'Samples: ' + (r.sample_count || 0)
          ];
          return rows.join('<br>');
        }
      },
      grid: { left: 56, right: 16, top: 14, bottom: 36 },
      xAxis: {
        type: 'category',
        data: dates,
        axisLabel: { color: colors.muted, fontSize: 11 },
        axisLine: { lineStyle: { color: colors.border } },
        splitLine: { show: false }
      },
      yAxis: {
        type: 'value',
        name: 'min past midnight',
        nameTextStyle: { color: colors.muted, fontSize: 9, padding: [0, 0, 0, -6] },
        min: 0,
        axisLabel: {
          color: colors.muted,
          fontSize: 10,
          formatter: function(v) {
            var h = Math.floor(v / 60);
            var m = v % 60;
            return m === 0 ? h + ':00' : h + ':' + (m < 10 ? '0' : '') + m;
          }
        },
        splitLine: { lineStyle: { color: colors.border, type: 'dashed' } }
      },
      series: [{
        type: 'bar',
        barMaxWidth: 32,
        data: minutesData.map(function(v, i) {
          var isToday = history[i] && history[i].date === todayKey;
          return {
            value: v,
            itemStyle: {
              color: isToday
                ? { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: '#b47cff' }, { offset: 1, color: 'rgba(180,124,255,0.22)' }] }
                : { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(180,124,255,0.70)' }, { offset: 1, color: 'rgba(180,124,255,0.12)' }] },
              borderRadius: [4, 4, 0, 0]
            }
          };
        }),
        label: { show: false }
      }]
    }, true);

    var listEl = document.getElementById('battery-full-history');
    if (!listEl) return;
    listEl.innerHTML = history.slice().reverse().map(function(r) {
      var reachedFull = r.reached_full;
      return '<div class="bft-history-row' + (reachedFull ? '' : ' bft-no-full') + '">' +
        '<span class="bft-hist-date">' + escapeHtml(r.date || '—') + '</span>' +
        '<span class="bft-hist-time' + (reachedFull ? ' bft-full' : '') + '">' + escapeHtml(reachedFull ? (r.first_full_local || '—') : 'Not full') + '</span>' +
        '<span class="bft-hist-delta">+' + escapeHtml(fmtMinutes(r.minutes_from_sunrise_to_full)) + ' sunrise</span>' +
        '<span class="bft-hist-delta">+' + escapeHtml(fmtMinutes(r.minutes_from_pv_start_to_full)) + ' PV</span>' +
        '<span class="bft-hist-samples">' + escapeHtml(String(r.sample_count || 0)) + ' samp</span>' +
        '</div>';
    }).join('');
  }


  function fmtKwh(v, dec = 1) {
    const x = n(v);
    return x === null ? '—' : `${x.toFixed(dec)} kWh`;
  }

  function fmtThb(v) {
    const x = n(v);
    return x === null ? '—' : `฿${x.toFixed(2)}`;
  }

  function periodLabelTh(period) {
    return ({ day: t('summary.periodText.day'), week: t('summary.periodText.week'), month: t('summary.periodText.month'), year: t('summary.periodText.year'), all: t('summary.periodText.all') })[period] || t('summary.periodText.day');
  }

  function priorityLabel(priority) {
    return ({ high: currentLang === 'th' ? 'สำคัญ' : 'High', medium: currentLang === 'th' ? 'ควรปรับ' : 'Medium', low: currentLang === 'th' ? 'ตรวจสอบ' : 'Check', info: currentLang === 'th' ? 'ข้อมูล' : 'Info' })[priority] || priority || (currentLang === 'th' ? 'ข้อมูล' : 'Info');
  }

  function localizedAction(action) {
    const raw = action || {};
    if (currentLang === 'en') {
      return {
        ...raw,
        title: raw.title_en || raw.title || 'Recommendation',
        message: raw.message_en || raw.message || '',
        evidence: raw.evidence_en || raw.evidence || '',
      };
    }
    return {
      ...raw,
      title: raw.title_th || raw.title || 'คำแนะนำ',
      message: raw.message_th || raw.message || '',
      evidence: raw.evidence_th || raw.evidence || '',
    };
  }

  function updateSummaryCard(payload) {
    if (!payload) return;
    const energy = payload.energy || {};
    const cost = payload.cost || {};
    const eff = payload.efficiency || {};
    const opt = payload.optimization || {};
    const dq = payload.data_quality || {};
    const periodText = periodLabelTh(payload.period);

    setText('summary-period-subtitle', `${periodText} · ${new Date(payload.start).toLocaleString(currentLang === 'th' ? 'th-TH' : 'en-GB')} → ${new Date(payload.end).toLocaleString(currentLang === 'th' ? 'th-TH' : 'en-GB')} · ${t('summary.computed')}`);
    setText('summary-quality-line', `${t('summary.dataQuality')}: ${t('summary.coverage')} ${dq.coverage_pct ?? '—'}% · ${t('summary.samples')} ${dq.sample_count ?? 0} · ${t('summary.maxGap')} ${dq.largest_gap_minutes ?? '—'} ${currentLang === 'th' ? 'นาที' : 'min'} · ${t('summary.latest')} ${dq.latest_timestamp ? new Date(dq.latest_timestamp).toLocaleTimeString(currentLang === 'th' ? 'th-TH' : 'en-GB') : '—'}`);

    setText('sum-pv-kwh', fmtKwh(energy.pv_generation_kwh));
    setText('sum-pv-sub', energy.pv_source ? `${t('summary.source')}: ${energy.pv_source}` : 'kWh');
    setText('sum-load-kwh', fmtKwh(energy.home_consumption_kwh));
    setText('sum-grid-import', fmtKwh(energy.grid_import_kwh));
    setText('sum-grid-export', fmtKwh(energy.grid_export_kwh));
    setText('sum-grid-cost', fmtThb(cost.grid_cost_thb));
    setText('sum-grid-cost-sub', `${fmtThb(cost.grid_cost_thb)} · ${fmt(cost.rate_thb_per_kwh, ' ฿/kWh', 2)}`);
    setText('sum-self-use', eff.self_consumption_pct == null ? '—' : `${eff.self_consumption_pct.toFixed(0)}%`);
    setText('sum-self-suff', eff.self_sufficiency_pct == null ? `${t('summary.selfSuff')} —` : `${t('summary.selfSuff')} ${eff.self_sufficiency_pct.toFixed(0)}%`);
    setText('sum-opt-score', opt.score == null ? '—' : `${opt.score}/100`);
    setText('sum-opt-status', currentLang === 'en' ? (opt.status_en || opt.status || '—') : (opt.status_th || opt.status || '—'));

    const solarWindow = opt.best_solar_window;
    const importWindow = opt.grid_import_peak_window;
    setText('sum-best-solar-window', solarWindow ? solarWindow.window : '—');
    const solarWindowType = solarWindow && solarWindow.type === 'pv_production' ? 'pv_production' : 'surplus_export';
    const solarWindowLabel = solarWindowType === 'pv_production' ? t('summary.pvProductionWindow') : t('summary.solarSurplusWindow');
    const solarWindowKwh = solarWindow && solarWindow.kwh != null ? solarWindow.kwh : opt.solar_surplus_kwh;
    setText('sum-solar-surplus', `${solarWindowLabel} ${fmtKwh(solarWindowKwh)}`);
    setText('sum-import-peak-window', importWindow ? importWindow.window : '—');
    setText('sum-import-peak-sub', importWindow ? `${importWindow.kwh.toFixed(1)} kWh ${currentLang === 'th' ? 'ในช่วง peak' : 'during peak'}` : t('summary.noPeak'));
    setText('sum-potential-saving', fmtThb(opt.potential_saving_thb));
    setText('sum-shiftable-load', `${t('summary.shiftable')} ${fmtKwh(opt.shiftable_load_opportunity_kwh)}`);
    setText('sum-battery-full', opt.battery_full_time ? timeOrDash(opt.battery_full_time) : t('summary.notFull'));
    setText('sum-export-after-full', `${t('summary.exportAfterFull')} ${fmtKwh(opt.export_after_battery_full_kwh)}`);

    const actions = Array.isArray(opt.actions) ? opt.actions : [];
    const actionsHtml = actions.length ? actions.map(rawAction => {
      const a = localizedAction(rawAction);
      return `
      <article class="summary-action priority-${escapeHtml(a.priority || 'info')}">
        <div class="summary-action-head"><span>${escapeHtml(priorityLabel(a.priority))}</span><strong>${escapeHtml(a.title || (currentLang === 'th' ? 'คำแนะนำ' : 'Recommendation'))}</strong></div>
        <p>${escapeHtml(a.message || '')}</p>
        <small>${escapeHtml(a.evidence || '')}${a.potential_saving_thb ? ` · ${t('summary.approxSaving')} ${fmtThb(a.potential_saving_thb)}` : ''}</small>
      </article>
    `;
    }).join('') : `<div class="summary-action-empty">${escapeHtml(t('summary.noRecs'))}</div>`;
    setHtml('summary-actions', actionsHtml);

    if (charts.summaryEnergy) {
      const names = [t('summary.chart.pv'), t('summary.chart.load'), t('summary.chart.import'), t('summary.chart.export'), t('summary.chart.battCharge'), t('summary.chart.battDischarge'), 'DC Charger'];
      const values = [
        n(energy.pv_generation_kwh), n(energy.home_consumption_kwh), n(energy.grid_import_kwh),
        n(energy.grid_export_kwh), n(energy.battery_charge_kwh), n(energy.battery_discharge_kwh), n(energy.ev_charging_kwh)
      ];
      charts.summaryEnergy.setOption({
        backgroundColor: 'transparent',
        tooltip: { trigger: 'axis', backgroundColor: colors.panel, borderColor: colors.border, textStyle: { color: colors.text }, formatter(params) { const p = params[0]; return `${p.name}<br><b>${(p.value || 0).toFixed(2)} kWh</b>`; } },
        grid: { left: 44, right: 14, top: 18, bottom: 56 },
        xAxis: { type: 'category', data: names, axisLabel: { color: colors.muted, rotate: 25, fontSize: 10 }, axisLine: { lineStyle: { color: colors.border } }, splitLine: { show: false } },
        yAxis: { type: 'value', name: 'kWh', min: 0, ...axisStyle() },
        series: [{
          type: 'bar',
          barMaxWidth: 34,
          data: values.map((v, i) => ({ value: v || 0, itemStyle: { color: [colors.pv_power, colors.load_power, colors.grid_cost, colors.grid_flow_power, colors.battery_power, '#e879f9', colors.ev_power][i], borderRadius: [5, 5, 0, 0] } }))
        }]
      }, true);
    }
  }

  async function fetchRealtimeEnergy() {
    return getJson('/api/realtime-energy');
  }

  async function refreshRealtimeCards() {
    try {
      const data = await fetchRealtimeEnergy();
      updateRealtimeCards(data);
      setConnectivity(true);
      return data;
    } catch (err) {
      realtimeFailures += 1;
      setConnectivity(false, err.message || String(err));
      throw err;
    }
  }

  function updateRealtimeCards(data) {
    if (!data) return;
    const { pv, homeLoad, grid, batterySoc, batteryPower } = data;
    setText('m-pv', pv.value !== null ? `${pv.value.toFixed(2)} kW` : '—');
    setText('m-load', homeLoad.value !== null ? `${homeLoad.value.toFixed(2)} kW` : '—');
    setText('m-soc', batterySoc.value !== null ? `${batterySoc.value.toFixed(0)}%` : '—');
    const bp = batteryPower.value;
    setText('m-batt-sub', bp !== null
      ? `${bp > 0 ? 'Charging' : bp < 0 ? 'Discharging' : 'Idle'} ${Math.abs(bp).toFixed(2)} kW`
      : '—');
    const gv = grid.value;
    setText('m-grid', gv !== null ? `${Math.abs(gv).toFixed(2)} kW` : '—');
    setText('m-grid-sub', gv !== null
      ? (gv > 0.05 ? 'Exporting to grid' : gv < -0.05 ? 'Importing from grid' : 'Grid idle')
      : '—');
    setText('last-updated', `Updated ${new Date().toLocaleTimeString()}`);
  }

  async function refresh() {
    try {
      await refreshRealtimeCards().catch(() => null);

      // Fast path: render the core dashboard as soon as the primary live/history
      // APIs return. Slow analytical cards (battery-full-time, summary, cost) update
      // independently so one long Influx query does not block the whole page load.
      const nowMs = Date.now();
      const shouldFetchTeslaContext = nowMs - lastTeslaContextFetch > ANALYTICS_REFRESH_MS;
      if (shouldFetchTeslaContext) lastTeslaContextFetch = nowMs;
      const teslaContextPromise = shouldFetchTeslaContext
        ? getJson('/api/tesla/session-context').catch(() => {
            lastTeslaContextFetch = 0;
            return null;
          })
        : Promise.resolve(latestTeslaContext);
      const [latest, history, weatherVsActual, energySourceMix, dataHealth, todayRecommendation, teslaContext] = await Promise.all([
        getJson('/api/latest'),
        getJson(`/api/history?date=${selectedHistoryDate}`),
        getJson(`/api/weather-vs-actual?date=${selectedHistoryDate}`),
        getJson(`/api/energy-source-mix?date=${selectedHistoryDate}`).catch(() => null),
        getJson('/api/data-health').catch(() => null),
        getJson('/api/today-recommendation').catch(() => null),
        teslaContextPromise,
      ]);
      latestTeslaContext = teslaContext;
      showError('');
      setConnectivity(true);
      updateMetrics(latest);
      drawFlow(latest);
      drawSource(energySourceMix, selectedHistoryDate);
      drawTrend(history.series || {}, selectedHistoryDate);
      updateBatteryDetails(latest);
      drawWeatherVsActual(weatherVsActual);
      updateDataHealth(dataHealth);
      updateTodayRecommendation(todayRecommendation);
      updateTeslaCardFromContext(latestTeslaContext);
      const isToday = selectedHistoryDate === todayLocalDate();
      const subtitle = document.getElementById('weather-actual-subtitle');
      if (subtitle) {
        subtitle.textContent = isToday
          ? 'PV1–PV4 actual string power (stacked bars) · GHI line · cloud cover. Today — realtime cards (KPI · Power Flow · Battery Details) remain live.'
          : `PV1–PV4 actual string power (stacked bars) · GHI line · cloud cover. History for ${selectedHistoryDate} (00:00 → 24:00) — realtime cards remain live.`;
      }

      if (nowMs - lastSummaryFetch > ANALYTICS_REFRESH_MS) {
        lastSummaryFetch = nowMs;
        getJson(`/api/summary?period=${selectedSummaryPeriod}`)
          .then(updateSummaryCard)
          .catch(() => { lastSummaryFetch = 0; });
      }
      if (nowMs - lastGridCostFetch > ANALYTICS_REFRESH_MS) {
        lastGridCostFetch = nowMs;
        getJson(`/api/grid-cost?days=${selectedGridCostDays}`)
          .then(drawGridCost)
          .catch(() => { lastGridCostFetch = 0; });
      }
      if (nowMs - lastDcCostFetch > ANALYTICS_REFRESH_MS) {
        lastDcCostFetch = nowMs;
        getJson('/api/dc-charger-cost')
          .then(payload => {
            updateDcCharger(latest, payload);
            if (latestTeslaContext) updateTeslaCard(latestTeslaContext.tesla_latest, payload);
          })
          .catch(() => {
            lastDcCostFetch = 0;
            updateDcCharger(latest, null);
            if (latestTeslaContext) updateTeslaCard(latestTeslaContext.tesla_latest, null);
          });
      } else {
        updateDcCharger(latest, undefined);
      }
      if (nowMs - lastBatteryFullFetch > BATTERY_FULL_REFRESH_MS) {
        lastBatteryFullFetch = nowMs;
        getJson('/api/battery-full-time?days=7')
          .then(drawBatteryFullTime)
          .catch(() => { lastBatteryFullFetch = 0; });
      }
    } catch (err) {
      realtimeFailures += 1;
      setConnectivity(false, err.message || String(err));
    }
  }

  function schedule() {
    clearInterval(refreshTimer);
    refreshTimer = setInterval(refresh, REFRESH_MS);
  }

  function scheduleRealtime() {
    clearTimeout(realtimeTimer);
    const tick = () => {
      refreshRealtimeCards()
        .catch(() => {})
        .finally(() => { realtimeTimer = setTimeout(tick, nextRealtimeDelay()); });
    };
    realtimeTimer = setTimeout(tick, REALTIME_MS);
  }


  document.querySelectorAll('.lang-btn').forEach(btn => btn.addEventListener('click', () => setLanguage(btn.dataset.lang || 'th')));

  document.querySelectorAll('.summary-period-btn').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.summary-period-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedSummaryPeriod = btn.dataset.summaryPeriod || 'day';
    lastSummaryFetch = 0;
    refresh();
    schedule();
  }));

  document.querySelectorAll('.grid-cost-range').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.grid-cost-range').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedGridCostDays = Number(btn.dataset.gridCostDays) || 7;
    lastGridCostFetch = 0;
    refresh();
  }));

  document.querySelectorAll('.range-btn').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentRange = btn.dataset.range || '2h';
    refresh();
    schedule();
  }));

  // Wire history date toolbar
  (function() {
    const histDateInput = document.getElementById('hist-date');
    const histPrev = document.getElementById('hist-prev');
    const histNext = document.getElementById('hist-next');
    const histToday = document.getElementById('hist-today');

    if (histDateInput) histDateInput.value = selectedHistoryDate;

    function applyHistoryDate(dateKey) {
      selectedHistoryDate = dateKey;
      if (histDateInput) histDateInput.value = dateKey;
      lastTrendSignature = '';
      weatherActualSolarMarkerCache = null;
      weatherActualMarkerSig = null;
      refresh();
      schedule();
    }

    if (histPrev) histPrev.addEventListener('click', () => {
      const [y, m, d] = selectedHistoryDate.split('-').map(Number);
      applyHistoryDate(new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10));
    });

    if (histNext) histNext.addEventListener('click', () => {
      const [y, m, d] = selectedHistoryDate.split('-').map(Number);
      const nextKey = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
      if (nextKey <= todayLocalDate()) applyHistoryDate(nextKey);
    });

    if (histToday) histToday.addEventListener('click', () => applyHistoryDate(todayLocalDate()));

    if (histDateInput) histDateInput.addEventListener('change', () => {
      if (histDateInput.value && /^\d{4}-\d{2}-\d{2}$/.test(histDateInput.value)) {
        applyHistoryDate(histDateInput.value);
      }
    });
  })();

  window.addEventListener('resize', () => Object.values(charts).forEach(c => c && c.resize()));

  fetch('/api/health')
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(data) {
      if (!data) return;
      var envEl = document.getElementById('env-marker');
      var verEl = document.getElementById('version-marker');
      if (envEl) envEl.textContent = 'env: ' + (data.environment || 'local');
      if (verEl) verEl.textContent = data.release_label || data.release_version || 'dev';
    })
    .catch(function() {});

  applyLanguage();
  refresh();
  schedule();
  scheduleRealtime();
})();
