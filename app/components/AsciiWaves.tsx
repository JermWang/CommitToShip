"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";

export default function AsciiWaves() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const tab = searchParams.get("tab");
  
  // Only show on landing page (no tab or tab=home)
  const isLandingPage = pathname === "/" && (!tab || tab === "home");

  useEffect(() => {
    if (!isLandingPage) return;
    
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const chars = [".", ":", "-", "=", "+", "*", "#", "%", "@", "0", "1"];

    let width = 0;
    let height = 0;
    let time = 0;
    let rafId = 0;
    let running = true;

    const resize = () => {
      const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      width = Math.floor(window.innerWidth);
      height = Math.floor(window.innerHeight);

      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.font = "15px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace";
      ctx.textBaseline = "top";
    };

    const draw = () => {
      if (!running) return;

      ctx.clearRect(0, 0, width, height);

      const isMobile = window.innerWidth < 768;
      const charW = isMobile ? 14 : 10;
      const charH = isMobile ? 18 : 14;

      const cols = Math.floor(width / charW);
      const rows = Math.floor(height / charH);

      const horizonRow = Math.floor(rows * 0.66);
      const baseRow = Math.floor(rows * 0.80);

      for (let x = 0; x < cols; x++) {
        const wave =
          Math.sin(x * 0.12 + time) * 1.2 +
          Math.sin(x * 0.04 + time * 0.6) * 2.4;

        const yCenter = baseRow + Math.round(wave * 2.6);

        // Leave upper/middle mostly clean.
        if (yCenter < horizonRow) continue;

        // Draw a crisp crest line + a trailing band below it.
        for (let dy = -2; dy <= 14; dy++) {
          const y = yCenter + dy;
          if (y < 0 || y >= rows) continue;

          // Keep the surface line dense, but fade/sparsify depth below.
          const phase = Math.floor(time * 12);
          const sprinkle = (x * 7 + y * 11 + phase) % 6;

          if (dy <= 1) {
            // Crest: draw most columns, small gaps.
            if (sprinkle === 5) continue;
          } else if (dy <= 6) {
            // Upper body: draw ~50-66%.
            if (sprinkle === 4 || sprinkle === 5) continue;
          } else {
            // Lower body: draw ~33%.
            if (sprinkle !== 0 && sprinkle !== 1) continue;
          }

          const depth = Math.max(0, 1 - dy / 14);
          const intensity = dy <= 0 ? 1 : depth;
          const idx = Math.max(0, Math.min(chars.length - 1, Math.floor(intensity * (chars.length - 1))));

          ctx.globalAlpha = dy <= 1 ? 0.82 : 0.34 * depth;
          ctx.fillStyle = "#fff";
          ctx.fillText(chars[idx], x * charW, y * charH);
        }
      }

      time += 0.02;
      rafId = window.requestAnimationFrame(draw);
    };

    const onVisibilityChange = () => {
      if (document.hidden) {
        running = false;
        window.cancelAnimationFrame(rafId);
      } else {
        if (running) return;
        running = true;
        draw();
      }
    };

    resize();
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", onVisibilityChange);

    draw();

    return () => {
      running = false;
      window.cancelAnimationFrame(rafId);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [isLandingPage]);

  // Don't render canvas at all if not on landing page
  if (!isLandingPage) return null;

  return <canvas ref={canvasRef} aria-hidden className="ascii-waves" />;
}
