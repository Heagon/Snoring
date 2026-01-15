/* SleepMon web (public viewer)
   - Live view: only when selecting exactly 1 day == today (Hanoi) and Live is ON
   - Multi-day compare: select multiple days -> Live auto OFF
*/

const { DateTime } = luxon;

// ===== CHANGE THIS =====
const API_BASE = "https://sleepmon-api.sleepmon.workers.dev";

// ===== SMA1 (IMA-ADPCM) decoder =====
// Container: 64B header ("SMA1") + blocks
// Each block: predictor(int16 LE) + index(uint8) + reserved(uint8) + (blockSamples/2) bytes ADPCM nibbles
const SMA1_INDEX_TABLE = [-1,-1,-1,-1, 2,4,6,8, -1,-1,-1,-1, 2,4,6,8];
const SMA1_STEP_TABLE = [
  7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,60,66,73,80,88,
  97,107,118,130,143,157,173,190,209,230,253,279,307,337,371,408,449,494,544,598,
  658,724,796,876,963,1060,1166,1282,1411,1552,1707,1878,2066,2272,2499,2749,3024,
  3327,3660,4026,4428,4871,5358,5894,6484,7132,7845,8630,9493,10442,11487,12635,
  13899,15289,16818,18500,20350,22385,24623,27086,29794,32767
];

function clamp16(v){
  if (v > 32767) return 32767;
  if (v < -32768) return -32768;
  return v | 0;
}

function parseSma1Header(buf){
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== "SMA1") throw new Error("Không phải file SMA1.");
  const headerSize   = dv.getUint32(4, true);
  const sampleRate   = dv.getUint32(8, true);
  const blockSamples = dv.getUint32(12, true);
  const totalSamples = dv.getUint32(16, true);
  const startEpoch   = dv.getUint32(20, true);
  const dataBytes    = dv.getUint32(24, true);
  return { headerSize, sampleRate, blockSamples, totalSamples, startEpoch, dataBytes };
}

function imaDecodeNibble(nib, st){
  const code = nib & 0x0F;
  let step = SMA1_STEP_TABLE[st.index] || 7;
  let diff = step >> 3;
  if (code & 1) diff += step >> 2;
  if (code & 2) diff += step >> 1;
  if (code & 4) diff += step;
  if (code & 8) diff = -diff;

  st.predictor = clamp16(st.predictor + diff);
  st.index += SMA1_INDEX_TABLE[code] || 0;
  if (st.index < 0) st.index = 0;
  if (st.index > 88) st.index = 88;

  return st.predictor;
}

function decodeSma1ToPcm16(buf){
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  const h = parseSma1Header(buf);

  const headerSize = (h.headerSize && h.headerSize >= 28) ? h.headerSize : 64;
  const blockSamples = h.blockSamples | 0;
  const bytesPerBlock = 4 + (blockSamples >> 1);

  const pcm = new Int16Array(h.totalSamples);
  let outPos = 0;

  let off = headerSize;
  const dataEnd = Math.min(u8.length, headerSize + (h.dataBytes || (u8.length - headerSize)));

  while (off + 4 <= dataEnd && outPos < pcm.length){
    const predictor = dv.getInt16(off, true);
    const index = u8[off + 2] | 0;
    // off+3 reserved
    off += 4;

    const st = { predictor, index };
    pcm[outPos++] = predictor;

    const bytes = Math.min((blockSamples >> 1), dataEnd - off);
    for (let i = 0; i < bytes && outPos < pcm.length; i++){
      const b = u8[off + i];
      const lo = b & 0x0F;
      const hi = (b >> 4) & 0x0F;

      pcm[outPos++] = imaDecodeNibble(lo, st);
      if (outPos < pcm.length) pcm[outPos++] = imaDecodeNibble(hi, st);
    }
    off += (blockSamples >> 1);

    // If file is truncated, break safely
    if (bytes < (blockSamples >> 1)) break;
  }

  return { pcm, info: h };
}

function pcm16ToWavBuffer(pcm, sampleRate){
  const numChannels = 1;
  const bitsPerSample = 16;
  const blockAlign = numChannels * bitsPerSample / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.length * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(buf);

  function wrStr(off, s){
    for (let i=0;i<s.length;i++) dv.setUint8(off+i, s.charCodeAt(i));
  }

  wrStr(0, "RIFF");
  dv.setUint32(4, 36 + dataSize, true);
  wrStr(8, "WAVE");
  wrStr(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, numChannels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, byteRate, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, bitsPerSample, true);
  wrStr(36, "data");
  dv.setUint32(40, dataSize, true);

  let off = 44;
  for (let i=0;i<pcm.length;i++,off+=2){
    dv.setInt16(off, pcm[i], true);
  }
  return buf;
}

// cache: r2_key -> { wavUrl, wavBlob, info }
const ABN_WAV_CACHE = new Map();

async function getAbnWavUrl(it){
  const key = it.r2_key;
  if (ABN_WAV_CACHE.has(key)) return ABN_WAV_CACHE.get(key);

  const smaUrl = API_BASE + "/abnormal/get?key=" + encodeURIComponent(key);
  const res = await fetch(smaUrl);
  if (!res.ok) throw new Error("Tải file SMA1 thất bại (HTTP " + res.status + ").");
  const buf = await res.arrayBuffer();
  const { pcm, info } = decodeSma1ToPcm16(buf);
  const wavBuf = pcm16ToWavBuffer(pcm, info.sampleRate || 16000);
  const wavBlob = new Blob([wavBuf], { type: "audio/wav" });
  const wavUrl = URL.createObjectURL(wavBlob);

  const pack = { wavUrl, wavBlob, info };
  ABN_WAV_CACHE.set(key, pack);
  return pack;
}


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
    right.style.display = "flex";
    right.style.flexDirection = "column";
    right.style.alignItems = "flex-end";
    right.style.gap = "8px";

    const status = document.createElement("div");
    status.className = "meta";
    status.textContent = "Chưa giải mã";

    const btnRow = document.createElement("div");
    btnRow.style.display = "flex";
    btnRow.style.gap = "8px";

    const playBtn = document.createElement("button");
    playBtn.textContent = "Giải mã & Play";

    const dlBtn = document.createElement("button");
    dlBtn.textContent = "Tải WAV";

    btnRow.appendChild(playBtn);
    btnRow.appendChild(dlBtn);

    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "none";
    audio.style.width = "260px";

    const baseName = (it.filename || "abnormal").replace(/\.(sma|bin|dat)$/i, "");
    const wavName = baseName + ".wav";

    async function ensureDecoded(){
      status.textContent = "Đang giải mã…";
      playBtn.disabled = true;
      dlBtn.disabled = true;
      try{
        const pack = await getAbnWavUrl(it);
        audio.src = pack.wavUrl;
        status.textContent = `OK • ${pack.info.sampleRate||""} Hz • ${pack.info.totalSamples||""} samples`;
        return pack;
      }catch(e){
        console.error(e);
        status.textContent = "Lỗi giải mã: " + (e && e.message ? e.message : e);
        throw e;
      }finally{
        playBtn.disabled = false;
        dlBtn.disabled = false;
      }
    }

    playBtn.addEventListener("click", async () => {
      try{
        const pack = await ensureDecoded();
        audio.currentTime = 0;
        await audio.play();
      }catch(_){}
    });

    dlBtn.addEventListener("click", async () => {
      try{
        const pack = await ensureDecoded();
        const a = document.createElement("a");
        a.href = pack.wavUrl;
        a.download = wavName;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }catch(_){}
    });

    // optional: keep raw download link (debug)
    const raw = document.createElement("a");
    raw.href = API_BASE + "/abnormal/get?key=" + encodeURIComponent(it.r2_key);
    raw.target = "_blank";
    raw.textContent = "Tải file gốc (.sma)";
    raw.style.fontSize = "12px";
    raw.style.color = "var(--muted)";

    right.appendChild(btnRow);
    right.appendChild(audio);
    right.appendChild(status);
    right.appendChild(raw);

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
