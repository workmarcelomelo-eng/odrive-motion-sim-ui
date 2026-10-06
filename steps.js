/*
 * ODrive Motion Setup — etapas do wizard (registradas em window.STEPS).
 * Depende de window._core exportado por app.js (helpers DOM, S, odrive, setA/getA…).
 *
 * Protocolo (mesmo para WSTransport e WebSerialTransport):
 *   odrive.get('axis0.motor.config.pole_pairs') / odrive.set(path, value)
 *   odrive.reqState(n) — AXIS_STATE_*: 1 IDLE, 4 MOTOR_CALIBRATION, 5 ENCODER_INDEX_SEARCH,
 *                        6 HOMING (fw custom), 8 CLOSED_LOOP_CONTROL
 *
 * Passos implementados aqui:
 *   1. Motor        — tipo, pole_pairs, R/L + botão "Medir R & L"
 *   2. Atuador      — fuso de esferas: pitch e curso
 *   3. Calibração   — endstop (fim de curso) ou stall-current (batente)
 *   4. Tuning       — pos/vel/vel_integrator gains + presets + entrada em closed-loop (8)
 *
 * Nota: requested_state 7 não existe no firmware ODrive padrão (é reservado);
 * closed-loop é 8 (AXIS_STATE_CLOSED_LOOP_CONTROL). O passo de tuning oferece
 * botões para IDLE(1), calibração de encoder(5), homing(6) e closed-loop(8).
 */
'use strict';

(function () {
  const { S, el, field, num, sel, btn, grid, row, note, log, odrive, axP, setA, getA, mm2turn, turn2mm, fmt, drawPlot, app } = window._core;
  const STEPS = window.STEPS;

  // IDs de estado do eixo (firmware 0.5.x)
  const AXIS = { IDLE: 1, MOTOR_CALIB: 4, ENCODER_INDEX: 5, HOMING: 6, CLOSED_LOOP: 8 };
  const MOTOR_TYPES = [[0, 'Motor grande / alto torque (MOTOR_TYPE_HIGH_CURRENT)'], [2, 'Gimbal (MOTOR_TYPE_GIMBAL)']];

  const statusLine = () => { const n = note('', 'info'); n.id = 'step-status'; return n; };
  const setStatus = (txt, kind = 'info') => {
    const n = document.getElementById('step-status');
    if (n) { n.className = 'notice ' + kind; n.textContent = txt; }
    log(txt);
  };

  /* =====================================================================
   * 1. MOTOR — tipo, parâmetros elétricos, medição automática de R & L
   * ===================================================================== */
  {
    let iType, iPoles, iR, iL, iCurLim, iCalCur, bMeasure, measured = { R: false, L: false };

    async function measureRL() {
      if (!S.dev) { setStatus('Selecione primeiro um atuador na etapa 0.', 'err'); return; }
      bMeasure.disabled = true;
      measured = { R: false, L: false };
      try {
        // 1) roda MOTOR_CALIBRATION(4): a ODrive mede fase R/L com spin-dir identificação
        setStatus('Salvando tipo de motor e corrente de calibração…');
        await setA('motor.config.motor_type', Number(iType.value));
        await setA('motor.config.pole_pairs', Number(iPoles.value || 7));
        await setA('motor.config.current_lim', Number(iCurLim.value || 10));
        await setA('motor.config.calibration_current', Number(iCalCur.value || 10));
        await setA('motor.config.resistance_calib_max_voltage', Number(iCalCur.value || 10) / 2);

        setStatus('Solicitando MOTOR_CALIBRATION (estado 4)…');
        await odrive.reqState(AXIS.MOTOR_CALIB);

        // 2) aguarda o eixo voltar a IDLE (polling de current_state)
        const t0 = Date.now();
        let st = AXIS.MOTOR_CALIB;
        while (Date.now() - t0 < 20000) {
          await new Promise(r => setTimeout(r, 500));
          st = await getA('current_state');
          if (st === AXIS.IDLE) break;
        }
        if (st !== AXIS.IDLE) { setStatus('Timeout na calibração — verifique motor/config', 'err'); return; }

        // 3) erro de calibração?
        const err = await getA('error');
        const mErr = await getA('motor.error');
        if (err || mErr) { setStatus(`Calibração falhou — axis.error=0x${Number(err).toString(16)} motor.error=0x${Number(mErr).toString(16)}`, 'err'); return; }

        // 4) lê R/L medidos
        const R = await getA('motor.config.phase_resistance');
        const L = await getA('motor.config.phase_inductance');
        measured.R = true; measured.L = true;
        S.profile.motor = { type: Number(iType.value), pole_pairs: Number(iPoles.value), R, L, current_lim: Number(iCurLim.value) };
        iR.value = fmt(R, 6); iL.value = fmt(L, 9);
        setStatus(`Medido! R = ${fmt(R, 5)} Ω  ·  L = ${fmt(L * 1e6, 1)} µH`, 'ok');
      } catch (e) {
        setStatus('Falha na medição: ' + e.message, 'err');
      } finally { bMeasure.disabled = false; }
    }

    STEPS.push({
      id: 'motor', title: '1. Motor', desc: 'Tipo do motor e parâmetros elétricos (pole pairs, resistência e indutância de fase).',
      body(b) {
        iType   = sel(MOTOR_TYPES, 0);
        iPoles  = num(7, 1, 1);
        iR      = num(0, 'any', 0); iR.readOnly = true;
        iL      = num(0, 'any', 0); iL.readOnly = true;
        iCurLim = num(10, 0.5, 0);
        iCalCur = num(10, 0.5, 0);
        bMeasure = btn('Medir R & L', 'primary');
        bMeasure.onclick = measureRL;

        b.append(
          note('A medição automática gira/energiza as fases — deixe a carga livre para mover.', 'warn'),
          grid(
            field('Tipo do motor', iType),
            field('Pole pairs (pares de polos)', iPoles),
          ),
          grid(
            field('Corrente limite [A]', iCurLim),
            field('Corrente de calibração [A]', iCalCur),
          ),
          grid(
            field('Resistência de fase R [Ω]', iR),
            field('Indutância de fase L [H]', iL),
          ),
          row(bMeasure),
          statusLine(),
        );
      },
      canFinish: () => measured.R && measured.L ? true : (setStatus('Meça R & L antes de avançar.', 'warn') || false),
    });
  }

  /* =====================================================================
   * 2. ATUADOR — fuso de esferas: passo (mm/volta) e curso útil (mm)
   * ===================================================================== */
  {
    let iPitch, iStroke, iInvert, vInfo;
    STEPS.push({
      id: 'actuator', title: '2. Atuador (fuso de esferas)', desc: 'Geometria do fuso que converte rotação do motor em deslocamento linear.',
      body(b) {
        iPitch  = num(S.pitch_mm, 0.1, 0.01);
        iStroke = num(S.stroke_mm, 1, 1);
        iInvert = document.createElement('input'); iInvert.type = 'checkbox'; iInvert.checked = S.invert;
        vInfo = note('', 'info');

        const update = () => {
          S.pitch_mm = Number(iPitch.value || 5);
          S.stroke_mm = Number(iStroke.value || 150);
          S.invert = iInvert.checked;
          const turns = mm2turn(S.stroke_mm);
          vInfo.textContent = `Curso de ${fmt(S.stroke_mm, 0)} mm = ${fmt(turns, 2)} voltas do motor · velocidade reference: 1 volta/s ↦ ${fmt(S.pitch_mm, 1)} mm/s`;
          S.profile.actuator = { pitch_mm: S.pitch_mm, stroke_mm: S.stroke_mm, invert: S.invert };
        };
        [iPitch, iStroke, iInvert].forEach(x => x.oninput = update);
        update();

        b.append(
          grid(
            field('Passo do fuso [mm/volta]', iPitch),
            field('Curso útil [mm]', iStroke),
          ),
          field('Inverter direção (+ = recuar)', iInvert),
          vInfo,
          note(`O encoder deve reportar múltiplas voltas (use circular ou absoluto com multi-turn).`, 'info'),
        );
      },
      onFinish() { /* persiste a geometria em S (já feito em update) */ },
    });
  }

  /* =====================================================================
   * 3. CALIBRAÇÃO DE ESTADO — homing por endstop OU por stall-current
   * ===================================================================== */
  {
    let mode = 'endstop'; // 'endstop' | 'stall'
    let eDelay, eDir, eOffset, eIdx, ePolarity;                    // endstop
    let sIq, sVel, sMinVel, sTime, sMinDist, sDir, sOffset;       // stall
    let bRun, bodyEl;

    const endstopPanel = () => grid(
      field('Pino do endstop (GPIO)', eIdx),
      field('Polaridade (1=fechado)', ePolarity),
      field('Direção do homing (-1=min, 1=max)', eDir),
      field('Debounce [ms]', eDelay),
      field('Offset após homing [mm]', eOffset),
    );

    const stallPanel = () => grid(
      field('Corrente de stall Iq [A]', sIq),
      field('Velocidade de homing [turns/s]', sVel),
      field('Vel. mín. para detectar batente [turns/s]', sMinVel),
      field('Tempo de confirmação [ms]', sTime),
      field('Distância mínima de prova [mm]', sMinDist),
      field('Direção (-1=min, 1=max)', sDir),
      field('Offset após homing [mm]', sOffset),
    );

    async function runHoming() {
      if (!S.dev) { setStatus('Selecione um atuador na etapa 0.', 'err'); return; }
      bRun.disabled = true;
      try {
        // >>> configurar modo escolhido <<<
        if (mode === 'endstop') {
          log('Configurando homing por ENDSTOP…');
          await setA('min_endstop.config.enabled', 1);
          await setA('min_endstop.config.gpio_num', Number(eIdx.value || 2));
          await setA('min_endstop.config.is_active_high', Number(ePolarity.value || 1));
          await setA('min_endstop.config.offset',-mm2turn(Number(eOffset.value || 0)));
          await setA('min_endstop.config.debounce_ms', Number(eDelay.value || 50));
          await setA('encoder.config.use_index', Number(eIdx.value ? 0 : 0)); // endstop não usa index
        } else {
          log('Configurando homing por STALL-CURRENT (batente)…');
          await setA('min_endstop.config.enabled', 0); // sem endstop físico
          // parâmetros de stall-homing gravados via trap_traj/min_endstop custom ou config dedicada do firmware
          await setA('stall_homing.config.iq_thres', Number(sIq.value || 2));           // corrente de stall
          await setA('stall_homing.config.vel', mm2turn(1) * Number(sVel.value || 1));  // turn/s desejados
          await setA('stall_homing.config.min_vel_detect', Number(sMinVel.value || 0.1));
          await setA('stall_homing.config.confirm_time_ms', Number(sTime.value || 100));
          await setA('stall_homing.config.min_probe_dist', mm2turn(Number(sMinDist.value || 10)));
          await setA('stall_homing.config.dir', Number(sDir.value || -1));
          await setA('stall_homing.config.offset', mm2turn(Number(sOffset.value || 1)));
        }
        await setA('encoder.config.mode', 0); // encoder incremental padrão do atuador

        // >>> sequência: index (opcional) → homing <<<
        setStatus('Entrando em HOMING (estado 6)… siga o movimento, carga livre!', 'warn');
        await odrive.reqState(AXIS.HOMING);

        const t0 = Date.now(); let st = AXIS.HOMING;
        while (Date.now() - t0 < 45000) {
          await new Promise(r => setTimeout(r, 500));
          st = await getA('current_state');
          if (st === AXIS.IDLE) break;
        }
        const err = await getA('error');
        if (st !== AXIS.IDLE || err) {
          setStatus(`Homing falhou — state=${st} axis.error=0x${Number(err || 0).toString(16)} encoder.erro=${await getA('encoder.error')}`, 'err');
        } else {
          const pos = await getA('encoder.pos_estimate');
          setStatus(`Homing OK — posição zero definida. pos_estimate = ${fmt(turn2mm(pos), 2)} mm`, 'ok');
        }
      } catch (e) { setStatus('Homing: ' + e.message, 'err'); }
      finally { bRun.disabled = false; }
    }

    STEPS.push({
      id: 'calibration', title: '3. Calibração de Estado (homing)', desc: 'Define a posição zero do atuador — por chave de fim de curso (endstop) ou por batente com detecção de corrente (stall).',
      body(b) {
        bodyEl = b;
        // endstop defaults
        eIdx = num(2, 1, 0); ePolarity = sel([[1, 'Ativo alto (1)'], [0, 'Ativo baixo (0)']], 1);
        eDir = sel([[-1, '−1 (recua até o fim mínimo)'], [1, '+1 (avança ao fim máximo)']], -1);
        eDelay = num(50, 10, 0); eOffset = num(2, 0.5);
        // stall defaults
        sIq = num(2, 0.1, 0.1); sVel = num(1, 0.1, 0.1); sMinVel = num(0.1, 0.05, 0);
        sTime = num(100, 10, 10); sMinDist = num(10, 1, 1);
        sDir = sel([[-1, '−1 (recua até batente)'], [1, '+1 (avança até batente)']], -1);
        sOffset = num(1, 0.5);

        const bEndstop = btn('Endstop (chave de fim de curso)', mode === 'endstop' ? 'primary' : '');
        const bStall = btn('Stall-current (batente, sem chave)', mode === 'stall' ? 'primary' : '');
        const panel = el('div');
        const bRun = btn('Executar homing', 'ok');
        bRun.onclick = null; // definido abaixo
        bEndstop.onclick = () => { mode = 'endstop'; bEndstop.className = 'primary'; bStall.className = ''; panel.innerHTML = ''; panel.append(endstopPanel(), note('Requer chave micro-switch em um dos fins de curso ligado a um GPIO da ODrive.', 'info')); };
        bStall.onclick = () => { mode = 'stall'; bStall.className = 'primary'; bEndstop.className = ''; panel.innerHTML = ''; panel.append(stallPanel(), note('Sem hardware: o motor avança até travar mecanicamente; a subida de corrente define o limite. Use corrente baixa!', 'warn')); };
        bEndstop.onclick();
        bRun.onclick = runHoming;

        b.append(row(bEndstop, bStall), panel, row(bRun), statusLine());
      },
    });
  }

  /* =====================================================================
   * 4. TUNING — ganhos do cascata pos/vel + presets + teste em closed-loop
   * ===================================================================== */
  {
    let iPos, iVel, iInt, bApply, bClosed, bIdle, bStepTgt, cv, liveTimer;
    const PRESETS = {
      conservador: { pos: 10, vel: 0.08, int: 0.2, desc: 'Suave, sem overshoot. Bom para primeiros testes e cargas com folga.' },
      equilibrado: { pos: 20, vel: 0.16, int: 0.32, desc: 'Padrão ODrive — bom compromisso entre rigidez e estabilidade.' },
      agressivo: { pos: 40, vel: 0.32, int: 0.6, desc: 'Resposta rápida e rígida. Exige mecânica firme — risco de oscilação.' },
    };
    let curPreset = 'equilibrado';

    async function applyGains() {
      try {
        await setA('controller.config.pos_gain', Number(iPos.value));
        await setA('controller.config.vel_gain', Number(iVel.value));
        await setA('controller.config.vel_integrator_gain', Number(iInt.value));
        S.profile.tuning = { pos_gain: +iPos.value, vel_gain: +iVel.value, vel_integrator_gain: +iInt.value, preset: curPreset };
        setStatus(`Ganhos aplicados: pos=${fmt(iPos.value, 1)} vel=${fmt(iVel.value, 3)} int=${fmt(iInt.value, 3)} (${curPreset})`, 'ok');
      } catch (e) { setStatus('Falha ao aplicar ganhos: ' + e.message, 'err'); }
    }

    async function enterClosedLoop() {
      try {
        setStatus('Solicitando CLOSED_LOOP_CONTROL (estado 8)…', 'warn');
        await odrive.reqState(AXIS.CLOSED_LOOP);
        await new Promise(r => setTimeout(r, 300));
        const st = await getA('current_state');
        const err = await getA('error');
        if (Number(st) === AXIS.CLOSED_LOOP) {
          setStatus('Closed-loop ATIVO — o motor segue pos_setpoint. Use o botão de passo para testar.', 'ok');
        } else {
          setStatus(`Não entrou em closed-loop — state=${st} error=0x${Number(err || 0).toString(16)}. Calibração pendente?`, 'err');
        }
      } catch (e) { setStatus('Closed-loop: ' + e.message, 'err'); }
    }

    async function exitToIdle() {
      await odrive.reqState(AXIS.IDLE);
      setStatus('Eixo em IDLE — energia desligada das fases.', 'info');
    }

    async function stepTarget(mm) {
      const cur = await getA('controller.input_pos') ?? 0;
      await setA('controller.input_mode', 5); // INPUT_MODE_TRAP_TRAJ
      await setA('controller.input_pos', cur + mm2turn(mm));
      setStatus(`Comando: +${mm} mm → input_pos = ${fmt(turn2mm(cur + mm2turn(mm)), 2)} mm`, 'info');
    }

    STEPS.push({
      id: 'tuning', title: '4. Tuning de Controle', desc: 'Ganhos do controlador em cascata (posição → velocidade → corrente) e teste do servo em malha fechada.',
      body(b) {
        const p = PRESETS[curPreset];
        iPos = num(p.pos, 1, 0); iVel = num(p.vel, 0.01, 0); iInt = num(p.int, 0.01, 0);

        const makePresetBtn = (key, label) => {
          const bp = btn(label, key === curPreset ? 'primary' : '');
          bp.onclick = () => {
            curPreset = key;
            iPos.value = PRESETS[key].pos; iVel.value = PRESETS[key].vel; iInt.value = PRESETS[key].int;
            [...presetRow.children].forEach(x => x.className = ''); bp.className = 'primary';
            dDesc.textContent = PRESETS[key].desc;
          };
          return bp;
        };
        const presetRow = row(
          makePresetBtn('conservador', 'Conservador'),
          makePresetBtn('equilibrado', 'Equilibrado'),
          makePresetBtn('agressivo', 'Agressivo'),
        );
        const dDesc = note(PRESETS[curPreset].desc, 'info');

        bApply = btn('Aplicar ganhos', 'primary'); bApply.onclick = applyGains;
        bClosed = btn('Entrar em closed-loop (8)', 'ok'); bClosed.onclick = enterClosedLoop;
        bIdle = btn('Sair para IDLE (1)'); bIdle.onclick = exitToIdle;
        const bP10 = btn('+10 mm'); bP10.onclick = () => stepTarget(+10);
        const bM10 = btn('−10 mm'); bM10.onclick = () => stepTarget(-10);
        const bP50 = btn('+50 mm'); bP50.onclick = () => stepTarget(+50);
        const bM50 = btn('−50 mm'); bM50.onclick = () => stepTarget(-50);

        cv = el('canvas', 'plot');
        cv.width = 640; cv.height = 120;
        odrive.subscribe(50).then(() => { liveTimer = setInterval(() => drawPlot(cv), 50); }).catch(() => {});

        b.append(
          presetRow, dDesc,
          grid(
            field('pos_gain [(turn/s)/turn]', iPos),
            field('vel_gain [A·s/turn]', iVel),
            field('vel_integrator_gain [A/turn]', iInt),
          ),
          row(bApply),
          note('Após aplicar, entre em closed-loop e teste com passos de posição. A curva azul (posição) deve seguir a laranja (alvo) sem oscilação persistente.', 'info'),
          row(bClosed, bIdle),
          row(bM50, bM10, bP10, bP50),
          cv,
          statusLine(),
        );
      },
      onLeave() { if (liveTimer) { clearInterval(liveTimer); liveTimer = null; } odrive.unsubscribe(); },
    });
  }

  /* =====================================================================
   * 5. TESTE DE MOVIMENTO — jog em mm, varredura 0→curso→0, telemetria live
   * ===================================================================== */
  {
    let iStep, cv, liveTimer, sweeping = false;

    async function ensureClosedLoop() {
      const st = await getA('current_state');
      if (Number(st) !== AXIS.CLOSED_LOOP) {
        setStatus('Eixo não está em closed-loop — ativando (estado 8)…', 'warn');
        await odrive.reqState(AXIS.CLOSED_LOOP);
        await new Promise(r => setTimeout(r, 300));
      }
    }

    async function jog(dir) {
      if (!S.dev) { setStatus('Selecione um atuador na etapa 0.', 'err'); return; }
      const mm = Number(iStep.value || 5) * dir;
      try {
        await ensureClosedLoop();
        const cur = await getA('encoder.pos_estimate');
        await setA('controller.input_mode', 6); // INPUT_MODE_TRAP_TRAJ
        const tgt = Number(cur) + mm2turn(mm);
        await setA('controller.input_position', tgt);
        setStatus(`Jog ${mm > 0 ? '+' : ''}${mm} mm → alvo ${fmt(turn2mm(tgt), 2)} mm`, 'info');
      } catch (e) { setStatus('Jog: ' + e.message, 'err'); }
    }

    // guarda de segurança: aborta a varredura se o eixo sair de closed-loop ou gerar erro
    async function watchGuard(cancel) {
      while (!cancel.cancelled && sweeping) {
        try {
          const [st, err] = await Promise.all([getA('current_state'), getA('error')]);
          if (Number(st) !== AXIS.CLOSED_LOOP && Number(st) !== AXIS.IDLE) continue;
          if (Number(err)) { cancel.cancelled = true; setStatus(`ERRO 0x${Number(err).toString(16)} — varredura abortada, eixo em IDLE.`, 'err'); await odrive.reqState(AXIS.IDLE).catch(() => {}); }
          if (Number(st) === AXIS.IDLE) { cancel.cancelled = true; setStatus('Eixo caiu para IDLE — varredura abortada.', 'err'); }
        } catch (_) { /* ignora erro transitório de leitura */ }
        await new Promise(r => setTimeout(r, 150));
      }
    }

    async function moveTo(mmPos, cancel) {
      await setA('controller.input_mode', 6);
      await setA('controller.input_position', mm2turn(mmPos));
      // espera chegar perto do alvo (ou cancelamento)
      const t0 = Date.now();
      while (!cancel.cancelled && Date.now() - t0 < 60000) {
        await new Promise(r => setTimeout(r, 200));
        const pos = await getA('encoder.pos_estimate');
        if (Math.abs(turn2mm(pos) - mmPos) < 0.5) break;
      }
    }

    async function sweep() {
      if (!S.dev) { setStatus('Selecione um atuador na etapa 0.', 'err'); return; }
      const homed = await getA('is_homed').catch(() => 1);
      if (!Number(homed)) { setStatus('Eixo NÃO referenciado (is_homed=0) — faça o homing no passo 3 antes de varrer.', 'err'); return; }
      if (!confirm(`Varredura completa 0 → ${fmt(S.stroke_mm, 0)} mm → 0.\nO eixo vai percorrer TODO o curso em closed-loop.\nCarga livre e área desobstruída?`)) return;
      sweeping = true;
      const cancel = { cancelled: false };
      watchGuard(cancel);
      try {
        await ensureClosedLoop();
        setStatus('Varredura: indo a 0 mm…', 'warn');
        await moveTo(0, cancel);
        if (cancel.cancelled) return;
        setStatus(`Varredura: indo a ${fmt(S.stroke_mm, 0)} mm…`, 'warn');
        await moveTo(S.stroke_mm, cancel);
        if (cancel.cancelled) return;
        setStatus('Varredura: retornando a 0 mm…', 'warn');
        await moveTo(0, cancel);
        if (!cancel.cancelled) setStatus('Varredura completa OK — 0 → curso → 0.', 'ok');
      } catch (e) { setStatus('Varredura: ' + e.message, 'err'); }
      finally { sweeping = false; }
    }

    STEPS.push({
      id: 'motiontest', title: '5. Teste de movimento', desc: 'Validação do movimento em closed-loop (jog e varredura de curso) antes de salvar a configuração.',
      body(b) {
        iStep = num(5, 0.5, 0.1);
        const bJogM = btn('−mm'); bJogM.onclick = () => jog(-1);
        const bJogP = btn('+mm'); bJogP.onclick = () => jog(+1);
        const bSweep = btn('Varredura 0→curso→0', 'primary'); bSweep.onclick = sweep;
        const bStop = btn('STOP (idle)', 'err'); bStop.onclick = async () => { sweeping = false; await odrive.reqState(AXIS.IDLE).catch(() => {}); setStatus('Parado — eixo em IDLE.', 'warn'); };
        const bPos = btn('Posição atual'); bPos.onclick = async () => {
          try {
            const pos = await getA('encoder.pos_estimate');
            setStatus(`Posição atual: ${fmt(turn2mm(pos), 2)} mm (${fmt(pos, 3)} turns)`, 'info');
          } catch (e) { setStatus('Leitura de posição: ' + e.message, 'err'); }
        };

        cv = el('canvas', 'plot');
        cv.width = 640; cv.height = 120;
        odrive.subscribe(50).then(() => { liveTimer = setInterval(() => drawPlot(cv), 50); }).catch(() => {});

        b.append(
          note('⚠ Eixo em closed-loop e carga livre! Qualquer comando move o atuador imediatamente.', 'warn'),
          grid(field('Passo do jog [mm]', iStep)),
          row(bJogM, bJogP, bPos),
          row(bSweep, bStop),
          cv,
          statusLine(),
        );
      },
      onLeave() { sweeping = false; if (liveTimer) { clearInterval(liveTimer); liveTimer = null; } odrive.unsubscribe(); },
    });
  }

  /* =====================================================================
   * 6. SALVAR & CAN — node_id/baud, save+reboot, exportar/importar perfil
   * ===================================================================== */
  {
    let iNode, iBaud, iFile;

    async function applyCan() {
      const node = Number(iNode.value);
      if (!(node >= 0 && node <= 63)) { setStatus('node_id deve estar entre 0 e 63.', 'err'); return; }
      try {
        await setA('can.config.node_id', node);
        await setA('can.config.baud_rate', Number(iBaud.value));
        S.profile.can = { node_id: node, baud_rate: Number(iBaud.value) };
        setStatus(`CAN configurado: node_id=${node} baud=${Number(iBaud.value) / 1000}k (efetivo após reboot).`, 'ok');
      } catch (e) { setStatus('CAN: ' + e.message, 'err'); }
    }

    async function saveFlash() {
      if (!confirm('Gravar TODA a configuração em flash e reiniciar a ODrive?')) return;
      try {
        setStatus('Salvando em flash… (pode levar alguns segundos)', 'warn');
        await odrive.action('save');
        setStatus('Salvo! Reiniciando…', 'ok');
        await odrive.action('reboot').catch(() => {}); // reboot derruba a conexão — erro esperado
      } catch (e) { setStatus('Salvar: ' + e.message, 'err'); }
    }

    function exportProfile() {
      const meta = { exported_at: new Date().toISOString(), serial: S.dev && S.dev.serial ? S.dev.serial : 'unknown', axis: S.axis };
      const blob = new Blob([JSON.stringify({ meta, profile: S.profile }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `odrive-profile-${meta.serial}-axis${meta.axis}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      setStatus('Perfil exportado como JSON.', 'ok');
    }

    async function importProfile(file) {
      let data;
      try { data = JSON.parse(await file.text()); }
      catch (e) { setStatus('JSON inválido: ' + e.message, 'err'); return; }
      const p = data.profile || data;
      const jobs = [];
      if (p.motor) {
        jobs.push(['motor.config.motor_type', p.motor.type]);
        jobs.push(['motor.config.pole_pairs', p.motor.pole_pairs]);
        jobs.push(['motor.config.current_lim', p.motor.current_lim]);
        jobs.push(['motor.config.phase_resistance', p.motor.R]);
        jobs.push(['motor.config.phase_inductance', p.motor.L]);
      }
      if (p.tuning) {
        jobs.push(['controller.config.pos_gain', p.tuning.pos_gain]);
        jobs.push(['controller.config.vel_gain', p.tuning.vel_gain]);
        jobs.push(['controller.config.vel_integrator_gain', p.tuning.vel_integrator_gain]);
      }
      if (p.homing && p.homing.mode === 'stall_current') {
        jobs.push(['min_endstop.config.enabled', 0]);
        if (p.homing.iq_thres != null) jobs.push(['stall_homing.config.iq_thres', p.homing.iq_thres]);
        if (p.homing.vel != null) jobs.push(['stall_homing.config.vel', p.homing.vel]);
      }
      let ok = 0, fail = 0;
      for (const [path, val] of jobs) {
        if (val == null) continue;
        try { await setA(path, val); ok++; }
        catch (e) { fail++; log(`Import: FALHOU ${path} = ${val} — ${e.message}`); }
      }
      Object.assign(S.profile, p);
      setStatus(`Importado: ${ok} parâmetros aplicados, ${fail} falharam (veja o log).`, fail ? 'warn' : 'ok');
    }

    STEPS.push({
      id: 'save', title: '6. Salvar & CAN', desc: 'Configuração CAN, gravação em flash com reboot e exportação/importação do perfil.',
      async body(b) {
        let curNode = 0;
        try { curNode = await getA('can.config.node_id'); } catch (_) {}
        iNode = num(curNode || 0, 1, 0); iNode.max = 63;
        iBaud = sel([[250000, '250 kbit/s'], [125000, '125 kbit/s'], [500000, '500 kbit/s'], [1000000, '1 Mbit/s']], 250000);
        const bApplyCan = btn('Aplicar CAN'); bApplyCan.onclick = applyCan;
        const bSave = btn('Salvar configuração em flash', 'primary'); bSave.onclick = saveFlash;
        const bExp = btn('Exportar perfil JSON'); bExp.onclick = exportProfile;
        iFile = document.createElement('input'); iFile.type = 'file'; iFile.accept = '.json,application/json';
        iFile.onchange = () => { if (iFile.files[0]) importProfile(iFile.files[0]); };
        const bImp = btn('Importar perfil…'); bImp.onclick = () => iFile.click();

        b.append(
          note('A configuração em RAM é perdida no reboot — salve em flash antes de desligar.', 'warn'),
          grid(
            field('CAN node_id (0–63)', iNode),
            field('CAN baud rate', iBaud),
          ),
          row(bApplyCan, bSave),
          note('Backup do perfil (motor, atuador, tuning, homing) em arquivo JSON.', 'info'),
          row(bExp, bImp),
          iFile,
          statusLine(),
        );
        iFile.style.display = 'none';
      },
    });
  }

  /* =====================================================================
   * 7. MONITORAMENTO — dashboard multi-eixo em tempo real + reboot/home
   * ===================================================================== */
  {
    let timer = null;
    let cv, plotTimer = null;
    let cellsRoot;

    const STATE_NAMES = { 0: 'UNDEFINED', 1: 'IDLE', 2: 'STARTUP', 3: 'FULL_CALIB', 4: 'MOTOR_CALIB', 5: 'ENC_INDEX', 6: 'HOMING', 7: 'ENC_OFFSET', 8: 'CLOSED_LOOP' };

    function makeCard(n) {
      const card = el('div', 'mon-card');
      card.style.cssText = 'border:1px solid #333;border-radius:6px;padding:8px;min-width:170px';
      const title = el('div'); title.style.fontWeight = 'bold'; title.textContent = `axis${n}`;
      const pos = el('div'), vel = el('div'), iq = el('div'), st = el('div'), err = el('div');
      card.append(title, pos, vel, iq, st, err);
      return { card, pos, vel, iq, st, err };
    }

    async function pollOnce(cards) {
      for (const { n, c } of cards) {
        try {
          // WebSerialTransport: subscribe já faz polling; getA/get devolvem os últimos valores.
          // WSTransport (ESP32 :81): get por caminho completo 'axisN.<prop>'.
          const p = (prop) => n === Number(S.axis) ? getA(prop) : odrive.get(`axis${n}.${prop}`);
          const [pos, vel, iq, st, err] = await Promise.all([
            p('encoder.pos_estimate'), p('encoder.vel_estimate'), p('motor.current_control.Iq_measured'),
            p('current_state'), p('error'),
          ]);
          c.pos.textContent = `Posição: ${fmt(turn2mm(pos), 2)} mm`;
          c.vel.textContent = `Velocidade: ${fmt(turn2mm(vel), 1)} mm/s`;
          c.iq.textContent = `Iq: ${fmt(iq, 2)} A`;
          c.st.textContent = `Estado: ${STATE_NAMES[Number(st)] || st}`;
          c.err.textContent = `Erro: 0x${Number(err || 0).toString(16)}`;
          c.err.style.color = Number(err) ? '#e5534b' : '#57ab5a';
        } catch (e) {
          c.st.textContent = `sem resposta (${e.message})`;
        }
      }
      try {
        const vbus = await odrive.get('vbus_voltage');
        const elV = document.getElementById('mon-vbus');
        if (elV) elV.textContent = `Vbus: ${fmt(vbus, 2)} V`;
      } catch (_) {}
    }

    STEPS.push({
      id: 'monitor', title: '7. Monitoramento', desc: 'Dashboard em tempo real de todos os eixos configurados: posição, velocidade, corrente, estado e erros.',
      body(b) {
        const axes = (Array.isArray(S.axesList) && S.axesList.length ? S.axesList : [Number(S.axis || 0)]);
        cellsRoot = el('div');
        cellsRoot.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px';
        const cards = axes.map(n => { const c = makeCard(n); cellsRoot.append(c.card); return { n, c }; });

        const vbus = note('Vbus: --', 'info'); vbus.id = 'mon-vbus';

        cv = el('canvas', 'plot');
        cv.width = 640; cv.height = 120;

        const bHomeAll = btn('Reboot & Home em todos', 'err');
        bHomeAll.onclick = async () => {
          if (!confirm('Enviar HOMING (estado 6) para TODOS os eixos? Todos vão se mover até seus limites!')) return;
          for (const n of axes) {
            try {
              if (n === Number(S.axis)) await odrive.reqState(AXIS.HOMING);
              else await odrive.set(`axis${n}.requested_state`, AXIS.HOMING);
              log(`Homing solicitado em axis${n}`);
            } catch (e) { log(`axis${n}: falha no homing — ${e.message}`); }
          }
          setStatus('Homing disparado em todos os eixos — acompanhe o dashboard.', 'warn');
        };

        odrive.subscribe(200).catch(() => {});
        timer = setInterval(() => pollOnce(cards), 200);
        plotTimer = setInterval(() => drawPlot(cv), 200);
        pollOnce(cards);

        b.append(
          note(`Monitorando eixos: ${axes.map(n => 'axis' + n).join(', ')} — atualização a cada 200 ms.`, 'info'),
          vbus,
          cellsRoot,
          cv,
          row(bHomeAll),
          statusLine(),
        );
      },
      onLeave() {
        if (timer) { clearInterval(timer); timer = null; }
        if (plotTimer) { clearInterval(plotTimer); plotTimer = null; }
        odrive.unsubscribe();
      },
    });
  }
})();
