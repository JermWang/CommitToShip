"use client";

import { Transaction } from "@solana/web3.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import bs58 from "bs58";
import styles from "./CommitDashboard.module.css";

type RewardMilestoneStatus = "locked" | "claimable" | "released";

type RewardMilestone = {
  id: string;
  title: string;
  unlockLamports: number;
  status: RewardMilestoneStatus;
  completedAtUnix?: number;
  claimableAtUnix?: number;
  becameClaimableAtUnix?: number;
  releasedAtUnix?: number;
  releasedTxSig?: string;
};

type RewardMilestoneApprovalCounts = Record<string, number>;

type Props = {
  id: string;
  kind: "personal" | "creator_reward";
  escrowPubkey: string;
  destinationOnFail: string;
  authority: string;
  statement?: string | null;
  status: string;
  canMarkSuccess: boolean;
  canMarkFailure: boolean;
  explorerUrl: string;

  creatorPubkey?: string | null;
  tokenMint?: string | null;
  milestones?: RewardMilestone[];
  approvalCounts?: RewardMilestoneApprovalCounts;
  approvalThreshold?: number;
  totalFundedLamports?: number;
  unlockedLamports?: number;
  balanceLamports?: number;
  nowUnix?: number;
};

async function readJsonSafe(res: Response): Promise<any> {
  const contentType = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (!text.trim().length) return {};
  if (contentType.toLowerCase().includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      return { error: text };
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

async function adminPost(path: string): Promise<any> {
  const res = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    credentials: "include",
  });
  const json = await readJsonSafe(res);
  if (!res.ok) throw new Error(json?.error ?? `Request failed (${res.status})`);
  return json;
}

async function jsonPost(path: string, body: unknown): Promise<any> {
  const res = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    credentials: "include",
    body: JSON.stringify(body ?? {}),
  });
  const json = await readJsonSafe(res);
  if (!res.ok) throw new Error(json?.error ?? `Request failed (${res.status})`);
  return json;
}

function fmtSol(lamports: number): string {
  const sol = lamports / 1_000_000_000;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(sol);
}

function unixToLocal(unix: number): string {
  return new Date(unix * 1000).toLocaleString();
}

function completionMessage(commitmentId: string, milestoneId: string): string {
  return `Commit To Ship\nMilestone Completion\nCommitment: ${commitmentId}\nMilestone: ${milestoneId}`;
}

function signalMessage(commitmentId: string, milestoneId: string): string {
  return `Commit To Ship\nMilestone Approval Signal\nCommitment: ${commitmentId}\nMilestone: ${milestoneId}`;
}

export default function CommitDashboardClient(props: Props) {
  const { escrowPubkey, explorerUrl, id, canMarkFailure, canMarkSuccess, kind } = props;

  const [copied, setCopied] = useState<null | "escrow" | "id">(null);
  const [adminWalletPubkey, setAdminWalletPubkey] = useState<string | null>(null);
  const [adminAuthBusy, setAdminAuthBusy] = useState<string | null>(null);
  const [adminAuthError, setAdminAuthError] = useState<string | null>(null);
  const [adminBusy, setAdminBusy] = useState<string | null>(null);
  const [adminError, setAdminError] = useState<string | null>(null);

  const [pumpCreatorPubkeyInput, setPumpCreatorPubkeyInput] = useState<string>(String(props.creatorPubkey ?? ""));
  const [pumpBusy, setPumpBusy] = useState<string | null>(null);
  const [pumpError, setPumpError] = useState<string | null>(null);
  const [pumpStatus, setPumpStatus] = useState<any>(null);
  const [pumpClaimResult, setPumpClaimResult] = useState<any>(null);
  const [pumpWalletPubkey, setPumpWalletPubkey] = useState<string | null>(null);

  const [creatorBusy, setCreatorBusy] = useState<string | null>(null);
  const [creatorError, setCreatorError] = useState<string | null>(null);
  const [signatureInput, setSignatureInput] = useState<Record<string, string>>({});

  const [signalSignerPubkey, setSignalSignerPubkey] = useState("");
  const [signalBusy, setSignalBusy] = useState<string | null>(null);
  const [signalError, setSignalError] = useState<string | null>(null);
  const [signalSignatureInput, setSignalSignatureInput] = useState<Record<string, string>>({});

  const [holderWalletPubkey, setHolderWalletPubkey] = useState<string | null>(null);
  const [holderBusy, setHolderBusy] = useState<string | null>(null);

  const canAdminAct = useMemo(() => Boolean(adminWalletPubkey) && adminBusy == null, [adminWalletPubkey, adminBusy]);

  async function copy(text: string, which: "escrow" | "id") {
    try {
      if (!window.isSecureContext || !navigator.clipboard?.writeText) {
        throw new Error("Clipboard access is not available in this context");
      }
      await navigator.clipboard.writeText(text);
      setCopied(which);
      window.setTimeout(() => setCopied(null), 900);
    } catch (e) {
      setAdminError((e as Error).message);
    }
  }

  async function markMilestoneComplete(milestoneId: string) {
    setCreatorError(null);
    setCreatorBusy(`complete:${milestoneId}`);
    try {
      const message = completionMessage(id, milestoneId);
      const signature = (signatureInput[milestoneId] ?? "").trim();
      await jsonPost(`/api/commitments/${id}/milestones/${milestoneId}/complete`, { message, signature });
      window.location.reload();
    } catch (e) {
      setCreatorError((e as Error).message);
    } finally {
      setCreatorBusy(null);
    }
  }

  function getSolanaProvider(): any {
    return (window as any)?.solana;
  }

  async function connectPumpCreatorWallet() {
    setPumpError(null);
    setPumpBusy("connect");
    try {
      const provider = getSolanaProvider();
      if (!provider?.connect) throw new Error("Wallet provider not found");
      const res = await provider.connect();
      const pk = (res?.publicKey ?? provider.publicKey)?.toBase58?.();
      if (!pk) throw new Error("Failed to read wallet public key");
      setPumpWalletPubkey(pk);
      if (!pumpCreatorPubkeyInput.trim()) {
        setPumpCreatorPubkeyInput(pk);
      }
    } catch (e) {
      setPumpError((e as Error).message);
    } finally {
      setPumpBusy(null);
    }
  }

  function expectedPumpClaimMessage(input: { creatorPubkey: string; timestampUnix: number }): string {
    return `Commit To Ship\nPump.fun Claim\nCreator: ${input.creatorPubkey}\nTimestamp: ${input.timestampUnix}`;
  }

  function base64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function pumpSignAndClaimFees() {
    setPumpError(null);
    setPumpBusy("claim");
    try {
      const provider = getSolanaProvider();
      if (!provider?.publicKey) throw new Error("Connect wallet first");
      if (!provider.signMessage) throw new Error("Wallet does not support message signing");

      const creatorPubkey = pumpCreatorPubkeyInput.trim();
      if (!creatorPubkey) throw new Error("Creator wallet required");

      const connected = provider.publicKey.toBase58();
      setPumpWalletPubkey(connected);
      if (connected !== creatorPubkey) {
        throw new Error("Connected wallet must match creator wallet to claim");
      }

      const timestampUnix = Math.floor(Date.now() / 1000);
      const message = expectedPumpClaimMessage({ creatorPubkey, timestampUnix });
      const signed = await provider.signMessage(new TextEncoder().encode(message), "utf8");
      const signatureBytes: Uint8Array = signed?.signature ?? signed;
      const signatureB58 = bs58.encode(signatureBytes);

      const res = await jsonPost("/api/pumpfun/claim", {
        creatorPubkey,
        timestampUnix,
        signatureB58,
      });

      const txBase64 = String(res?.txBase64 ?? "");
      if (!txBase64) throw new Error("Server did not return a transaction");

      const tx = Transaction.from(base64ToBytes(txBase64));

      if (!provider.signAndSendTransaction) {
        throw new Error("Wallet does not support signAndSendTransaction");
      }

      const sent = await provider.signAndSendTransaction(tx);
      const sig = String(sent?.signature ?? sent);

      setPumpClaimResult({ ...res, signature: sig });
      setPumpStatus({
        ok: true,
        nowUnix: res.nowUnix,
        creator: res.creator,
        creatorVault: res.creatorVault,
        vaultBalanceLamports: res.vaultBalanceLamports,
        rentExemptMinLamports: res.rentExemptMinLamports,
        claimableLamports: 0,
      });
    } catch (e) {
      setPumpError((e as Error).message);
    } finally {
      setPumpBusy(null);
    }
  }

  const refreshAdminSession = useCallback(async () => {
    const res = await fetch("/api/admin/me", { cache: "no-store", credentials: "include" });
    const json = await readJsonSafe(res);
    if (!res.ok) throw new Error(json?.error ?? `Request failed (${res.status})`);
    const wallet = typeof json?.walletPubkey === "string" && json.walletPubkey.trim().length ? json.walletPubkey.trim() : null;
    setAdminWalletPubkey(wallet);
  }, []);

  useEffect(() => {
    refreshAdminSession().catch(() => null);
  }, [refreshAdminSession]);

  async function pumpCheckStatus() {
    setPumpError(null);
    setPumpClaimResult(null);
    setPumpBusy("check");
    try {
      const creatorPubkey = pumpCreatorPubkeyInput.trim();
      if (!creatorPubkey) throw new Error("Creator wallet required");
      const res = await jsonPost("/api/pumpfun/status", { creatorPubkey });
      setPumpStatus(res);
    } catch (e) {
      setPumpError((e as Error).message);
    } finally {
      setPumpBusy(null);
    }
  }

  async function pumpClaimFees() {
    await pumpSignAndClaimFees();
  }

  async function adminSignIn() {
    setAdminAuthError(null);
    setAdminAuthBusy("signin");
    try {
      const provider = getSolanaProvider();
      if (!provider?.connect) throw new Error("Wallet provider not found");
      const connectRes = await provider.connect();
      const pk = (connectRes?.publicKey ?? provider.publicKey)?.toBase58?.();
      if (!pk) throw new Error("Failed to read wallet public key");
      if (!provider.signMessage) throw new Error("Wallet does not support message signing");

      const nonceRes = await jsonPost("/api/admin/nonce", { walletPubkey: pk });
      const message = String(nonceRes?.message ?? "");
      const nonce = String(nonceRes?.nonce ?? "");
      const walletPubkey = String(nonceRes?.walletPubkey ?? "");
      if (!message || !nonce || !walletPubkey) throw new Error("Failed to start admin sign-in");

      const signed = await provider.signMessage(new TextEncoder().encode(message), "utf8");
      const signatureBytes: Uint8Array = signed?.signature ?? signed;
      const signatureB58 = bs58.encode(signatureBytes);

      await jsonPost("/api/admin/login", { walletPubkey, nonce, signatureB58 });
      await refreshAdminSession();
    } catch (e) {
      setAdminAuthError((e as Error).message);
    } finally {
      setAdminAuthBusy(null);
    }
  }

  async function adminSignOut() {
    setAdminAuthError(null);
    setAdminAuthBusy("signout");
    try {
      await jsonPost("/api/admin/logout", {});
      setAdminWalletPubkey(null);
    } catch (e) {
      setAdminAuthError((e as Error).message);
    } finally {
      setAdminAuthBusy(null);
    }
  }

  async function connectHolderWallet() {
    setSignalError(null);
    setHolderBusy("connect");
    try {
      const provider = getSolanaProvider();
      if (!provider?.connect) throw new Error("Wallet provider not found");
      const res = await provider.connect();
      const pk = (res?.publicKey ?? provider.publicKey)?.toBase58?.();
      if (!pk) throw new Error("Failed to read wallet public key");
      setHolderWalletPubkey(pk);
      setSignalSignerPubkey(pk);
    } catch (e) {
      setSignalError((e as Error).message);
    } finally {
      setHolderBusy(null);
    }
  }

  async function signalMilestone(milestoneId: string, override?: { signerPubkey: string; signature: string }) {
    setSignalError(null);
    setSignalBusy(`signal:${milestoneId}`);
    try {
      const signerPubkey = (override?.signerPubkey ?? signalSignerPubkey).trim();
      const message = signalMessage(id, milestoneId);
      const signature = (override?.signature ?? signalSignatureInput[milestoneId] ?? "").trim();
      await jsonPost(`/api/commitments/${id}/milestones/${milestoneId}/signal`, { signerPubkey, message, signature });
      window.location.reload();
    } catch (e) {
      setSignalError((e as Error).message);
    } finally {
      setSignalBusy(null);
    }
  }

  async function signAndSignalMilestone(milestoneId: string) {
    setSignalError(null);
    setHolderBusy(`sign:${milestoneId}`);
    try {
      const provider = getSolanaProvider();
      if (!provider?.publicKey) throw new Error("Connect wallet first");
      if (!provider.signMessage) throw new Error("Wallet does not support message signing");

      const signerPubkey = provider.publicKey.toBase58();
      const message = signalMessage(id, milestoneId);
      const signed = await provider.signMessage(new TextEncoder().encode(message), "utf8");
      const signatureBytes: Uint8Array = signed?.signature ?? signed;
      const signature = bs58.encode(signatureBytes);

      setHolderWalletPubkey(signerPubkey);
      setSignalSignerPubkey(signerPubkey);
      setSignalSignatureInput((prev) => ({ ...prev, [milestoneId]: signature }));

      await signalMilestone(milestoneId, { signerPubkey, signature });
    } catch (e) {
      setSignalError((e as Error).message);
    } finally {
      setHolderBusy(null);
    }
  }

  async function releaseMilestone(milestoneId: string) {
    setAdminError(null);
    setAdminBusy(`release:${milestoneId}`);
    try {
      await adminPost(`/api/commitments/${id}/milestones/${milestoneId}/release`);
      window.location.reload();
    } catch (e) {
      setAdminError((e as Error).message);
    } finally {
      setAdminBusy(null);
    }
  }

  async function resolve(kind: "success" | "failure") {
    setAdminError(null);
    setAdminBusy(kind);
    try {
      await adminPost(`/api/commitments/${id}/${kind}`);
      window.location.reload();
    } catch (e) {
      setAdminError((e as Error).message);
    } finally {
      setAdminBusy(null);
    }
  }

  return (
    <div className={styles.lower}>
      <div className={styles.primaryFlow}>
        {kind === "creator_reward" ? (
          <div className={styles.primarySection}>
            <div className={styles.primaryTitle}>Milestones</div>
            <div className={styles.smallNote} style={{ marginTop: 10 }}>
              Creator completes milestones. Token holders signal approval. After the delay and threshold, milestones become claimable. Admin releases funds via an explicit on-chain transfer.
            </div>

            {creatorError ? (
              <div className={styles.smallNote} style={{ color: "rgba(180, 40, 60, 0.86)", marginTop: 12 }}>
                {creatorError}
              </div>
            ) : null}

            {signalError ? (
              <div className={styles.smallNote} style={{ color: "rgba(180, 40, 60, 0.86)", marginTop: 12 }}>
                {signalError}
              </div>
            ) : null}

            <div className={styles.milestoneList}>
              {(props.milestones ?? []).map((m) => {
                const msg = completionMessage(id, m.id);
                const nowUnix = Number(props.nowUnix ?? 0);
                const canComplete = m.status === "locked" && m.completedAtUnix == null;
                const canRelease = m.status === "claimable";

                const balanceLamports = Number(props.balanceLamports ?? 0);
                const unlockLamports = Number(m.unlockLamports ?? 0);
                const underfunded = Number.isFinite(balanceLamports) && Number.isFinite(unlockLamports) && balanceLamports < unlockLamports;

                const approvals = Number((props.approvalCounts ?? {})[m.id] ?? 0);
                const threshold = Number(props.approvalThreshold ?? 0);
                const showApprovals = threshold > 0;
                const canSignal = m.status === "locked" && m.completedAtUnix != null;

                const statusLabel = (() => {
                  if (m.status === "released") return "Released";
                  if (m.status === "claimable") return "Claimable";
                  if (m.completedAtUnix != null) return "Pending";
                  return "Locked";
                })();

                const timing = (() => {
                  if (m.status === "released" && m.releasedAtUnix != null) return `Released ${unixToLocal(m.releasedAtUnix)}`;
                  if (m.status === "claimable") return "Ready for release";
                  if (m.claimableAtUnix != null) {
                    if (nowUnix > 0 && nowUnix < m.claimableAtUnix) return `Claimable ${unixToLocal(m.claimableAtUnix)}`;
                    return `Claimable at ${unixToLocal(m.claimableAtUnix)}`;
                  }
                  return "Not completed yet";
                })();

                return (
                  <div key={m.id} className={styles.milestoneRow}>
                    <div className={styles.milestoneRail}>
                      <div
                        className={`${styles.milestoneDot} ${
                          m.status === "released"
                            ? styles.dotReleased
                            : m.status === "claimable"
                              ? styles.dotClaimable
                              : m.completedAtUnix != null
                                ? styles.dotPending
                                : ""
                        }`}
                      />
                      <div className={styles.milestoneStem} />
                    </div>

                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className={styles.milestoneTop}>
                        <div style={{ minWidth: 0 }}>
                          <div className={styles.milestoneTitle}>{m.title}</div>
                          <div className={styles.milestoneMeta}>
                            <span className={styles.milestonePill}>{statusLabel}</span>
                            <span className={styles.milestoneMuted}>{timing}</span>
                          </div>
                          {showApprovals && m.completedAtUnix != null ? (
                            <div className={styles.smallNote} style={{ marginTop: 6 }}>
                              Approvals {approvals}/{threshold}
                            </div>
                          ) : null}
                        </div>
                        <div className={styles.milestoneAmount}>{fmtSol(Number(m.unlockLamports || 0))} SOL</div>
                      </div>

                      {m.status === "released" && m.releasedTxSig ? (
                        <div className={styles.milestoneSmallMono}>releasedTxSig={m.releasedTxSig}</div>
                      ) : null}

                      {canComplete ? (
                        <div className={styles.milestoneAction}>
                          <div className={styles.smallNote}>
                            Sign this message with your creator wallet ({props.creatorPubkey ?? "creator"}), then paste the base58 signature.
                          </div>
                          <div className={styles.milestoneSmallMono}>{msg}</div>
                          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
                            <input
                              className={styles.adminInput}
                              value={signatureInput[m.id] ?? ""}
                              onChange={(e) => setSignatureInput((prev) => ({ ...prev, [m.id]: e.target.value }))}
                              placeholder="Signature (base58)"
                            />
                            <button
                              className={`${styles.actionBtn} ${styles.actionPrimary}`}
                              onClick={() => markMilestoneComplete(m.id)}
                              disabled={creatorBusy != null}
                            >
                              {creatorBusy === `complete:${m.id}` ? "Submitting…" : "Mark Complete"}
                            </button>
                          </div>
                        </div>
                      ) : null}

                      {canSignal ? (
                        <div className={styles.milestoneAction}>
                          <div className={styles.smallNote}>
                            Token holders can vote by connecting a wallet, signing the message, and submitting the signature.
                          </div>
                          <div className={styles.milestoneSmallMono}>{signalMessage(id, m.id)}</div>
                          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
                            <button
                              className={`${styles.actionBtn} ${styles.actionPrimary}`}
                              onClick={connectHolderWallet}
                              disabled={holderBusy != null || signalBusy != null}
                            >
                              {holderBusy === "connect" ? "Connecting…" : holderWalletPubkey ? "Wallet Connected" : "Connect Wallet"}
                            </button>
                            <button
                              className={`${styles.actionBtn} ${styles.actionPrimary}`}
                              onClick={() => signAndSignalMilestone(m.id)}
                              disabled={signalBusy != null || holderBusy != null || !props.tokenMint}
                            >
                              {holderBusy === `sign:${m.id}` || signalBusy === `signal:${m.id}` ? "Submitting…" : "Sign & Vote"}
                            </button>
                          </div>
                          {props.tokenMint ? (
                            <div className={styles.smallNote} style={{ marginTop: 8 }}>
                              Voting requires holding {props.tokenMint} with value over $20.
                            </div>
                          ) : null}
                        </div>
                      ) : null}

                      {canRelease ? (
                        <div className={styles.milestoneAction}>
                          <div className={styles.smallNote}>Admin release (explicit transfer from escrow to creator wallet).</div>
                          {underfunded ? (
                            <div className={styles.smallNote} style={{ marginTop: 8, color: "rgba(180, 40, 60, 0.86)" }}>
                              Escrow underfunded. Balance {fmtSol(balanceLamports)} SOL, requires {fmtSol(unlockLamports)} SOL.
                            </div>
                          ) : null}
                          <div className={styles.actions} style={{ marginTop: 10 }}>
                            <button
                              className={`${styles.actionBtn} ${styles.actionPrimary}`}
                              onClick={() => releaseMilestone(m.id)}
                              disabled={!canAdminAct || underfunded || adminBusy === `release:${m.id}`}
                            >
                              {adminBusy === `release:${m.id}` ? "Releasing…" : "Release"}
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        {canMarkSuccess || canMarkFailure ? (
          <div className={styles.primarySection}>
            <div className={styles.primaryTitle}>Resolution</div>
            <div className={styles.smallNote} style={{ marginTop: 10 }}>
              Admin controls are intentionally quiet. They appear only when relevant.
            </div>

            {adminError ? <div className={styles.smallNote} style={{ color: "rgba(180, 40, 60, 0.86)", marginTop: 10 }}>{adminError}</div> : null}

            <div className={styles.actions} style={{ marginTop: 14, justifyContent: "flex-start" }}>
              {canMarkSuccess ? (
                <button
                  className={`${styles.actionBtn} ${styles.actionPrimary}`}
                  onClick={() => resolve("success")}
                  disabled={!canAdminAct || adminBusy === "success"}
                >
                  {adminBusy === "success" ? "Resolving…" : "Mark Success"}
                </button>
              ) : null}

              {canMarkFailure ? (
                <button
                  className={`${styles.actionBtn} ${styles.actionPrimary}`}
                  onClick={() => resolve("failure")}
                  disabled={!canAdminAct || adminBusy === "failure"}
                >
                  {adminBusy === "failure" ? "Resolving…" : "Mark Failure"}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      <aside className={styles.receiptRail}>
        <div className={styles.receiptTitle}>Receipt</div>

        <div className={styles.receiptBlock}>
          <div className={styles.receiptLabel}>Escrow address</div>
          <div className={styles.receiptValue}>{escrowPubkey}</div>
          <div className={styles.actions} style={{ marginTop: 10, justifyContent: "flex-start" }}>
            <button className={styles.actionBtn} onClick={() => copy(escrowPubkey, "escrow")}>
              {copied === "escrow" ? "Copied" : "Copy"}
            </button>
            <a className={styles.actionBtn} href={explorerUrl} target="_blank" rel="noreferrer">
              Explorer
            </a>
          </div>
        </div>

        <div className={styles.receiptBlock}>
          <div className={styles.receiptLabel}>Commitment id</div>
          <div className={styles.receiptValue}>{id}</div>
          <div className={styles.actions} style={{ marginTop: 10, justifyContent: "flex-start" }}>
            <button className={styles.actionBtn} onClick={() => copy(id, "id")}>
              {copied === "id" ? "Copied" : "Copy"}
            </button>
          </div>
        </div>

        {kind === "creator_reward" ? (
          <div className={styles.receiptBlock}>
            <div className={styles.receiptLabel}>Creator wallet</div>
            <div className={styles.receiptValue}>{props.creatorPubkey ?? ""}</div>
          </div>
        ) : (
          <>
            <div className={styles.receiptBlock}>
              <div className={styles.receiptLabel}>Authority (refund)</div>
              <div className={styles.receiptValue}>{props.authority}</div>
            </div>
            <div className={styles.receiptBlock}>
              <div className={styles.receiptLabel}>Destination on failure</div>
              <div className={styles.receiptValue}>{props.destinationOnFail}</div>
            </div>
          </>
        )}

        {(kind === "creator_reward" || canMarkSuccess || canMarkFailure) ? (
          <div className={styles.receiptBlock}>
            <div className={styles.receiptLabel}>Admin key</div>
            {adminAuthError ? <div className={styles.smallNote} style={{ marginTop: 8, color: "rgba(180, 40, 60, 0.86)" }}>{adminAuthError}</div> : null}
            <div className={styles.actions} style={{ marginTop: 10, justifyContent: "flex-start" }}>
              <button className={styles.actionBtn} onClick={adminSignIn} disabled={adminAuthBusy != null}>
                {adminWalletPubkey ? "Admin Signed In" : adminAuthBusy === "signin" ? "Signing in..." : "Admin Sign In"}
              </button>
              {adminWalletPubkey ? (
                <button className={styles.actionBtn} onClick={adminSignOut} disabled={adminAuthBusy != null}>
                  {adminAuthBusy === "signout" ? "Signing out..." : "Sign Out"}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {kind === "creator_reward" ? (
          <div className={styles.receiptBlock}>
            <div className={styles.receiptLabel}>Pump.fun Creator Fees</div>
            <div className={styles.smallNote} style={{ marginTop: 8 }}>
              Connect the creator wallet to check and claim fees.
            </div>

            {pumpError ? <div className={styles.smallNote} style={{ marginTop: 10, color: "rgba(180, 40, 60, 0.86)" }}>{pumpError}</div> : null}

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
              <input
                className={styles.adminInput}
                value={pumpCreatorPubkeyInput}
                onChange={(e) => setPumpCreatorPubkeyInput(e.target.value)}
                placeholder="Creator wallet pubkey"
              />
              <button
                className={styles.actionBtn}
                onClick={connectPumpCreatorWallet}
                disabled={pumpBusy != null}
              >
                {pumpBusy === "connect" ? "Connecting…" : pumpWalletPubkey ? "Wallet Connected" : "Connect Wallet"}
              </button>
              <button
                className={styles.actionBtn}
                onClick={pumpCheckStatus}
                disabled={pumpBusy != null}
              >
                {pumpBusy === "check" ? "Checking…" : "Check"}
              </button>
              <button
                className={`${styles.actionBtn} ${styles.actionPrimary}`}
                onClick={pumpClaimFees}
                disabled={pumpBusy != null || !pumpWalletPubkey}
              >
                {pumpBusy === "claim" ? "Claiming…" : "Claim"}
              </button>
            </div>

            {pumpStatus?.creatorVault ? (
              <div className={styles.smallNote} style={{ marginTop: 10 }}>
                Vault {String(pumpStatus.creatorVault)}
              </div>
            ) : null}
            {typeof pumpStatus?.claimableLamports === "number" ? (
              <div className={styles.smallNote} style={{ marginTop: 6 }}>
                Claimable {fmtSol(Number(pumpStatus.claimableLamports || 0))} SOL
              </div>
            ) : null}

            {pumpClaimResult?.signature ? (
              <div className={styles.smallNote} style={{ marginTop: 10 }}>
                Claimed: {String(pumpClaimResult.signature)}
              </div>
            ) : null}
          </div>
        ) : null}

        {kind === "creator_reward" && props.tokenMint ? (
          <div className={styles.receiptBlock}>
            <div className={styles.receiptLabel}>Token mint</div>
            <div className={styles.receiptValue}>{props.tokenMint}</div>
          </div>
        ) : null}
      </aside>
    </div>
  );
}
