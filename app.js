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
    this.url = url; this.seq = 1; this.pending = new Map(); this.onstate = null; this.onevent = null; this._wsReconnectOn = false;
  }
  get connected() { return !!(this.ws && this.ws.readyState === 1); }
  connect() {
    this._wsReconnectOn = true;
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => { resolve(); };
      this.ws.onclose = () => { onConn(false); this.onstate && this.onstate(false); this._wsAutoReconnect(); };
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
  async _wsAutoReconnect() {
    if (!this._wsReconnectOn) return;
    while (this._wsReconnectOn && !this.connected) {
      await new Promise(r => setTimeout(r, 2000));
      try { await this.connect(); break; } catch (e) { /* tenta de novo */ }
    }
  }
  call(cmd, payload = {}) {
    const id = this.seq++;
    return new Promise((res, rej) => {
      if (!this.connected) return rej(new Error('não conectado'));
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
/* Transporte serial direto à ODrive (protocolo ASCII, ver docs/ascii-protocol.rst).
 * No Windows: rookEdge/Chrome com Web Serial; abre o COM da ODrive (USB) ou um adaptador
 * USB-TTL em GPIO1/GPIO2 (UART_A, 115200 8N1). Não requer bridge. */
class WebSerialTransport {
  constructor(baud = 115200) { this.baud = baud; this.q = Promise.resolve(); this.reader = null; this.onstate = null; this.onevent = null; this.teleTimer = null; this._pendingGet = null; this._buf = ''; }
  connect() {
    return new Promise(async (res, rej) => {
      try {
        if (!('serial' in navigator)) return rej(new Error('Web Serial não suportado neste browser — use Chrome/Edge'));
        this.port = await navigator.serial.requestPort();
        await this.port.open({ baudRate: this.baud, dataBits: 8, stopBits: 1, parity: 'none' });
        this.td = new TextDecoderStream(); this.port.readable.pipeTo(this.td.writable).catch(() => {});
        this.stream = this.td.readable; this.reader = this.stream.getReader();
        this._readLoop();
        res();
      } catch (e) { rej(e); }
    });
  }
  async _readLoop() {
    try {
      while (true) {
        const { value, done } = await this.reader.read();
        if (done) break;
        this._buf += value;
        let i;
        while ((i = this._buf.indexOf('\n')) >= 0) {
          const line = this._buf.slice(0, i).replace(/\r$/, '').trim();
          this._buf = this._buf.slice(i + 1);
          if (this._pendingGet) { const p = this._pendingGet; this._pendingGet = null; const f = parseFloat(line); p.res(isNaN(f) ? line : f); }
        }
      }
    } catch (e) {} this._close();
  }
  _close() { onConn(false); this.onstate && this.onstate(false); this._autoReconnect(); }
  // Reconexão automática: reabre a mesma porta (após reboot/erase a ODrive volta com o mesmo USB).
  async _autoReconnect() {
    if (this._reconnOn) return; this._reconnOn = true;
    let tries = 0;
    while (this._reconnOn && tries++ < 60 && !this.connected) {
      try {
        if (!this.port) {
          const ports = await navigator.serial.getPorts();
          if (ports.length) this.port = ports[0]; else { await new Promise(r => setTimeout(r, 1500)); continue; }
        }
        try { await this.port.close(); } catch (e) {}
        await new Promise(r => setTimeout(r, 1500));
        await this.port.open({ baudRate: this.baud, dataBits: 8, stopBits: 1, parity: 'none' });
        this.td = new TextDecoderStream(); this.port.readable.pipeTo(this.td.writable).catch(() => {});
        this.stream = this.td.readable; this.reader = this.stream.getReader();
        this._readLoop();
        onConn(true); this.onstate && this.onstate(true);
        if (typeof window !== 'undefined' && window._core && window._core.S && window._core.S.onReconnected) window._core.S.onReconnected();
        return;
      } catch (e) { await new Promise(r => setTimeout(r, 1500)); }
    }
    this._reconnOn = false;
  }
  stopAutoReconnect() { this._reconnOn = false; }
  get connected() { return !!(this.port && this.port.writable); }
  _send(line) { if (!this.connected) return; const w = this.port.writable.getWriter(); const te = new TextEncoder(); w.write(te.encode(line + '\n')).finally(() => w.releaseLock()); }
  // serialização de requisições (a ODrive processa uma linha por vez)
  _q(fn) { const r = this.q.then(fn, fn); this.q = r.catch(() => {}); return r; }
  get(path) {
    if (!this.connected) return Promise.resolve(null);
    return this._q(() => new Promise((res) => {
      this._pendingGet = { res };
      setTimeout(() => { if (this._pendingGet) { this._pendingGet = null; res(null); } }, 800);
      this._send('r ' + path);
    }));
  }
  set(path, value) { return this._q(async () => { this._send(`w ${path} ${value}`); await new Promise(r => setTimeout(r, 30)); }); }
  reqState(s) { const axn = (typeof S !== 'undefined' ? S.axis : 0); return this.set(`axis${axn}.requested_state`, s); }
  action(name) {
    const m = { save: 'ss', erase: 'se', reboot: 'sr', clear: 'sc' };
    return this._q(async () => { this._send(m[name] || name); await new Promise(r => setTimeout(r, 50)); });
  }
  scan() { return Promise.resolve([{ serial: 'USB-serial', hw_major: 3, hw_minor: 6, fw: '0.5.6-sh' }]); }
  // Sincroniza campos do wizard a partir da placa (chamada automática na (re)conexão)
  async syncFromDevice(paths) {
    const out = {};
    for (const [key, path] of Object.entries(paths)) {
      const v = await this.get(path);
      if (v !== null && v !== undefined) out[key] = v;
      await new Promise(r => setTimeout(r, 30));
    }
    return out;
  }
  subscribe(period = 50) {
    this.unsubscribe();
    if (!this.connected) return Promise.resolve();
    this.teleTimer = setInterval(async () => {
      const pos = await this.get(`axis${S.axis}.encoder.pos_estimate`);
      const iq  = await this.get(`axis${S.axis}.motor.Iq_measured`);
      const tgt = await this.get(`axis${S.axis}.controller.pos_setpoint`);
      const err = await this.get(`axis${S.axis}.error`);
      const st  = await this.get(`axis${S.axis}.current_state`);
      const vb  = await this.get(`vbus_voltage`);
      this.onevent && this.onevent({ event: 'telemetry', pos, iq, tgt, error: err, state: st, vbus: vb });
    }, period);
    return Promise.resolve();
  }
  unsubscribe() { if (this.teleTimer) { clearInterval(this.teleTimer); this.teleTimer = null; } return Promise.resolve(); }
}

/* Escolha automática:
 *  - página servida pelo ESP32 (porta 80)  -> WebSocket (CAN no outro lado)
 *  - screen do browser local/dev          -> Web Serial direto à ODrive (Windows)
 *  - fallback para mock/bridge WS já em :8765 se navigator.serial não existir
 */
function makeTransport() {
  // ESP32 hospeda a UI pelo seu IP/mDNS: AP 192.168.4.1, STA em DHCP na sua rede, ou odrive-motorsim.local
  const host = location.hostname;
  const isEsp32 = (/^\d+\.\d+\.\d+\.\d+$/.test(host) && host !== '127.0.0.1') || host.endsWith('.local') || host === 'odrive-motorsim';
  if (isEsp32) return new WSTransport(`ws://${host}:81/`);
  // PC (GitHub Pages/localhost/dev): Web Serial direto à ODrive; fallback p/ mock WS em browser sem Web Serial
  if ('serial' in navigator) return new WebSerialTransport();
  return new WSTransport('ws://127.0.0.1:8765/');
}
const odrive = makeTransport();

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

  const isEsp32 = odrive instanceof WSTransport && odrive.url && odrive.url.includes(':81');
  const isSerial = odrive instanceof WebSerialTransport;
  bConn.textContent = isSerial ? 'Conectar ODrive (USB serial)' : (isEsp32 ? 'Conectar à ponte ESP32 (CAN)' : 'Conectar bridge (dev)');
  bConn.onclick = async () => {
    try { await odrive.connect(); onConn(true); log(isSerial ? 'serial conectada (115200 8N1)' : 'bridge/ponte conectada em ' + odrive.url); }
    catch (e) { onConn(false); log('falha: ' + (e && e.message ? e.message : e)); }
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
    id: 'link',
    title: '0. Conexão',
    desc: isEsp32
      ? 'ESP32 como ponte: gerenciamento de até 6 eixos ODrive via CAN (IDs já gravados pelo setup no Windows).'
      : 'Conexão serial direta à ODrive (USB/ASCII) — primeiro setup do atuador: parâmetros, homing e CAN ID.',
    body(b) {
      if (isEsp32) {
        // Modo ESP32: sem serial aqui — o link é WS (CAN por trás). Gerencia todos os eixos do rig.
        bConn.textContent = 'Conectar à ponte ESP32';
        const iNA = num(2, 1, 1);
        const iAxis = sel([], 0);
        const refreshAxes = n => {
          iAxis.innerHTML = '';
          for (let i = 0; i < n; i++) iAxis.append(new Option('Eixo ' + i + ' (CAN node ' + i + ')', i));
          S.axesList = Array.from({ length: n }, (_, i) => i);
        };
        refreshAxes(2);
        iNA.oninput = () => refreshAxes(Math.max(1, Math.min(6, +iNA.value || 2)));
        iAxis.onchange = () => { S.axis = +iAxis.value; };
        const bApplyAx = btn('Aplicar configuração do rig (qtd eixos)', 'primary');
        bApplyAx.onclick = () => {
          S.axesList = Array.from({ length: Math.max(1, Math.min(6, +iNA.value || 2)) }, (_, i) => i);
          S.axis = +iAxis.value;
          document.getElementById('hdr-device').textContent = `ESP32 — ${S.axesList.length} eixo(s), eixo atual ${S.axis}`;
          app.finish('link');
        };
        b.append(note('No ESP32 o uso diário é via esta página. A conexão serial PC↔ODrive só faz sentido para gravar parâmetros/CAN IDs — faça isso pela UI no Windows.', 'info'),
                 grid(field('QD de eixos do rig (1–6)', iNA), field('Eixo em foco', iAxis)),
                 row(bConn),
                 el('hr'),
                 row(bApplyAx));
      } else {
        bConn.textContent = odrive instanceof WebSerialTransport ? 'Conectar ODrive (USB serial)' : 'Conectar bridge (dev)';
        bUse.onclick = () => {
          S.dev = chosen.dev; S.axis = chosen.axis;
          document.getElementById('hdr-device').textContent = `${S.dev} — eixo M${S.axis}`;
          app.finish('link');
        };

        // Apagar toda a configuração da ODrive (começar do zero)
        const bWipe = btn('⚠ Apagar toda a configuração (erase)', 'danger');
        bWipe.onclick = async () => {
          if (!odrive.connected) { log('Conecte à ODrive antes de apagar.' , 'warn'); return; }
          if (!confirm('Isso APAGA permanentemente toda a configuração gravada na flash da ODrive (motor, encoder, homing, CAN). A placa vai reiniciar de fábrica. Continuar?')) return;
          if (!confirm('Confirma novamente: ERASE CONFIGURATION + REBOOT?')) return;
          try {
            bWipe.disabled = true;
            await odrive.action('erase');   // se — erase config
            await odrive.action('reboot');  // sr — reinicia a placa
            log('Configuração apagada. Aguarde o boot (~2s) e Clique novamente em "Conectar ODrive" para recomeçar do zero.');
            onConn(false); odrive.onstate && odrive.onstate(false);
            S.done.delete('link'); app.render();
          } catch (e) { log('Falha ao apagar: ' + e.message); }
          bWipe.disabled = false;
        };
        b.append(row(bConn, bScan), table, row(bUse), el('hr'), row(bWipe),
          note('O botão de apagar só serve se houver configuração antiga travada — use com cautela.', 'warn'));
      }
    },
  });
}

/* ---- 1...7 preenchidas em seguida ---- */

/* ===================== App ===================== */
/* Persistência local (localStorage) dos campos do wizard por etapa — sobrevive a troca de tela/boot/reload */
const LS_KEY = 'odms-wizard-v1';
const lsLoad = () => { try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { return {}; } };
const lsSet = (k, v) => { const o = lsLoad(); o[k] = v; try { localStorage.setItem(LS_KEY, JSON.stringify(o)); } catch {} };

const app = {
  cur: 0,
  _prevStep: null,
  finish(id) { const s = STEPS[this.cur]; if (s && s.canFinish && !s.canFinish()) { return; } S.done.add(id); this.cur = Math.min(this.cur + 1, STEPS.length - 1); this.render(); },
  goto(i) { this.cur = i; this.render(); },
  render() {
    // onLeave da etapa anterior (adesão de timers/telemetria)
    if (this._prevStep && this._prevStep.onLeave) { try { this._prevStep.onLeave(); } catch (e) {} }
    const s = STEPS[this.cur];
    this._prevStep = s;

    const nav = document.getElementById('steps');
    nav.innerHTML = '';
    STEPS.forEach((st, i) => {
      const it = el('div', 'item' + (i === this.cur ? ' active' : '') + (S.done.has(st.id) ? ' done' : ''));
      it.append(el('span', 'n', S.done.has(st.id) ? '✓' : String(i)), el('span', null, st.title));
      it.onclick = () => this.goto(i);
      nav.append(it);
    });
    const page = document.getElementById('page');
    page.innerHTML = '';
    const tpl = document.getElementById('tpl-step').content.cloneNode(true);
    tpl.querySelector('h2').textContent = s.title;
    tpl.querySelector('.desc').textContent = s.desc;
    const bodyEl = tpl.querySelector('.body');
    logbox = el('div', 'log'); logbox.textContent = '';

    // Se a etapa falhar internamente, mostra o erro em vez de tela em branco
    let renderErr = null;
    try { s.body(bodyEl); }
    catch (e) { renderErr = e; }
    if (renderErr) {
      const n = el('div', 'notice err', 'Erro interno nesta etapa: <b>' + (renderErr && renderErr.message) + '</b><br><small>' + (renderErr && renderErr.stack || '') + '</small>');
      bodyEl.append(n);
      console.error(renderErr);
    }

    // Restaura valores salvos e persiste novas edições (mesmo entre troca de etapas)
    const saved = lsLoad();
    bodyEl.querySelectorAll('input, select').forEach((inp, i) => {
      const k = s.id + ':' + i;
      if (saved[k] !== undefined) {
        try {
          if (inp.type === 'checkbox') inp.checked = !!saved[k];
          else if (typeof saved[k] === 'object') inp.value = JSON.stringify(saved[k]);
          else inp.value = saved[k];
        } catch (e) { /* ignora dados de formato antigo */ }
      }
      inp.addEventListener('input', () => lsSet(k, inp.type === 'checkbox' ? inp.checked : inp.value));
    });

    bodyEl.append(logbox);
    tpl.querySelector('.prev').style.display = this.cur === 0 ? 'none' : '';
    tpl.querySelector('.next').style.display = this.cur === STEPS.length - 1 ? 'none' : '';
    tpl.querySelector('.prev').onclick = () => this.goto(this.cur - 1);
    tpl.querySelector('.next').onclick = () => app.finish(s.id);
    page.append(tpl);

    // Leitura automática da ODrive quando conectada: dispara o "Verificar" da etapa automaticamente
    if (odrive.connected) {
      const bVer = [...bodyEl.querySelectorAll('button')].find(x => x.textContent.trim() === 'Verificar');
      if (bVer) bVer.click();
    }
    if (s.onEnter) { try { s.onEnter(); } catch (e) {} }
    // badge: só atualiza se mudou (render não deve chamar onConn(true) para não recursar)
    try {
      const on = odrive.connected || !!(odrive.ws && odrive.ws.readyState === 1);
      _connWas = on; // marca estado p/ onConn não re-disparar render
      const h = document.getElementById('hdr-status');
      h.className = 'badge ' + (on ? 'on' : 'off'); h.textContent = on ? 'online' : 'offline';
    } catch (e) {}
  },
};
let _connWas = false;
function onConn(on) {
  const h = document.getElementById('hdr-status');
  h.className = 'badge ' + (on ? 'on' : 'off'); h.textContent = on ? 'online' : 'offline';
  // re-renderiza SÓ na transição offline→online (evita loop render→onConn→render)
  if (on && !_connWas) { try { app.render(); } catch (e) {} }
  _connWas = !!on;
}
odrive.onstate = onConn;

/* as demais etapas registram-se em STEPS via steps.js */
window.STEPS = STEPS; window._core = { S, el, field, num, sel, btn, grid, row, note, log, odrive, axP, setA, getA, mm2turn, turn2mm, fmt, drawPlot, app, onConn };
document.addEventListener('DOMContentLoaded', () => app.render());
