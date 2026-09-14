import type maplibregl from 'maplibre-gl';

/**
 * Replaces MapLibre's stepped scroll-zoom with a velocity-based one: each wheel tick adds zoom
 * velocity, which decays every frame, so zooming glides to a stop the way panning does.
 */
export function installInertialZoom(
  map: maplibregl.Map,
  // one mouse notch (deltaY 100) => velocity 0.1 zoom/frame, which decays to ~1 zoom level total
  opts = { sensitivity: 0.001, decay: 0.9, maxVel: 0.25 },
) {
  map.scrollZoom.disable();
  const canvas = map.getCanvas();
  let vel = 0;
  let anchor: { x: number; y: number } | null = null;
  let running = false;
  let last = 0;
  let lastStep = 0;
  const EPS = 1e-6;

  const stop = () => { vel = 0; running = false; };

  const step = (now: number) => {
    lastStep = now;
    try {
      const dt = Math.max(0.25, Math.min(48, now - last)) / 16.667; // in nominal frames
      last = now;
      if (Math.abs(vel) < 0.0004 || !anchor) return stop();
      const z = map.getZoom();
      const target = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), z + vel * dt));
      if (Math.abs(target - z) < EPS) {
        // pinned against a zoom limit: drop the velocity in that direction but keep listening
        return stop();
      }
      map.easeTo({ zoom: target, around: map.unproject([anchor.x, anchor.y]), duration: 0, easing: (t) => t });
      vel *= Math.pow(opts.decay, dt);
      requestAnimationFrame(step);
    } catch (err) {
      // never leave the loop flagged as running after a failure, or every later wheel is ignored
      console.warn('inertial zoom step failed', err);
      stop();
    }
  };

  const start = () => {
    running = true;
    last = lastStep = performance.now();
    requestAnimationFrame(step);
  };

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      let delta = e.deltaY;
      if (e.deltaMode === 1) delta *= 40;
      else if (e.deltaMode === 2) delta *= 400;
      const impulse = -delta * opts.sensitivity;
      // a reversal should respond immediately rather than first cancelling the old momentum
      if (Math.sign(impulse) !== Math.sign(vel)) vel = 0;
      vel = Math.max(-opts.maxVel, Math.min(opts.maxVel, vel + impulse));
      const r = canvas.getBoundingClientRect();
      anchor = { x: e.clientX - r.left, y: e.clientY - r.top };
      // (re)start the loop if it is not running, or if it looks stalled (no frame for 250 ms)
      if (!running || performance.now() - lastStep > 250) start();
    },
    { passive: false },
  );

  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
}
