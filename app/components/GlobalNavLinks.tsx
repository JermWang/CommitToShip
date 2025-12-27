"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

type ActiveTab = "landing" | "discover" | "commit";

function getActiveTab(pathname: string, tabParam: string | null): ActiveTab {
  if (pathname.startsWith("/commit")) return "commit";

  const raw = (tabParam ?? "").toLowerCase();
  if (raw === "discover") return "discover";
  if (raw === "commit") return "commit";
  return "landing";
}

function shorten(addr: string): string {
  const a = String(addr ?? "").trim();
  if (a.length <= 16) return a;
  return `${a.slice(0, 6)}…${a.slice(-6)}`;
}

function getSolanaProvider(): any {
  return (window as any)?.solana;
}

export default function GlobalNavLinks() {
  const pathname = usePathname() ?? "/";
  const searchParams = useSearchParams();

  const active = getActiveTab(pathname, searchParams?.get("tab") ?? null);

  const [walletPubkey, setWalletPubkey] = useState<string | null>(null);
  const [walletBusy, setWalletBusy] = useState<string | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);

  useEffect(() => {
    const provider = getSolanaProvider();
    if (provider?.isConnected && provider?.publicKey?.toBase58) {
      setWalletPubkey(provider.publicKey.toBase58());
    }

    const onConnect = () => {
      const pk = provider?.publicKey?.toBase58?.();
      if (pk) setWalletPubkey(String(pk));
    };

    const onDisconnect = () => {
      setWalletPubkey(null);
    };

    provider?.on?.("connect", onConnect);
    provider?.on?.("disconnect", onDisconnect);

    return () => {
      provider?.removeListener?.("connect", onConnect);
      provider?.removeListener?.("disconnect", onDisconnect);
    };
  }, []);

  async function onWalletClick() {
    setWalletError(null);

    const provider = getSolanaProvider();
    if (!provider?.connect) {
      setWalletError("Wallet provider not found");
      return;
    }

    if (walletPubkey) {
      setWalletBusy("disconnect");
      try {
        if (provider.disconnect) await provider.disconnect();
      } catch {
        // ignore
      } finally {
        setWalletPubkey(null);
        setWalletBusy(null);
      }
      return;
    }

    setWalletBusy("connect");
    try {
      const res = await provider.connect();
      const pk = (res?.publicKey ?? provider.publicKey)?.toBase58?.();
      if (!pk) throw new Error("Failed to read wallet public key");
      setWalletPubkey(String(pk));
    } catch (e) {
      setWalletError((e as Error).message);
    } finally {
      setWalletBusy(null);
    }
  }

  return (
    <nav className="globalNavLinks" aria-label="Global">
      <Link className={`globalNavLink${active === "landing" ? " globalNavLinkPrimary" : ""}`} href="/" aria-current={active === "landing" ? "page" : undefined}>
        Landing
      </Link>
      <Link
        className={`globalNavLink${active === "discover" ? " globalNavLinkPrimary" : ""}`}
        href="/?tab=discover"
        aria-current={active === "discover" ? "page" : undefined}
      >
        Discover
      </Link>
      <Link
        className={`globalNavLink${active === "commit" ? " globalNavLinkPrimary" : ""}`}
        href="/?tab=commit"
        aria-current={active === "commit" ? "page" : undefined}
      >
        Commit
      </Link>

      <button
        type="button"
        className="globalNavTokenCopy"
        onClick={onWalletClick}
        title={walletError ?? (walletPubkey ? "Disconnect wallet" : "Connect wallet")}
      >
        <span className="globalNavTokenLabel">Wallet</span>
        <span className="globalNavTokenAddr">
          {walletPubkey ? shorten(walletPubkey) : walletBusy === "connect" ? "Connecting…" : "Connect"}
        </span>
        <span className="globalNavTokenHint">{walletPubkey ? "Connected" : walletBusy ? "…" : ""}</span>
      </button>
    </nav>
  );
}
