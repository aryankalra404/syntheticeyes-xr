# SyntheticEyes in a headset

This repository is the published copy of the `xr/` folder of the SyntheticEyes
project (Samsung PRISM XR Hackathon 2026, Track 1). It holds the page and its assets
only; the local server, the tests and the export from Blender stay in the main project.

---


The hero head (`tex_09`, the head in the final videos) as a life-size bust that looks at you:
eyes first, quick jumps between your eyes and now and then your mouth, blinks, short glances
away, and the head turning when you move. It loses you when you walk behind it or out of the
room, looks round, and greets you (a look, a blink, a brow flash) when you come back.

One web page, no build step. In a Meta Quest browser it stands in your room through the
passthrough cameras; on a laptop or phone the camera is you.

**Live: https://aryankalra404.github.io/syntheticeyes-xr/** (HTTPS, so on a Quest it opens
straight in the browser with no certificate step: tap START XR).

This is an unscored bonus; nothing in the scored bundle depends on it.

## Run it

From the repo root:

```
python3 xr/serve.py
```

It prints two addresses:

- **Laptop**: `http://localhost:8000/xr/`. Move the mouse to walk round the head (±50 deg
  sideways, ±20 up and down), scroll to come closer or step back (0.3 to 1.5 m), take the
  mouse off the page to walk away and bring it back to be seen again. On a phone, drag with
  one finger and pinch with two.
- **Controls** (top right, at the bottom on a phone): *View* switches between the face, both
  eyes and an eye close-up (the cameras of the Blender stills; the close-ups ride with the head
  like a head-mounted eye camera, and the eyes follow the mouse instead of the camera moving).
  *Follow*: *Mouse* as above; *You (camera)* uses the laptop or phone camera to find your face
  (MediaPipe face detection, in the browser; the video never leaves the device) and the head
  looks at you: lean sideways or up to walk round it, lean in to come closer, leave the frame
  to walk away. Where you sit when you pick it is the centre; pick it again to re-centre.
  *Off* stands the camera in front and the head simply keeps looking at you.
- **Quest, same Wi-Fi**: `https://<this Mac's address>:8443/xr/`. The certificate is
  self-signed (made with openssl on the first run, kept in `xr/.certs/`, git-ignored, valid
  30 days), so the Quest browser warns once: open *Advanced* and continue. Then tap
  **START XR**.
- **Quest over USB** (if the Wi-Fi blocks the Mac): plug the headset in, allow USB debugging,
  then

  ```
  adb reverse tcp:8000 tcp:8000
  ```

  and open `http://localhost:8000/xr/` in the Quest browser (localhost counts as secure, so
  no certificate step).

`python3 xr/serve.py --http-only` serves just the laptop address.

## In the headset

- START XR opens an `immersive-ar` session (passthrough); a browser without AR gets
  `immersive-vr` on a dark background instead.
- The bust appears 0.7 m in front of you, its eyes at your eye height, facing you. **Pull the
  trigger or pinch** to place it again in front of you.
- It tracks your head (the headset), not your eyes or hands.

## Checklist for the first try in the headset

Write down what you see; a phone video through the headset's casting is ideal.

1. **Does it find me?** On START XR the bust is in front of you at eye height and looks at you
   within a second. Trigger or pinch moves it.
2. **Eyes before head?** Step half a metre to the side: the eyes should arrive first, the head
   follow a beat later and stop about three quarters of the way, the eyes doing the rest.
   Walk slowly round it: the head follows to its limit (60 deg) without a jerk.
3. **Is it alive when I stand still?** Small jumps between your eyes about every second, a
   look at your mouth now and then, a blink every few seconds, a short glance away every 5 to
   10 s, a slight sway.
4. **Lose me, greet me.** Walk round behind it (or past 2.5 m): it holds where it lost you
   for 2 s, turns back to the middle and looks round. Come back into view: a quick look at
   you, a blink and a brow raise.
5. **Clipping?** Up close (30 cm) and from the sides: does any part of the eye show through
   the eyelids, do lashes poke into the eye, is the neck cut visible above the plinth?
6. **Flicker or shimmer?** Lashes, the lid edges, the tear line, the shadow of the nose.
7. **Frame rate.** Is it smooth (72 Hz or more), also when you move your head quickly? If it
   stutters, say so: the first fixes are a smaller shadow map and the plinth without shadow.
8. **Looks.** Is it the same man as in the videos? Too pale, too shiny, eyes too dark or too
   bright in your room's light? (The light is fixed, it does not match the room.)

## Files

```
index.html            the page (an import map, no build step)
js/app.js             scene, materials, light, plinth, XR session, laptop wearer, debug views
js/rig.js             port of wrapper/rig.py: channels -> bone rotations and morph weights
js/gaze.js            real-time gaze: (state, wearer, dt) -> channels; seeded, frame-rate free
js/facefollow.js      Follow: You: the camera's face detection -> where the viewer's eyes are
assets/head.glb       the head, skinned, 21 named shape keys; lash ribbons and tear lines
assets/rig.json       eye centres, bone heads, rig constants, the gaze engine's numbers
assets/face_detector.tflite  MediaPipe BlazeFace short range, for Follow: You (camera)
assets/*.jpg, *.webp  tex_09 at 2048 (skin albedo; normal as lossless WebP) and 1024 (roughness, eyes)
vendor/three/         three.js 0.185.1, MIT, unmodified, only the files used
tests/                node --test (no browser): rig directions, the five scripted wearers
serve.py              local HTTP / HTTPS server for the laptop and the headset
```

`tools/export_xr.py` rebuilds `assets/` from `scene.blend` (it reads the scene and never
saves it):

```
$BLENDER -b scene.blend -P tools/export_xr.py
$BLENDER -b --factory-startup -P tools/export_xr.py -- --check
cd xr && node --test
```

The live link is a public copy of this folder in `aryankalra404/syntheticeyes-xr` (GitHub
Pages from `main`). After a change here, update it from the repo root with
`tools/publish_xr.sh` (optionally a one-line commit message as the argument).

Debug views for screenshots: `?view=face|eyes|eye|eyeL&size=800&shot=1` puts the camera where
the Blender still cameras are; `?pose=1&gy=20&gp=0&hy=0&blink=0.66&brow=0.3` sets the
channels directly and freezes time; `?seed=N` picks the gaze seed.

## Credits

- Head: Google GNM Head v3 (Apache-2.0).
- Skin colour of `tex_09` and the skin micro-relief: "Infinite, 3D Head Scan by Lee
  Perry-Smith", based on a work at www.triplegangers.com, licensed under
  [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/).
- Rendering: [three.js](https://threejs.org) (MIT).
- Face detection for *Follow: You*: [MediaPipe](https://ai.google.dev/edge/mediapipe) BlazeFace
  short-range model and tasks-vision 1.1.1 (Apache-2.0); the runtime is loaded from jsDelivr.
- Iris, rig, lid shapes, gaze model and this page: SyntheticEyes.
