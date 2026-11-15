// Real-time gaze for the bust: (state, viewer, dt) -> channels for rig.js.
// Pure JavaScript: no three.js, no DOM, no clock of its own. Seeded; same seed and same viewer
// path give the same channels, at any frame rate (it runs on a fixed internal tick).
//
//   const g = createGaze({ seed: 0, rig });      // rig: a rig.js Rig (for the head's eye midpoint)
//   const ch = step(g, viewer, dt);               // viewer: { pos, right, up? } in bust space, or null
//   rig.apply(ch)                                 // ch.target is the gaze target point
//
// Bust space is rig.json's frame (+X image-right, +Y up, +Z toward the viewer). Angles are in
// degrees, image space as in the wrapper: yaw > 0 toward image-right, pitch > 0 up. Gaze angles
// are directions from the head's (posed) eye midpoint; eye-in-head = gaze - head, as in
// wrapper/gaze/engine.py.
//
// The motion numbers are wrapper/gaze/engine.py GazeParams (ENGINE below; a test checks them
// against rig.json, which tools/export_xr.py reads from the engine). The behaviour numbers
// that are new for a live viewer come from docs/BRIEF_M14.md section D (LIVE below).

import { angles, direction } from './rig.js';

export const ENGINE = {
  sacc_vmax: 550.0, sacc_c: 6.0, sacc_min_dur: 0.018, min_isi: 0.15,
  undershoot_from: 12.0, undershoot: [0.06, 0.12], corrective_delay: [0.15, 0.22],
  glissade_frac: 0.02, glissade_tau: 0.035,
  drift_deg: 0.10,
  head_freq: 1.2, head_roll_coupling: -0.20, head_dip_gain: 0.064, head_dip_tau: 0.06,
  head_sway_deg: [0.55, 0.45, 0.30], head_sway_band: [0.08, 0.35],
  blink_close: 0.075, blink_hold: 0.030, blink_open: 0.165,
  blink_mean_gap: 3.2, blink_min_gap: 1.6, blink_forced_gap: 1.3, blink_evoked_from: 10.0,
  blink_eye_dip: 1.5, blink_eye_nasal: 1.0, eye_half_ipd: 0.0309,
  blink_partial_rate: 0.22, blink_partial_amp: [0.65, 0.75],
  verg_tau: 0.20,
  brow_from_pitch: [6.0, 24.0, 0.45], brow_tau: 0.09,
  brow_side_amp: 0.15, brow_side_lag: [0.020, 0.040],
  shift_from: 10.0, shift_full: 24.0, shift_brow: 0.31, shift_squint: 0.12,
  shift_rise: 0.20, shift_relax: 0.55,
  pupil_tau: 0.40, hippus: 0.024, hippus_band: [0.30, 1.00], near_gain: 0.065,
};

export const LIVE = {
  tick: 1 / 500,                 // s, internal clock
  eye_sep: 0.032,                // m, the wearer's eyes either side of their head position
  mouth_drop: 0.07,              // m below
  dwell: [0.6, 1.8],             // s on one face point
  mouth_share: 1 / 6,
  glance_every: [5, 10],         // s between glances away
  glance_hold: [0.4, 1.0],       // s
  glance_amp: [6, 12],           // deg from the wearer's face, to a side ...
  glance_down: [25, 50],         // ... or down and to a side, this many deg below the horizontal
  glance_down_share: 0.5,
  catchup_deg: 2.0,              // pursuit error that fires a catch-up saccade
  pursuit_gain: 0.95, pursuit_tau: 0.08, pursuit_pull: 0.5,
  head_trigger: 12,              // deg eye-in-head (to where the eyes are going)
  head_sustain: [6, 1.2],        // deg held for s
  head_share: 0.8,               // the head's goal is this share of the target's direction
  head_delay: [0.04, 0.10],      // s after the eyes
  head_track_stop: [3, 0.3],     // deg/s of the wearer, for s: the head stops tracking
  head_rate: 50,                 // deg/s: how fast the head's goal may move (a 60 deg step through
                                 // the 1.2 Hz follower alone peaks near 166 deg/s, a lurch)
  recentre_rate: 20,             // deg/s when it drifts back to centre after losing the wearer
  head_feedforward: 0.7,         // share of the goal's own speed fed to the follower: a moving
                                 // wearer is tracked with less lag (0 = the engine's plain follower)
  head_ff_tau: 0.10,             // s, low-pass on that speed so a stopping goal does not jolt
  busy_pursuit: 5,               // deg/s: while the wearer moves faster, no face jumps or glances
  head_yaw: [-60, 60], head_pitch: [-20, 25],
  roll_max: 3.0,                 // deg: the engine's roll per degree of yaw was tuned on 6 deg turns;
                                 // unbounded it is a 12 deg tilt held at the 60 deg limit
  dip_max: 2.5,                  // deg: same for the dip, a 4 deg nod on a fast 30 deg turn
  eye_yaw_max: 28, eye_up: 22, eye_down: 25,
  lost_range: 2.5,               // m
  lost_after: 2.0,               // s before the head gives up and recentres
  greet_after: 0.5,              // s lost before coming back counts as a return
  look_every: [1.5, 4.0], look_yaw: 20, look_pitch: [-8, 5], look_dist: 1.5,
  flash_amp: 0.35, flash_dur: 0.4,
  blink_gap_cap: 3,              // the random part of a spontaneous gap is capped at this many
                                 // times its mean: 6.4 s at most, an uncapped tail left some seeds
                                 // staring for 8 to 10 s, which reads as a stare
  greet_blink_gap: 0.1,          // s: the greeting always blinks; right after another it is a double blink
};

// ---- small maths -----------------------------------------------------------------------------

const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
const D2R = Math.PI / 180;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const addv = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const lerp3 = (a, b, u) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
const ang2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const degAngles = (v) => { const [y, p] = angles(v); return [y / D2R, p / D2R]; };

export function minjerk(u) {
  u = clamp(u, 0, 1);
  return u * u * u * (10 - 15 * u + 6 * u * u);
}
function skew(amp) { return 1 - 0.22 * Math.min(amp / 30, 1); }
export function profile(u, k) { return minjerk(Math.pow(clamp(u, 0, 1), k)); }
const PEAK = new Map();
function peakFactor(k, n = 2000) {
  const key = Math.round(k * 1e5);
  if (PEAK.has(key)) return PEAK.get(key);
  // numpy.gradient on linspace(0, 1, n): central differences inside, one-sided at the ends
  const h = 1 / (n - 1);
  let best = 0;
  for (let i = 0; i < n; i++) {
    const u = i * h;
    const g = i === 0 ? (profile(h, k) - profile(0, k)) / h
      : i === n - 1 ? (profile(1, k) - profile(1 - h, k)) / h
        : (profile(u + h, k) - profile(u - h, k)) / (2 * h);
    if (g > best) best = g;
  }
  PEAK.set(key, best);
  return best;
}
export function saccadePeakVelocity(amp, p = ENGINE) { return p.sacc_vmax * (1 - Math.exp(-amp / p.sacc_c)); }
export function saccadeDuration(amp, p = ENGINE) {
  if (amp <= 1e-6) return p.sacc_min_dur;
  return Math.max(p.sacc_min_dur, peakFactor(skew(amp)) * amp / saccadePeakVelocity(amp, p));
}

// mulberry32: small, fast, seedable
function rng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.uniform = (lo = 0, hi = 1) => lo + (hi - lo) * next();
  next.exp = (mean) => -mean * Math.log(1 - next());
  next.normal = () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
  return next;
}
const stream = (seed, k) => rng(Math.imul(seed + 1, 0x85ebca6b) ^ Math.imul(k + 1, 0xc2b2ae35));

/** Band-limited noise with unit RMS: a few sines with random frequency and phase (engine). */
function smoothNoise(r, fLo, fHi, n = 5) {
  const parts = [];
  for (let i = 0; i < n; i++) parts.push([r.uniform(fLo, fHi), r()]);
  const norm = Math.sqrt(2 / n);
  return (t) => {
    let s = 0;
    for (const [f, ph] of parts) s += Math.sin(2 * Math.PI * (f * t + ph));
    return s * norm;
  };
}
function envelope(t, t0, dur, attack = 0.18, release = 0.35) {
  const up = clamp((t - t0) / attack, 0, 1);
  const down = clamp((t - (t0 + dur)) / release, 0, 1);
  return 0.5 * (1 - Math.cos(Math.PI * up)) * 0.5 * (1 + Math.cos(Math.PI * down));
}

// ---- state -----------------------------------------------------------------------------------

export function createGaze({ seed = 0, rig = null, eyeMid = null, log = false, live = {}, engine = {} } = {}) {
  const P = { ...ENGINE, ...engine };
  const L = { ...LIVE, ...live };
  const R = {
    look: stream(seed, 1), glance: stream(seed, 2), sacc: stream(seed, 3), head: stream(seed, 4),
    blink: stream(seed, 5), brow: stream(seed, 6), noise: stream(seed, 7),
  };
  const nz = R.noise;
  const s = {
    P, L, R, rig,
    eyeMidRest: eyeMid || (rig ? rig.eyeMid : [0, 0.304, 0.0976]),
    t: 0, frameT: 0, acc: 0, lastViewer: null,
    g: [0, 0], d: 0.7, dTarget: 0.7,
    sac: null, glis: null, freeAt: 0, corrective: null,
    fix: null, mode: null, dwellEnd: 0, glanceAt: R.glance.uniform(...L.glance_every), glanceEnd: 0,
    lostSince: null, nextLook: 0, desired: null, desiredPrev: null, pursuitV: [0, 0],
    head: { y: 0, vy: 0, p: 0, vp: 0, goal: [0, 0], cmd: [0, 0], rate: L.head_rate, pending: null,
            tracking: false, slowSince: null, sustainSince: null, dipLP: 0, cmdV: [0, 0] },
    ticks: 0,
    blinks: [], nextBlink: blinkGap(R.blink, P, L),
    lastBlink: -10, blinkCount: 0,
    efforts: [], flashes: [], browLP: [0, 0], squintLP: 0, widenLP: 0, pupilLP: 0,
    browLean: (() => { const l = R.brow.uniform(0.86, 0.96); return R.brow() < 0.5 ? [l, 1] : [1, l]; })(),
    sway: [0, 1, 2].map(() => smoothNoise(nz, ...P.head_sway_band)),
    drift: [smoothNoise(nz, 0.3, 1.6), smoothNoise(nz, 0.3, 1.6)],
    hippus: smoothNoise(nz, ...P.hippus_band),
    out: null,
    log: log ? { saccades: [], blinks: [], glances: [], greets: [], lost: [], headGoals: [] } : null,
  };
  return s;
}

// ---- geometry ------------------------------------------------------------------------------

function eyeMidPosed(s) {
  if (!s.rig) return s.eyeMidRest;
  return s.rig.headPose({ head_yaw: s.headOut ? s.headOut[0] : 0, head_pitch: s.headOut ? s.headOut[1] : 0,
                          head_roll: s.headOut ? s.headOut[2] : 0 }).map(s.rig.eyeMid);
}

function facePoints(s, v) {
  const up = v.up || [0, 1, 0];
  return {
    L: sub(v.pos, scl(v.right, s.L.eye_sep)),       // the wearer's left eye
    R: addv(v.pos, scl(v.right, s.L.eye_sep)),
    M: sub(v.pos, scl(up, s.L.mouth_drop)),
  };
}

/** Is the wearer somewhere the bust can look at? Measured from the eyes at rest. */
function inRange(s, v) {
  if (!v) return false;
  const rel = sub(v.pos, s.eyeMidRest);
  const dist = len(rel);
  if (dist > s.L.lost_range || dist < 0.05) return false;
  const [y, p] = degAngles(rel);
  const L = s.L;
  return Math.abs(y) <= L.head_yaw[1] + L.eye_yaw_max && p <= L.head_pitch[1] + L.eye_up
    && p >= L.head_pitch[0] - L.eye_down;
}

// ---- events --------------------------------------------------------------------------------

function startSaccade(s, goal, dist, kind, primary = true) {
  const { P } = s;
  const t0 = Math.max(s.t, s.freeAt);
  if (t0 > s.t + 1e-9) return false;                 // refractory: the caller tries again later
  const g0 = s.g.slice();
  const amp = ang2(goal, g0);
  if (amp < 0.05) return true;
  let end = goal.slice(), short = 0;
  if (primary && amp > P.undershoot_from) {
    short = s.R.sacc.uniform(...P.undershoot);
    end = [g0[0] + (goal[0] - g0[0]) * (1 - short), g0[1] + (goal[1] - g0[1]) * (1 - short)];
  }
  const a = ang2(end, g0);
  const D = saccadeDuration(a, P);
  const gl = a >= 2 ? s.R.sacc.normal() * P.glissade_frac * a : 0;
  const unit = [(end[0] - g0[0]) / a, (end[1] - g0[1]) / a];
  s.sac = { t0, D, k: skew(a), g0, g1: end, gl: [unit[0] * gl, unit[1] * gl], short, kind };
  s.freeAt = t0 + D + P.min_isi;
  s.dTarget = dist;
  if (s.log) s.log.saccades.push({ t: t0, amp: a, kind });
  if (primary && kind !== 'catchup' && kind !== 'corrective') onShift(s, amp, kind);
  return true;
}

/** A real gaze shift: maybe a gaze-evoked blink, brow and lid effort when it is large. */
function onShift(s, amp, kind) {
  const { P } = s;
  if (kind !== 'greet') {
    const chance = clamp((amp - P.blink_evoked_from) / 22, 0, 0.85);
    if (s.R.blink() < chance) blink(s, s.t - 0.02, 1.0, true);
  }
  const a = clamp((amp - P.shift_from) / (P.shift_full - P.shift_from), 0, 1);
  if (a > 0) s.efforts.push({ t0: s.t, a, sides: browSides(s) });
}

function browSides(s) {
  const r = s.R.brow, P = s.P;
  const weak = 1 - r.uniform(0, P.brow_side_amp);
  const lag = r.uniform(...P.brow_side_lag);
  const gain = r() < 0.5 ? [weak, 1] : [1, weak];
  const delay = r() < 0.5 ? [lag, 0] : [0, lag];
  return [[gain[0], delay[0]], [gain[1], delay[1]]];
}

function blinkGap(r, P, L) {
  const m = P.blink_mean_gap - P.blink_min_gap;
  return P.blink_min_gap + Math.min(r.exp(m), L.blink_gap_cap * m);
}

function blink(s, t0, amp, forced, gapOverride = null) {
  const { P } = s;
  const gap = gapOverride ?? (forced ? P.blink_forced_gap : P.blink_min_gap);
  if (t0 - s.lastBlink < gap) return false;
  const r = s.R.blink;
  const roll = r(), part = r.uniform(...P.blink_partial_amp);
  if (!forced) amp = r.uniform(0.85, 1.0);
  if (s.blinkCount > 0 && roll < P.blink_partial_rate && !forced) amp = part;
  const j = r.uniform(0.88, 1.12);
  s.blinks.push({ t0, amp, ampR: amp * r.uniform(0.97, 1.0), lag: r.uniform(-0.004, 0.004),
                  c: P.blink_close * j, h: P.blink_hold * j, o: P.blink_open * j });
  s.lastBlink = t0;
  s.blinkCount += 1;
  s.nextBlink = Math.max(s.nextBlink, t0 + blinkGap(r, P, s.L));
  if (s.log) s.log.blinks.push({ t: t0, amp, forced });
  return true;
}

function blinkShape(b, x) {
  if (x < 0 || x > b.c + b.h + b.o) return 0;
  if (x < b.c) return minjerk(x / b.c);
  if (x < b.c + b.h) return 1;
  return 1 - minjerk((x - b.c - b.h) / b.o);
}

function headGoalFor(s, dir) {
  const L = s.L;
  return [clamp(L.head_share * dir[0], ...L.head_yaw), clamp(L.head_share * dir[1], ...L.head_pitch)];
}
function setHeadGoal(s, dir, track) {
  const goal = headGoalFor(s, dir);
  if (ang2(goal, s.head.goal) < 0.5 && track === s.head.tracking) return;   // nothing to change
  const rate = s.mode === 'search' ? s.L.recentre_rate : s.L.head_rate;       // looking around: slowly
  s.head.pending = { at: s.t + s.R.head.uniform(...s.L.head_delay), goal, track, rate };
  if (s.log) s.log.headGoals.push({ t: s.t, goal });
}

// ---- one internal tick ---------------------------------------------------------------------

function tick(s, v) {
  const { P, L } = s;
  const t = s.t;
  const mid = eyeMidPosed(s);
  const here = inRange(s, v);
  const pts = here ? facePoints(s, v) : null;
  const dirTo = (p) => { const rel = sub(p, mid); return { dir: degAngles(rel), dist: len(rel) }; };

  // -- modes: engaged (face / glance), lost (lostHold, then search) -------------------------
  if (s.mode === null) {
    if (here) {
      s.mode = 'face';
      s.fix = { kind: 'face', which: s.R.look() < 0.5 ? 'L' : 'R' };
      const d0 = dirTo(pts[s.fix.which]);
      s.g = d0.dir.slice(); s.d = s.dTarget = d0.dist;
      s.dwellEnd = t + s.R.look.uniform(...L.dwell);
    } else {
      s.mode = 'search'; s.lostSince = t - L.lost_after; s.nextLook = t + 0.5;
      s.fix = { kind: 'dir', dir: [0, 0], dist: L.look_dist };
    }
  }
  const engaged = s.mode === 'face' || s.mode === 'glance';
  if (engaged && !here) {
    s.mode = 'lostHold'; s.lostSince = t;
    s.fix = { kind: 'dir', dir: s.g.slice(), dist: s.d };
    s.head.tracking = false;
    if (s.log) s.log.lost.push({ t });
  } else if (!engaged && here) {
    const greet = t - s.lostSince > L.greet_after;
    s.mode = 'face';
    s.fix = { kind: 'face', which: s.R.look() < 0.5 ? 'L' : 'R' };
    s.sac = null; s.corrective = null; s.freeAt = Math.min(s.freeAt, t);
    const d0 = dirTo(pts[s.fix.which]);
    startSaccade(s, d0.dir, d0.dist, greet ? 'greet' : 'return');
    s.dwellEnd = t + (s.sac ? s.sac.D : 0) + s.R.look.uniform(...L.dwell);
    s.glanceAt = Math.max(s.glanceAt, t + s.R.glance.uniform(...L.glance_every));
    if (greet) {
      blink(s, t, 1.0, true, L.greet_blink_gap);
      s.flashes.push({ t0: t, amp: L.flash_amp, dur: L.flash_dur, sides: browSides(s) });
      if (s.log) s.log.greets.push({ t });
    }
  } else if (s.mode === 'lostHold' && t - s.lostSince >= L.lost_after) {
    s.mode = 'search';
    s.head.pending = { at: t, goal: [0, 0], track: false, rate: L.recentre_rate };   // drift back to centre
    s.nextLook = t + s.R.look.uniform(0.3, 1.0);
    s.recentred = false;
  }

  // -- where the eyes want to be ----------------------------------------------------------
  let desired, desiredDist, person = null;
  if (s.fix.kind === 'face') {
    const d0 = dirTo(pts[s.fix.which]);
    desired = d0.dir; desiredDist = d0.dist;
    person = dirTo(v.pos).dir;                          // the head turns to the person, the eyes to an eye
  } else {
    desired = s.fix.dir; desiredDist = s.fix.dist;
  }
  // angular velocity of what is fixated (pursuit), deg/s
  if (s.desiredPrev && s.fix.kind === 'face' && s.desiredPrevKey === s.fix.which) {
    const vy = (desired[0] - s.desiredPrev[0]) / L.tick, vp = (desired[1] - s.desiredPrev[1]) / L.tick;
    const a = L.tick / (L.pursuit_tau + L.tick);
    s.pursuitV = [s.pursuitV[0] + a * (vy - s.pursuitV[0]), s.pursuitV[1] + a * (vp - s.pursuitV[1])];
  } else if (s.fix.kind !== 'face') {
    s.pursuitV = [0, 0];
  }
  s.desiredPrev = desired.slice();
  s.desiredPrevKey = s.fix.kind === 'face' ? s.fix.which : null;
  const free = !s.sac && t >= s.freeAt;
  if (s.mode === 'face' && Math.hypot(...s.pursuitV) > L.busy_pursuit) {
    // tracking someone who moves: stay on the same point, glance later
    s.dwellEnd = Math.max(s.dwellEnd, t + 0.3);
    s.glanceAt = Math.max(s.glanceAt, t + 1.0);
  }

  // -- scheduling -------------------------------------------------------------------------
  if (s.corrective && t >= s.corrective.at && free) {
    s.corrective = null;
    startSaccade(s, desired, desiredDist, 'corrective', false);
  } else if (s.mode === 'face' && free && !s.corrective) {
    if (t >= s.glanceAt) {
      const side = s.R.glance() < 0.5 ? -1 : 1;
      const phi = s.R.glance() < L.glance_down_share ? s.R.glance.uniform(...L.glance_down) * D2R : 0;
      const amp = s.R.glance.uniform(...L.glance_amp);
      const off = [side * amp * Math.cos(phi), -amp * Math.sin(phi)];          // never up
      s.mode = 'glance';
      s.fix = { kind: 'dir', dir: [person[0] + off[0], person[1] + off[1]], dist: desiredDist };
      startSaccade(s, s.fix.dir, desiredDist, 'glance');
      s.glanceEnd = t + (s.sac ? s.sac.D : 0) + s.R.glance.uniform(...L.glance_hold);
      if (s.log) s.log.glances.push({ t, off });
    } else if (t >= s.dwellEnd) {
      const cur = s.fix.which;
      let next;
      if (cur === 'M') next = s.R.look() < 0.5 ? 'L' : 'R';
      else next = s.R.look() < L.mouth_share ? 'M' : (cur === 'L' ? 'R' : 'L');
      s.fix = { kind: 'face', which: next };
      const d0 = dirTo(pts[next]);
      startSaccade(s, d0.dir, d0.dist, 'face');
      s.dwellEnd = t + (s.sac ? s.sac.D : 0) + s.R.look.uniform(...L.dwell);
    } else if (ang2(desired, s.g) > L.catchup_deg) {
      startSaccade(s, desired, desiredDist, 'catchup', false);
    }
  } else if (s.mode === 'glance' && free && t >= s.glanceEnd) {
    s.mode = 'face';
    s.fix = { kind: 'face', which: s.R.look() < 0.5 ? 'L' : 'R' };
    const d0 = dirTo(pts[s.fix.which]);
    startSaccade(s, d0.dir, d0.dist, 'return');
    s.dwellEnd = t + (s.sac ? s.sac.D : 0) + s.R.look.uniform(...L.dwell);
    s.glanceAt = t + s.R.glance.uniform(...L.glance_every);
  } else if (s.mode === 'search' && free && t >= s.nextLook) {
    // while the head drifts back, the eyes look a little ahead of it toward the middle (not
    // pinned at the corner of the eye); the look-around starts once the head is back there
    if (!s.recentred && Math.hypot(s.head.y, s.head.p) < 2) s.recentred = true;
    const toward = s.recentred ? 0 : s.head.y - Math.sign(s.head.y) * Math.min(Math.abs(s.head.y), 15);
    const span = s.recentred ? L.look_yaw : 4;
    const dir = [toward + s.R.look.uniform(-span, span), s.R.look.uniform(...L.look_pitch)];
    s.fix = { kind: 'dir', dir, dist: L.look_dist };
    startSaccade(s, dir, L.look_dist, 'look');
    s.nextLook = t + (s.recentred ? s.R.look.uniform(...L.look_every) : s.R.look.uniform(0.6, 1.0));
  }

  // -- the eyes ---------------------------------------------------------------------------
  if (s.sac) {
    const u = (t - s.sac.t0) / s.sac.D;
    const { g0, g1, k } = s.sac;
    if (u >= 1) {
      s.g = g1.slice();
      s.glis = { t0: t, v: s.sac.gl };
      if (s.sac.short > 0) s.corrective = { at: t + s.R.sacc.uniform(...P.corrective_delay) };
      s.sac = null;
    } else {
      const f = profile(u, k);
      s.g = [g0[0] + (g1[0] - g0[0]) * f, g0[1] + (g1[1] - g0[1]) * f];
    }
  } else if (s.fix.kind === 'face') {
    // smooth pursuit: match the target's angular velocity, with a weak pull onto it
    s.g = [s.g[0] + (L.pursuit_gain * s.pursuitV[0] + L.pursuit_pull * (desired[0] - s.g[0])) * L.tick,
           s.g[1] + (L.pursuit_gain * s.pursuitV[1] + L.pursuit_pull * (desired[1] - s.g[1])) * L.tick];
  }
  if (!s.sac) s.dTarget = desiredDist;
  s.d += (s.dTarget - s.d) * (L.tick / (P.verg_tau + L.tick));

  // -- the head ---------------------------------------------------------------------------
  const H = s.head;
  const going = s.sac ? s.sac.g1 : desired;            // where the eyes are going
  const aim = person && s.mode === 'face' ? person : going;
  const recentring = s.mode === 'search' && !s.recentred;               // the head keeps its centre goal
  if (!H.pending && s.mode !== 'lostHold' && s.mode !== 'glance' && !recentring) {   // a glance is the eyes' alone
    if (ang2(going, H.goal) > L.head_trigger) setHeadGoal(s, aim, s.fix.kind === 'face');
    const eIn = s.headOut ? ang2(s.gOut || s.g, s.headOut) : 0;
    if (eIn > L.head_sustain[0]) {
      if (H.sustainSince === null) H.sustainSince = t;
      else if (t - H.sustainSince >= L.head_sustain[1] && !H.pending) {
        setHeadGoal(s, aim, s.fix.kind === 'face');
        H.sustainSince = null;
      }
    } else H.sustainSince = null;
  }
  if (H.pending && t >= H.pending.at) {
    H.goal = H.pending.goal; H.tracking = H.pending.track; H.rate = H.pending.rate; H.pending = null;
    H.slowSince = null;
  }
  if (H.tracking && s.mode === 'face' && person) {
    // while the wearer keeps moving, the head keeps its share of the way to them
    H.goal = headGoalFor(s, person);
    if (Math.hypot(...s.pursuitV) < L.head_track_stop[0]) {
      if (H.slowSince === null) H.slowSince = t;
      else if (t - H.slowSince >= L.head_track_stop[1]) H.tracking = false;
    } else H.slowSince = null;
  } else if (s.mode !== 'face') H.tracking = false;
  // the goal moves at most H.rate deg/s; the 1.2 Hz critically damped follower smooths it
  const step = H.rate * L.tick;
  const dg = [H.goal[0] - H.cmd[0], H.goal[1] - H.cmd[1]];
  const dn = Math.hypot(dg[0], dg[1]);
  const prev = H.cmd;
  H.cmd = dn <= step ? H.goal.slice() : [H.cmd[0] + dg[0] * step / dn, H.cmd[1] + dg[1] * step / dn];
  const af = L.tick / (L.head_ff_tau + L.tick);
  H.cmdV = [0, 1].map((i) => H.cmdV[i] + af * ((H.cmd[i] - prev[i]) / L.tick - H.cmdV[i]));
  const w = 2 * Math.PI * P.head_freq, ff = L.head_feedforward;
  H.vy += (w * w * (H.cmd[0] - H.y) + 2 * w * (ff * H.cmdV[0] - H.vy)) * L.tick;
  H.vp += (w * w * (H.cmd[1] - H.p) + 2 * w * (ff * H.cmdV[1] - H.vp)) * L.tick;
  H.y += H.vy * L.tick;
  H.p += H.vp * L.tick;
  // the limits hold for the head itself, not only for its goal (the feed-forward can overshoot)
  if (H.y < L.head_yaw[0] || H.y > L.head_yaw[1]) { H.y = clamp(H.y, ...L.head_yaw); H.vy = 0; }
  if (H.p < L.head_pitch[0] || H.p > L.head_pitch[1]) { H.p = clamp(H.p, ...L.head_pitch); H.vp = 0; }
  H.dipLP += (Math.abs(H.vy) - H.dipLP) * (L.tick / (P.head_dip_tau + L.tick));
  const ramp = clamp(t / 0.5, 0, 1);
  const sw = s.sway.map((f, i) => f(t) * P.head_sway_deg[i] * ramp);
  const hy = H.y + sw[0];
  // roll and dip follow the engine for small turns and level off for large ones
  const soft = (x, m) => m * Math.tanh(x / m);
  const hp = H.p - soft(P.head_dip_gain * H.dipLP, L.dip_max) + sw[1];
  const hr = soft(P.head_roll_coupling * hy, L.roll_max) + sw[2];
  s.headOut = [hy, hp, hr];

  // -- blinks -----------------------------------------------------------------------------
  if (t >= s.nextBlink) {
    if (!blink(s, t, 1.0, false)) s.nextBlink = s.lastBlink + P.blink_min_gap + 0.05;
  }
  s.blinks = s.blinks.filter((b) => t - b.t0 < 1.0);
  let bL = 0, bR = 0;
  for (const b of s.blinks) {
    bL = Math.max(bL, b.amp * blinkShape(b, t - b.t0));
    bR = Math.max(bR, b.ampR * blinkShape(b, t - b.t0 - b.lag));
  }
  const lid = Math.max(bL, bR);

  // -- output gaze: glissade, drift, the eyes' dip under a blink, oculomotor range ----------
  let gy = s.g[0], gp = s.g[1];
  if (s.glis) {
    const e = Math.exp(-(t - s.glis.t0) / P.glissade_tau);
    gy += s.glis.v[0] * e; gp += s.glis.v[1] * e;
    if (e < 1e-3) s.glis = null;
  }
  gy += P.drift_deg * s.drift[0](t);
  gp += P.drift_deg * s.drift[1](t) - P.blink_eye_dip * lid;
  const eyeYaw = clamp(gy - hy, -L.eye_yaw_max, L.eye_yaw_max);
  const eyePitch = clamp(gp - hp, -L.eye_down, L.eye_up);
  s.gOut = [hy + eyeYaw, hp + eyePitch];
  const half = Math.atan(P.eye_half_ipd / s.d) + P.blink_eye_nasal * D2R * lid;
  const dOut = P.eye_half_ipd / Math.tan(half);

  // -- brows, lids, pupil -----------------------------------------------------------------
  const [b0, b1, bamt] = P.brow_from_pitch;
  const base = bamt * clamp((eyePitch - b0) / (b1 - b0), 0, 1);
  const raw = [base * s.browLean[0], base * s.browLean[1]];
  let effort = 0;
  const curve = (x, a) => {
    if (x < 0) return 0;
    const rise = 0.5 * (1 - Math.cos(Math.PI * clamp(x / P.shift_rise, 0, 1)));
    return a * rise * Math.exp(-Math.max(x - P.shift_rise, 0) / P.shift_relax);
  };
  s.efforts = s.efforts.filter((e) => t - e.t0 < 4);
  for (const e of s.efforts) {
    effort = Math.max(effort, curve(t - e.t0, e.a));
    for (let i = 0; i < 2; i++) raw[i] = Math.max(raw[i], P.shift_brow * e.sides[i][0] * curve(t - e.t0 - e.sides[i][1], e.a));
  }
  s.flashes = s.flashes.filter((f) => t - f.t0 < f.dur + 1);
  for (const f of s.flashes) {
    for (let i = 0; i < 2; i++) raw[i] = Math.max(raw[i], f.amp * f.sides[i][0] * envelope(t, f.t0 + f.sides[i][1], f.dur));
  }
  const ab = L.tick / (P.brow_tau + L.tick);
  s.browLP = s.browLP.map((v0, i) => v0 + ab * (raw[i] - v0));
  s.squintLP += (P.shift_squint * effort - s.squintLP) * (L.tick / (0.08 + L.tick));
  s.widenLP += (0.3 * Math.max(...s.browLP) - s.widenLP) * (L.tick / (0.06 + L.tick));
  const near = -P.near_gain * clamp(1 / s.d - 1 / 0.6, -1, 2);
  s.pupilLP += (near - s.pupilLP) * (L.tick / (P.pupil_tau + L.tick));

  s.out = {
    t, mode: s.mode,
    head_yaw: hy, head_pitch: hp, head_roll: hr,
    head_follow_yaw: H.y, head_follow_pitch: H.p,
    gaze_yaw: s.gOut[0], gaze_pitch: s.gOut[1], gaze_dist: dOut,
    eye_yaw: eyeYaw, eye_pitch: eyePitch,
    target: addv(mid, scl(direction(s.gOut[0] * D2R, s.gOut[1] * D2R), dOut)),
    desired_yaw: desired[0], desired_pitch: desired[1],
    blink_L: clamp(bL, 0, 1), blink_R: clamp(bR, 0, 1),
    brow_L: clamp(s.browLP[0], 0, 1), brow_R: clamp(s.browLP[1], 0, 1),
    widen: clamp(s.widenLP, 0, 1), squint: clamp(s.squintLP, 0, 1),
    pupil: s.pupilLP + P.hippus * s.hippus(t),
    saccade: !!s.sac,
  };
}

/**
 * Advance by dt seconds with the wearer at `viewer` ({pos, right, up?} in bust space, or null)
 * at the end of the step. The internal clock ticks at LIVE.tick; the viewer is interpolated
 * between the previous call and this one, so 72, 90 and 120 Hz see the same path.
 */
export function step(s, viewer, dt) {
  const v0 = s.lastViewer, T0 = s.frameT;
  s.frameT += dt;
  const tk = s.L.tick;
  const n = Math.floor(s.frameT / tk + 1e-6);          // whole ticks, so every frame rate ticks alike
  while (s.ticks < n) {
    s.ticks += 1;
    s.t = s.ticks * tk;
    let v = viewer;
    if (viewer && v0 && dt > 0) {
      const u = clamp((s.t - T0) / dt, 0, 1);
      v = { pos: lerp3(v0.pos, viewer.pos, u), right: lerp3(v0.right, viewer.right, u),
            up: viewer.up && v0.up ? lerp3(v0.up, viewer.up, u) : viewer.up };
    }
    tick(s, v);
  }
  s.lastViewer = viewer ? { pos: viewer.pos.slice(), right: viewer.right.slice(), up: viewer.up ? viewer.up.slice() : undefined } : null;
  if (!s.out) tick(s, viewer);
  return s.out;
}
