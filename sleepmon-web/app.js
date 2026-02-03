/* SleepMon web (Auto update v8)
   Yêu cầu:
   1) Tự động cập nhật khi người dùng đang xem mốc hiện tại (hôm nay + bucket 10 phút hiện tại)
   2) Qua mốc mới (vd 14:26 -> 14:31) tự chuyển sang bucket 14:30
   3) Nếu người dùng xem lịch sử (giờ/phút khác hoặc ngày khác) thì KHÔNG tự cập nhật
   4) Refresh trang -> tự quay về mốc hiện tại và tiếp tục tự cập nhật
*/

const { DateTime } = luxon;

// ===== CHANGE THIS (nếu bạn đổi worker domain) =====
const API_BASE = "https://sleepmon-api.sleepmon.workers.dev";

const TZ = "Asia/Ho_Chi_Minh";
const WINDOW_MIN = 10;
const AUTO_REFRESH_MS = 5000;

// Colors
const SPO2_COLOR = "#e53935";
const RMS_COLOR  = "#3b82f6";

// UI refs
const connPill = document.getElementById("connPill");

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

// Cache day data by dateISO
const dayCache = new Map(); // dateISO -> { dateISO, points:[{ts,spo2,rms,alarmA?}] }

// Selected date (single day)
let selectedDateISO = null;

// Auto-update state
let autoTimer = null;
let pinnedHistory = false;     // true = user đang xem lịch sử -> không auto
let lastBucketKey = null;

function setConn(ok) {
  if (!connPill) return;
  connPill.textContent = ok ? "API: OK" : "API: chưa kết nối";
  connPill.style.color = ok ? "var(--ok)" : "var(--muted)";
}

function hanoiNow() {
  return DateTime.now().setZone(TZ);
}
function isoToday(){
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
      renderDateChips();
      await loadSelectedDayAndRenderByTime(false);
      updatePinnedHistory();
    });
    dateBox.appendChild(b);
  });

  if (modeNote){
    modeNote.textContent = `Đang chọn: ${fmtDayDisp(selectedDateISO)}${selectedDateISO === isoToday() ? " (hôm nay)" : ""}`;
  }
}

function setDayLabels(dateISO){
  const d = fmtDayDisp(dateISO);
  if (spo2DayLabel) spo2DayLabel.textContent = d;
  if (rmsDayLabel)  rmsDayLabel.textContent = d;
}

function baseChartOptions(title, yOverrides = {}){
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
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
        ...yOverrides,
      }
    }
  };
}

function ensureCharts(){
  if (!spo2Chart){
    spo2Chart = new Chart(document.getElementById("spo2Chart"), {
      type: "line",
      data: { datasets: [] },
      options: baseChartOptions("SpO2 (%)", { min: 0, max: 100 }),
    });
  }
  if (!rmsChart){
    rmsChart = new Chart(document.getElementById("rmsChart"), {
      type: "line",
      data: { datasets: [] },
      options: baseChartOptions("Audio RMS", { min: 0 }),
    });
  }
}

function sanitizeValue(key, v){
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (key === "spo2") return Math.max(0, Math.min(100, n));
  if (key === "rms")  return Math.max(0, n);
  return n;
}

function buildDataset(points, key, label, color){
  return {
    label,
    data: points
      .map(p => ({ x: p.ts * 1000, y: sanitizeValue(key, p[key]) }))
      .filter(p => p.y !== null),
    borderColor: color,
    backgroundColor: "transparent",
    borderWidth: 2,
    pointRadius: 0,
    tension: 0.2,
  };
}

function normalizeDayResponse(res, dateISO){
  // A) { ok:true, days: { "YYYY-MM-DD": [ {ts,spo2,rms,...}, ...] } }
  // B) { ok:true, days: [ {date:"YYYY-MM-DD", points:[...]}, ...] }
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

async function fetchDay(dateISO, force=false){
  if (!force && dayCache.has(dateISO)) return dayCache.get(dateISO);
  const q = encodeURIComponent(dateISO);
  const res = await apiGet(`/telemetry/days?dates=${q}`);
  const day = normalizeDayResponse(res, dateISO);
  if (!day || !Array.isArray(day.points)) throw new Error("No day data");
  dayCache.set(dateISO, day);
  return day;
}

function getWindowMs(dateISO, hh, mm){
  const start = DateTime.fromISO(dateISO, { zone: TZ }).startOf("day").plus({ hours: hh, minutes: mm });
  const end   = start.plus({ minutes: WINDOW_MIN });
  return { startMs: start.toMillis(), endMs: end.toMillis(), start, end };
}

function applyWindowToCharts(dateISO, day, hh, mm){
  const { startMs, endMs, start, end } = getWindowMs(dateISO, hh, mm);

  const windowPoints = day.points.filter(p => {
    const t = (p.ts ?? 0) * 1000;
    return t >= startMs && t < endMs;
  });

  spo2Chart.data.datasets = [buildDataset(windowPoints, "spo2", "SpO2 (%)", SPO2_COLOR)];
  rmsChart.data.datasets  = [buildDataset(windowPoints, "rms",  "RMS",      RMS_COLOR)];

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

async function loadSelectedDayAndRenderByTime(force=false){
  ensureCharts();
  try{
    if (!selectedDateISO) selectedDateISO = isoToday();
    const day = await fetchDay(selectedDateISO, force);
    setConn(true);

    const { hh, mm } = getPickedTime();
    applyWindowToCharts(day.dateISO, day, hh, mm);
  }catch(e){
    setConn(false);
    console.error(e);
    spo2Chart.data.datasets = [];
    rmsChart.data.datasets = [];
    spo2Chart.update();
    rmsChart.update();
  }
}

// ===== Auto update logic =====
function getCurrentBucket(){
  const now = hanoiNow();
  const mm = Math.floor(now.minute / WINDOW_MIN) * WINDOW_MIN;
  return { dateISO: isoToday(), hh: now.hour, mm };
}
function makeBucketKey(b){
  return `${b.dateISO} ${pad2(b.hh)}:${pad2(b.mm)}`;
}
function isLiveSelection(){
  const cur = getCurrentBucket();
  const { hh, mm } = getPickedTime();
  return selectedDateISO === cur.dateISO && hh === cur.hh && mm === cur.mm;
}
function updatePinnedHistory(){
  pinnedHistory = !isLiveSelection();
  if (windowNote){
    // thêm trạng thái nhỏ cho người dùng
    const suffix = pinnedHistory ? " • (đang xem lịch sử - không tự cập nhật)" : " • (tự cập nhật)";
    if (!windowNote.textContent.includes("(tự cập nhật)") && !windowNote.textContent.includes("(đang xem lịch sử")){
      windowNote.textContent += suffix;
    } else {
      // thay thế suffix cũ
      windowNote.textContent = windowNote.textContent.replace(/\s•\s\(.+\)$/, "") + suffix;
    }
  }
}

function startAuto(){
  if (autoTimer) clearInterval(autoTimer);
  lastBucketKey = makeBucketKey(getCurrentBucket());
  autoTimer = setInterval(async () => {
    if (pinnedHistory) return;

    const cur = getCurrentBucket();
    const key = makeBucketKey(cur);

    // Nếu user đang ở live selection, tự chuyển bucket khi qua mốc mới
    if (key !== lastBucketKey){
      lastBucketKey = key;
      // chỉ tự nhảy nếu user đang xem live (không pinned)
      selectedDateISO = cur.dateISO;
      renderDateChips();
      setPickedTime(cur.hh, cur.mm);
      await loadSelectedDayAndRenderByTime(true);
      updatePinnedHistory();
      return;
    }

    // Cùng bucket: refresh dữ liệu (force) để cập nhật điểm mới
    if (isLiveSelection()){
      await loadSelectedDayAndRenderByTime(true);
      updatePinnedHistory();
    }
  }, AUTO_REFRESH_MS);
}

// ===== UI events =====
applyTimeBtn?.addEventListener("click", async () => {
  await loadSelectedDayAndRenderByTime(false);
  updatePinnedHistory();
});

hourPick?.addEventListener("change", () => updatePinnedHistory());
minPick?.addEventListener("change", () => updatePinnedHistory());

// ===== INIT =====
(async function init(){
  initTimePick();
  ensureCharts();

  // Default: hôm nay + bucket 10 phút hiện tại
  const cur = getCurrentBucket();
  selectedDateISO = cur.dateISO;
  renderDateChips();
  setPickedTime(cur.hh, cur.mm);

  await loadSelectedDayAndRenderByTime(true);
  updatePinnedHistory();
  startAuto();
})();
