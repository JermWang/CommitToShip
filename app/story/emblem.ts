import * as THREE from "three";
import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/**
 * The Ship & Commit sailboat emblem as a piece of clear, softly-rounded glass.
 *
 * Geometry is built from our own logo artwork (/branding/svg-logo.svg): each path is extruded with a
 * multi-segment bevel so every edge is rounded. It's the one 3D object in the story and moves between
 * chapter "poses" as you scroll.
 */

/** x/y: fraction of the half-viewport (-1..1). size: fraction of viewport height. maxW: cap as a fraction of viewport width. */
export type EmblemPose = { x: number; y: number; size: number; rotY: number; rotX: number; glow: number; maxW?: number };

export type Emblem = {
  render: (u: number, time: number, pointer: { x: number; y: number }) => void;
  resize: () => void;
  dispose: () => void;
};

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/**
 * A soft studio "light pool" that sits behind the emblem and travels with it. It fades to pure black at its
 * edges (invisible against the page), but gives the glass bright, soft shapes to refract - which is what makes
 * the frosted glass glow from within on a black stage.
 */
function makeLightPool(): THREE.CanvasTexture {
  const S = 1024;
  const c = document.createElement("canvas");
  c.width = S;
  c.height = S;
  const g = c.getContext("2d")!;
  g.fillStyle = "#000";
  g.fillRect(0, 0, S, S);

  // an even, soft studio glow: bright core, long falloff - no hard beams
  const pool = g.createRadialGradient(S / 2, S * 0.46, 0, S / 2, S / 2, S / 2);
  pool.addColorStop(0, "rgb(150,150,150)");
  pool.addColorStop(0.18, "rgb(96,96,96)");
  pool.addColorStop(0.45, "rgb(34,34,34)");
  pool.addColorStop(1, "rgb(0,0,0)");
  g.fillStyle = pool;
  g.fillRect(0, 0, S, S);

  // final vignette guarantees pure black edges
  g.globalCompositeOperation = "multiply";
  const fade = g.createRadialGradient(S / 2, S / 2, S * 0.22, S / 2, S / 2, S / 2);
  fade.addColorStop(0, "#fff");
  fade.addColorStop(1, "#000");
  g.fillStyle = fade;
  g.fillRect(0, 0, S, S);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

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

  // SVG is y-down: flip, then centre and normalise so the emblem's largest side is 1 unit.
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

export function createEmblem(canvas: HTMLCanvasElement, poses: EmblemPose[], mobilePoses: EmblemPose[]): Emblem {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  const poolTex = makeLightPool();
  const pool = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: poolTex, toneMapped: false }));
  scene.add(pool);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.02);
  scene.environment = env.texture;

  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  camera.position.set(0, 0, 10);

  // Frosted glass (same language as the UI cards): a diffused, light-catching body under a glossy clear coat,
  // so the rounded edges stay crisp while the inside glows softly.
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    metalness: 0,
    roughness: 0.32,
    transmission: 1,
    thickness: 1.1,
    ior: 1.5,
    envMapIntensity: 2.2,
    specularIntensity: 1,
    clearcoat: 1,
    clearcoatRoughness: 0.04,
    attenuationColor: new THREE.Color(0xe9e9e9),
    attenuationDistance: 0.9,
  });

  const pivot = new THREE.Group();
  scene.add(pivot);

  let loaded = false;
  let disposed = false;
  buildGlassLogo(glass)
    .then((logo) => {
      if (disposed) return;
      pivot.add(logo);
      loaded = true;
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
  };
  resize();

  const halfH = () => Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.position.z;

  let spin = 0;
  const render = (u: number, time: number, pointer: { x: number; y: number }) => {
    if (loaded) {
      const set = w < 820 ? mobilePoses : poses;
      const i = Math.max(0, Math.min(set.length - 2, Math.floor(u)));
      const t = ease((u - i - 0.15) / 0.7);
      const a = set[i];
      const b = set[Math.min(set.length - 1, i + 1)];

      const hh = halfH();
      const hw = hh * camera.aspect;
      const sizeA = Math.min(a.size * hh * 2, (a.maxW ?? 9) * hw * 2);
      const sizeB = Math.min(b.size * hh * 2, (b.maxW ?? 9) * hw * 2);
      const size = lerp(sizeA, sizeB, t);

      spin += 0.003;
      const flourish = Math.sin(t * Math.PI) * 0.9;
      pivot.position.set(lerp(a.x, b.x, t) * hw, lerp(a.y, b.y, t) * hh + Math.sin(time * 0.9) * 0.035 * size, 0);
      pivot.scale.setScalar(Math.max(0.0001, size));
      // the light pool sits a little behind the emblem, follows it, and breathes subtly
      pool.position.set(pivot.position.x, pivot.position.y, -1.6);
      pool.scale.setScalar(size * (2.6 + Math.sin(time * 0.5) * 0.05));
      pivot.rotation.set(
        lerp(a.rotX, b.rotX, t) + pointer.y * 0.1,
        lerp(a.rotY, b.rotY, t) + flourish + Math.sin(spin) * 0.28 + pointer.x * 0.22,
        Math.sin(time * 0.6) * 0.02
      );
      glass.envMapIntensity = 1.9 + lerp(a.glow, b.glow, t) * 0.6;
    }
    renderer.render(scene, camera);
  };

  return {
    render,
    resize,
    dispose: () => {
      disposed = true;
      glass.dispose();
      poolTex.dispose();
      env.dispose();
      pmrem.dispose();
      scene.traverse((o) => (o as THREE.Mesh).geometry?.dispose?.());
      renderer.dispose();
    },
  };
}
