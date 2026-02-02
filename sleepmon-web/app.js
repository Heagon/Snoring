function normalizeTo10Minutes(hhmm) {
  // Accepts "HH:MM". Returns snapped down to 10-minute steps.
  if (!hhmm || !/^\d{2}:\d{2}$/.test(hhmm)) return "00:00";
  let [h, m] = hhmm.split(":").map((x) => parseInt(x, 10));
  if (Number.isNaN(h) || Number.isNaN(m)) return "00:00";
  h = Math.max(0, Math.min(23, h));
  m = Math.max(0, Math.min(59, m));
  m = Math.floor(m / 10) * 10; // 0,10,20,30,40,50
  // latest selectable start time (10-min window)
  if (h === 23 && m > 50) m = 50;
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}
/* SleepMon web (Time window)
   Yêu cầu:
   - Bỏ chọn ngày & bảng ngưng thở
   - Chỉ hiển thị cửa sổ 10 phút (mặc định từ 00:00)
   - Có chọn thời điểm (giờ/phút) bằng input type=time
   - Live (tuỳ chọn): hiển thị 10 phút gần nhất (rolling)
*/

const { DateTime } = luxon;

// ===== CHANGE THIS =====
const API_BASE = "https://sleepmon-api.sleepmon.workers.dev";

// UI refs
const connPill = document.getElementById("connPill");
const livePill = document.getElementById("livePill");
const liveToggle = document.getElementById("liveToggle");
const reloadBtn = document.getElementById("reloadBtn");

const applyTimeBtn = document.getElementById("applyTimeBtn");

const hourPick = document.getElementById("hourPick");
const minPick  = document.getElementById("minPick");
const windowNote = document.getElementById("windowNote");

const spo2DayLabel = document.getElementById("spo2DayLabel");
const rmsDayLabel = document.getElementById("rmsDayLabel");

const TZ = "Asia/Ho_Chi_Minh";
const WINDOW_MIN = 10;
const DAY_COLOR = "#e53935";
const RMS_COLOR = "#3b82f6";

let spo2Chart, rmsChart;
let liveTimer = null;
let lastLiveTs = 0;

function setConn(ok) {
  connPill.textContent = ok ? "API: OK" : "API: chưa kết nối";
  connPill.style.color = ok ? "var(--ok)" : "var(--muted)";
}

function setLivePill(on) {
  livePill.textContent = on ? "LIVE: ON" : "LIVE: OFF";
  livePill.style.color = on ? "var(--warn)" : "var(--muted)";
}

function hanoiNow() {
  return DateTime.now().setZone(TZ);
}

function hanoiTodayStr() {
  return hanoiNow().toFormat("yyyy-LL-dd");
}

function fmtDayDisp(isoDate) {
  return DateTime.fromISO(isoDate, { zone: TZ }).toFormat("dd-LL-yyyy");
}

function parseHHMM(v) {
  // v: "HH:MM"
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(v || ""));
  if (!m) return { hh: 0, mm: 0 };
  return { hh: Number(m[1]), mm: Number(m[2]) };
}

function pad2(n){ return String(n).padStart(2,"0"); }

function initTimePick(){
  const hEl = document.getElementById("hourPick");
  const mEl = document.getElementById("minPick");
  if (!hEl || !mEl) return;

  // Hours 00-23
  hEl.innerHTML = "";
  for (let h=0; h<=23; h++){
    const opt = document.createElement("option");
    opt.value = String(h);
    opt.textContent = pad2(h);
    hEl.appendChild(opt);
  }

  // Minutes: 00,10,20,30,40,50
  mEl.innerHTML = "";
  for (let m=0; m<=50; m+=10){
    const opt = document.createElement("option");
    opt.value = String(m);
    opt.textContent = pad2(m);
    mEl.appendChild(opt);
  }

  // Default 00:00
  hEl.value = "0";
  mEl.value = "0";
}

function getPickedTime(){
  const hEl = document.getElementById("hourPick");
  const mEl = document.getElementById("minPick");
  const hh = Math.max(0, Math.min(23, Number(hEl?.value ?? 0)));
  const mmRaw = Number(mEl?.value ?? 0);
  const mm = Math.max(0, Math.min(50, Math.floor(mmRaw / 10) * 10));
  return { hh, mm };
}



function windowRangeMsFromStart(hh, mm) {
  const base = hanoiNow().startOf("day");
  const start = base.plus({ hours: hh, minutes: mm });
  const end = start.plus({ minutes: WINDOW_MIN });
  return { startMs: start.toMillis(), endMs: end.toMillis(), start, end };
}

function updateWindowNoteForHistory(hh, mm) {
  const day = hanoiTodayStr();
  const { start, end } = windowRangeMsFromStart(hh, mm);
  windowNote.textContent = `Đang xem: ${fmtDayDisp(day)} • ${start.toFormat("HH:mm")} → ${end.toFormat("HH:mm")} (10 phút)`;
  spo2DayLabel.textContent = `Ngày: ${fmtDayDisp(day)}`;
  rmsDayLabel.textContent = `Ngày: ${fmtDayDisp(day)}`;
}

function updateWindowNoteForLive() {
  windowNote.textContent = `Live: hiển thị 10 phút gần nhất (rolling)`;
  spo2DayLabel.textContent = `Ngày: ${fmtDayDisp(hanoiTodayStr())}`;
  rmsDayLabel.textContent = `Ngày: ${fmtDayDisp(hanoiTodayStr())}`;
}

function ensureCharts() {
  const common = () => ({
    responsive: true,
    animation: false,
    parsing: false,
    scales: {
      x: {
        type: "time",
        adapters: { date: { zone: TZ } },
        time: { unit: "minute" },
        ticks: { color: "#9fb0c3" },
        grid: { color: "#22314a" }
      },
      y: {
        ticks: { color: "#9fb0c3" },
        grid: { color: "#22314a" }
      }
    },
    plugins: {
      legend: { labels: { color: "#e8eef7" } }
    }
  });

  if (!spo2Chart) {
    const ctx = document.getElementById("spo2Chart").getContext("2d");
    spo2Chart = new Chart(ctx, { type: "line", data: { datasets: [] }, options: common() });
    spo2Chart.options.scales.y.suggestedMin = 70;
    spo2Chart.options.scales.y.suggestedMax = 100;
  }

  if (!rmsChart) {
    const ctx2 = document.getElementById("rmsChart").getContext("2d");
    rmsChart = new Chart(ctx2, { type: "line", data: { datasets: [] }, options: common() });
    rmsChart.options.scales.y.suggestedMin = 0;
  }
}

async function apiGet(path) {
  const r = await fetch(API_BASE + path, { method: "GET" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return await r.json();
}

function normalizeY(field, value) {
  let y = value;
  if (y === undefined || y === null) return null;
  if (typeof y !== "number") y = Number(y);
  if (!Number.isFinite(y)) return null;

  if (field === "spo2") {
    if (y < 70 || y > 100) return null;
  }
  if (field === "rms") {
    if (y <= 0) return null;
  }
  return y;
}

function buildDataset(points, field, label, color, startMs, endMs) {
  const arr = (points || []).slice().sort((a, b) => a.ts - b.ts);

  const GAP_BREAK_SEC = 3;
  const out = [];
  let lastTs = null;

  for (const p of arr) {
    const xMs = (p.ts || 0) * 1000;
    if (xMs < startMs || xMs > endMs) continue;

    if (lastTs !== null && (p.ts - lastTs) > GAP_BREAK_SEC) {
      out.push({ x: (lastTs + 1) * 1000, y: null });
    }

    const y = normalizeY(field, p[field]);
    out.push({ x: xMs, y });
    lastTs = p.ts;
  }

  return {
    label,
    data: out,
    pointRadius: 0,
    borderWidth: 2,
    borderColor: color,
    tension: 0.15,
    spanGaps: false
  };
}

function applyWindowToCharts(points, startMs, endMs) {
  spo2Chart.options.scales.x.min = startMs;
  spo2Chart.options.scales.x.max = endMs;
  rmsChart.options.scales.x.min = startMs;
  rmsChart.options.scales.x.max = endMs;

  spo2Chart.data.datasets = [buildDataset(points, "spo2", "SpO2 (%)", DAY_COLOR, startMs, endMs)];
  rmsChart.data.datasets = [buildDataset(points, "rms", "RMS", RMS_COLOR, startMs, endMs)];

  spo2Chart.update();
  rmsChart.update();
}

async function loadTodayAndRenderByTime() {
  ensureCharts();

  const { hh, mm } = getPickedTime();
  updateWindowNoteForHistory(hh, mm);

  const { startMs, endMs } = windowRangeMsFromStart(hh, mm);

  try {
    const today = hanoiTodayStr();
    const q = encodeURIComponent(today);
    const res = await apiGet(`/telemetry/days?dates=${q}`);
    setConn(true);

    const points = (res && res.days && res.days[today]) ? res.days[today] : [];
    applyWindowToCharts(points, startMs, endMs);
  } catch (e) {
    setConn(false);
    console.error(e);
    spo2Chart.data.datasets = [];
    rmsChart.data.datasets = [];
    spo2Chart.update();
    rmsChart.update();
  }
}

function stopLive() {
  if (liveTimer) {
    clearInterval(liveTimer);
    liveTimer = null;
  }
  setLivePill(false);
}

function startLiveRollingWindow() {
  ensureCharts();
  updateWindowNoteForLive();

  // Reset datasets
  spo2Chart.data.datasets = [{
    label: "SpO2 (%)",
    data: [],
    pointRadius: 0,
    borderWidth: 2,
    borderColor: DAY_COLOR,
    tension: 0.15,
    spanGaps: false
  }];
  rmsChart.data.datasets = [{
    label: "RMS",
    data: [],
    pointRadius: 0,
    borderWidth: 2,
    borderColor: RMS_COLOR,
    tension: 0.15,
    spanGaps: false
  }];

  lastLiveTs = 0;

  liveTimer = setInterval(async () => {
    try {
      const res = await apiGet("/telemetry/latest");
      setConn(true);

      const p = res && res.point;
      if (!p || !p.ts) return;
      if (p.ts <= lastLiveTs) return;
      lastLiveTs = p.ts;

      const xMs = p.ts * 1000;

      const dsSpo2 = spo2Chart.data.datasets[0];
      const dsRms = rmsChart.data.datasets[0];

      const ySpo2 = normalizeY("spo2", p.spo2);
      const yRms = normalizeY("rms", p.rms);

      dsSpo2.data.push({ x: xMs, y: ySpo2 });
      dsRms.data.push({ x: xMs, y: yRms });

      const nowMs = Date.now();
      const cutoff = nowMs - WINDOW_MIN * 60 * 1000;

      dsSpo2.data = dsSpo2.data.filter(pt => pt.x >= cutoff);
      dsRms.data = dsRms.data.filter(pt => pt.x >= cutoff);

      // Lock x-axis to rolling window
      spo2Chart.options.scales.x.min = cutoff;
      spo2Chart.options.scales.x.max = nowMs;
      rmsChart.options.scales.x.min = cutoff;
      rmsChart.options.scales.x.max = nowMs;

      spo2Chart.update("none");
      rmsChart.update("none");
    } catch (e) {
      setConn(false);
    }
  }, 1000);

  setLivePill(true);
}

// ===== UI events =====

applyTimeBtn?.addEventListener("click", async () => {
  // Khi áp dụng lịch sử, tự tắt Live
  if (liveToggle) liveToggle.checked = false;
  stopLive();
  await loadTodayAndRenderByTime();
});

hourPick?.addEventListener("change", async () => {
  if (liveToggle?.checked) return;
  await loadTodayAndRenderByTime();
});

minPick?.addEventListener("change", async () => {
  if (liveToggle?.checked) return;
  await loadTodayAndRenderByTime();
});

  await loadTodayAndRenderByTime();
});
});

reloadBtn?.addEventListener("click", async () => {
  if (liveToggle.checked) {
    // Live: reset lại window
    stopLive();
    startLiveRollingWindow();
  } else {
    await loadTodayAndRenderByTime();
  }
});

liveToggle?.addEventListener("change", async () => {
  if (liveToggle.checked) {
    // Live: bỏ chọn thời điểm, dùng rolling window
    stopLive();
    startLiveRollingWindow();
  } else {
    stopLive();
    await loadTodayAndRenderByTime();
  }
});

applyTimeBtn.addEventListener("click", async () => {
  stopLive();
  if (liveToggle) liveToggle.checked = false;
  await loadTodayAndRenderByTime();
});
});


// ===== INIT =====
(async function init() {
  initTimePick(); // populate hour/min options (00-23, 00-50 step 10)
  ensureCharts();
  if (liveToggle) liveToggle.checked = false;
  stopLive();
  await loadTodayAndRenderByTime();
})();

