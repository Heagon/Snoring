const $ = (sel) => document.querySelector(sel);

const fmtHCM = (tsSec) => {
  const d = new Date(tsSec * 1000);
  return d.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
};

function todayHCM() {
  const d = new Date();
  // get today's date in HCM (YYYY-MM-DD)
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return parts; // en-CA => YYYY-MM-DD
}

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText} ${text}`.trim());
  }
  return await res.json();
}

function makeLineChart(canvasId, title) {
  const ctx = document.getElementById(canvasId);
  return new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: title,
        data: [],
        pointRadius: 0,
        tension: 0.15,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: true },
        tooltip: { mode: 'index', intersect: false }
      },
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { ticks: { maxTicksLimit: 8 } },
        y: { beginAtZero: false }
      }
    }
  });
}

const chartSpO2 = makeLineChart('chartSpo2', 'SpO₂ (%)');
const chartRMS  = makeLineChart('chartRms',  'RMS');

function setChartData(chart, rows, key) {
  const labels = rows.map(r => r.time_hcm);
  const values = rows.map(r => r[key]);
  chart.data.labels = labels;
  chart.data.datasets[0].data = values;
  chart.update();
}

function setStatus(msg, isErr=false) {
  const el = $('#status');
  el.textContent = msg;
  el.className = isErr ? 'err' : '';
}

async function loadDaily() {
  const base = $('#apiBase').value.trim().replace(/\/$/, '');
  const date = $('#day').value;
  const dev  = $('#deviceId').value.trim() || 'default';

  setStatus('Đang tải dữ liệu theo ngày...');
  try {
    const url = `${base}/telemetry?date=${encodeURIComponent(date)}&device=${encodeURIComponent(dev)}`;
    const data = await fetchJson(url);
    $('#points').textContent = `${data.count}`;

    setChartData(chartSpO2, data.rows, 'spo2');
    setChartData(chartRMS,  data.rows, 'rms_fast');

    setStatus(`OK. ${data.count} điểm (ngày ${date})`);
  } catch (e) {
    console.error(e);
    setStatus(`Lỗi: ${e.message}`, true);
  }
}

async function loadAbnormal() {
  const base = $('#apiBase').value.trim().replace(/\/$/, '');
  const days = Number($('#abnDays').value || 1);
  const dev  = $('#deviceId').value.trim() || 'default';

  const list = $('#abnList');
  list.innerHTML = '';

  setStatus('Đang tải danh sách Abnormal...');
  try {
    const url = `${base}/abnormal?days=${days}&device=${encodeURIComponent(dev)}`;
    const data = await fetchJson(url);

    if (!data.items.length) {
      const li = document.createElement('li');
      li.textContent = 'Không có file Abnormal trong khoảng ngày đã chọn.';
      list.appendChild(li);
      setStatus('OK. 0 file abnormal');
      return;
    }

    for (const it of data.items) {
      const li = document.createElement('li');

      const meta = document.createElement('div');
      meta.className = 'meta';
      const sizeKB = (it.size_bytes / 1024).toFixed(1);
      meta.textContent = `${it.time_hcm} — ${it.filename} (${sizeKB} KB)`;

      const audio = document.createElement('audio');
      audio.controls = true;
      audio.preload = 'none';
      audio.src = `${base}/audio/${encodeURIComponent(it.key)}`;

      li.appendChild(meta);
      li.appendChild(audio);
      list.appendChild(li);
    }

    setStatus(`OK. ${data.items.length} file abnormal (last ${days} day(s))`);
  } catch (e) {
    console.error(e);
    setStatus(`Lỗi: ${e.message}`, true);
  }
}

let liveTimer = null;

async function tickLive() {
  const base = $('#apiBase').value.trim().replace(/\/$/, '');
  const dev  = $('#deviceId').value.trim() || 'default';
  try {
    const url = `${base}/telemetry/latest?limit=120&device=${encodeURIComponent(dev)}`;
    const data = await fetchJson(url);

    if (!data.rows.length) {
      $('#liveSpo2').textContent = '--';
      $('#liveRms').textContent = '--';
      $('#liveTs').textContent = '--';
      return;
    }
    const last = data.rows[data.rows.length - 1];
    $('#liveSpo2').textContent = (last.spo2 ?? '--');
    $('#liveRms').textContent  = (last.rms_fast ?? '--');
    $('#liveTs').textContent   = last.time_hcm;
  } catch (e) {
    console.error(e);
  }
}

function toggleLive() {
  const on = $('#liveToggle').checked;
  if (on) {
    tickLive();
    liveTimer = setInterval(tickLive, 1000);
  } else {
    if (liveTimer) clearInterval(liveTimer);
    liveTimer = null;
  }
}

function init() {
  $('#day').value = todayHCM();

  $('#loadDay').addEventListener('click', loadDaily);
  $('#loadAbn').addEventListener('click', loadAbnormal);
  $('#liveToggle').addEventListener('change', toggleLive);

  // auto-load once
  loadDaily();
  loadAbnormal();
}

window.addEventListener('DOMContentLoaded', init);
