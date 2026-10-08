"use client";

import { useEffect, useRef } from "react";

export default function AsciiParticles() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let width = 0;
    let height = 0;
    let rafId = 0;
    let running = true;

    type Particle = { x: number; y: number; r: number; vx: number; vy: number; a: number };
    let particles: Particle[] = [];

    const resize = () => {
      const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      width = Math.floor(window.innerWidth);
      height = Math.floor(window.innerHeight);

      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const count = Math.max(24, Math.min(90, Math.floor((width * height) / 52000)));
      particles = new Array(count).fill(0).map(() => {
        const yMax = Math.max(1, height * 0.78);
        return {
          x: Math.random() * width,
          y: Math.random() * yMax,
          r: 0.6 + Math.random() * 1.1,
          vx: (Math.random() - 0.5) * 0.12,
          vy: 0.08 + Math.random() * 0.22,
          a: 0.05 + Math.random() * 0.10,
        };
      });
    };

    const draw = () => {
      if (!running) return;

      ctx.clearRect(0, 0, width, height);

      ctx.fillStyle = "#141414"; // ink dust on the cream backdrop
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        p.x += p.vx;
        p.y -= p.vy;

        if (p.x < -4) p.x = width + 4;
        if (p.x > width + 4) p.x = -4;

        const yMax = height * 0.78;
        if (p.y < -6) {
          p.y = yMax + 6;
          p.x = Math.random() * width;
        }

        ctx.globalAlpha = p.a;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }

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
  }, []);

  return <canvas ref={canvasRef} aria-hidden className="ascii-particles" />;
}
