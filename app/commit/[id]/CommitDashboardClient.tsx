"use client";

import { Connection, PublicKey, SystemProgram, Transaction, clusterApiUrl } from "@solana/web3.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import bs58 from "bs58";
import { useToast } from "@/app/components/ToastProvider";
import PriceChart from "@/app/components/PriceChart";
import styles from "./CommitDashboard.module.css";

type AdminActionModalState =
  | null
  | {
      kind: "resolve";
      outcome: "success" | "failure";
      step: "confirm" | "submitting" | "done";
      result?: any;
      error?: string;
    }
  | {
      kind: "release";
      milestoneId: string;
      milestoneTitle: string;
      unlockLamports: number;
      toPubkey: string;
      step: "confirm" | "submitting" | "done";
      result?: any;
      error?: string;
    }
  | {
      kind: "milestoneFailurePayout";
      milestoneId: string;
      milestoneTitle: string;
      step: "confirm" | "submitting" | "done";
      result?: any;
      error?: string;
    };

type ProfileSummary = {
  walletPubkey: string;
  displayName?: string | null;
  avatarUrl?: string | null;
};

type RewardMilestoneStatus = "locked" | "approved" | "failed" | "claimable" | "released";

type RewardMilestone = {
  id: string;
  title: string;
  unlockLamports: number;
  unlockPercent?: number;
  dueAtUnix?: number;
  status: RewardMilestoneStatus;
  completedAtUnix?: number;
  reviewOpenedAtUnix?: number;
  approvedAtUnix?: number;
  failedAtUnix?: number;
  claimableAtUnix?: number;
  becameClaimableAtUnix?: number;
  releasedAtUnix?: number;
  releasedTxSig?: string;
};

type RewardMilestoneApprovalCounts = Record<string, number>;

type ProjectProfileSummary = {
  tokenMint: string;
  name?: string | null;
  symbol?: string | null;
  websiteUrl?: string | null;
  xUrl?: string | null;
  telegramUrl?: string | null;
  discordUrl?: string | null;
  imageUrl?: string | null;
};

type Props = {
  id: string;
  kind: "personal" | "creator_reward";
  amountLamports: number;
  escrowPubkey: string;
  destinationOnFail: string;
  authority: string;
  statement?: string | null;
  status: string;
  canMarkSuccess: boolean;
  canMarkFailure: boolean;
  explorerUrl: string;

  creatorPubkey?: string | null;
  creatorFeeMode?: "managed" | "assisted" | null;
  tokenMint?: string | null;
  milestones?: RewardMilestone[];
  approvalCounts?: RewardMilestoneApprovalCounts;
  approvalThreshold?: number;
  totalFundedLamports?: number;
  unlockedLamports?: number;
  balanceLamports?: number;
  milestoneTotalUnlockLamports?: number;
  nowUnix?: number;
  projectProfile?: {
    name?: string | null;
    symbol?: string | null;
    imageUrl?: string | null;
    description?: string | null;
    websiteUrl?: string | null;
    xUrl?: string | null;
    telegramUrl?: string | null;
    discordUrl?: string | null;
  } | null;
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

function shortWallet(pk: string): string {
  const s = String(pk ?? "").trim();
  if (!s) return "";
  if (s.length <= 10) return s;
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function tokenLabel(input: { symbol?: string | null; name?: string | null; mint?: string | null }): string {
  const sym = String(input.symbol ?? "").trim();
  if (sym) return `$${sym}`;
  const name = String(input.name ?? "").trim();
  if (name) return name;
  const mint = String(input.mint ?? "").trim();
  return mint ? shortWallet(mint) : "this token";
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
  if (!res.ok) {
    const err = typeof json?.error === "string" && json.error.trim().length ? json.error.trim() : `Request failed (${res.status})`;
    const hint = typeof json?.hint === "string" && json.hint.trim().length ? json.hint.trim() : "";
    throw new Error(hint ? `${err}\n${hint}` : err);
  }
  return json;
}

function fmtSol(lamports: number): string {
  const sol = lamports / 1_000_000_000;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(sol);
}

function fmtUsd(value: number): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function milestoneFailureClaimMessage(input: {
  commitmentId: string;
  milestoneId: string;
  walletPubkey: string;
  timestampUnix: number;
}): string {
  return `Commit To Ship\nMilestone Failure Voter Claim\nCommitment: ${input.commitmentId}\nMilestone: ${input.milestoneId}\nWallet: ${input.walletPubkey}\nTimestamp: ${input.timestampUnix}`;
}

function unixToLocal(unix: number): string {
  return new Date(unix * 1000).toLocaleString();
}

function toDatetimeLocalValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function completionMessage(commitmentId: string, milestoneId: string): string {
  return `Commit To Ship\nMilestone Completion\nCommitment: ${commitmentId}\nMilestone: ${milestoneId}`;
}

function signalMessage(commitmentId: string, milestoneId: string, vote: "approve" | "reject"): string {
  const v = vote === "reject" ? "reject" : "approve";
  const title = v === "reject" ? "Milestone Reject Signal" : "Milestone Approval Signal";
  return `Commit To Ship\n${title}\nCommitment: ${commitmentId}\nMilestone: ${milestoneId}\nVote: ${v}`;
}

function addMilestoneMessage(input: { commitmentId: string; requestId: string; title: string; unlockPercent: number; dueAtUnix: number }): string {
  return `Commit To Ship\nAdd Milestone\nCommitment: ${input.commitmentId}\nRequest: ${input.requestId}\nTitle: ${input.title}\nUnlockPercent: ${input.unlockPercent}\nDueAtUnix: ${input.dueAtUnix}`;
}

function claimMessage(commitmentId: string, milestoneId: string): string {
  return `Commit To Ship\nMilestone Claim\nCommitment: ${commitmentId}\nMilestone: ${milestoneId}`;
}

function makeRequestId(): string {
  const rand = Math.random().toString(16).slice(2);
  return `${Date.now()}:${rand}`;
}

function solToLamports(sol: string): number {
  const n = Number(String(sol ?? "").trim());
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n * 1_000_000_000);
}

export default function CommitDashboardClient(props: Props) {
  const { escrowPubkey, explorerUrl, id, canMarkFailure, canMarkSuccess, kind, projectProfile: projectProfileProp } = props;

  const router = useRouter();
  const toast = useToast();

  const isManagedCreatorFeeMode = String(props.creatorFeeMode ?? "assisted") === "managed";

  const effectiveRewardMilestoneLamports = (m: RewardMilestone): number => {
    const explicit = Number(m.unlockLamports ?? 0);
    if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
    const pct = Number((m as any).unlockPercent ?? 0);
    const total = Number(props.totalFundedLamports ?? 0);
    if (!Number.isFinite(pct) || pct <= 0) return 0;
    if (!Number.isFinite(total) || total <= 0) return 0;
    return Math.floor((total * pct) / 100);
  };

  async function copyAny(text: string) {
    try {
      if (!window.isSecureContext || !navigator.clipboard?.writeText) {
        throw new Error("Clipboard access is not available in this context");
      }
      await navigator.clipboard.writeText(text);
      toast({ kind: "success", message: "Copied" });
    } catch (e) {
      toast({ kind: "error", message: (e as Error).message });
    }
  }

  function openExplorerTx(signature: string) {
    const sig = String(signature ?? "").trim();
    if (!sig) return;
    window.open(`https://solscan.io/tx/${encodeURIComponent(sig)}`, "_blank", "noopener,noreferrer");
  }

  function closeAdminModal(opts?: { refresh?: boolean }) {
    setAdminModal(null);
    if (opts?.refresh) {
      window.setTimeout(() => router.refresh(), 0);
    }
  }

  const [copied, setCopied] = useState<null | "escrow" | "id">(null);
  const [adminWalletPubkey, setAdminWalletPubkey] = useState<string | null>(null);
  const [adminAuthBusy, setAdminAuthBusy] = useState<string | null>(null);
  const [adminAuthError, setAdminAuthError] = useState<string | null>(null);
  const [adminBusy, setAdminBusy] = useState<string | null>(null);
  const [adminError, setAdminError] = useState<string | null>(null);

  const [pumpCreatorPubkeyInput, setPumpCreatorPubkeyInput] = useState<string>(String(props.authority ?? ""));
  const [pumpBusy, setPumpBusy] = useState<string | null>(null);
  const [pumpError, setPumpError] = useState<string | null>(null);
  const [pumpStatus, setPumpStatus] = useState<any>(null);
  const [pumpClaimResult, setPumpClaimResult] = useState<any>(null);
  const [pumpWalletPubkey, setPumpWalletPubkey] = useState<string | null>(null);

  const [profilesByWallet, setProfilesByWallet] = useState<Record<string, ProfileSummary>>({});

  const [signalSignerPubkey, setSignalSignerPubkey] = useState("");
  const [signalBusy, setSignalBusy] = useState<string | null>(null);
  const [signalError, setSignalError] = useState<string | null>(null);
  const [signalSignatureInput, setSignalSignatureInput] = useState<Record<string, string>>({});

  const [signalVote, setSignalVote] = useState<"approve" | "reject">("approve");

  const [holderWalletPubkey, setHolderWalletPubkey] = useState<string | null>(null);
  const [holderBusy, setHolderBusy] = useState<string | null>(null);

  const [selectedVoteMilestoneIds, setSelectedVoteMilestoneIds] = useState<string[]>([]);

  const [milestoneFailureClaimBusy, setMilestoneFailureClaimBusy] = useState<string | null>(null);
  const [milestoneFailureClaimError, setMilestoneFailureClaimError] = useState<Record<string, string>>({});
  const [milestoneFailureClaimResult, setMilestoneFailureClaimResult] = useState<Record<string, any>>({});

  const [fundWalletPubkey, setFundWalletPubkey] = useState<string | null>(null);
  const [fundBusy, setFundBusy] = useState<string | null>(null);
  const [fundError, setFundError] = useState<string | null>(null);
  const [fundSignature, setFundSignature] = useState<string | null>(null);

  const [projectProfile, setProjectProfile] = useState<ProjectProfileSummary | null>(null);

  const [adminModal, setAdminModal] = useState<AdminActionModalState>(null);

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

  function getSolanaProvider(): any {
    return (window as any)?.solana;
  }

  function getClientRpcEndpoint(): string {
    const explicit = String(process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "").trim();
    if (explicit) return explicit;

    const cluster = String(process.env.NEXT_PUBLIC_SOLANA_CLUSTER ?? "mainnet-beta").trim();
    if (cluster === "devnet" || cluster === "testnet" || cluster === "mainnet-beta") {
      return clusterApiUrl(cluster);
    }
    return clusterApiUrl("mainnet-beta");
  }

  async function connectFundingWallet() {
    setFundError(null);
    setFundBusy("connect");
    try {
      const provider = getSolanaProvider();
      if (!provider?.connect) throw new Error("Wallet provider not found");
      const res = await provider.connect();
      const pk = (res?.publicKey ?? provider.publicKey)?.toBase58?.();
      if (!pk) throw new Error("Failed to read wallet public key");
      setFundWalletPubkey(pk);
    } catch (e) {
      setFundError((e as Error).message);
    } finally {
      setFundBusy(null);
    }
  }

  async function fundEscrow() {
    setFundError(null);
    setFundSignature(null);
    setFundBusy("fund");
    try {
      const requiredLamports = Number(props.amountLamports ?? 0);
      const currentLamports = Number(props.balanceLamports ?? 0);
      const remainingLamports = Math.max(0, requiredLamports - currentLamports);
      if (!Number.isFinite(requiredLamports) || requiredLamports <= 0) throw new Error("Invalid required amount");
      if (!Number.isFinite(currentLamports) || currentLamports < 0) throw new Error("Invalid escrow balance");
      if (remainingLamports <= 0) throw new Error("Escrow is already funded");

      const provider = getSolanaProvider();
      if (!provider?.publicKey) {
        if (!provider?.connect) throw new Error("Wallet provider not found");
        await provider.connect();
      }
      if (!provider?.publicKey?.toBase58) throw new Error("Failed to read wallet public key");

      const from = new PublicKey(provider.publicKey.toBase58());
      setFundWalletPubkey(from.toBase58());

      const to = new PublicKey(String(escrowPubkey));

      const connection = new Connection(getClientRpcEndpoint(), "confirmed");
      const latest = await connection.getLatestBlockhash("processed");

      const tx = new Transaction();
      tx.recentBlockhash = latest.blockhash;
      tx.lastValidBlockHeight = latest.lastValidBlockHeight;
      tx.feePayer = from;
      tx.add(
        SystemProgram.transfer({
          fromPubkey: from,
          toPubkey: to,
          lamports: remainingLamports,
        })
      );

      let signature: string;

      if (provider.signAndSendTransaction) {
        const sent = await provider.signAndSendTransaction(tx);
        signature = String(sent?.signature ?? sent);
      } else if (provider.signTransaction) {
        const signedTx = await provider.signTransaction(tx);
        const raw = signedTx.serialize();
        signature = await connection.sendRawTransaction(raw, { skipPreflight: false });
      } else {
        throw new Error("Wallet does not support sending transactions");
      }

      await connection.confirmTransaction(
        { signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
        "confirmed"
      );

      setFundSignature(signature);
      toast({ kind: "success", message: "Funding transaction submitted" });
      router.refresh();
    } catch (e) {
      const msg = (e as Error).message;
      setFundError(msg);
      toast({ kind: "error", message: msg });
    } finally {
      setFundBusy(null);
    }
  }

  useEffect(() => {
    const wallets: string[] = [];
    if (props.creatorPubkey) wallets.push(String(props.creatorPubkey));
    if (props.authority) wallets.push(String(props.authority));

    const cleaned = Array.from(new Set(wallets.map((w) => String(w ?? "").trim()).filter(Boolean)));
    const missing = cleaned.filter((w) => !profilesByWallet[w]);
    if (missing.length === 0) return;

    fetch("/api/profiles/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ walletPubkeys: missing }),
    })
      .then((res) => readJsonSafe(res).then((json) => ({ ok: res.ok, json })))
      .then(({ ok, json }) => {
        if (!ok) return;
        const profiles = Array.isArray(json?.profiles) ? (json.profiles as ProfileSummary[]) : [];
        if (!profiles.length) return;

        setProfilesByWallet((prev) => {
          const next = { ...prev };
          for (const p of profiles) {
            const pk = String(p?.walletPubkey ?? "").trim();
            if (!pk) continue;
            next[pk] = {
              walletPubkey: pk,
              displayName: p.displayName ?? null,
              avatarUrl: p.avatarUrl ?? null,
            };
          }
          return next;
        });
      })
      .catch(() => null);
  }, [profilesByWallet, props.authority, props.creatorPubkey]);

  useEffect(() => {
    const mint = String(props.tokenMint ?? "").trim();
    if (!mint) {
      setProjectProfile(null);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(mint)}`, { cache: "no-store" });
        const json = await readJsonSafe(res);
        if (!res.ok) return;
        const p = json?.project ?? null;
        if (cancelled) return;
        if (!p?.tokenMint) {
          setProjectProfile(null);
          return;
        }
        setProjectProfile({
          tokenMint: String(p.tokenMint),
          name: p.name ?? null,
          symbol: p.symbol ?? null,
          websiteUrl: p.websiteUrl ?? null,
          xUrl: p.xUrl ?? null,
          telegramUrl: p.telegramUrl ?? null,
          discordUrl: p.discordUrl ?? null,
          imageUrl: p.imageUrl ?? null,
        });
      } catch {
        // ignore
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [props.tokenMint]);

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

  function toggleSelectedVoteMilestone(milestoneId: string) {
    setSelectedVoteMilestoneIds((prev) => {
      if (prev.includes(milestoneId)) return prev.filter((x) => x !== milestoneId);
      return [...prev, milestoneId];
    });
  }

  async function signAndSignalSelectedMilestones(milestoneIds: string[]) {
    setSignalError(null);
    setHolderBusy("sign:batch");
    setSignalBusy("signal:batch");
    try {
      const provider = getSolanaProvider();
      if (!provider?.publicKey) {
        if (!provider?.connect) throw new Error("Wallet provider not found");
        await provider.connect();
      }
      if (!provider?.publicKey?.toBase58) throw new Error("Failed to read wallet public key");
      if (!provider.signMessage) throw new Error("Wallet does not support message signing");

      const signerPubkey = provider.publicKey.toBase58();
      setHolderWalletPubkey(signerPubkey);
      setSignalSignerPubkey(signerPubkey);

      const unique = Array.from(new Set(milestoneIds)).filter(Boolean);
      if (unique.length === 0) throw new Error("Select at least one milestone");

      for (const milestoneId of unique) {
        const message = signalMessage(id, milestoneId, signalVote);
        const signed = await provider.signMessage(new TextEncoder().encode(message), "utf8");
        const signatureBytes: Uint8Array = signed?.signature ?? signed;
        const signature = bs58.encode(signatureBytes);
        await jsonPost(`/api/commitments/${id}/milestones/${milestoneId}/signal`, { signerPubkey, message, signature, vote: signalVote });
      }

      toast({ kind: "success", message: `Voted on ${unique.length} milestone${unique.length === 1 ? "" : "s"}` });
      setSelectedVoteMilestoneIds([]);
      router.refresh();
    } catch (e) {
      const msg = (e as Error).message;
      setSignalError(msg);
    } finally {
      setSignalBusy(null);
      setHolderBusy(null);
    }
  }

  async function signalMilestone(milestoneId: string, override?: { signerPubkey: string; signature: string; vote?: "approve" | "reject" }) {
    setSignalError(null);
    setSignalBusy(`signal:${milestoneId}`);
    try {
      const signerPubkey = (override?.signerPubkey ?? signalSignerPubkey).trim();
      const vote = override?.vote ?? signalVote;
      const message = signalMessage(id, milestoneId, vote);
      const signature = (override?.signature ?? signalSignatureInput[milestoneId] ?? "").trim();
      await jsonPost(`/api/commitments/${id}/milestones/${milestoneId}/signal`, { signerPubkey, message, signature, vote });
      toast({ kind: "success", message: "Vote submitted" });
      router.refresh();
    } catch (e) {
      const msg = (e as Error).message;
      setSignalError(msg);
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
      const message = signalMessage(id, milestoneId, signalVote);
      const signed = await provider.signMessage(new TextEncoder().encode(message), "utf8");
      const signatureBytes: Uint8Array = signed?.signature ?? signed;
      const signature = bs58.encode(signatureBytes);

      setHolderWalletPubkey(signerPubkey);
      setSignalSignerPubkey(signerPubkey);
      setSignalSignatureInput((prev) => ({ ...prev, [milestoneId]: signature }));

      await signalMilestone(milestoneId, { signerPubkey, signature, vote: signalVote });
    } catch (e) {
      setSignalError((e as Error).message);
    } finally {
      setHolderBusy(null);
    }
  }

  async function claimMilestoneFailureRewards(milestoneId: string) {
    setMilestoneFailureClaimResult((prev) => ({ ...prev, [milestoneId]: null }));
    setMilestoneFailureClaimError((prev) => ({ ...prev, [milestoneId]: "" }));
    setMilestoneFailureClaimBusy(milestoneId);
    try {
      const provider = getSolanaProvider();
      if (!provider?.publicKey) {
        if (!provider?.connect) throw new Error("Wallet provider not found");
        await provider.connect();
      }
      if (!provider?.publicKey?.toBase58) throw new Error("Failed to read wallet public key");
      if (!provider.signMessage) throw new Error("Wallet does not support message signing");

      const walletPubkey = provider.publicKey.toBase58();
      const timestampUnix = Math.floor(Date.now() / 1000);
      const message = milestoneFailureClaimMessage({ commitmentId: id, milestoneId, walletPubkey, timestampUnix });

      const signed = await provider.signMessage(new TextEncoder().encode(message), "utf8");
      const signatureBytes: Uint8Array = signed?.signature ?? signed;
      const signatureB58 = bs58.encode(signatureBytes);

      setHolderWalletPubkey(walletPubkey);

      const res = await jsonPost(`/api/commitments/${id}/milestones/${milestoneId}/failure-distribution/claim`, {
        walletPubkey,
        timestampUnix,
        signatureB58,
      });

      setMilestoneFailureClaimResult((prev) => ({ ...prev, [milestoneId]: res }));
    } catch (e) {
      setMilestoneFailureClaimError((prev) => ({ ...prev, [milestoneId]: (e as Error).message }));
    } finally {
      setMilestoneFailureClaimBusy(null);
    }
  }

  async function releaseMilestone(milestoneId: string) {
    const m = (props.milestones ?? []).find((x) => x.id === milestoneId);
    const title = String(m?.title ?? "Milestone");
    const unlockLamports = Number(m?.unlockLamports ?? 0);
    const toPubkey = String(props.creatorPubkey ?? "");
    setAdminModal({ kind: "release", milestoneId, milestoneTitle: title, unlockLamports, toPubkey, step: "confirm" });
  }

  async function approveMilestoneFailurePayout(milestoneId: string) {
    const m = (props.milestones ?? []).find((x) => x.id === milestoneId);
    const title = String(m?.title ?? "Milestone");
    setAdminModal({ kind: "milestoneFailurePayout", milestoneId, milestoneTitle: title, step: "confirm" });
  }

  async function resolve(kind: "success" | "failure") {
    setAdminModal({ kind: "resolve", outcome: kind, step: "confirm" });
  }

  async function submitAdminModal() {
    if (!adminModal) return;
    setAdminError(null);

    if (adminModal.kind === "release") {
      setAdminBusy(`release:${adminModal.milestoneId}`);
      setAdminModal({ ...adminModal, step: "submitting", error: undefined });
      try {
        const res = await adminPost(`/api/commitments/${id}/milestones/${adminModal.milestoneId}/release`);
        setAdminModal({ ...adminModal, step: "done", result: res });
        const sig = String(res?.signature ?? "").trim();
        toast({ kind: "success", message: sig ? `Release submitted: ${sig}` : "Release submitted" });
      } catch (e) {
        const msg = (e as Error).message;
        setAdminError(msg);
        setAdminModal({ ...adminModal, step: "confirm", error: msg });
        toast({ kind: "error", message: msg });
      } finally {
        setAdminBusy(null);
      }
      return;
    }

    if (adminModal.kind === "milestoneFailurePayout") {
      setAdminBusy(`milestoneFailure:${adminModal.milestoneId}`);
      setAdminModal({ ...adminModal, step: "submitting", error: undefined });
      try {
        const res = await adminPost(`/api/commitments/${id}/milestones/${adminModal.milestoneId}/failure-distribution/create`);
        setAdminModal({ ...adminModal, step: "done", result: res });
        const buybackSig = String(res?.buyback?.signature ?? "").trim();
        toast({ kind: "success", message: buybackSig ? `Failure payout approved: ${buybackSig}` : "Failure payout approved" });
      } catch (e) {
        const msg = (e as Error).message;
        setAdminError(msg);
        setAdminModal({ ...adminModal, step: "confirm", error: msg });
        toast({ kind: "error", message: msg });
      } finally {
        setAdminBusy(null);
      }
      return;
    }

    if (adminModal.kind === "resolve") {
      setAdminBusy(adminModal.outcome);
      setAdminModal({ ...adminModal, step: "submitting", error: undefined });
      try {
        const res = await adminPost(`/api/commitments/${id}/${adminModal.outcome}`);
        setAdminModal({ ...adminModal, step: "done", result: res });

        const sig =
          String(res?.signature ?? "").trim() ||
          String(res?.buyback?.signature ?? "").trim() ||
          String(res?.voterPot?.txSig ?? "").trim();

        toast({
          kind: "success",
          message: sig ? `Marked ${adminModal.outcome}: ${sig}` : adminModal.outcome === "success" ? "Marked success" : "Marked failure",
        });
      } catch (e) {
        const msg = (e as Error).message;
        setAdminError(msg);
        setAdminModal({ ...adminModal, step: "confirm", error: msg });
        toast({ kind: "error", message: msg });
      } finally {
        setAdminBusy(null);
      }
    }
  }

  // Use prop if provided (for mock projects), otherwise use fetched state
  const effectiveProjectProfile = projectProfileProp || projectProfile;
  const hasProjectInfo = kind === "creator_reward" && effectiveProjectProfile;

  return (
    <div className={styles.lower}>
      {adminModal ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.64)",
            zIndex: 120,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 18,
          }}
          role="dialog"
          aria-modal="true"
        >
          <div
            style={{
              width: "min(640px, 96vw)",
              borderRadius: 16,
              border: "1px solid rgba(255,255,255,0.16)",
              background: "rgba(0,0,0,0.92)",
              padding: 18,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
              <div style={{ fontWeight: 700 }}>
                {adminModal.kind === "release"
                  ? "Confirm Release"
                  : adminModal.kind === "milestoneFailurePayout"
                    ? "Confirm Failure Payout"
                    : adminModal.outcome === "success"
                      ? "Confirm Mark Success"
                      : "Confirm Mark Failure"}
              </div>
              <button
                className={styles.actionBtn}
                type="button"
                onClick={() => closeAdminModal({ refresh: adminModal.step === "done" })}
                disabled={adminModal.step === "submitting"}
              >
                Close
              </button>
            </div>

            <div className={styles.smallNote} style={{ marginTop: 10 }}>
              This action is irreversible.
            </div>

            {adminModal.kind === "release" ? (
              <div className={styles.smallNote} style={{ marginTop: 10 }}>
                Release <strong>{adminModal.milestoneTitle}</strong> for <strong>{fmtSol(adminModal.unlockLamports)} SOL</strong> to
                <span className={styles.mono}> {adminModal.toPubkey || "creator"}</span>.
              </div>
            ) : adminModal.kind === "milestoneFailurePayout" ? (
              <div className={styles.smallNote} style={{ marginTop: 10 }}>
                Approve failure payout for <strong>{adminModal.milestoneTitle}</strong>. This will forfeit this milestone’s allocation and split it <strong>50/50</strong>
                between buybacks and eligible voters.
              </div>
            ) : (
              <div className={styles.smallNote} style={{ marginTop: 10 }}>
                Mark commitment <span className={styles.mono}>{id}</span> as <strong>{adminModal.outcome}</strong>.
              </div>
            )}

            {adminModal.error ? (
              <div className={styles.smallNote} style={{ marginTop: 12, color: "rgba(180, 40, 60, 0.86)" }}>
                {adminModal.error}
              </div>
            ) : null}

            {adminModal.step === "done" ? (
              (() => {
                const res: any = (adminModal as any).result;
                const sig =
                  String(res?.signature ?? "").trim() ||
                  String(res?.buyback?.signature ?? "").trim() ||
                  String(res?.voterPot?.txSig ?? "").trim();
                return (
                  <div style={{ marginTop: 12 }}>
                    <div className={styles.smallNote} style={{ marginTop: 10 }}>
                      Submitted.
                    </div>
                    {sig ? (
                      <div className={styles.smallNote} style={{ marginTop: 8 }}>
                        txSig=<span className={styles.mono}>{sig}</span>
                      </div>
                    ) : null}
                    <div className={styles.actions} style={{ marginTop: 12, justifyContent: "flex-start" }}>
                      {sig ? (
                        <>
                          <button className={styles.actionBtn} type="button" onClick={() => copyAny(sig)}>
                            Copy tx
                          </button>
                          <button className={`${styles.actionBtn} ${styles.actionPrimary}`} type="button" onClick={() => openExplorerTx(sig)}>
                            Open explorer
                          </button>
                        </>
                      ) : null}
                      <button className={styles.actionBtn} type="button" onClick={() => closeAdminModal({ refresh: true })}>
                        Done
                      </button>
                    </div>
                  </div>
                );
              })()
            ) : (
              <div className={styles.actions} style={{ marginTop: 14, justifyContent: "flex-start" }}>
                <button
                  className={`${styles.actionBtn} ${styles.actionPrimary}`}
                  type="button"
                  onClick={submitAdminModal}
                  disabled={adminModal.step === "submitting" || adminBusy != null}
                >
                  {adminModal.step === "submitting" ? "Submitting…" : "Confirm"}
                </button>
                <button className={styles.actionBtn} type="button" onClick={() => closeAdminModal()} disabled={adminModal.step === "submitting"}>
                  Cancel
                </button>
              </div>
            )}
          </div>
        </div>
      ) : null}
      <div className={styles.primaryFlow}>
        {hasProjectInfo && effectiveProjectProfile ? (
          <div className={styles.projectHeader}>
            <div className={styles.projectImage}>
              {effectiveProjectProfile.imageUrl ? (
                <img src={effectiveProjectProfile.imageUrl} alt={effectiveProjectProfile.name || ""} />
              ) : null}
            </div>
            <div className={styles.projectInfo}>
              <h2 className={styles.projectName}>
                {effectiveProjectProfile.name || "Project"}
                {effectiveProjectProfile.symbol ? <span className={styles.projectSymbol}>${effectiveProjectProfile.symbol}</span> : null}
              </h2>
              <div className={styles.projectSocials}>
                {effectiveProjectProfile.websiteUrl ? (
                  <a
                    href={effectiveProjectProfile.websiteUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.projectSocialLink}
                    title="Website"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="2" y1="12" x2="22" y2="12" />
                      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                    </svg>
                  </a>
                ) : null}
                {effectiveProjectProfile.xUrl ? (
                  <a
                    href={effectiveProjectProfile.xUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.projectSocialLink}
                    title="X (Twitter)"
                  >
                    <svg viewBox="0 0 24 24" fill="currentColor">
                      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                    </svg>
                  </a>
                ) : null}
                {effectiveProjectProfile.telegramUrl ? (
                  <a
                    href={effectiveProjectProfile.telegramUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.projectSocialLink}
                    title="Telegram"
                  >
                    <svg viewBox="0 0 24 24" fill="currentColor">
                      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
                    </svg>
                  </a>
                ) : null}
                {effectiveProjectProfile.discordUrl ? (
                  <a
                    href={effectiveProjectProfile.discordUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.projectSocialLink}
                    title="Discord"
                  >
                    <svg viewBox="0 0 24 24" fill="currentColor">
                      <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" />
                    </svg>
                  </a>
                ) : null}
                {props.tokenMint ? (
                  <a
                    href={`https://dexscreener.com/solana/${encodeURIComponent(props.tokenMint)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.projectSocialLink}
                    title="View on DexScreener"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                    </svg>
                  </a>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}

        {kind === "creator_reward" && props.tokenMint ? (
          <div className={styles.primarySection}>
            <div className={styles.primaryTitle}>Price</div>
            <div style={{ marginTop: 12 }}>
              <PriceChart tokenMint={props.tokenMint} height={460} />
            </div>
          </div>
        ) : null}

        {kind === "personal" ? (
          <div className={styles.primarySection}>
            <div className={styles.primaryTitle}>Funding</div>
            <div className={styles.smallNote} style={{ marginTop: 10 }}>
              This sends SOL from your wallet to the escrow address. It will send exactly the remaining amount required to fully fund the commitment.
            </div>
            <div className={styles.smallNote} style={{ marginTop: 8 }}>
              Custody notice: escrow funds are controlled by this service. An admin wallet can mark success/failure and trigger on-chain transfers.
            </div>

            {(() => {
              const requiredLamports = Number(props.amountLamports ?? 0);
              const balanceLamports = Number(props.balanceLamports ?? 0);
              const remainingLamports = Math.max(0, requiredLamports - balanceLamports);
              const funded = requiredLamports > 0 && balanceLamports >= requiredLamports;
              return (
                <div style={{ marginTop: 12 }}>
                  <div className={styles.smallNote}>
                    Required {fmtSol(requiredLamports)} SOL. Escrow balance {fmtSol(balanceLamports)} SOL.
                  </div>
                  {!funded ? (
                    <div className={styles.smallNote} style={{ marginTop: 6 }}>
                      Remaining {fmtSol(remainingLamports)} SOL.
                    </div>
                  ) : (
                    <div className={styles.smallNote} style={{ marginTop: 6 }}>
                      Escrow is funded.
                    </div>
                  )}
                </div>
              );
            })()}

            {fundError ? (
              <div className={styles.smallNote} style={{ color: "rgba(180, 40, 60, 0.86)", marginTop: 10 }}>
                {fundError}
              </div>
            ) : null}

            {fundSignature ? (
              <div className={styles.smallNote} style={{ marginTop: 10 }}>
                Funding sent: {fundSignature}
              </div>
            ) : null}

            <div className={styles.actions} style={{ marginTop: 12, justifyContent: "flex-start" }}>
              <button className={styles.actionBtn} onClick={connectFundingWallet} disabled={fundBusy != null}>
                {fundWalletPubkey ? "Wallet Connected" : fundBusy === "connect" ? "Connecting…" : "Connect Wallet"}
              </button>
              <button
                className={`${styles.actionBtn} ${styles.actionPrimary}`}
                onClick={fundEscrow}
                disabled={fundBusy != null}
              >
                {fundBusy === "fund" ? "Sending…" : "Fund Escrow"}
              </button>
            </div>
          </div>
        ) : null}

        {/* Prominent Holder Voting Section */}
        {kind === "creator_reward" && props.tokenMint ? (
          (() => {
            const nowUnix = Number(props.nowUnix ?? 0);
            const cutoffSeconds = 24 * 60 * 60;
            const voteWindow = (m: RewardMilestone): { startUnix: number; endUnix: number } | null => {
              const completedAtUnix = Number(m.completedAtUnix ?? 0);
              if (!Number.isFinite(completedAtUnix) || completedAtUnix <= 0) return null;

              const reviewOpenedAtUnix = Number((m as any).reviewOpenedAtUnix ?? 0);
              const dueAtUnix = Number(m.dueAtUnix ?? 0);
              const hasReview = Number.isFinite(reviewOpenedAtUnix) && reviewOpenedAtUnix > 0;

              const startUnix = hasReview
                ? Math.floor(reviewOpenedAtUnix)
                : Number.isFinite(dueAtUnix) && dueAtUnix > 0
                  ? Math.floor(dueAtUnix)
                  : completedAtUnix;

              const endUnix = hasReview
                ? startUnix + cutoffSeconds
                : Number.isFinite(dueAtUnix) && dueAtUnix > 0
                  ? Math.floor(dueAtUnix) + cutoffSeconds
                  : completedAtUnix + cutoffSeconds;

              if (!Number.isFinite(endUnix) || endUnix <= startUnix) return null;
              return { startUnix, endUnix };
            };

            const pendingAll = (props.milestones ?? []).filter((m) => m.status === "locked" && m.completedAtUnix != null);
            const openMilestones = pendingAll.filter((m) => {
              if (!(nowUnix > 0)) return true;
              const w = voteWindow(m);
              if (!w) return false;
              return nowUnix >= w.startUnix && nowUnix < w.endUnix;
            });
            const scheduledMilestones = pendingAll.filter((m) => {
              if (!(nowUnix > 0)) return false;
              const w = voteWindow(m);
              if (!w) return false;
              return nowUnix < w.startUnix;
            });

            const pendingMilestones = openMilestones;
            const threshold = Number(props.approvalThreshold ?? 0);
            const totalPendingSOL = pendingMilestones.reduce((acc, m) => acc + effectiveRewardMilestoneLamports(m), 0) / 1_000_000_000;

            const handleShare = async () => {
              const url = typeof window !== "undefined" ? window.location.href : "";
              const projectName = effectiveProjectProfile?.name || effectiveProjectProfile?.symbol || "this project";
              const text = `Help ${projectName} ship. Vote to release milestone funds for the dev team.\n\n${url}`;
              
              if (navigator.share) {
                try {
                  await navigator.share({ title: `Vote for ${projectName}`, text, url });
                } catch (e) {
                  // User cancelled or error
                }
              } else {
                try {
                  await navigator.clipboard.writeText(text);
                  toast({ kind: "success", message: "Link copied to clipboard!" });
                } catch (e) {
                  toast({ kind: "error", message: "Failed to copy link" });
                }
              }
            };

            return (
              <div className={styles.holderVoteSection}>
                <div className={styles.holderVoteHeader}>
                  <div className={styles.holderVoteIcon}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                      <polyline points="22 4 12 14.01 9 11.01" />
                    </svg>
                  </div>
                  <div className={styles.holderVoteHeaderText}>
                    <h3 className={styles.holderVoteTitle}>Token Holder Voting</h3>
                    <p className={styles.holderVoteSubtitle}>
                      {pendingMilestones.length > 0
                        ? `${pendingMilestones.length} milestone${pendingMilestones.length === 1 ? "" : "s"} open for voting (${totalPendingSOL.toFixed(2)} SOL)`
                        : scheduledMilestones.length > 0
                          ? `${scheduledMilestones.length} milestone${scheduledMilestones.length === 1 ? "" : "s"} turned in early — voting opens at the deadline`
                          : "No milestones open for voting right now"}
                    </p>
                  </div>
                  <button className={styles.shareBtn} onClick={handleShare} title="Share with holders">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="18" cy="5" r="3" />
                      <circle cx="6" cy="12" r="3" />
                      <circle cx="18" cy="19" r="3" />
                      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                      <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
                    </svg>
                    Share
                  </button>
                </div>

                {pendingMilestones.length > 0 ? (
                  <div className={styles.holderVoteContent}>
                    <div className={styles.holderVoteSteps}>
                      <div className={styles.holderVoteStep}>
                        <div className={styles.holderVoteStepNum}>1</div>
                        <div className={styles.holderVoteStepText}>Connect wallet</div>
                      </div>
                      <div className={styles.holderVoteStepArrow}>→</div>
                      <div className={styles.holderVoteStep}>
                        <div className={styles.holderVoteStepNum}>2</div>
                        <div className={styles.holderVoteStepText}>Select milestones</div>
                      </div>
                      <div className={styles.holderVoteStepArrow}>→</div>
                      <div className={styles.holderVoteStep}>
                        <div className={styles.holderVoteStepNum}>3</div>
                        <div className={styles.holderVoteStepText}>Sign to vote</div>
                      </div>
                    </div>

                    <div className={styles.holderVoteActions}>
                      {!holderWalletPubkey ? (
                        <button 
                          className={styles.holderVoteConnectBtn} 
                          onClick={connectHolderWallet} 
                          disabled={holderBusy != null}
                        >
                          {holderBusy === "connect" ? "Connecting..." : "Connect Wallet to Vote"}
                        </button>
                      ) : (
                        <div className={styles.holderVoteConnected}>
                          <span className={styles.holderVoteConnectedDot} />
                          <span>Connected: {shortWallet(holderWalletPubkey)}</span>
                        </div>
                      )}
                    </div>

                    <div className={styles.holderVoteNote}>
                      <strong>No gas fees.</strong> Voting uses a signature only — your tokens stay in your wallet.
                    </div>
                  </div>
                ) : (
                  <div className={styles.holderVoteEmpty}>
                    <p>
                      {scheduledMilestones.length > 0
                        ? "Milestones have been turned in early. Voting opens at the milestone deadline and lasts 24 hours."
                        : "The creator hasn\'t marked any milestones as complete yet. Check back soon!"}
                    </p>
                  </div>
                )}
              </div>
            );
          })()
        ) : null}

        {kind === "creator_reward" ? (
          <div className={styles.primarySection}>
            <div className={styles.primaryTitle}>Milestones</div>
            <div className={styles.smallNote} style={{ marginTop: 10 }}>
              Creator completes milestones. Token holders signal approval. After the delay and threshold, milestones become claimable. Creator can claim releases via signature.
            </div>
            <div className={styles.smallNote} style={{ marginTop: 8 }}>
              Votes do not move funds. Escrow can be underfunded, and claims will fail if escrow balance is insufficient.
            </div>

            {props.status !== "failed" ? (
              (() => {
                const nowUnix = Number(props.nowUnix ?? 0);

                const cutoffSeconds = 24 * 60 * 60;
                const voteWindow = (m: RewardMilestone): { startUnix: number; endUnix: number } | null => {
                  const completedAtUnix = Number(m.completedAtUnix ?? 0);
                  if (!Number.isFinite(completedAtUnix) || completedAtUnix <= 0) return null;

                  const reviewOpenedAtUnix = Number((m as any).reviewOpenedAtUnix ?? 0);
                  const dueAtUnix = Number(m.dueAtUnix ?? 0);
                  const hasReview = Number.isFinite(reviewOpenedAtUnix) && reviewOpenedAtUnix > 0;

                  const startUnix = hasReview
                    ? Math.floor(reviewOpenedAtUnix)
                    : Number.isFinite(dueAtUnix) && dueAtUnix > 0
                      ? Math.floor(dueAtUnix)
                      : completedAtUnix;

                  const endUnix = hasReview
                    ? startUnix + cutoffSeconds
                    : Number.isFinite(dueAtUnix) && dueAtUnix > 0
                      ? Math.floor(dueAtUnix) + cutoffSeconds
                      : completedAtUnix + cutoffSeconds;

                  if (!Number.isFinite(endUnix) || endUnix <= startUnix) return null;
                  return { startUnix, endUnix };
                };

                const pendingAll = (props.milestones ?? []).filter((m) => m.status === "locked" && m.completedAtUnix != null);
                const pending = pendingAll.filter((m) => {
                  if (!(nowUnix > 0)) return true;
                  const w = voteWindow(m);
                  if (!w) return false;
                  return nowUnix >= w.startUnix && nowUnix < w.endUnix;
                });
                const scheduled = pendingAll.filter((m) => {
                  if (!(nowUnix > 0)) return false;
                  const w = voteWindow(m);
                  if (!w) return false;
                  return nowUnix < w.startUnix;
                });
                const threshold = Number(props.approvalThreshold ?? 0);
                const showApprovals = threshold > 0;

                const selectedCount = selectedVoteMilestoneIds.length;
                const selectedSet = new Set(selectedVoteMilestoneIds);

                const signalErrorParts = String(signalError ?? "")
                  .split("\n")
                  .map((s) => s.trim())
                  .filter(Boolean);
                const signalErrorTitle = signalErrorParts[0] ?? "";
                const signalErrorHint = signalErrorParts.length > 1 ? signalErrorParts.slice(1).join(" ") : "";

                return (
                  <div className={styles.votePanel}>
                    <div className={styles.votePanelHeader}>
                      <div className={styles.votePanelTitleRow}>
                        <div className={styles.votePanelIcon}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                            <polyline points="22 4 12 14.01 9 11.01" />
                          </svg>
                        </div>
                        <div className={styles.votePanelTitleGroup}>
                          <div className={styles.votePanelTitle}>Holder Voting</div>
                          <div className={styles.votePanelSubtitle}>
                            Select milestones, choose approve or reject, then sign once
                          </div>
                        </div>
                        {props.tokenMint ? (
                          <div className={styles.votePanelRequirement}>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <circle cx="12" cy="12" r="10" />
                              <path d="M12 6v6l4 2" />
                            </svg>
                            Hold {tokenLabel({ symbol: effectiveProjectProfile?.symbol, name: effectiveProjectProfile?.name, mint: props.tokenMint })} &gt;$20
                          </div>
                        ) : null}
                      </div>

                      <div className={styles.votePanelControls}>
                        <div className={styles.votePanelControlGroup}>
                          <button
                            className={styles.actionBtn}
                            type="button"
                            onClick={() => setSelectedVoteMilestoneIds(pending.map((m) => m.id))}
                            disabled={pending.length === 0 || holderBusy != null || signalBusy != null}
                          >
                            Select all
                          </button>
                          <button
                            className={styles.actionBtn}
                            type="button"
                            onClick={() => setSelectedVoteMilestoneIds([])}
                            disabled={selectedCount === 0 || holderBusy != null || signalBusy != null}
                          >
                            Clear
                          </button>
                          <div className={styles.voteSelectedPill} data-empty={selectedCount === 0 ? "true" : undefined}>
                            {selectedCount} selected
                          </div>
                        </div>

                        <div className={styles.votePanelActions}>
                          <button className={styles.actionBtn} type="button" onClick={connectHolderWallet} disabled={holderBusy != null || signalBusy != null}>
                            {holderBusy === "connect" ? "Connecting…" : holderWalletPubkey ? `${shortWallet(holderWalletPubkey)}` : "Connect Wallet"}
                          </button>
                          <select
                            className={styles.voteDirectionSelect}
                            value={signalVote}
                            onChange={(e) => setSignalVote(e.target.value === "reject" ? "reject" : "approve")}
                            disabled={holderBusy != null || signalBusy != null}
                            aria-label="Vote direction"
                          >
                            <option value="approve">Approve</option>
                            <option value="reject">Reject</option>
                          </select>
                          <button
                            className={`${styles.actionBtn} ${styles.actionPrimary}`}
                            type="button"
                            onClick={() => signAndSignalSelectedMilestones(selectedVoteMilestoneIds)}
                            disabled={selectedCount === 0 || holderBusy != null || signalBusy != null || !props.tokenMint}
                          >
                            {holderBusy === "sign:batch" || signalBusy === "signal:batch"
                              ? "Submitting…"
                              : "Sign & Submit"}
                          </button>
                        </div>
                      </div>
                    </div>

                    {scheduled.length > 0 ? (
                      <div className={styles.votePanelBody}>
                        <div className={styles.smallNote}>
                          {scheduled.length} milestone{scheduled.length === 1 ? "" : "s"} have been turned in early.
                          Voting opens at the deadline and lasts 24 hours.
                        </div>
                      </div>
                    ) : null}

                    {signalErrorTitle ? (
                      <div className={styles.votePanelBody}>
                        <div className={styles.voteNotice} role="alert">
                          <div className={styles.voteNoticeTop}>
                            <div style={{ minWidth: 0 }}>
                              <div className={styles.voteNoticeTitle}>{signalErrorTitle}</div>
                              {signalErrorHint ? <div className={styles.voteNoticeHint}>{signalErrorHint}</div> : null}
                            </div>
                            <button className={styles.voteNoticeDismiss} type="button" onClick={() => setSignalError(null)}>
                              Dismiss
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : null}

                    {pending.length === 0 ? (
                      <div className={styles.votePanelEmpty}>
                        No milestones are open for voting right now.
                      </div>
                    ) : (
                      <div className={styles.votePanelBody}>
                        <div className={styles.votePanelList}>
                          {pending.map((m, idx) => {
                            const approvals = Number((props.approvalCounts ?? {})[m.id] ?? 0);
                            const pct = showApprovals ? clamp01(threshold > 0 ? approvals / threshold : 0) : 0;
                            const checked = selectedSet.has(m.id);
                            const label = String(m.title ?? "").trim().length ? m.title : `Milestone ${idx + 1}`;
                            const unlockLamports = effectiveRewardMilestoneLamports(m);

                            return (
                              <div
                                key={m.id}
                                className={styles.voteRow}
                                role="button"
                                tabIndex={0}
                                onClick={() => toggleSelectedVoteMilestone(m.id)}
                                onKeyDown={(ev) => {
                                  if (ev.key === "Enter" || ev.key === " ") {
                                    ev.preventDefault();
                                    toggleSelectedVoteMilestone(m.id);
                                  }
                                }}
                              >
                                <input
                                  className={styles.voteCheckbox}
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => toggleSelectedVoteMilestone(m.id)}
                                  onClick={(ev) => ev.stopPropagation()}
                                />
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div className={styles.voteRowTop}>
                                    <div className={styles.voteRowTitle}>{label}</div>
                                    <div className={styles.voteRowAmount}>{fmtSol(unlockLamports)} SOL</div>
                                  </div>

                                  {showApprovals ? (
                                    <div className={styles.voteProgress}>
                                      <div className={styles.voteProgressMeta}>
                                        {Math.floor(approvals)}/{Math.floor(threshold)} approvals
                                      </div>
                                      <div className={styles.voteProgressBar} aria-hidden="true">
                                        <div className={styles.voteProgressFill} style={{ width: `${Math.round(pct * 100)}%` }} />
                                      </div>
                                    </div>
                                  ) : null}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()
            ) : null}

            <div className={styles.milestoneList}>
              {(props.milestones ?? []).map((m) => {
                const nowUnix = Number(props.nowUnix ?? 0);
                const canRelease = m.status === "claimable";

                const balanceLamports = Number(props.balanceLamports ?? 0);
                const unlockLamports = effectiveRewardMilestoneLamports(m);
                const underfunded = Number.isFinite(balanceLamports) && Number.isFinite(unlockLamports) && balanceLamports < unlockLamports;

                const approvals = Number((props.approvalCounts ?? {})[m.id] ?? 0);
                const threshold = Number(props.approvalThreshold ?? 0);
                const showApprovals = threshold > 0;
                const canSignal = m.status === "locked" && m.completedAtUnix != null;

                const statusLabel = (() => {
                  if (m.status === "released") return "Released";
                  if (m.status === "claimable") return "Claimable";
                  if (m.status === "approved") return "Approved";
                  if (m.status === "failed") return "Failed";
                  if (m.completedAtUnix != null) return "Pending";
                  return "Locked";
                })();

                const timing = (() => {
                  if (m.status === "released" && m.releasedAtUnix != null) return `Released ${unixToLocal(m.releasedAtUnix)}`;
                  if (m.status === "claimable") return "Ready for release";
                  if (m.status === "failed") {
                    const failedAtUnix = Number((m as any).failedAtUnix ?? 0);
                    if (Number.isFinite(failedAtUnix) && failedAtUnix > 0) return `Failed ${unixToLocal(failedAtUnix)}`;
                    return "Failed";
                  }
                  if (m.status === "approved") {
                    if (m.claimableAtUnix != null) {
                      if (nowUnix > 0 && nowUnix < m.claimableAtUnix) return `Claimable ${unixToLocal(m.claimableAtUnix)}`;
                      return `Claimable at ${unixToLocal(m.claimableAtUnix)}`;
                    }
                    const approvedAtUnix = Number((m as any).approvedAtUnix ?? 0);
                    if (Number.isFinite(approvedAtUnix) && approvedAtUnix > 0) return `Approved ${unixToLocal(approvedAtUnix)}`;
                    return "Approved";
                  }
                  if (m.claimableAtUnix != null) {
                    if (nowUnix > 0 && nowUnix < m.claimableAtUnix) return `Claimable ${unixToLocal(m.claimableAtUnix)}`;
                    return `Claimable at ${unixToLocal(m.claimableAtUnix)}`;
                  }
                  if (m.dueAtUnix != null) return `Due ${unixToLocal(m.dueAtUnix)}`;
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
                              : m.status === "approved"
                                ? styles.dotApproved
                                : m.status === "failed"
                                  ? styles.dotFailed
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
                              Approvals {Math.floor(approvals)}/{Math.floor(threshold)}
                            </div>
                          ) : null}
                        </div>
                        <div className={styles.milestoneAmount}>{fmtSol(unlockLamports)} SOL</div>
                      </div>

                      {m.status === "released" && m.releasedTxSig ? (
                        <div className={styles.milestoneSmallMono}>releasedTxSig={m.releasedTxSig}</div>
                      ) : null}

                      {m.status === "failed" ? (
                        <div className={styles.milestoneAction}>
                          <div className={styles.smallNote}>This milestone failed. If the failure payout is approved, eligible voters can claim their share.</div>
                          {milestoneFailureClaimError[m.id] ? (
                            <div className={styles.smallNote} style={{ marginTop: 8, color: "rgba(180, 40, 60, 0.86)" }}>
                              {milestoneFailureClaimError[m.id]}
                            </div>
                          ) : null}
                          {milestoneFailureClaimResult[m.id]?.ok ? (
                            <div className={styles.smallNote} style={{ marginTop: 8 }}>
                              Claimed {fmtSol(Number(milestoneFailureClaimResult[m.id]?.amountLamports ?? 0))} SOL.
                            </div>
                          ) : null}
                          <div className={styles.actions} style={{ marginTop: 10, justifyContent: "flex-start" }}>
                            <button
                              className={styles.actionBtn}
                              onClick={connectHolderWallet}
                              disabled={holderBusy != null || milestoneFailureClaimBusy != null}
                            >
                              {holderWalletPubkey ? "Wallet Connected" : holderBusy === "connect" ? "Connecting…" : "Connect Wallet"}
                            </button>
                            <button
                              className={`${styles.actionBtn} ${styles.actionPrimary}`}
                              onClick={() => claimMilestoneFailureRewards(m.id)}
                              disabled={milestoneFailureClaimBusy != null && milestoneFailureClaimBusy !== m.id}
                            >
                              {milestoneFailureClaimBusy === m.id ? "Claiming…" : "Claim Voter Rewards"}
                            </button>

                            <button
                              className={styles.actionBtn}
                              onClick={() => approveMilestoneFailurePayout(m.id)}
                              disabled={!canAdminAct || adminBusy === `milestoneFailure:${m.id}`}
                              style={{ opacity: canAdminAct ? 1 : 0.5 }}
                            >
                              {adminBusy === `milestoneFailure:${m.id}` ? "Approving…" : "Approve Failure Payout"}
                            </button>
                          </div>

                          {milestoneFailureClaimResult[m.id]?.signature ? (
                            <div className={styles.actions} style={{ marginTop: 10, justifyContent: "flex-start" }}>
                              <button
                                className={styles.actionBtn}
                                type="button"
                                onClick={() => openExplorerTx(String(milestoneFailureClaimResult[m.id]?.signature))}
                              >
                                View Payout on Solscan
                              </button>
                            </div>
                          ) : null}
                        </div>
                      ) : null}

                      {canRelease ? (
                        <div className={styles.milestoneAction}>
                          <div className={styles.smallNote}>Claim release (escrow transfer to creator wallet).</div>
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
          <>
            <div className={styles.receiptBlock}>
              <div className={styles.receiptLabel}>Custody wallet (fees)</div>
              <div className={styles.receiptValue}>{String(props.authority ?? "")}</div>
            </div>
            <div className={styles.receiptBlock}>
              <div className={styles.receiptLabel}>Creator payout wallet</div>
              <div className={styles.receiptValue}>
                {(() => {
                  const pk = String(props.creatorPubkey ?? "");
                  const p = pk ? profilesByWallet[pk] : null;
                  const label = p?.displayName?.trim() ? String(p.displayName) : shortWallet(pk);
                  return pk ? (
                    <a className={styles.receiptValue} href={`/u/${encodeURIComponent(pk)}`}>
                      {p?.avatarUrl ? <img src={String(p.avatarUrl)} alt="" style={{ width: 18, height: 18, borderRadius: 999, objectFit: "cover", marginRight: 8, verticalAlign: "middle" }} /> : null}
                      <span style={{ verticalAlign: "middle" }}>{label}</span>
                    </a>
                  ) : (
                    ""
                  );
                })()}
              </div>
            </div>
          </>
        ) : (
          <>
            <div className={styles.receiptBlock}>
              <div className={styles.receiptLabel}>Authority (refund)</div>
              <div className={styles.receiptValue}>
                {(() => {
                  const pk = String(props.authority ?? "");
                  const p = pk ? profilesByWallet[pk] : null;
                  const label = p?.displayName?.trim() ? String(p.displayName) : shortWallet(pk);
                  return pk ? (
                    <a className={styles.receiptValue} href={`/u/${encodeURIComponent(pk)}`}>
                      {p?.avatarUrl ? <img src={String(p.avatarUrl)} alt="" style={{ width: 18, height: 18, borderRadius: 999, objectFit: "cover", marginRight: 8, verticalAlign: "middle" }} /> : null}
                      <span style={{ verticalAlign: "middle" }}>{label}</span>
                    </a>
                  ) : (
                    ""
                  );
                })()}
              </div>
            </div>
            <div className={styles.receiptBlock}>
              <div className={styles.receiptLabel}>Destination on failure</div>
              <div className={styles.receiptValue}>{props.destinationOnFail}</div>
            </div>
          </>
        )}

        {kind === "creator_reward" ? (
          <div className={styles.receiptBlock}>
            <div className={styles.receiptLabel}>Creator fee mode</div>
            <div className={styles.smallNote} style={{ marginTop: 8 }}>
              {String(props.creatorFeeMode ?? "assisted") === "managed" ? "Auto-escrow (managed)" : "Assisted (self-custody)"}
            </div>
            <div className={styles.smallNote} style={{ marginTop: 6 }}>
              {String(props.creatorFeeMode ?? "assisted") === "managed" ? "Fees can be auto-claimed and auto-escrowed." : "Deposits to escrow are voluntary in this mode."}
            </div>

            {(() => {
              const funded = Number(props.totalFundedLamports ?? 0);
              const total =
                props.milestoneTotalUnlockLamports != null
                  ? Number(props.milestoneTotalUnlockLamports)
                  : (props.milestones ?? []).reduce((acc, m) => acc + Number(m.unlockLamports || 0), 0);
              const pct = total > 0 ? clamp01(funded / total) : 0;
              return (
                <div style={{ marginTop: 12 }}>
                  <div className={styles.smallNote}>
                    Escrowed {fmtSol(funded)} / {fmtSol(total)} SOL ({Math.round(pct * 100)}%)
                  </div>
                  <div className={styles.complianceTrack} aria-hidden="true" style={{ marginTop: 8 }}>
                    <div className={styles.complianceFill} style={{ width: `${Math.round(pct * 100)}%` }} />
                  </div>
                </div>
              );
            })()}
          </div>
        ) : null}

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
              {isManagedCreatorFeeMode
                ? "Managed mode: fees are swept server-side from the custody wallet."
                : "Connect the creator wallet to check and claim fees."}
            </div>

            {pumpError ? <div className={styles.smallNote} style={{ marginTop: 10, color: "rgba(180, 40, 60, 0.86)" }}>{pumpError}</div> : null}

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
              <input
                className={styles.adminInput}
                value={pumpCreatorPubkeyInput}
                onChange={(e) => setPumpCreatorPubkeyInput(e.target.value)}
                placeholder="Custody wallet pubkey"
              />
              {!isManagedCreatorFeeMode ? (
                <button
                  className={styles.actionBtn}
                  onClick={connectPumpCreatorWallet}
                  disabled={pumpBusy != null}
                >
                  {pumpBusy === "connect" ? "Connecting…" : pumpWalletPubkey ? "Wallet Connected" : "Connect Wallet"}
                </button>
              ) : null}
              <button
                className={styles.actionBtn}
                onClick={pumpCheckStatus}
                disabled={pumpBusy != null}
              >
                {pumpBusy === "check" ? "Checking…" : "Check"}
              </button>
              {!isManagedCreatorFeeMode ? (
                <button
                  className={`${styles.actionBtn} ${styles.actionPrimary}`}
                  onClick={pumpClaimFees}
                  disabled={pumpBusy != null || !pumpWalletPubkey}
                >
                  {pumpBusy === "claim" ? "Claiming…" : "Claim"}
                </button>
              ) : null}
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
            <div className={styles.receiptLabel}>Token</div>
            <div className={styles.receiptValue}>
              {tokenLabel({ symbol: effectiveProjectProfile?.symbol, name: effectiveProjectProfile?.name, mint: props.tokenMint })}
            </div>
            <div className={styles.smallNote} style={{ marginTop: 8 }}>
              Mint{" "}
              <a
                href={`https://solscan.io/token/${encodeURIComponent(props.tokenMint)}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "rgba(255,255,255,0.72)", textDecoration: "none" }}
              >
                {shortWallet(props.tokenMint)}
              </a>
            </div>
          </div>
        ) : null}

      </aside>
    </div>
  );
}
