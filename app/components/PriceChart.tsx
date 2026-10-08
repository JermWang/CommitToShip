"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Props = {
  tokenMint: string;
  chain?: "solana";
  height?: number;
  theme?: "dark" | "light";
  embed?: boolean;
};

type DexScreenerPair = {
  chainId?: string;
  dexId?: string;
  url?: string;
  pairAddress?: string;
  liquidity?: { usd?: number };
};

function pickBestPair(pairs: DexScreenerPair[], chain: string): DexScreenerPair | null {
  const filtered = pairs.filter((p) => String(p?.chainId ?? "").toLowerCase() === chain.toLowerCase());
  if (!filtered.length) return null;

  let best: DexScreenerPair | null = null;
  let bestUsd = -1;
  for (const p of filtered) {
    const usd = Number(p?.liquidity?.usd ?? 0);
    if (Number.isFinite(usd) && usd > bestUsd) {
      bestUsd = usd;
      best = p;
    }
  }
  return best ?? filtered[0] ?? null;
}

export default function PriceChart({ tokenMint, chain = "solana", height = 400, theme = "light", embed: embedProp = true }: Props) {
  const [pair, setPair] = useState<DexScreenerPair | null>(null);
  const [pairLoading, setPairLoading] = useState(false);
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [hasError, setHasError] = useState(false);
  const iframeLoadedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!tokenMint) return;
      setPairLoading(true);
      try {
        const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(tokenMint)}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`DexScreener request failed (${res.status})`);
        const json = (await res.json().catch(() => null)) as any;
        const pairs = Array.isArray(json?.pairs) ? (json.pairs as DexScreenerPair[]) : [];
        const best = pickBestPair(pairs, chain);
        if (cancelled) return;
        setPair(best);
      } catch {
        if (cancelled) return;
        setPair(null);
      } finally {
        if (cancelled) return;
        setPairLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [tokenMint, chain]);

  const viewDexUrl = useMemo(() => {
    const pairAddress = String((pair as any)?.pairAddress ?? "").trim();
    const id = pairAddress || tokenMint;
    return `https://dexscreener.com/${encodeURIComponent(chain)}/${encodeURIComponent(id)}`;
  }, [pair, tokenMint, chain]);

  const embedSrc = useMemo(() => {
    const pairAddress = String((pair as any)?.pairAddress ?? "").trim();
    const id = pairAddress || String(tokenMint ?? "").trim();
    if (!id) return "";
    const themeParam = theme === "light" ? "light" : "dark";
    return `https://dexscreener.com/${encodeURIComponent(chain)}/${encodeURIComponent(id)}?embed=1&theme=${themeParam}&info=0`;
  }, [pair, chain, theme, tokenMint]);

  const embed = embedProp;

  useEffect(() => {
    if (!embed) return;
    setIframeLoaded(false);
    setHasError(false);
    iframeLoadedRef.current = false;
    if (!embedSrc) return;

    const t = window.setTimeout(() => {
      if (!iframeLoadedRef.current) setHasError(true);
    }, 15000);

    return () => {
      window.clearTimeout(t);
    };
  }, [embed, embedSrc]);

  if (!tokenMint) return null;

  return (
    <div className="birdeyeChartWrap">
      {embed ? (
        <>
          {!iframeLoaded && !hasError && (
            <div className="birdeyeChartLoading">
              <div className="birdeyeChartSpinner" />
              <span>{pairLoading ? "Finding market…" : "Loading chart..."}</span>
            </div>
          )}

          {hasError || !embedSrc ? (
            <div className="birdeyeChartError">
              <span>Chart unavailable</span>
              <a href={viewDexUrl} target="_blank" rel="noopener noreferrer" className="birdeyeChartLink">
                View on DexScreener →
              </a>
            </div>
          ) : null}

          {embedSrc ? (
            <iframe
              key={embedSrc}
              src={embedSrc}
              width="100%"
              height={height}
              frameBorder="0"
              allowFullScreen
              style={{
                display: hasError ? "none" : "block",
                opacity: iframeLoaded ? 1 : 0,
                transition: "opacity 0.3s ease",
                borderRadius: 12,
              }}
              onLoad={() => {
                iframeLoadedRef.current = true;
                setIframeLoaded(true);
                setHasError(false);
              }}
              onError={() => {
                iframeLoadedRef.current = false;
                setIframeLoaded(false);
                setHasError(true);
              }}
            />
          ) : null}
        </>
      ) : (
        <div className="birdeyeChartLoading" style={{ position: "relative" }}>
          <div className="birdeyeChartSpinner" style={{ opacity: pairLoading ? 1 : 0 }} />
          <span style={{ textAlign: "center", maxWidth: 520 }}>
            {pairLoading ? "Finding market…" : "Open the live chart on DexScreener."}
          </span>
          <a href={viewDexUrl} target="_blank" rel="noopener noreferrer" className="birdeyeChartLink">
            View on DexScreener →
          </a>
        </div>
      )}
    </div>
  );
}
