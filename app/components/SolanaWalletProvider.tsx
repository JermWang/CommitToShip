"use client";

import { ReactNode, useCallback, useMemo } from "react";
import { WalletAdapterNetwork, WalletError, WalletReadyState } from "@solana/wallet-adapter-base";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { BackpackWalletAdapter } from "@solana/wallet-adapter-backpack";

import { getClientRpcEndpoint } from "../lib/clientRpc";

export default function SolanaWalletProvider({ children }: { children: ReactNode }) {
  const network = useMemo<WalletAdapterNetwork>(() => {
    const raw = String(process.env.NEXT_PUBLIC_SOLANA_CLUSTER ?? "mainnet-beta").trim();
    if (raw === "devnet") return WalletAdapterNetwork.Devnet;
    if (raw === "testnet") return WalletAdapterNetwork.Testnet;
    return WalletAdapterNetwork.Mainnet;
  }, []);

  const endpoint = useMemo(() => getClientRpcEndpoint(), []);

  const wallets = useMemo(() => {
    return [new PhantomWalletAdapter(), new SolflareWalletAdapter({ network }), new BackpackWalletAdapter()];
  }, [network]);

  const onError = useCallback((error: WalletError) => {
    const anyErr: any = error as any;
    const details = {
      name: String((error as any)?.name ?? ""),
      message: String((error as any)?.message ?? ""),
      causeName: String(anyErr?.cause?.name ?? ""),
      causeMessage: String(anyErr?.cause?.message ?? ""),
      innerName: String(anyErr?.error?.name ?? ""),
      innerMessage: String(anyErr?.error?.message ?? ""),
      code: anyErr?.code,
    };
    console.error("[wallet] error", details, { cause: anyErr?.cause, inner: anyErr?.error }, error);
  }, []);

  const autoConnect = useCallback(async (adapter: any) => {
    try {
      const readyState: WalletReadyState | undefined = adapter?.readyState;
      if (readyState !== WalletReadyState.Installed && readyState !== WalletReadyState.Loadable) return false;

      await new Promise((r) => setTimeout(r, 0));
      if (typeof adapter?.autoConnect === "function") {
        await adapter.autoConnect();
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect={autoConnect} onError={onError}>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
