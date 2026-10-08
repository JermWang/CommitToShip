import * as THREE from "three";
import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/**
 * The Ship & Commit sailboat emblem as rounded glass, floating over a living cream-pastel backdrop.
 *
 * - Geometry: our own /branding/svg-logo.svg, extruded with a multi-segment bevel (every edge rounded).
 * - Backdrop: a full-screen pastel shader drawn INSIDE the WebGL scene, so the glass genuinely refracts it.
 *   It also paints the soft bloom behind the emblem and its contact shadow.
 * - Motion: chapter poses + a cinematic transition (full turn, dolly toward camera, bank, arc) fed through
 *   damped springs so the emblem has weight and settles instead of snapping. Idle "sailing" bob on top.
 */

/** x/y: fraction of the half-viewport (-1..1). size: fraction of viewport height. maxW: cap as a fraction of viewport width. */
export type EmblemPose = { x: number; y: number; size: number; rotY: number; rotX: number; glow: number; maxW?: number };

export type Emblem = {
  render: (u: number, time: number, pointer: { x: number; y: number }) => void;
  resize: () => void;
  dispose: () => void;
};

const TAU = Math.PI * 2;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));

/** Lightly under-damped spring: gives the emblem mass and a soft settle without overshooting into the UI. */
class Spring {
  v = 0;
  constructor(public x: number, private k = 52, private zeta = 0.86) {}
  step(target: number, dt: number) {
    const c = 2 * this.zeta * Math.sqrt(this.k);
    const a = this.k * (target - this.x) - c * this.v;
    this.v += a * dt;
    this.x += this.v * dt;
    return this.x;
  }
}

/* ---------------------------------------------------------------------------------------------- */

const BACKDROP_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.9999, 1.0);
  }
`;

const BACKDROP_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform float uProg;
  uniform float uAspect;
  uniform vec2 uGlow;      // emblem centre in uv
  uniform float uGlowR;    // emblem radius in uv-height units
  uniform float uLift;     // how far the emblem is lifted toward camera (0..1) -> softer, wider shadow

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

  float blob(vec2 uv, vec2 c, float r) {
    vec2 d = uv - c;
    d.x *= uAspect;
    return exp(-dot(d, d) / (r * r));
  }

  void main() {
    vec2 uv = vUv;
    float t = uTime * 0.05;
    float p = uProg;

    vec3 cream  = vec3(0.969, 0.949, 0.918);
    vec3 peach  = vec3(0.984, 0.855, 0.788);
    vec3 lilac  = vec3(0.886, 0.867, 0.965);
    vec3 mint   = vec3(0.847, 0.937, 0.894);
    vec3 sky    = vec3(0.851, 0.906, 0.969);
    vec3 butter = vec3(0.984, 0.937, 0.812);

    vec3 col = cream;
    // drifting pastel light; scroll pans the palette like a slow camera move
    col = mix(col, peach,  blob(uv, vec2(0.12 + 0.05*sin(t*3.1) + p*0.05, 0.82 + 0.04*cos(t*2.3)), 0.42) * 0.85);
    col = mix(col, lilac,  blob(uv, vec2(0.92 - p*0.06 + 0.04*cos(t*2.7), 0.70 + 0.05*sin(t*1.9)), 0.46) * 0.8);
    col = mix(col, mint,   blob(uv, vec2(0.80 + 0.05*sin(t*2.0), 0.10 + p*0.04), 0.44) * 0.7);
    col = mix(col, sky,    blob(uv, vec2(0.18 + 0.04*cos(t*1.7), 0.16 - p*0.03), 0.40) * 0.65);
    col = mix(col, butter, blob(uv, vec2(0.50 + 0.10*sin(t*1.3 + p), 0.50), 0.30) * 0.35);

    // contact shadow under the emblem (wider + fainter when it lifts toward the camera)
    vec2 sd = uv - vec2(uGlow.x, uGlow.y - uGlowR * (1.05 + uLift * 0.35));
    sd.x *= uAspect;
    float sw = uGlowR * (1.15 + uLift * 0.5);
    float sh = uGlowR * (0.16 + uLift * 0.1);
    float shadow = exp(-(sd.x*sd.x)/(sw*sw) - (sd.y*sd.y)/(sh*sh));
    col *= 1.0 - shadow * (0.16 - uLift * 0.07);

    // soft white bloom behind the emblem - the glass refracts this
    vec2 gd = uv - uGlow;
    gd.x *= uAspect;
    float bloom = exp(-dot(gd, gd) / pow(uGlowR * 1.35, 2.0));
    col = mix(col, vec3(1.0), bloom * 0.7);

    // gentle vignette + grain (kills banding)
    vec2 v = uv - 0.5;
    col *= 1.0 - dot(v, v) * 0.12;
    col += (hash(uv * vec2(1931.0, 1373.0) + uTime) - 0.5) * 0.012;

    gl_FragColor = vec4(col, 1.0);
  }
`;

async function buildGlassLogo(material: THREE.Material): Promise<THREE.Group> {
  const svgText = await fetch("/branding/svg-logo.svg").then((r) => r.text());
  const data = new SVGLoader().parse(svgText);

  const group = new THREE.Group();
  const extrude: THREE.ExtrudeGeometryOptions = {
    depth: 18,
    bevelEnabled: true,
    bevelThickness: 9,
    bevelSize: 5,
    bevelOffset: -1.2,
    bevelSegments: 12,
    curveSegments: 48,
  };

  for (const path of data.paths) {
    for (const shape of SVGLoader.createShapes(path)) {
      let geo: THREE.BufferGeometry = new THREE.ExtrudeGeometry(shape, extrude);
      geo.deleteAttribute("uv");
      geo = mergeVertices(geo, 1e-3);
      geo.computeVertexNormals();
      group.add(new THREE.Mesh(geo, material));
    }
  }

  // SVG is y-down: flip, then centre (including depth) and normalise so the largest side is 1 unit.
  group.scale.y = -1;
  const box = new THREE.Box3().setFromObject(group);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  group.position.sub(center);
  const holder = new THREE.Group();
  holder.add(group);
  holder.scale.setScalar(1 / Math.max(size.x, size.y));
  return holder;
}

/* ---------------------------------------------------------------------------------------------- */

export function createEmblem(canvas: HTMLCanvasElement, poses: EmblemPose[], mobilePoses: EmblemPose[]): Emblem {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.03);
  scene.environment = env.texture;

  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  camera.position.set(0, 0, 10);

  // Full-screen pastel backdrop (opaque, so the glass's transmission pass sees it).
  const bgUniforms = {
    uTime: { value: 0 },
    uProg: { value: 0 },
    uAspect: { value: 1 },
    uGlow: { value: new THREE.Vector2(0.5, 0.6) },
    uGlowR: { value: 0.1 },
    uLift: { value: 0 },
  };
  const bgMat = new THREE.ShaderMaterial({
    vertexShader: BACKDROP_VERT,
    fragmentShader: BACKDROP_FRAG,
    uniforms: bgUniforms,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const bg = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bgMat);
  bg.frustumCulled = false;
  bg.renderOrder = -10;
  scene.add(bg);

  // Clear, lightly frosted glass with a glossy coat: refracts the pastel light, crisp rounded highlights.
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    metalness: 0,
    roughness: 0.12,
    transmission: 1,
    thickness: 1.25,
    ior: 1.5,
    envMapIntensity: 1.25,
    specularIntensity: 1,
    clearcoat: 1,
    clearcoatRoughness: 0.03,
    attenuationColor: new THREE.Color(0xf6f2ec),
    attenuationDistance: 1.6,
  });

  const pivot = new THREE.Group();
  scene.add(pivot);

  let loaded = false;
  let loadedAt = 0;
  let disposed = false;
  buildGlassLogo(glass)
    .then((logo) => {
      if (disposed) return;
      pivot.add(logo);
      loaded = true;
      loadedAt = -1; // stamped on the next frame
    })
    .catch((e) => console.error("[story] emblem failed to build", e));

  let w = 1;
  let h = 1;
  const resize = () => {
    w = Math.max(1, canvas.clientWidth);
    h = Math.max(1, canvas.clientHeight);
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    bgUniforms.uAspect.value = w / h;
  };
  resize();

  const halfH = () => Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.position.z;

  // springs for every animated channel
  const sx = new Spring(0);
  const sy = new Spring(0);
  const sz = new Spring(0, 40, 0.9);
  const sScale = new Spring(0.0001, 40, 0.9);
  const sRotX = new Spring(0, 46, 0.8);
  const sRotY = new Spring(0, 34, 0.82);
  const sRotZ = new Spring(0, 46, 0.8);

  const projected = new THREE.Vector3();
  let lastTime = 0;

  const render = (u: number, time: number, pointer: { x: number; y: number }) => {
    const dt = Math.min(0.05, Math.max(0.001, time - lastTime));
    lastTime = time;
    bgUniforms.uTime.value = time;

    if (loaded) {
      if (loadedAt < 0) loadedAt = time;
      const set = w < 820 ? mobilePoses : poses;
      const n = set.length;
      const i = Math.max(0, Math.min(n - 2, Math.floor(u)));
      const f = clamp01(u - i);
      // the move happens in the middle of the scroll between two chapters; it holds still at each chapter
      const e = easeInOutCubic(clamp01((f - 0.12) / 0.76));
      const arc = Math.sin(e * Math.PI); // 0 -> 1 -> 0 across the move
      const a = set[i];
      const b = set[i + 1];

      const hh = halfH();
      const hw = hh * camera.aspect;
      const size = lerp(Math.min(a.size * hh * 2, (a.maxW ?? 9) * hw * 2), Math.min(b.size * hh * 2, (b.maxW ?? 9) * hw * 2), e);
      const dir = i % 2 === 0 ? 1 : -1;

      // entrance: rises out of the light and turns to face you
      const intro = easeOutExpo(clamp01((time - loadedAt) / 2.2));

      // cinematic move: one full turn per chapter, a dolly toward the lens, a banking roll and a lifting arc
      const turns = (i + e) * TAU;
      const targetX = lerp(a.x, b.x, e) * hw + pointer.x * 0.06 * size;
      const targetY = lerp(a.y, b.y, e) * hh + arc * 0.16 * size - (1 - intro) * 0.6 * size - pointer.y * 0.04 * size;
      const targetZ = arc * 2.6;
      const targetScale = size * (0.82 + 0.18 * intro);
      const targetRotY = lerp(a.rotY, b.rotY, e) + turns - (1 - intro) * 1.4 + pointer.x * 0.2;
      const targetRotX = lerp(a.rotX, b.rotX, e) - arc * 0.22 + pointer.y * 0.12;
      const targetRotZ = arc * 0.2 * dir;

      // idle "sailing": slow pitch, roll and bob layered on top of the springs
      const bob = Math.sin(time * 0.9) * 0.03 * size;
      const pitch = Math.sin(time * 0.62) * 0.045;
      const roll = Math.sin(time * 0.81 + 1.2) * 0.04;

      pivot.position.set(sx.step(targetX, dt), sy.step(targetY, dt) + bob, sz.step(targetZ, dt));
      pivot.scale.setScalar(Math.max(0.0001, sScale.step(targetScale, dt)));
      pivot.rotation.set(sRotX.step(targetRotX, dt) + pitch, sRotY.step(targetRotY, dt), sRotZ.step(targetRotZ, dt) + roll);
      glass.envMapIntensity = 1.1 + lerp(a.glow, b.glow, e) * 0.35 + arc * 0.25;

      // tell the backdrop where the emblem is (for its bloom + contact shadow)
      projected.set(pivot.position.x, pivot.position.y, 0).project(camera);
      bgUniforms.uGlow.value.set(projected.x * 0.5 + 0.5, projected.y * 0.5 + 0.5);
      bgUniforms.uGlowR.value = (pivot.scale.x / (hh * 2)) * 0.62 * (1 + sz.x * 0.08);
      bgUniforms.uLift.value = clamp01(sz.x / 2.6);
      bgUniforms.uProg.value = u / Math.max(1, n - 1);
    }
    renderer.render(scene, camera);
  };

  return {
    render,
    resize,
    dispose: () => {
      disposed = true;
      glass.dispose();
      bgMat.dispose();
      env.dispose();
      pmrem.dispose();
      scene.traverse((o) => (o as THREE.Mesh).geometry?.dispose?.());
      renderer.dispose();
    },
  };
}
