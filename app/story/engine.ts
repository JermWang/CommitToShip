import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

/**
 * Scroll-driven cinematic world, rendered through an ASCII "shader":
 * a low-resolution WebGL render (one pixel per character cell) is mapped to a character ramp on a 2D canvas.
 * The story is a single continuous fly-through: boat -> coin -> vault -> milestones -> votes -> payout -> boat.
 */

export const SCENE_COUNT = 7;
const ZONE_X = [0, 6, 12, 18, 24, 30, 36];
const RAMP = " .:-=+*#%@";

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (x: number) => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};

type Key = { pos: [number, number, number]; look: [number, number, number]; fov: number };
const CAMERA_KEYS: Key[] = [
  { pos: [-1.8, 0.55, 5.4], look: [0, 0.15, 0], fov: 36 },
  { pos: [6.9, 0.7, 4.3], look: [6, 0.15, 0], fov: 34 },
  { pos: [10.9, 1.7, 4.8], look: [12, 0.35, 0], fov: 34 },
  { pos: [16.4, 0.8, 5.0], look: [18, 0, 0], fov: 36 },
  { pos: [24, 1.3, 6.4], look: [24, 0, 0], fov: 38 },
  { pos: [30, 1.0, 5.6], look: [30, 0.7, 0], fov: 36 },
  { pos: [34.4, 0.5, 5.8], look: [36, 0.3, 0], fov: 36 },
];

export type StoryEngine = {
  dispose: () => void;
};

export type EngineOptions = {
  canvas: HTMLCanvasElement;
  getProgress: () => number; // 0..1 across the whole story
  getPointer: () => { x: number; y: number }; // -1..1
  onFrame: (u: number) => void; // u = scene-space position (scene i is centred on integer i)
  isVisible: () => boolean;
};

function whiteMat(opts?: { roughness?: number; metalness?: number; wireframe?: boolean }): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: opts?.roughness ?? 0.55,
    metalness: opts?.metalness ?? 0.1,
    wireframe: opts?.wireframe ?? false,
  });
}

function makeFallbackBoat(): THREE.Group {
  const g = new THREE.Group();
  const hull = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.28, 0.5), whiteMat());
  const sail = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.5, 3), whiteMat());
  sail.position.set(0, 0.95, 0);
  sail.rotation.y = Math.PI / 2;
  g.add(hull, sail);
  return g;
}

function normalizeModel(model: THREE.Object3D, targetHeight: number): THREE.Group {
  const wrapper = new THREE.Group();
  const box = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  model.position.sub(center);
  const s = size.y > 0 ? targetHeight / size.y : 1;
  wrapper.add(model);
  wrapper.scale.setScalar(s);
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if ((m as any).isMesh) {
      m.material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.15, side: THREE.DoubleSide });
    }
  });
  return wrapper;
}

export function createStoryEngine(opts: EngineOptions): StoryEngine {
  const { canvas } = opts;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");

  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: "high-performance" });
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x000000, 1);

  const sampler = document.createElement("canvas");
  const sctx = sampler.getContext("2d", { willReadFrequently: true });
  if (!sctx) throw new Error("sampler canvas unavailable");

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x000000, 7, 20);

  const camera = new THREE.PerspectiveCamera(36, 1.6, 0.1, 60);

  // ----- lights ---------------------------------------------------------------------------------
  scene.add(new THREE.AmbientLight(0xffffff, 0.75));
  const key = new THREE.DirectionalLight(0xffffff, 2.6);
  key.position.set(4, 6, 5);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffffff, 0.9);
  rim.position.set(-5, 2, -4);
  scene.add(rim);
  const headlight = new THREE.PointLight(0xffffff, 11, 18, 1.4);
  scene.add(headlight);

  // ----- water ----------------------------------------------------------------------------------
  const waterGeo = new THREE.PlaneGeometry(110, 26, 220, 52);
  waterGeo.rotateX(-Math.PI / 2);
  const water = new THREE.Mesh(waterGeo, new THREE.MeshBasicMaterial({ color: 0x6a6a6a, wireframe: true }));
  water.position.set(18, -0.95, -2);
  scene.add(water);
  const waterBase = (waterGeo.attributes.position.array as Float32Array).slice();

  // ----- zone 0 + 6 : boats ---------------------------------------------------------------------
  const boat0 = new THREE.Group();
  const boat1 = new THREE.Group();
  scene.add(boat0, boat1);
  boat0.position.set(ZONE_X[0], 0, 0);
  boat1.position.set(ZONE_X[6], 0, 0);

  let disposed = false;
  new GLTFLoader().load(
    "/branding/logo.glb",
    (gltf) => {
      if (disposed) return;
      const a = normalizeModel(gltf.scene.clone(true), 1.9);
      const b = normalizeModel(gltf.scene.clone(true), 1.9);
      boat0.add(a);
      boat1.add(b);
    },
    undefined,
    () => {
      if (disposed) return;
      boat0.add(makeFallbackBoat());
      boat1.add(makeFallbackBoat());
    }
  );

  // ----- zone 1 : coin --------------------------------------------------------------------------
  const coin1 = new THREE.Group();
  const coinBodyGeo = new THREE.CylinderGeometry(0.5, 0.5, 0.09, 56);
  coinBodyGeo.rotateX(Math.PI / 2);
  const coinRimGeo = new THREE.TorusGeometry(0.5, 0.045, 12, 56);
  const coinInnerGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.11, 40);
  coinInnerGeo.rotateX(Math.PI / 2);
  coin1.add(new THREE.Mesh(coinBodyGeo, whiteMat({ metalness: 0.3 })));
  coin1.add(new THREE.Mesh(coinRimGeo, whiteMat()));
  const inner1 = new THREE.Mesh(coinInnerGeo, new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.6 }));
  coin1.add(inner1);
  coin1.position.set(ZONE_X[1], 0.2, 0);
  scene.add(coin1);

  const rings: THREE.Mesh[] = [];
  for (let k = 0; k < 3; k++) {
    const r = new THREE.Mesh(new THREE.TorusGeometry(1, 0.02, 8, 64), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    r.position.set(ZONE_X[1], 0.2, 0);
    rings.push(r);
    scene.add(r);
  }

  // ----- zone 2 : vault -------------------------------------------------------------------------
  const vault = new THREE.Group();
  vault.position.set(ZONE_X[2], -0.45, 0);
  const vaultBodyMat = new THREE.MeshStandardMaterial({ color: 0x777777, roughness: 0.5, metalness: 0.25 });
  const vaultBody = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.1, 1.2), vaultBodyMat);
  const lidPivot = new THREE.Group();
  lidPivot.position.set(0, 0.55, -0.6);
  const lid = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.14, 1.3), whiteMat());
  lid.position.set(0, 0.07, 0.65);
  lidPivot.add(lid);
  const band = new THREE.Mesh(new THREE.BoxGeometry(1.74, 0.16, 1.24), whiteMat());
  band.position.set(0, 0.12, 0);
  vault.add(vaultBody, lidPivot, band);
  scene.add(vault);

  const coin2 = coin1.clone(true);
  scene.add(coin2);

  const FEE_N = 70;
  const feeGeo = new THREE.SphereGeometry(0.055, 8, 8);
  const fees = new THREE.InstancedMesh(feeGeo, whiteMat(), FEE_N);
  fees.frustumCulled = false;
  scene.add(fees);

  // ----- zone 3 : milestone slabs ---------------------------------------------------------------
  const slabs: THREE.Mesh[] = [];
  for (let k = 0; k < 3; k++) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.52, 0.14), new THREE.MeshStandardMaterial({ color: 0x808080, roughness: 0.5, metalness: 0.2 }));
    slabs.push(m);
    scene.add(m);
  }

  // ----- zone 4 : holders voting ----------------------------------------------------------------
  const HOLD_N = 54;
  const holders = new THREE.InstancedMesh(new THREE.SphereGeometry(0.11, 10, 10), whiteMat(), HOLD_N);
  holders.frustumCulled = false;
  scene.add(holders);
  const voteSlabMat = new THREE.MeshStandardMaterial({ color: 0x808080, roughness: 0.5, metalness: 0.2 });
  const voteSlab = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.8, 0.16), voteSlabMat);
  voteSlab.position.set(ZONE_X[4], 0, 0);
  scene.add(voteSlab);

  // ----- zone 5 : payout / redistribution -------------------------------------------------------
  const payMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, metalness: 0.2 });
  const paySlab = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.7, 0.16), payMat);
  paySlab.position.set(ZONE_X[5], 0.35, 0);
  scene.add(paySlab);
  const creatorMarker = new THREE.Mesh(new THREE.OctahedronGeometry(0.28), whiteMat());
  creatorMarker.position.set(ZONE_X[5] + 2.7, 1.5, 0);
  scene.add(creatorMarker);
  const targetSpheres: THREE.Mesh[] = [];
  const targetPos: [number, number, number][] = [
    [ZONE_X[5] - 2.2, -0.35, 0.3],
    [ZONE_X[5], -0.55, 0.6],
    [ZONE_X[5] + 2.0, -0.2, 0.2],
  ];
  const targetSize = [0.34, 0.3, 0.14];
  targetPos.forEach((p, i) => {
    const t = new THREE.Mesh(new THREE.SphereGeometry(targetSize[i], 20, 20), whiteMat());
    t.position.set(p[0], p[1], p[2]);
    targetSpheres.push(t);
    scene.add(t);
  });
  const PAY_N = 90;
  const pay = new THREE.InstancedMesh(new THREE.SphereGeometry(0.05, 8, 8), whiteMat(), PAY_N);
  pay.frustumCulled = false;
  scene.add(pay);

  // ----- render plumbing -----------------------------------------------------------------------
  let cols = 0;
  let rows = 0;
  let charW = 9;
  let charH = 15;
  let w = 0;
  let h = 0;
  const dpr = () => Math.max(1, Math.min(2, window.devicePixelRatio || 1));

  const resize = () => {
    w = Math.max(1, canvas.clientWidth || window.innerWidth);
    h = Math.max(1, canvas.clientHeight || window.innerHeight);
    const d = dpr();
    canvas.width = Math.floor(w * d);
    canvas.height = Math.floor(h * d);
    ctx.setTransform(d, 0, 0, d, 0, 0);

    charW = Math.max(7, Math.min(12, Math.round(w / 150)));
    charH = Math.round(charW * 1.62);
    cols = Math.max(20, Math.floor(w / charW));
    rows = Math.max(12, Math.floor(h / charH));

    renderer.setSize(cols, rows, false);
    sampler.width = cols;
    sampler.height = rows;
    camera.aspect = (cols * charW) / (rows * charH);
    // Portrait / small screens: the glass card docks to the bottom, so lift the 3D subject into the upper half.
    if (camera.aspect < 1.1) camera.setViewOffset(cols, rows, 0, Math.round(rows * 0.2), cols, rows);
    else camera.clearViewOffset();
    camera.updateProjectionMatrix();

    ctx.font = `${Math.round(charW / 0.6)}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`;
    ctx.textBaseline = "top";
  };

  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  const buckets: number[][] = Array.from({ length: RAMP.length }, () => []);
  const dummy = new THREE.Object3D();
  const camLook = new THREE.Vector3();
  const lookA = new THREE.Vector3();
  const lookB = new THREE.Vector3();

  let smoothP = opts.getProgress();
  let raf = 0;
  let last = performance.now();
  let time = 0;

  const draw = () => {
    renderer.render(scene, camera);
    sctx.drawImage(renderer.domElement, 0, 0, cols, rows);
    const data = sctx.getImageData(0, 0, cols, rows).data;

    for (const b of buckets) b.length = 0;
    for (let i = 0, n = cols * rows; i < n; i++) {
      const o = i * 4;
      const lum = (data[o] * 0.3 + data[o + 1] * 0.59 + data[o + 2] * 0.11) / 255;
      const level = Math.min(RAMP.length - 1, Math.floor(Math.pow(lum, 0.62) * RAMP.length));
      if (level > 0) buckets[level].push(i);
    }

    ctx.clearRect(0, 0, w, h);
    for (let l = 1; l < RAMP.length; l++) {
      const list = buckets[l];
      if (!list.length) continue;
      const a = 0.18 + 0.82 * (l / (RAMP.length - 1));
      ctx.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
      const ch = RAMP[l];
      for (let k = 0; k < list.length; k++) {
        const idx = list[k];
        ctx.fillText(ch, (idx % cols) * charW, Math.floor(idx / cols) * charH);
      }
    }
  };

  const update = (dt: number) => {
    time += dt;
    const target = opts.getProgress();
    smoothP += (target - smoothP) * (1 - Math.exp(-dt * 5.5));

    const u = smoothP * (SCENE_COUNT - 1); // scene i is centred on u = i (first scene at the top, last at the bottom)
    const uc = Math.min(SCENE_COUNT - 1, Math.max(0, u));
    const a = Math.min(SCENE_COUNT - 2, Math.floor(uc));
    const t = uc - a;
    const eased = smooth((t - 0.22) / 0.56); // dwell near each scene centre, travel in between
    const swoosh = Math.sin(eased * Math.PI);

    const ka = CAMERA_KEYS[a];
    const kb = CAMERA_KEYS[a + 1];
    const ptr = opts.getPointer();
    camera.position.set(
      lerp(ka.pos[0], kb.pos[0], eased) + Math.sin(time * 0.35) * 0.12 + ptr.x * 0.35,
      lerp(ka.pos[1], kb.pos[1], eased) + swoosh * 0.55 + Math.cos(time * 0.3) * 0.06 - ptr.y * 0.2,
      lerp(ka.pos[2], kb.pos[2], eased) - swoosh * 0.6
    );
    lookA.set(...ka.look);
    lookB.set(...kb.look);
    camLook.lerpVectors(lookA, lookB, eased);
    // Narrow viewports see less horizontally: back the camera off so subjects still fit.
    if (camera.aspect < 1.4) {
      const f = Math.pow(1.4 / camera.aspect, 0.5);
      camera.position.sub(camLook).multiplyScalar(f).add(camLook);
    }
    camera.lookAt(camLook);
    camera.rotation.z = Math.sin(eased * Math.PI * 2) * 0.035; // gentle roll through the move
    camera.fov = lerp(ka.fov, kb.fov, eased) - swoosh * 5;
    camera.updateProjectionMatrix();
    headlight.position.copy(camera.position).add(new THREE.Vector3(0.6, 1.2, 0.8));

    // local progress per scene window (0..1 across [i-0.5, i+0.5])
    const z = (i: number) => clamp01(u - i + 0.5);

    // water
    const pos = waterGeo.attributes.position.array as Float32Array;
    for (let i = 0; i < pos.length; i += 3) {
      const x = waterBase[i];
      const zz = waterBase[i + 2];
      pos[i + 1] = Math.sin(x * 0.35 + time * 0.9) * 0.16 + Math.sin(zz * 0.6 + time * 0.7) * 0.1 + Math.sin((x + zz) * 0.15 + time * 0.4) * 0.14;
    }
    waterGeo.attributes.position.needsUpdate = true;

    // zone visibility (skip far geometry)
    const near = (i: number) => Math.abs(u - i) < 1.45;
    boat0.visible = near(0);
    coin1.visible = near(1);
    rings.forEach((r) => (r.visible = near(1)));
    vault.visible = near(2);
    coin2.visible = near(2);
    fees.visible = near(2);
    slabs.forEach((s) => (s.visible = near(3)));
    holders.visible = near(4);
    voteSlab.visible = near(4);
    paySlab.visible = near(5);
    creatorMarker.visible = near(5);
    targetSpheres.forEach((s) => (s.visible = near(5)));
    pay.visible = near(5);
    boat1.visible = near(6);

    // zone 0: boat
    boat0.position.y = 0.05 + Math.sin(time * 1.1) * 0.06;
    boat0.rotation.set(Math.sin(time * 0.8) * 0.03, -0.55 + Math.sin(time * 0.25) * 0.25 + smoothP * 2.4, Math.sin(time * 0.9) * 0.04);

    // zone 1: coin pops in and spins, rings ripple outward
    const pop = smooth((u - 0.6) / 0.5);
    coin1.scale.setScalar(Math.max(0.001, pop * 1.55));
    coin1.rotation.y = time * 1.6;
    coin1.position.y = 0.25 + Math.sin(time * 1.4) * 0.07;
    rings.forEach((r, k) => {
      const ph = (time * 0.45 + k / 3) % 1;
      r.scale.setScalar(0.5 + ph * 3.2);
      r.rotation.x = Math.PI / 2;
      (r.material as THREE.MeshBasicMaterial).color.setScalar(pop * (1 - ph) * 0.9);
    });

    // zone 2: coin drops in, lid closes, vault glows, fees stream in
    const z2 = z(2);
    const drop = smooth((z2 - 0.1) / 0.3);
    coin2.position.set(ZONE_X[2], lerp(2.6, 0.35, drop) - 0.0, 0);
    coin2.rotation.y = time * 2.2;
    coin2.scale.setScalar(Math.max(0.001, 1.2 * (1 - smooth((z2 - 0.4) / 0.1))));
    const lidOpen = 1 - smooth((z2 - 0.4) / 0.22);
    lidPivot.rotation.x = -1.25 * lidOpen;
    const locked = smooth((z2 - 0.6) / 0.25);
    vaultBodyMat.color.setScalar(lerp(0.65, 1, locked));
    for (let i = 0; i < FEE_N; i++) {
      const ph = (time * 0.38 + i / FEE_N) % 1;
      const on = smooth((z2 - 0.5) / 0.15);
      const sx = ZONE_X[2] - 3.4 + (i % 7) * 0.12;
      const sy = 1.9 + ((i * 13) % 9) * 0.1;
      const px = lerp(sx, ZONE_X[2], ph);
      const py = lerp(sy, 0.15, ph * ph) + Math.sin(ph * Math.PI) * 0.5;
      dummy.position.set(px, py, ((i % 5) - 2) * 0.07);
      dummy.scale.setScalar(on * (1 - smooth((ph - 0.9) / 0.1)));
      dummy.updateMatrix();
      fees.setMatrixAt(i, dummy.matrix);
    }
    fees.instanceMatrix.needsUpdate = true;

    // zone 3: three milestones rise in and light up one by one
    const z3 = z(3);
    slabs.forEach((s, k) => {
      const rise = smooth((z3 - 0.05 - 0.14 * k) / 0.28);
      const lit = smooth((z3 - 0.5 - 0.14 * k) / 0.18);
      s.position.set(ZONE_X[3] + (k - 1) * 0.18, 0.95 - k * 0.92 - (1 - rise) * 1.4, -k * 0.3);
      s.scale.set(Math.max(0.001, rise), Math.max(0.001, rise), 1);
      (s.material as THREE.MeshStandardMaterial).color.setScalar(lerp(0.5, 1, lit));
    });

    // zone 4: holders orbit, then fly into the slab one by one (each is a vote)
    const z4 = z(4);
    let arrived = 0;
    for (let i = 0; i < HOLD_N; i++) {
      const th = 0.12 + 0.62 * (i / HOLD_N);
      const f = smooth((z4 - th) / 0.14);
      if (f >= 1) arrived++;
      const ang = (i / HOLD_N) * Math.PI * 2 + time * 0.35;
      const rad = 2.5 + ((i * 7) % 5) * 0.12;
      const rx = ZONE_X[4] + Math.cos(ang) * rad;
      const ry = Math.sin(ang * 2) * 0.35 + ((i % 4) - 1.5) * 0.18;
      const rz = Math.sin(ang) * rad * 0.55;
      dummy.position.set(lerp(rx, ZONE_X[4], f), lerp(ry, 0, f), lerp(rz, 0.1, f));
      dummy.scale.setScalar(1 - f * 0.85);
      dummy.updateMatrix();
      holders.setMatrixAt(i, dummy.matrix);
    }
    holders.instanceMatrix.needsUpdate = true;
    voteSlabMat.color.setScalar(lerp(0.5, 1, arrived / HOLD_N));
    voteSlab.rotation.y = Math.sin(time * 0.5) * 0.12;

    // zone 5: release to the creator, then the forfeit split
    const z5 = z(5);
    const phaseB = smooth((z5 - 0.52) / 0.12);
    creatorMarker.rotation.y = time * 1.3;
    creatorMarker.scale.setScalar(lerp(1, 0.55, phaseB));
    targetSpheres.forEach((s, k) => s.scale.setScalar(Math.max(0.001, phaseB) * (1 + Math.sin(time * 2 + k) * 0.05)));
    paySlab.rotation.y = Math.sin(time * 0.5) * 0.1;
    const on5 = smooth((z5 - 0.1) / 0.1);
    for (let i = 0; i < PAY_N; i++) {
      const ph = (time * 0.42 + i / PAY_N) % 1;
      const frac = i / PAY_N;
      const tIdx = frac < 0.5 ? 0 : frac < 0.95 ? 1 : 2;
      const dest = phaseB > 0.02 ? targetPos[tIdx] : ([creatorMarker.position.x, creatorMarker.position.y, 0] as [number, number, number]);
      const sx = ZONE_X[5];
      const sy = 0.35;
      const px = lerp(sx, dest[0], ph);
      const py = lerp(sy, dest[1], ph) + Math.sin(ph * Math.PI) * (phaseB > 0.02 ? 0.55 : 0.8);
      dummy.position.set(px, py, lerp(0, dest[2], ph));
      dummy.scale.setScalar(on5 * (1 - smooth((ph - 0.92) / 0.08)) * (0.7 + 0.3 * Math.sin(i)));
      dummy.updateMatrix();
      pay.setMatrixAt(i, dummy.matrix);
    }
    pay.instanceMatrix.needsUpdate = true;

    // zone 6: return to the boat
    boat1.position.y = 0.05 + Math.sin(time * 1.1 + 1) * 0.06;
    boat1.position.x = ZONE_X[6] + smooth(u - 5.4) * 0.8;
    boat1.rotation.set(Math.sin(time * 0.8) * 0.03, -0.9 + Math.sin(time * 0.25) * 0.2, Math.sin(time * 0.9) * 0.04);

    opts.onFrame(u);
  };

  const tick = () => {
    raf = requestAnimationFrame(tick);
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!opts.isVisible() || document.hidden) return;
    update(dt);
    draw();
  };
  raf = requestAnimationFrame(tick);

  return {
    dispose: () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        (m as any).geometry?.dispose?.();
        const mat = (m as any).material;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose?.());
        else mat?.dispose?.();
      });
      renderer.dispose();
    },
  };
}
