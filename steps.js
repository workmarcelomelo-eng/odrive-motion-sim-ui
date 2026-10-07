/*
 * ODrive Motion Setup — etapas 1..7 do wizard (a etapa 0, Conexão, vive em app.js).
 * Depende de window._core exportado por app.js:
 *   { S, el, field, num, sel, btn, grid, row, note, log, odrive,
 *     axP, setA, getA, mm2turn, turn2mm, fmt, drawPlot, app }
 *
 * Contrato rígido (etapas 1..6):
 *   - Botões separados "Aplicar" (grava config) e "Verificar" (relê e valida).
 *   - Avanço só com S.stepOk[id] === true, setado por verificação bem-sucedida.
 *
 * Nota sobre protocolo ASCII (transporte serial): odrive.reqState(n) escreve
 *   `w axisN.requested_state n` na linha serial. Erros de leitura da ODrive
 *   (axis.error / motor.error) são flags físicas — exibidas decodificadas em hex.
 */
'use strict';

(function () {
  const { S, el, field, num, sel, btn, grid, row, note, log,
          odrive, setA, getA, mm2turn, turn2mm, fmt, drawPlot, app } = window._core;
  const STEPS = window.STEPS;

  // Estado de validação por etapa: avanço só ocorre quando S.stepOk[id] === true.
  if (!S.stepOk) S.stepOk = {};

  // Aviso exibido quando o "Próximo →" é bloqueado.
  function blockedWarn(bodyEl, id) {
    const old = bodyEl.querySelector('.notice.warn.gate');
    if (old) old.remove();
    const n = note('⚠ Etapa "' + id + '" ainda não verificada — aplique os parâmetros e clique em "Verificar" antes de avançar.', 'warn gate');
    bodyEl.insertBefore(n, bodyEl.firstChild);
    setTimeout(() => n.remove(), 5000);
  }

  // Gate global do botão "Próximo →" (app.finish) respeitando canFinish().
  if (!app.__gated) {
    const origFinish = app.finish.bind(app);
    app.finish = function (id) {
      const st = STEPS.find(s => s.id === id);
      if (st && typeof st.canFinish === 'function' && st.canFinish() !== true) {
        const bodyEl = document.querySelector('#page .body');
        if (bodyEl) blockedWarn(bodyEl, st.title);
        log('Etapa bloqueada: verificação pendente (' + id + ')');
        return;
      }
      origFinish(id);
    };
    app.__gated = true;

    // Garante que onLeave() do passo atual seja chamado ao trocar de etapa.
    const origGoto = app.goto.bind(app);
    app.goto = function (i) {
      const cur = STEPS[app.cur];
      if (cur && typeof cur.onLeave === 'function') {
        try { cur.onLeave(); } catch (e) { /* ignora */ }
      }
      origGoto(i);
    };
  }

  // Diferença tolerante para comparar floats relidos da ODrive.
  const eq = (a, b, tol = 1e-4) => {
    const na = parseFloat(a), nb = parseFloat(b);
    if (isNaN(na) || isNaN(nb)) return String(a) === String(b);
    return Math.abs(na - nb) <= Math.max(tol, Math.abs(nb) * 1e-3);
  };

  // Erros físicos da ODrive em hex para facilitar diagnóstico.
  const hexErr = v => {
    const n = parseInt(v) || 0;
    return n === 0 ? '0' : ('0x' + (n >>> 0).toString(16).toUpperCase());
  };

  // ============ Decodificador de erros para o operador (pt-BR) ============
  // Bitmasks do firmware v0.5.6 (ver tools/odrive/enums.py). Msg formatada "[bit flag] descrição — dica".
  const ERR_AXIS = {
    0x1:  ['INVALID_STATE', 'O eixo não está no estado que a operação exige — provavelmente falta calibração/encoder pronto. Complete Etapas 1–3.'],
    0x40: ['MOTOR_FAILED', 'Falha geral do motor — ver motor.error para detalhe.'],
    0x80: ['SENSORLESS_FAILED', 'Estimador sem sensor falhou — confira os parâmetros motor/encoder.'],
    0x100:['ENCODER_FAILED', 'Falha no encoder — ver encoder.error.'],
    0x200:['CONTROLLER_FAILED', 'Controlador falhou — ver controller.error.'],
    0x800:['WATCHDOG', 'O watchdog expirou — a UI deixou de enviar comando por muito tempo (USB travou ou aba fechada).'],
    0x1000:['MIN_ENDSTOP', 'Endstop mínimo acionado fora de homing — verifique fio/polaridade/GPIO.'],
    0x2000:['MAX_ENDSTOP', 'Endstop máximo acionado fora de homing.'],
    0x4000:['ESTOP_CAN', 'E-stop recebido por CAN — o rig paralisou por segurança.'],
    0x20000:['HOMING_SEM_ENDSTOP', 'Homing requisitado mas nenhum endstop habilitado. Use modo stall-current ou ative GPIO na Etapa 3.'],
    0x40000:['OVER_TEMP_ROM', 'Temperatura excedida — cheque dissipador/ventilação do driver.'],
    0x80000:['POSICAO_INVALIDA', 'Posição do encoder inválida — encoder ainda não pronto ou CPR errado.'],
    0x100000:['HOMING_STALL_NAO_DETECTADO', 'Homing por stall percorreu mais que o curso máx. sem travar — aumente corrente de stall / distância máx / verifique se o fuso trava de verdade no batente.'],
  };
  const ERR_MOTOR = {
    0x1:  ['RESISTENCIA_FORA', 'Resistência de fase medida fora da faixa — verifique os fios do motor e os pole pairs.'],
    0x2:  ['INDUTANCIA_FORA', 'Indutância fora da faixa — recalibre o motor.'],
    0x8:  ['DRV8301_FAULT', 'Falha no driver de potência (DRV8301) — pode indicar curto/resfriamento/alimentação.'],
    0x10: ['DEADLINE_MISSED', 'Controle perdeu o deadline do PWM — reinicie e diminua carga.'],
    0x80: ['MODULACAO_SAT', 'Modulação saturada — tensão de bus/motor incompatível, suba fonte ou revise vel_limit.'],
    0x400:['CORRENTE_SATURADA', 'Sensor de corrente saturado — corrente passou do que o shunt mede; aceite menos corrente_lim.'],
    0x1000:['LIMITE_CORRENTE', 'Motor passou de current_lim em operação normal — aumente a margem ou restrinja velocidade.'],
    0x10000:['MODULACAO_NAN', 'NaN na modulação de fase — falha de software/encoder; reinicie.'],
    0x20000:['TERM_MOTOR_QUENTE', 'Sensor de temperatura do motor excedeu limite.'],
    0x40000:['TERM_FET_QUENTE', 'FETs da ODrive em sobretemperatura — ventile a placa.'],
    0x80000:['TIMER_UPDATE_MISSED', 'Timer do MCU perdeu ciclo — raro; reboot.'],
    0x100000:['CORRENTE_INVALIDA', 'Leitura de corrente indisponível — problema no ADC/offset.'],
    0x200000:['CONTROLLER_CORRENTE', 'Controlador de corrente/FOC in coerente — recalibre o motor.'],
    0x800000:['RESISTOR_FREIO', 'Resistor de dissipação desarmado — corrente de regeneração perigosa.'],
  };
  const ERR_ENCODER = {
    0x1:  ['GANHO_INSTAVEL', 'Ganho de PLL do encoder instável — recalibre o encoder.'],
    0x2:  ['CPR_INCON.VALE', 'CPR do encoder não bate com pole pairs — corrija pole pairs ou cpr.'],
    0x4:  ['SEM_RESPOSTA', 'Encoder não responde — fio/sinal.'],
    0x8:  ['MODO_NAO_SUPORTADO', 'Modo de encoder não suportado neste hardware.'],
    0x10: ['HALL_INVALIDO', 'Estado de Hall ilegal — encoder Hall com problema.'],
    0x20: ['SEM_INDEX_AINDA', 'Busca de index ainda não achou — gire 1 completa ou revise canal Z.'],
    0x40: ['SPI_TIMEOUT', 'Encoder SPI absoluto: timeout.'],
    0x80: ['SPI_COM', 'Encoder SPI absoluto: falha de comunicação.'],
    0x100:['SPI_NAO_PRONTO', 'Encoder SPI absoluto não está pronto.'],
    0x200:['HALL_NAO_CALIBRADO', 'Encoder Hall não calibrado ainda.'],
  };

  const decErr = (kind, v) => {
    const n = parseInt(v) || 0;
    if (!n) return 'sem erros';
    const table = kind === 'motor' ? ERR_MOTOR : kind === 'encoder' ? ERR_ENCODER : ERR_AXIS;
    const parts = [];
    for (const bit of Object.keys(table).map(Number)) {
      if (n & bit) parts.push(`<b>[${table[bit][0]}]</b> ${table[bit][1]}`);
    }
    const desconhecidos = n & ~Object.keys(table).map(Number).reduce((a, b) => a | b, 0);
    if (desconhecidos) parts.push('<b>[?]</b> flags desconhecidas ' + hexErr(desconhecidos));
    return parts.length ? parts.join('<br>') : ('erro ' + hexErr(n));
  };

  // uso: decErr('axis'|'motor'|'encoder', valorLido) — texto já formatado em HTML compacto

  // Espera até que getA(path) satisfaça pred, com timeout.
  function pollUntil(path, pred, timeoutMs = 30000, periodMs = 300) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      (async function tick() {
        let v = null;
        try { v = await getA(path); } catch (e) { /* ignora e tenta de novo */ }
        if (v !== null && v !== undefined && pred(v)) return resolve(v);
        if (Date.now() - t0 > timeoutMs) return reject(new Error('timeout aguardando ' + path + ' (último valor: ' + v + ')'));
        setTimeout(tick, periodMs);
      })();
    });
  }

  /* ===================== 1. Motor ===================== */
  {
    const id = 'motor';
    let iType, iPoles, iIlim, iIcal, iVcal, oR, oL, noteEl;
    let measured = false;

    STEPS.push({
      id,
      title: '1. Motor',
      desc: 'Parâmetros elétricos do motor e medição de resistência/indutância de fase (R & L).',
      canFinish() { return S.stepOk.motor === true; },
      body(b) {
        S.stepOk.motor = false; measured = false;
        iType = sel([[0, 'HIGH_CURRENT (0)'], [2, 'GIMBAL (2)']], 0);
        iPoles = num(7, 1, 1);
        iIlim  = num(20, 0.5, 0);
        iIcal  = num(10, 0.5, 0);
        iVcal  = num(4, 0.5, 0);
        oR = num(); oR.readOnly = true; oR.value = '';
        oL = num(); oL.readOnly = true; oL.value = '';
        noteEl = note('1) Aplique os parâmetros. 2) Meça R & L. 3) Verifique.', 'info');

        const bApply = btn('Aplicar', 'primary');
        const bMeas  = btn('Medir R & L');
        const bVer   = btn('Verificar', 'ok');

        bApply.onclick = async () => {
          try {
            await setA('motor.config.motor_type', +iType.value);
            await setA('motor.config.pole_pairs', +iPoles.value);
            await setA('motor.config.current_lim', +iIlim.value);
            await setA('motor.config.calibration_current', +iIcal.value);
            await setA('motor.config.resistance_calib_max_voltage', +iVcal.value);
            Object.assign(S.profile, {
              motor_type: +iType.value, pole_pairs: +iPoles.value,
              current_lim: +iIlim.value, calibration_current: +iIcal.value,
              resistance_calib_max_voltage: +iVcal.value,
            });
            noteEl.className = 'notice info';
            noteEl.textContent = 'Parâmetros do motor aplicados. Agora clique em "Medir R & L".';
            log('motor: parâmetros aplicados (type=' + iType.value + ', poles=' + iPoles.value + ', Ilim=' + iIlim.value + ')');
          } catch (e) { noteEl.className = 'notice warn'; noteEl.textContent = 'Falha ao aplicar: ' + e.message; log('motor apply falhou: ' + e.message); }
        };

        bMeas.onclick = async () => {
          bMeas.disabled = true;
          noteEl.className = 'notice info';
          noteEl.textContent = 'Medindo R & L… o motor vai emitir um beep e vibrar levemente.';
          try {
            await odrive.reqState(4); // MOTOR_CALIBRATION
            await pollUntil('current_state', s => parseInt(s) === 1, 30000); // volta a IDLE
            const axErr = await getA('error');
            const moErr = await getA('motor.error');
            if ((parseInt(axErr) || 0) !== 0 || (parseInt(moErr) || 0) !== 0) {
              throw new Error('Falha na calibração do motor:<br>' + decErr('axis', axErr) + (moErr ? '<br>' + decErr('motor', moErr) : ''));
            }
            const R = await getA('motor.config.phase_resistance');
            const L = await getA('motor.config.phase_inductance');
            oR.value = R; oL.value = L;
            S.profile.phase_resistance = R; S.profile.phase_inductance = L;
            measured = true;
            S.stepOk.motor = false; // exige nova verificação
            noteEl.className = 'notice ok';
            noteEl.textContent = 'R = ' + fmt(R, 4) + ' Ω, L = ' + fmt(L * 1e6, 1) + ' µH. Clique em "Verificar".';
            log('motor: medida ok R=' + fmt(R, 4) + 'Ω L=' + fmt(L * 1e6, 1) + 'µH');
          } catch (e) {
            noteEl.className = 'notice warn';
            noteEl.textContent = 'Medição falhou: ' + e.message;
            log('motor medida falhou: ' + e.message);
          }
          bMeas.disabled = false;
        };

        bVer.onclick = async () => {
          try {
            const mt = await getA('motor.config.motor_type');
            const pp = await getA('motor.config.pole_pairs');
            const il = await getA('motor.config.current_lim');
            const ic = await getA('motor.config.calibration_current');
            const vc = await getA('motor.config.resistance_calib_max_voltage');
            const ok = eq(mt, iType.value, 0.1) && eq(pp, iPoles.value, 0.1) && eq(il, iIlim.value)
                    && eq(ic, iIcal.value) && eq(vc, iVcal.value);
            if (ok && measured) {
              S.stepOk.motor = true;
              S.done.add(id);
              noteEl.className = 'notice ok';
              noteEl.textContent = '✓ Motor verificado (parâmetros + medição de R & L). Pode avançar.';
              log('motor: verificação ok');
            } else if (ok) {
              noteEl.className = 'notice warn';
              noteEl.textContent = 'Parâmetros conferem, mas falta medir R & L com sucesso.';
            } else {
              S.stepOk.motor = false;
              noteEl.className = 'notice warn';
              noteEl.textContent = 'Verificação FALHOU: valores relidos diferem (type=' + mt + ', poles=' + pp + ', Ilim=' + fmt(il, 1) + ').';
              log('motor: verificação falhou');
            }
          } catch (e) { noteEl.className = 'notice warn'; noteEl.textContent = 'Erro na verificação: ' + e.message; }
        };

        b.append(noteEl,
                 grid(field('Tipo de motor', iType), field('Pole pairs', iPoles),
                      field('Limite de corrente [A]', iIlim), field('Corrente de calibração [A]', iIcal),
                      field('Tensão máx. calib. R [V]', iVcal)),
                 grid(field('Resistência de fase [Ω]', oR), field('Indutância de fase [H]', oL)),
                 row(bApply, bMeas, bVer));
      },
    });
  }

  /* ===================== 2. Atuador (fuso) ===================== */
  {
    const id = 'actuator';

    STEPS.push({
      id,
      title: '2. Atuador (fuso)',
      desc: 'Geometria do fuso de esferas e limites derivados no controlador.',
      canFinish() { return S.stepOk.actuator === true; },
      body(b) {
        S.stepOk.actuator = false;
        const iPitch = num(S.pitch_mm, 0.5, 0.1);
        const iStroke = num(S.stroke_mm, 1, 1);
        const iInv = sel([[0, 'Normal'], [1, 'Invertido']], S.invert ? 1 : 0);
        const iCpr = num(8192, 1, 1);
        const noteEl = note('Passo e curso definem o vel_limit e os fatores mm↔voltas.', 'info');

        const bApply = btn('Aplicar', 'primary');
        const bVer = btn('Verificar', 'ok');

        const velLim = () => Math.max(1, Math.round((+iStroke.value / +iPitch.value) * 2)); // 2x o curso em voltas/s (razoável p/ fuso)

        bApply.onclick = async () => {
          try {
            S.pitch_mm = +iPitch.value; S.stroke_mm = +iStroke.value; S.invert = (+iInv.value === 1);
            await setA('encoder.config.cpr', +iCpr.value);
            await setA('controller.config.vel_limit', velLim());
            await setA('controller.config.pos_gain', 20);
            await setA('controller.config.vel_gain', 0.16);
            Object.assign(S.profile, {
              pitch_mm: S.pitch_mm, stroke_mm: S.stroke_mm, invert: S.invert,
              encoder_cpr: +iCpr.value, vel_limit: velLim(), pos_gain: 20, vel_gain: 0.16,
            });
            noteEl.className = 'notice info';
            noteEl.textContent = 'Atuador aplicado: cpr=' + iCpr.value + ', vel_limit=' + velLim() + ', pos_gain=20, vel_gain=0.16. Clique em "Verificar".';
            log('atuador: cpr=' + iCpr.value + ' vel_limit=' + velLim());
          } catch (e) { noteEl.className = 'notice warn'; noteEl.textContent = 'Falha ao aplicar: ' + e.message; log('atuador apply falhou: ' + e.message); }
        };

        bVer.onclick = async () => {
          try {
            const cpr = await getA('encoder.config.cpr');
            const vl = await getA('controller.config.vel_limit');
            const pg = await getA('controller.config.pos_gain');
            const vg = await getA('controller.config.vel_gain');
            const ok = eq(cpr, iCpr.value, 0.5) && eq(vl, velLim()) && eq(pg, 20) && eq(vg, 0.16);
            if (ok) {
              S.stepOk.actuator = true; S.done.add(id);
              noteEl.className = 'notice ok';
              noteEl.textContent = '✓ Atuador verificado. Pode avançar.';
              log('atuador: verificação ok');
            } else {
              S.stepOk.actuator = false;
              noteEl.className = 'notice warn';
              noteEl.textContent = 'Verificação FALHOU: cpr=' + cpr + ', vel_limit=' + vl + ', pos_gain=' + fmt(pg, 1) + ', vel_gain=' + fmt(vg, 3);
            }
          } catch (e) { noteEl.className = 'notice warn'; noteEl.textContent = 'Erro na verificação: ' + e.message; }
        };

        b.append(noteEl,
                 grid(field('Passo do fuso [mm/volta]', iPitch), field('Curso útil [mm]', iStroke),
                      field('Sentido', iInv), field('Encoder CPR', iCpr)),
                 row(bApply, bVer));
      },
    });
  }

  /* ===================== 3. Calibração / Homing ===================== */
  {
    const id = 'homing';
    let modeSel, boxEnd, boxStall, noteEl;

    STEPS.push({
      id,
      title: '3. Calibração/Homing',
      desc: 'Referência de zero do atuador: endstop (fim de curso físico) ou detecção de batente por corrente.',
      canFinish() { return S.stepOk.homing === true; },
      body(b) {
        S.stepOk.homing = false;
        modeSel = sel([['endstop', 'Endstop (fim de curso)'], ['stall', 'Stall-current (batente)']], 'endstop');

        const eGpio = num(5, 1, 1);
        const eHigh = sel([[0, 'Ativo em LOW'], [1, 'Ativo em HIGH']], 0);
        const eOff = num(0, 0.5);
        const eDeb = num(50, 10, 0);

        const sSpeed = num(1.0, 0.1, 0.1);
        const sCur = num(4.0, 0.5, 0.5);
        const sVel = num(0.2, 0.05, 0.01);
        const sTime = num(0.4, 0.1, 0.05);
        const sOff = num(5.0, 0.5);
        const sMax = num(1.2, 0.1, 0.1);

        boxEnd = el('div');
        boxStall = el('div');
        boxEnd.append(grid(field('GPIO do endstop', eGpio), field('Polaridade', eHigh),
                           field('Offset [mm]', eOff), field('Debounce [ms]', eDeb)));
        boxStall.append(grid(field('Velocidade de homing [turn/s]', sSpeed), field('Corrente de stall [A]', sCur),
                             field('Vel. de stall [turn/s]', sVel), field('Tempo de stall [s]', sTime),
                             field('Offset pós-stall [mm]', sOff), field('Distância máx. [voltas]', sMax)));

        const upd = () => {
          boxEnd.style.display = modeSel.value === 'endstop' ? '' : 'none';
          boxStall.style.display = modeSel.value === 'stall' ? '' : 'none';
        };
        modeSel.onchange = upd; upd();

        noteEl = note('Configure o modo, aplique e execute o homing. O eixo precisa retornar homed sem erros.', 'info');
        const bApply = btn('Aplicar', 'primary');
        const bHome = btn('Executar homing');
        const bVer = btn('Verificar', 'ok');

        bApply.onclick = async () => {
          try {
            const isEnd = modeSel.value === 'endstop';
            await setA('controller.config.homing_mode', isEnd ? 0 : 1); // 0=ENDSTOP (nativo), 1=STALL_CURRENT (mod do firmware)
            if (isEnd) {
              await setA('min_endstop.config.gpio_num', +eGpio.value);
              await setA('min_endstop.config.is_active_high', +eHigh.value === 1);
              await setA('min_endstop.config.offset', mm2turn(+eOff.value));
              await setA('min_endstop.config.debounce_ms', +eDeb.value);
              Object.assign(S.profile, { homing_mode: 'endstop', endstop_gpio: +eGpio.value, endstop_active_high: +eHigh.value === 1, endstop_offset_mm: +eOff.value, endstop_debounce_ms: +eDeb.value });
            } else {
              await setA('controller.config.homing_speed', +sSpeed.value);
              await setA('controller.config.homing_stall_current', +sCur.value);
              await setA('controller.config.homing_stall_vel', +sVel.value);
              await setA('controller.config.homing_stall_time', +sTime.value);
              await setA('controller.config.homing_offset', mm2turn(+sOff.value));
              await setA('controller.config.homing_max_distance', +sMax.value);
              Object.assign(S.profile, { homing_mode: 'stall', homing_speed: +sSpeed.value, homing_stall_current: +sCur.value, homing_stall_vel: +sVel.value, homing_stall_time: +sTime.value, homing_offset_mm: +sOff.value, homing_max_distance: +sMax.value });
            }
            S.stepOk.homing = false;
            noteEl.className = 'notice info';
            noteEl.textContent = 'Configuração de homing aplicada. Execute o homing e depois verifique.';
            log('homing: config aplicada (modo ' + modeSel.value + ')');
          } catch (e) { noteEl.className = 'notice warn'; noteEl.textContent = 'Falha ao aplicar: ' + e.message; log('homing apply falhou: ' + e.message); }
        };

        bHome.onclick = async () => {
          bHome.disabled = true;
          noteEl.className = 'notice info';
          noteEl.textContent = 'Executando homing… o atuador vai se mover até a referência.';
          try {
            await odrive.reqState(6); // HOMING
            await pollUntil('current_state', s => parseInt(s) === 1, 60000, 400);
            const axErr = await getA('error');
            const homed = await getA('is_homed');
            if ((parseInt(axErr) || 1) !== 0) throw new Error('Falha no homing:<br>' + decErr('axis', axErr));
            if (parseInt(homed) !== 1) throw new Error('eixo não reportou is_homed=1');
            S.stepOk.homing = true; S.done.add(id);
            noteEl.className = 'notice ok';
            noteEl.textContent = '✓ Homing concluído: is_homed=1, error=0. Clique em "Verificar" para confirmar.';
            log('homing: ok (is_homed=1)');
          } catch (e) {
            S.stepOk.homing = false;
            noteEl.className = 'notice warn';
            noteEl.textContent = 'Homing falhou: ' + e.message;
            log('homing falhou: ' + e.message);
          }
          bHome.disabled = false;
        };

        bVer.onclick = async () => {
          try {
            const hm = await getA('controller.config.homing_mode');
            const homed = await getA('is_homed');
            const axErr = await getA('error');
            const wantMode = modeSel.value === 'endstop' ? 1 : 2;
            const ok = eq(hm, wantMode, 0.1) && parseInt(homed) === 1 && (parseInt(axErr) || 1) === 0 && S.stepOk.homing === true;
            if (ok) {
              noteEl.className = 'notice ok';
              noteEl.textContent = '✓ Homing verificado (modo=' + modeSel.value + ', homed=1, error=0). Pode avançar.';
              log('homing: verificação ok');
            } else {
              S.stepOk.homing = false; S.done.delete(id);
              noteEl.className = 'notice warn';
              noteEl.innerHTML = 'Verificação FALHOU:<br>modo=' + hm + ' is_homed=' + homed + '<br>erro: ' + decErr('axis', axErr);
            }
          } catch (e) { noteEl.className = 'notice warn'; noteEl.textContent = 'Erro na verificação: ' + e.message; }
        };

        b.append(noteEl, field('Modo de homing', modeSel), boxEnd, boxStall, row(bApply, bHome, bVer));
      },
    });
  }

  /* ===================== 4. Tuning ===================== */
  {
    const id = 'tuning';
    let iPg, iVg, iVi, noteEl;

    const PRESETS = {
      conservador: { pg: 10, vg: 0.10, vi: 0.15 },
      equilibrado: { pg: 20, vg: 0.16, vi: 0.30 },
      agressivo:   { pg: 40, vg: 0.25, vi: 0.50 },
    };

    STEPS.push({
      id,
      title: '4. Tuning',
      desc: 'Ganhos do controlador de posição. Comece conservador; suba só se o movimento ficar lento demais.',
      canFinish() { return S.stepOk.tuning === true; },
      body(b) {
        S.stepOk.tuning = false;
        const preset = sel([['conservador', 'Conservador'], ['equilibrado', 'Equilibrado'], ['agressivo', 'Agressivo']], 'equilibrado');
        iPg = num(20, 1, 0); iVg = num(0.16, 0.01, 0); iVi = num(0.30, 0.01, 0);
        preset.onchange = () => { const p = PRESETS[preset.value]; iPg.value = p.pg; iVg.value = p.vg; iVi.value = p.vi; };

        noteEl = note('Aplique os ganhos, teste em malha fechada e verifique.', 'info');
        const bApply = btn('Aplicar', 'primary');
        const bVer = btn('Verificar', 'ok');
        const bCL = btn('Entrar em malha fechada (8)');
        const bIdle = btn('Sair para IDLE (1)');

        bApply.onclick = async () => {
          try {
            await setA('controller.config.pos_gain', +iPg.value);
            await setA('controller.config.vel_gain', +iVg.value);
            await setA('controller.config.vel_integrator_gain', +iVi.value);
            Object.assign(S.profile, { pos_gain: +iPg.value, vel_gain: +iVg.value, vel_integrator_gain: +iVi.value });
            S.stepOk.tuning = false;
            noteEl.className = 'notice info';
            noteEl.textContent = 'Ganhos aplicados. Teste em malha fechada e clique em "Verificar".';
            log('tuning: pg=' + iPg.value + ' vg=' + iVg.value + ' vi=' + iVi.value);
          } catch (e) { noteEl.className = 'notice warn'; noteEl.textContent = 'Falha ao aplicar: ' + e.message; }
        };

        bVer.onclick = async () => {
          try {
            const pg = await getA('controller.config.pos_gain');
            const vg = await getA('controller.config.vel_gain');
            const vi = await getA('controller.config.vel_integrator_gain');
            const ok = eq(pg, iPg.value) && eq(vg, iVg.value, 1e-3) && eq(vi, iVi.value, 1e-3);
            if (ok) {
              S.stepOk.tuning = true; S.done.add(id);
              noteEl.className = 'notice ok';
              noteEl.textContent = '✓ Ganhos verificados na ODrive. Pode avançar.';
              log('tuning: verificação ok');
            } else {
              S.stepOk.tuning = false;
              noteEl.className = 'notice warn';
              noteEl.textContent = 'Verificação FALHOU: relido pg=' + fmt(pg, 1) + ' vg=' + fmt(vg, 3) + ' vi=' + fmt(vi, 3);
            }
          } catch (e) { noteEl.className = 'notice warn'; noteEl.textContent = 'Erro na verificação: ' + e.message; }
        };

        bCL.onclick = async () => {
          try {
            await odrive.reqState(8); // CLOSED_LOOP_CONTROL
            const st = await getA('current_state');
            const axErr = await getA('error');
            if (parseInt(st) === 8 && (parseInt(axErr) || 1) === 0) {
              log('tuning: malha fechada ativa');
              noteEl.className = 'notice ok';
              noteEl.textContent = 'Malha fechada ativa (state=8, error=0). O motor vai segurar posição — não force o eixo.';
            } else {
              throw new Error('Malha fechada falhou (state=' + st + '):<br>' + decErr('axis', axErr));
            }
          } catch (e) { log('closed-loop falhou: ' + e.message); noteEl.className = 'notice warn'; noteEl.textContent = 'Falha ao entrar em malha fechada: ' + e.message; }
        };

        bIdle.onclick = async () => {
          try {
            await odrive.reqState(1);
            const st = await getA('current_state');
            if (parseInt(st) === 1) log('tuning: volta a IDLE');
            else log('tuning: atenção — state relido = ' + st);
          } catch (e) { log('idle falhou: ' + e.message); }
        };

        b.append(noteEl,
                 grid(field('Preset', preset), field('pos_gain', iPg),
                      field('vel_gain', iVg), field('vel_integrator_gain', iVi)),
                 row(bApply, bVer), row(bCL, bIdle));
      },
    });
  }

  /* ===================== 5. Teste de movimento ===================== */
  {
    const id = 'motiontest';
    let cv, noteEl, timer = null, plotTimer = null;

    // alimenta o plot com telemetria ao vivo
    const onTel = () => { if (cv) drawPlot(cv); };

    async function jog(mm) {
      const pos = await getA('encoder.pos_estimate');
      const alvo = (pos || 0) + mm2turn(mm);
      await setA('controller.config.input_mode', 6);   // TRAP_TRAJ
      await setA('controller.config.control_mode', 3); // POSITION_CONTROL
      await setA('controller.input_pos', alvo);        // (não input_position)
      log('jog ' + (mm > 0 ? '+' : '') + mm + ' mm (alvo=' + fmt(turn2mm(alvo), 1) + ' mm)');
    }

    async function ensureClosedLoop() {
      const st = await getA('current_state');
      if (parseInt(st) !== 8) await odrive.reqState(8);
    }

    STEPS.push({
      id,
      title: '5. Teste de movimento',
      desc: 'Jog em malha fechada, varredura do curso e acompanhamento ao vivo no gráfico.',
      canFinish() { return S.stepOk.motiontest === true; },
      onLeave() {
        if (timer) { clearTimeout(timer); timer = null; }
        if (plotTimer) { clearInterval(plotTimer); plotTimer = null; }
        if (S.onTelemetry === onTel) S.onTelemetry = null;
        odrive.unsubscribe();
      },
      body(b) {
        S.stepOk.motiontest = false;
        const iJog = num(10, 1, 1);
        noteEl = note('Entre em malha fechada e use o jog. A varredura exige homing concluído.', 'info');

        cv = el('canvas', 'plot');
        cv.style.width = '100%'; cv.style.height = '160px';
        S.onTelemetry = onTel;
        odrive.subscribe(50);
        plotTimer = setInterval(() => drawPlot(cv), 100);

        const bCL = btn('Malha fechada (8)');
        const bNeg = btn('◀ Jog −');
        const bPos = btn('Jog + ▶');
        const bSweep = btn('Varredura 0 → curso → 0');
        const bStop = btn('STOP', 'warn');
        const bVer = btn('Verificar', 'ok');

        bCL.onclick = async () => {
          try {
            await odrive.reqState(8);
            const st = await getA('current_state');
            if (parseInt(st) !== 8) throw new Error('state relido = ' + st);
            noteEl.className = 'notice ok';
            noteEl.textContent = 'Malha fechada ativa. Use o jog.';
          } catch (e) { noteEl.className = 'notice warn'; noteEl.textContent = 'Falha: ' + e.message; }
        };

        bNeg.onclick = async () => { try { await jog(-Math.abs(+iJog.value || 10)); } catch (e) { log('jog falhou: ' + e.message); } };
        bPos.onclick = async () => { try { await jog(Math.abs(+iJog.value || 10)); } catch (e) { log('jog falhou: ' + e.message); } };

        bSweep.onclick = async () => {
          try {
            const homed = await getA('is_homed');
            if (parseInt(homed) !== 1) {
              noteEl.className = 'notice warn';
              noteEl.textContent = 'Varredura bloqueada: is_homed != 1. Faça o homing na etapa 3.';
              return;
            }
            bSweep.disabled = true;
            noteEl.className = 'notice info';
            noteEl.textContent = 'Varredura em andamento: 0 → curso → 0…';
            await ensureClosedLoop();
            await setA('controller.config.input_mode', 6);
            await setA('controller.config.control_mode', 3);
            const wait = ms => new Promise(r => { timer = setTimeout(r, ms); });
            await setA('controller.input_pos', mm2turn(0));            await wait(2500);
            await setA('controller.input_pos', mm2turn(S.stroke_mm));  await wait(4000);
            await setA('controller.input_pos', mm2turn(0));            await wait(4000);
            noteEl.className = 'notice ok';
            noteEl.textContent = 'Varredura concluída. Clique em "Verificar".';
            log('varredura 0→' + S.stroke_mm + 'mm→0 concluída');
            bSweep.disabled = false;
          } catch (e) {
            noteEl.className = 'notice warn';
            noteEl.textContent = 'Varredura falhou: ' + e.message;
            bSweep.disabled = false;
          }
        };

        bStop.onclick = async () => {
          try {
            await odrive.reqState(1); // IDLE — para tudo
            const axErr = await getA('error');
            log('STOP acionado (state=1): ' + decErr('axis', axErr));
            noteEl.className = 'notice warn';
            noteEl.textContent = 'STOP: eixo em IDLE. Malha fechada desligada.';
          } catch (e) { log('stop falhou: ' + e.message); }
        };

        bVer.onclick = async () => {
          try {
            const st = await getA('current_state');
            const axErr = await getA('error');
            const ok = parseInt(st) === 8 && (parseInt(axErr) || 1) === 0;
            if (ok) {
              S.stepOk.motiontest = true; S.done.add(id);
              noteEl.className = 'notice ok';
              noteEl.textContent = '✓ Movimento ok: eixo em malha fechada sem erros. Pode avançar.';
              log('motiontest: verificação ok (state=8)');
            } else {
              S.stepOk.motiontest = false;
              noteEl.className = 'notice warn';
              noteEl.innerHTML = 'Verificação FALHOU: state=' + st + ' (esperado 8)<br>erro: ' + decErr('axis', axErr) + '. Faça um jog antes de verificar.';
            }
          } catch (e) { noteEl.className = 'notice warn'; noteEl.textContent = 'Erro na verificação: ' + e.message; }
        };

        b.append(noteEl, cv,
                 grid(field('Passo do jog [mm]', iJog)),
                 row(bCL, bNeg, bPos, bStop),
                 row(bSweep, bVer));
      },
    });
  }

  /* ===================== 6. Salvar & CAN ===================== */
  {
    const id = 'save';

    const BAUDS = [[125000, '125 k'], [250000, '250 k (padrão)'], [500000, '500 k'], [1000000, '1 M']];

    STEPS.push({
      id,
      title: '6. Salvar & CAN',
      desc: 'Grava os parâmetros em flash, configura o barramento CAN e exporta/importa o perfil.',
      canFinish() { return S.stepOk.save === true; },
      body(b) {
        S.stepOk.save = false;
        const iNode = num(S.axis, 1, 0);   // EDITÁVEL (era o bug: estava readonly)
        const iBaud = sel(BAUDS, 250000);
        const noteEl = note('Configure o node_id do CAN igual à posição do eixo no rig (0..5).', 'info');

        const bApply = btn('Aplicar', 'primary');
        const bVer = btn('Verificar', 'ok');
        const bFlash = btn('Salvar em flash + reboot', 'warn');

        const ta = el('textarea'); ta.rows = 6; ta.style.width = '100%';
        ta.placeholder = 'perfil JSON (exportar/importar)';
        const bExp = btn('Exportar perfil');
        const bImp = btn('Importar perfil');

        bApply.onclick = async () => {
          try {
            const node = parseInt(iNode.value);
            if (isNaN(node) || node < 0 || node > 62) throw new Error('node_id deve ser inteiro entre 0 e 62');
            await odrive.set(axP('config.can.node_id'), node);     // node_id é por-eixo
            await odrive.set('can.config.baud_rate', +iBaud.value); // baud é do dispositivo (raiz)
            S.profile.can_node_id = node; S.profile.can_baud_rate = +iBaud.value;
            S.stepOk.save = false;
            noteEl.className = 'notice info';
            noteEl.textContent = 'CAN aplicado (node_id=' + node + ', baud=' + iBaud.value + '). Verifique antes de salvar em flash.';
            log('can: node_id=' + node + ' baud=' + iBaud.value);
          } catch (e) { noteEl.className = 'notice warn'; noteEl.textContent = 'Falha ao aplicar: ' + e.message; }
        };

        bVer.onclick = async () => {
          try {
            const nid = await getA('config.can.node_id');
            const ok = eq(nid, parseInt(iNode.value), 0.1);
            if (ok) {
              S.stepOk.save = true; S.done.add(id);
              noteEl.className = 'notice ok';
              noteEl.textContent = '✓ CAN verificado (node_id=' + nid + '). Pode salvar em flash e avançar.';
              log('can: verificação ok (node_id=' + nid + ')');
            } else {
              S.stepOk.save = false;
              noteEl.className = 'notice warn';
              noteEl.textContent = 'Verificação FALHOU: node_id relido=' + nid + ', esperado=' + iNode.value + '.';
            }
          } catch (e) { noteEl.className = 'notice warn'; noteEl.textContent = 'Erro na verificação: ' + e.message; }
        };

        bFlash.onclick = async () => {
          if (!confirm('Gravar configuração em flash e reiniciar a ODrive? A conexão serial vai cair.')) return;
          try {
            bFlash.disabled = true;
            await odrive.action('save');
            log('flash: save ok, reiniciando…');
            await odrive.action('reboot');
            noteEl.className = 'notice ok';
            noteEl.textContent = 'Configuração gravada em flash e ODrive reiniciada. Reconecte quando necessário.';
          } catch (e) { noteEl.className = 'notice warn'; noteEl.textContent = 'Falha ao salvar: ' + e.message; }
          bFlash.disabled = false;
        };

        bExp.onclick = () => {
          S.profile.axis = S.axis;
          S.profile.exported_at = new Date().toISOString();
          ta.value = JSON.stringify(S.profile, null, 2);
          log('perfil exportado (' + Object.keys(S.profile).length + ' chaves)');
        };

        bImp.onclick = () => {
          try {
            const p = JSON.parse(ta.value);
            if (typeof p !== 'object' || !p) throw new Error('JSON inválido');
            if (p.pitch_mm) S.pitch_mm = p.pitch_mm;
            if (p.stroke_mm) S.stroke_mm = p.stroke_mm;
            if (p.invert !== undefined) S.invert = !!p.invert;
            if (p.can_node_id !== undefined) iNode.value = p.can_node_id;
            if (p.can_baud_rate) iBaud.value = p.can_baud_rate;
            S.profile = p;
            log('perfil importado — revise os campos e aplique');
          } catch (e) { log('import falhou: ' + e.message); }
        };

        b.append(noteEl,
                 grid(field('CAN node_id (0–62)', iNode), field('CAN baud rate', iBaud)),
                 row(bApply, bVer, bFlash),
                 el('hr'), ta, row(bExp, bImp));
      },
    });
  }

  /* ===================== 7. Monitoramento ===================== */
  {
    const id = 'monitor';
    let cv = null, pollTimer = null, drawTimer = null, table = null;

    function makeTable(axes) {
      const t = el('table', 'list');
      t.innerHTML = '<tr><th>Eixo</th><th>Pos [mm]</th><th>Vel [mm/s]</th><th>Iq [A]</th><th>Estado</th><th>Erro</th><th>Vbus [V]</th></tr>';
      axes.forEach(a => {
        const tr = t.insertRow();
        tr.insertCell().textContent = 'M' + a;
        for (let i = 0; i < 6; i++) tr.insertCell().textContent = '—';
      });
      return t;
    }

    async function pollAll(axes) {
      const prevAxis = S.axis;
      try {
        const vb = await odrive.get('vbus_voltage');
        for (let k = 0; k < axes.length; k++) {
          S.axis = axes[k];
          const tr = table.rows[k + 1];
          try {
            const pos = await getA('encoder.pos_estimate');
            const vel = await getA('encoder.vel_estimate');
            const iq  = await getA('motor.Iq_measured');
            const st  = await getA('current_state');
            const err = await getA('error');
            tr.cells[1].textContent = pos === null ? '—' : fmt(turn2mm(pos), 1);
            tr.cells[2].textContent = vel === null ? '—' : fmt(turn2mm(vel), 1);
            tr.cells[3].textContent = iq === null ? '—' : fmt(iq, 2);
            tr.cells[4].textContent = st === null ? '—' : String(st);
            tr.cells[5].innerHTML = decErr('axis', err);
            tr.cells[5].className = (parseInt(err) || 0) !== 0 ? 'err' : '';
            tr.cells[6].textContent = vb === null ? '—' : fmt(vb, 1);
          } catch (e) {
            tr.cells[1].textContent = 'erro';
          }
        }
      } finally {
        S.axis = prevAxis;
      }
    }

    const onTelMon = () => { if (cv) drawPlot(cv); };

    STEPS.push({
      id,
      title: '7. Monitoramento',
      desc: 'Acompanhamento contínuo de todos os eixos do rig. Sem bloqueio de avanço.',
      // sem gating
      body(b) {
        const axes = S.axesList && S.axesList.length ? S.axesList : [S.axis];
        table = makeTable(axes);
        cv = el('canvas', 'plot');
        cv.style.width = '100%'; cv.style.height = '160px';

        S.onTelemetry = onTelMon;
        odrive.subscribe(200);
        pollTimer = setInterval(() => pollAll(axes), 200);
        drawTimer = setInterval(() => { if (cv) drawPlot(cv); }, 200);

        const bHomeAll = btn('Reboot & Home em todos', 'warn');
        bHomeAll.onclick = async () => {
          if (!confirm('Reiniciar e executar homing em TODOS os eixos do rig?')) return;
          const prev = S.axis;
          try {
            for (const a of axes) {
              S.axis = a;
              log('monitor: reboot eixo M' + a + '…');
              try { await odrive.action('reboot'); } catch (e) { log('reboot M' + a + ': ' + e.message); }
            }
            await new Promise(r => setTimeout(r, 3000));
            for (const a of axes) {
              S.axis = a;
              log('monitor: homing eixo M' + a + '…');
              try {
                await odrive.reqState(6);
                await pollUntil('current_state', s => parseInt(s) === 1, 60000, 400);
                const err = await getA('error');
                log('monitor: M' + a + ' fim de homing — ' + decErr('axis', err));
              } catch (e) { log('homing M' + a + ' falhou: ' + e.message); }
            }
          } finally { S.axis = prev; }
        };

        b.append(note('Leitura a cada 200 ms. Erros são flags físicas da ODrive (hex).', 'info'),
                 table, cv, row(bHomeAll));
      },
      onLeave() {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        if (drawTimer) { clearInterval(drawTimer); drawTimer = null; }
        if (S.onTelemetry === onTelMon) S.onTelemetry = null;
        odrive.unsubscribe();
      },
    });
  }
})();
