// Port of wrapper/rig.py Rig.apply(): channels -> bone rotations and morph weights.
// Pure maths, no three.js and no DOM, so node --test runs it.
//
// Frame: bust space = the glTF frame of head.glb (rig.json "axes"): metres, +X image-right
// (the subject's left), +Y up, +Z toward the viewer; the face looks along +Z.
// Signs, as in the wrapper: yaw > 0 toward image-right, pitch > 0 up, head roll > 0 tilts the
// top of the head to image-right.
//
// Blender's rot3(yaw, pitch, roll) = Rz(yaw) Rx(-pitch) Ry(roll) in its own frame (Z up, -Y
// forward). Blender Z is glTF Y and Blender Y is glTF -Z, so the same rotation here is
// Ry(yaw) Rx(-pitch) Rz(-roll).
//
// Input: head_yaw/pitch/roll (deg), the gaze target as a point in bust space (`target`), or
// for the debug pose gaze_yaw / gaze_pitch / gaze_dist as the wrapper has them, plus blink_L/R,
// brow_L/R, widen, squint, pupil. Output: for each bone the rotation it gets relative to its
// rest pose, in bust space, about its own head (`delta`), the morph weights by name, and each
// eye's yaw and pitch in the head (deg). bonesLocal() turns the deltas into local quaternions.

const D2R = Math.PI / 180;
export const SIDES = ['L', 'R'];

// ---- quaternions [x, y, z, w] and vectors [x, y, z] ------------------------------------------

export function qAxis(ax, ay, az, angle) {
  const s = Math.sin(angle / 2);
  return [ax * s, ay * s, az * s, Math.cos(angle / 2)];
}
export function qMul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
export function qInv(q) { return [-q[0], -q[1], -q[2], q[3]]; }   // unit quaternions only
export function qRot(q, v) {
  const p = qMul(qMul(q, [v[0], v[1], v[2], 0]), qInv(q));
  return [p[0], p[1], p[2]];
}
export const QI = [0, 0, 0, 1];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);

/** rot3 of wrapper/rig.py in bust space; radians. */
export function rot3(yaw, pitch, roll = 0) {
  return qMul(qMul(qAxis(0, 1, 0, yaw), qAxis(1, 0, 0, -pitch)), qAxis(0, 0, 1, -roll));
}

/** Unit gaze direction for image-space yaw/pitch (radians); (0, 0) looks at the viewer (+Z). */
export function direction(yaw, pitch) {
  return [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
}

/** Yaw and pitch (radians) of a direction, the inverse of direction(). */
export function angles(v) {
  return [Math.atan2(v[0], v[2]), Math.atan2(v[1], Math.hypot(v[0], v[2]))];
}

/** Point p rotated by q about centre c. */
export function pivot(q, c, p) { return add(c, qRot(q, sub(p, c))); }

function tent(b, centre, width = 1 / 3) { return Math.max(0, 1 - Math.abs(b - centre) / width); }

// ---- the rig ---------------------------------------------------------------------------------

export class Rig {
  constructor(rig) {
    this.r = rig;
    this.k = rig.constants;
    this.eyeRest = { L: rig.eye_rest_L, R: rig.eye_rest_R };
    this.eyeMid = rig.eye_mid;
    this.neckC = rig.bones.neck.head;
    this.headC = rig.bones.head.head;
    this.tentBlink = rig.blink_keys === 'tent';
  }

  /** Where the head carries a point given in its rest pose (Ln @ Lh @ p). */
  headPose(ch) {
    const K = this.k.NECK_SHARE;
    const hy = (ch.head_yaw || 0) * D2R, hp = (ch.head_pitch || 0) * D2R, hl = (ch.head_roll || 0) * D2R;
    const qn = rot3(K * hy, K * hp, K * hl);
    const qh = rot3((1 - K) * hy, (1 - K) * hp, (1 - K) * hl);
    const qHead = qMul(qn, qh);
    const neckC = this.neckC, headC = this.headC;
    const map = (p) => pivot(qn, neckC, pivot(qh, headC, p));
    return { qn, qh, qHead, map };
  }

  /** The wrapper's fixation point: gaze_dist along (gaze_yaw, gaze_pitch) from the eye midpoint. */
  targetFromAngles(ch, pose = this.headPose(ch)) {
    const d = ch.gaze_dist ?? 0.6;
    return add(pose.map(this.eyeMid), scale(direction((ch.gaze_yaw || 0) * D2R, (ch.gaze_pitch || 0) * D2R), d));
  }

  apply(ch) {
    const k = this.k;
    const pose = this.headPose(ch);
    const target = ch.target || this.targetFromAngles(ch, pose);
    const qHeadInv = qInv(pose.qHead);

    // each eye aims at the target from where the head has carried it (vergence), no torsion
    const eyeYaw = {}, eyePitch = {}, qEye = {}, eyeCentre = {};
    for (const s of SIDES) {
      const c = pose.map(this.eyeRest[s]);
      const t = qRot(qHeadInv, sub(target, c));             // in the head's rest frame
      const [yaw, pitch] = angles(t);
      eyeYaw[s] = yaw / D2R;
      eyePitch[s] = pitch / D2R;
      qEye[s] = rot3(yaw, pitch);
      eyeCentre[s] = c;
    }

    const w = {};
    for (const s of SIDES) {
      const b = clamp(ch[`blink_${s}`] || 0, 0, 1);
      const p = eyePitch[s];
      const up = clamp(p / k.LID_UP_FULL, 0, k.LID_FOLLOW_MAX);
      const down = clamp(-p / k.LID_DOWN_FULL, 0, k.LID_FOLLOW_MAX);
      w[`lid_up.${s}`] = (up + k.WIDEN_GAIN * (ch.widen || 0)) * (1 - b);
      w[`lid_down.${s}`] = down * (1 - b);
      // the lid apex follows the cornea sideways; nasal is -X for L, +X for R
      const nasal = s === 'L' ? -eyeYaw[s] : eyeYaw[s];
      w[`lid_in.${s}`] = clamp(nasal / k.LID_SIDE_FULL, 0, k.LID_FOLLOW_MAX) * (1 - b);
      w[`lid_out.${s}`] = clamp(-nasal / k.LID_SIDE_FULL, 0, k.LID_FOLLOW_MAX) * (1 - b);
      w[`lid_open.${s}`] = this.r.rest_lid_open * (1 - b);
      if (this.tentBlink) {
        w[`blink_33.${s}`] = tent(b, 1 / 3);
        w[`blink_66.${s}`] = tent(b, 2 / 3);
        w[`blink.${s}`] = Math.max(0, 1 - Math.abs(b - 1) / (1 / 3));
      } else {
        w[`blink.${s}`] = b;
      }
      w[`brow_up.${s}`] = (ch[`brow_${s}`] || 0) - k.BLINK_BROW_DIP * b;
      w[`squint.${s}`] = (ch.squint || 0) * (1 - b);
    }
    w.pupil = this.r.rest_pupil + (ch.pupil || 0);

    return {
      delta: {                                   // rotation relative to rest, in bust space
        neck: pose.qn,
        head: pose.qHead,
        'eye.L': qMul(pose.qHead, qEye.L),
        'eye.R': qMul(pose.qHead, qEye.R),
      },
      weights: w, eyeYaw, eyePitch, eyeCentre, target, headMap: pose.map,
    };
  }
}

/**
 * Local quaternions for the bones from their world deltas, as `_set_local` does it: a bone's
 * new world rotation is delta * restWorld, and its local rotation is what is left after its
 * parent's new world rotation. restWorld[name] are the rest world quaternions in bust space,
 * restWorld.root the world quaternion of the neck's parent (the armature node).
 */
export const PARENT = { neck: 'root', head: 'neck', 'eye.L': 'head', 'eye.R': 'head' };
export function bonesLocal(delta, restWorld) {
  const out = {};
  const world = { root: restWorld.root || QI };
  for (const name of ['neck', 'head', 'eye.L', 'eye.R']) {
    world[name] = qMul(delta[name], restWorld[name]);
    out[name] = qMul(qInv(world[PARENT[name]]), world[name]);
  }
  return out;
}
