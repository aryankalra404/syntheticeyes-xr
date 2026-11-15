// "Follow you": the laptop or phone camera finds the viewer's face and reports where their eyes
// are, in metres, in the screen's frame (x to the viewer's right as they face the screen, y up,
// z away from the screen). The page turns that into where the wearer stands, so the head looks
// at the person in front of the screen.
//
// Face detection is MediaPipe's BlazeFace short-range model (Apache-2.0, assets/
// face_detector.tflite, 230 KB). Its runtime (tasks-vision, Apache-2.0, 13 MB of wasm) is loaded
// from jsDelivr at a pinned version only when this mode is switched on, so the page itself stays
// small. Frames never leave the device: detection runs in the browser.

const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1';
const MODEL = './assets/face_detector.tflite';
const IPD = 0.063;          // metres between the pupils, adult average
const HFOV = 60;            // horizontal field of view of a typical laptop camera, degrees
const TAU = 0.12;           // smoothing time constant of the reported position, seconds

let runtime = null;         // the tasks-vision module, loaded once

export function createFaceFollow({ video, onStatus = () => {} }) {
  const st = { on: false, stream: null, detector: null, face: null, seen: -Infinity, lastT: 0,
               handle: null };

  async function start() {
    if (st.on) return true;
    st.on = true;
    onStatus('Starting the camera…');
    try {
      st.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
    } catch (e) {
      st.on = false;
      onStatus(e && e.name === 'NotAllowedError'
        ? 'Camera blocked: allow it for this site and try again.'
        : 'No camera found.');
      return false;
    }
    if (!st.on) { stopTracks(); return false; }          // switched off while asking
    video.srcObject = st.stream;
    await video.play().catch(() => {});
    try {
      onStatus('Loading the face tracker…');
      runtime = runtime || await import(`${MP}/vision_bundle.mjs`);
      const files = await runtime.FilesetResolver.forVisionTasks(`${MP}/wasm`);
      st.detector = await runtime.FaceDetector.createFromOptions(files, {
        baseOptions: { modelAssetPath: MODEL, delegate: 'CPU' },
        runningMode: 'VIDEO', minDetectionConfidence: 0.5 });
    } catch (e) {
      stop();
      onStatus('Could not load the face tracker.');
      return false;
    }
    if (!st.on) { stop(); return false; }
    onStatus('Looking for you…');
    schedule();
    return true;
  }

  function schedule() {
    if (!st.on) return;
    if (video.requestVideoFrameCallback) st.handle = video.requestVideoFrameCallback(tick);
    else st.handle = setTimeout(tick, 33);
  }

  function tick() {
    if (!st.on || !st.detector) return;
    const now = performance.now();
    if (video.readyState >= 2 && now > st.lastT) {
      st.lastT = now;
      let res = null;
      try { res = st.detector.detectForVideo(video, now); } catch { res = null; }
      const m = res && measure(res.detections, video.videoWidth, video.videoHeight);
      if (m) {
        const a = st.face ? 1 - Math.exp(-Math.min((now - st.seen) / 1000, 0.5) / TAU) : 1;
        st.face = st.face ? st.face.map((v, i) => v + (m[i] - v) * a) : m;
        if (now - st.seen > 1000) onStatus('Following you');
        st.seen = now;
      }
    }
    schedule();
  }

  function stopTracks() {
    if (st.stream) for (const t of st.stream.getTracks()) t.stop();
    st.stream = null;
  }

  function stop() {
    st.on = false;
    if (st.handle !== null) {
      if (video.cancelVideoFrameCallback) try { video.cancelVideoFrameCallback(st.handle); } catch { /* */ }
      clearTimeout(st.handle);
      st.handle = null;
    }
    if (st.detector) { try { st.detector.close(); } catch { /* */ } st.detector = null; }
    stopTracks();
    video.srcObject = null;
    st.face = null;
    st.seen = -Infinity;
  }

  /** The viewer's eye midpoint [x, y, z] in metres, or null if no face for `lostAfter` s. */
  function position(lostAfter = 1.0) {
    if (!st.face || performance.now() - st.seen > lostAfter * 1000) return null;
    return st.face;
  }

  return { start, stop, position, get on() { return st.on; } };
}

// The largest face; its two eye keypoints give the direction (their midpoint) and the distance
// (their spacing against the average pupil distance). The camera image is not mirrored, so the
// viewer's right is image-left and x flips.
function measure(dets, W, H) {
  if (!dets || !dets.length || !W || !H) return null;
  let best = null, area = 0;
  for (const d of dets) {
    const b = d.boundingBox, a = b ? b.width * b.height : 0;
    if (a > area && d.keypoints && d.keypoints.length >= 2) { area = a; best = d; }
  }
  if (!best) return null;
  const [r, l] = best.keypoints;
  const f = (W / 2) / Math.tan(HFOV * Math.PI / 360);
  const ex = ((r.x + l.x) / 2) * W - W / 2, ey = ((r.y + l.y) / 2) * H - H / 2;
  const ipdPx = Math.hypot((l.x - r.x) * W, (l.y - r.y) * H);
  if (ipdPx < 4) return null;
  const z = f * IPD / ipdPx;
  return [-ex / f * z, -ey / f * z, z];
}
