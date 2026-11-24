'use strict';
(() => {
  const canvas = document.querySelector('#court'), ctx = canvas.getContext('2d');
  const $ = id => document.getElementById(id);
  const W = canvas.width, H = canvas.height, R = 19, margin = 32;
  const center = W / 2;
  const leftEnd = 88, rightEnd = W - leftEnd;
  const top = margin + R, bottom = H - margin - R;
  const innerTop = 84, innerBottom = H - innerTop;
  const throwLeftThird = margin + (W - 2 * margin) / 3;
  const throwRightThird = W - throwLeftThird;
  const ballRadius = 10;
  const keys = new Set();
  let state = 'ready', players = [], ball, controlled, effects = [], time = 0, last = 0;
  let ballIdle = 0;
  const clamp = (v, a, b) => Math.max(a, Math.min(v, b));
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const infield = team => players.filter(p => p.team === team && p.zone === 'infield');
  const outfield = team => players.filter(p => p.team === team && p.zone !== 'infield');
  const baseSpeed = () => Number($('speedSetting').value);
  const cpuModes = {
    easy: {dodge:0.25, move:0.80, hold:1.6, aim:0.20},
    normal: {dodge:1.00, move:1.00, hold:1.0, aim:0},
    hard: {dodge:1.00, move:1.22, hold:0.6, aim:0}
  };
  const cpuMode = () => cpuModes[$('cpuDifficulty').value] || cpuModes.normal;
  const speedLevel = () => Math.min(12, Math.floor(time / 10));
  const speedMultiplier = () => 1 + speedLevel() / 6;
  const currentBallSpeed = () => Math.round(baseSpeed() * speedMultiplier());
  const teamName = team => team === 0 ? '青' : '赤';
  const leftOutfieldTeam = 1;
  const outfieldOnLeft = team => team === leftOutfieldTeam;
  const frontX = (team, inset) => center + (team ? 1 : -1) * (R + inset);

  function horizontalBounds(p) {
    if (p.zone === 'infield') {
      return p.team ? [frontX(1, 5), rightEnd - R] : [leftEnd + R, frontX(0, 5)];
    }
    return outfieldOnLeft(p.team) ? [margin + R, center - R] : [center + R, W - margin - R];
  }

  const sideX = team => outfieldOnLeft(team) ? leftEnd - R - 12 : rightEnd + R + 12;
  const sideBoundary = team => outfieldOnLeft(team) ? leftEnd - R : rightEnd + R;

  function outfieldPart(p, x = p.x, y = p.y) {
    if (p.zone === 'infield') return null;
    const [minX, maxX] = horizontalBounds(p);
    if (x < minX || x > maxX || y < top || y > bottom) return null;
    const edge = sideBoundary(p.team);
    if (outfieldOnLeft(p.team) ? x <= edge : x >= edge) return 'side';
    if (y <= innerTop - R) return 'top';
    if (y >= innerBottom + R) return 'bottom';
    return null;
  }

  function legalOutfieldThrow(p) {
    if (p.zone === 'infield') return true;
    const part = outfieldPart(p);
    return part === 'side' || (part !== null &&
      (outfieldOnLeft(p.team) ? p.x <= throwLeftThird : p.x >= throwRightThird));
  }

  function nearest(point, candidates) {
    return candidates.reduce((best, p) => !best || distance(p, point) < distance(best, point) ? p : best, null);
  }

  function reset() {
    players = [];
    for (const team of [0, 1]) {
      for (let i = 0; i < 4; i++) {
        const p = {team, number:i + 1, zone:i < 3 ? 'infield' : 'starter', wait:0,
          phase:i * 2 + team, dodgeDir:0, dodgeUntil:0, lastThreat:null, dodgeEnabled:false, catchUntil:0, nextCatch:0};
        p.x = i < 3 ? frontX(team, 81) : sideX(team);
        p.y = i < 3 ? 184 + i * 92 : H / 2;
        players.push(p);
      }
    }
    controlled = players[0];
    ball = {x:leftEnd + 95, y:H / 2, vx:0, vy:0, owner:null, shot:null, flight:0,
      lock:0, trail:[], receivedPass:false, looseOutfieldAttackFrom:null, pendingTurnover:null};
    effects = [];
    time = 0;
    ballIdle = 0;
    keys.clear();
    updateScore();
    updateSpeedDisplay();
  }

  function updateScore() {
    for (const [team, color] of ['blue', 'red'].entries()) {
      $(color + 'Count').textContent = infield(team).length;
      $(color + 'OutCount').textContent = outfield(team).length;
    }
  }

  function updateSpeedDisplay() {
    const label = `${currentBallSpeed()} (${speedMultiplier().toFixed(2)}倍${speedLevel() === 12 ? '・最高速' : ''})`;
    if ($('ballSpeed').textContent !== label) $('ballSpeed').textContent = label;
  }

  function start() {
    reset();
    state = 'playing';
    $('overlay').hidden = true;
    $('status').textContent = 'ボールをひろって、Spaceで投球・Pでパス！';
    last = performance.now();
    canvas.focus();
  }

  function finish(team) {
    state = 'ended';
    keys.clear();
    $('overlay').hidden = false;
    $('message').textContent = team === 0 ? 'やったね！ あなたの勝ち！' : 'CPUの勝ち！ もう一度ちょうせん！';
    $('detail').textContent = 'よける動きと、ボールをひろうタイミングがコツ！';
    $('start').textContent = 'もう一度あそぶ';
    $('status').textContent = teamName(team) + 'チームの勝利！';
  }

  function canTarget(p, target, kind) {
    if (!players.includes(p) || !players.includes(target) || p === target) return false;
    if (kind === 'attack') return target.team !== p.team && target.zone === 'infield';
    return kind === 'pass' && target.team === p.team &&
      (p.zone === 'infield') !== (target.zone === 'infield');
  }

  function selectTarget(p, kind) {
    return nearest(p, players.filter(target => canTarget(p, target, kind)));
  }

  function throwBall(p, kind, target) {
    if (!p || ball.owner !== p || state !== 'playing') return false;
    if (!canTarget(p, target, kind)) return false;
    const [minX, maxX] = horizontalBounds(p);
    if (p.x < minX || p.x > maxX || p.y < (p.zone === 'infield' ? innerTop + R : top) ||
        p.y > (p.zone === 'infield' ? innerBottom - R : bottom) || !legalOutfieldThrow(p)) return false;
    const length = distance(p, target);
    const speed = currentBallSpeed();
    ball.owner = null;
    ball.shot = {kind, from:p, target, crossedCenter:false};
    ball.flight = Math.max(1.65, length / speed + .12);
    ball.x = p.x;
    ball.y = p.y;
    // Only red CPU attacks lose accuracy on lower difficulty.
    const angleError = p.team === 1 && kind === 'attack' ?
      (Math.random() * 2 - 1) * cpuMode().aim : 0;
    const angle = Math.atan2(target.y-p.y, target.x-p.x) + angleError;
    ball.vx = Math.cos(angle) * speed;
    ball.vy = Math.sin(angle) * speed;
    ball.trail = [];
    ball.receivedPass = false;
    ball.looseOutfieldAttackFrom = null;
    ball.pendingTurnover = null;
    p.wait = .8;
    if (p === controlled) $('status').textContent = kind === 'pass' ? '外野へパス！' : 'ナイススロー！';
    return true;
  }

  function move(p, dx, dy, speed, dt) {
    let tx = p.x + dx, ty = p.y + dy;
    if (p.zone !== 'infield') {
      const [minX, maxX] = horizontalBounds(p);
      tx = clamp(tx, minX, maxX);
      ty = clamp(ty, top, bottom);
      // Follow the U-shaped corridor instead of cutting through the infield.
      const targetPart = outfieldPart(p, tx, ty);
      const destination = targetPart ?? 'side';
      if (!targetPart) tx = sideBoundary(p.team);
      const current = outfieldPart(p);
      if (current === 'top' && destination !== 'top' ||
          current === 'bottom' && destination !== 'bottom') {
        if (Math.abs(p.x - sideX(p.team)) > 1) {
          tx = sideX(p.team); ty = p.y;
        }
      } else if (current === 'side' && destination !== 'side') {
        if (destination === 'top' && p.y > innerTop - R ||
            destination === 'bottom' && p.y < innerBottom + R) tx = sideX(p.team);
      }
      // Crossing between upper and lower corridors must also use the side lane.
      if ((current === 'top' && destination === 'bottom') ||
          (current === 'bottom' && destination === 'top')) {
        tx = sideX(p.team);
        if (Math.abs(p.x - tx) > 1) ty = p.y;
      }
    }
    const length = Math.hypot(tx - p.x, ty - p.y);
    if (length > 0) {
      const step = Math.min(length, speed * dt) / length;
      p.x += (tx - p.x) * step;
      p.y += (ty - p.y) * step;
    }
    const [minX, maxX] = horizontalBounds(p);
    p.x = clamp(p.x, minX, maxX);
    p.y = clamp(p.y, p.zone === 'infield' ? innerTop + R : top,
      p.zone === 'infield' ? innerBottom - R : bottom);
    if (p.zone !== 'infield' && !outfieldPart(p)) {
      // Any diagonal rounding at a corner is kept in the nearest legal lane.
      if (Math.abs(p.x - sideX(p.team)) < Math.abs(p.y - (p.y < H / 2 ? innerTop - R : innerBottom + R)))
        p.x = sideBoundary(p.team);
      else p.y = p.y < H / 2 ? Math.min(p.y, innerTop - R) : Math.max(p.y, innerBottom + R);
    }
  }

  // Predict where an attack crosses the defender's x coordinate.
  function dodgeDirection(p) {
    if (ball.shot?.kind !== 'attack' || ball.shot.from.team === p.team || Math.abs(ball.vx) < 30) return 0;
    const interceptTime = (p.x - ball.x) / ball.vx;
    if (interceptTime < -.07 || interceptTime > Math.min(1.05, ball.flight)) return 0;
    const interceptY = ball.y + ball.vy * Math.max(0, interceptTime);
    if (Math.abs(interceptY - p.y) > 95) return 0;
    if (interceptY >= p.y && p.y - (innerTop + R) > 35) return -1;
    if (interceptY < p.y && (innerBottom - R) - p.y > 35) return 1;
    return (innerBottom - R) - p.y > p.y - (innerTop + R) ? 1 : -1;
  }

  function evade(p, dt) {
    // Roll only once per incoming shot, avoiding random changes each frame.
    if (p.team === 1 && ball.shot !== p.lastThreat) {
      p.lastThreat = ball.shot;
      p.dodgeEnabled = !!ball.shot && Math.random() < cpuMode().dodge;
      if (!p.dodgeEnabled) p.dodgeUntil = 0;
    }
    if (p.team === 1 && !p.dodgeEnabled) return false;
    const direction = dodgeDirection(p);
    if (direction && time >= p.dodgeUntil) {
      p.dodgeDir = direction;
      p.dodgeUntil = time + .32;
    }
    if (ball.shot?.kind !== 'attack' || ball.shot.from.team === p.team) p.dodgeUntil = 0;
    if (time >= p.dodgeUntil) return false;
    // Retreat away from the thrower, whether the attack comes from the front or back.
    move(p, Math.sign(ball.vx) * 115, p.dodgeDir * 270, p.team === 1 ? 265 * cpuMode().move : 265, dt);
    return true;
  }

  function moveControlled(p, dt) {
    const dx = Number(keys.has('arrowright') || keys.has('d')) - Number(keys.has('arrowleft') || keys.has('a'));
    const dy = Number(keys.has('arrowdown') || keys.has('s')) - Number(keys.has('arrowup') || keys.has('w'));
    move(p, dx * W, dy * W, 205, dt);
  }

  function playBall(p, dt) {
    if (p.zone === 'infield') {
      const dx = frontX(p.team, 8) - p.x;
      if (Math.abs(dx) > 2) {
        move(p, dx, 0, p.team === 1 ? 175 * cpuMode().move : 175, dt);
        return;
      }
    }
    if (p.wait > 0) return;
    // The middle third of the upper/lower outer lanes is catch/move only.
    if (p.zone !== 'infield' && !legalOutfieldThrow(p)) {
      const tx = outfieldOnLeft(p.team) ? throwLeftThird - R - 5 : throwRightThird + R + 5;
      move(p, tx - p.x, 0, 180 * (p.team ? cpuMode().move : 1), dt);
      return;
    }
    const opponent = selectTarget(p, 'attack');
    const teammate = selectTarget(p, 'pass');
    if (!opponent) return;
    // A receiver attacks next, preventing AI teammates from passing back and forth.
    // Outfield prioritizes fast attacks. It still sometimes returns a loose
    // ball to an infield teammate, but never keeps passing back and forth.
    const pass = teammate && !ball.receivedPass &&
      (p.zone !== 'infield'
        ? (p.zone === 'starter' && Math.random() < .15)
        : distance(p, opponent) > 145 && Math.abs(teammate.y - opponent.y) > 85);
    throwBall(p, pass ? 'pass' : 'attack', pass ? teammate : opponent);
  }

  function looseBallCandidates() {
    if (ball.owner || ball.shot || ball.pendingTurnover) return [];
    if (ball.y >= innerTop && ball.y <= innerBottom &&
        ball.x >= leftEnd && ball.x <= rightEnd) {
      return infield(ball.x < center ? 0 : 1);
    }
    return outfield(ball.x < center ? leftOutfieldTeam : 1 - leftOutfieldTeam);
  }

  function moveAI(p, chaser, dt) {
    const aiSpeed = p.team === 1 ? cpuMode().move : 1;
    if (ball.owner === p) {
      playBall(p, dt);
      return;
    }
    if (p.zone === 'infield' && evade(p, dt)) return;
    if (ball.shot?.kind === 'pass' && ball.shot.target === p) return;
    if (p === chaser) {
      move(p, ball.x - p.x, ball.y - p.y, 150 * aiSpeed, dt);
      return;
    }

    let tx, ty;
    if (p.zone === 'infield') {
      const defending = ball.owner && ball.owner.team !== p.team;
      tx = frontX(p.team, defending ? 130 : 34);
      ty = 140 + (p.number - 1) * 140 + Math.sin(time * 1.2 + p.phase) * 30;
    } else {
      // Patrol all three arms of the U, not only the endline.
      const patrol = (Math.floor(time / 7 + p.phase / 4) % 3);
      tx = patrol === 0 ? sideX(p.team)
        : (outfieldOnLeft(p.team) ? throwLeftThird - 40 : throwRightThird + 40);
      ty = patrol === 1 ? top + 8 : patrol === 2 ? bottom - 8 : H / 2;
    }
    move(p, tx - p.x, ty - p.y, 150 * aiSpeed, dt);
  }

  function stopFlight(drag, lock) {
    ball.shot = null;
    ball.flight = 0;
    ball.vx *= drag;
    ball.vy *= drag;
    ball.lock = lock;
    ball.trail = [];
    ball.receivedPass = false;
  }

  function takeBall(p, receivedPass = false) {
    stopFlight(0, 0);
    ball.owner = p;
    ball.receivedPass = receivedPass;
    ball.looseOutfieldAttackFrom = null;
    ball.pendingTurnover = null;
    ballIdle = 0;
    // Outfield players release quickly regardless of CPU difficulty.
    // Infield timing continues to follow the existing difficulty settings.
    p.wait = p.zone === 'infield'
      ? (1.1 + Math.random() * .6) * (p.team === 1 ? cpuMode().hold : 1)
      : .25 + Math.random() * .15;
    if (p === controlled) $('status').textContent = 'ボールを持っているよ！ Spaceで投球・Pでパス';
  }

  function hitPlayer(p, thrower) {
    effects.push({x:p.x, y:p.y, life:.6});
    p.zone = 'returning';
    p.x = sideX(p.team);
    p.y = clamp(p.y, top, bottom);
    p.catchUntil = 0;
    stopFlight(.3, .3);

    if (thrower.zone === 'returning') {
      thrower.zone = 'infield';
      const [min, max] = horizontalBounds(thrower);
      thrower.x = (min + max) / 2;
      thrower.y = 184 + (thrower.number - 1) * 92;
      $('status').textContent = teamName(thrower.team) + 'チームの選手が内野に復帰！';
    }
    if (p === controlled) {
      controlled = infield(0)[0];
      $('status').textContent = 'アウト！ 味方に交代したよ';
    }
    updateScore();
    if (!infield(p.team).length) finish(thrower.team);
  }

  // Return the first contact along a frame's path so fast shots cannot skip a player.
  function contactTime(p, dx, dy) {
    const x = ball.x - p.x, y = ball.y - p.y;
    const gap = x * x + y * y - (R + ballRadius) ** 2;
    if (gap <= 0) return 0;
    const travel = dx * dx + dy * dy;
    const approach = x * dx + y * dy;
    const discriminant = approach * approach - travel * gap;
    if (travel === 0 || approach >= 0 || discriminant < 0) return Infinity;
    return (-approach - Math.sqrt(discriminant)) / travel;
  }

  function missedShotInThrowersOutfield(thrower, x, y) {
    if (thrower.zone === 'infield') return false;
    const onOwnSide = outfieldOnLeft(thrower.team) ? x < center : x > center;
    return onOwnSide && (x <= leftEnd || x >= rightEnd || y <= innerTop || y >= innerBottom);
  }

  function giveTurnoverBall(thrower) {
    // First show the dead ball where it landed for half a second.
    // No team may collect or throw it while the turnover is pending.
    if (ball.pendingTurnover) return;
    stopFlight(0, 0);
    ball.owner = null;
    ball.x = clamp(ball.x, margin + ballRadius, W - margin - ballRadius);
    ball.y = clamp(ball.y, margin + ballRadius, H - margin - ballRadius);
    ball.vx = 0;
    ball.vy = 0;
    ball.looseOutfieldAttackFrom = null;
    ball.pendingTurnover = {team:1 - thrower.team, remaining:.5};
    ballIdle = 0;
    $('status').textContent = '外野の球が落ちた！ 0.5秒後に相手ボール';
  }

  function finishTurnoverBall() {
    const pending = ball.pendingTurnover;
    if (!pending) return;
    const receiver = nearest(ball, infield(pending.team));
    if (receiver) {
      takeBall(receiver);
      $('status').textContent = '外野の投球が無効になったため、' + teamName(pending.team) + 'チームのボール！';
    } else {
      ball.pendingTurnover = null;
    }
  }

  function moveShot(dt) {
    const {from, target, kind} = ball.shot;
    const step = Math.min(dt, ball.flight);
    const dx = ball.vx * step, dy = ball.vy * step;
    let contact = 1;
    let hit = null;
    for (const p of players) {
      const eligible = kind === 'pass'
        ? p === target || canTarget(from, p, 'attack')
        : canTarget(from, p, 'attack') || (p.team !== from.team && p.zone !== 'infield') ||
          (from.zone !== 'infield' && p.team === from.team && p.zone === 'infield');
      if (!eligible) continue;
      const along = contactTime(p, dx, dy);
      if (along <= contact) {
        contact = along;
        hit = p;
      }
    }
    const beforeX = ball.x;
    ball.x += dx * contact;
    ball.y += dy * contact;
    if (kind === 'attack' && from.zone !== 'infield' &&
        ((beforeX < center && ball.x >= center) ||
         (beforeX > center && ball.x <= center))) {
      ball.shot.crossedCenter = true;
    }
    if (hit) {
      const manualCatch = hit === controlled && hit.catchUntil > time;
      const safeCatch = hit.zone !== 'infield' ||
        (from.team === hit.team && from.zone !== 'infield');
      if (kind === 'pass' || manualCatch || safeCatch) {
        hit.catchUntil = 0;
        takeBall(hit, kind === 'pass' && hit === target || safeCatch);
        if (manualCatch || safeCatch) $('status').textContent = 'キャッチ成功！ Spaceで投球・Pでパス';
      } else hitPlayer(hit, from);
      return;
    }
    ball.trail.push({x:ball.x, y:ball.y});
    if (ball.trail.length > 10) ball.trail.shift();
    ball.flight -= step;
    const x = clamp(ball.x, margin + ballRadius, W - margin - ballRadius);
    const y = clamp(ball.y, margin + ballRadius, H - margin - ballRadius);
    if (ball.x !== x || ball.y !== y || ball.flight <= 0) {
      if (kind === 'attack' && from.zone !== 'infield' &&
          (!ball.shot.crossedCenter || missedShotInThrowersOutfield(from, x, y))) {
        giveTurnoverBall(from);
        return;
      }
      stopFlight(0, .15);
      ball.looseOutfieldAttackFrom = kind === 'attack' && from.zone !== 'infield' ? from : null;
    }
    ball.x = x;
    ball.y = y;
  }

  function moveLooseBall(dt) {
    if (ball.pendingTurnover) return;
    ballIdle += dt;
    if (ballIdle >= 6) {
      ball.x = center + (Math.random() < .5 ? -90 : 90);
      ball.y = H / 2;
      stopFlight(0, 0);
      ballIdle = 0;
      $('status').textContent = 'ボールを中央付近に戻したよ！';
    }
    ball.x = clamp(ball.x + ball.vx * dt, margin + ballRadius, W - margin - ballRadius);
    ball.y = clamp(ball.y + ball.vy * dt, margin + ballRadius, H - margin - ballRadius);
    const drag = Math.exp(-3 * dt);
    ball.vx *= drag;
    ball.vy *= drag;
    ball.lock = Math.max(0, ball.lock - dt);
    if (ball.lock > 0) return;
    const p = nearest(ball, looseBallCandidates());
    if (p && distance(p, ball) <= R + ballRadius) {
      if (p.zone !== 'infield' && ball.looseOutfieldAttackFrom?.team === p.team) {
        giveTurnoverBall(ball.looseOutfieldAttackFrom);
      } else takeBall(p);
    }
  }

  function update(dt) {
    time += dt;
    updateSpeedDisplay();
    if (ball.pendingTurnover) {
      ball.pendingTurnover.remaining -= dt;
      if (ball.pendingTurnover.remaining <= 0) finishTurnoverBall();
      effects = effects.filter(e => (e.life -= dt) > 0);
      return;
    }
    const chaser = nearest(ball, looseBallCandidates().filter(p => p !== controlled));
    for (const p of players) {
      p.wait = Math.max(0, p.wait - dt);
      if (p === controlled) moveControlled(p, dt);
      else moveAI(p, chaser, dt);
    }
    if (ball.owner) {
      ball.x = ball.owner.x;
      ball.y = ball.owner.y - 15;
    } else if (ball.shot) moveShot(dt);
    else moveLooseBall(dt);
    effects = effects.filter(e => (e.life -= dt) > 0);
  }
  function draw() {
    ctx.clearRect(0,0,W,H);
    ctx.fillStyle='#21576a';ctx.fillRect(0,0,W,H);
    for (const team of [0, 1]) {
      ctx.fillStyle = team === 1 ? '#7c3e51' : '#1d567c';
      ctx.fillRect(outfieldOnLeft(team) ? margin : center, margin, center - margin, H - 2 * margin);
    }
    ctx.fillStyle='#286e88';ctx.fillRect(leftEnd,innerTop,center-leftEnd,innerBottom-innerTop);
    ctx.fillStyle='#68556b';ctx.fillRect(center,innerTop,rightEnd-center,innerBottom-innerTop);
    // Top/bottom central area: move and catch, but no outfield attacks.
    ctx.fillStyle='#132d403f';
    for(const yy of [margin,innerBottom]){
      ctx.fillRect(throwLeftThird,yy,center-throwLeftThird,innerTop-margin);
      ctx.fillRect(center,yy,throwRightThird-center,innerTop-margin);
    }
    ctx.strokeStyle='#dfebee';ctx.lineWidth=3;
    ctx.strokeRect(margin,margin,W-2*margin,H-2*margin);
    ctx.beginPath();ctx.moveTo(center,margin);ctx.lineTo(center,H-margin);ctx.stroke();
    ctx.setLineDash([9,5]);ctx.strokeStyle='#ffe46b';ctx.lineWidth=3;
    ctx.strokeRect(leftEnd,innerTop,rightEnd-leftEnd,innerBottom-innerTop);
    ctx.setLineDash([]);
    ctx.strokeStyle='#ff7777';ctx.lineWidth=4;ctx.beginPath();
    for(const xx of [throwLeftThird,throwRightThird]){
      ctx.moveTo(xx,margin);ctx.lineTo(xx,innerTop);
      ctx.moveTo(xx,innerBottom);ctx.lineTo(xx,H-margin);
    }
    ctx.stroke();
    ctx.fillStyle='#eaf6ff';ctx.font='bold 15px system-ui';ctx.textAlign='center';
    for (const team of [0, 1]) {
      const label = teamName(team) + ' 外野';
      const left = outfieldOnLeft(team);
      ctx.fillText(label, left ? (margin + leftEnd) / 2 : W - (margin + leftEnd) / 2, 158);
      ctx.fillText(label, left ? leftEnd + 35 : rightEnd - 35, margin + 25);
    }
    ctx.fillText('青 内野',leftEnd+120,innerTop+25);ctx.fillText('赤 内野',rightEnd-120,innerTop+25);
    ctx.font='bold 12px system-ui';
    ctx.fillText('投球不可',center-60,margin+26);ctx.fillText('投球不可',center+60,margin+26);
    ctx.fillText('投球不可',center-60,H-margin-15);ctx.fillText('投球不可',center+60,H-margin-15);
    ctx.strokeStyle='#dfebee';ctx.lineWidth=2;ctx.globalAlpha=.35;ctx.beginPath();ctx.arc(center,H/2,52,0,Math.PI*2);ctx.stroke();ctx.globalAlpha=1;
    for (const p of players) {
      ctx.fillStyle='#102e3d55';ctx.beginPath();ctx.ellipse(p.x,p.y+18,22,9,0,0,Math.PI*2);ctx.fill();
      if (p === controlled || ball.owner === p) {
        ctx.strokeStyle = ball.owner === p ? '#ffe17b' : '#9de6ff';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(p.x, p.y, R + 7 + Math.sin(time * 5) * 1.5, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (p.zone === 'returning' || p.catchUntil > time) {
        ctx.strokeStyle = p.zone === 'returning' ? '#fff' : '#b8ffd8';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.arc(p.x, p.y, R + 3, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.fillStyle=p.team?'#f1767d':'#58b1ff';ctx.beginPath();ctx.arc(p.x,p.y,R,0,Math.PI*2);ctx.fill();
      ctx.fillStyle='white';ctx.font='bold 18px system-ui';ctx.textAlign='center';ctx.fillText(p.number,p.x,p.y+6);
      const label = p === controlled ? 'あなた' : {starter:'初期', returning:'復帰可'}[p.zone];
      if (label) {
        ctx.font = 'bold 13px system-ui';
        ctx.fillStyle = '#fff';
        ctx.fillText(label, p.x, p.y - 29);
      }
    }
    if (ball.shot) ball.trail.forEach((point, i) => {
      ctx.globalAlpha = i / 12;
      ctx.fillStyle = ball.shot.kind === 'pass' ? '#b8ffd8' : '#ffe17b';
      ctx.beginPath();
      ctx.arc(point.x, point.y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    });
    ctx.fillStyle='#ffe183';ctx.strokeStyle='#be782e';ctx.lineWidth=2;ctx.beginPath();ctx.arc(ball.x,ball.y,10,0,Math.PI*2);ctx.fill();ctx.stroke();
    for(const e of effects){ctx.globalAlpha=e.life/.6;ctx.strokeStyle='#ffe9ac';ctx.lineWidth=4;ctx.beginPath();ctx.arc(e.x,e.y,20+(1-e.life/.6)*50,0,Math.PI*2);ctx.stroke();ctx.font='bold 19px system-ui';ctx.fillStyle='white';ctx.fillText('アウト！',e.x,e.y-35);ctx.globalAlpha=1;}
  }
  const movementKeys = ['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd'];
  document.addEventListener('keydown', event => {
    const key = event.key.toLowerCase();
    if (state !== 'playing' || !controlled || event.target?.tagName === 'SELECT') return;
    if (movementKeys.includes(key)) {
      event.preventDefault();
      keys.add(key);
    } else if ([' ', 'p', 'c'].includes(key)) {
      event.preventDefault();
      if (event.repeat) return;
      if (key === 'c') {
        if (ball.shot?.kind === 'attack' && ball.shot.from.team !== controlled.team && time >= controlled.nextCatch) {
          controlled.catchUntil = time + Number($('catchSetting').value);
          controlled.nextCatch = time + 1;
        }
      } else {
        const kind = key === 'p' ? 'pass' : 'attack';
        throwBall(controlled, kind, selectTarget(controlled, kind));
      }
    }
  });
  document.addEventListener('keyup', event => keys.delete(event.key.toLowerCase()));
  window.addEventListener('blur', () => keys.clear());
  document.addEventListener('visibilitychange', () => {
    keys.clear();
    last = performance.now();
  });
  $('speedSetting').addEventListener('change', updateSpeedDisplay);
  $('start').addEventListener('click', start);
  $('restart').addEventListener('click', start);
  canvas.tabIndex = 0;
  reset();

  function frame(now) {
    const dt = Math.min((now - last) / 1000, .035);
    last = now;
    if (state === 'playing') update(dt);
    draw();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
