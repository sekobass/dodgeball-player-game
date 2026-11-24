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

function setup(seed = 31) {
  const elements = new Map(), listeners = new Map();
  const labels = [];
  const ctx = new Proxy({fillText: (label, x) => labels.push({label, x})}, {
    get: (target, key) => target[key] ?? (() => {})
  });
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      width:960, height:560, value:id === 'catchSetting' ? '0.4' : id === 'cpuDifficulty' ? 'normal' : '365', getContext:() => ctx, focus() {},
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
  assert.deepEqual([game.margin, game.leftEnd, game.rightEnd, game.innerTop, game.innerBottom], [32, 122, 838, 112, 448]);
  assert.ok(game.outfield(1)[0].x + game.R <= game.leftEnd);
  assert.ok(game.outfield(0)[0].x - game.R >= game.rightEnd);
  for (const team of [0, 1]) assert.equal(game.outfield(team)[0].number, 4);
  game.draw();
  assert.ok(labels.filter(entry => entry.label === '赤 外野').every(entry => entry.x < game.center));
  assert.ok(labels.filter(entry => entry.label === '青 外野').every(entry => entry.x > game.center));
  for (const label of ['赤 外野', '青 内野', '赤 内野', '青 外野', 'あなた', '初期']) {
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

test('an out switches controls, then a successful outfield attack restores the player', () => {
  const {game, element, labels} = setup();
  const original = game.controlled;
  const attacker = game.outfield(1)[0];
  aim(game, attacker, original);
  fly(game);
  assert.equal(original.zone, 'returning');
  assert.ok(original.x - game.R >= game.rightEnd);
  assert.notEqual(game.controlled, original);
  assert.deepEqual(count(element), [2, 2, 3, 1]);
  game.draw();
  assert.ok(labels.some(entry => entry.label === '復帰可'));

  const target = game.infield(1)[0];
  aim(game, original, target);
  fly(game);
  assert.equal(original.zone, 'infield');
  assert.ok(original.x < game.center);
  assert.deepEqual(count(element), [3, 1, 2, 2]);
  assert.equal(game.selectTarget(original, 'pass').zone, 'starter');
  aim(game, original, game.infield(1)[0]);
  fly(game);
  assert.deepEqual(count(element), [3, 1, 1, 3]);
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
  for (const seed of [17, 31, 46]) {
    const {game, element, press} = setup(seed);
    let shots = 0;
    let lastShot = null;
    for (let i = 0; i < 21600 && game.state === 'playing'; i++) {
      if (game.ball.owner && game.ball.owner === game.controlled) press(' ');
      game.update(1 / 60);
      if (game.ball.shot && game.ball.shot !== lastShot) shots++;
      lastShot = game.ball.shot;
      if (i % 60 !== 0) continue;
      for (const p of game.players) {
        const [min, max] = game.horizontalBounds(p);
        assert.ok(p.x >= min && p.x <= max);
        if (p.zone !== 'infield') assert.ok(game.outfieldPart(p));
      }
      for (const [inside, outside] of [[0, 1], [2, 3]]) {
        const counts = count(element);
        assert.equal(counts[inside] + counts[outside], 4);
      }
    }
    assert.ok(shots >= 3, `seed ${seed} produced ${shots} shots`);
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

  blue.x += 15;
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
