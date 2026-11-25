'use strict';

const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const {test} = require('node:test');
const {runInNewContext} = require('node:vm');

const source = readFileSync(join(__dirname, '..', 'game.js'), 'utf8');
// Run the actual browser script with a minimal DOM and expose its closure only in tests.
const script = source.replace(/\}\)\(\);\s*$/, `
  globalThis.game = {
    start, update, draw, move, throwBall, selectTarget, playBall, evade, moveShot, moveLooseBall,
    horizontalBounds, infield, outfield, contactTime, outfieldPart, legalOutfieldThrow,
    looseBallCandidates, cpuMode, margin, leftEnd, rightEnd, innerTop, innerBottom, center, R,
    get players() { return players; }, get ball() { return ball; },
    get controlled() { return controlled; }, get state() { return state; },
    get time() { return time; }
  };
})();
`);

function setup(seed = 31, size = 3) {
  const settings = {infieldCount:String(size), catchSetting:'0.4', cpuDifficulty:'normal', speedSetting:'365'};
  const elements = new Map(), listeners = new Map();
  const labels = [];
  const ctx = new Proxy({fillText: (label, x) => labels.push({label, x})}, {
    get: (target, key) => target[key] ?? (() => {})
  });
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      width:960, height:560, value:settings[id], getContext:() => ctx, focus() {},
      addEventListener:(type, listener) => listeners.set(id + ':' + type, listener)
    });
    return elements.get(id);
  }
  const math = Object.create(Math);
  math.random = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const context = {
    document:{querySelector:() => element('court'), getElementById:element,
      addEventListener:(type, listener) => listeners.set(type, listener)},
    window:{addEventListener() {}}, performance:{now:() => 0}, requestAnimationFrame() {}, Math:math
  };
  runInNewContext(script, context, {filename:'game.js'});
  const game = context.game;
  game.start();
  return {
    game, element, labels,
    click:id => listeners.get(id + ':click')(),
    release:key => listeners.get('keyup')({key}),
    press:(key, repeat = false) => listeners.get('keydown')({key, repeat, preventDefault() {}})
  };
}

function count(element) {
  return ['blueCount', 'blueOutCount', 'redCount', 'redOutCount'].map(id => element(id).textContent);
}

function fly(game) {
  for (let i = 0; i < 480 && game.ball.shot; i++) game.moveShot(1 / 120);
  assert.equal(game.ball.shot, null);
}

function aim(game, from, target, kind = 'attack') {
  from.y = target.y;
  game.ball.owner = from;
  assert.equal(game.throwBall(from, kind, target), true);
}

test('starts 3v3 infield and 1v1 outfield and renders outfield roles', () => {
  const {game, element, labels} = setup();
  assert.deepEqual(count(element), [3, 1, 3, 1]);
  assert.equal(game.players.length, 8);
  assert.equal(game.controlled.team, 0);
  assert.deepEqual([game.margin, game.leftEnd, game.rightEnd, game.innerTop, game.innerBottom], [32, 88, 872, 84, 476]);
  assert.ok(game.outfield(1)[0].x + game.R <= game.leftEnd);
  assert.ok(game.outfield(0)[0].x - game.R >= game.rightEnd);
  for (const team of [0, 1]) assert.equal(game.outfield(team)[0].number, 4);
  game.draw();
  assert.ok(labels.filter(entry => entry.label === '赤 外野').every(entry => entry.x < game.center));
  assert.ok(labels.filter(entry => entry.label === '青 外野').every(entry => entry.x > game.center));
  for (const label of ['赤 外野', '青 内野', '赤 内野', '青 外野', '▼ あなた', '初期']) {
    assert.ok(labels.some(entry => entry.label === label), label);
  }
});

test('clamps both outfields and rejects illegal releases and targets', () => {
  for (const team of [0, 1]) {
    const {game} = setup();
    const [p] = game.outfield(team);
    const opponent = game.infield(1 - team)[0];
    game.move(p, team ? 1000 : -1000, 0, 500, 2);
    assert.equal(team ? p.x + game.R : p.x - game.R, team ? game.leftEnd : game.rightEnd);
    game.ball.owner = p;
    assert.equal(game.throwBall(p, 'attack', game.outfield(1 - team)[0]), false);
    assert.equal(game.throwBall(p, 'attack', game.infield(team)[0]), false);
    assert.equal(game.selectTarget(p, 'pass').zone, 'infield');
    p.x += team ? 1 : -1;
    assert.equal(game.throwBall(p, 'attack', opponent), false);
    game.move(p, 0, 0, 0, 0);
    aim(game, p, opponent);
    assert.equal(game.ball.x, p.x);
    fly(game);
    assert.equal(opponent.zone, 'returning');
    assert.equal(p.zone, 'starter');
  }
});

test('P and AI exchange infield/outfield passes, even beyond the old flight limit', () => {
  const {game, element, press} = setup();
  const player = game.controlled;
  game.move(player, -1000, 0, 500, 2);
  for (const red of game.infield(1)) red.y = 415;
  player.y = 150;
  for (const blue of game.outfield(0)) blue.y = 150;
  element('speedSetting').value = '290';
  game.ball.owner = player;
  press('p');
  const receiver = game.ball.shot.target;
  assert.equal(game.ball.shot.kind, 'pass');
  assert.equal(receiver.zone, 'starter');
  assert.ok(game.ball.flight > 1.65);
  fly(game);
  assert.equal(game.ball.owner, receiver);
  assert.deepEqual(count(element), [3, 1, 3, 1]);
  aim(game, receiver, player, 'pass');
  fly(game);
  assert.equal(game.ball.owner, player);

  game.start();
  const cpu = game.outfield(1)[0];
  cpu.wait = 0;
  for (const p of game.infield(0)) p.x = 450;
  game.ball.owner = cpu;
  game.playBall(cpu, 1 / 60);
  assert.ok(game.ball.shot);
  assert.equal(game.ball.shot.target.zone, 'infield');
});

test('pass interception gives possession without an out or a return', () => {
  const {game, element} = setup();
  const [from, interceptor, target] = [game.infield(0)[0], game.infield(1)[0], game.outfield(0)[0]];
  aim(game, from, target, 'pass');
  interceptor.y = target.y;
  fly(game);
  assert.equal(game.ball.owner, interceptor);
  assert.deepEqual(count(element), [3, 1, 3, 1]);
});

test('keyboard control and the overhead marker follow the same player out and back', () => {
  const {game, element, labels, press, release} = setup();
  const original = game.controlled;
  const attacker = game.outfield(1)[0];
  aim(game, attacker, original);
  fly(game);
  assert.equal(original.zone, 'returning');
  assert.ok(original.x - game.R >= game.rightEnd);
  assert.equal(game.controlled, original);
  assert.deepEqual(count(element), [2, 2, 3, 1]);
  game.draw();
  assert.ok(labels.some(entry => entry.label === '▼ あなた・復帰可'));
  assert.match(element('status').textContent, /同じ選手/);
  const before = original.y;
  press('ArrowDown');
  game.update(1 / 60);
  release('ArrowDown');
  assert.ok(original.y > before);

  const target = game.infield(1)[0];
  original.y = target.y;
  game.ball.owner = original;
  press(' ');
  assert.equal(game.ball.shot.from, original);
  fly(game);
  assert.equal(original.zone, 'infield');
  assert.ok(original.x < game.center);
  assert.equal(game.controlled, original);
  assert.match(element('status').textContent, /内野に復帰/);
  labels.length = 0;
  game.draw();
  assert.ok(labels.some(entry => entry.label === '▼ あなた'));
  const xBefore = original.x;
  press('ArrowLeft');
  game.update(1 / 60);
  release('ArrowLeft');
  assert.ok(original.x < xBefore);
  assert.deepEqual(count(element), [3, 1, 2, 2]);
  assert.equal(game.selectTarget(original, 'pass').zone, 'starter');
  aim(game, original, game.infield(1)[0]);
  fly(game);
  assert.deepEqual(count(element), [3, 1, 1, 3]);
});

test('the controlled outfielder can pass to a teammate in the infield', () => {
  const {game, press} = setup();
  const player = game.controlled;
  aim(game, game.outfield(1)[0], player);
  fly(game);

  const ally = game.infield(0)[0];
  player.y = ally.y;
  for (const enemy of game.infield(1)) enemy.y = 420;
  game.ball.owner = player;
  press('p');
  assert.equal(game.ball.shot.from, player);
  assert.equal(game.ball.shot.kind, 'pass');
  assert.equal(game.ball.shot.target, ally);
  fly(game);
  assert.equal(game.ball.owner, ally);
  assert.equal(game.controlled, player);
  assert.equal(player.zone, 'returning');
});

test('a returning player cannot return through a friendly pass or a caught attack', () => {
  const {game, element, press} = setup();
  const [starter, returning] = [game.outfield(0)[0], game.infield(1)[0]];
  aim(game, starter, returning);
  fly(game);
  aim(game, returning, game.infield(1)[0], 'pass');
  fly(game);
  assert.equal(returning.zone, 'returning');
  const catcher = game.controlled;
  aim(game, returning, catcher);
  press('c');
  fly(game);
  assert.equal(game.ball.owner, catcher);
  assert.equal(returning.zone, 'returning');
  assert.deepEqual(count(element), [3, 1, 2, 2]);
  assert.match(element('status').textContent, /キャッチ成功/);
});

test('both teams win on the last infield out, and restart resets score and controls', () => {
  for (const winner of [0, 1]) {
    const {game, element} = setup();
    const from = game.outfield(winner)[0];
    for (const p of game.infield(1 - winner)) {
      aim(game, from, p);
      fly(game);
    }
    assert.equal(game.state, 'ended');
    assert.equal(game.infield(1 - winner).length, 0);
    assert.equal(game.outfield(1 - winner).length, 4);
    assert.equal(element('overlay').hidden, false);
    assert.match(element('status').textContent, winner ? /赤チームの勝利/ : /青チームの勝利/);
    game.start();
    assert.equal(element('overlay').hidden, true);
    assert.equal(game.controlled.number, 1);
    assert.deepEqual(count(element), [3, 1, 3, 1]);
  }
});

test('both teams evade attacks from either side and ignore friendly passes', () => {
  for (const team of [0, 1]) {
    for (const fromOutfield of [false, true]) {
      const {game} = setup();
      const defender = game.infield(team)[1];
      const opponent = fromOutfield ? game.outfield(1 - team)[0] : game.infield(1 - team)[0];
      aim(game, opponent, defender);
      const before = defender.y;
      assert.equal(game.evade(defender, 1 / 60), true);
      assert.notEqual(defender.y, before);
      game.ball.owner = game.outfield(team)[0];
      assert.equal(game.throwBall(game.ball.owner, 'pass', defender), true);
      assert.equal(game.evade(defender, 1 / 60), false);
    }
  }
});

test('AI runs up before throwing, outfielders track play and retrieve loose balls', () => {
  const {game} = setup();
  const cpu = game.infield(1)[0];
  game.ball.owner = cpu;
  game.playBall(cpu, 1 / 60);
  assert.equal(game.ball.owner, cpu);
  assert.ok(cpu.x < 580);
  for (let i = 0; i < 180 && !game.ball.shot; i++) game.playBall(cpu, 1 / 60);
  assert.ok(game.ball.shot);
  assert.ok(Math.abs(cpu.x - (game.center + game.R + 8)) <= 2);

  game.start();
  const [outfielder] = game.outfield(0);
  const initialY = outfielder.y;
  game.update(1 / 60);
  assert.notEqual(outfielder.y, initialY);
  game.ball.x = outfielder.x;
  game.ball.y = outfielder.y;
  game.moveLooseBall(1 / 60);
  assert.equal(game.ball.owner, outfielder);
  game.ball.owner = null;
  game.ball.x = game.center;
  game.ball.y = 50;
  for (let i = 0; i < 400 && game.ball.x === game.center; i++) game.moveLooseBall(1 / 60);
  assert.ok(Math.abs(game.ball.x - game.center) === 90);
});

test('runs a ten-minute match, increases speed at ten seconds, and caps it at threefold', () => {
  const {game, element, press} = setup();
  game.ball.owner = game.controlled;
  for (let i = 0; i < 599; i++) game.update(1 / 60);
  assert.equal(element('ballSpeed').textContent, '365 (1.00倍)');
  game.update(.02);
  assert.equal(element('ballSpeed').textContent, '426 (1.17倍)');
  for (let i = 0; i < 36000; i++) game.update(1 / 60);
  assert.ok(game.time > 600);
  assert.equal(game.state, 'playing');
  assert.equal(element('ballSpeed').textContent, '1095 (3.00倍・最高速)');
  element('speedSetting').value = '440';
  game.update(1 / 60);
  assert.equal(element('ballSpeed').textContent, '1320 (3.00倍・最高速)');
  press(' ');
  assert.equal(game.ball.shot.kind, 'attack');
  assert.equal(Math.round(Math.hypot(game.ball.vx, game.ball.vy)), 1320);
  assert.ok(game.contactTime({x:game.ball.x + 55, y:game.ball.y}, 120, 0) < 1);
});

test('seeded matches keep legal positions, progress through possessions, and conserve both rosters', () => {
  for (const [seed, size] of [[17, 1], [31, 3], [46, 5], [72, 10]]) {
    const {game, element, press} = setup(seed, size);
    const controlled = game.controlled;
    const shotTeams = new Set();
    let lastShot = null;
    for (let i = 0; i < 21600 && game.state === 'playing'; i++) {
      if (game.ball.owner && game.ball.owner === game.controlled) press(' ');
      game.update(1 / 60);
      if (game.ball.shot && game.ball.shot !== lastShot) shotTeams.add(game.ball.shot.from.team);
      lastShot = game.ball.shot;
      assert.equal(game.controlled, controlled);
      if (i % 60 !== 0) continue;
      for (const p of game.players) {
        const [min, max] = game.horizontalBounds(p);
        assert.ok(p.x >= min && p.x <= max);
        if (p.zone === 'infield') {
          assert.ok(p.y >= game.innerTop + game.R && p.y <= game.innerBottom - game.R);
        } else assert.ok(game.outfieldPart(p));
      }
      for (const [inside, outside] of [[0, 1], [2, 3]]) {
        const counts = count(element);
        assert.equal(counts[inside] + counts[outside], size + 1);
      }
    }
    assert.deepEqual([...shotTeams].sort(), [0, 1], `size ${size}: both teams shoot`);
  }
});

test('each U connects its endline and both arms, where central throws are blocked', () => {
  for (const team of [0, 1]) {
    const {game, element} = setup();
    assert.deepEqual({...game.cpuMode()}, {dodge:1, move:1, hold:1, aim:0});
    element('cpuDifficulty').value = 'easy';
    const [p] = game.outfield(team);
    const centralX = game.center + (team === 1 ? -35 : 35);
    for (const [part, y] of [['top', game.innerTop - game.R], ['bottom', game.innerBottom + game.R]]) {
      for (let i = 0; i < 500; i++) {
        game.move(p, centralX - p.x, y - p.y, 150, 1 / 60);
        assert.ok(game.outfieldPart(p));
      }
      assert.ok(Math.abs(p.x - centralX) < .001);
      assert.equal(game.outfieldPart(p), part);
      Object.assign(game.ball, {x:p.x, y:p.y, owner:null});
      assert.equal(game.looseBallCandidates()[0], p);
      game.moveLooseBall(1 / 60);
      assert.equal(game.ball.owner, p);
      assert.equal(game.throwBall(p, 'attack', game.infield(1 - team)[0]), false);
      assert.equal(game.throwBall(p, 'pass', game.infield(team)[0]), false);
      assert.ok(p.wait >= .25 && p.wait <= .4);

      p.wait = 0;
      for (let i = 0; i < 180 && !game.ball.shot; i++) game.playBall(p, 1 / 60);
      assert.ok(game.ball.shot);
      assert.ok(game.legalOutfieldThrow(p));
      game.ball.shot = null;
    }
  }
});

test('both teams move their out players to the same end as their starter', () => {
  for (const team of [0, 1]) {
    const {game} = setup();
    const victim = game.infield(team)[0];
    aim(game, game.outfield(1 - team)[0], victim);
    fly(game);
    assert.equal(victim.zone, 'returning');
    const [starter] = game.outfield(team).filter(p => p.zone === 'starter');
    assert.equal(victim.x, starter.x);
    game.ball.owner = victim;
    assert.equal(game.throwBall(victim, 'pass', starter), false);
    assert.equal(game.selectTarget(victim, 'pass').zone, 'infield');
  }
});

test('an outfield shot can reach a friendly infield catcher through a friendly outfielder', () => {
  const {game, element} = setup();
  const [red] = game.outfield(1);
  const [blue] = game.outfield(0);
  const [target, returning] = game.infield(0);
  aim(game, red, returning);
  fly(game);
  assert.equal(returning.zone, 'returning');

  blue.x = game.horizontalBounds(blue)[1];
  aim(game, blue, game.infield(1)[0]);
  // Continue the original shot beyond the missed red infield towards blue.
  for (const p of game.infield(1)) p.y = 300;
  returning.y = blue.y;
  target.y = blue.y;
  fly(game);
  assert.equal(game.ball.owner, target);
  assert.equal(returning.zone, 'returning');
  assert.deepEqual(count(element), [2, 2, 3, 1]);
});

test('each configured roster is shared, fits the court, and is preserved on restart', () => {
  for (let size = 1; size <= 10; size++) {
    const {game, element, click} = setup(31, size);
    assert.deepEqual(count(element), [size, 1, size, 1]);
    click('restart');
    assert.deepEqual(count(element), [size, 1, size, 1]);
    assert.equal(element('infieldCount').disabled, true);
    assert.equal(game.controlled, game.infield(0)[0]);
    for (const team of [0, 1]) {
      const roster = game.infield(team);
      assert.equal(game.outfield(team)[0].number, size + 1);
      for (const p of roster) {
        const [min, max] = game.horizontalBounds(p);
        assert.ok(p.x >= min && p.x <= max);
        assert.ok(p.y >= game.innerTop + game.R && p.y <= game.innerBottom - game.R);
        for (const other of roster.filter(other => other.number < p.number)) {
          assert.ok(Math.hypot(p.x - other.x, p.y - other.y) >= 2 * game.R);
        }
      }
    }
  }
});

test('with one infield player, their out ends the match and unlocks the next roster', () => {
  const {game, element, click} = setup(31, 1);
  const player = game.controlled;
  aim(game, game.outfield(1)[0], player);
  fly(game);
  assert.equal(game.controlled, player);
  assert.equal(player.zone, 'returning');
  assert.equal(game.state, 'ended');
  assert.deepEqual(count(element), [0, 2, 1, 1]);
  assert.equal(element('infieldCount').disabled, false);
  element('infieldCount').value = '5';
  click('start');
  assert.notEqual(game.controlled, player);
  assert.deepEqual(count(element), [5, 1, 5, 1]);
});

test('a high-numbered infield player can return to a legal position', () => {
  const {game} = setup(31, 10);
  const player = game.infield(0)[9];
  aim(game, game.outfield(1)[0], player);
  fly(game);
  assert.equal(player.zone, 'returning');
  aim(game, player, game.infield(1)[0]);
  fly(game);
  assert.equal(player.zone, 'infield');
  assert.equal(game.controlled.number, 1);
  assert.ok(player.y >= game.innerTop + game.R && player.y <= game.innerBottom - game.R);
});

test('an allied infield CPU can catch an incoming attack and pass to an outfielder', () => {
  const {game} = setup();
  const ally = game.infield(0)[1];
  const outfielder = game.outfield(0)[0];
  aim(game, game.outfield(1)[0], ally);
  game.ball.x = ally.x - 50;
  for (let i = 0; i < 12 && game.ball.shot; i++) game.update(1 / 120);
  assert.equal(game.ball.owner, ally);
  assert.equal(ally.zone, 'infield');

  ally.x = game.center - game.R - 8;
  ally.wait = 0;
  outfielder.y = 430;
  for (const enemy of game.infield(1)) {
    enemy.x = 800;
    enemy.y = 150;
  }
  game.update(1 / 120);
  assert.equal(game.ball.shot.from, ally);
  assert.equal(game.ball.shot.kind, 'pass');
  assert.equal(game.ball.shot.target, outfielder);
  fly(game);
  assert.equal(game.ball.owner, outfielder);
});

test('all three opponent difficulty settings retain their tuning', () => {
  const {game, element} = setup();
  for (const [mode, expected] of [
    ['easy', {dodge:.25, move:.8, hold:1.6, aim:.2}],
    ['normal', {dodge:1, move:1, hold:1, aim:0}],
    ['hard', {dodge:1, move:1.22, hold:.6, aim:0}]
  ]) {
    element('cpuDifficulty').value = mode;
    assert.deepEqual({...game.cpuMode()}, expected);
  }
});

test('a missed outfield attack that does not cross center turns over after half a second', () => {
  const {game, element} = setup();
  const thrower = game.outfield(1)[0];
  const receiver = game.controlled;
  Object.assign(thrower, {x:200, y:game.innerTop - game.R});
  receiver.x = thrower.x;
  game.ball.owner = thrower;
  assert.equal(game.throwBall(thrower, 'attack', receiver), true);
  receiver.x = 300;
  fly(game);
  assert.equal(game.ball.owner, null);
  assert.equal(game.ball.pendingTurnover.remaining, .5);
  assert.match(element('status').textContent, /0.5秒後/);
  const landing = [game.ball.x, game.ball.y];
  const [nearest] = [...game.infield(0)].sort((a, b) =>
    Math.hypot(a.x - landing[0], a.y - landing[1]) - Math.hypot(b.x - landing[0], b.y - landing[1]));
  game.update(.49);
  assert.equal(game.ball.owner, null);
  assert.deepEqual([game.ball.x, game.ball.y], landing);
  game.update(.011);
  assert.equal(game.ball.pendingTurnover, null);
  assert.equal(game.ball.owner, nearest);
});

test('an outfielder cannot pick up a loose ball from their own outfield attack', () => {
  const {game} = setup();
  const thrower = game.outfield(0)[0];
  Object.assign(game.ball, {x:thrower.x, y:thrower.y, looseOutfieldAttackFrom:thrower});
  game.moveLooseBall(1 / 60);
  assert.equal(game.ball.owner, null);
  assert.equal(game.ball.pendingTurnover.team, 1);
  assert.equal(game.ball.pendingTurnover.remaining, .5);
});

test('manual catch uses the selected window and retains the one-second cooldown', () => {
  const {game, element, press} = setup();
  const player = game.controlled;
  const attacker = game.outfield(1)[0];
  element('catchSetting').value = '.25';
  aim(game, attacker, player);
  press('c');
  assert.equal(player.catchUntil, .25);
  assert.equal(player.nextCatch, 1);

  element('catchSetting').value = '1';
  press('c');
  assert.equal(player.catchUntil, .25);
  fly(game);
  assert.equal(game.ball.owner, player);

  game.update(.3);
  aim(game, attacker, player);
  press('c');
  assert.equal(player.catchUntil, 0);
  fly(game);
  assert.equal(player.zone, 'returning');
});
