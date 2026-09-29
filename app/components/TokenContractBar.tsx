"use client";

import { useState } from "react";

function shorten(addr: string): string {
  const a = addr.trim();
  if (a.length <= 16) return a;
  return `${a.slice(0, 6)}…${a.slice(-6)}`;
}

function tokenLabel(input: { symbol?: string; name?: string; mint?: string }): string {
  const sym = String(input.symbol ?? "").trim();
  if (sym) return sym.startsWith("$") ? sym : `$${sym}`;
  const name = String(input.name ?? "").trim();
  if (name) return name;
  const mint = String(input.mint ?? "").trim();
  return mint ? shorten(mint) : "Not set";
}

export default function TokenContractBar() {
  const addr = (process.env.NEXT_PUBLIC_TOKEN_CONTRACT_ADDRESS ?? "").trim();
  const symbol = (process.env.NEXT_PUBLIC_TOKEN_SYMBOL ?? "").trim();
  const name = (process.env.NEXT_PUBLIC_TOKEN_NAME ?? "").trim();

  const [copied, setCopied] = useState(false);

  const hasAddr = addr.length > 0;

  // No contract address configured (yet): render nothing rather than a "Not set" pill.
  if (!hasAddr) return null;

  async function onCopy() {
    try {
      if (!hasAddr) return;
      if (!window.isSecureContext || !navigator.clipboard?.writeText) {
        throw new Error("Clipboard access is not available in this context");
      }
      await navigator.clipboard.writeText(addr);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 900);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      className={`globalNavTokenCopy${copied ? " globalNavTokenCopyCopied" : ""}`}
      onClick={onCopy}
      aria-label="Copy contract address"
      aria-disabled={!hasAddr}
    >
      <span className="globalNavTokenLabel">Token</span>
      <span className="globalNavTokenAddr" title={hasAddr ? addr : ""}>{tokenLabel({ symbol, name, mint: hasAddr ? addr : "" })}</span>
      <span className="globalNavTokenHint">{hasAddr ? (copied ? "Copied" : "Copy") : "Set"}</span>
    </button>
  );
}
