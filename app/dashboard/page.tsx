"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Transaction } from "@solana/web3.js";
import { Buffer } from "buffer";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";

import { useToast } from "@/app/components/ToastProvider";
import styles from "./Dashboard.module.css";
import CreatorDashboardPage from "../creator/page";

type ClaimableAllResult = {
  ok: boolean;
  walletPubkey: string;
  amountRaw: string;
  uiAmount?: string;
  decimals?: number;
  commitments?: number;
  distributions?: number;
  breakdown?: Array<{
    commitmentId: string;
    amountRaw: string;
    uiAmount?: string;
    distributions: number;
    mintPubkey: string;
    tokenProgramPubkey: string;
    faucetOwnerPubkey: string;
    tokenMint?: string | null;
    statement?: string | null;
  }>;
};

type ProjectProfile = {
  tokenMint: string;
  name?: string | null;
  symbol?: string | null;
  imageUrl?: string | null;
};

type TokenBalanceRow = {
  mint: string;
  amountRaw?: string;
  decimals?: number;
  uiAmount?: number;
  error?: string;
};

type VoteHistoryRow = {
  commitmentId: string;
  milestoneId: string;
  vote: string;
  createdAtUnix: number;
  projectValueUsd: number;
  tokenMint?: string | null;
  statement?: string | null;
};

function shortWallet(pk: string): string {
  const s = String(pk ?? "").trim();
  if (!s) return "";
  if (s.length <= 10) return s;
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function formatUnix(unix: number): string {
  if (!Number.isFinite(unix) || unix <= 0) return "";
  return new Date(unix * 1000).toLocaleString("en-US", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export default function DashboardPage() {
  const toast = useToast();
  const { setVisible } = useWalletModal();
  const { publicKey, connected, signTransaction } = useWallet();

  const [tab, setTab] = useState<"holder" | "creator">("holder");

  const walletPubkey = useMemo(() => (publicKey ? publicKey.toBase58() : ""), [publicKey]);

  const [claimableBusy, setClaimableBusy] = useState(false);
  const [claimableError, setClaimableError] = useState<string | null>(null);
  const [claimable, setClaimable] = useState<ClaimableAllResult | null>(null);

  const [shipBusy, setShipBusy] = useState(false);
  const [shipError, setShipError] = useState<string | null>(null);
  const [shipUiAmount, setShipUiAmount] = useState<number>(0);

  const [profilesByMint, setProfilesByMint] = useState<Record<string, ProjectProfile>>({});
  const [balancesByMint, setBalancesByMint] = useState<Record<string, TokenBalanceRow>>({});

  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [history, setHistory] = useState<VoteHistoryRow[]>([]);

  const postJson = useCallback(async (url: string, body: any) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = typeof json?.error === "string" && json.error.trim().length ? json.error.trim() : `Request failed (${res.status})`;
      const hint = typeof json?.hint === "string" && json.hint.trim().length ? json.hint.trim() : "";
      throw new Error(hint ? `${err}\n${hint}` : err);
    }
    return json;
  }, []);

  const refreshClaimable = useCallback(async () => {
    if (!walletPubkey) return;
    setClaimableError(null);
    setClaimableBusy(true);
    try {
      const res = (await postJson("/api/vote-reward/claimable-all", { walletPubkey })) as ClaimableAllResult;
      setClaimable(res);

      const tokenMints = Array.from(
        new Set(
          (res?.breakdown ?? [])
            .map((b) => String(b.tokenMint ?? "").trim())
            .filter((s) => s.length > 0)
        )
      );

      if (tokenMints.length) {
        const prof = await postJson("/api/projects/batch", { tokenMints });
        const projects = Array.isArray(prof?.projects) ? (prof.projects as any[]) : [];
        const map: Record<string, ProjectProfile> = {};
        for (const p of projects) {
          const tm = String(p?.tokenMint ?? "").trim();
          if (!tm) continue;
          map[tm] = {
            tokenMint: tm,
            name: p?.name ?? null,
            symbol: p?.symbol ?? null,
            imageUrl: p?.imageUrl ?? null,
          };
        }
        setProfilesByMint(map);

        const balRes = await postJson("/api/wallet/token-balances", { walletPubkey, tokenMints });
        const balances = Array.isArray(balRes?.balances) ? (balRes.balances as TokenBalanceRow[]) : [];
        const bm: Record<string, TokenBalanceRow> = {};
        for (const b of balances) {
          const m = String(b?.mint ?? "");
          if (!m) continue;
          bm[m] = b;
        }
        setBalancesByMint(bm);
      } else {
        setProfilesByMint({});
        setBalancesByMint({});
      }
    } catch (e) {
      setClaimableError((e as Error).message);
    } finally {
      setClaimableBusy(false);
    }
  }, [postJson, walletPubkey]);

  const refreshShipBalance = useCallback(async () => {
    if (!walletPubkey) return;
    setShipError(null);
    setShipBusy(true);
    try {
      const res = await postJson("/api/wallet/ship-balance", { walletPubkey });
      const ui = Number(res?.uiAmount ?? 0);
      setShipUiAmount(Number.isFinite(ui) ? ui : 0);
    } catch (e) {
      setShipError((e as Error).message);
    } finally {
      setShipBusy(false);
    }
  }, [postJson, walletPubkey]);

  const refreshHistory = useCallback(async () => {
    if (!walletPubkey) return;
    setHistoryError(null);
    setHistoryBusy(true);
    try {
      const res = await postJson("/api/vote-reward/history", { walletPubkey, limit: 80 });
      const rows = Array.isArray(res?.rows) ? (res.rows as VoteHistoryRow[]) : [];
      setHistory(rows);
    } catch (e) {
      setHistoryError((e as Error).message);
    } finally {
      setHistoryBusy(false);
    }
  }, [postJson, walletPubkey]);

  useEffect(() => {
    if (!connected || !walletPubkey) {
      setClaimable(null);
      setShipUiAmount(0);
      setHistory([]);
      return;
    }

    void refreshClaimable();
    void refreshShipBalance();
    void refreshHistory();
  }, [connected, refreshClaimable, refreshHistory, refreshShipBalance, walletPubkey]);

  const claimAllGlobal = useCallback(async () => {
    if (!walletPubkey) throw new Error("Connect wallet first");
    if (!signTransaction) throw new Error("Wallet does not support transaction signing");

    const prepared = await postJson("/api/vote-reward/claim-all-global", {
      walletPubkey,
      action: "prepare",
    });

    const txBase64 = String(prepared?.transactionBase64 ?? "");
    if (!txBase64) throw new Error("Failed to prepare claim transaction");

    const tx = Transaction.from(Buffer.from(txBase64, "base64"));
    const signedTx = await signTransaction(tx);
    const signedTxBase64 = Buffer.from(signedTx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64");

    const finalized = await postJson("/api/vote-reward/claim-all-global", {
      walletPubkey,
      action: "finalize",
      signedTransactionBase64: signedTxBase64,
    });

    const sig = String(finalized?.signature ?? "").trim();
    toast({ kind: "success", message: sig ? `Claim submitted: ${sig}` : "Claim submitted" });

    void finalized;
    await refreshClaimable();
    await refreshShipBalance();
  }, [postJson, refreshClaimable, refreshShipBalance, signTransaction, toast, walletPubkey]);

  const holderRows = useMemo(() => {
    const b = claimable?.breakdown ?? [];
    return b;
  }, [claimable]);

  const totalClaimableUi = useMemo(() => String(claimable?.uiAmount ?? "0"), [claimable]);
  const totalDistributions = useMemo(() => Number(claimable?.distributions ?? 0), [claimable]);
  const totalCommitments = useMemo(() => Number(claimable?.commitments ?? 0), [claimable]);

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Dashboard</h1>
        <div className={styles.tabs} role="tablist" aria-label="Dashboard tabs">
          <button
            type="button"
            className={`${styles.tabBtn}${tab === "holder" ? " " + styles.tabBtnActive : ""}`}
            onClick={() => setTab("holder")}
            role="tab"
            aria-selected={tab === "holder"}
          >
            Holder
          </button>
          <button
            type="button"
            className={`${styles.tabBtn}${tab === "creator" ? " " + styles.tabBtnActive : ""}`}
            onClick={() => setTab("creator")}
            role="tab"
            aria-selected={tab === "creator"}
          >
            Creator
          </button>
        </div>
      </div>

      {tab === "creator" ? (
        <CreatorDashboardPage />
      ) : !connected ? (
        <div className={styles.card}>
          <div className={styles.cardHeader}>
            <div>
              <div className={styles.cardTitle}>Connect your wallet</div>
              <div className={styles.smallNote} style={{ marginTop: 4 }}>
                View your claimable $SHIP, holdings, and voting history.
              </div>
            </div>
            <div className={styles.actions}>
              <button type="button" className={styles.primaryBtn} onClick={() => setVisible(true)}>
                Connect
              </button>
            </div>
          </div>
          <div className={styles.cardBody}>
            <div className={styles.smallNote}>No wallet connected.</div>
          </div>
        </div>
      ) : (
        <>
          <div className={styles.summaryGrid}>
            <div className={styles.summaryCard}>
              <div className={styles.summaryLabel}>Wallet</div>
              <div className={styles.summaryValue} style={{ fontSize: 16 }}>
                {shortWallet(walletPubkey)}
              </div>
            </div>
            <div className={styles.summaryCard}>
              <div className={styles.summaryLabel}>$SHIP balance</div>
              <div className={`${styles.summaryValue} ${styles.summaryValueGreen}`}>
                {shipBusy ? "…" : shipUiAmount.toLocaleString("en-US", { maximumFractionDigits: 4 })}
              </div>
              {shipError ? <div className={styles.error}>{shipError}</div> : null}
            </div>
            <div className={styles.summaryCard}>
              <div className={styles.summaryLabel}>Claimable $SHIP</div>
              <div className={`${styles.summaryValue} ${styles.summaryValueBlue}`}>{claimableBusy ? "…" : totalClaimableUi}</div>
              {claimableError ? <div className={styles.error}>{claimableError}</div> : null}
            </div>
            <div className={styles.summaryCard}>
              <div className={styles.summaryLabel}>Distributions</div>
              <div className={`${styles.summaryValue} ${styles.summaryValueOrange}`}>{claimableBusy ? "…" : `${totalDistributions}`}</div>
              <div className={styles.smallNote}>{claimableBusy ? "" : `${totalCommitments} projects`}</div>
            </div>
          </div>

          <div className={`${styles.card} ${styles.cardAccentGreen}`}>
            <div className={styles.cardHeader}>
              <div>
                <div className={styles.cardTitle}>Global claim</div>
                <div className={styles.smallNote} style={{ marginTop: 4 }}>
                  Claim all eligible vote rewards across all projects.
                </div>
              </div>
              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.primaryBtn}
                  onClick={() =>
                    void claimAllGlobal().catch((e) => {
                      toast({ kind: "error", message: (e as Error).message });
                    })
                  }
                  disabled={claimableBusy || shipBusy}
                >
                  Sign & Claim All
                </button>
                <button
                  type="button"
                  className={styles.secondaryBtn}
                  onClick={() => {
                    void refreshClaimable();
                    void refreshShipBalance();
                    void refreshHistory();
                  }}
                  disabled={claimableBusy || shipBusy || historyBusy}
                >
                  Refresh
                </button>
              </div>
            </div>
            <div className={styles.cardBody}>
              <div className={styles.smallNote}>
                You can safely claim multiple times. Claims are idempotent per distribution.
              </div>
            </div>
          </div>

          <div className={`${styles.card} ${styles.cardAccentBlue}`}>
            <div className={styles.cardHeader}>
              <div>
                <div className={styles.cardTitle}>Claimable by project</div>
                <div className={styles.smallNote} style={{ marginTop: 4 }}>
                  {claimableBusy ? "Loading…" : holderRows.length ? "" : "No claimable rewards yet."}
                </div>
              </div>
            </div>
            <div className={styles.cardBody}>
              <div className={styles.list}>
                {holderRows.map((b) => {
                  const tokenMint = String(b.tokenMint ?? "").trim();
                  const profile = tokenMint ? profilesByMint[tokenMint] : null;
                  const bal = tokenMint ? balancesByMint[tokenMint] : null;
                  const name =
                    (profile?.name && String(profile.name).trim()) ||
                    (profile?.symbol && String(profile.symbol).trim()) ||
                    (b.statement && String(b.statement).trim()) ||
                    b.commitmentId;

                  const holdingUi = bal && typeof bal.uiAmount === "number" ? bal.uiAmount : null;

                  return (
                    <div key={b.commitmentId} className={styles.row}>
                      <div className={styles.rowMain}>
                        <div className={styles.rowTitle}>{name}</div>
                        <div className={styles.rowMeta}>
                          {holdingUi != null ? `Holding: ${holdingUi.toLocaleString("en-US", { maximumFractionDigits: 4 })}` : ""}
                          {holdingUi != null ? " · " : ""}
                          {b.distributions} distribution{b.distributions === 1 ? "" : "s"}
                        </div>
                      </div>
                      <div className={styles.rowRight}>
                        <div className={styles.amount}>{String(b.uiAmount ?? b.amountRaw)}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div className={`${styles.card} ${styles.cardAccentOrange}`}>
            <div className={styles.cardHeader}>
              <div>
                <div className={styles.cardTitle}>Voting history</div>
                <div className={styles.smallNote} style={{ marginTop: 4 }}>
                  {historyBusy ? "Loading…" : history.length ? "" : "No votes found."}
                </div>
              </div>
            </div>
            <div className={styles.cardBody}>
              {historyError ? <div className={styles.error}>{historyError}</div> : null}
              <div className={styles.list}>
                {history.slice(0, 40).map((h) => {
                  const tokenMint = String(h.tokenMint ?? "").trim();
                  const profile = tokenMint ? profilesByMint[tokenMint] : null;
                  const name =
                    (profile?.name && String(profile.name).trim()) ||
                    (profile?.symbol && String(profile.symbol).trim()) ||
                    (h.statement && String(h.statement).trim()) ||
                    h.commitmentId;

                  return (
                    <div key={`${h.commitmentId}:${h.milestoneId}:${h.createdAtUnix}`} className={styles.row}>
                      <div className={styles.rowMain}>
                        <div className={styles.rowTitle}>{name}</div>
                        <div className={styles.rowMeta}>
                          {String(h.vote)} · {formatUnix(Number(h.createdAtUnix))}
                        </div>
                      </div>
                      <div className={styles.rowRight}>
                        <div className={styles.amount}>{String(h.projectValueUsd ? Math.round(h.projectValueUsd).toLocaleString("en-US") : "")}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
