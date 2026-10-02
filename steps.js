/* Etapas 1–7 do wizard. Depende de window._core e window.STEPS (app.js) */
'use strict';
(function () {
const { S, el, field, num, sel, btn, grid, row, note, log, odrive, axP, setA, getA, mm2turn, turn2mm, fmt, drawPlot, app } = window._core;
const STEPS = window.STEPS;

/* ---- 1. Identificação do motor ---- */
{
  const PRESETS = {
    custom: null,
    hoverboard: { type: 0, pp: 15, cpr: 90,  r: 0.16, l: 0.12e-3, ilim: 40, ical: 15 },
    tm8318:     { type: 0, pp: 20, cpr: 2048, r: 0.09, l: 0.06e-3, ilim: 30, ical: 10 },
  };
  const sPreset = sel([['custom', 'Personalizado'], ['hoverboard', 'Hoverboard 6.5" (barato/potente)'], ['tm8318', 'T-Motor 8318 KV100']]);
  const sType = sel([[0, 'High current (brushetti/BLDC)'], [3, 'Gimbal'], [2, 'ACIM/indução']], 0);
  const iPoles = num(15, 1, 1), iR = num(0.16, 0.01), iL = num(0.00012, 0.00001);
  const iIlim = num(40, 1), iCal = num(15, 1);
  sPreset.onchange = () => {
    const p = PRESETS[sPreset.value]; if (!p) return;
    sType.value = p.type; iPoles.value = p.pp; iR.value = p.r; iL.value = p.l; iIlim.value = p.ilim; iCal.value = p.ical;
  };
  const bApply = btn('Aplicar ao eixo (RAM)', 'primary');
  const bErr = btn('Limpar erros', 'notice');

  STEPS.push({
    id: 'motor', title: '1. Motor', desc: 'Tipo, parâmetros elétricos e limites de corrente do motor do atuador.',
    body(b) {
      bApply.onclick = async () => {
        try {
          await setA('motor.config.motor_type', +sType.value);
          await setA('motor.config.pole_pairs', +iPoles.value);
          await setA('motor.config.current_lim', +iIlim.value);
          await setA('motor.config.calibration_current', +iCal.value);
          S.profile.motor = { motor_type: +sType.value, pole_pairs: +iPoles.value, R_ref: +iR.value, L_ref: +iL.value, current_lim: +iIlim.value, calibration_current: +iCal.value };
          log('parâmetros de motor aplicados (gravado em RAM — salva só na etapa 7)');
          app.finish('motor');
        } catch (e) { log('falha: ' + e.message); }
      };
      b.append(
        field('Preset', sPreset),
        grid(
          field('Tipo de motor', sType),
          field('Pares de polos', iPoles),
          field('Resistência/fase [Ω] (ref)', iR),
          field('Indutância/fase [H] (ref)', iL),
          field('current_lim [A]', iIlim),
          field('calibration_current [A]', iCal),
        ),
        note('A corrente superior deve ser limitada também pelo fuso: saneie com o torque máximo admissível do fuso (<b>força = 2π·Kt·I / passo</b>).'),
        row(bApply),
      );
    },
  });
}

/* ---- 2. Atuador (fuso de esferas) ---- */
{
  const iPitch = num(S.pitch_mm, 0.5, 0.5), iStroke = num(S.stroke_mm, 1, 1);
  const sDir = sel([[0, 'Normal'], [1, 'Invertida']], 0);
  const iVel = num(40, 1, 1), iAccel = num(300, 1, 1), iVelMax = num(80, 1, 1);
  const oVelTurn = el('span', 'muted'), oVelTraj = el('span', 'muted');
  const refresh = () => {
    S.pitch_mm = +iPitch.value; S.stroke_mm = +iStroke.value; S.invert = sDir.value == 1;
    oVelTurn.textContent = ` vel_limit = ${fmt(mm2turn(+iVelMax.value), 2)} turn/s (rel. carga ~ motor RPM ${fmt(+iVelMax.value / S.pitch_mm * 60, 0)})`;
    oVelTraj.textContent = ` trapézio: vel ${fmt(mm2turn(+iVel.value), 2)} turn/s, acel ${fmt(mm2turn(+iAccel.value), 2)} turn/s²`;
  };
  [iPitch, iStroke, iVel, iAccel, iVelMax].forEach(i => i.oninput = refresh);

  STEPS.push({
    id: 'screw', title: '2. Atuador (fuso)', desc: 'Geometria do fuso de esferas — converte tudo para mm.',
    body(b) {
      const bApply = btn('Aplicar trajetória & limites', 'primary');
      bApply.onclick = async () => {
        try {
          refresh();
          await setA('encoder.config.cpr', S.encoder_cpr ?? 8192); // definido na etapa de calibração se ausente
          await setA('controller.config.vel_limit', mm2turn(+iVelMax.value));
          await setA('trap_traj.config.vel_limit', mm2turn(+iVelMax.value));
          await setA('trap_traj.config.accel_limit', mm2turn(+iAccel.value));
          await setA('trap_traj.config.decel_limit', mm2turn(+iAccel.value));
          S.profile.screw = { pitch_mm: +iPitch.value, stroke_mm: +iStroke.value, invert: sDir.value == 1, vel_limit_mm_s: +iVelMax.value, accel_mm_s2: +iAccel.value };
          log('trajetória e limites aplicados');
          app.finish('screw');
        } catch (e) { log('falha: ' + e.message); }
      };
      b.append(
        grid(
          field('Passo do fuso [mm/volta]', iPitch),
          field('Curso útil [mm]', iStroke),
          field('Direção lógica', sDir),
          field('Velocidade de trajetória [mm/s]', iVel),
          field('Aceleração [mm/s²]', iAccel),
          field('vel_limit [mm/s]', iVelMax),
        ),
        oVelTurn, el('br'), oVelTraj,
        row(bApply));
    },
  });
}

/* ---- 3. Calibração ---- */
{
  let timer = null;
  STEPS.push({
    id: 'calib', title: '3. Calibração', desc: 'Calibração do motor + offset do encoder, com progresso guiado.',
    body(b) {
      const status = el('div', 'kv');
      const bFull = btn('Calibração completa (FULL_SEQUENCE)', 'primary');
      const bMot  = btn('Só motor', ''),
            bEnc  = btn('Só encoder offset', '');
      const bAbort = btn('Abortar (idle)', 'danger');
      const sCpr = num(8192, 1, 16);
      const sIdx = sel([[1, 'Usar índice Z (recomendado p/ calibração exata)'], [0, 'Sem índice']], 1);
      const main = el('b');

      async function poll() {
        try {
          const st = await getA('current_state');
          const err = await getA('error');
          const busy = await getA('is_homed').catch(() => null);
          status.innerHTML =
            `<span>current_state</span><b>${st}</b>` +
            `<span>axis.error</span><b>${err || 0}</b>` +
            `<span>encoder.is_ready</span><b>${await getA('encoder.is_ready')}</b>` +
            `<span>motor.is_calibrated</span><b>${await getA('motor.is_calibrated')}</b>`;
          if (st === 1 && (err || 0) === 0) { clearInterval(timer); timer = null; log('calibração concluída sem erros');
            S.profile.calib = { cpr: +sCpr.value, use_index: +sIdx.value }; app.finish('calib'); }
          else if ((err || 0) !== 0) { clearInterval(timer); timer = null; log('ERRO na calibração: axis.error=' + err); }
        } catch (e) { log('poll: ' + e.message); }
      }
      const start = st => async () => {
        try { await odrive.reqState(st); log('estado solicitado: ' + st); timer = setInterval(poll, 500); poll(); }
        catch (e) { log('falha: ' + e.message); }
      };
      bFull.onclick = start(3);  // AXIS_STATE_FULL_CALIBRATION_SEQUENCE
      bMot.onclick  = start(4);  // MOTOR_CALIBRATION
      bEnc.onclick  = start(7);  // ENCODER_OFFSET_CALIBRATION
      bAbort.onclick = start(1); // IDLE
      b.append(
        grid(field('Encoder CPR', sCpr), field('Índice Z', sIdx)),
        row(bFull, bMot, bEnc, bAbort),
        status,
        note('Motor começa a girar sozinho na calibração de offset — o atuador deve poder se mover livremente (alguns mm).'),
      );
    },
    leave() { if (timer) clearInterval(timer); },
  });
}

/* ---- 4. Tuning ---- */
{
  const TUNINGS = {
    conservador: { pos: 8,  vel: 0.05, vi: 0.08 },
    equilibrado: { pos: 20, vel: 0.167, vi: 0.33 },
    agressivo:   { pos: 60, vel: 0.6,  vi: 0.8 },
  };
  let timer = null, plot = null;
  STEPS.push({
    id: 'tuning', title: '4. Tuning de controle', desc: 'Ganhos posição/velocidade + validação visual.',
    body(b) {
      const sPreset = sel([['conservador', 'Conservador'], ['equilibrado', 'Equilibrado'], ['agressivo', 'Agressivo']], 'equilibrado');
      const iPos = num(20, 0.5), iVel = num(0.167, 0.01), iVi = num(0.33, 0.01);
      const iInertia = num(0.05, 0.005);
      const bApply = btn('Aplicar ganhos', 'primary');
      const bStart = btn('Entrar em closed-loop'), bStop = btn('Sair (idle)', 'danger');
      const bTest = btn('Teste: passo 20 mm'), bSub = btn('Plot ON'), bUnsub = btn('Plot OFF');
      plot = el('canvas', 'plot');
      sPreset.onchange = () => { const t = TUNINGS[sPreset.value]; iPos.value = t.pos; iVel.value = t.vel; iVi.value = t.vi; };
      bApply.onclick = async () => {
        try {
          await setA('controller.config.pos_gain', +iPos.value);
          await setA('controller.config.vel_gain', +iVel.value);
          await setA('controller.config.vel_integrator_gain', +iVi.value);
          await setA('controller.config.inertia', +iInertia.value);
          await setA('controller.config.control_mode', 3); // POSITION
          await setA('controller.config.input_mode', 1);   // POS_FILTER
          S.profile.tuning = { pos_gain: +iPos.value, vel_gain: +iVel.value, vel_integrator_gain: +iVi.value, inertia: +iInertia.value };
          log('ganhos aplicados'); app.finish('tuning');
        } catch (e) { log('falha: ' + e.message); }
      };
      bStart.onclick = () => odrive.reqState(8).catch(e => log(e.message));   // CLOSED_LOOP
      bStop.onclick  = () => odrive.reqState(1).catch(e => log(e.message));   // IDLE
      bTest.onclick  = async () => { try { await setA('controller.input_pos', mm2turn(20)); log('passo 20mm comandado'); } catch (e) { log(e.message); } };
      bSub.onclick   = () => { odrive.subscribe(20).then(() => { timer = setInterval(() => drawPlot(plot), 33); log('telemetria ON'); }); };
      bUnsub.onclick = () => { odrive.unsubscribe(); clearInterval(timer); log('telemetria OFF'); };
      b.append(
        grid(field('Preset', sPreset), field('pos_gain [(1/s)]', iPos), field('vel_gain', iVel), field('vel_integrator_gain', iVi), field('inércia estimada', iInertia)),
        row(bApply, bStart, bStop),
        row(bTest, bSub, bUnsub),
        plot,
        note('Curve da posição (azul) contra o alvo (laranja). Overshoot < 5% e sem oscilação residual é um tuning aceitável para motion.'),
      );
    },
  });
}

/* ---- 5. Homing (endstop OU stall-current) ---- */
{
  let timer = null;
  STEPS.push({
    id: 'homing', title: '5. Homing / fim de curso', desc: 'Estratégia de referência no boot sob carga: stall-current recomendado para fuso com batente rígido.',
    body(b) {
      const sMode = sel([[1, 'STALL_CURRENT — batente mecânico (recomendado)'], [0, 'ENDSTOP — chave de fim de curso']], 1);
      const iSpeed = num(5, 0.5, 0.5);           // mm/s (será convertido via pitch)
      const iStallI = num(20, 0.5, 1);           // A
      const iStallT = num(300, 10, 50);          // ms
      const iStallV = num(0.05, 0.005, 0.005);   // turn/s
      const iOff = num(2, 0.5, 0);               // mm de afastamento após o batente
      const iMaxDist = num(S.stroke_mm * 1.05, 1, 10); // mm
      const iCurHoming = num(10, 1, 1);          // current_lim reduzida durante homing
      const sStartHoming = sel([[1, 'Homing automático no boot (startup_homing)'], [0, 'Homing manual']], 1);
      const oStats = el('div', 'kv');
      const bApply = btn('Aplicar configuração de homing', 'primary');
      const bRun   = btn('⚠ Executar homing agora'), bAbort = btn('Abortar', 'danger');

      const refreshDerived = () => {
        oStats.innerHTML =
          `<span>Vnx de procura</span><b>${fmt(mm2turn(+iSpeed.value), 3)} turn/s</b>` +
          `<span>Curso limite</span><b>${fmt(mm2turn(+iMaxDist.value), 2)} turn</b>` +
          `<span>Offset pós-homing</span><b>${fmt(mm2turn(-(+iOff.value)), 2)} turn</b>`;
      };
      [iSpeed, iMaxDist, iOff].forEach(i => i.oninput = refreshDerived);

      bApply.onclick = async () => {
        try {
          await setA('controller.config.homing_mode', +sMode.value);
          await setA('controller.config.homing_speed', Math.abs(mm2turn(+iSpeed.value)));
          await setA('controller.config.homing_stall_current', +iStallI.value);
          await setA('controller.config.homing_stall_vel', +iStallV.value);
          await setA('controller.config.homing_stall_time', +iStallT.value / 1000);
          await setA('controller.config.homing_offset', mm2turn(-(+iOff.value)));
          await setA('controller.config.homing_max_distance', Math.abs(mm2turn(+iMaxDist.value)));
          await setA('config.startup_homing', +sStartHoming.value ? true : false);
          S.profile.homing = { mode: +sMode.value, speed_mm_s: +iSpeed.value, stall_current: +iStallI.value, stall_time_ms: +iStallT.value, offset_mm: -iOff.value, max_dist_mm: +iMaxDist.value };
          log('homing configurado'); app.finish('homing');
        } catch (e) { log('falha: ' + e.message); }
      };
      bRun.onclick = async () => {
        try { await setA('motor.config.current_lim', +iCurHoming.value); await odrive.reqState(9); log('homing iniciado — abortar para emergência'); }
        catch (e) { log('falha: ' + e.message); }
      };
      bAbort.onclick = () => odrive.reqState(1).catch(e => log(e.message));
      b.append(
        grid(
          field('Modo de homing', sMode),
          field('Velocidade de procura [mm/s]', iSpeed),
          field('Corrente de stall [A]', iStallI),
          field('Tempo de stall [ms]', iStallT),
          field('Velocidade de stall [turn/s]', iStallV),
          field('Afaste pós-homing [mm]', iOff),
          field('Curso de busca máx [mm]', iMaxDist),
          field('current_lim durante homing [A]', iCurHoming),
          field('Homing no boot', sStartHoming),
        ),
        oStats, refreshDerived(),
        note('O homing por stall desacelera torque reduzido; confirme que <b>current_lim</b> recupera o valor nominal após homing bem-sucedido.', 'warn'),
        row(bApply, bRun, bAbort),
      );
    },
  });
}

/* ---- 6. Teste de movimento ---- */
{
  let tmove = null, plot = null;
  STEPS.push({
    id: 'motiontest', title: '6. Teste de movimento', desc: 'Jog, varredura de curso, validação de limites (mm).',
    body(b) {
      plot = el('canvas', 'plot');
      const iJog = num(5, 1, 0.1); // mm
      const bJogM = btn(`−mm`), bJogP = btn(`+mm`);
      const bSweep = btn('Varredura 0 → curso → 0', 'primary');
      const bStop = btn('STOP (idle)', 'danger');
      const bPerc = btn('Posição atual (mm)'); const oPos = el('b', null, '—');
      const logKv = el('div', 'kv');
      bJogM.textContent = '−mm'; bJogP.textContent = '+mm';
      const jog = dmm => async () => {
        try { const pos = await getA('encoder.pos_estimate'); await setA('control_mode', undefined).catch(() => {}); await setA('controller.input_pos', pos + mm2turn(+iJog.value * dmm)); } catch (e) { log(e.message); }
      };
      bJogM.onclick = jog(-1); bJogP.onclick = jog(+1);
      bPerc.onclick = async () => { try { const p = await getA('encoder.pos_estimate'); oPos.textContent = fmt(turn2mm(p), 2) + ' mm'; } catch (e) { log(e.message); } };
      bSweep.onclick = async () => {
        try { await odrive.reqState(8); await setA('controller.config.input_mode', 6); // TRAP_TRAJ
          await setA('controller.input_pos', 0); await new Promise(r => setTimeout(r, 800));
          await setA('controller.input_pos', mm2turn(S.stroke_mm)); await new Promise(r => setTimeout(r, 1500));
          await setA('controller.input_pos', 0); log('varredura comandada'); }
        catch (e) { log('falha: ' + e.message); }
      };
      bStop.onclick = () => odrive.reqState(1).catch(e => log(e.message));
      b.append(
        note('Certifique-se de que o homing (etapa 5) já rodou e `is_homed = true` antes da varredura.'),
        grid(field('Passo do jog [mm]', iJog)),
        row(bJogM, bJogP, bPerc, oPos),
        row(bSweep, bStop),
        plot, logKv,
      );
      odrive.subscribe(40).then(() => { timerOf(tmove); tmove = setInterval(() => drawPlot(plot), 33); });
    },
    leave() { odrive.unsubscribe(); if (tmove) clearInterval(tmove); },
  });
}

/* ---- 7. Salvar & CAN ---- */
{
  STEPS.push({
    id: 'save', title: '7. Salvar & CAN', desc: 'Persiste tudo, atribui node_id CAN e exporta perfil do atuador.',
    body(b) {
      const iNode = num(S.axis, 1, 0);            // ids 0..(2N-1)
      const iBaud = sel([[250000, '250 kbps (motion)'], [500000, '500 kbps'], [125000, '125 kbps']], 250000);
      const bSave = btn('Salvar configuração em flash (save_configuration)', 'primary');
      const bReboot = btn('Reboot', '');
      const bJson = btn('Exportar perfil JSON', '');
      const iJson = el('input'); iJson.type = 'file'; iJson.accept = '.json';
      const bLoad = btn('Aplicar perfil JSON', '');
      bSave.onclick = async () => {
        try {
          await setA('config.can.node_id', +iNode.value);
          await odrive.set('can.config.baud_rate', +iBaud.value);
          S.profile.can = { node_id: +iNode.value, baud: +iBaud.value };
          S.profile.meta = { serial: S.dev, axis: S.axis, created: new Date().toISOString(), app: 'motion-sim-setup v1' };
          await odrive.action('save'); log('configuração salva; reboot recomendado');
          app.finish('save');
        } catch (e) { log('falha: ' + e.message); }
      };
      bReboot.onclick = () => odrive.action('reboot').catch(e => log(e.message));
      bJson.onclick = () => {
        const blob = new Blob([JSON.stringify(S.profile, null, 2)], { type: 'application/json' });
        const a = el('a'); a.href = URL.createObjectURL(blob); a.download = `odrive_atuador_${S.dev || 'x'}_m${S.axis}.json`; a.click();
      };
      bLoad.onclick = () => iJson.click();
      iJson.onchange = async () => {
        const f = iJson.files[0]; if (!f) return;
        const p = JSON.parse(await f.text());
        try {
          if (p.motor) { await setA('motor.config.motor_type', p.motor.motor_type); await setA('motor.config.pole_pairs', p.motor.pole_pairs); await setA('motor.config.current_lim', p.motor.current_lim); await setA('motor.config.calibration_current', p.motor.calibration_current); }
          if (p.screw) { await setA('controller.config.vel_limit', mm2turn(p.screw.vel_limit_mm_s)); await setA('trap_traj.config.vel_limit', mm2turn(p.screw.vel_limit_mm_s)); }
          if (p.tuning) { await setA('controller.config.pos_gain', p.tuning.pos_gain); await setA('controller.config.vel_gain', p.tuning.vel_gain); await setA('controller.config.vel_integrator_gain', p.tuning.vel_integrator_gain); }
          if (p.homing) { await setA('controller.config.homing_mode', p.homing.mode); await setA('controller.config.homing_speed', Math.abs(mm2turn(p.homing.speed_mm_s))); await setA('controller.config.homing_stall_current', p.homing.stall_current); await setA('controller.config.homing_stall_time', p.homing.stall_time_ms / 1000); }
          log('perfil aplicado — salve em flash se confirmado');
        } catch (e) { log('falha ao aplicar perfil: ' + e.message); }
      };
      b.append(
        grid(field('CAN node_id (0..63)', iNode), field('CAN baud', iBaud)),
        note('No setup identifique cada ODrive por <b>node_id ímpar/par</b>: eixo M1 = id+1. O ESP32 já fábrica assume os ids 0..(2·N−1).'),
        row(bSave, bReboot),
        row(bJson, bLoad),
        note('Após o reboot com <b>startup_homing=true</b>, o eixo calibra e homeia sozinho sob carga — exatamente o cenário do rig.', 'ok'),
      );
    },
  });
}
function timerOf(x){}
})();
