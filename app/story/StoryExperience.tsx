"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

import styles from "./story.module.css";
import { SCENE_COUNT, createStoryEngine } from "./engine";

type MockKind = "form" | "escrow" | "milestones" | "votes" | "split" | "cta" | "none";

type SceneDef = {
  id: string;
  eyebrow: string;
  title: string;
  body: string;
  chips?: string[];
  mock: MockKind;
  side: 1 | -1; // which side of the screen the glass card sits on (desktop)
};

const SCENES: SceneDef[] = [
  {
    id: "intro",
    eyebrow: "Ship & Commit",
    title: "Anyone can launch. Few ever ship.",
    body: "Ship & Commit is the accountability layer for token launches: creators lock their fees behind real milestones, and holders decide when they're earned.",
    mock: "none",
    side: 1,
  },
  {
    id: "launch",
    eyebrow: "01 — Launch",
    title: "Launch a token in a few clicks.",
    body: "Name it, drop in an image and approve one wallet transaction. Your token goes live on pump.fun, with fee-locking switched on from the very first trade.",
    chips: ["pump.fun", "One approval", "Auto-Lock"],
    mock: "form",
    side: -1,
  },
  {
    id: "lock",
    eyebrow: "02 — Lock",
    title: "Creator fees go into escrow.",
    body: "Fees flow into a dedicated on-chain escrow wallet instead of the creator's pocket. Nobody can quietly drain it, and anyone can verify the balance.",
    chips: ["On-chain", "Verifiable", "Non-custodial"],
    mock: "escrow",
    side: 1,
  },
  {
    id: "commit",
    eyebrow: "03 — Commit",
    title: "Commit to milestones.",
    body: "Set specific deliverables with deadlines, or market-cap goals that resolve automatically. Each milestone unlocks a share of the escrow, and nothing moves until it's earned.",
    chips: ["Deadlines", "Market-cap goals", "% of escrow"],
    mock: "milestones",
    side: -1,
  },
  {
    id: "vote",
    eyebrow: "04 — Verify",
    title: "Holders vote on every milestone.",
    body: "When the creator ships, token holders confirm it with signed, publicly verifiable votes. Real holders decide — not promises, not hype.",
    chips: ["Signed votes", "Holder-weighted", "Public record"],
    mock: "votes",
    side: 1,
  },
  {
    id: "payout",
    eyebrow: "05 — Release or forfeit",
    title: "Ship and get paid. Miss and it's redistributed.",
    body: "Approved milestones release their share to the creator. Missed deadlines forfeit it: half to the voters, the rest to buybacks and the rewards pool.",
    chips: ["Released on approval", "Forfeits go to holders"],
    mock: "split",
    side: -1,
  },
  {
    id: "cta",
    eyebrow: "Your turn",
    title: "Ready to ship?",
    body: "Launch your token, lock your fees and let your delivery speak for itself.",
    mock: "cta",
    side: 1,
  },
];

function Mock({ kind }: { kind: MockKind }) {
  if (kind === "form") {
    return (
      <div className={styles.mock}>
        <div className={styles.field}>
          <span>Coin name</span>
          <b>Ship It</b>
        </div>
        <div className={styles.field}>
          <span>Ticker</span>
          <b>$SHIPIT</b>
        </div>
        <div className={styles.toggleRow}>
          <span>Auto-Lock fees</span>
          <i className={styles.toggle} />
        </div>
        <div className={styles.mockBtn}>Launch token</div>
      </div>
    );
  }
  if (kind === "escrow") {
    return (
      <div className={styles.mock}>
        <div className={styles.mockHead}>
          <span>Escrow</span>
          <em className={styles.pill}>Locked</em>
        </div>
        <div className={styles.bigNum}>
          12.480 <small>SOL</small>
        </div>
        <div className={styles.track}>
          <div className={styles.fill} style={{ ["--w" as any]: "0.78" }} />
        </div>
        <div className={styles.mockFoot}>Released only when milestones are approved</div>
      </div>
    );
  }
  if (kind === "milestones") {
    const rows = [
      ["Ship v1 on mainnet", "30%"],
      ["Reach $1M market cap", "30%"],
      ["Publish audit report", "40%"],
    ];
    return (
      <div className={styles.mock}>
        {rows.map(([t, p], i) => (
          <div key={t} className={styles.row} style={{ ["--i" as any]: i }}>
            <span className={styles.check}>✓</span>
            <span className={styles.rowTitle}>{t}</span>
            <span className={styles.rowPct}>{p}</span>
          </div>
        ))}
      </div>
    );
  }
  if (kind === "votes") {
    return (
      <div className={styles.mock}>
        <div className={styles.voteRow}>
          <span>Approve</span>
          <div className={styles.track}>
            <div className={styles.fill} style={{ ["--w" as any]: "0.87" }} />
          </div>
          <b>87%</b>
        </div>
        <div className={styles.voteRow}>
          <span>Reject</span>
          <div className={styles.track}>
            <div className={styles.fill} style={{ ["--w" as any]: "0.13" }} />
          </div>
          <b>13%</b>
        </div>
        <div className={styles.mockFoot}>214 holders voted · all signatures verifiable</div>
      </div>
    );
  }
  if (kind === "split") {
    return (
      <div className={styles.mock}>
        <div className={styles.mockHead}>
          <span>If a milestone is missed</span>
        </div>
        <div className={styles.split}>
          <div style={{ flex: 50 }} className={styles.seg}>
            <b>50%</b>
            <span>Voters</span>
          </div>
          <div style={{ flex: 45 }} className={styles.seg}>
            <b>45%</b>
            <span>Buybacks</span>
          </div>
          <div style={{ flex: 5 }} className={styles.seg}>
            <b>5%</b>
          </div>
        </div>
        <div className={styles.mockFoot}>Approved? 100% of that milestone&apos;s share goes to the creator.</div>
      </div>
    );
  }
  return null;
}

export default function StoryExperience() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cardRefs = useRef<(HTMLElement | null)[]>([]);
  const pointer = useRef({ x: 0, y: 0 });
  const visible = useRef(true);
  const lastActive = useRef(0);

  const [active, setActive] = useState(0);
  const [staticMode, setStaticMode] = useState<boolean | null>(null);

  // Decide between the cinematic version and the simple stacked fallback.
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let webgl = false;
    try {
      const c = document.createElement("canvas");
      webgl = Boolean(c.getContext("webgl2") || c.getContext("webgl"));
    } catch {
      webgl = false;
    }
    setStaticMode(reduce || !webgl);
  }, []);

  const getProgress = useCallback(() => {
    const root = rootRef.current;
    if (!root) return 0;
    const rect = root.getBoundingClientRect();
    const total = rect.height - window.innerHeight;
    if (total <= 0) return 0;
    return Math.min(1, Math.max(0, -rect.top / total));
  }, []);

  useEffect(() => {
    if (staticMode !== false) return;
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return;

    const io = new IntersectionObserver(([e]) => (visible.current = e.isIntersecting), { threshold: 0 });
    io.observe(stage);

    const onMove = (e: PointerEvent) => {
      pointer.current = { x: (e.clientX / window.innerWidth) * 2 - 1, y: (e.clientY / window.innerHeight) * 2 - 1 };
      stage.style.setProperty("--mx", `${e.clientX}px`);
      stage.style.setProperty("--my", `${e.clientY}px`);
    };
    window.addEventListener("pointermove", onMove, { passive: true });

    let engine: ReturnType<typeof createStoryEngine> | null = null;
    try {
      engine = createStoryEngine({
        canvas,
        getProgress,
        getPointer: () => pointer.current,
        isVisible: () => visible.current,
        onFrame: (u) => {
          for (let i = 0; i < SCENE_COUNT; i++) {
            const el = cardRefs.current[i];
            if (!el) continue;
            const d = u - i;
            const ad = Math.abs(d);
            // hold fully visible near the centre, fade/rotate away on either side
            const v = Math.min(1, Math.max(0, 1 - (ad - 0.2) / 0.3));
            const vs = v * v * (3 - 2 * v);
            el.style.setProperty("--v", vs.toFixed(3));
            el.style.setProperty("--d", Math.max(-1, Math.min(1, d)).toFixed(3));
            el.style.pointerEvents = vs > 0.6 ? "auto" : "none";
            el.style.visibility = vs < 0.01 ? "hidden" : "visible";
          }
          const idx = Math.max(0, Math.min(SCENE_COUNT - 1, Math.round(u)));
          if (idx !== lastActive.current) {
            lastActive.current = idx;
            setActive(idx);
          }
        },
      });
    } catch {
      setStaticMode(true);
    }

    return () => {
      engine?.dispose();
      io.disconnect();
      window.removeEventListener("pointermove", onMove);
    };
  }, [staticMode, getProgress]);

  const jump = (i: number) => {
    const root = rootRef.current;
    if (!root) return;
    const top = root.getBoundingClientRect().top + window.scrollY;
    const total = root.offsetHeight - window.innerHeight;
    window.scrollTo({ top: top + (i / (SCENE_COUNT - 1)) * total, behavior: "smooth" });
  };

  const renderCard = (s: SceneDef, i: number, isStatic: boolean) => (
    <section
      key={s.id}
      ref={(el) => {
        cardRefs.current[i] = el;
      }}
      className={`${styles.card} ${s.mock === "cta" ? styles.cardCta : ""} ${isStatic ? styles.cardStatic : ""}`}
      style={{ ["--side" as any]: s.side }}
      data-side={s.side === 1 ? "right" : "left"}
      aria-label={s.title}
    >
      <div className={styles.eyebrow}>{s.eyebrow}</div>
      <h2 className={i === 0 ? styles.titleHero : styles.title}>{s.title}</h2>
      <p className={styles.body}>{s.body}</p>
      {s.chips ? (
        <div className={styles.chips}>
          {s.chips.map((c) => (
            <span key={c} className={styles.chip}>
              {c}
            </span>
          ))}
        </div>
      ) : null}
      <Mock kind={s.mock} />
      {s.mock === "cta" ? (
        <div className={styles.ctaRow}>
          <Link href="/?tab=commit" className={styles.ctaBtn}>
            Launch your token
            <span aria-hidden>→</span>
          </Link>
          <Link href="/?tab=discover" className={styles.ctaGhost}>
            Explore projects
          </Link>
        </div>
      ) : null}
    </section>
  );

  if (staticMode === true) {
    return (
      <div className={`${styles.root} ${styles.rootStatic} story-root`}>
        <div className={styles.staticList}>{SCENES.map((s, i) => renderCard(s, i, true))}</div>
      </div>
    );
  }

  return (
    <div ref={rootRef} className={`${styles.root} story-root`} style={{ height: `${SCENE_COUNT * 115}vh` }}>
      <div ref={stageRef} className={styles.stage}>
        <canvas ref={canvasRef} className={styles.ascii} aria-hidden />
        <div className={styles.vignette} aria-hidden />
        <div className={styles.grain} aria-hidden />

        {SCENES.map((s, i) => renderCard(s, i, false))}

        <nav className={styles.rail} aria-label="Story progress">
          {SCENES.map((s, i) => (
            <button key={s.id} type="button" className={`${styles.dot} ${i === active ? styles.dotActive : ""}`} onClick={() => jump(i)} aria-label={s.eyebrow}>
              <span className={styles.dotLabel}>{s.eyebrow.replace(/^\d+ — /, "")}</span>
            </button>
          ))}
        </nav>

        <div className={`${styles.hint} ${active === 0 ? styles.hintOn : ""}`} aria-hidden>
          <span>SCROLL</span>
          <i />
        </div>
      </div>
    </div>
  );
}
