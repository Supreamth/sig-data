(() => {
  'use strict';

  const REFRESH_MS = 15000;
  let refreshTimer = null;
  let isOnline = false;

  function el(id) {
    return document.getElementById(id);
  }

  function setText(id, value) {
    var node = el(id);
    if (node) node.textContent = value;
  }

  function localTime(isoStr) {
    var d = isoStr ? new Date(isoStr) : new Date();
    return d.toLocaleTimeString('th-TH', {
      timeZone: 'Asia/Bangkok',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }

  function setDot(id, state) {
    var node = el(id);
    if (!node) return;
    node.className = 'dot ' + (state || '');
  }

  function setLiveBadge(state) {
    var badge = el('live-badge');
    if (!badge) return;
    badge.className = 'live-badge ' + state;
    badge.textContent = state === 'live' ? 'LIVE' : state === 'offline' ? 'OFFLINE' : 'syncing';
  }

  function applyHealth(data) {
    if (!data) return;

    setLiveBadge(data.status === 'ok' ? 'live' : 'offline');
    isOnline = data.status === 'ok';
    document.body.classList.toggle('is-offline', !isOnline);

    setText('cb-updated', localTime(null));

    if (data.latest_db_timestamp) {
      var dbTime = localTime(data.latest_db_timestamp);
      setText('db-ts', dbTime);
      setText('dh-db-ts', dbTime);
      setDot('db-dot', 'on');
    }

    if (data.station_id) {
      setText('station-state', data.station_id.slice(-6));
      setText('dh-station', 'OK');
      setText('dh-station-id', data.station_id);
      setDot('station-dot', 'on');
    }

    if (data.bucket) {
      setText('dh-bucket', data.bucket);
    }
    if (data.org) {
      setText('dh-org', data.org);
    }

    setText('dh-status', data.status === 'ok' ? 'OK' : 'ERROR');
    setText('dh-checked', 'Checked ' + localTime(null));

    var healthCard = el('health-v2');
    if (healthCard) {
      healthCard.classList.remove('health-ok', 'health-warn', 'health-err');
      healthCard.classList.add(data.status === 'ok' ? 'health-ok' : 'health-err');
    }
  }

  function handleFetchError() {
    setLiveBadge('offline');
    isOnline = false;
    document.body.classList.add('is-offline');
    setText('cb-updated', localTime(null));
    setText('dh-status', 'OFFLINE');
    setText('dh-checked', 'Failed ' + localTime(null));
    setDot('station-dot', 'off');
    setDot('db-dot', 'off');
  }

  function fetchHealth() {
    return fetch('/api/health')
      .then(function(res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function(data) {
        applyHealth(data);
      })
      .catch(function() {
        handleFetchError();
      });
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(function() {
      fetchHealth().then(scheduleRefresh);
    }, REFRESH_MS);
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

    fetchHealth().then(scheduleRefresh);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
