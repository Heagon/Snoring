function getApiBase() {
  return localStorage.getItem("apiBase") || "";
}
function setApiBase(v) {
  localStorage.setItem("apiBase", v.trim());
}

function fmtTime(sec) {
  try {
    const d = new Date(Number(sec) * 1000);
    return d.toLocaleString("vi-VN");
  } catch { return String(sec); }
}

async function loadEvents() {
  const api = getApiBase();
  const status = document.getElementById("status");
  const listDesat = document.getElementById("listDesat");
    const listSnore = document.getElementById("listSnore");
  listDesat.innerHTML = "";
    if (listSnore) listSnore.innerHTML = "";
  if (!api) {
    status.textContent = "Hãy nhập API Base URL rồi bấm Lưu.";
    return;
  }
  status.textContent = "Đang tải...";
  try {
    const r = await fetch(`${api.replace(/\/+$/,'')}/api/public/events?limit=200`);
    const j = await r.json();
    if (!j.ok) throw new Error(j.message || "API error");
    status.textContent = `OK. Tổng: ${j.events.length} sự kiện.`;
    for (const ev of j.events) {
      const div = document.createElement("div");
      div.className = "item";
      div.innerHTML = `
        <div class="top">
          <div>
            <strong>${ev.type}</strong>
            <span class="badge">device: ${ev.device_id}</span>
            <span class="badge">sev: ${ev.severity}</span>
          </div>
          <div class="muted">${fmtTime(ev.created_at)}</div>
        </div>
        <div class="muted">ts_start: ${fmtTime(ev.ts_start)} ${ev.ts_end ? `— ts_end: ${fmtTime(ev.ts_end)}` : ""}</div>
        <div class="muted">SpO₂ min: ${ev.spo2_min ?? "-"} | SpO₂ avg: ${ev.spo2_avg ?? "-"} | HR avg: ${ev.hr_avg ?? "-"}</div>
        ${ev.audio_url ? `<audio controls src="${ev.audio_url}"></audio>` : ""}
        ${ev.meta ? `<pre>${JSON.stringify(ev.meta, null, 2)}</pre>` : ""}
      `;
      list.appendChild(div);
    }
  } catch (e) {
    status.textContent = `Lỗi: ${e.message || e}`;
  }
}

document.getElementById("apiBase").value = getApiBase();

document.getElementById("save").addEventListener("click", () => {
  setApiBase(document.getElementById("apiBase").value);
  loadEvents();
});

document.getElementById("refresh").addEventListener("click", loadEvents);

loadEvents();
