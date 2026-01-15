/* SleepMon web (public viewer)
   - Không phụ thuộc CDN (luxon/chart.js) để tránh lỗi "mất lựa chọn ngày".
   - Chọn 1 hoặc nhiều ngày (tối đa 7 ngày gần nhất) để lọc:
     + 2 đồ thị SpO2 và Audio RMS
     + Danh sách Abnormal (giải mã SMA1 -> WAV để Play/Tải)
*/

"use strict";

// ===== CHANGE THIS =====
const API_BASE = "https://sleepmon-api.sleepmon.workers.dev";
// =======================

const TZ = "Asia/Ho_Chi_Minh";

// UI refs
const connPill   = document.getElementById("connPill");
const livePill   = document.getElementById("livePill");
const dateBox    = document.getElementById("dateBox");
const modeNote   = document.getElementById("modeNote");
const liveToggle = document.getElementById("liveToggle");
const reloadBtn  = document.getElementById("reloadBtn");

const spo2Canvas = document.getElementById("spo2Chart");
const rmsCanvas  = document.getElementById("rmsChart");
const spo2DayLabel = document.getElementById("spo2DayLabel");
const rmsDayLabel  = document.getElementById("rmsDayLabel");

const abnList = document.getElementById("abnList");

// State
let selectedDates = []; // ["YYYY-MM-DD", ...] (Hanoi)
let abnAllItems = [];   // from /abnormal/list?days=7

let liveTimer = null;
let liveSeries = []; // points for today when live enabled

// ===== Utils: TZ-safe date formatting =====
function isoDateInTZ(date, timeZone){
  // returns "YYYY-MM-DD"
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return `${map.year}-${map.month}-${map.day}`;
}

function hanoiTodayStr(){
  return isoDateInTZ(new Date(), TZ);
}

function last7Dates(){
  const out = [];
  const now = new Date();
  for (let i=0; i<7; i++){
    const d = new Date(now.getTime() - i*24*3600*1000);
    out.push(isoDateInTZ(d, TZ));
  }
  return out;
}

function fmtDayDisp(iso){ // "YYYY-MM-DD" -> "DD-MM-YYYY"
  const [y,m,d] = iso.split("-");
  return `${d}-${m}-${y}`;
}

function fmtHanoi(tsSec){
  const d = new Date(tsSec * 1000);
  // "DD-MM-YYYY HH:mm:ss" in Hanoi TZ
  const parts = new Intl.DateTimeFormat("vi-VN", {
    timeZone: TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false
  }).formatToParts(d);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return `${map.day}-${map.month}-${map.year} ${map.hour}:${map.minute}:${map.second}`;
}

function dayIsoFromTs(tsSec){
  return isoDateInTZ(new Date(tsSec*1000), TZ);
}

function setConn(ok){
  connPill.textContent = ok ? "API: OK" : "API: chưa kết nối";
  connPill.style.color = ok ? "var(--ok)" : "var(--muted)";
}

function setLive(on){
  livePill.textContent = on ? "LIVE: ON" : "LIVE: OFF";
  livePill.style.color = on ? "var(--warn)" : "var(--muted)";
}

function canLive(){
  // live chỉ khi chọn đúng 1 ngày và đó là hôm nay (Hanoi)
  return selectedDates.length === 1 && selectedDates[0] === hanoiTodayStr();
}

function updateModeNote(){
  if (selectedDates.length === 0){
    modeNote.textContent = "Chưa chọn ngày nào.";
    return;
  }
  if (selectedDates.length === 1){
    modeNote.textContent = canLive()
      ? "Bạn có thể bật Live để xem dữ liệu trực tiếp (1s/điểm)."
      : "Đang xem lịch sử theo ngày đã chọn.";
  } else {
    modeNote.textContent = "Đang so sánh nhiều ngày (Live bị tắt).";
  }
}

function setDayLabels(){
  if (selectedDates.length === 0){
    spo2DayLabel.textContent = "";
    rmsDayLabel.textContent = "";
    return;
  }
  const label = selectedDates.map(fmtDayDisp).join(", ");
  spo2DayLabel.textContent = selectedDates.length === 1 ? `Ngày: ${label}` : `So sánh: ${label}`;
  rmsDayLabel.textContent  = spo2DayLabel.textContent;
}

// ===== API helpers =====
async function apiGet(path){
  const url = API_BASE.replace(/\/+$/,"") + path;
  const res = await fetch(url, { method: "GET" });
  if (!res.ok){
    const t = await res.text().catch(()=> "");
    throw new Error(`GET ${path} -> ${res.status} ${t}`);
  }
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("application/json")) return await res.json();
  // allow non-json
  return await res.text();
}

async function apiGetArrayBuffer(path){
  const url = API_BASE.replace(/\/+$/,"") + path;
  const res = await fetch(url, { method: "GET" });
  if (!res.ok){
    const t = await res.text().catch(()=> "");
    throw new Error(`GET(bin) ${path} -> ${res.status} ${t}`);
  }
  return await res.arrayBuffer();
}

async function checkHealth(){
  try{
    await apiGet("/health");
    setConn(true);
    return true;
  }catch(_){
    // không bắt buộc API có /health — chỉ để hiện pill
    setConn(false);
    return false;
  }
}

// ===== Date selector =====
function renderDateSelector(){
  const dates = last7Dates();
  dateBox.innerHTML = "";

  dates.forEach(dIso => {
    const chip = document.createElement("label");
    chip.className = "datechip";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = selectedDates.includes(dIso);

    cb.addEventListener("change", () => {
      if (cb.checked){
        selectedDates.push(dIso);
      } else {
        selectedDates = selectedDates.filter(x => x !== dIso);
      }
      // sort newest first
      selectedDates.sort((a,b)=> (a<b ? 1 : -1));

      if (selectedDates.length !== 1 || !canLive()){
        liveToggle.checked = false;
        stopLive();
      }

      updateModeNote();
      setDayLabels();
      renderAbnFiltered();
      loadSelected().catch(()=>{});
    });

    const span = document.createElement("span");
    span.textContent = fmtDayDisp(dIso);

    // highlight today
    if (dIso === hanoiTodayStr()) chip.classList.add("today");

    chip.appendChild(cb);
    chip.appendChild(span);
    dateBox.appendChild(chip);
  });
}

// ===== Minimal canvas chart renderer =====
const PALETTE_SPO2 = ["#e53935", "#d32f2f", "#ff5252", "#f44336", "#c62828", "#b71c1c", "#ff1744"];
const PALETTE_RMS  = ["#1565c0", "#1e88e5", "#42a5f5", "#64b5f6", "#0d47a1", "#2196f3", "#90caf9"];

function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }
function niceRange(min, max){
  if (!isFinite(min) || !isFinite(max) || min===max){
    return {min: min-1, max: max+1};
  }
  const pad = (max-min)*0.08;
  return {min: min-pad, max: max+pad};
}

function tsToSecondsOfDay(tsSec){
  const d = new Date(tsSec*1000);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ, hour:"2-digit", minute:"2-digit", second:"2-digit", hour12:false
  }).formatToParts(d);
  const map = {};
  for (const p of parts) map[p.type]=p.value;
  const hh = parseInt(map.hour||"0",10);
  const mm = parseInt(map.minute||"0",10);
  const ss = parseInt(map.second||"0",10);
  return hh*3600 + mm*60 + ss;
}

function clearCanvas(canvas){
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(10, rect.width);
  const h = Math.max(10, rect.height);
  canvas.width = Math.round(w*dpr);
  canvas.height = Math.round(h*dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,w,h);
  return {ctx, w, h};
}

function drawChart(canvas, series, opts){
  // series: [{label, points:[{xSec,y}], color}, ...]
  const {ctx, w, h} = clearCanvas(canvas);

  // background
  ctx.fillStyle = "rgba(255,255,255,0.02)";
  ctx.fillRect(0,0,w,h);

  const padL=44, padR=12, padT=10, padB=22;
  const pw = w - padL - padR;
  const ph = h - padT - padB;

  // find y range
  let ymin = Infinity, ymax = -Infinity;
  for (const s of series){
    for (const p of s.points){
      if (!isFinite(p.y)) continue;
      ymin = Math.min(ymin, p.y);
      ymax = Math.max(ymax, p.y);
    }
  }
  if (!isFinite(ymin) || !isFinite(ymax)){
    // placeholder
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.font = "12px system-ui, -apple-system, Segoe UI, Roboto";
    ctx.fillText("Chưa có dữ liệu", padL, padT+14);
    // axes
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.strokeRect(padL, padT, pw, ph);
    return;
  }
  let r = niceRange(ymin, ymax);
  ymin = r.min; ymax = r.max;

  const xMin = 0, xMax = 24*3600;

  function xToPx(x){ return padL + (x - xMin) / (xMax - xMin) * pw; }
  function yToPx(y){ return padT + (1 - (y - ymin) / (ymax - ymin)) * ph; }

  // grid
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;

  const yTicks = 4;
  for (let i=0;i<=yTicks;i++){
    const yy = padT + (i/yTicks)*ph;
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL+pw, yy); ctx.stroke();
  }
  const xTicks = 4; // 0,6,12,18,24
  for (let i=0;i<=xTicks;i++){
    const xx = padL + (i/xTicks)*pw;
    ctx.beginPath(); ctx.moveTo(xx, padT); ctx.lineTo(xx, padT+ph); ctx.stroke();
  }

  // axes border
  ctx.strokeStyle = "rgba(255,255,255,0.14)";
  ctx.strokeRect(padL, padT, pw, ph);

  // y labels
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.font = "11px system-ui, -apple-system, Segoe UI, Roboto";
  for (let i=0;i<=yTicks;i++){
    const val = ymax - (i/yTicks)*(ymax-ymin);
    const yy = padT + (i/yTicks)*ph;
    ctx.fillText(val.toFixed(opts.yDecimals ?? 1), 6, yy+4);
  }
  // x labels
  const hours = [0,6,12,18,24];
  for (let i=0;i<hours.length;i++){
    const sec = hours[i]*3600;
    const xx = xToPx(sec);
    ctx.fillText(hours[i].toString().padStart(2,"0")+":00", xx-14, padT+ph+16);
  }

  // series lines
  for (const s of series){
    const pts = s.points;
    if (!pts || pts.length < 2) continue;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    let started=false;
    for (const p of pts){
      const x = xToPx(p.xSec);
      const y = yToPx(p.y);
      if (!started){
        ctx.moveTo(x,y); started=true;
      } else {
        ctx.lineTo(x,y);
      }
    }
    ctx.stroke();
  }
}

function buildSeriesFromDays(daysObj, field, palette){
  const series = [];
  selectedDates.forEach((dIso, idx) => {
    const arr = (daysObj && daysObj[dIso]) ? daysObj[dIso] : [];
    const pts = [];
    for (const it of arr){
      const ts = it.ts ?? it.t ?? it.time;
      const y = it[field];
      if (!ts || y == null) continue;
      pts.push({ xSec: tsToSecondsOfDay(ts), y: Number(y) });
    }
    pts.sort((a,b)=>a.xSec-b.xSec);
    series.push({
      label: dIso,
      color: palette[idx % palette.length],
      points: pts
    });
  });
  return series;
}

// ===== Data loading + rendering =====
async function loadSelected(){
  setDayLabels();

  // empty states
  if (selectedDates.length === 0){
    drawChart(spo2Canvas, [], {yDecimals:1});
    drawChart(rmsCanvas,  [], {yDecimals:2});
    return;
  }

  try{
    const q = encodeURIComponent(selectedDates.join(","));
    const res = await apiGet(`/telemetry/days?dates=${q}`);
    setConn(true);

    const days = res.days || {};
    const spo2Series = buildSeriesFromDays(days, "spo2", PALETTE_SPO2);
    const rmsSeries  = buildSeriesFromDays(days, "rms",  PALETTE_RMS);

    drawChart(spo2Canvas, spo2Series, {yDecimals:1});
    drawChart(rmsCanvas,  rmsSeries,  {yDecimals:2});

  }catch(e){
    console.error(e);
    setConn(false);
    // still draw placeholder so user thấy JS chạy
    drawChart(spo2Canvas, [], {yDecimals:1});
    drawChart(rmsCanvas,  [], {yDecimals:2});
  }
}

reloadBtn.addEventListener("click", () => {
  stopLive();
  loadSelected().catch(()=>{});
  loadAbn().catch(()=>{});
});

// ===== Live mode =====
function stopLive(){
  if (liveTimer){
    clearInterval(liveTimer);
    liveTimer = null;
  }
  setLive(false);
}

async function tickLive(){
  try{
    const res = await apiGet("/telemetry/latest");
    setConn(true);
    const ts = res.ts ?? res.t ?? res.time;
    if (!ts) return;
    const day = dayIsoFromTs(ts);
    if (day !== hanoiTodayStr()) return;

    liveSeries.push({ts, spo2: res.spo2, rms: res.rms});
    // keep last ~2 hours
    const cutoff = ts - 2*3600;
    liveSeries = liveSeries.filter(p => p.ts >= cutoff);

    // render using liveSeries as today's data
    const days = {};
    days[hanoiTodayStr()] = liveSeries.map(p => ({ts: p.ts, spo2: p.spo2, rms: p.rms}));
    const spo2Series = buildSeriesFromDays(days, "spo2", PALETTE_SPO2);
    const rmsSeries  = buildSeriesFromDays(days, "rms",  PALETTE_RMS);
    drawChart(spo2Canvas, spo2Series, {yDecimals:1});
    drawChart(rmsCanvas,  rmsSeries,  {yDecimals:2});
  }catch(e){
    setConn(false);
  }
}

liveToggle.addEventListener("change", () => {
  if (!liveToggle.checked){
    stopLive();
    loadSelected().catch(()=>{});
    return;
  }
  if (!canLive()){
    liveToggle.checked = false;
    stopLive();
    return;
  }
  // start
  liveSeries = [];
  setLive(true);
  if (liveTimer) clearInterval(liveTimer);
  liveTimer = setInterval(tickLive, 1000);
  tickLive().catch(()=>{});
});

// ===== Abnormal: list/filter/decode/play/download =====
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
    title.innerHTML = `<strong>${it.filename || it.name || "abnormal"}</strong>`;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${fmtHanoi(it.ts)} • ${((it.size_bytes||0)/1024).toFixed(1)} KB`;
    left.appendChild(title);
    left.appendChild(meta);

    const right = document.createElement("div");
    right.style.display = "flex";
    right.style.flexDirection = "column";
    right.style.gap = "6px";
    right.style.alignItems = "flex-end";

    const rawUrl = API_BASE.replace(/\/+$/,"") + "/abnormal/get?key=" + encodeURIComponent(it.r2_key || it.key || "");
    const btnRow = document.createElement("div");
    btnRow.style.display = "flex";
    btnRow.style.gap = "8px";
    btnRow.style.flexWrap = "wrap";
    btnRow.style.justifyContent = "flex-end";

    const btnDecode = document.createElement("button");
        btnDecode.textContent = "Giải mã & Play";

    const btnWav = document.createElement("button");
        btnWav.textContent = "Tải WAV";
    btnWav.disabled = true;

    const linkRaw = document.createElement("a");
    linkRaw.href = rawUrl;
    linkRaw.target = "_blank";
    linkRaw.textContent = "Tải gốc";
    
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "none";
    audio.style.width = "260px";

    // cache per key
    let wavBlob = null;
    let wavUrl = null;

    async function ensureWav(){
      if (wavBlob) return;
      btnDecode.disabled = true;
      btnDecode.textContent = "Đang giải mã...";
      try{
        const buf = await apiGetArrayBuffer("/abnormal/get?key=" + encodeURIComponent(it.r2_key || it.key || ""));
        try{
          // ưu tiên SMA1 (IMA-ADPCM) -> WAV
          const { wav } = sma1ToWav(buf);
          wavBlob = new Blob([wav], { type: "audio/wav" });
        }catch(_err){
          // fallback: nếu server trả WAV sẵn thì play trực tiếp
          wavBlob = new Blob([buf], { type: "audio/wav" });
        }
        wavUrl = URL.createObjectURL(wavBlob);
        audio.src = wavUrl;
        btnWav.disabled = false;
        btnDecode.textContent = "Play lại";
      }catch(e){
        console.error(e);
        btnDecode.textContent = "Lỗi giải mã";
      }finally{
        btnDecode.disabled = false;
      }
    }

    btnDecode.addEventListener("click", async () => {
      await ensureWav();
      if (audio.src){
        try{ await audio.play(); }catch(_){}
      }
    });

    btnWav.addEventListener("click", async () => {
      await ensureWav();
      if (!wavBlob) return;
      const a = document.createElement("a");
      const base = (it.filename || "abnormal").replace(/\.[^.]+$/,"");
      a.download = base + ".wav";
      a.href = wavUrl;
      document.body.appendChild(a);
      a.click();
      a.remove();
    });

    btnRow.appendChild(btnDecode);
    btnRow.appendChild(btnWav);
    btnRow.appendChild(linkRaw);

    right.appendChild(btnRow);
    right.appendChild(audio);

    div.appendChild(left);
    div.appendChild(right);
    abnList.appendChild(div);
  });
}

function renderAbnFiltered(){
  if (!abnAllItems || abnAllItems.length === 0){
    renderAbn([]);
    return;
  }
  const pick = new Set(selectedDates);
  const items = (abnAllItems || []).filter(it => pick.has(dayIsoFromTs(it.ts)));
  renderAbn(items);
}

async function loadAbn(){
  try{
    const res = await apiGet("/abnormal/list?days=7");
    setConn(true);
    abnAllItems = res.items || [];
    renderAbnFiltered();
  }catch(e){
    console.error(e);
    setConn(false);
    abnList.textContent = "Lỗi tải danh sách abnormal.";
  }
}

// ===== SMA1 (IMA-ADPCM) decode =====
const IMA_INDEX_TABLE = [-1,-1,-1,-1, 2,4,6,8, -1,-1,-1,-1, 2,4,6,8];
const IMA_STEP_TABLE = [
  7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,
  34,37,41,45,50,55,60,66,73,80,88,97,107,118,130,143,
  157,173,190,209,230,253,279,307,337,371,408,449,494,544,598,658,
  724,796,876,963,1060,1166,1282,1411,1552,1707,1878,2066,2272,2499,2749,3024,
  3327,3660,4026,4428,4871,5358,5894,6484,7132,7845,8630,9493,10442,11487,12635,13899,
  15289,16818,18500,20350,22385,24623,27086,29794,32767
];

function clamp16(n){
  return Math.max(-32768, Math.min(32767, n|0));
}

function readU32LE(view, off){ return view.getUint32(off, true); }
function readI16LE(view, off){ return view.getInt16(off, true); }

function sma1ToWav(arrayBuffer){
  const view = new DataView(arrayBuffer);
  if (view.byteLength < 64) throw new Error("SMA1 too small");
  const magic = String.fromCharCode(
    view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)
  );
  if (magic !== "SMA1") throw new Error("Not SMA1");
  const headerSize  = readU32LE(view, 4);
  const sampleRate  = readU32LE(view, 8);
  const blockSamples = readU32LE(view, 12);
  const totalSamples = readU32LE(view, 16);
  // const startEpoch = readU32LE(view, 20);
  // const dataBytes  = readU32LE(view, 24);

  if (headerSize < 64 || headerSize > view.byteLength) throw new Error("Bad headerSize");
  if (!blockSamples || blockSamples > 4096) throw new Error("Bad blockSamples");
  if (!totalSamples || totalSamples > 10_000_000) throw new Error("Bad totalSamples");

  const pcm = new Int16Array(totalSamples);
  let outPos = 0;

  const blockBytes = 4 + Math.floor(blockSamples / 2); // matches encoder padding for even blockSamples

  let pos = headerSize;
  const u8 = new Uint8Array(arrayBuffer);

  while (outPos < totalSamples && pos + 4 <= view.byteLength){
    const blockStart = pos;
    const predictor = readI16LE(view, pos); pos += 2;
    let index = view.getUint8(pos); pos += 1;
    pos += 1; // reserved

    let pred = predictor|0;
    index = clamp(index|0, 0, 88);

    pcm[outPos++] = clamp16(pred);

    const dataStart = blockStart + 4;
    // decode samples 2..blockSamples
    for (let i=1; i<blockSamples && outPos < totalSamples; i++){
      const bi = (i-1) >> 1;
      const b = u8[dataStart + bi];
      const code = ((i-1) & 1) === 0 ? (b & 0x0F) : (b >> 4);

      const step = IMA_STEP_TABLE[index];
      let diff = step >> 3;
      if (code & 4) diff += step;
      if (code & 2) diff += (step >> 1);
      if (code & 1) diff += (step >> 2);

      if (code & 8) pred -= diff;
      else pred += diff;
      pred = clamp16(pred);

      index += IMA_INDEX_TABLE[code & 0x0F];
      index = clamp(index, 0, 88);

      pcm[outPos++] = pred;
    }

    pos = blockStart + blockBytes;
  }

  // build WAV
  const wav = pcm16ToWav(pcm, sampleRate, 1);
  return { wav, sampleRate };
}

function pcm16ToWav(pcm, sampleRate, channels){
  const bytesPerSample = 2;
  const dataBytes = pcm.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  function writeStr(off, s){
    for (let i=0;i<s.length;i++) view.setUint8(off+i, s.charCodeAt(i));
  }
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataBytes, true);

  // PCM
  let off = 44;
  for (let i=0;i<pcm.length;i++,off+=2){
    view.setInt16(off, pcm[i], true);
  }
  return buffer;
}

// ===== Init =====
window.addEventListener("resize", () => {
  // redraw with last known state (best-effort)
  loadSelected().catch(()=>{});
});

(async function init(){
  // default: select today
  selectedDates = [hanoiTodayStr()];
  renderDateSelector();
  updateModeNote();
  setDayLabels();

  // placeholders
  drawChart(spo2Canvas, [], {yDecimals:1});
  drawChart(rmsCanvas,  [], {yDecimals:2});

  await checkHealth();
  await loadSelected();
  await loadAbn();

  setLive(false);
})();
