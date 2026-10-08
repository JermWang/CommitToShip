"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";

import styles from "./story.module.css";
import { createEmblem, type EmblemPose } from "./emblem";
import { createAsciiHorizon } from "./asciiHorizon";

/* ------------------------------------------------------------------------------------------------
 * Chapters
 * ---------------------------------------------------------------------------------------------- */

type Chapter = {
  id: string;
  label: string;
  title: string;
  body: string;
  layout: "center" | "split";
  card?: () => ReactNode;
  /** ASCII sea for this chapter */
  sea: { level: number; alpha: number; stream?: number };
};

const css = (v: Record<string, string | number>) => v as CSSProperties;

const CHAPTERS: Chapter[] = [
  {
    id: "intro",
    label: "Ship & Commit",
    title: "Launch is easy.\nShipping is everything.",
    body: "The launchpad that locks creator fees behind milestones holders verify.",
    layout: "center",
    sea: { level: 0.04, alpha: 0.9 },
  },
  {
    id: "launch",
    label: "Launch",
    title: "Launch in one transaction.",
    body: "Name your token, add an image and approve once. It goes live on pump.fun with Auto-Lock already on.",
    layout: "split",
    sea: { level: 0, alpha: 0.5 },
    card: () => (
      <>
        <div className={styles.cardHead}>
          <span>New token</span>
          <span className={styles.mono}>pump.fun</span>
        </div>
        <div className={styles.tokenRow}>
          <img src="/branding/PFP.png" alt="" className={styles.tokenImg} />
          <div className={styles.tokenFields}>
            <div className={styles.input}>
              <span>Name</span>
              <b data-type="Ship It" />
            </div>
            <div className={styles.input}>
              <span>Ticker</span>
              <b data-type="$SHIPIT" />
            </div>
          </div>
        </div>
        <div className={styles.switchRow}>
          <span>Auto-Lock creator fees</span>
          <i className={styles.switch} />
        </div>
        <div className={styles.steps} data-steps="4">
          {["Validate", "Fund", "Launch", "Live"].map((s, i) => (
            <div key={s} className={styles.step} style={css({ "--k": i })}>
              <i />
              <span>{s}</span>
            </div>
          ))}
        </div>
      </>
    ),
  },
  {
    id: "lock",
    label: "Lock",
    title: "Every fee lands in escrow.",
    body: "Creator fees flow into a dedicated on-chain escrow instead of a wallet. Anyone can verify the balance; nobody can quietly drain it.",
    layout: "split",
    sea: { level: 0, alpha: 0.55, stream: 1 },
    card: () => (
      <>
        <div className={styles.cardHead}>
          <span>Escrow</span>
          <span className={styles.badge}>Locked</span>
        </div>
        <div className={styles.big}>
          <b data-count-to="12.48" data-decimals="2">0.00</b>
          <small>SOL</small>
        </div>
        <div className={`${styles.mono} ${styles.spark}`}>
          ▁▁▂▂▃▃▄▅▅▆▇
        </div>
        <div className={styles.kv}>
          <span>Address</span>
          <span className={styles.mono}>4mLR…3pmam</span>
        </div>
        <div className={styles.kv}>
          <span>Released</span>
          <span className={styles.mono}>0.00 SOL</span>
        </div>
      </>
    ),
  },
  {
    id: "commit",
    label: "Commit",
    title: "Commit to real milestones.",
    body: "Each milestone unlocks a share of the escrow — a deadline you deliver against, or a market-cap goal that verifies itself.",
    layout: "split",
    sea: { level: 0, alpha: 0.42 },
    card: () => (
      <>
        <div className={styles.cardHead}>
          <span>Milestones</span>
          <span className={styles.mono}>3 · 100%</span>
        </div>
        <div className={styles.timeline}>
          {[
            ["Ship v1 on mainnet", "30%", "Due Nov 14"],
            ["Reach $1M market cap", "30%", "Auto-verified"],
            ["Publish security audit", "40%", "Due Dec 20"],
          ].map(([t, p, m], i) => (
            <div key={t} className={styles.ms} style={css({ "--k": i })}>
              <i className={styles.msDot} />
              <div className={styles.msText}>
                <b>{t}</b>
                <span>{m}</span>
              </div>
              <span className={styles.msPct}>{p}</span>
            </div>
          ))}
        </div>
      </>
    ),
  },
  {
    id: "verify",
    label: "Verify",
    title: "Holders decide when it's earned.",
    body: "When a milestone ships, token holders review it and vote with signed, publicly verifiable messages.",
    layout: "split",
    sea: { level: 0, alpha: 0.42 },
    card: () => (
      <>
        <div className={styles.cardHead}>
          <span>Ship v1 on mainnet</span>
          <span className={styles.mono}>vote</span>
        </div>
        <div className={styles.voters} aria-hidden>
          {Array.from({ length: 48 }, (_, i) => (
            <i key={i} style={css({ "--k": i })} className={i % 8 === 5 ? styles.voterNo : undefined} />
          ))}
        </div>
        <div className={styles.bar}>
          <span>Approve</span>
          <div className={styles.track}>
            <div className={styles.fill} style={css({ "--w": 0.87 })} />
          </div>
          <b data-count-to="87" data-decimals="0">0</b>
          <b>%</b>
        </div>
        <div className={styles.sig}>
          <span className={styles.mono} data-type="sig 5Kq9…f2Tz · verified ✓" />
        </div>
      </>
    ),
  },
  {
    id: "outcome",
    label: "Release",
    title: "Ship and get paid.\nMiss, and holders do.",
    body: "Approved milestones release to the creator. Missed ones are forfeited: half to voters, the rest to $SHIP buybacks and rewards.",
    layout: "split",
    sea: { level: 0, alpha: 0.48 },
    card: () => (
      <>
        <div className={styles.outcome}>
          <div className={styles.outcomeRow}>
            <span className={styles.outcomeTag}>Approved</span>
            <span>Released to creator</span>
            <b className={styles.mono}>3.74 SOL</b>
          </div>
          <div className={styles.outcomeDivider} />
          <div className={styles.outcomeRow}>
            <span className={`${styles.outcomeTag} ${styles.outcomeTagGhost}`}>Missed</span>
            <span>Forfeited and redistributed</span>
          </div>
          <div className={styles.splitBar}>
            <div style={css({ flex: 50 })}>
              <b>50%</b>
              <span>Voters</span>
            </div>
            <div style={css({ flex: 45 })}>
              <b>45%</b>
              <span>Buybacks</span>
            </div>
            <div style={css({ flex: 5 })} title="Rewards" />
          </div>
        </div>
      </>
    ),
  },
  {
    id: "cta",
    label: "Your turn",
    title: "Ready to ship?",
    body: "Launch your token, lock your fees, and let your delivery speak for itself.",
    layout: "center",
    sea: { level: 0, alpha: 0.55 },
  },
];

const N = CHAPTERS.length;

/* Emblem choreography (x/y: fraction of half-viewport, size: fraction of viewport height) */
const POSES: EmblemPose[] = [
  { x: 0, y: 0.5, size: 0.27, rotY: 0, rotX: 0.04, glow: 1, maxW: 0.3 },
  // middle chapters: the emblem holds the centre column, between the copy and the glass card
  // each pose also says how the emblem travels into it and which glass icon it becomes (intro/CTA keep the logo)
  { x: 0, y: 0.02, size: 0.3, rotY: -0.32, rotX: 0.05, glow: 0.5, maxW: 0.15, move: "spin", shape: "rocket" },
  { x: 0, y: 0.02, size: 0.3, rotY: 0.34, rotX: -0.04, glow: 0.6, maxW: 0.15, move: "dial", land: "ripple", shape: "lock" },
  { x: 0, y: 0.02, size: 0.3, rotY: -0.28, rotX: 0.06, glow: 0.5, maxW: 0.15, move: "flip", shape: "flag" },
  { x: 0, y: 0.02, size: 0.3, rotY: 0.3, rotX: 0.02, glow: 0.5, maxW: 0.15, move: "inspect", shape: "shield" },
  { x: 0, y: 0.02, size: 0.3, rotY: -0.22, rotX: -0.03, glow: 0.6, maxW: 0.15, move: "double", land: "burst", shape: "unlock" },
  { x: 0, y: 0.5, size: 0.27, rotY: Math.PI * 2, rotX: 0.04, glow: 1, maxW: 0.3, move: "spin", land: "burst" },
];
const MOBILE_POSES: EmblemPose[] = POSES.map((p, i) => {
  const edge = i === 0 || i === N - 1;
  // intro/CTA: above the headline. Other chapters: in the gap between the copy and the docked glass card.
  return { ...p, x: 0, y: edge ? 0.47 : 0.1, size: edge ? 0.2 : 0.15, maxW: 0.7 };
});

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (x: number) => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};

/* ------------------------------------------------------------------------------------------------ */

export default function StoryExperience() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const glRef = useRef<HTMLCanvasElement | null>(null);
  const asciiRef = useRef<HTMLCanvasElement | null>(null);
  const chapterRefs = useRef<(HTMLElement | null)[]>([]);
  const meterRef = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState(0);
  const [mode, setMode] = useState<"pending" | "cinematic" | "static">("pending");

  // cream skin for the global nav while the story is on screen
  useEffect(() => {
    const prev = document.body.dataset.skin;
    document.body.dataset.skin = "story";
    return () => {
      document.body.dataset.skin = prev ?? "app";
    };
  }, []);

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let webgl = false;
    try {
      webgl = Boolean(document.createElement("canvas").getContext("webgl2"));
    } catch {
      webgl = false;
    }
    setMode(reduce || !webgl ? "static" : "cinematic");
  }, []);

  useEffect(() => {
    if (mode !== "cinematic") return;
    const root = rootRef.current;
    const stage = stageRef.current;
    const gl = glRef.current;
    const asciiCanvas = asciiRef.current;
    if (!root || !stage || !gl || !asciiCanvas) return;

    let emblem: ReturnType<typeof createEmblem> | null = null;
    try {
      emblem = createEmblem(gl, POSES, MOBILE_POSES);
    } catch {
      setMode("static");
      return;
    }
    const sea = createAsciiHorizon(asciiCanvas, "#0e0c09");

    const pointer = { x: 0, y: 0 };
    const target = { x: 0, y: 0 };
    const onMove = (e: PointerEvent) => {
      target.x = (e.clientX / window.innerWidth) * 2 - 1;
      target.y = (e.clientY / window.innerHeight) * 2 - 1;
    };
    window.addEventListener("pointermove", onMove, { passive: true });

    const onResize = () => {
      emblem?.resize();
      sea.resize();
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(stage);

    const readProgress = () => {
      const rect = root.getBoundingClientRect();
      const total = rect.height - window.innerHeight;
      return total > 0 ? clamp01(-rect.top / total) : 0;
    };

    let p = readProgress();
    let last = performance.now();
    let time = 0;
    let raf = 0;
    let lastActive = -1;

    const frame = () => {
      raf = requestAnimationFrame(frame);
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (document.hidden) return;
      time += dt;

      // inertia: the story glides toward the scroll position instead of snapping
      p += (readProgress() - p) * (1 - Math.exp(-dt * 7));
      pointer.x += (target.x - pointer.x) * (1 - Math.exp(-dt * 4));
      pointer.y += (target.y - pointer.y) * (1 - Math.exp(-dt * 4));
      const u = p * (N - 1);

      let seaLevel = 0;
      let seaAlpha = 0;
      let stream = 0;
      let streamTo: { x: number; y: number } | null = null;

      for (let i = 0; i < N; i++) {
        const el = chapterRefs.current[i];
        const d = u - i;
        const ad = Math.abs(d);
        const v = smooth(1 - (ad - 0.16) / 0.34);
        const s = clamp01((d + 0.46) / 0.42); // scrubbed micro-animations finish just before the chapter is centred
        const w = Math.max(0, 1 - ad); // weight for blending global layers

        seaLevel += CHAPTERS[i].sea.level * w;
        seaAlpha += CHAPTERS[i].sea.alpha * w;
        stream += (CHAPTERS[i].sea.stream ?? 0) * w * v;

        if (!el) continue;
        el.style.setProperty("--v", v.toFixed(4));
        el.style.setProperty("--d", Math.max(-1, Math.min(1, d)).toFixed(4));
        el.style.setProperty("--s", s.toFixed(4));
        el.style.visibility = v < 0.005 ? "hidden" : "visible";
        el.style.pointerEvents = v > 0.6 ? "auto" : "none";

        if (v > 0.005) {
          // scroll-scrubbed micro-interactions inside the cards
          el.querySelectorAll<HTMLElement>("[data-count-to]").forEach((n) => {
            const to = Number(n.dataset.countTo);
            const dec = Number(n.dataset.decimals ?? 0);
            n.textContent = (to * smooth(s)).toFixed(dec);
          });
          el.querySelectorAll<HTMLElement>("[data-type]").forEach((n) => {
            const full = n.dataset.type ?? "";
            const k = Math.round(full.length * smooth(s * 1.3));
            n.textContent = full.slice(0, k);
          });
          el.querySelectorAll<HTMLElement>("[data-steps]").forEach((n) => {
            const steps = Number(n.dataset.steps);
            n.dataset.at = String(Math.min(steps, Math.floor(s * (steps + 0.6))));
          });
          if (CHAPTERS[i].id === "lock" && v > 0.2) {
            const card = el.querySelector<HTMLElement>(`.${styles.card}`);
            if (card) {
              const r = card.getBoundingClientRect();
              streamTo = { x: r.left + r.width * 0.5, y: r.top + r.height * 0.42 };
            }
          }
        }
      }

      const idx = Math.max(0, Math.min(N - 1, Math.round(u)));
      if (idx !== lastActive) {
        lastActive = idx;
        setActive(idx);
      }
      meterRef.current?.style.setProperty("--p", p.toFixed(4));

      // ink on cream reads stronger than white on black: keep the sea quiet
      sea.draw({ time, level: seaLevel, alpha: Math.min(1, seaAlpha * 1.05), drift: u * 60, stream, streamTo });
      emblem?.render(u, time, pointer);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("pointermove", onMove);
      emblem?.dispose();
    };
  }, [mode]);

  const jumpTo = (i: number) => {
    const root = rootRef.current;
    if (!root) return;
    const top = root.getBoundingClientRect().top + window.scrollY;
    window.scrollTo({ top: top + (i / (N - 1)) * (root.offsetHeight - window.innerHeight), behavior: "smooth" });
  };

  const titleWords = (title: string) =>
    title.split("\n").map((line, li) => (
      <span key={li} className={styles.line}>
        {line.split(" ").map((word, wi) => (
          <span key={wi} className={styles.word} style={css({ "--wi": li * 4 + wi })}>
            {word}&nbsp;
          </span>
        ))}
      </span>
    ));

  const renderChapter = (c: Chapter, i: number, isStatic: boolean) => {
    const isCta = c.id === "cta";
    const isIntro = c.id === "intro";
    return (
      <section
        key={c.id}
        ref={(el) => {
          chapterRefs.current[i] = el;
        }}
        className={`${styles.chapter} ${c.layout === "center" ? styles.center : styles.split} ${isStatic ? styles.static : styles["enter_" + c.id] ?? ""}`}
        aria-label={c.title.replace("\n", " ")}
      >
        <div className={styles.copy}>
          <div className={styles.label}>
            {i > 0 && !isCta ? <span className={styles.num}>{String(i).padStart(2, "0")}</span> : null}
            {c.label}
          </div>
          {isIntro ? <h1 className={styles.hero}>{titleWords(c.title)}</h1> : <h2 className={isCta ? styles.hero : styles.title}>{titleWords(c.title)}</h2>}
          <p className={styles.body}>{c.body}</p>
          {isCta ? (
            <div className={styles.ctaRow}>
              <Link href="/?tab=commit" className={styles.cta}>
                Launch your token
                <span aria-hidden className={styles.ctaArrow}>
                  →
                </span>
              </Link>
              <Link href="/?tab=discover" className={styles.ghost}>
                Explore projects
              </Link>
            </div>
          ) : null}
          {isIntro && !isStatic ? (
            <div className={styles.scrollCue} aria-hidden>
              <span>Scroll</span>
              <i />
            </div>
          ) : null}
        </div>
        {c.card ? (
          <div className={styles.cardWrap}>
            <div className={`${styles.card} ${styles["card_" + c.id] ?? ""}`}>{c.card()}</div>
          </div>
        ) : null}
      </section>
    );
  };

  if (mode === "static") {
    return (
      <div className={`${styles.root} ${styles.rootStatic}`}>
        <img src="/branding/black-logo.png" alt="" className={styles.staticLogo} />
        {CHAPTERS.map((c, i) => renderChapter(c, i, true))}
      </div>
    );
  }

  return (
    <div ref={rootRef} className={styles.root} style={{ height: `${N * 140}vh` }}>
      <div ref={stageRef} className={styles.stage}>
        {/* the glass scene renders its own studio backdrop; the ASCII sea draws on top of it */}
        <canvas ref={glRef} className={`${styles.layer} ${styles.gl}`} aria-hidden />
        <canvas ref={asciiRef} className={`${styles.layer} ${styles.sea}`} aria-hidden />
        <div className={styles.vignette} aria-hidden />

        {mode === "cinematic" ? CHAPTERS.map((c, i) => renderChapter(c, i, false)) : null}

        <nav className={styles.chapters} aria-label="Chapters">
          {CHAPTERS.map((c, i) => (
            <button key={c.id} type="button" onClick={() => jumpTo(i)} className={`${styles.chip} ${i === active ? styles.chipOn : ""}`} aria-current={i === active ? "step" : undefined}>
              <span>{c.label}</span>
            </button>
          ))}
        </nav>
        <div ref={meterRef} className={styles.meter} aria-hidden>
          <i />
        </div>
      </div>
    </div>
  );
}
