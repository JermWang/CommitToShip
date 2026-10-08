"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

type Props = {
  src: string;
};

export default function ModelSpotlight(props: Props) {
  const { src } = props;

  const hostRef = useRef<HTMLDivElement | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let mounted = true;

    const host = hostRef.current;
    if (!host) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 2.05;
    renderer.setClearColor(0xf6f1e9, 1);
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();

    const pmrem = new THREE.PMREMGenerator(renderer);
    const envRt = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = envRt.texture;

    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
    camera.position.set(0.25, -0.16, 3.15);

    const lookAtTarget = new THREE.Vector3(0, -0.35, 0);
    camera.lookAt(lookAtTarget);

    const ambient = new THREE.AmbientLight(0xffffff, 1.65);
    scene.add(ambient);

    const key = new THREE.DirectionalLight(0xffffff, 4.4);
    key.position.set(2.2, 2.4, 2.4);
    scene.add(key);

    const rim = new THREE.DirectionalLight(0xffffff, 0.25);
    rim.position.set(-2.8, 1.8, -1.4);
    scene.add(rim);

    const fill = new THREE.DirectionalLight(0xffffff, 2.2);
    fill.position.set(0.4, 0.2, 2.2);
    scene.add(fill);

    const pivot = new THREE.Group();
    scene.add(pivot);

    pivot.position.set(0.95, -0.48, 0);

    const loader = new GLTFLoader();

    let raf = 0;

    const resize = () => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(h, 1);
      camera.updateProjectionMatrix();
    };

    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();

    const tick = () => {
      raf = window.requestAnimationFrame(tick);
      pivot.rotation.y += 0.0022;
      if (pivot.rotation.y > Math.PI * 2) pivot.rotation.y -= Math.PI * 2;

      camera.lookAt(lookAtTarget);

      renderer.render(scene, camera);
    };

    const onLoad = (gltf: any) => {
      if (!mounted) return;
      const loadedModel = gltf?.scene as THREE.Object3D | undefined;
      if (!loadedModel) {
        setMissing(true);
        tick();
        return;
      }

      pivot.rotation.set(0, 0, 0);

      const box = new THREE.Box3().setFromObject(loadedModel);
      const size = new THREE.Vector3();
      box.getSize(size);
      const center = new THREE.Vector3();
      box.getCenter(center);
      loadedModel.position.sub(center);

      const maxDim = Math.max(size.x, size.y, size.z);
      const scale = maxDim > 0 ? 1.2 / maxDim : 1;
      loadedModel.scale.setScalar(scale);

      const box2 = new THREE.Box3().setFromObject(loadedModel);
      const center2 = new THREE.Vector3();
      box2.getCenter(center2);
      loadedModel.position.sub(center2);

      loadedModel.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!(mesh as any).isMesh) return;
        const mat = (mesh as any).material;
        if (!mat) return;
        const mats = Array.isArray(mat) ? mat : [mat];
        for (const m of mats) {
          if (m && typeof m === "object") {
            (m as any).envMapIntensity = 1.45;
          }
        }
      });

      pivot.add(loadedModel);
      setMissing(false);
      tick();
    };

    const onError = () => {
      if (!mounted) return;
      setMissing(true);
      tick();
    };

    const u = new URL(src, "http://local");
    u.searchParams.set("v", String(Date.now()));
    const cacheBustedSrc = u.pathname + u.search;

    loader.load(cacheBustedSrc, onLoad, undefined, onError);

    return () => {
      mounted = false;
      window.cancelAnimationFrame(raf);
      ro.disconnect();

      renderer.dispose();
      pmrem.dispose();
      envRt.texture.dispose();
      envRt.dispose();
      if (renderer.domElement.parentElement) renderer.domElement.parentElement.removeChild(renderer.domElement);

      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if ((mesh as any).geometry) (mesh as any).geometry.dispose?.();
        if ((mesh as any).material) {
          const mat = (mesh as any).material;
          if (Array.isArray(mat)) mat.forEach((m) => m.dispose?.());
          else mat.dispose?.();
        }
      });
    };
  }, [src]);

  return (
    <div className="spotlight" ref={hostRef}>
      {missing ? (
        <div className="spotlightHint">
          Drop your 3D logo at <span className="mono">/branding/logo.glb</span>.
          <br />
          <strong>Waiting for asset.</strong>
        </div>
      ) : null}
    </div>
  );
}
