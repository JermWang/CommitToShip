import "./globals.css";
import "@solana/wallet-adapter-react-ui/styles.css";
import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import TokenContractBar from "./components/TokenContractBar";
import GlobalNavLinks from "./components/GlobalNavLinks";
import AsciiParticles from "./components/AsciiParticles";
import SolanaWalletProvider from "./components/SolanaWalletProvider";
import { ToastProvider } from "./components/ToastProvider";
import { SITE_DESCRIPTION, SITE_NAME, getSiteOrigin } from "./lib/siteConfig";

export const metadata: Metadata = {
  metadataBase: new URL(getSiteOrigin()),
  title: { default: SITE_NAME, template: `%s · ${SITE_NAME}` },
  description: SITE_DESCRIPTION,
  icons: {
    icon: [{ url: "/favicon.svg", type: "image/svg+xml" }],
  },
  openGraph: {
    title: SITE_NAME,
    siteName: SITE_NAME,
    description: SITE_DESCRIPTION,
    images: [
      {
        url: "/branding/SHIP-AND-COMMIT-PROMO-1.png",
        width: 1024,
        height: 576,
        alt: "Ship & Commit — Accountability infrastructure & milestone escrow",
      },
    ],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
    images: ["/branding/SHIP-AND-COMMIT-PROMO-1.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body data-skin="app">
        <AsciiParticles />
        <SolanaWalletProvider>
          <ToastProvider>
            <header className="globalNav">
              <div className="globalNavInner">
                <div className="globalNavLeft">
                  <Link className="globalNavBrand" href="/">
                    <span className="globalNavBrandMarkWrap">
                      <img className="globalNavBrandMark" src="/branding/white-logo.png" alt="Ship & Commit" />
                    </span>
                    <span className="globalNavBrandText">Ship &amp; Commit</span>
                  </Link>

                  <TokenContractBar />
                </div>

                <Suspense fallback={null}>
                  <GlobalNavLinks />
                </Suspense>
              </div>
            </header>

            {children}
          </ToastProvider>
        </SolanaWalletProvider>
      </body>
    </html>
  );
}
