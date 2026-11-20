// Which hand the bust looks at, if any. Pure maths on plain {x, y, z} points in the XR
// reference space (metres, +Y up); no three.js, so node can test it.
//
// A hand counts once it is raised in front of the wearer: the index fingertip above
// (head - RAISE_UP) and at least REACH_UP away from the head across the floor. It stops counting
// below (head - RAISE_DOWN) or nearer than REACH_DOWN (the gap between the two is hysteresis, so
// a hand at the edge does not flicker on and off). A hand that keeps counting stays the one
// followed; otherwise the higher raised hand wins. When tracking drops for a moment the last
// point is held for HOLD seconds before the bust goes back to the wearer.

export const HAND = {
  RAISE_UP: 0.35, RAISE_DOWN: 0.45,      // m below the head
  REACH_UP: 0.18, REACH_DOWN: 0.12,      // m from the head, horizontally
  HOLD: 0.3,                             // s
};

export function createHandFollow(opts = {}) {
  return { P: { ...HAND, ...opts }, which: null, last: null, lostFor: 0 };
}

/**
 * tips: { left?: {x,y,z}, right?: {x,y,z} } index fingertips this frame (missing = not tracked)
 * head: {x,y,z} the headset. Returns the point to look at, or null for the wearer.
 */
export function stepHandFollow(st, tips, head, dt) {
  const P = st.P;
  const counts = (p, already) => {
    if (!p) return false;
    const reach = Math.hypot(p.x - head.x, p.z - head.z);
    const below = head.y - p.y;
    return already ? below < P.RAISE_DOWN && reach > P.REACH_DOWN
                   : below < P.RAISE_UP && reach > P.REACH_UP;
  };
  let pick = null;
  if (st.which && counts(tips[st.which], true)) {
    pick = st.which;
  } else {
    for (const k of ['left', 'right']) {
      if (counts(tips[k], false) && (!pick || tips[k].y > tips[pick].y)) pick = k;
    }
  }
  if (pick) {
    st.which = pick;
    st.last = { ...tips[pick] };
    st.lostFor = 0;
    return st.last;
  }
  // the followed hand was not seen this frame (tracking lost), as opposed to lowered
  const unseen = st.which && !tips[st.which];
  if (st.last && unseen && st.lostFor + dt < P.HOLD) {
    st.lostFor += dt;
    return st.last;
  }
  st.which = null;
  st.last = null;
  st.lostFor = 0;
  return null;
}
