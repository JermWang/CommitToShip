"use client";

import { useEffect, useMemo, useState } from "react";

const DEFAULT_BETA_START_ISO = "2026-01-06T00:00:00-08:00";

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function daysUntil(target: Date, now: Date): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  const t = startOfLocalDay(target).getTime();
  const n = startOfLocalDay(now).getTime();
  return Math.ceil((t - n) / msPerDay);
}

function msUntilNextLocalMidnight(now: Date): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return Math.max(500, next.getTime() - now.getTime());
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

export default function ClosedBetaNotice() {
  const betaStart = useMemo(() => {
    const raw = String(process.env.NEXT_PUBLIC_CLOSED_BETA_START_ISO ?? "").trim();
    const d = new Date(raw || DEFAULT_BETA_START_ISO);
    if (!Number.isFinite(d.getTime())) return new Date(DEFAULT_BETA_START_ISO);
    return d;
  }, []);

  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    if (typeof window === "undefined") return;

    let intervalId: number | null = null;

    setNow(new Date());

    const tick = () => setNow(new Date());
    const t1 = window.setTimeout(() => {
      tick();
      intervalId = window.setInterval(tick, 24 * 60 * 60 * 1000);
    }, msUntilNextLocalMidnight(new Date()));

    return () => {
      window.clearTimeout(t1);
      if (intervalId != null) window.clearInterval(intervalId);
    };
  }, []);

  const d = daysUntil(betaStart, now);
  const isBetaOpen = d <= 0;

  if (isBetaOpen) return null;

  const countdownLabel =
    d > 1
      ? `${d} days`
      : d === 1
        ? "1 day"
        : "Today";

  return (
    <div className="betaBlockerOverlay">
      <div className="betaBlockerModal">
        <div className="betaBlockerIcon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
        </div>
        
        <h2 className="betaBlockerTitle">Closed Beta Coming Soon</h2>
        
        <p className="betaBlockerText">
          We&apos;re putting the finishing touches on CommitToShip. The closed beta opens on:
        </p>
        
        <div className="betaBlockerDate">
          {formatDate(betaStart)}
        </div>
        
        <div className="betaBlockerCountdown">
          <div className="betaBlockerCountdownValue">{countdownLabel}</div>
          <div className="betaBlockerCountdownLabel">until launch</div>
        </div>
        
        <div className="betaBlockerDivider" />
        
        <p className="betaBlockerSubtext">
          In the meantime, explore the <strong>Discover</strong> tab to see how commitments work, or check out our flagship launch.
        </p>
        
        <div className="betaBlockerActions">
          <a href="/?tab=discover" className="betaBlockerBtn betaBlockerBtnPrimary">
            Explore Discover
          </a>
          <a href="https://x.com/committoship" target="_blank" rel="noopener noreferrer" className="betaBlockerBtn betaBlockerBtnSecondary">
            Follow for Updates
          </a>
        </div>
      </div>
    </div>
  );
}
