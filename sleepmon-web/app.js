/* SleepMon web (public viewer)
   - Live view: only when selecting exactly 1 day == today (Hanoi) and Live is ON
   - Multi-day compare: select multiple days -> Live auto OFF
*/

const { DateTime } = luxon;

// ===== CHANGE THIS =====
const API_BASE = "https://sleepmon-api.YOURNAME.workers.dev";

// UI refs
const connPill = document.getElementById("connPill");
const livePill = document.getElementById("livePill");
const dateBox  = document.getElementById("dateBox");
const modeNote = document.getElementById("modeNote");
const liveToggle = document.getElementById("liveToggle");
const reloadBtn  = document.getElementById("reloadBtn");

const spo2DayLabel = document.getElementById("spo2DayLabel");
const rmsDayLabel  = document.getElementById("rmsDayLabel");

const abnTbody = document.getElementById("abnTbody");
const abnCheckAll = document.getElementById("abnCheckAll");
const abnEmpty = document.getElementById("abnEmpty");

const TZ = "Asia/Ho_Chi_Minh";

let selectedDates = []; // ["YYYY-MM-DD", ...]
let liveTimer = null;
let lastLiveTs = 0;
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

const AbnMarkersPlugin = {
  id: "abnMarkers",
  afterDatasetsDraw(chart, _args, opts){
    const markers = (opts && opts.markers) ? opts.markers : [];
    if (!markers || !markers.length) return;
    const xScale = chart.scales.x;
    if (!xScale) return;
    const area = chart.chartArea;
    const ctx = chart.ctx;

    ctx.save();
    for (const m of markers){
      const px = xScale.getPixelForValue(m.x);
      if (!Number.isFinite(px)) continue;
      const color = m.color || "#ffffff";

      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.setLineDash([5,4]);
      ctx.beginPath();
      ctx.moveTo(px, area.top);
      ctx.lineTo(px, area.bottom);
      ctx.stroke();
      ctx.setLineDash([]);

      if (m.label){
        ctx.fillStyle = color;
        ctx.font = "12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillText(String(m.label), px + 2, area.top + 2);
      }
    }
    ctx.restore();
  }
};

if (typeof Chart !== "undefined" && Chart && typeof Chart.register === "function") {
  Chart.register(AbnMarkersPlugin);
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
      legend: { labels: { color: "#e8eef7" } },
      abnMarkers: { markers: [] }
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


async function apiGetArrayBuffer(path){
  const r = await fetch(API_BASE + path, { method:"GET" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return await r.arrayBuffer();
}

function toWavFilename(name){
  if (!name) return "abnormal.wav";
  let out = name.replace(/\.(sma|adpcm|bin)$/i, ".wav");
  if (!out.toLowerCase().endsWith(".wav")) out = out + ".wav";
  return out;
}

function isRiffWav(u8){
  if (u8.length < 12) return false;
  return u8[0]===0x52 && u8[1]===0x49 && u8[2]===0x46 && u8[3]===0x46 && // RIFF
         u8[8]===0x57 && u8[9]===0x41 && u8[10]===0x56 && u8[11]===0x45;   // WAVE
}

// IMA-ADPCM tables (must match ESP32 encoder)
const IMA_STEP_TABLE = [
  7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,60,66,73,80,88,
  97,107,118,130,143,157,173,190,209,230,253,279,307,337,371,408,449,494,544,598,658,
  724,796,876,963,1060,1166,1282,1411,1552,1707,1878,2066,2272,2499,2749,3024,3327,
  3660,4026,4428,4871,5358,5894,6484,7132,7845,8630,9493,10442,11487,12635,13899,
  15289,16818,18500,20350,22385,24623,27086,29794,32767
];
const IMA_INDEX_TABLE = [-1,-1,-1,-1, 2,4,6,8, -1,-1,-1,-1, 2,4,6,8];

function clamp16(v){
  if (v > 32767) return 32767;
  if (v < -32768) return -32768;
  return v|0;
}

function decodeImaNibble(code, state){
  // state: { predictor, index }
  let step = IMA_STEP_TABLE[state.index];
  let diff = step >> 3;
  if (code & 1) diff += step >> 2;
  if (code & 2) diff += step >> 1;
  if (code & 4) diff += step;

  if (code & 8) state.predictor -= diff;
  else state.predictor += diff;
  state.predictor = clamp16(state.predictor);

  state.index += IMA_INDEX_TABLE[code & 0x0F];
  if (state.index < 0) state.index = 0;
  if (state.index > 88) state.index = 88;

  return state.predictor;
}

function sma1DecodeToPcm16(arrayBuffer){
  const u8 = new Uint8Array(arrayBuffer);
  if (u8.length < 64) return null;

  // "SMA1"
  if (!(u8[0]===0x53 && u8[1]===0x4D && u8[2]===0x41 && u8[3]===0x31)) return null;

  const dv = new DataView(arrayBuffer);
  const headerSize = dv.getUint32(4, true);
  const sampleRate = dv.getUint32(8, true);
  const blockSamples = dv.getUint32(12, true);
  const totalSamples = dv.getUint32(16, true);
  const startEpoch = dv.getUint32(20, true);
  const dataBytes = dv.getUint32(24, true);

  const blockBytes = 4 + (blockSamples / 2); // matches ESP: predictor(2)+index(1)+res(1)+payload
  let off = headerSize;
  const maxDataEnd = Math.min(u8.length, headerSize + dataBytes);

  const out = new Int16Array(totalSamples);
  let outPos = 0;

  while (off + 4 <= maxDataEnd && outPos < totalSamples){
    const predictor = new DataView(arrayBuffer, off, 2).getInt16(0, true);
    const index = u8[off+2] & 0xFF;
    // off+3 reserved
    off += 4;

    const state = { predictor, index: Math.min(88, index) };
    // first sample of block
    out[outPos++] = state.predictor;

    const nibblesNeeded = Math.min(blockSamples - 1, totalSamples - outPos);
    // read bytes containing packed nibbles
    const bytesNeeded = Math.ceil(nibblesNeeded / 2);
    const payloadEnd = Math.min(maxDataEnd, off + (blockBytes - 4));
    const payloadAvail = Math.max(0, payloadEnd - off);
    const bytesToRead = Math.min(bytesNeeded, payloadAvail);

    for (let bi = 0; bi < bytesToRead && outPos < totalSamples; bi++){
      const b = u8[off + bi];
      // low nibble then high nibble (matches encoder packing)
      const lo = b & 0x0F;
      out[outPos++] = decodeImaNibble(lo, state);
      if (outPos >= totalSamples) break;
      if ((bi*2 + 1) >= nibblesNeeded) break;
      const hi = (b >> 4) & 0x0F;
      out[outPos++] = decodeImaNibble(hi, state);
    }

    // move to next block boundary (fixed size)
    off = (off - 0) + (blockBytes - 4);
  }

  return { pcm: out, sampleRate, startEpoch };
}

function pcm16ToWavBlob(pcm16, sampleRate){
  const dataBytes = pcm16.length * 2;
  const header = new ArrayBuffer(44);
  const dv = new DataView(header);

  function writeFourCC(off, s){
    dv.setUint8(off+0, s.charCodeAt(0));
    dv.setUint8(off+1, s.charCodeAt(1));
    dv.setUint8(off+2, s.charCodeAt(2));
    dv.setUint8(off+3, s.charCodeAt(3));
  }

  writeFourCC(0, "RIFF");
  dv.setUint32(4, 36 + dataBytes, true);
  writeFourCC(8, "WAVE");

  writeFourCC(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);   // PCM
  dv.setUint16(22, 1, true);   // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true); // byte rate
  dv.setUint16(32, 2, true);   // block align
  dv.setUint16(34, 16, true);  // bits

  writeFourCC(36, "data");
  dv.setUint32(40, dataBytes, true);

  return new Blob([header, pcm16.buffer], { type: "audio/wav" });
}

async function getOrDecodeWav(it){
  const key = it.r2_key || it.key || it.r2Key || it.r2 || "";
  if (!key) throw new Error("Missing key");
  if (wavCache.has(key)) return wavCache.get(key);

  const ab = await apiGetArrayBuffer(`/abnormal/get?key=${encodeURIComponent(key)}`);
  const u8 = new Uint8Array(ab);

  let blob = null;
  // If already WAV (RIFF), just use it
  if (isRiffWav(u8)) {
    blob = new Blob([ab], { type: "audio/wav" });
  } else {
    const decoded = sma1DecodeToPcm16(ab);
    if (decoded && decoded.pcm) {
      blob = pcm16ToWavBlob(decoded.pcm, decoded.sampleRate || 16000);
    } else {
      // Unknown; still make a blob so user can download/open
      blob = new Blob([ab], { type: "application/octet-stream" });
    }
  }

  const url = URL.createObjectURL(blob);
  const entry = { url, blob, key };
  wavCache.set(key, entry);
  return entry;
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
    chip.style.setProperty("--day-color", colorForDay(d));
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

const DAY_COLORS_BY_OFFSET = [
  "#e53935", // hôm nay / live: đỏ
  "#43a047", // hôm qua: xanh lá
  "#1e88e5", // 2 ngày trước: xanh dương
  "#fdd835", // 3 ngày trước: vàng
  "#8e24aa", // 4 ngày trước: tím
  "#fb8c00", // 5 ngày trước: cam
  "#d81b60"  // 6 ngày trước: hồng
];

function colorForDay(dayIso){
  // dayIso: YYYY-MM-DD
  const today = DateTime.now().setZone(TZ).startOf("day");
  const d = DateTime.fromISO(dayIso).startOf("day");
  const diff = Math.round(today.diff(d, "days").days); // 0..6 trong phạm vi 7 ngày gần nhất
  if (diff >= 0 && diff < DAY_COLORS_BY_OFFSET.length){
    return DAY_COLORS_BY_OFFSET[diff];
  }
  // fallback (ngoài phạm vi)
  return "#90a4ae";
}

function datasetsFromDays(daysObj, field, unitLabel){
  const datasets = [];

  // Telemetry is expected to arrive roughly once per second.
  // If there's a gap (device offline / WiFi drop / reboot...), break the line
  // by inserting a single null point right after the last seen timestamp.
  const GAP_BREAK_SEC = 3;

  selectedDates.forEach((d) => {
    const arr = (daysObj[d] || []).slice().sort((a,b) => a.ts - b.ts);

    const out = [];
    let lastTs = null;
    for (const p of arr){
      if (lastTs !== null && (p.ts - lastTs) > GAP_BREAK_SEC){
        // Insert a null point to force a visual break.
        out.push({ x: (lastTs + 1) * 1000, y: null });
      }
      // Normalize values: missing/invalid -> null so we DON'T draw confusing connecting lines.
      let y = (p[field] === undefined ? null : p[field]);
      if (y !== null){
        // API sometimes returns 0 (or negative) for missing points; treat as gap.
        if (typeof y !== 'number') y = Number(y);

        if (field === 'spo2'){
          // SpO2 outside physiological range should be treated as missing.
          if (!Number.isFinite(y) || y < 70 || y > 100) y = null;
        } else if (field === 'rms'){
          if (!Number.isFinite(y) || y <= 0) y = null;
        } else {
          if (!Number.isFinite(y)) y = null;
        }
      }
      out.push({ x: p.ts * 1000, y });
      lastTs = p.ts;
    }

    const color = colorForDay(d);

    datasets.push({
      label: fmtDayDisp(d) + " " + unitLabel,
      data: out,
      pointRadius: 0,
      borderWidth: 2,
      borderColor: color,
      tension: 0.15,
      spanGaps: false
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

    spo2Chart.data.datasets = datasetsFromDays(res.days, "spo2", "(%)");
    rmsChart.data.datasets  = datasetsFromDays(res.days, "rms", "(RMS)");

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

/* ================= ABNORMAL MARKERS (table + chart vertical lines) ================= */

let abnAllItems = [];
let abnVisibleItems = [];
let abnSelectedKeys = new Set();

function dayIsoFromTs(ts){
  try { return DateTime.fromSeconds(ts).setZone(TZ).toISODate(); } catch(_) { return ""; }
}

function abnKey(it){
  if (it && it.key) return String(it.key);
  const d = (it && it.day) ? String(it.day) : dayIsoFromTs(it.ts||0);
  const fn = (it && it.filename) ? String(it.filename) : "";
  const ts = (it && it.ts) ? String(it.ts) : "";
  return d + "|" + fn + "|" + ts;
}

function updateAbnCheckAllState(){
  if (!abnCheckAll) return;
  const total = abnVisibleItems.length;
  let sel = 0;
  for (const it of abnVisibleItems) {
    if (abnSelectedKeys.has(abnKey(it))) sel++;
  }
  abnCheckAll.indeterminate = (sel > 0 && sel < total);
  abnCheckAll.checked = (total > 0 && sel === total);
}

function setAbnMarkersFromSelection(){
  if (!spo2Chart || !rmsChart) return;
  const markers = [];
  for (let i = 0; i < abnVisibleItems.length; i++) {
    const it = abnVisibleItems[i];
    const k = abnKey(it);
    if (!abnSelectedKeys.has(k)) continue;
    // Marker line style requirement: dashed WHITE line.
    // Keep x in **epoch seconds** (plugin multiplies by 1000 for Chart.js time scale).
    markers.push({ x: it.ts, label: String(i + 1), color: "#fff" });
  }
  spo2Chart.options.plugins.abnMarkers.markers = markers;
  rmsChart.options.plugins.abnMarkers.markers = markers;
  spo2Chart.update("none");
  rmsChart.update("none");
}

function renderAbnTable(items){
  abnSelectedKeys = new Set();
  abnVisibleItems = items || [];

  if (abnTbody) abnTbody.innerHTML = "";
  if (abnEmpty) abnEmpty.textContent = "";

  if (!abnVisibleItems.length) {
    if (abnEmpty) abnEmpty.textContent = "Không có mốc ngưng thở trong ngày đã chọn.";
    updateAbnCheckAllState();
    setAbnMarkersFromSelection();
    return;
  }

  const frag = document.createDocumentFragment();
  abnVisibleItems.forEach((it, idx) => {
    const tr = document.createElement("tr");

    const tdIdx = document.createElement("td");
    tdIdx.className = "colIdx";
    tdIdx.textContent = String(idx + 1);

    const tdName = document.createElement("td");
    const file = document.createElement("div");
    file.className = "abnFile";
    file.textContent = it.filename || "(no name)";
    const meta = document.createElement("div");
    meta.className = "abnMeta";
    const tm = DateTime.fromSeconds(it.ts).setZone(TZ).toFormat("HH:mm:ss");
    const day = it.day || dayIsoFromTs(it.ts||0);
    meta.textContent = `${tm} (${day})`;
    tdName.appendChild(file);
    tdName.appendChild(meta);

    const tdPick = document.createElement("td");
    tdPick.className = "colPick";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "abnPick";
    cb.dataset.key = abnKey(it);
    tdPick.appendChild(cb);

    tr.appendChild(tdIdx);
    tr.appendChild(tdName);
    tr.appendChild(tdPick);
    frag.appendChild(tr);
  });

  if (abnTbody) abnTbody.appendChild(frag);
  updateAbnCheckAllState();
  setAbnMarkersFromSelection();
}

function renderAbnFiltered(){
  const pick = new Set(selectedDates);
  // For the apnea-marker list, only allow filtering by ONE day (to avoid confusion).
  if (pick.size !== 1) {
    if (abnTbody) abnTbody.innerHTML = "";
    abnVisibleItems = [];
    abnSelectedKeys.clear();
    if (abnCheckAll) abnCheckAll.checked = false;
    if (abnEmpty) abnEmpty.textContent = "Để lọc và đánh dấu mốc ngưng thở, hãy chọn đúng 1 ngày ở phía trên.";
    setAbnMarkersFromSelection();
    return;
  }

  const [dayOnly] = Array.from(pick);
  const items = (abnAllItems || [])
    .map(it => ({ ...it, day: it.day || dayIsoFromTs(it.ts||0) }))
    .filter(it => it.day === dayOnly)
    .sort((a, b) => (a.ts || 0) - (b.ts || 0));
  renderAbnTable(items);
}

async function loadAbn(){
  try {
    const res = await apiGet(`/abnormal/list?days=7`);
    setConn(true);
    abnAllItems = res.items || [];
    renderAbnFiltered();
  } catch (e) {
    console.error(e);
    setConn(false);
    abnAllItems = [];
    if (abnTbody) abnTbody.innerHTML = "";
    if (abnEmpty) abnEmpty.textContent = "Lỗi tải danh sách mốc ngưng thở.";
    setAbnMarkersFromSelection();
  }
}

if (abnTbody) {
  abnTbody.addEventListener("change", (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLInputElement)) return;
    if (!t.classList.contains("abnPick")) return;
    const k = t.dataset.key || "";
    if (!k) return;
    if (t.checked) abnSelectedKeys.add(k);
    else abnSelectedKeys.delete(k);
    updateAbnCheckAllState();
    setAbnMarkersFromSelection();
  });
}

if (abnCheckAll) {
  abnCheckAll.addEventListener("change", () => {
    const on = abnCheckAll.checked;
    abnSelectedKeys = new Set();
    if (on) {
      for (const it of abnVisibleItems) abnSelectedKeys.add(abnKey(it));
    }
    if (abnTbody) {
      abnTbody.querySelectorAll("input.abnPick").forEach(cb => {
        const key = cb.dataset.key || "";
        cb.checked = !!key && abnSelectedKeys.has(key);
      });
    }
    updateAbnCheckAllState();
    setAbnMarkersFromSelection();
  });
}

// ================= INIT =================
(async function(){
  ensureCharts();
  selectedDates = [hanoiTodayStr()];
  renderDateSelector();
  await loadSelected();
  await loadAbn();
})();
