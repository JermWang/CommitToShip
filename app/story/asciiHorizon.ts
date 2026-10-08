/**
 * The site's signature ASCII sea (same character ramp and crest/body treatment as the landing page's
 * AsciiWaves), drawn as a calm horizon under the story. Optional "stream" draws a thin column of 0/1
 * flowing toward a target point (used while fees flow into escrow).
 */

export type AsciiFrame = {
  time: number;
  /** 0..1 how high the sea sits (0 = bottom edge, 1 = mid-screen) */
  level: number;
  /** 0..1 overall opacity */
  alpha: number;
  /** horizontal drift driven by scroll */
  drift: number;
  /** 0..1 strength of the data stream, and where it flows to (viewport px) */
  stream: number;
  streamTo: { x: number; y: number } | null;
};

export type AsciiHorizon = { draw: (f: AsciiFrame) => void; resize: () => void };

const RAMP = [".", ":", "-", "=", "+", "*", "#", "%", "@", "0", "1"];

export function createAsciiHorizon(canvas: HTMLCanvasElement, color = "#fff"): AsciiHorizon {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");

  let w = 1;
  let h = 1;
  let cw = 10;
  let chh = 14;

  const resize = () => {
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    w = Math.max(1, canvas.clientWidth);
    h = Math.max(1, canvas.clientHeight);
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const mobile = w < 768;
    cw = mobile ? 12 : 10;
    chh = mobile ? 16 : 14;
    ctx.font = `${mobile ? 13 : 13}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`;
    ctx.textBaseline = "top";
  };

  const draw = (f: AsciiFrame) => {
    ctx.clearRect(0, 0, w, h);
    if (f.alpha <= 0.002) return;

    const cols = Math.ceil(w / cw) + 1;
    const rows = Math.ceil(h / chh);
    const baseRow = Math.round(rows * (0.93 - 0.32 * f.level));
    const offset = f.drift * 0.02;
    const phaseTick = Math.floor(f.time * 10);

    for (let x = 0; x < cols; x++) {
      const xx = x + offset * 40;
      const wave = Math.sin(xx * 0.12 + f.time) * 1.1 + Math.sin(xx * 0.04 + f.time * 0.6) * 2.2;
      const crest = baseRow + Math.round(wave * 2.2);

      for (let dy = -1; dy <= 13; dy++) {
        const y = crest + dy;
        if (y < 0 || y >= rows) continue;
        const sprinkle = (x * 7 + y * 11 + phaseTick) % 6;
        if (dy <= 1) {
          if (sprinkle === 5) continue;
        } else if (dy <= 6) {
          if (sprinkle >= 4) continue;
        } else if (sprinkle > 1) continue;

        const depth = Math.max(0, 1 - dy / 13);
        const idx = Math.max(0, Math.min(RAMP.length - 1, Math.floor((dy <= 0 ? 1 : depth) * (RAMP.length - 1))));
        ctx.globalAlpha = f.alpha * (dy <= 1 ? 0.78 : 0.3 * depth);
        ctx.fillStyle = color;
        ctx.fillText(RAMP[idx], x * cw, y * chh);
      }
    }

    // data stream: a narrow ribbon of 0/1 rising from the sea toward the target
    if (f.stream > 0.01 && f.streamTo) {
      const sx = w * 0.5;
      const sy = baseRow * chh;
      const tx = f.streamTo.x;
      const ty = f.streamTo.y;
      const n = 54;
      ctx.fillStyle = color;
      for (let i = 0; i < n; i++) {
        const ph = (f.time * 0.22 + i / n) % 1;
        const lane = ((i * 37) % 7) - 3;
        const curve = Math.sin(ph * Math.PI);
        const x = sx + (tx - sx) * ph + lane * 5 * (1 - ph);
        const y = sy + (ty - sy) * ph - curve * h * 0.08;
        ctx.globalAlpha = f.alpha * f.stream * Math.min(1, ph * 4) * (1 - ph) * 0.95;
        ctx.fillText((i + phaseTick) % 3 === 0 ? "1" : (i + phaseTick) % 3 === 1 ? "0" : ".", x, y);
      }
    }
    ctx.globalAlpha = 1;
  };

  resize();
  return { draw, resize };
}
