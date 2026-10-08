import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

/**
 * The Ship & Commit sailboat emblem (our own /branding/logo.glb) rendered as polished chrome.
 * It is the one 3D object in the story and acts as the "narrator": every chapter gives it a pose,
 * and scroll progress blends between poses.
 */

/** Pose in viewport-relative units: x/y are fractions of the half-viewport (-1..1), size is a fraction of viewport height. */
export type EmblemPose = { x: number; y: number; size: number; rotY: number; rotX: number; glow: number };

export type Emblem = {
  render: (u: number, time: number, pointer: { x: number; y: number }) => void;
  resize: () => void;
  dispose: () => void;
};

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

export function createEmblem(canvas: HTMLCanvasElement, poses: EmblemPose[], mobilePoses: EmblemPose[]): Emblem {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.4;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.035);
  scene.environment = env.texture;

  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  camera.position.set(0, 0, 10);

  // Studio rig: soft key, strong rim from behind for the chrome edge highlight.
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(3, 4, 6);
  const rim = new THREE.DirectionalLight(0xffffff, 3.2);
  rim.position.set(-5, 2, -4);
  scene.add(key, rim, new THREE.AmbientLight(0xffffff, 0.15));

  // pivot -> holder (scaled so the emblem's height == 1 world unit, centred)
  const pivot = new THREE.Group();
  const holder = new THREE.Group();
  pivot.add(holder);
  scene.add(pivot);

  const face = new THREE.MeshPhysicalMaterial({ color: 0xf4f4f4, metalness: 1, roughness: 0.14, clearcoat: 1, clearcoatRoughness: 0.08, side: THREE.DoubleSide });
  const edge = new THREE.MeshPhysicalMaterial({ color: 0x8c8c8c, metalness: 1, roughness: 0.34, side: THREE.DoubleSide });

  let loaded = false;
  let disposed = false;
  new GLTFLoader().load(
    "/branding/logo.glb",
    (gltf) => {
      if (disposed) return;
      const model = gltf.scene;
      model.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!(m as any).isMesh) return;
        // primitive 0 = the faces (was a tinted glass/metal), primitive 1 = extrusion sides
        const name = String((m.material as THREE.Material)?.name ?? "");
        m.material = name.endsWith("002") ? edge : face;
      });
      // (the GLB's node transform already stands the emblem up facing +Z)
      const box = new THREE.Box3().setFromObject(model);
      const size = new THREE.Vector3();
      const center = new THREE.Vector3();
      box.getSize(size);
      box.getCenter(center);
      model.position.sub(center);
      holder.add(model);
      holder.scale.setScalar(1 / Math.max(size.y, size.x, 0.0001));
      loaded = true;
    },
    undefined,
    (e) => console.error("[story] emblem failed to load", e)
  );

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

  const visibleHalfHeight = () => Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.position.z;

  let spin = 0;
  const render = (u: number, time: number, pointer: { x: number; y: number }) => {
    if (!loaded) {
      renderer.render(scene, camera);
      return;
    }
    const set = w < 820 ? mobilePoses : poses;
    const i = Math.max(0, Math.min(set.length - 2, Math.floor(u)));
    const t = ease((u - i - 0.15) / 0.7);
    const a = set[i];
    const b = set[Math.min(set.length - 1, i + 1)];

    const hh = visibleHalfHeight();
    const hw = hh * camera.aspect;
    const size = lerp(a.size, b.size, t) * hh * 2;

    // a small continuous turn so the chrome always catches light, plus a full flourish between chapters
    spin += 0.0035;
    const flourish = Math.sin(t * Math.PI) * 0.9;

    pivot.position.set(lerp(a.x, b.x, t) * hw, lerp(a.y, b.y, t) * hh + Math.sin(time * 0.9) * 0.04 * size, 0);
    pivot.scale.setScalar(Math.max(0.0001, size));
    pivot.rotation.set(
      lerp(a.rotX, b.rotX, t) + pointer.y * 0.12,
      lerp(a.rotY, b.rotY, t) + flourish + Math.sin(spin) * 0.22 + pointer.x * 0.25,
      Math.sin(time * 0.6) * 0.02
    );
    key.intensity = 1.6 + lerp(a.glow, b.glow, t) * 1.6;
    renderer.render(scene, camera);
  };

  return {
    render,
    resize,
    dispose: () => {
      disposed = true;
      face.dispose();
      edge.dispose();
      env.dispose();
      pmrem.dispose();
      scene.traverse((o) => (o as THREE.Mesh).geometry?.dispose?.());
      renderer.dispose();
    },
  };
}
