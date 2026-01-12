/* SleepMon web (public viewer)
   - Live view: only when selecting exactly 1 day == today (Hanoi) and Live is ON
   - Multi-day compare: select multiple days -> Live auto OFF
*/

const { DateTime } = luxon;

// ===== CHANGE THIS =====
const API_BASE = "https://sleepmon-api.sleepmon.workers.dev";

// UI refs
const connPill = document.getElementById("connPill");
const livePill = document.getElementById("livePill");
const dateBox  = document.getElementById("dateBox");
const modeNote = document.getElementById("modeNote");
const liveToggle = document.getElementById("liveToggle");
const reloadBtn  = document.getElementById("reloadBtn");

const spo2DayLabel = document.getElementById("spo2DayLabel");
const rmsDayLabel  = document.getElementById("rmsDayLabel");

const abnList = document.getElementById("abnList");

const TZ = "Asia/Ho_Chi_Minh";

let selectedDates = []; // ["YYYY-MM-DD", ...]
let liveTimer = null;
let lastLiveTs = 0;

// Abnormal cache (tối đa 7 ngày trên cloud)
let abnAllItems = [];

function fmtDayDisp(isoDate){
  // isoDate: YYYY-MM-DD
  return DateTime.fromISO(isoDate, { zone: TZ }).toFormat("dd-LL-yyyy");
}

// Charts
let spo2Chart, rmsChart;

function hanoiTodayStr(){
  return DateTime.now().setZone(TZ).toFormat("yyyy-LL-dd");
}

function last7Dates(){
  const now = DateTime.now().setZone(TZ).startOf("day");
  const out = [];
  for (let i=0;i<7;i++){
    out.push(now.minus({days:i}).toFormat("yyyy-LL-dd"));
  }
  return out;
}

function setConn(ok){
  connPill.textContent = ok ? "API: OK" : "API: chưa kết nối";
  connPill.style.color = ok ? "var(--ok)" : "var(--muted)";
}

function setLivePill(on){
  livePill.textContent = on ? "LIVE: ON" : "LIVE: OFF";
  livePill.style.color = on ? "var(--warn)" : "var(--muted)";
}

function selectionLabel(){
  if (selectedDates.length === 0) return "Chưa chọn ngày";
  if (selectedDates.length === 1) return "Ngày: " + fmtDayDisp(selectedDates[0]);
  return "Ngày: " + selectedDates.map(fmtDayDisp).join(", ");
}

function ensureCharts(){
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

  if (!spo2Chart){
    const ctx = document.getElementById("spo2Chart").getContext("2d");
    spo2Chart = new Chart(ctx, { type:"line", data:{datasets:[]}, options: common() });
    spo2Chart.options.scales.y.suggestedMin = 70;
    spo2Chart.options.scales.y.suggestedMax = 100;
  }
  if (!rmsChart){
    const ctx2 = document.getElementById("rmsChart").getContext("2d");
    rmsChart = new Chart(ctx2, { type:"line", data:{datasets:[]}, options: common() });
    rmsChart.options.scales.y.suggestedMin = 0;
  }
}

async function apiGet(path){
  const r = await fetch(API_BASE + path, { method:"GET" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return await r.json();
}

function stopLive(){
  if (liveTimer){ clearInterval(liveTimer); liveTimer = null; }
  setLivePill(false);
}

function canLive(){
  const today = hanoiTodayStr();
  return selectedDates.length === 1 && selectedDates[0] === today;
}

function updateModeNote(){
  if (selectedDates.length === 0){
    modeNote.textContent = "Chọn 1 ngày để xem lịch sử, hoặc chọn hôm nay để bật Live.";
  } else if (selectedDates.length === 1){
    if (canLive()){
      modeNote.textContent = "Bạn có thể bật Live để xem dữ liệu trực tiếp (1s/điểm).";
    } else {
      modeNote.textContent = "Đang xem lịch sử theo ngày đã chọn (Live không áp dụng).";
    }
  } else {
    modeNote.textContent = "Đang so sánh nhiều ngày (Live bị tắt).";
  }
}

function renderDateSelector(){
  const dates = last7Dates();
  const today = hanoiTodayStr();

  dateBox.innerHTML = "";
  dates.forEach(d => {
    const chip = document.createElement("label");
    chip.className = "datechip";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = selectedDates.includes(d);
    cb.addEventListener("change", () => {
      if (cb.checked){
        selectedDates.push(d);
      } else {
        selectedDates = selectedDates.filter(x => x !== d);
      }

      selectedDates.sort((a,b)=> (a<b?1:-1));

      if (selectedDates.length !== 1 || !canLive()){
        liveToggle.checked = false;
        stopLive();
      }

      updateModeNote();
      // Abnormal list luôn lọc theo ngày đang chọn
      renderAbnFiltered();
      loadSelected();
    });

    const span = document.createElement("span");
    const dDisp = fmtDayDisp(d);
    span.textContent = (d === today) ? (dDisp + " (Hôm nay)") : dDisp;

    chip.appendChild(cb);
    chip.appendChild(span);
    dateBox.appendChild(chip);
  });

  updateModeNote();
}

function setDayLabels(){
  const label = selectionLabel();
  spo2DayLabel.textContent = label;
  rmsDayLabel.textContent  = label;
}

const PALETTE_SPO2 = [
  "#e53935", "#d32f2f", "#c62828", "#b71c1c", "#ff5252", "#ff1744", "#f44336"
];
const PALETTE_RMS = [
  "#1565c0", "#1e88e5", "#42a5f5", "#0d47a1", "#64b5f6", "#90caf9", "#2196f3"
];

function datasetsFromDays(daysObj, field, unitLabel, palette){
  const datasets = [];
  selectedDates.forEach((d, idx) => {
    const arr = daysObj[d] || [];
    const data = arr
      .filter(p => p[field] !== null && p[field] !== undefined)
      .map(p => ({ x: p.ts * 1000, y: p[field] }));

    const color = (palette && palette.length) ? palette[idx % palette.length] : undefined;

    datasets.push({
      label: fmtDayDisp(d) + " " + unitLabel,
      data,
      pointRadius: 0,
      borderWidth: 2,
      borderColor: color,
      tension: 0.15
    });
  });
  return datasets;
}

async function loadSelected(){
  ensureCharts();
  setDayLabels();

  if (selectedDates.length === 0){
    spo2Chart.data.datasets = [];
    rmsChart.data.datasets = [];
    spo2Chart.update();
    rmsChart.update();
    return;
  }

  try{
    const q = encodeURIComponent(selectedDates.join(","));
    const res = await apiGet(`/telemetry/days?dates=${q}`);
    setConn(true);

    spo2Chart.data.datasets = datasetsFromDays(res.days, "spo2", "(%)", PALETTE_SPO2);
    rmsChart.data.datasets  = datasetsFromDays(res.days, "rms", "(RMS)", PALETTE_RMS);

    spo2Chart.update();
    rmsChart.update();
  }catch(e){
    setConn(false);
    console.error(e);
  }
}

async function loadTodayThenLive(){
  const today = hanoiTodayStr();
  selectedDates = [today];
  renderDateSelector();
  await loadSelected();

  lastLiveTs = 0;
  stopLive();
  liveTimer = setInterval(async () => {
    try{
      const res = await apiGet("/telemetry/latest");
      setConn(true);
      const p = res.point;
      if (!p) return;

      if (p.ts && p.ts <= lastLiveTs) return;
      lastLiveTs = p.ts;

      if (spo2Chart.data.datasets.length === 0){
        await loadSelected();
      }
      const dsSpo2 = spo2Chart.data.datasets[0];
      const dsRms  = rmsChart.data.datasets[0];
      if (!dsSpo2 || !dsRms) return;

      if (p.spo2 !== null && p.spo2 !== undefined){
        dsSpo2.data.push({ x: p.ts * 1000, y: p.spo2 });
      }
      if (p.rms !== null && p.rms !== undefined){
        dsRms.data.push({ x: p.ts * 1000, y: p.rms });
      }

      const cutoff = Date.now() - 6 * 3600 * 1000;
      dsSpo2.data = dsSpo2.data.filter(pt => pt.x >= cutoff);
      dsRms.data  = dsRms.data.filter(pt => pt.x >= cutoff);

      spo2Chart.update("none");
      rmsChart.update("none");
    }catch(e){
      setConn(false);
    }
  }, 1000);

  setLivePill(true);
}

liveToggle.addEventListener("change", async () => {
  if (liveToggle.checked){
    if (!canLive()){
      liveToggle.checked = false;
      alert("Muốn bật Live: chỉ chọn đúng 1 ngày và phải là hôm nay (Hà Nội).");
      return;
    }
    await loadTodayThenLive();
  } else {
    stopLive();
    await loadSelected();
  }
});

reloadBtn.addEventListener("click", async () => {
  stopLive();
  await loadSelected();
});

// Abnormal list
function fmtHanoi(ts){
  return DateTime.fromSeconds(ts).setZone(TZ).toFormat("dd-LL-yyyy HH:mm:ss");
}

function renderAbn(items){
  abnList.innerHTML = "";
  if (!items || items.length === 0){
    abnList.textContent = "Không có file abnormal trong khoảng thời gian đã chọn.";
    return;
  }
  items.forEach(it => {
    const div = document.createElement("div");
    div.className = "item";

    const left = document.createElement("div");
    const title = document.createElement("div");
    title.innerHTML = `<strong>${it.filename}</strong>`;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${fmtHanoi(it.ts)} • ${(it.size_bytes/1024).toFixed(1)} KB`;
    left.appendChild(title);
    left.appendChild(meta);

    const right = document.createElement("div");
    const a = document.createElement("a");
    a.href = API_BASE + "/abnormal/get?key=" + encodeURIComponent(it.r2_key);
    a.target = "_blank";
    a.textContent = "Mở / Tải";
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.src = a.href;
    audio.preload = "none";
    audio.style.width = "260px";
    right.appendChild(a);
    right.appendChild(document.createElement("div")).style.height = "6px";
    right.appendChild(audio);

    div.appendChild(left);
    div.appendChild(right);
    abnList.appendChild(div);
  });
}

function dayIsoFromTs(ts){
  try{
    return DateTime.fromSeconds(ts).setZone(TZ).toISODate();
  }catch(_){
    return "";
  }
}

function renderAbnFiltered(){
  const pick = new Set(selectedDates);
  const items = (abnAllItems || []).filter(it => pick.has(dayIsoFromTs(it.ts)));
  renderAbn(items);
}

async function loadAbn(){
  try{
    const res = await apiGet(`/abnormal/list?days=7`);
    setConn(true);
    abnAllItems = res.items || [];
    renderAbnFiltered();
  }catch(e){
    setConn(false);
    abnList.textContent = "Lỗi tải danh sách abnormal.";
  }
}

// init
(async function init(){
  ensureCharts();

  selectedDates = [hanoiTodayStr()];
  renderDateSelector();
  await loadSelected();
  await loadAbn();
})();
