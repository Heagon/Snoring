/* SleepMon web (Time window v7)
   1) Lọc giờ: 0h → 23h, lọc phút mỗi 10p (00p, 10p, 20p...)
   2) 2 biểu đồ hiển thị liên tục theo CỬA SỔ 10 PHÚT.
      Khi qua mốc 10 phút mới, biểu đồ sẽ tự reset sang cửa sổ mới.
   3) Lọc ngày: chỉ hiển thị 7 ngày gần nhất.
*/

const { DateTime } = luxon;

// ===== CHANGE THIS (nếu bạn đổi worker domain) =====
const API_BASE = "https://sleepmon-api.sleepmon.workers.dev";

const TZ = "Asia/Ho_Chi_Minh";
const WINDOW_MIN = 10;

// Colors
const SPO2_COLOR = "#e53935";      // đỏ
const RMS_COLOR  = "#3b82f6";      // xanh dương

// UI refs
const connPill = document.getElementById("connPill");
const livePill = document.getElementById("livePill");
const liveToggle = document.getElementById("liveToggle");
const reloadBtn = document.getElementById("reloadBtn");

const hourPick = document.getElementById("hourPick");
const minPick  = document.getElementById("minPick");
const applyTimeBtn = document.getElementById("applyTimeBtn");
const windowNote = document.getElementById("windowNote");

const dateBox = document.getElementById("dateBox");
const modeNote = document.getElementById("modeNote");

const spo2DayLabel = document.getElementById("spo2DayLabel");
const rmsDayLabel  = document.getElementById("rmsDayLabel");

// Charts
let spo2Chart, rmsChart;

// Live
let liveTimer = null;

// Live bucket tracking (10-minute buckets)
let liveBucketStartMs = null;

// Cache day data by dateISO
const dayCache = new Map(); // dateISO -> { dateISO, points:[{ts,spo2,rms,alarmA?}] }

// Selected date (single day)
let selectedDateISO = null;

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

async function apiGet(path){
  const r = await fetch(API_BASE + path, { method:"GET" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return await r.json();
}

function pad2(n){ return String(n).padStart(2,"0"); }

function initTimePick(){
  if (!hourPick || !minPick) return;

  hourPick.innerHTML = "";
  for (let h=0; h<=23; h++){
    const opt = document.createElement("option");
    opt.value = String(h);
    opt.textContent = `${pad2(h)}h`;
    hourPick.appendChild(opt);
  }

  minPick.innerHTML = "";
  for (let m=0; m<=50; m+=10){
    const opt = document.createElement("option");
    opt.value = String(m);
    opt.textContent = `${pad2(m)}p`;
    minPick.appendChild(opt);
  }

  hourPick.value = "0";
  minPick.value = "0";
}

function setPickedTime(hh, mm){
  if (hourPick) hourPick.value = String(Math.max(0, Math.min(23, Number(hh)||0)));
  if (minPick)  minPick.value  = String(Math.max(0, Math.min(50, Number(mm)||0)));
}

function getPickedTime(){
  const hh = Math.max(0, Math.min(23, Number(hourPick?.value ?? 0)));
  const mm = Math.max(0, Math.min(50, Number(minPick?.value ?? 0)));
  return { hh, mm };
}

function isoToday(){
  return hanoiTodayStr();
}

function isoLastNDays(n){
  const now = hanoiNow().startOf("day");
  const out = [];
  for (let i=0; i<n; i++) out.push(now.minus({ days: i }).toFormat("yyyy-LL-dd"));
  return out;
}

function renderDateChips(){
  if (!dateBox) return;

  const last7 = isoLastNDays(7);
  if (!selectedDateISO) selectedDateISO = last7[0];
  if (!last7.includes(selectedDateISO)) selectedDateISO = last7[0];

  dateBox.innerHTML = "";
  last7.forEach((d) => {
    const b = document.createElement("button");
    b.className = "datechip" + (d === selectedDateISO ? " on" : "");
    b.type = "button";
    b.textContent = fmtDayDisp(d);
    b.title = d;
    b.addEventListener("click", async () => {
      if (selectedDateISO === d) return;
      selectedDateISO = d;

      // Tắt live nếu không phải hôm nay
      if (selectedDateISO !== isoToday() && liveToggle){
        liveToggle.checked = false;
        stopLive();
      }

      renderDateChips();
      await loadSelectedDayAndRenderByTime();
    });
    dateBox.appendChild(b);
  });

  if (modeNote){
    modeNote.textContent = `Đang chọn: ${fmtDayDisp(selectedDateISO)}${selectedDateISO === isoToday() ? " (hôm nay)" : ""}`;
  }
}

function getWindowMs(dateISO, hh, mm){
  const start = DateTime.fromISO(dateISO, { zone: TZ }).startOf("day").plus({ hours: hh, minutes: mm });
  const end   = start.plus({ minutes: WINDOW_MIN });
  return { startMs: start.toMillis(), endMs: end.toMillis(), start, end };
}

function setDayLabels(dateISO){
  const d = fmtDayDisp(dateISO);
  spo2DayLabel.textContent = d;
  rmsDayLabel.textContent = d;
}

function ensureCharts(){
  if (!spo2Chart){
    spo2Chart = new Chart(document.getElementById("spo2Chart"), {
      type: "line",
      data: { datasets: [] },
      options: baseChartOptions("SpO2 (%)"),
    });
  }
  if (!rmsChart){
    rmsChart = new Chart(document.getElementById("rmsChart"), {
      type: "line",
      data: { datasets: [] },
      options: baseChartOptions("Audio RMS"),
    });
  }
}

function baseChartOptions(title){
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { display: true, labels: { color: "#dbe7ff" } },
      title:  { display: false, text: title },
      tooltip: {
        callbacks: {
          label: (ctx) => {
            const v = ctx.parsed?.y;
            return `${ctx.dataset.label}: ${v ?? ""}`;
          }
        }
      }
    },
    scales: {
      x: {
        type: "time",
        adapters: { date: { zone: TZ } },
        time: { unit: "minute" },
        ticks: { color: "#9db4d6" },
        grid: { color: "rgba(157,180,214,0.15)" },
      },
      y: {
        ticks: { color: "#9db4d6" },
        grid: { color: "rgba(157,180,214,0.15)" },
      }
    }
  };
}

function buildDataset(points, key, label, color){
  return {
    label,
    data: points
      .filter(p => p[key] !== null && p[key] !== undefined)
      .map(p => ({ x: p.ts * 1000, y: p[key] })),
    borderColor: color,
    backgroundColor: "transparent",
    borderWidth: 2,
    pointRadius: 0,
    tension: 0.2,
  };
}

function normalizeDayResponse(res, dateISO){
  // Support both formats:
  //  A) { ok:true, days: { "YYYY-MM-DD": [ {ts,spo2,rms,...}, ...] } }
  //  B) { ok:true, days: [ {date:"YYYY-MM-DD", points:[...]}, ...] }
  if (!res) return null;
  const d1 = res?.days;
  if (Array.isArray(d1)){
    const day = d1.find(x => x?.date === dateISO) || d1[0];
    if (day && Array.isArray(day.points)) return { dateISO: day.date || dateISO, points: day.points };
  }
  if (d1 && typeof d1 === "object"){
    const pts = d1[dateISO];
    if (Array.isArray(pts)) return { dateISO, points: pts };
  }
  return null;
}

async function fetchDay(dateISO){
  if (dayCache.has(dateISO)) return dayCache.get(dateISO);
  const q = encodeURIComponent(dateISO);
  const res = await apiGet(`/telemetry/days?dates=${q}`);
  const day = normalizeDayResponse(res, dateISO);
  if (!day || !Array.isArray(day.points)) throw new Error("No day data");
  dayCache.set(dateISO, day);
  return day;
}

function applyWindowToCharts(dateISO, day, hh, mm){
  const { startMs, endMs, start, end } = getWindowMs(dateISO, hh, mm);

  // filter within [start,end)
  const windowPoints = day.points.filter(p => {
    const t = (p.ts ?? 0) * 1000;
    return t >= startMs && t < endMs;
  });

  spo2Chart.data.datasets = [buildDataset(windowPoints, "spo2", "SpO2 (%)", SPO2_COLOR)];
  rmsChart.data.datasets  = [buildDataset(windowPoints, "rms",  "RMS",      RMS_COLOR)];

  // lock x-axis to 10-minute window
  spo2Chart.options.scales.x.min = startMs;
  spo2Chart.options.scales.x.max = endMs;
  rmsChart.options.scales.x.min  = startMs;
  rmsChart.options.scales.x.max  = endMs;

  spo2Chart.update();
  rmsChart.update();

  setDayLabels(dateISO);
  if (windowNote){
    windowNote.textContent = `Đang xem: ${fmtDayDisp(dateISO)} • ${start.toFormat("HH:mm")} → ${end.toFormat("HH:mm")} (${WINDOW_MIN} phút)`;
  }
}

async function loadSelectedDayAndRenderByTime(){
  ensureCharts();

  try{
    if (!selectedDateISO) selectedDateISO = isoToday();
    const day = await fetchDay(selectedDateISO);
    setConn(true);

    const { hh, mm } = getPickedTime();
    applyWindowToCharts(day.dateISO, day, hh, mm);
  }catch(e){
    setConn(false);
    console.error(e);
    // clear charts
    spo2Chart.data.datasets = [];
    rmsChart.data.datasets = [];
    spo2Chart.update();
    rmsChart.update();
  }
}

// ===== Live mode (bucketed 10 minutes) =====
function stopLive(){
  if (liveTimer){
    clearInterval(liveTimer);
    liveTimer = null;
  }
  liveBucketStartMs = null;
  setLivePill(false);
}

function bucketStartEndMs(nowMs){
  const t = DateTime.fromMillis(nowMs, { zone: TZ });
  const bucketMinute = Math.floor(t.minute / WINDOW_MIN) * WINDOW_MIN;
  const start = t.set({ minute: bucketMinute, second: 0, millisecond: 0 });
  const end = start.plus({ minutes: WINDOW_MIN });
  return { startMs: start.toMillis(), endMs: end.toMillis(), start, end };
}

function resetLiveBucket(startMs, endMs, start, end){
  liveBucketStartMs = startMs;
  spo2Chart.data.datasets = [buildDataset([], "spo2", "SpO2 (%)", SPO2_COLOR)];
  rmsChart.data.datasets  = [buildDataset([], "rms",  "RMS",      RMS_COLOR)];

  spo2Chart.options.scales.x.min = startMs;
  spo2Chart.options.scales.x.max = endMs;
  rmsChart.options.scales.x.min  = startMs;
  rmsChart.options.scales.x.max  = endMs;

  spo2Chart.update();
  rmsChart.update();

  if (windowNote){
    windowNote.textContent = `Live: ${start.toFormat("HH:mm")} → ${end.toFormat("HH:mm")} (${WINDOW_MIN} phút)`;
  }

  // Keep date label synced
  setDayLabels(isoToday());
}

async function startLiveBucketedWindow(){
  ensureCharts();
  setLivePill(true);

  // Live luôn đi kèm "hôm nay"
  selectedDateISO = isoToday();
  renderDateChips();

  liveTimer = setInterval(async () => {
    try{
      const res = await apiGet("/telemetry/latest");
      setConn(true);
      const p = res.point;
      if (!p || !p.ts) return;

      const nowMs = p.ts * 1000;
      const { startMs, endMs, start, end } = bucketStartEndMs(nowMs);

      // If crossed into a new 10-minute bucket, reset chart datasets
      if (liveBucketStartMs === null || startMs !== liveBucketStartMs){
        resetLiveBucket(startMs, endMs, start, end);
      }

      // Only accept points that belong to current bucket
      if (nowMs < startMs || nowMs >= endMs) return;

      // push
      const dsSpo2 = spo2Chart.data.datasets[0];
      const dsRms  = rmsChart.data.datasets[0];

      if (p.spo2 !== null && p.spo2 !== undefined){
        dsSpo2.data.push({ x: nowMs, y: p.spo2 });
      }
      if (p.rms !== null && p.rms !== undefined){
        dsRms.data.push({ x: nowMs, y: p.rms });
      }

      // trim (đề phòng dữ liệu cũ)
      dsSpo2.data = dsSpo2.data.filter(pt => pt.x >= startMs && pt.x < endMs);
      dsRms.data  = dsRms.data.filter(pt => pt.x >= startMs && pt.x < endMs);

      spo2Chart.update("none");
      rmsChart.update("none");

      if (windowNote){
        windowNote.textContent = `Live: ${start.toFormat("HH:mm")} → ${end.toFormat("HH:mm")} (${WINDOW_MIN} phút)`;
      }
      setDayLabels(isoToday());
    }catch(e){
      setConn(false);
      console.error(e);
    }
  }, 1000);
}

// ===== UI events =====
applyTimeBtn?.addEventListener("click", async () => {
  if (liveToggle) liveToggle.checked = false;
  stopLive();
  await loadSelectedDayAndRenderByTime();
});

reloadBtn?.addEventListener("click", async () => {
  dayCache.clear();
  if (liveToggle?.checked){
    stopLive();
    startLiveBucketedWindow();
  } else {
    await loadSelectedDayAndRenderByTime();
  }
});

liveToggle?.addEventListener("change", async () => {
  if (liveToggle.checked){
    // Live chỉ cho hôm nay
    selectedDateISO = isoToday();
    renderDateChips();
    stopLive();
    startLiveBucketedWindow();
  } else {
    stopLive();
    await loadSelectedDayAndRenderByTime();
  }
});

// ===== INIT =====
(function init(){
  initTimePick();
  ensureCharts();
  setLivePill(false);
  if (liveToggle) liveToggle.checked = false;

  // Default: chọn cửa sổ theo mốc 10 phút hiện tại
  const now = hanoiNow();
  const mm = Math.floor(now.minute / 10) * 10;
  setPickedTime(now.hour, mm);

  // Date chips (7 ngày gần nhất)
  selectedDateISO = isoToday();
  renderDateChips();

  loadSelectedDayAndRenderByTime();
})();
