"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";

type ActiveTab = "landing" | "discover" | "commit" | "creator" | "docs";

function getActiveTab(pathname: string, tabParam: string | null): ActiveTab {
  if (pathname.startsWith("/docs")) return "docs";
  if (pathname.startsWith("/creator")) return "creator";
  if (pathname.startsWith("/commit")) return "commit";

  const raw = (tabParam ?? "").toLowerCase();
  if (raw === "discover") return "discover";
  if (raw === "commit") return "commit";
  return "landing";
}

function Icon(props: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false" className="globalNavIcon">
      <path d={props.d} fill="currentColor" />
    </svg>
  );
}

export default function GlobalNavLinks() {
  const pathname = usePathname() ?? "/";
  const searchParams = useSearchParams();

  const active = getActiveTab(pathname, searchParams?.get("tab") ?? null);

  return (
    <nav className="globalNavLinks" aria-label="Global">
      <Link
        className={`globalNavIconBtn${active === "landing" ? " globalNavIconBtnActive" : ""}`}
        href="/"
        aria-current={active === "landing" ? "page" : undefined}
        aria-label="Home"
        title="Home"
      >
        <Icon d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" />
      </Link>
      <Link
        className={`globalNavIconBtn${active === "discover" ? " globalNavIconBtnActive" : ""}`}
        href="/?tab=discover"
        aria-current={active === "discover" ? "page" : undefined}
        aria-label="Discover"
        title="Discover"
      >
        <Icon d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
      </Link>
      <Link
        className={`globalNavIconBtn${active === "commit" ? " globalNavIconBtnActive" : ""}`}
        href="/?tab=commit"
        aria-current={active === "commit" ? "page" : undefined}
        aria-label="Create Commitment"
        title="Create Commitment"
      >
        <Icon d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
      </Link>
      <Link
        className={`globalNavIconBtn${active === "creator" ? " globalNavIconBtnActive" : ""}`}
        href="/creator"
        aria-current={active === "creator" ? "page" : undefined}
        aria-label="Creator Dashboard"
        title="Creator Dashboard"
      >
        <Icon d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
      </Link>
      <Link
        className={`globalNavIconBtn${active === "docs" ? " globalNavIconBtnActive" : ""}`}
        href="/docs/platform-overview"
        aria-current={active === "docs" ? "page" : undefined}
        aria-label="Documentation"
        title="Documentation"
      >
        <Icon d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z" />
      </Link>
      <a
        className="globalNavIconBtn"
        href="https://x.com/CommitToShip"
        target="_blank"
        rel="noreferrer noopener"
        aria-label="Twitter"
        title="Twitter"
      >
        <Icon d="M18.244 2H21l-6.219 7.108L22 22h-7.059l-5.524-7.72L3.445 22H0.687l6.657-7.606L0 2h7.238l4.99 7.014L18.244 2zm-1.236 18h1.528L6.402 3.93H4.76L17.008 20z" />
      </a>
      <WalletMultiButton />
    </nav>
  );
}
