/*
 * ODrive Motion Setup — núcleo do wizard (8 etapas) para atuadores de fuso de esferas.
 * A mesma UI roda no PC (dev, via bridge.py) e no ESP32 (SPIFFS + WebSocket).
 *
 * Protocolo de transporte (WebSocket JSON, id correlaciona requisição/resposta):
 *   -> {id, cmd:"scan"}
 *   -> {id, cmd:"get",  path:"vbus_voltage"}
 *   -> {id, cmd:"set",  path:"axis0.controller.config.pos_gain", value:20}
 *   -> {id, cmd:"state", requested:8}                    // solicita estado do eixo (AXIS_STATE_*)
 *   -> {id, cmd:"action", action:"save"|"erase"|"reboot"}
 *   <- {id, ok:true, value?} | {id, ok:false, error}
 *   <- {event:"telemetry", ...}                          // assinaturas (live plot/dashboard)
 */
'use strict';

/* ===================== Transporte ===================== */
class WSTransport {
  constructor(url) {
    // ESP32 serve a UI na porta 80 e o WS na 81; em dev a UI é servida em :8080 e a bridge (bridge.py/mock) em :8765.
    if (!url) url = (location.port === '' || location.port === '80') ? `ws://${location.hostname}:81/` : 'ws://127.0.0.1:8765/';
    this.url = url; this.seq = 1; this.pending = new Map(); this.onstate = null; this.onevent = null;
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => { resolve(); };
      this.ws.onclose = () => { onConn(false); this.onstate && this.onstate(false); };
      this.ws.onerror = e => reject(e);
      this.ws.onmessage = ev => {
        const m = JSON.parse(ev.data);
        if (m.id !== undefined && this.pending.has(m.id)) {
          const p = this.pending.get(m.id); this.pending.delete(m.id);
          m.ok ? p.res(m.value) : p.rej(new Error(m.error || 'erro remoto'));
        } else if (m.event && this.onevent) this.onevent(m);
      };
    });
  }
  call(cmd, payload = {}) {
    const id = this.seq++;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      setTimeout(() => { if (this.pending.delete(id)) rej(new Error('timeout')); }, 10000);
      this.ws.send(JSON.stringify({ id, cmd, ...payload }));
    });
  }
  get(path)          { return this.call('get',   { path }); }
  set(path, value)   { return this.call('set',   { path, value }); }
  scan()             { return this.call('scan'); }
  reqState(swatch)  { return this.call('state', { requested: swatch }); }
  action(name)      { return this.call('action', { action: name }); }
  subscribe(period) { return this.call('telemetry', { on: true, period_ms: period }); }
  unsubscribe()     { return this.call('telemetry', { on: false }); }
}
const odrive = new WSTransport();

/* ===================== Estado global ===================== */
const S = {
  scanned: [],      // dispositivos detectados
  dev: null,        // serial number selecionado
  axis: 0,          // 0 | 1
  pitch_mm: 5,      // passo do fuso [mm/volta]
  stroke_mm: 150,   // curso útil [mm]
  invert: false,
  done: new Set(),
  profile: {},      // espelho dos parâmetros gravados (export JSON)
};
const axP = p => `axis${S.axis}.${p}`;
const setA = (p, v) => odrive.set(axP(p), v);
const getA = p => odrive.get(axP(p));

/* ===================== DOM helpers ===================== */
const el   = (t, c, h) => { const d = document.createElement(t); if (c) d.className = c; if (h !== undefined) d.innerHTML = h; return d; };
const field = (lab, input) => { const f = el('div', 'field'); f.append(el('label', null, lab), input); return f; };
const num  = (v, step = 'any', min) => { const i = el('input'); i.type = 'number'; i.step = step; if (min !== undefined) i.min = min; if (v !== undefined) i.value = v; return i; };
const sel  = (pairs, v) => { const s = el('select'); pairs.forEach(([x, t]) => s.append(new Option(t, x))); if (v !== undefined) s.value = v; return s; };
const btn  = (t, c) => el('button', c, t);
const grid = (...e) => { const g = el('div', 'grid'); g.append(...e); return g; };
const row  = (...e) => { const r = el('div', 'btns'); r.append(...e); return r; };
const note = (txt, kind = '') => el('div', 'notice ' + kind, txt);
let logbox = null;
const log  = m => { if (logbox) { logbox.textContent += `[${new Date().toLocaleTimeString()}] ${m}\n`; logbox.scrollTop = logbox.scrollHeight; } };

/* Live plot mínimo (sem libs — Canvas nativo, favorável ao ESP32) */
const plotData = { pos: [], tgt: [], cur: [], max: 300 };
function drawPlot(cv) {
  const c = cv.getContext('2d');
  const W = cv.width = cv.clientWidth, H = cv.height = cv.clientHeight;
  c.clearRect(0, 0, W, H);
  const series = [plotData.pos, plotData.tgt].filter(a => a.length > 1);
  if (!series.length) return;
  const all = series.flat();
  const mn = Math.min(...all), mx = Math.max(...all), span = Math.max(1e-9, mx - mn);
  const n = plotData.max;
  const y = v => H - 8 - ((v - mn) / span) * (H - 16);
  const x = i => i / (n - 1) * W;
  const line = (a, color) => {
    c.beginPath(); c.strokeStyle = color; c.lineWidth = 1.5;
    a.forEach((v, i) => i ? c.lineTo(x(i), y(v)) : c.moveTo(x(i), y(v)));
    c.stroke();
  };
  line(plotData.tgt, '#e0a13a');
  line(plotData.pos, '#2f7fd6');
}
function pushPlot(pos, tgt) {
  plotData.pos.push(pos); plotData.tgt.push(tgt);
  if (plotData.pos.length > plotData.max) { plotData.pos.shift(); plotData.tgt.shift(); }
}
odrive.onevent = m => {
  if (m.event === 'telemetry') {
    pushPlot(turn2mm(m.pos ?? 0), turn2mm(m.tgt ?? 0));
    S.live = m;
    if (S.onTelemetry) S.onTelemetry(m);
  }
};

/* mm <-> turn */
const mm2turn = mm => (mm / S.pitch_mm) * (S.invert ? -1 : 1);
const turn2mm = t => t * S.pitch_mm * (S.invert ? -1 : 1);
const fmt = (v, d = 1) => Number(v).toFixed(d);

/* ===================== Etapas ===================== */
const STEPS = [];

/* ---- 0. Conexão ---- */
{
  let chosen = null;
  const table = el('table', 'list');
  const bConn = btn('Conectar bridge', 'primary');
  const bScan = btn('Procurar ODrives');
  const bUse  = btn('Usar selecionado', 'ok');
  bUse.disabled = true;

  bConn.onclick = async () => {
    try { await odrive.connect(); onConn(true); log('bridge conectado em ' + odrive.url); }
    catch { onConn(false); log('falha — rode python bridge.py no PC'); }
  };
  bScan.onclick = async () => {
    bScan.disabled = true;
    table.innerHTML = '<tr><td class="muted">procurando…</td></tr>';
    try {
      S.scanned = await odrive.scan() || [];
      table.innerHTML = S.scanned.length
        ? '<tr><th></th><th>Eixo</th><th>Serial</th><th>HW</th><th>Firmware</th></tr>'
        : '<tr><td class="muted">nenhum dispositivo — verifique o USB</td></tr>';
      S.scanned.forEach(d => [0, 1].forEach(a => {
        const tr = table.insertRow();
        const r = el('input'); r.type = 'radio'; r.name = 'pick';
        r.onchange = () => { chosen = { dev: d.serial || d.uuid, axis: a }; bUse.disabled = false; };
        tr.insertCell().append(r);
        tr.insertCell().textContent = 'M' + a;
        tr.insertCell().textContent = d.serial || d.uuid || '?';
        tr.insertCell().textContent = `${d.hw_major}.${d.hw_minor} ${d.hw_variant || ''}`.trim();
        tr.insertCell().textContent = d.fw || '?';
      }));
    } catch (e) { log('scan falhou: ' + e.message); }
    bScan.disabled = false;
  };

  STEPS.push({
    id: 'link', title: '0. Conexão', desc: 'Conecta no bridge e seleciona o atuador (ODrive + eixo).',
    body(b) {
      bUse.onclick = () => {
        S.dev = chosen.dev; S.axis = chosen.axis;
        document.getElementById('hdr-device').textContent = `${S.dev} — eixo M${S.axis}`;
        app.finish('link');
      };
      b.append(row(bConn, bScan), table, row(bUse));
    },
  });
}

/* ---- 1...7 preenchidas em seguida ---- */

/* ===================== App ===================== */
const app = {
  cur: 0,
  finish(id) { S.done.add(id); this.cur = Math.min(this.cur + 1, STEPS.length - 1); this.render(); },
  goto(i) { this.cur = i; this.render(); },
  render() {
    const nav = document.getElementById('steps');
    nav.innerHTML = '';
    STEPS.forEach((s, i) => {
      const it = el('div', 'item' + (i === this.cur ? ' active' : '') + (S.done.has(s.id) ? ' done' : ''));
      it.append(el('span', 'n', S.done.has(s.id) ? '✓' : String(i)), el('span', null, s.title));
      it.onclick = () => this.goto(i);
      nav.append(it);
    });
    const s = STEPS[this.cur];
    const page = document.getElementById('page');
    page.innerHTML = '';
    const tpl = document.getElementById('tpl-step').content.cloneNode(true);
    tpl.querySelector('h2').textContent = s.title;
    tpl.querySelector('.desc').textContent = s.desc;
    const bodyEl = tpl.querySelector('.body');
    logbox = el('div', 'log'); logbox.textContent = '';
    s.body(bodyEl);
    bodyEl.append(logbox);
    tpl.querySelector('.prev').style.display = this.cur === 0 ? 'none' : '';
    tpl.querySelector('.next').style.display = this.cur === STEPS.length - 1 ? 'none' : '';
    tpl.querySelector('.prev').onclick = () => this.goto(this.cur - 1);
    tpl.querySelector('.next').onclick = () => app.finish(s.id);
    page.append(tpl);
  },
};
function onConn(on) {
  const h = document.getElementById('hdr-status');
  h.className = 'badge ' + (on ? 'on' : 'off'); h.textContent = on ? 'online' : 'offline';
}
odrive.onstate = onConn;

/* as demais etapas registram-se em STEPS via steps.js */
window.STEPS = STEPS; window._core = { S, el, field, num, sel, btn, grid, row, note, log, odrive, axP, setA, getA, mm2turn, turn2mm, fmt, drawPlot, app, onConn };
document.addEventListener('DOMContentLoaded', () => app.render());
