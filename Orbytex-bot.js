/**
 * Orbytex auto-player v7 — exact-state + time-dilation edition.
 *
 * Run:
 *   1. New tab -> https://orbytex.neonwarp.com
 *   2. F12 -> Console, paste this whole file, Enter
 *
 * Commands:
 *   __orbyBot.stop()          stop everything and restore the game clock
 *   __orbyBot.debug()         print current state
 *   __orbyBot.test()          press space once
 *   __orbyBot.setSpeed(0.3)   run the GAME at 30% speed (bot stays realtime).
 *                             1 = normal speed. Lower = slower = higher ceiling.
 *   __orbyBot.setThrottle(3)  fallback: only let the game update every Nth frame
 *                             (use ONLY if setSpeed visibly does nothing)
 *
 * Why time dilation: the game moves the ball in discrete per-frame steps that
 * grow with the score. Once one step is wider than the arc, NO frame ever has
 * the ball inside the zone — mathematically unbeatable by pressing keys.
 * Slowing the game clock shrinks the step size, so precision holds at any score.
 */
(() => {
  'use strict';
  if (window.__orbyBot) { try { window.__orbyBot.stop(); } catch (e) {} }

  const log = (...a) => console.log('[orbybot]', ...a);

  if (!/orbytex/i.test(location.host)) {
    console.error('%c[orbybot] WRONG CONSOLE CONTEXT', 'color:#ff4444;font-size:15px;font-weight:bold');
    console.error('[orbybot] Open https://orbytex.neonwarp.com directly in a new tab and paste there.');
    return;
  }

  // ---------------- tunables ----------------
  const CFG = {
    TIME_SCALE: 0.35,      // game speed on start (0.35 = 35%); __orbyBot.setSpeed(x) to change live
    DOUBLE_TAP_GUARD: 70,  // min real-ms between presses
    LOCK_MS: 500,          // max hold of the one-press-per-arc lock
    IDLE_RESTART: 1200,    // real-ms of frozen ball before restarting
  };

  const TAU = Math.PI * 2;
  const deg = r => (r * 180 / Math.PI).toFixed(1) + '°';
  const norm = a => ((a % TAU) + TAU) % TAU;
  const angDiff = (a, b) => { let d = norm(a - b); if (d > Math.PI) d -= TAU; return d; };

  // ---------------- REAL clock for the bot ----------------
  const realNow = performance.now.bind(performance);

  // ---------------- time dilation for the GAME ----------------
  let scale = CFG.TIME_SCALE;
  let rAnchor = realNow(), vAnchor = rAnchor;
  const vnow = () => vAnchor + (realNow() - rAnchor) * scale;
  function setSpeed(s) {
    s = Math.max(0.02, Math.min(4, +s || 1));
    vAnchor = vnow(); rAnchor = realNow(); scale = s;
    log('%cgame time scale = ' + s + (s < 1 ? '  (game slowed to ' + Math.round(s * 100) + '%)' : ''), 'color:#03a9f4;font-weight:bold');
  }
  performance.now = vnow;                      // game reads the slowed clock

  let minGameInterval = 0;                     // frame-throttle fallback (0 = off)
  function setThrottle(n) {
    minGameInterval = n > 1 ? (n * 16.6 - 4) : 0;
    log('game frame throttle = ' + (n > 1 ? ('every ' + n + ' frames') : 'off'));
  }

  let running = true, lastFire = 0, hits = 0, presses = 0;

  // ---------------- input (keyboard only) ----------------
  function press(reason) {
    presses++;
    log('>>> PRESS #' + presses + ' — ' + reason);
    const o = { key: ' ', code: 'Space', keyCode: 32, which: 32, bubbles: true, cancelable: true };
    const targets = [window, document, document.body, document.activeElement];
    targets.forEach(t => { try { t && t.dispatchEvent(new KeyboardEvent('keydown', o)); } catch (e) {} });
    setTimeout(() => targets.forEach(t => { try { t && t.dispatchEvent(new KeyboardEvent('keyup', o)); } catch (e) {} }), 25);
  }

  function dumpMarkup(reason) {
    console.log('%c[orbybot] ' + reason + ' — copy the block below into the chat:', 'color:orange;font-weight:bold');
    const svg = document.querySelector('svg');
    console.log(svg ? svg.outerHTML.slice(0, 6000) : document.body.innerHTML.slice(0, 4000));
  }

  // ================================================================
  // EXACT engine — reads the game's true state from the SVG markup:
  //   ball  : <circle cx cy style="transform: rotate(Xdeg)">  -> angle = base + X
  //   arc   : <path d="M x1,y1 A r,r 0 laf,sweep x2,y2">      -> exact interval
  // ================================================================
  const engine = {
    state: 'boot',
    cx: 50, cy: 50,
    prevA: null, prevT: 0, w: 0, wReset: true,
    lock: null, pendingFire: null, lastD: '', arcCache: null,
    lastRotMove: realNow(),
    lastBallAngle: null, lastSpeed: 0, lastSweep: 0, lastArc: null, lastWin: 0,
    pressLog: [], warned: false,

    parts() {
      const svg = document.querySelector('svg');
      if (!svg) return null;
      let ball = null, ring = null;
      for (const c of svg.querySelectorAll('circle')) {
        const st = (c.getAttribute('style') || '') + (c.style.transform || '');
        if (/rotate\(/.test(st)) ball = c;
        else if (parseFloat(c.getAttribute('r')) > 20) ring = c;
      }
      const arc = svg.querySelector('path');
      if (ring) { this.cx = +ring.getAttribute('cx') || 50; this.cy = +ring.getAttribute('cy') || 50; }
      return ball ? { svg, ball, arc } : null;
    },

    ballAngle(ball) {
      const m = /rotate\(\s*(-?[\d.]+)deg/.exec(ball.style.transform || ball.getAttribute('style') || '');
      if (!m) return null;
      const bx = +ball.getAttribute('cx'), by = +ball.getAttribute('cy');
      const base = Math.atan2(by - this.cy, bx - this.cx);
      return norm(base + (+m[1]) * Math.PI / 180);
    },

    ballHalfAngle(ball) {
      const r = parseFloat(ball.getAttribute('r')) || 4;
      const R = Math.hypot((+ball.getAttribute('cx')) - this.cx, (+ball.getAttribute('cy')) - this.cy) || 46;
      return Math.asin(Math.min(0.9, r / R));
    },

    parseArc(arcEl) {
      if (!arcEl) { this.arcCache = null; this.lastD = ''; return null; }
      const d = arcEl.getAttribute('d') || '';
      if (d === this.lastD) return this.arcCache;
      this.lastD = d;
      const m = /M\s*(-?[\d.eE]+)[,\s]+(-?[\d.eE]+)\s*A\s*(-?[\d.eE]+)[,\s]+(-?[\d.eE]+)[,\s]+(-?[\d.eE]+)[,\s]+([01])[,\s]*([01])[,\s]+(-?[\d.eE]+)[,\s]+(-?[\d.eE]+)/.exec(d);
      if (!m) { this.arcCache = null; return null; }
      const x1 = +m[1], y1 = +m[2], sweep = +m[7], x2 = +m[8], y2 = +m[9];
      const a1 = norm(Math.atan2(y1 - this.cy, x1 - this.cx));
      const a2 = norm(Math.atan2(y2 - this.cy, x2 - this.cx));
      const span = sweep ? norm(a2 - a1) : norm(a1 - a2);
      const center = norm((sweep ? a1 : a2) + span / 2);
      this.arcCache = { center, half: span / 2, sig: d };
      return this.arcCache;
    },

    tick() {
      const P = this.parts();
      if (!P) {
        if (!this.warned) { this.warned = true; dumpMarkup('Could not find ball/arc in the SVG'); }
        return;
      }
      if (this.state === 'boot') { this.state = 'play'; log('locked onto game markup — ball + arc found. centre(' + this.cx + ',' + this.cy + ')'); }

      const tms = realNow();
      const a = this.ballAngle(P.ball);
      if (a === null) return;

      // frozen-ball watchdog (game over / menu without motion)
      if (this.lastBallAngle === null || Math.abs(angDiff(a, this.lastBallAngle)) > 0.002) this.lastRotMove = tms;
      else if (tms - this.lastRotMove > CFG.IDLE_RESTART && tms - lastFire > 500) {
        this.postMortem();
        lastFire = tms; this.lastRotMove = tms;
        if (!this.clickRestart()) press('ball frozen -> space to start/retry');
        else log('restarted');
        this.lock = null; this.pendingFire = null; this.wReset = true; this.prevA = null;
        return;
      }
      this.lastBallAngle = a;

      // angular velocity in REAL time
      const dtMs = this.prevT ? Math.min(100, Math.max(3, tms - this.prevT)) : 16.7;
      if (this.prevA !== null) {
        const raw = angDiff(a, this.prevA) / dtMs;
        this.w = this.wReset ? raw : this.w * 0.5 + raw * 0.5;
        this.wReset = false;
      }
      this.prevA = a; this.prevT = tms;
      this.lastSpeed = Math.abs(this.w) * 1000 * 180 / Math.PI;

      const arc = this.parseArc(P.arc);
      this.lastArc = arc;
      if (!arc) return;

      const half = arc.half;
      const ballHalf = this.ballHalfAngle(P.ball);
      const safety = Math.min(ballHalf * 0.6 + 0.01, half * 0.2);
      const win = Math.max(0.005, half - safety);
      this.lastWin = win;

      const d = angDiff(a, arc.center);
      const absD = Math.abs(d);
      const dNext = d + this.w * dtMs;
      const sweep = Math.abs(this.w) * dtMs;
      this.lastSweep = sweep;

      if (this.pendingFire && this.pendingFire !== arc.sig) this.pendingFire = null;
      const locked = this.lock && this.lock.sig === arc.sig && tms < this.lock.until;
      if (locked || tms - lastFire <= CFG.DOUBLE_TAP_GUARD) return;

      if (this.pendingFire === arc.sig) {          // deferred from last frame — this frame is closest to centre
        this.pendingFire = null;
        this.doFire(arc, d, 'deferred frame');
        return;
      }

      const crossing = Math.sign(d) !== Math.sign(dNext) && absD <= Math.min(1.2, half + sweep + ballHalf);

      if (absD <= win * 0.35) {
        this.doFire(arc, d, 'deep inside');
      } else if (crossing) {
        if (Math.abs(dNext) < absD) this.pendingFire = arc.sig;   // next frame lands closer
        else if (this.w) {
          const tc = Math.min(dtMs - 1, Math.max(0, -d / this.w));
          this.doFire(arc, d, 'scheduled +' + tc.toFixed(1) + 'ms', tc);
        } else this.doFire(arc, d, 'crossing');
      } else if (absD <= win && Math.abs(dNext) >= absD) {
        this.doFire(arc, d, sweep > win ? 'fast closest-approach' : 'inside window');
      }
    },

    doFire(arc, d, mode, delayMs) {
      this.lock = { sig: arc.sig, until: realNow() + CFG.LOCK_MS };
      this.wReset = true;
      lastFire = realNow();
      hits++;
      const info = 'HIT #' + hits + ' | off-centre ' + deg(Math.abs(d)) + ' | ' + this.lastSpeed.toFixed(0) + '°/s | arc ±' + deg(arc.half) + ' | ' + mode;
      this.pressLog.push({ t: realNow(), info });
      if (this.pressLog.length > 5) this.pressLog.shift();
      if (delayMs && delayMs > 1) setTimeout(() => { if (running) press(info); }, delayMs);
      else press(info);
    },

    clickRestart() {
      let best = null;
      for (const el of document.querySelectorAll('button, a, [role="button"], div, span, text')) {
        const txt = (el.textContent || '').trim();
        if (txt.length && txt.length < 25 && /try again|play again|retry|restart/i.test(txt)) {
          if (!best || txt.length < (best.textContent || '').trim().length) best = el;
        }
      }
      if (best) { log('clicking "' + best.textContent.trim() + '"'); best.click(); return true; }
      return false;
    },

    score() {
      const svg = document.querySelector('svg');
      if (!svg) return '?';
      for (const t of svg.querySelectorAll('text')) {
        const s = (t.textContent || '').trim();
        if (/^\d+$/.test(s)) return s;
      }
      return '?';
    },

    postMortem() {
      if (!hits) return;
      console.log('%c[orbybot] GAME OVER post-mortem: score~' + this.score() +
        ' | speed=' + this.lastSpeed.toFixed(0) + '°/s | step/frame=' + deg(this.lastSweep) +
        ' | arc=' + (this.lastArc ? '±' + deg(this.lastArc.half) : '?') +
        ' | timeScale=' + scale, 'color:#e91e63;font-weight:bold');
      this.pressLog.forEach(p => log('   recent: ' + ((realNow() - p.t) / 1000).toFixed(1) + 's ago — ' + p.info));
      if (this.lastArc && this.lastSweep > this.lastArc.half * 2) {
        console.log('%c[orbybot]    the ball stepped ' + deg(this.lastSweep) + ' per frame vs arc width ' + deg(this.lastArc.half * 2) +
          ' — lower the time scale further: __orbyBot.setSpeed(' + Math.max(0.05, (scale * 0.5).toFixed(2)) + ')', 'color:#e91e63');
      }
    },

    heartbeat() {
      log('status: hits=' + hits + ' score=' + this.score() +
        ' | speed=' + this.lastSpeed.toFixed(0) + '°/s step/frame=' + deg(this.lastSweep) +
        (this.lastArc ? ' | arc±' + deg(this.lastArc.half) + ' win±' + deg(this.lastWin) : ' | no arc') +
        ' | timeScale=' + scale);
    },
  };

  // ---------------- frame loop + rAF wrap ----------------
  let lastFrame = -1, lastBeat = 0, lastGameRun = 0;
  function analyze(t) {
    if (!running || t === lastFrame) return;
    lastFrame = t;
    try {
      engine.tick();
      if (realNow() - lastBeat > 1000) { lastBeat = realNow(); engine.heartbeat(); }
    } catch (e) { console.error('[orbybot] tick error:', e); }
  }
  const origRAF = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = cb => {
    const wrapped = t => {
      if (minGameInterval && realNow() - lastGameRun < minGameInterval) { origRAF(wrapped); return; }
      lastGameRun = realNow();
      const out = cb(vnow());          // the game receives the DILATED clock
      analyze(t);
      return out;
    };
    return origRAF(wrapped);
  };
  (function loop() { if (!running) return; origRAF(t => { analyze(t); loop(); }); })();

  window.__orbyBot = {
    stop() {
      running = false;
      window.requestAnimationFrame = origRAF;
      performance.now = realNow;
      log('stopped — game clock restored');
    },
    debug() { engine.heartbeat(); },
    test() { press('MANUAL TEST'); },
    setSpeed, setThrottle,
  };

  log('%cv7 running — exact state reading + game clock at ' + Math.round(scale * 100) + '%.', 'color:#4caf50;font-weight:bold');
  log('If the ball is NOT visibly slower, the game ignores the clock — try __orbyBot.setThrottle(3) instead.');
  log('__orbyBot.setSpeed(1) = normal speed | setSpeed(0.1) = very slow & very safe | __orbyBot.stop() to stop.');
})();