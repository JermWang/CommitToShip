import * as THREE from "three";
import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/**
 * The Ship & Commit sailboat emblem as rounded glass, floating over a living cream-pastel backdrop.
 *
 * - Geometry: our own /branding/svg-logo.svg, extruded with a multi-segment bevel (every edge rounded).
 * - Backdrop: a full-screen pastel shader drawn INSIDE the WebGL scene, so the glass genuinely refracts it.
 *   It also paints the soft bloom behind the emblem, its contact shadow and iridescent twinkles around it.
 * - Motion: chapter poses + a cinematic transition (full turn, dolly toward camera, bank, arc) fed through
 *   damped springs so the emblem has weight and settles instead of snapping. Idle "sailing" bob on top.
 * - Sparkle: prismatic glints that live on the rounded edges, an orbiting key light that slides highlights
 *   across the curves, floating bokeh dust, and a small glint burst whenever the emblem lands on a chapter.
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

/** Pastel "prism" tint for a glint, so sparkles read on a light background. */
function prism(seed: number): THREE.Color {
  const c = new THREE.Color();
  c.setHSL((seed * 0.83 + 0.55) % 1, 0.85, 0.82);
  return c;
}

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

    // iridescent twinkles in the air around the emblem
    vec2 g = vec2(uv.x * uAspect, uv.y) * 54.0;
    vec2 cell = floor(g);
    vec2 fr = fract(g) - 0.5;
    float rnd = hash(cell);
    if (rnd > 0.955) {
      float tw = pow(max(0.0, sin(uTime * (0.9 + rnd * 2.2) + rnd * 50.0)), 14.0);
      float crossH = max(0.0, 1.0 - abs(fr.y) * 22.0) * max(0.0, 1.0 - abs(fr.x) * 2.2);
      float crossV = max(0.0, 1.0 - abs(fr.x) * 22.0) * max(0.0, 1.0 - abs(fr.y) * 2.2);
      float star = (exp(-dot(fr, fr) * 140.0) + (crossH + crossV) * 0.55) * tw;
      float near = exp(-dot(gd, gd) / pow(uGlowR * 2.8, 2.0)) * (1.0 - bloom * 0.6);
      vec3 tint = 0.62 + 0.38 * cos(6.2831 * (rnd * 7.0 + vec3(0.0, 0.33, 0.67)));
      col = mix(col, tint, clamp(star * near, 0.0, 1.0) * 0.95);
    }

    // gentle vignette + grain (kills banding)
    vec2 v = uv - 0.5;
    col *= 1.0 - dot(v, v) * 0.12;
    col += (hash(uv * vec2(1931.0, 1373.0) + uTime) - 0.5) * 0.012;

    gl_FragColor = vec4(col, 1.0);
  }
`;

/* bokeh dust: soft discs at different depths, drifting up and parallaxing with scroll */
const DUST_VERT = /* glsl */ `
  attribute float aSeed;
  uniform float uTime;
  uniform float uProg;
  uniform float uPixelRatio;
  varying float vAlpha;
  varying float vSeed;
  void main() {
    vec3 p = position;
    float speed = 0.12 + fract(aSeed * 13.7) * 0.18;
    p.y = mod(p.y + uTime * speed + 6.0, 12.0) - 6.0;
    p.x += sin(uTime * 0.3 + aSeed * 20.0) * 0.25 - uProg * (1.5 + p.z * 0.4);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    float size = 14.0 + fract(aSeed * 7.3) * 34.0;
    gl_PointSize = size * uPixelRatio * (8.0 / -mv.z);
    vAlpha = (0.22 + 0.4 * fract(aSeed * 3.1)) * smoothstep(6.0, 4.0, abs(p.y));
    vSeed = aSeed;
  }
`;

const DUST_FRAG = /* glsl */ `
  precision highp float;
  varying float vAlpha;
  varying float vSeed;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    float disc = smoothstep(0.5, 0.18, d);
    float rim = smoothstep(0.5, 0.42, d) - smoothstep(0.42, 0.34, d);
    vec3 tint = 0.86 + 0.14 * cos(6.2831 * (vSeed * 5.0 + vec3(0.0, 0.33, 0.67)));
    gl_FragColor = vec4(tint, (disc * 0.65 + rim * 0.35) * vAlpha);
  }
`;

function makeSparkleTexture(): THREE.CanvasTexture {
  const S = 128;
  const c = document.createElement("canvas");
  c.width = S;
  c.height = S;
  const g = c.getContext("2d")!;
  const m = S / 2;

  const core = g.createRadialGradient(m, m, 0, m, m, S * 0.2);
  core.addColorStop(0, "rgba(255,255,255,1)");
  core.addColorStop(0.3, "rgba(255,255,255,0.75)");
  core.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = core;
  g.fillRect(0, 0, S, S);

  const flare = (angle: number, len: number, width: number, alpha: number) => {
    g.save();
    g.translate(m, m);
    g.rotate(angle);
    const lg = g.createLinearGradient(-len, 0, len, 0);
    lg.addColorStop(0, "rgba(255,255,255,0)");
    lg.addColorStop(0.5, `rgba(255,255,255,${alpha})`);
    lg.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = lg;
    g.fillRect(-len, -width / 2, len * 2, width);
    g.restore();
  };
  flare(0, m, 3, 1);
  flare(Math.PI / 2, m, 3, 1);
  flare(Math.PI / 4, m * 0.5, 2, 0.6);
  flare(-Math.PI / 4, m * 0.5, 2, 0.6);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

async function buildGlassLogo(material: THREE.Material): Promise<{ holder: THREE.Group; edgePoints: THREE.Vector3[] }> {
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
  holder.updateMatrixWorld(true);

  // Glint anchors: points on the rounded front bevel (normals tilted toward the viewer), in holder space.
  const edgePoints: THREE.Vector3[] = [];
  const v = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const nm = new THREE.Matrix3();
  holder.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!(mesh as any).isMesh) return;
    const pos = mesh.geometry.getAttribute("position");
    const nor = mesh.geometry.getAttribute("normal");
    nm.getNormalMatrix(mesh.matrixWorld);
    for (let k = 0; k < pos.count; k += 7) {
      nrm.fromBufferAttribute(nor, k).applyMatrix3(nm).normalize();
      if (nrm.z > 0.35 && nrm.z < 0.85) {
        v.fromBufferAttribute(pos, k).applyMatrix4(mesh.matrixWorld);
        edgePoints.push(v.clone());
      }
    }
  });
  return { holder, edgePoints };
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

  // An orbiting key light: its specular highlight glides across the rounded glass (the "glisten").
  const keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
  scene.add(keyLight);

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

  // Bokeh dust
  const DUST = 70;
  const dustGeo = new THREE.BufferGeometry();
  const dustPos = new Float32Array(DUST * 3);
  const dustSeed = new Float32Array(DUST);
  for (let k = 0; k < DUST; k++) {
    dustPos[k * 3] = (Math.random() * 2 - 1) * 9;
    dustPos[k * 3 + 1] = (Math.random() * 2 - 1) * 6;
    dustPos[k * 3 + 2] = -4 + Math.random() * 6.5;
    dustSeed[k] = Math.random();
  }
  dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPos, 3));
  dustGeo.setAttribute("aSeed", new THREE.BufferAttribute(dustSeed, 1));
  const dustUniforms = { uTime: { value: 0 }, uProg: { value: 0 }, uPixelRatio: { value: 1 } };
  const dustMat = new THREE.ShaderMaterial({
    vertexShader: DUST_VERT,
    fragmentShader: DUST_FRAG,
    uniforms: dustUniforms,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
  const dust = new THREE.Points(dustGeo, dustMat);
  dust.frustumCulled = false;
  dust.renderOrder = 5;
  scene.add(dust);

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

  // sparkle sprites
  const sparkleTex = makeSparkleTexture();
  const makeSprite = (tint: THREE.Color) => {
    const s = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: sparkleTex,
        color: tint,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      })
    );
    s.renderOrder = 20;
    return s;
  };

  type Glint = { sprite: THREE.Sprite; rate: number; phase: number; size: number };
  const glints: Glint[] = [];

  const BURST = 16;
  const burst = Array.from({ length: BURST }, (_, k) => {
    const sprite = makeSprite(prism(k / BURST));
    sprite.visible = false;
    scene.add(sprite);
    const ang = (k / BURST) * TAU + Math.random() * 0.3;
    return { sprite, dir: new THREE.Vector2(Math.cos(ang), Math.sin(ang)), reach: 0.55 + Math.random() * 0.45, size: 0.06 + Math.random() * 0.07 };
  });
  let burstAt = -10;
  let burstCenter = new THREE.Vector3();
  let burstScale = 1;

  let loaded = false;
  let loadedAt = 0;
  let disposed = false;
  buildGlassLogo(glass)
    .then(({ holder, edgePoints }) => {
      if (disposed) return;
      pivot.add(holder);
      // ~14 glints spread across the rounded edges
      const picks = Math.min(14, edgePoints.length);
      for (let k = 0; k < picks; k++) {
        const p = edgePoints[Math.floor((k / picks) * edgePoints.length + Math.random() * (edgePoints.length / picks))];
        if (!p) continue;
        const sprite = makeSprite(prism(Math.random()));
        sprite.position.copy(p);
        pivot.add(sprite);
        glints.push({ sprite, rate: 0.6 + Math.random() * 1.1, phase: Math.random() * TAU, size: 0.08 + Math.random() * 0.1 });
      }
      loaded = true;
      loadedAt = -1; // stamped on the next frame
    })
    .catch((e) => console.error("[story] emblem failed to build", e));

  let w = 1;
  let h = 1;
  const resize = () => {
    w = Math.max(1, canvas.clientWidth);
    h = Math.max(1, canvas.clientHeight);
    const pr = Math.min(2, window.devicePixelRatio || 1);
    renderer.setPixelRatio(pr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    bgUniforms.uAspect.value = w / h;
    dustUniforms.uPixelRatio.value = pr;
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
  let lastSeg = -1;
  let lastE = 0;

  const render = (u: number, time: number, pointer: { x: number; y: number }) => {
    const dt = Math.min(0.05, Math.max(0.001, time - lastTime));
    lastTime = time;
    bgUniforms.uTime.value = time;
    dustUniforms.uTime.value = time;

    // the key light slowly orbits so highlights slide across the curved glass
    keyLight.position.set(Math.cos(time * 0.42) * 6, 3.5 + Math.sin(time * 0.31) * 2, 5 + Math.sin(time * 0.42) * 2);

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
      keyLight.intensity = 2.0 + arc * 2.2;

      // edge glints: brief, sharp twinkles (brighter while the emblem turns)
      for (const g of glints) {
        const tw = Math.pow(Math.max(0, Math.sin(time * g.rate * TAU * 0.35 + g.phase)), 10);
        const s = g.size * (tw * (1 + arc * 0.8) + 0.0001) * intro;
        g.sprite.scale.setScalar(s);
        (g.sprite.material as THREE.SpriteMaterial).rotation = time * 0.6 + g.phase;
        (g.sprite.material as THREE.SpriteMaterial).opacity = Math.min(1, tw * 1.4);
      }

      // landing burst: a ring of prismatic glints when the emblem settles into a chapter
      const landed = (i === lastSeg && ((lastE < 0.96 && e >= 0.96) || (lastE > 0.04 && e <= 0.04))) || (lastSeg >= 0 && i !== lastSeg && (e >= 0.96 || e <= 0.04));
      if (landed && time - loadedAt > 1.2) {
        burstAt = time;
        burstCenter.copy(pivot.position);
        burstScale = pivot.scale.x;
      }
      lastSeg = i;
      lastE = e;

      // tell the backdrop where the emblem is (for its bloom, contact shadow and twinkles)
      projected.set(pivot.position.x, pivot.position.y, 0).project(camera);
      bgUniforms.uGlow.value.set(projected.x * 0.5 + 0.5, projected.y * 0.5 + 0.5);
      bgUniforms.uGlowR.value = (pivot.scale.x / (hh * 2)) * 0.62 * (1 + sz.x * 0.08);
      bgUniforms.uLift.value = clamp01(sz.x / 2.6);
      bgUniforms.uProg.value = u / Math.max(1, n - 1);
      dustUniforms.uProg.value = u / Math.max(1, n - 1);
    }

    const bp = (time - burstAt) / 1.1;
    for (const p of burst) {
      if (bp < 0 || bp >= 1) {
        p.sprite.visible = false;
        continue;
      }
      const out = easeOutExpo(bp);
      p.sprite.visible = true;
      p.sprite.position.set(
        burstCenter.x + p.dir.x * burstScale * p.reach * (0.35 + out * 0.65),
        burstCenter.y + p.dir.y * burstScale * p.reach * (0.35 + out * 0.65),
        burstCenter.z + 0.2
      );
      p.sprite.scale.setScalar(burstScale * p.size * (1 - bp) * (0.6 + Math.sin(bp * Math.PI) * 0.8));
      (p.sprite.material as THREE.SpriteMaterial).opacity = Math.pow(1 - bp, 1.4);
      (p.sprite.material as THREE.SpriteMaterial).rotation = bp * 2;
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
      dustMat.dispose();
      dustGeo.dispose();
      sparkleTex.dispose();
      env.dispose();
      pmrem.dispose();
      scene.traverse((o) => {
        (o as THREE.Mesh).geometry?.dispose?.();
        const m = (o as THREE.Sprite).material as THREE.Material | undefined;
        if (m && (o as any).isSprite) m.dispose();
      });
      renderer.dispose();
    },
  };
}
