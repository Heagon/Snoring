/* SleepMon Web UI (v3) - Abnormal markers (no audio upload/decoding)
   - Select 1..7 days
   - Charts: SpO2 + RMS (today/live colors fixed)
   - Abnormal: table of abnormal segments (filename) + checkboxes
     -> checked rows show vertical lines (labeled by row index) on both charts
*/

// ====== CONFIG ======
const API_BASE = "https://sleepmon-api.sleepmon.workers.dev"; // change to your Worker domain
const ZONE = "Asia/Ho_Chi_Minh";

// Day palette: index 0 = today
const DAY_COLORS = [
  "#e53935", // today: red
  "#43a047", // yesterday: green
  "#1e88e5", // blue
  "#fbc02d", // yellow
  "#8e24aa", // purple
  "#fb8c00", // orange
  "#d81b60", // pink
];

// ====== DOM ======
const elStatus   = document.getElementById("status");
const elDateBox  = document.getElementById("dateBox");
const elBtnRef   = document.getElementById("btnRefresh");

const elLastTs   = document.getElementById("lastTs");
const elSpo2Val  = document.getElementById("spo2Val");
const elRmsVal   = document.getElementById("rmsVal");
const elAlarmVal = document.getElementById("alarmVal");

const elAbnList  = document.getElementById("abnList");

// ====== STATE ======
let selectedDates = [];        // display format DD-MM-YYYY
let selectedIsoDays = [];      // ISO yyyy-LL-dd

let latestPoint = null;
let daysData = {};             // { isoDay: [ {ts,spo2,rms,alarmA} ... ] }

let abnAllItems = [];          // from API: {key,ts,day,filename}
const abnChecked = new Set();  // keys checked in UI
const abnRowInfo = new Map();  // key -> { ts, day, idx }
let abnVisibleKeys = [];

let spo2Chart = null;
let rmsChart  = null;

// ====== UTILS ======
const { DateTime } = luxon;

function toDisplayDate(dt) {
  return dt.toFormat("dd-LL-yyyy");
}

function displayToIso(displayDDMMYYYY) {
  const dt = DateTime.fromFormat(displayDDMMYYYY, "dd-LL-yyyy", { zone: ZONE });
  if (!dt.isValid) return null;
  return dt.toFormat("yyyy-LL-dd");
}

function isoToDisplay(isoDay) {
  const dt = DateTime.fromFormat(isoDay, "yyyy-LL-dd", { zone: ZONE });
  if (!dt.isValid) return isoDay;
  return dt.toFormat("dd-LL-yyyy");
}

function dayIndexFromIso(isoDay) {
  const todayIso = DateTime.now().setZone(ZONE).toFormat("yyyy-LL-dd");
  const d0 = DateTime.fromFormat(todayIso, "yyyy-LL-dd", { zone: ZONE });
  const d1 = DateTime.fromFormat(isoDay, "yyyy-LL-dd", { zone: ZONE });
  if (!d0.isValid || !d1.isValid) return 6;
  const diff = Math.floor(d0.startOf("day").diff(d1.startOf("day"), "days").days);
  return Math.max(0, Math.min(6, diff));
}

function colorForDay(isoDay) {
  const idx = dayIndexFromIso(isoDay);
  const base = DAY_COLORS[idx] || DAY_COLORS[6];
  return { spo2: base, rms: base, base };
}

function fmtTimeFromTs(tsSec) {
  const dt = DateTime.fromSeconds(Number(tsSec), { zone: ZONE });
  if (!dt.isValid) return "";
  return dt.toFormat("HH:mm:ss");
}

function setStatus(msg) {
  elStatus.textContent = msg || "";
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

// ====== CHART: vertical lines plugin ======
const vlinesPlugin = {
  id: "vlines",
  afterDatasetsDraw(chart) {
    const lines = chart?.options?.plugins?.vlines?.lines || [];
    if (!lines.length) return;

    const { ctx, chartArea } = chart;
    const xScale = chart.scales.x;
    if (!chartArea || !xScale) return;

    ctx.save();

    for (const ln of lines) {
      const x = xScale.getPixelForValue(ln.x);
      if (x < chartArea.left - 1 || x > chartArea.right + 1) continue;

      ctx.strokeStyle = ln.color || "#ffffff";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, chartArea.top);
      ctx.lineTo(x, chartArea.bottom);
      ctx.stroke();

      if (ln.label) {
        ctx.fillStyle = ln.color || "#ffffff";
        ctx.font = "12px system-ui";
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillText(String(ln.label), x + 3, chartArea.top + 3);
      }
    }

    ctx.restore();
  },
};
Chart.register(vlinesPlugin);

function ensureCharts() {
  if (spo2Chart && rmsChart) return;

  const ctxS = document.getElementById("canvasSpo2").getContext("2d");
  const ctxR = document.getElementById("canvasRms").getContext("2d");

  spo2Chart = new Chart(ctxS, {
    type: "line",
    data: { datasets: [] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      parsing: false,
      animation: false,
      normalized: true,
      interaction: { mode: "nearest", intersect: false },
      scales: {
        x: {
          type: "time",
          adapters: { date: luxon.AdapterLuxon },
          time: { unit: "hour" },
          ticks: { maxRotation: 0 },
        },
        y: {
          suggestedMin: 70,
          suggestedMax: 100,
        },
      },
      plugins: {
        legend: { labels: { color: "#e6edf3" } },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const v = ctx.parsed.y;
              if (v === null || v === undefined || Number.isNaN(v)) return `${ctx.dataset.label}: (null)`;
              return `${ctx.dataset.label}: ${Number(v).toFixed(1)}`;
            },
          },
        },
        vlines: { lines: [] },
      },
      elements: { point: { radius: 0 } },
    },
  });

  rmsChart = new Chart(ctxR, {
    type: "line",
    data: { datasets: [] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      parsing: false,
      animation: false,
      normalized: true,
      interaction: { mode: "nearest", intersect: false },
      scales: {
        x: {
          type: "time",
          adapters: { date: luxon.AdapterLuxon },
          time: { unit: "hour" },
          ticks: { maxRotation: 0 },
        },
        y: {
          suggestedMin: 0,
        },
      },
      plugins: {
        legend: { labels: { color: "#e6edf3" } },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const v = ctx.parsed.y;
              if (v === null || v === undefined || Number.isNaN(v)) return `${ctx.dataset.label}: (null)`;
              return `${ctx.dataset.label}: ${Number(v).toFixed(5)}`;
            },
          },
        },
        vlines: { lines: [] },
      },
      elements: { point: { radius: 0 } },
    },
  });
}

function buildDatasets() {
  // Live datasets (today only)
  const liveSpo2 = {
    label: "Live SpO2",
    data: [],
    borderColor: "#e53935",
    borderWidth: 2,
    spanGaps: true,
  };
  const liveRms = {
    label: "Live RMS",
    data: [],
    borderColor: "#1e88e5",
    borderWidth: 2,
    spanGaps: true,
  };

  const dsSpo2 = [liveSpo2];
  const dsRms  = [liveRms];

  for (const isoDay of selectedIsoDays) {
    const col = colorForDay(isoDay);

    const spo2 = {
      label: `SpO2 ${isoToDisplay(isoDay)}`,
      data: [],
      borderColor: col.spo2,
      borderWidth: 2,
      spanGaps: true,
    };
    const rms = {
      label: `RMS ${isoToDisplay(isoDay)}`,
      data: [],
      borderColor: col.rms,
      borderWidth: 2,
      spanGaps: true,
    };

    const rows = daysData?.[isoDay] || [];
    for (const p of rows) {
      const x = Number(p.ts) * 1000;
      if (p.spo2 !== null && p.spo2 !== undefined) spo2.data.push({ x, y: Number(p.spo2) });
      if (p.rms  !== null && p.rms  !== undefined) rms.data.push({ x, y: Number(p.rms)  });

      // feed live if today
      const todayIso = DateTime.now().setZone(ZONE).toFormat("yyyy-LL-dd");
      if (isoDay === todayIso) {
        if (p.spo2 !== null && p.spo2 !== undefined) liveSpo2.data.push({ x, y: Number(p.spo2) });
        if (p.rms  !== null && p.rms  !== undefined) liveRms.data.push({ x, y: Number(p.rms)  });
      }
    }

    dsSpo2.push(spo2);
    dsRms.push(rms);
  }

  spo2Chart.data.datasets = dsSpo2;
  rmsChart.data.datasets  = dsRms;
}

function updateAbnLines() {
  const lines = [];
  for (const key of abnChecked) {
    const info = abnRowInfo.get(key);
    if (!info) continue; // not visible

    const c = colorForDay(info.day);
    lines.push({
      x: Number(info.ts) * 1000,
      label: String(info.idx),
      color: c.base,
    });
  }

  spo2Chart.options.plugins.vlines.lines = lines;
  rmsChart.options.plugins.vlines.lines  = lines;
  spo2Chart.update("none");
  rmsChart.update("none");
}

// ====== DATE SELECTOR ======
function buildDateSelector() {
  const now = DateTime.now().setZone(ZONE).startOf("day");
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = now.minus({ days: i });
    days.push({
      iso: d.toFormat("yyyy-LL-dd"),
      display: toDisplayDate(d),
      idx: i,
    });
  }

  // Default: today only
  selectedDates = [days[0].display];
  selectedIsoDays = [days[0].iso];

  elDateBox.innerHTML = "";
  for (const d of days) {
    const chip = document.createElement("label");
    chip.className = "datechip";
    chip.style.setProperty("--day-color", DAY_COLORS[d.idx] || DAY_COLORS[6]);

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = d.idx === 0;
    cb.dataset.iso = d.iso;
    cb.dataset.display = d.display;

    const span = document.createElement("span");
    span.textContent = d.display;

    chip.appendChild(cb);
    chip.appendChild(span);
    elDateBox.appendChild(chip);

    cb.addEventListener("change", () => {
      const all = [...elDateBox.querySelectorAll("input[type=checkbox]")];
      const picked = all.filter((x) => x.checked).map((x) => ({ iso: x.dataset.iso, display: x.dataset.display }));
      if (!picked.length) {
        cb.checked = true;
        return;
      }

      // keep original ordering: newest -> oldest by selector order
      const order = new Map(days.map((x, i) => [x.iso, i]));
      picked.sort((a, b) => (order.get(a.iso) ?? 99) - (order.get(b.iso) ?? 99));

      selectedDates = picked.map((x) => x.display);
      selectedIsoDays = picked.map((x) => x.iso);

      loadSelected().catch(() => {});
      renderAbnTable();
      updateAbnLines();
    });
  }
}

// ====== FETCH + RENDER ======
async function loadLatest() {
  try {
    const j = await fetchJson(`${API_BASE}/telemetry/latest`);
    latestPoint = j.point || null;

    if (!latestPoint) {
      elLastTs.textContent = "-";
      elSpo2Val.textContent = "-";
      elRmsVal.textContent = "-";
      elAlarmVal.textContent = "-";
      return;
    }

    const dt = DateTime.fromSeconds(Number(latestPoint.ts), { zone: ZONE });
    elLastTs.textContent = dt.isValid ? dt.toFormat("dd-LL-yyyy HH:mm:ss") : String(latestPoint.ts);
    elSpo2Val.textContent = latestPoint.spo2 === null ? "-" : Number(latestPoint.spo2).toFixed(1);
    elRmsVal.textContent  = latestPoint.rms  === null ? "-" : Number(latestPoint.rms).toFixed(5);
    elAlarmVal.textContent = latestPoint.alarmA ? "ALARM" : "OK";
  } catch (e) {
    console.warn("latest fail", e);
  }
}

async function loadSelected() {
  if (!selectedIsoDays.length) return;

  setStatus("Đang tải dữ liệu...");

  try {
    const qs = encodeURIComponent(selectedIsoDays.join(","));
    const j = await fetchJson(`${API_BASE}/telemetry/days?dates=${qs}`);
    daysData = j.days || {};

    ensureCharts();
    buildDatasets();

    spo2Chart.update("none");
    rmsChart.update("none");

    setStatus("OK");
  } catch (e) {
    console.error(e);
    setStatus("Không tải được dữ liệu (check API_BASE / CORS / Worker)");
  }
}

async function loadAbn() {
  try {
    const j = await fetchJson(`${API_BASE}/abnormal/list?days=7`);
    abnAllItems = Array.isArray(j.items) ? j.items : [];
  } catch (e) {
    console.warn("abnormal list fail", e);
    abnAllItems = [];
  }
}

function renderAbnTable() {
  if (!elAbnList) return;

  // Build visible list
  const visible = [];
  const isoSet = new Set(selectedIsoDays);

  for (const it of abnAllItems) {
    const ts = Number(it.ts);
    if (!Number.isFinite(ts) || ts <= 0) continue;

    const day = it.day || DateTime.fromSeconds(ts, { zone: ZONE }).toFormat("yyyy-LL-dd");
    if (!isoSet.has(day)) continue;

    const key = it.key || `${day}/${ts}/${it.filename || "unknown"}`;
    const filename = it.filename || "unknown";
    visible.push({ key, ts, day, filename });
  }

  // Sort ascending for readable sequence (so indices match timeline)
  visible.sort((a, b) => a.ts - b.ts);

  abnRowInfo.clear();
  abnVisibleKeys = visible.map((x) => x.key);

  if (!visible.length) {
    elAbnList.innerHTML = `<div class="note">Không có Abnormal trong các ngày đang chọn.</div>`;
    // Remove lines that are no longer visible
    updateAbnLines();
    return;
  }

  // Build table with day grouping rows
  let html = "";
  html += `<div class="abnTop">`;
  html += `<div class="sub">Bảng Abnormal (tên file segment 30s được gắn nhãn Abnormal khi đóng segment).</div>`;
  html += `<label class="abnControls">Chọn tất cả <input id="abnAllToggle" type="checkbox"></label>`;
  html += `</div>`;

  html += `<table class="abnTable">`;
  html += `<thead><tr><th style="width:64px">#</th><th>Tên file</th><th style="width:120px">Chọn</th></tr></thead>`;
  html += `<tbody>`;

  let idx = 1;
  let curDay = null;
  const dayKeys = new Map(); // day -> [keys]

  for (const row of visible) {
    if (!dayKeys.has(row.day)) dayKeys.set(row.day, []);
    dayKeys.get(row.day).push(row.key);

    if (row.day !== curDay) {
      curDay = row.day;
      const c = colorForDay(curDay);
      html += `<tr class="abnDayRow"><td colspan="3">`;
      html += `<div class="abnDayHeader">`;
      html += `<div class="abnDayLeft"><span class="swatch" style="--day-color:${c.base}"></span><span>${isoToDisplay(curDay)}</span></div>`;
      html += `<label class="abnControls">Chọn tất cả <input class="abnDayToggle" data-day="${curDay}" type="checkbox"></label>`;
      html += `</div>`;
      html += `</td></tr>`;
    }

    abnRowInfo.set(row.key, { ts: row.ts, day: row.day, idx });
    const checked = abnChecked.has(row.key) ? "checked" : "";
    const t = fmtTimeFromTs(row.ts);

    html += `<tr>`;
    html += `<td class="abnIdx">${idx}</td>`;
    html += `<td class="abnFile">${row.filename}<div class="meta">${isoToDisplay(row.day)} ${t}</div></td>`;
    html += `<td><input class="abnRowToggle" data-key="${row.key}" type="checkbox" ${checked}></td>`;
    html += `</tr>`;

    idx++;
  }

  html += `</tbody></table>`;

  elAbnList.innerHTML = html;

  // Wire events
  const allToggle = document.getElementById("abnAllToggle");
  if (allToggle) {
    allToggle.checked = abnVisibleKeys.length > 0 && abnVisibleKeys.every((k) => abnChecked.has(k));
    allToggle.addEventListener("change", () => {
      if (allToggle.checked) {
        for (const k of abnVisibleKeys) abnChecked.add(k);
      } else {
        for (const k of abnVisibleKeys) abnChecked.delete(k);
      }
      syncAbnCheckboxes();
      updateAbnLines();
    });
  }

  const dayToggles = [...elAbnList.querySelectorAll(".abnDayToggle")];
  for (const dcb of dayToggles) {
    const day = dcb.dataset.day;
    const keys = dayKeys.get(day) || [];
    dcb.checked = keys.length > 0 && keys.every((k) => abnChecked.has(k));
    dcb.addEventListener("change", () => {
      if (dcb.checked) {
        for (const k of keys) abnChecked.add(k);
      } else {
        for (const k of keys) abnChecked.delete(k);
      }
      syncAbnCheckboxes();
      updateAbnLines();
    });
  }

  const rowToggles = [...elAbnList.querySelectorAll(".abnRowToggle")];
  for (const cb of rowToggles) {
    const key = cb.dataset.key;
    cb.addEventListener("change", () => {
      if (cb.checked) abnChecked.add(key);
      else abnChecked.delete(key);

      // Update group/global toggles states
      if (allToggle) allToggle.checked = abnVisibleKeys.every((k) => abnChecked.has(k));
      for (const dcb of dayToggles) {
        const day = dcb.dataset.day;
        const keys = dayKeys.get(day) || [];
        dcb.checked = keys.length > 0 && keys.every((k) => abnChecked.has(k));
      }

      updateAbnLines();
    });
  }

  updateAbnLines();
}

function syncAbnCheckboxes() {
  // Visible rows
  for (const cb of elAbnList.querySelectorAll(".abnRowToggle")) {
    const key = cb.dataset.key;
    cb.checked = abnChecked.has(key);
  }

  // Global toggle
  const allToggle = document.getElementById("abnAllToggle");
  if (allToggle) allToggle.checked = abnVisibleKeys.length > 0 && abnVisibleKeys.every((k) => abnChecked.has(k));
}

// ====== INIT ======
async function init() {
  buildDateSelector();
  ensureCharts();

  await loadLatest();
  await loadSelected();

  await loadAbn();
  renderAbnTable();

  if (elBtnRef) {
    elBtnRef.addEventListener("click", async () => {
      await loadLatest();
      await loadSelected();
      await loadAbn();
      renderAbnTable();
    });
  }

  // periodic refresh for live widgets (no heavy re-fetch)
  setInterval(() => loadLatest().catch(() => {}), 4000);
}

init();
