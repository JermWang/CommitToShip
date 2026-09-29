"use client";

import { useCallback, useMemo, useRef } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import type { PublicKey, Transaction } from "@solana/web3.js";

/**
 * A `window.solana`-shaped facade over the wallet adapter.
 *
 * The launch flow, milestone dashboard and profile editor were written against Phantom's injected
 * `window.solana`. That only works for Phantom - Solflare/Backpack users (and anyone whose header wallet is not
 * the injected one) hit "Wallet provider not found". This bridge keeps those call sites unchanged while routing
 * everything through the same wallet the user connected in the header ("Select Wallet").
 */
export type SolanaProvider = {
  readonly publicKey: PublicKey | null;
  connect: () => Promise<{ publicKey: PublicKey }>;
  signMessage: (message: Uint8Array, encoding?: string) => Promise<{ signature: Uint8Array }>;
  signAndSendTransaction: (tx: Transaction) => Promise<{ signature: string }>;
  signTransaction: (tx: Transaction) => Promise<Transaction>;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function useSolanaProvider(): SolanaProvider {
  const wallet = useWallet();
  const { connection } = useConnection();
  const { visible, setVisible } = useWalletModal();

  // Async callbacks outlive renders; always read the freshest wallet state through a ref.
  const latest = useRef({ wallet, connection, visible });
  latest.current = { wallet, connection, visible };

  const ensureConnected = useCallback(async (): Promise<PublicKey> => {
    const isReady = () => latest.current.wallet.connected && latest.current.wallet.publicKey;
    if (isReady()) return latest.current.wallet.publicKey as PublicKey;

    // A wallet was already picked (e.g. remembered from a previous visit) - try to connect it directly first.
    if (latest.current.wallet.wallet && !latest.current.wallet.connecting) {
      try {
        await latest.current.wallet.connect();
      } catch {
        // fall through to the picker
      }
      for (let i = 0; i < 15 && !isReady(); i++) await sleep(200);
      if (isReady()) return latest.current.wallet.publicKey as PublicKey;
    }

    setVisible(true);

    const deadline = Date.now() + 2 * 60 * 1000;
    let sawModal = false;
    while (Date.now() < deadline) {
      await sleep(200);
      if (isReady()) {
        setVisible(false);
        return latest.current.wallet.publicKey as PublicKey;
      }
      if (latest.current.visible) sawModal = true;
      else if (sawModal && !latest.current.wallet.connecting) throw new Error("Wallet connection was cancelled");
    }
    throw new Error("Timed out waiting for wallet connection");
  }, [setVisible]);

  return useMemo<SolanaProvider>(
    () => ({
      get publicKey() {
        return latest.current.wallet.publicKey;
      },
      async connect() {
        const publicKey = await ensureConnected();
        return { publicKey };
      },
      async signMessage(message: Uint8Array) {
        await ensureConnected();
        const sign = latest.current.wallet.signMessage;
        if (!sign) throw new Error("This wallet can't sign messages. Please use Phantom, Solflare or Backpack.");
        const signature = await sign(message);
        return { signature };
      },
      async signAndSendTransaction(tx: Transaction) {
        await ensureConnected();
        const { wallet: w, connection: conn } = latest.current;
        const signature = await w.sendTransaction(tx, conn, { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 });
        return { signature };
      },
      async signTransaction(tx: Transaction) {
        await ensureConnected();
        const sign = latest.current.wallet.signTransaction;
        if (!sign) throw new Error("This wallet can't sign transactions.");
        return (await sign(tx)) as Transaction;
      },
    }),
    [ensureConnected]
  );
}
