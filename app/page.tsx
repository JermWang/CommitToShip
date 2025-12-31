"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import bs58 from "bs58";

import ClosedBetaNotice from "./components/ClosedBetaNotice";

type ProfileSummary = {
  walletPubkey: string;
  displayName?: string | null;
  bio?: string | null;
  avatarUrl?: string | null;
};

type ProjectProfileSummary = {
  tokenMint: string;
  name?: string | null;
  symbol?: string | null;
  description?: string | null;
  websiteUrl?: string | null;
  xUrl?: string | null;
  telegramUrl?: string | null;
  discordUrl?: string | null;
  imageUrl?: string | null;
  metadataUri?: string | null;
};

type CreatorFeeMode = "managed" | "assisted";

type TimelineEventType =
  | "commitment_created"
  | "commitment_resolved_success"
  | "commitment_resolved_failure"
  | "reward_milestone_completed"
  | "reward_milestone_claimable"
  | "reward_milestone_released"
  | "reward_commitment_completed";

type TimelineEvent = {
  id: string;
  type: TimelineEventType;
  kind: "personal" | "creator_reward";
  timestampUnix: number;

  creatorFeeMode?: CreatorFeeMode;
  totalFundedLamports?: number;
  milestoneTotalUnlockLamports?: number;

  commitmentId: string;
  statement?: string;
  status: string;
  escrowPubkey: string;
  authority?: string;
  destinationOnFail?: string;
  creatorPubkey?: string;
  amountLamports?: number;
  unlockLamports?: number;
  milestoneId?: string;
  milestoneTitle?: string;
  txSig?: string;
};

type TimelineResponse = {
  events: TimelineEvent[];
  commitments?: CommitmentSummary[];
  nextCursor?: { beforeTs: number; beforeId: string } | null;
};

type CommitmentSummary = {
  id: string;
  statement?: string;
  kind?: "personal" | "creator_reward";
  authority: string;
  destinationOnFail: string;
  amountLamports: number;
  deadlineUnix: number;
  escrowPubkey: string;
  status: string;
  createdAtUnix: number;
  resolvedAtUnix?: number;
  resolvedTxSig?: string;

  creatorPubkey?: string | null;
  creatorFeeMode?: CreatorFeeMode | null;
  tokenMint?: string | null;
  totalFundedLamports?: number;
  unlockedLamports?: number;
  milestones?: Array<{ id: string; title: string; unlockLamports: number; status: string }>;
};

type CommitmentStatusResponse = {
  commitment: CommitmentSummary;
  reward?: {
    approvalCounts?: Record<string, number>;
    approvalThreshold?: number;
  };
  escrow: {
    balanceLamports: number;
    funded: boolean;
    expired: boolean;
    nowUnix: number;
  };
};

function lamportsToSol(lamports: number): string {
  const sol = lamports / 1_000_000_000;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(sol);
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function localInputToUnix(value: string): number {
  const d = new Date(value);
  return Math.floor(d.getTime() / 1000);
}

function shortWallet(pk: string): string {
  const s = String(pk ?? "");
  if (s.length <= 10) return s;
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function fmtCompact(n: number): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return "0";
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(Math.round(v));
}

function unixAgoShort(tsUnix: number, nowUnix: number): string {
  const d = Math.max(0, nowUnix - tsUnix);
  if (d < 60) return `${d}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86400)}d`;
}

function SocialIcon({ type }: { type: "x" | "telegram" | "discord" | "website" | "globe" }) {
  const paths: Record<string, string> = {
    x: "M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z",
    telegram: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69.01-.03.01-.14-.07-.2-.08-.06-.19-.04-.27-.02-.12.02-1.96 1.25-5.54 3.66-.52.36-1 .53-1.42.52-.47-.01-1.37-.26-2.03-.48-.82-.27-1.47-.42-1.42-.88.03-.24.37-.49 1.02-.74 3.98-1.73 6.64-2.87 7.97-3.43 3.8-1.57 4.59-1.85 5.1-1.85.11 0 .37.03.53.17.14.12.18.28.2.45-.01.07.01.24-.01.37z",
    discord: "M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z",
    website: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z",
    globe: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z",
  };
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false" className="socialIcon">
      <path d={paths[type] || paths.globe} fill="currentColor" />
    </svg>
  );
}

export default function Home() {
  const commitmentRef = useRef<HTMLDivElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const timelineHydratedRef = useRef(false);
  const timelineUrlRef = useRef<string>("");

  const router = useRouter();
  const searchParams = useSearchParams();

  const [tab, setTab] = useState<"landing" | "commit" | "discover">("landing");

  const [statement, setStatement] = useState("");
  const [commitKind, setCommitKind] = useState<"personal" | "creator_reward">("creator_reward");
  const [commitPath, setCommitPath] = useState<null | "automated" | "manual">(null);
  const [commitStep, setCommitStep] = useState(1);
  const [statementTouched, setStatementTouched] = useState(false);

  const [draftName, setDraftName] = useState("Atlas Bridge");
  const [draftSymbol, setDraftSymbol] = useState("ATLAS");
  const [draftDescription, setDraftDescription] = useState(
    "Bridge monitor + proof relay with escrowed milestones and on-chain receipts. Built for uptime, clarity, and post-launch accountability."
  );
  const [draftImageUrl, setDraftImageUrl] = useState("https://images.unsplash.com/photo-1520607162513-77705c0f0d4a?auto=format&fit=crop&w=512&q=80");
  const [draftWebsiteUrl, setDraftWebsiteUrl] = useState("https://atlasbridge.io");
  const [draftXUrl, setDraftXUrl] = useState("https://x.com/atlasbridge");
  const [draftTelegramUrl, setDraftTelegramUrl] = useState("");
  const [draftDiscordUrl, setDraftDiscordUrl] = useState("https://discord.gg/atlasbridge");
  const [authority, setAuthority] = useState("");
  const [destinationOnFail, setDestinationOnFail] = useState("");
  const [amountSol, setAmountSol] = useState("0.01");
  const [creatorPubkey, setCreatorPubkey] = useState("");
  const [rewardTokenMint, setRewardTokenMint] = useState("");
  const [rewardCreatorFeeMode, setRewardCreatorFeeMode] = useState<CreatorFeeMode>("assisted");
  const [rewardMilestones, setRewardMilestones] = useState<Array<{ title: string; unlockSol: string }>>([
    { title: "Ship milestone 1", unlockSol: "0.25" },
    { title: "Ship milestone 2", unlockSol: "0.25" },
  ]);
  const [deadlineLocal, setDeadlineLocal] = useState("");

  const [devWalletPubkey, setDevWalletPubkey] = useState<string | null>(null);
  const [devVerifyBusy, setDevVerifyBusy] = useState<string | null>(null);
  const [devVerify, setDevVerify] = useState<null | { walletPubkey: string; signatureB58: string; timestampUnix: number }>(null);
  const [devVerifyResult, setDevVerifyResult] = useState<any>(null);

  const [adminWalletPubkey, setAdminWalletPubkey] = useState<string | null>(null);
  const [adminAuthBusy, setAdminAuthBusy] = useState<string | null>(null);
  const [adminAuthError, setAdminAuthError] = useState<string | null>(null);

  const [projectEditMint, setProjectEditMint] = useState("");
  const [projectEditBusy, setProjectEditBusy] = useState<string | null>(null);
  const [projectEditError, setProjectEditError] = useState<string | null>(null);
  const [projectEditResult, setProjectEditResult] = useState<any>(null);

  const [projectEditName, setProjectEditName] = useState("");
  const [projectEditSymbol, setProjectEditSymbol] = useState("");
  const [projectEditDescription, setProjectEditDescription] = useState("");
  const [projectEditWebsite, setProjectEditWebsite] = useState("");
  const [projectEditX, setProjectEditX] = useState("");
  const [projectEditTelegram, setProjectEditTelegram] = useState("");
  const [projectEditDiscord, setProjectEditDiscord] = useState("");
  const [projectEditImageUrl, setProjectEditImageUrl] = useState("");
  const [projectEditMetadataUri, setProjectEditMetadataUri] = useState("");

  const [commitments, setCommitments] = useState<CommitmentSummary[]>([]);
  const [expanded, setExpanded] = useState<Record<string, CommitmentStatusResponse | null>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [commitmentsLoading, setCommitmentsLoading] = useState(false);

  const [timelineEvents, setTimelineEvents] = useState<TimelineEvent[]>([]);
  const [timelineCommitments, setTimelineCommitments] = useState<CommitmentSummary[]>([]);
  const [timelineExpanded, setTimelineExpanded] = useState<Record<string, boolean>>({});
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineLoadingMore, setTimelineLoadingMore] = useState(false);
  const [timelineNextCursor, setTimelineNextCursor] = useState<null | { beforeTs: number; beforeId: string }>(null);
  const [timelineFilter, setTimelineFilter] = useState<"curated" | "all" | "reward" | "milestones" | "completed">("curated");
  const [timelineQuery, setTimelineQuery] = useState("");
  const [timelineKindFilter, setTimelineKindFilter] = useState<"all" | "personal" | "reward">("all");
  const [timelineStatusFilter, setTimelineStatusFilter] = useState<"all" | "active" | "funded" | "expired" | "success" | "failure">("all");
  const [timelineSort, setTimelineSort] = useState<"newest" | "oldest" | "amount_desc">("newest");
  const [timelineCopied, setTimelineCopied] = useState<string | null>(null);

  const [profilesByWallet, setProfilesByWallet] = useState<Record<string, ProfileSummary>>({});
  const [projectsByMint, setProjectsByMint] = useState<Record<string, ProjectProfileSummary>>({});

  const amountLamports = useMemo(() => {
    const parsed = Number(amountSol);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return Math.floor(parsed * 1_000_000_000);
  }, [amountSol]);

  const rewardMilestonesParsed = useMemo(() => {
    return rewardMilestones.map((m) => {
      const title = m.title.trim();
      const unlockSol = Number(m.unlockSol);
      const unlockLamports = Number.isFinite(unlockSol) && unlockSol > 0 ? Math.floor(unlockSol * 1_000_000_000) : 0;
      return { title, unlockSolRaw: m.unlockSol, unlockLamports };
    });
  }, [rewardMilestones]);

  const rewardTotalUnlockLamports = useMemo(() => {
    return rewardMilestonesParsed.reduce((sum, m) => sum + (m.unlockLamports || 0), 0);
  }, [rewardMilestonesParsed]);

  const commitSteps = useMemo(() => {
    if (commitPath == null) return ["Choose"];
    if (commitKind === "personal") return ["Basics", "Details", "Funding", "Review"];
    if (commitPath === "automated") return ["Asset", "Fees", "Milestones", "Confirm"];
    return ["Asset", "Milestones", "Confirm"];
  }, [commitKind, commitPath]);

  const maxCommitStep = commitSteps.length;

  const commitIssues = useMemo(() => {
    if (commitPath == null) return [];
    const issues: string[] = [];

    if (!statement.trim().length) issues.push("Add a clear statement (this becomes the public title).");

    if (commitKind === "personal") {
      if (!authority.trim().length) issues.push("Enter your refund wallet address.");
      if (!destinationOnFail.trim().length) issues.push("Enter a destination on failure.");
      if (amountLamports <= 0) issues.push("Enter a lock amount > 0.");
      if (!deadlineLocal.trim().length) issues.push("Select a deadline.");
    } else {
      if (!creatorPubkey.trim().length) issues.push("Enter the creator wallet address.");
      if (!rewardTokenMint.trim().length) issues.push("Enter the token mint address.");
      if (!devVerify) issues.push("Verify your dev wallet on-chain.");
      const anyMilestones = rewardMilestonesParsed.some((m) => m.title.length > 0);
      if (!anyMilestones) issues.push("Add at least one milestone title.");
      const anyAmounts = rewardMilestonesParsed.some((m) => m.unlockLamports > 0);
      if (!anyAmounts) issues.push("Set an unlock amount for at least one milestone.");
    }

    return issues;
  }, [amountLamports, authority, commitKind, commitPath, creatorPubkey, deadlineLocal, destinationOnFail, devVerify, rewardMilestonesParsed, rewardTokenMint, statement]);

  function datetimeLocalFromUnix(tsUnix: number): string {
    const d = new Date(tsUnix * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function setDeadlinePreset(hoursFromNow: number) {
    const nowUnix = Math.floor(Date.now() / 1000);
    setDeadlineLocal(datetimeLocalFromUnix(nowUnix + hoursFromNow * 60 * 60));
  }

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

  async function apiGet<T>(path: string): Promise<T> {
    const res = await fetch(path, { cache: "no-store" });
    const json = await readJsonSafe(res);
    if (!res.ok) throw new Error(json?.error ?? `Request failed (${res.status})`);
    return json as T;
  }

  async function apiPost<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: body == null ? undefined : JSON.stringify(body),
    });
    const json = await readJsonSafe(res);
    if (!res.ok) throw new Error(json?.error ?? `Request failed (${res.status})`);
    return json as T;
  }

  async function adminPost<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      credentials: "include",
      body: body == null ? undefined : JSON.stringify(body),
    });
    const json = await readJsonSafe(res);
    if (!res.ok) throw new Error(json?.error ?? `Request failed (${res.status})`);
    return json as T;
  }

  async function saveProjectProfileForMint() {
    if (commitKind !== "creator_reward") return;
    const mint = rewardTokenMint.trim();
    if (!mint) return;
    if (!devVerify) throw new Error("Verify your dev wallet on-chain first");

    const body = {
      name: draftName.trim().length ? draftName.trim() : null,
      symbol: draftSymbol.trim().length ? draftSymbol.trim() : null,
      description: draftDescription.trim().length ? draftDescription.trim() : null,
      websiteUrl: draftWebsiteUrl.trim().length ? draftWebsiteUrl.trim() : null,
      xUrl: draftXUrl.trim().length ? draftXUrl.trim() : null,
      telegramUrl: draftTelegramUrl.trim().length ? draftTelegramUrl.trim() : null,
      discordUrl: draftDiscordUrl.trim().length ? draftDiscordUrl.trim() : null,
      imageUrl: draftImageUrl.trim().length ? draftImageUrl.trim() : null,
      devVerify,
    };

    await apiPost(`/api/projects/${encodeURIComponent(mint)}`, body);
  }

  function getSolanaProvider(): any {
    return (window as any)?.solana;
  }

  async function connectDevWallet() {
    setDevVerifyResult(null);
    setDevVerify(null);
    setDevVerifyBusy("connect");
    try {
      const provider = getSolanaProvider();
      if (!provider?.connect) throw new Error("Wallet provider not found");
      const res = await provider.connect();
      const pk = (res?.publicKey ?? provider.publicKey)?.toBase58?.();
      if (!pk) throw new Error("Failed to read wallet public key");
      setDevWalletPubkey(pk);
      setCreatorPubkey(pk);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDevVerifyBusy(null);
    }
  }

  async function verifyDevWallet() {
    setDevVerifyResult(null);
    setDevVerify(null);
    setDevVerifyBusy("verify");
    try {
      const provider = getSolanaProvider();
      if (!provider?.publicKey) throw new Error("Connect wallet first");
      if (!provider.signMessage) throw new Error("Wallet does not support message signing");

      const tokenMint = rewardTokenMint.trim();
      if (!tokenMint) throw new Error("Token mint required");

      const walletPubkey = provider.publicKey.toBase58();
      const timestampUnix = Math.floor(Date.now() / 1000);
      const message = `Commit To Ship\nDev Verification\nMint: ${tokenMint}\nWallet: ${walletPubkey}\nTimestamp: ${timestampUnix}`;

      const signed = await provider.signMessage(new TextEncoder().encode(message), "utf8");
      const signatureBytes: Uint8Array = signed?.signature ?? signed;
      const signatureB58 = bs58.encode(signatureBytes);

      const result = await apiPost("/api/dev-verify", {
        tokenMint,
        walletPubkey,
        signatureB58,
        timestampUnix,
      });

      setDevVerify({ walletPubkey, signatureB58, timestampUnix });
      setDevVerifyResult(result);
      setDevWalletPubkey(walletPubkey);
      setCreatorPubkey(walletPubkey);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDevVerifyBusy(null);
    }
  }

  async function refreshAdminSession() {
    const res = await fetch("/api/admin/me", { cache: "no-store", credentials: "include" });
    const json = await readJsonSafe(res);
    if (!res.ok) throw new Error(json?.error ?? `Request failed (${res.status})`);
    const wallet = typeof json?.walletPubkey === "string" && json.walletPubkey.trim().length ? json.walletPubkey.trim() : null;
    setAdminWalletPubkey(wallet);
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

      const nonceRes = await apiPost<{ walletPubkey: string; nonce: string; message: string }>("/api/admin/nonce", { walletPubkey: pk });
      const signed = await provider.signMessage(new TextEncoder().encode(nonceRes.message), "utf8");
      const signatureBytes: Uint8Array = signed?.signature ?? signed;
      const signatureB58 = bs58.encode(signatureBytes);

      await apiPost("/api/admin/login", {
        walletPubkey: nonceRes.walletPubkey,
        nonce: nonceRes.nonce,
        signatureB58,
      });

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
      await apiPost("/api/admin/logout", {});
      setAdminWalletPubkey(null);
    } catch (e) {
      setAdminAuthError((e as Error).message);
    } finally {
      setAdminAuthBusy(null);
    }
  }

  function normText(value: string, maxLen: number): string | null {
    const s = String(value ?? "").trim();
    if (!s.length) return null;
    if (s.length > maxLen) throw new Error(`value too long (max ${maxLen})`);
    return s;
  }

  function normUrl(value: string): string | null {
    const s = String(value ?? "").trim();
    if (!s.length) return null;
    if (!/^https?:\/\//i.test(s)) throw new Error("url must be http(s)");
    return s;
  }

  async function adminLoadProjectProfile() {
    setProjectEditError(null);
    setProjectEditResult(null);
    setProjectEditBusy("load");
    try {
      const mint = projectEditMint.trim();
      if (!mint) throw new Error("Token mint required");

      const res = await fetch(`/api/projects/${encodeURIComponent(mint)}`, { cache: "no-store" });
      const json = await readJsonSafe(res);
      if (!res.ok) throw new Error(json?.error ?? `Request failed (${res.status})`);

      const project = json?.project ?? null;

      setProjectEditName(project?.name != null ? String(project.name) : "");
      setProjectEditSymbol(project?.symbol != null ? String(project.symbol) : "");
      setProjectEditDescription(project?.description != null ? String(project.description) : "");
      setProjectEditWebsite(project?.websiteUrl != null ? String(project.websiteUrl) : "");
      setProjectEditX(project?.xUrl != null ? String(project.xUrl) : "");
      setProjectEditTelegram(project?.telegramUrl != null ? String(project.telegramUrl) : "");
      setProjectEditDiscord(project?.discordUrl != null ? String(project.discordUrl) : "");
      setProjectEditImageUrl(project?.imageUrl != null ? String(project.imageUrl) : "");
      setProjectEditMetadataUri(project?.metadataUri != null ? String(project.metadataUri) : "");

      if (project?.tokenMint) {
        setProjectsByMint((prev) => {
          const next = { ...prev };
          const tm = String(project.tokenMint);
          next[tm] = {
            tokenMint: tm,
            name: project?.name ?? null,
            symbol: project?.symbol ?? null,
            description: project?.description ?? null,
            websiteUrl: project?.websiteUrl ?? null,
            xUrl: project?.xUrl ?? null,
            telegramUrl: project?.telegramUrl ?? null,
            discordUrl: project?.discordUrl ?? null,
            imageUrl: project?.imageUrl ?? null,
            metadataUri: project?.metadataUri ?? null,
          };
          return next;
        });
      }

      setProjectEditResult({ ok: true, action: "load", found: Boolean(project) });
    } catch (e) {
      setProjectEditError((e as Error).message);
    } finally {
      setProjectEditBusy(null);
    }
  }

  async function adminSaveProjectProfile() {
    setProjectEditError(null);
    setProjectEditResult(null);
    setProjectEditBusy("save");
    try {
      if (!adminWalletPubkey) throw new Error("Admin sign-in required");
      const mint = projectEditMint.trim();
      if (!mint) throw new Error("Token mint required");

      const body = {
        name: normText(projectEditName, 48),
        symbol: normText(projectEditSymbol, 16),
        description: normText(projectEditDescription, 600),
        websiteUrl: normUrl(projectEditWebsite),
        xUrl: normUrl(projectEditX),
        telegramUrl: normUrl(projectEditTelegram),
        discordUrl: normUrl(projectEditDiscord),
        imageUrl: normUrl(projectEditImageUrl),
        metadataUri: normUrl(projectEditMetadataUri),
      };

      const saved = await apiPost(`/api/projects/${encodeURIComponent(mint)}`, body);
      const project = (saved as any)?.project ?? null;

      if (project?.tokenMint) {
        setProjectsByMint((prev) => {
          const next = { ...prev };
          const tm = String(project.tokenMint);
          next[tm] = {
            tokenMint: tm,
            name: project?.name ?? null,
            symbol: project?.symbol ?? null,
            description: project?.description ?? null,
            websiteUrl: project?.websiteUrl ?? null,
            xUrl: project?.xUrl ?? null,
            telegramUrl: project?.telegramUrl ?? null,
            discordUrl: project?.discordUrl ?? null,
            imageUrl: project?.imageUrl ?? null,
            metadataUri: project?.metadataUri ?? null,
          };
          return next;
        });
      }

      setProjectEditResult({ ok: true, action: "save" });
    } catch (e) {
      setProjectEditError((e as Error).message);
    } finally {
      setProjectEditBusy(null);
    }
  }

  async function loadTimeline() {
    setTimelineLoading(true);
    try {
      const data = await apiGet<TimelineResponse>(`/api/timeline?limit=120`);
      setTimelineEvents(Array.isArray(data.events) ? data.events : []);
      setTimelineCommitments(Array.isArray(data.commitments) ? data.commitments : []);
      setTimelineNextCursor(data?.nextCursor && typeof data.nextCursor === "object" ? (data.nextCursor as any) : null);
      setTimelineExpanded({});
    } finally {
      setTimelineLoading(false);
    }
  }

  async function loadMoreTimeline() {
    if (!timelineNextCursor) return;
    if (timelineLoading || timelineLoadingMore) return;

    setTimelineLoadingMore(true);
    try {
      const c = timelineNextCursor;
      const qs = new URLSearchParams();
      qs.set("limit", "120");
      qs.set("beforeTs", String(c.beforeTs));
      qs.set("beforeId", String(c.beforeId));
      qs.set("includeCommitments", "0");

      const data = await apiGet<TimelineResponse>(`/api/timeline?${qs.toString()}`);
      const more: TimelineEvent[] = Array.isArray(data.events) ? data.events : [];

      setTimelineEvents((prev) => {
        const seen = new Set(prev.map((e) => e.id));
        const merged = prev.slice();
        for (const e of more) {
          if (!seen.has(e.id)) merged.push(e);
        }
        return merged;
      });

      setTimelineNextCursor(data?.nextCursor && typeof data.nextCursor === "object" ? (data.nextCursor as any) : null);
    } finally {
      setTimelineLoadingMore(false);
    }
  }

  async function loadProfilesForWallets(walletPubkeys: string[]) {
    const cleaned = Array.from(new Set(walletPubkeys.map((s) => String(s ?? "").trim()).filter(Boolean)));
    const missing = cleaned.filter((w) => !profilesByWallet[w]);
    if (missing.length === 0) return;

    const res = await fetch("/api/profiles/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ walletPubkeys: missing }),
    });

    const json = await readJsonSafe(res);
    if (!res.ok) return;

    const profiles = Array.isArray(json?.profiles) ? (json.profiles as ProfileSummary[]) : [];
    if (!profiles.length) return;

    setProfilesByWallet((prev) => {
      const next = { ...prev };
      for (const p of profiles) {
        if (!p?.walletPubkey) continue;
        next[String(p.walletPubkey)] = {
          walletPubkey: String(p.walletPubkey),
          displayName: p.displayName ?? null,
          bio: (p as any)?.bio ?? null,
          avatarUrl: p.avatarUrl ?? null,
        };
      }
      return next;
    });
  }

  async function loadProjectsForMints(tokenMints: string[]) {
    const cleaned = Array.from(new Set(tokenMints.map((s) => String(s ?? "").trim()).filter(Boolean)));
    const missing = cleaned.filter((m) => !projectsByMint[m]);
    if (missing.length === 0) return;

    const res = await fetch("/api/projects/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tokenMints: missing }),
    });

    const json = await readJsonSafe(res);
    if (!res.ok) return;

    const projects = Array.isArray(json?.projects) ? (json.projects as ProjectProfileSummary[]) : [];
    if (!projects.length) return;

    setProjectsByMint((prev) => {
      const next = { ...prev };
      for (const p of projects) {
        if (!p?.tokenMint) continue;
        const mint = String(p.tokenMint);
        next[mint] = {
          tokenMint: mint,
          name: (p as any)?.name ?? null,
          symbol: (p as any)?.symbol ?? null,
          description: (p as any)?.description ?? null,
          websiteUrl: (p as any)?.websiteUrl ?? null,
          xUrl: (p as any)?.xUrl ?? null,
          telegramUrl: (p as any)?.telegramUrl ?? null,
          discordUrl: (p as any)?.discordUrl ?? null,
          imageUrl: (p as any)?.imageUrl ?? null,
          metadataUri: (p as any)?.metadataUri ?? null,
        };
      }
      return next;
    });
  }

  const timelineCommitmentsById = useMemo(() => {
    const m: Record<string, CommitmentSummary> = {};
    for (const c of timelineCommitments) {
      if (!c?.id) continue;
      m[String(c.id)] = c;
    }
    return m;
  }, [timelineCommitments]);

  const timelineEventsByCommitmentId = useMemo(() => {
    const m: Record<string, TimelineEvent[]> = {};
    for (const e of timelineEvents) {
      const id = String((e as any)?.commitmentId ?? "").trim();
      if (!id) continue;
      if (!m[id]) m[id] = [];
      m[id].push(e);
    }
    for (const k of Object.keys(m)) {
      m[k].sort((a, b) => Number(b.timestampUnix ?? 0) - Number(a.timestampUnix ?? 0) || String(b.id).localeCompare(String(a.id)));
    }
    return m;
  }, [timelineEvents]);

  type DiscoverCard = {
    key: string;
    isMock: boolean;
    commitmentId: string;
    tokenMint: string;
    projectName: string;
    projectSymbol: string;
    projectImageUrl: string;
    projectDesc: string;
    websiteUrl: string;
    xUrl: string;
    telegramUrl: string;
    discordUrl: string;
    statement: string;
    status: string;
    creatorFeeMode: string;
    escrowedLamports: number;
    targetLamports: number;
    milestonesTotal: number;
    milestonesDone: number;
    milestonesReleased: number;
    lastActivityUnix: number;
    events24h: number;
    events7d: number;
  };

  const discoverCards: DiscoverCard[] = useMemo(() => {
    const nowUnix = Math.floor(Date.now() / 1000);

    const cards: DiscoverCard[] = [];

    for (const c of timelineCommitments) {
      const id = String(c?.id ?? "").trim();
      if (!id) continue;

      const kind = String(c?.kind ?? "").trim();
      if (timelineKindFilter === "reward" && kind !== "creator_reward") continue;
      if (timelineKindFilter === "personal" && kind !== "personal") continue;

      const tokenMint = String(c?.tokenMint ?? "").trim();
      if (kind === "creator_reward" && !tokenMint) continue;

      const status = String(c?.status ?? "").trim();
      if (timelineStatusFilter !== "all") {
        const s = status.toLowerCase();
        if (timelineStatusFilter === "active" && s !== "active") continue;
        if (timelineStatusFilter === "funded" && s !== "funded") continue;
        if (timelineStatusFilter === "expired" && s !== "expired") continue;
        if (timelineStatusFilter === "success" && s !== "resolved_success") continue;
        if (timelineStatusFilter === "failure" && s !== "resolved_failure" && s !== "failed") continue;
      }

      const events = timelineEventsByCommitmentId[id] ?? [];
      const lastActivityUnix = events.length ? Number(events[0]?.timestampUnix ?? 0) : Number(c?.createdAtUnix ?? 0);

      const events24h = events.filter((e) => nowUnix - Number(e.timestampUnix ?? 0) <= 86400).length;
      const events7d = events.filter((e) => nowUnix - Number(e.timestampUnix ?? 0) <= 86400 * 7).length;

      const milestones = Array.isArray(c?.milestones) ? c.milestones : [];
      const milestonesTotal = milestones.length;
      const milestonesDone = milestones.filter((m) => {
        const s = String((m as any)?.status ?? "").toLowerCase();
        return s === "completed" || s === "claimable" || s === "released";
      }).length;
      const milestonesReleased = milestones.filter((m) => String((m as any)?.status ?? "").toLowerCase() === "released").length;

      const targetLamports = milestones.reduce((acc, m) => acc + Number((m as any)?.unlockLamports ?? 0), 0);
      const escrowedLamports = Number(c?.totalFundedLamports ?? 0);

      const project = tokenMint ? projectsByMint[tokenMint] : undefined;
      const projectName = project?.name != null ? String(project.name) : "";
      const projectSymbol = project?.symbol != null ? String(project.symbol) : "";
      const projectImageUrl = project?.imageUrl != null ? String(project.imageUrl) : "";
      const projectDesc = project?.description != null ? String(project.description) : "";
      const websiteUrl = project?.websiteUrl != null ? String(project.websiteUrl) : "";
      const xUrl = project?.xUrl != null ? String(project.xUrl) : "";
      const telegramUrl = project?.telegramUrl != null ? String(project.telegramUrl) : "";
      const discordUrl = project?.discordUrl != null ? String(project.discordUrl) : "";

      const statement = String(c?.statement ?? "").trim();
      const creatorFeeMode = String(c?.creatorFeeMode ?? "assisted");

      const q = timelineQuery.trim().toLowerCase();
      if (q.length) {
        const hay = `${id} ${tokenMint} ${statement} ${projectName} ${projectSymbol}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }

      if (timelineFilter === "reward" && kind !== "creator_reward") continue;
      if (timelineFilter === "completed") {
        const s = status.toLowerCase();
        if (!(s.includes("resolved_success") || s.includes("completed"))) continue;
      }
      if (timelineFilter === "milestones") {
        if (milestonesTotal <= 0) continue;
      }

      cards.push({
        key: `real:${id}`,
        isMock: false,
        commitmentId: id,
        tokenMint,
        projectName,
        projectSymbol,
        projectImageUrl,
        projectDesc,
        websiteUrl,
        xUrl,
        telegramUrl,
        discordUrl,
        statement,
        status,
        creatorFeeMode,
        escrowedLamports,
        targetLamports,
        milestonesTotal,
        milestonesDone,
        milestonesReleased,
        lastActivityUnix,
        events24h,
        events7d,
      });
    }

    const sorted = cards.slice();
    if (timelineSort === "amount_desc") {
      sorted.sort((a, b) => b.escrowedLamports - a.escrowedLamports || b.lastActivityUnix - a.lastActivityUnix);
    } else if (timelineSort === "oldest") {
      sorted.sort((a, b) => a.lastActivityUnix - b.lastActivityUnix || a.key.localeCompare(b.key));
    } else {
      sorted.sort((a, b) => b.lastActivityUnix - a.lastActivityUnix || b.key.localeCompare(a.key));
    }

    const need = Math.max(0, 24 - sorted.length);
    if (need === 0) return sorted;

    const mock: DiscoverCard[] = [
      {
        key: "mock:atlas-bridge",
        isMock: true,
        commitmentId: "",
        tokenMint: "ATLAS9o9w4xD4mQdK9mZ2bYJrQyR2YVx7QxF1X9mZp1",
        projectName: "Atlas Bridge",
        projectSymbol: "ATLAS",
        projectImageUrl: "",
        projectDesc: "A production-grade bridge monitor + proof relay for Solana-native rollups. Audited, milestone-based escrow.",
        websiteUrl: "https://atlasbridge.io",
        xUrl: "https://x.com/atlasbridge",
        telegramUrl: "",
        discordUrl: "https://discord.gg/atlasbridge",
        statement: "Ship proof relay v1 + public uptime dashboard",
        status: "active",
        creatorFeeMode: "managed",
        escrowedLamports: 28_500_000_000,
        targetLamports: 40_000_000_000,
        milestonesTotal: 4,
        milestonesDone: 2,
        milestonesReleased: 1,
        lastActivityUnix: nowUnix - 60 * 22,
        events24h: 7,
        events7d: 18,
      },
      {
        key: "mock:clearclip",
        isMock: true,
        commitmentId: "",
        tokenMint: "CLIP9o9w4xD4mQdK9mZ2bYJrQyR2YVx7QxF1X9mZp2",
        projectName: "ClearClip",
        projectSymbol: "CLIP",
        projectImageUrl: "",
        projectDesc: "On-chain clip licensing for creators: escrowed payouts, milestone verification, and transparent revshare.",
        websiteUrl: "https://clearclip.app",
        xUrl: "https://x.com/clearclip",
        telegramUrl: "https://t.me/clearclip",
        discordUrl: "",
        statement: "Integrate payout escrow + publish licensing registry",
        status: "funded",
        creatorFeeMode: "assisted",
        escrowedLamports: 12_200_000_000,
        targetLamports: 12_200_000_000,
        milestonesTotal: 3,
        milestonesDone: 1,
        milestonesReleased: 0,
        lastActivityUnix: nowUnix - 3600 * 3,
        events24h: 4,
        events7d: 11,
      },
      {
        key: "mock:signalforge",
        isMock: true,
        commitmentId: "",
        tokenMint: "SIG9o9w4xD4mQdK9mZ2bYJrQyR2YVx7QxF1X9mZp3",
        projectName: "SignalForge",
        projectSymbol: "SGF",
        projectImageUrl: "",
        projectDesc: "A high-throughput alerts engine for on-chain events. Focus: latency, reliability, and transparent service SLAs.",
        websiteUrl: "https://signalforge.dev",
        xUrl: "https://x.com/signalforge",
        telegramUrl: "",
        discordUrl: "https://discord.gg/signalforge",
        statement: "Ship 50ms pipeline + public incident log",
        status: "active",
        creatorFeeMode: "managed",
        escrowedLamports: 6_300_000_000,
        targetLamports: 25_000_000_000,
        milestonesTotal: 5,
        milestonesDone: 1,
        milestonesReleased: 0,
        lastActivityUnix: nowUnix - 3600 * 9,
        events24h: 2,
        events7d: 8,
      },
      {
        key: "mock:shipyard-os",
        isMock: true,
        commitmentId: "",
        tokenMint: "SHIP9o9w4xD4mQdK9mZ2bYJrQyR2YVx7QxF1X9mZp4",
        projectName: "Shipyard OS",
        projectSymbol: "YARD",
        projectImageUrl: "",
        projectDesc: "A lightweight, opinionated release system for crypto teams: escrowed milestones + deterministic deployment receipts.",
        websiteUrl: "https://shipyardos.com",
        xUrl: "https://x.com/shipyardos",
        telegramUrl: "",
        discordUrl: "",
        statement: "Deliver staged release receipts + admin audit trail",
        status: "completed",
        creatorFeeMode: "managed",
        escrowedLamports: 55_000_000_000,
        targetLamports: 55_000_000_000,
        milestonesTotal: 4,
        milestonesDone: 4,
        milestonesReleased: 4,
        lastActivityUnix: nowUnix - 86400 * 2,
        events24h: 0,
        events7d: 6,
      },
    ];

    const fill: DiscoverCard[] = [];
    for (let i = 0; i < need; i++) {
      const base = mock[i % mock.length];
      fill.push({
        ...base,
        key: `${base.key}:${i}`,
        lastActivityUnix: base.lastActivityUnix - i * 2700,
        escrowedLamports: Math.max(0, base.escrowedLamports - i * 250_000_000),
        events24h: Math.max(0, base.events24h - (i % 3)),
        events7d: Math.max(0, base.events7d - (i % 5)),
      });
    }

    return sorted.concat(fill);
  }, [projectsByMint, timelineCommitments, timelineEventsByCommitmentId, timelineFilter, timelineKindFilter, timelineQuery, timelineSort, timelineStatusFilter]);

  const discoverStats = useMemo(() => {
    const real = discoverCards.filter((c) => !c.isMock);
    const totalEscrowedLamports = real.reduce((acc, c) => acc + Number(c.escrowedLamports || 0), 0);
    const active = real.filter((c) => String(c.status).toLowerCase() === "active").length;
    const funded = real.filter((c) => String(c.status).toLowerCase() === "funded").length;
    const shipped = real.filter((c) => {
      const s = String(c.status).toLowerCase();
      return s.includes("resolved_success") || s.includes("completed");
    }).length;
    return {
      realCount: real.length,
      active,
      funded,
      shipped,
      escrowedSol: totalEscrowedLamports / 1_000_000_000,
    };
  }, [discoverCards]);

  function humanTime(tsUnix: number): string {
    try {
      const d = new Date(tsUnix * 1000);
      return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    } catch {
      return String(tsUnix);
    }
  }

  function typeLabel(t: TimelineEventType): string {
    switch (t) {
      case "commitment_created":
        return "Commitment created";
      case "commitment_resolved_success":
        return "Shipped";
      case "commitment_resolved_failure":
        return "Failed";
      case "reward_milestone_completed":
        return "Milestone completed";
      case "reward_milestone_claimable":
        return "Unlock window";
      case "reward_milestone_released":
        return "Reward released";
      case "reward_commitment_completed":
        return "Reward commitment completed";
      default:
        return t;
    }
  }

  function fmtSol(lamports?: number): string {
    if (lamports == null) return "";
    const v = Number(lamports);
    if (!Number.isFinite(v)) return "";
    const sol = v / 1_000_000_000;
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(sol);
  }

  async function copyTimeline(text: string, key: string) {
    try {
      if (!window.isSecureContext || !navigator.clipboard?.writeText) {
        throw new Error("Clipboard access is not available in this context");
      }
      await navigator.clipboard.writeText(text);
      setTimelineCopied(key);
      window.setTimeout(() => setTimelineCopied((prev) => (prev === key ? null : prev)), 900);
    } catch {
      setTimelineCopied(null);
    }
  }

  const filteredTimeline = useMemo(() => {
    const base = timelineEvents.slice();
    const curatedTypes: TimelineEventType[] = [
      "commitment_resolved_success",
      "commitment_resolved_failure",
      "reward_milestone_completed",
      "reward_milestone_released",
      "reward_commitment_completed",
      "commitment_created",
    ];

    const curated = base.filter((e) => {
      if (!curatedTypes.includes(e.type)) return false;
      if (e.type === "commitment_created" && e.kind === "personal") return false;
      return true;
    });

    let list = timelineFilter === "curated" ? curated : base;

    if (timelineFilter === "reward") list = list.filter((e) => e.kind === "creator_reward");
    if (timelineFilter === "milestones") list = list.filter((e) => e.type.startsWith("reward_milestone"));
    if (timelineFilter === "completed") {
      list = list.filter((e) => e.type === "commitment_resolved_success" || e.type === "reward_commitment_completed");
    }

    if (timelineKindFilter === "personal") list = list.filter((e) => e.kind === "personal");
    if (timelineKindFilter === "reward") list = list.filter((e) => e.kind === "creator_reward");

    if (timelineStatusFilter !== "all") {
      const needle = timelineStatusFilter.toLowerCase();
      list = list.filter((e) => String(e.status ?? "").toLowerCase().includes(needle));
    }

    const q = timelineQuery.trim().toLowerCase();
    if (q.length) {
      list = list.filter((e) => {
        const hay = [
          e.statement,
          e.commitmentId,
          e.escrowPubkey,
          e.creatorPubkey,
          e.milestoneTitle,
          e.txSig,
          e.type,
          e.status,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      });
    }

    const amountForSort = (e: TimelineEvent) => Number(e.unlockLamports ?? e.amountLamports ?? 0);

    if (timelineSort === "oldest") list.sort((a, b) => a.timestampUnix - b.timestampUnix);
    else if (timelineSort === "amount_desc") list.sort((a, b) => amountForSort(b) - amountForSort(a));
    else list.sort((a, b) => b.timestampUnix - a.timestampUnix);

    return list;
  }, [timelineEvents, timelineFilter, timelineKindFilter, timelineQuery, timelineSort, timelineStatusFilter]);

  async function loadCommitments() {
    setCommitmentsLoading(true);
    try {
      const { commitments } = await apiGet<{ commitments: CommitmentSummary[] }>("/api/commitments");
      setCommitments(commitments);
    } finally {
      setCommitmentsLoading(false);
    }
  }

  async function createCommitment() {
    setError(null);
    setBusy("create");
    try {
      const body = (() => {
        if (commitKind === "creator_reward") {
          const milestones = rewardMilestones
            .map((m) => ({
              title: m.title.trim(),
              unlockLamports: Math.floor(Number(m.unlockSol) * 1_000_000_000),
            }))
            .filter((m) => m.title.length > 0);

          return {
            kind: "creator_reward" as const,
            statement,
            creatorPubkey: creatorPubkey.trim(),
            creatorFeeMode: rewardCreatorFeeMode,
            tokenMint: rewardTokenMint.trim().length ? rewardTokenMint.trim() : undefined,
            devVerify,
            milestones,
          };
        }

        const deadlineUnix = localInputToUnix(deadlineLocal);
        return {
          kind: "personal" as const,
          statement,
          authority,
          destinationOnFail,
          amountLamports,
          deadlineUnix,
        };
      })();
      if (commitKind === "creator_reward") {
        await saveProjectProfileForMint();
      }

      const created = await apiPost<{ id: string }>("/api/commitments", body);
      router.push(`/commit/${created.id}`);
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    if (statementTouched) return;
    if (commitKind !== "creator_reward") return;
    if (commitPath == null) return;
    const name = draftName.trim();
    const sym = draftSymbol.trim();
    const title = name.length ? name : sym.length ? `$${sym}` : "project";
    setStatement(`Lock creator fees in escrow for ${title}. Ship milestones, release on-chain.`);
  }, [commitKind, commitPath, draftName, draftSymbol, statementTouched]);

  async function loadCommitmentStatus(id: string) {
    setError(null);
    setBusy(`inspect:${id}`);
    try {
      const data = await apiGet<CommitmentStatusResponse>(`/api/commitments/${id}`);
      setExpanded((prev) => ({ ...prev, [id]: data }));
    } finally {
      setBusy(null);
    }
  }

  async function resolve(id: string, kind: "success" | "failure") {
    setError(null);
    setBusy(`${kind}:${id}`);
    try {
      await adminPost(`/api/commitments/${id}/${kind}`);
      await loadCommitments();
      await loadCommitmentStatus(id);
    } finally {
      setBusy(null);
    }
  }

  async function sweep() {
    setError(null);
    setBusy("sweep");
    try {
      await adminPost("/api/commitments/sweep");
      await loadCommitments();
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    setDeadlineLocal((prev) => {
      if (prev.trim().length > 0) return prev;
      const now = new Date(Date.now() + 60 * 60 * 1000);
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
    });
    loadCommitments().catch((e) => setError((e as Error).message));
    refreshAdminSession().catch(() => setAdminWalletPubkey(null));
  }, []);

  useEffect(() => {
    setCommitStep(1);
  }, [commitKind, commitPath]);

  useEffect(() => {
    if (commitKind !== "creator_reward") return;
    if (commitPath == null) return;
    setRewardCreatorFeeMode(commitPath === "automated" ? "managed" : "assisted");
  }, [commitKind, commitPath]);

  useEffect(() => {
    if (tab !== "discover") return;
    loadTimeline().catch((e) => setError((e as Error).message));
  }, [tab]);

  useEffect(() => {
    if (tab !== "discover") return;
    if (!searchParams) return;
    if (timelineHydratedRef.current) return;

    const tf = String(searchParams.get("tf") ?? "").trim();
    const tq = String(searchParams.get("tq") ?? "").trim();
    const tk = String(searchParams.get("tk") ?? "").trim();
    const ts = String(searchParams.get("ts") ?? "").trim();
    const tso = String(searchParams.get("tso") ?? "").trim();

    if (tf === "curated" || tf === "all" || tf === "reward" || tf === "milestones" || tf === "completed") setTimelineFilter(tf);
    if (tk === "all" || tk === "personal" || tk === "reward") setTimelineKindFilter(tk);
    if (ts === "all" || ts === "active" || ts === "funded" || ts === "expired" || ts === "success" || ts === "failure") setTimelineStatusFilter(ts);
    if (tso === "newest" || tso === "oldest" || tso === "amount_desc") setTimelineSort(tso);
    if (tq) setTimelineQuery(tq);

    timelineHydratedRef.current = true;
  }, [tab, searchParams]);

  useEffect(() => {
    if (tab !== "discover") return;
    if (!timelineHydratedRef.current) return;
    if (!searchParams) return;

    const next = new URLSearchParams(searchParams.toString());
    next.set("tab", "discover");
    next.set("tf", timelineFilter);
    next.set("tq", timelineQuery);
    next.set("tk", timelineKindFilter);
    next.set("ts", timelineStatusFilter);
    next.set("tso", timelineSort);

    const nextUrl = `/?${next.toString()}`;
    if (timelineUrlRef.current === nextUrl) return;
    timelineUrlRef.current = nextUrl;
    router.replace(nextUrl);
  }, [router, searchParams, tab, timelineFilter, timelineQuery, timelineKindFilter, timelineStatusFilter, timelineSort]);

  useEffect(() => {
    if (tab !== "discover") return;
    const wallets: string[] = [];
    for (const e of timelineEvents) {
      if (e.creatorPubkey) wallets.push(e.creatorPubkey);
      if (e.authority) wallets.push(e.authority);
    }
    loadProfilesForWallets(wallets).catch(() => null);
  }, [tab, timelineEvents]);

  useEffect(() => {
    if (tab !== "discover") return;

    const mints: string[] = [];
    for (const c of timelineCommitments) {
      const mint = typeof c?.tokenMint === "string" ? c.tokenMint.trim() : "";
      if (mint) mints.push(mint);
    }
    loadProjectsForMints(mints).catch(() => null);
  }, [tab, timelineCommitments]);

  useEffect(() => {
    const raw = (searchParams?.get("tab") ?? "").toLowerCase();
    const next = raw === "commit" || raw === "discover" || raw === "landing" ? (raw as typeof tab) : "landing";
    if (next === tab) return;
    setTab(next);
  }, [searchParams]);

  useEffect(() => {
    const raw = (searchParams?.get("tab") ?? "").toLowerCase();
    if (raw !== "landing") return;
    router.replace("/");
  }, [router, searchParams]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const skin = tab === "landing" ? "landing" : "app";
    document.body.dataset.skin = skin;
    document.documentElement.dataset.skin = skin;
  }, [tab]);

  function setTabAndUrl(next: typeof tab) {
    setTab(next);
    if (next === "landing") {
      router.replace("/");
      return;
    }
    router.replace(`/?tab=${encodeURIComponent(next)}`);
  }

  return (
    <>
      <div className="appShell" data-skin={tab === "landing" ? "landing" : "app"}>
        <aside className="appShellNav">
          <div className="appShellBrand">
            <img src="/branding/svg-logo.svg" alt="Commit To Ship" className="appShellBrandMark" />
            <div className="appShellBrandText">Commit To Ship</div>
          </div>

          <nav className="appShellNavGroup" aria-label="Primary">
            <button
              className={`appShellNavItem ${tab === "landing" ? "appShellNavItemActive" : ""}`}
              onClick={() => setTabAndUrl("landing")}
              disabled={busy != null}
            >
              Landing
            </button>
            <button
              className={`appShellNavItem ${tab === "discover" ? "appShellNavItemActive" : ""}`}
              onClick={() => {
                setTabAndUrl("discover");
                setTimeout(() => timelineRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 40);
              }}
              disabled={busy != null}
            >
              Discover
            </button>
            <button
              className={`appShellNavItem ${tab === "commit" ? "appShellNavItemActive" : ""}`}
              onClick={() => {
                setTabAndUrl("commit");
                setTimeout(() => commitmentRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
              }}
              disabled={busy != null}
            >
              Commit
            </button>
          </nav>

          <div className="appShellNavFoot">On-chain accountability</div>
        </aside>

        <div className="appShellMain">
          <main className="appShellBody">
            {tab === "landing" ? (
              <div className="commitStage">
                <div className="commitWrap">
                  <section className="commitSurface commitSurfaceMain landingSurface">
                    <div className="landingContent">
                      <div className="landingLeft">
                        <div className="wordmark">
                          <div className="brandLockup">
                            <Image
                              src="/branding/text-logo-white.png"
                              alt="Commit To Ship"
                              width={340}
                              height={44}
                              priority
                              className="brandImage"
                            />
                          </div>
                        </div>

                        <div className="heroMark">
                          <img src="/branding/svg-logo.svg" alt="Commit To Ship" className="heroMarkImage heroMarkImageSvg" />
                        </div>

                        <p className="heroLead">
                          Lock your{" "}
                          <a href="https://pump.fun" target="_blank" rel="noreferrer noopener" className="pumpfunLink">
                            pump.fun
                          </a>{" "}
                          creator fees in on-chain escrow. Set milestones; holders vote to approve releases. If you miss, fees stay locked or route to the chosen destination.
                        </p>

                        <div className="landingCtas">
                          <button
                            className="btn btnPrimary landingCtaPrimary"
                            onClick={() => {
                              setTabAndUrl("commit");
                              setTimeout(() => commitmentRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
                            }}
                          >
                            Create Commitment
                          </button>

                          <button
                            className="btn landingCtaSecondary"
                            onClick={() => {
                              setTabAndUrl("discover");
                              setTimeout(() => timelineRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 40);
                            }}
                          >
                            Explore Discover
                          </button>
                        </div>
                      </div>

                      <div className="landingRight">
                      </div>
                    </div>
                  </section>
                </div>
              </div>
            ) : tab === "commit" ? (
              <div className="commitStage">
                <div className="commitWrap">
                  <div className="commitLayout">
                      <section className="commitSurface commitSurfaceMain">
                      <div className="commitHero commitHeroInSurface" ref={commitmentRef}>
                        <h1 className="commitHeroTitle">Create Commitment</h1>
                        <p className="commitHeroLead">Choose the level of automation and guarantees. Both paths are verifiable; only one is system-enforced.</p>
                      </div>

                      <ClosedBetaNotice />

                      <div className="commitWizard">
                        <div className="commitWizardTop">
                          <div className="commitWizardSteps" role="tablist" aria-label="Commitment wizard steps">
                            {commitSteps.map((label, idx) => {
                              const step = idx + 1;
                              const active = step === commitStep;
                              const done = step < commitStep;
                              return (
                                <button
                                  key={label}
                                  type="button"
                                  className={`commitWizardStep ${active ? "commitWizardStepActive" : ""} ${done ? "commitWizardStepDone" : ""}`}
                                  onClick={() => setCommitStep(step)}
                                  disabled={busy != null || commitPath == null}
                                  role="tab"
                                  aria-selected={active}
                                >
                                  <span className="commitWizardStepIndex">{step}</span>
                                  <span className="commitWizardStepLabel">{label}</span>
                                </button>
                              );
                            })}
                          </div>

                          {commitPath != null ? (
                            <div className="commitWizardNav">
                              <button
                                type="button"
                                className="commitBtnSecondary commitBtnSmall"
                                onClick={() => setCommitStep((s) => Math.max(1, s - 1))}
                                disabled={busy != null || commitStep <= 1}
                              >
                                Back
                              </button>
                              <button
                                type="button"
                                className="commitBtnSecondary commitBtnSmall"
                                onClick={() => setCommitStep((s) => Math.min(maxCommitStep, s + 1))}
                                disabled={busy != null || commitStep >= maxCommitStep}
                              >
                                Next
                              </button>
                            </div>
                          ) : null}
                        </div>

                        {commitPath == null ? (
                          <section className="commitCard commitCardPrimary">
                            <div className="commitCardLabel">Choose your path</div>
                            <div className="commitCardDesc">
                              Automated is system-enforced (higher credibility). Manual is self-managed (lower guarantees). Both remain transparent.
                            </div>

                            <div className="commitTypeGrid" style={{ marginTop: 14 }}>
                              <button
                                className="commitTypeCard"
                                onClick={() => {
                                  setCommitKind("creator_reward");
                                  setCommitPath("automated");
                                  setRewardCreatorFeeMode("managed");
                                  setCommitStep(1);
                                }}
                                disabled={busy != null}
                              >
                                <div className="commitTypeIcon" aria-hidden="true">
                                  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M12 2l8 4v6c0 5-3.2 9.4-8 10-4.8-.6-8-5-8-10V6l8-4z" stroke="currentColor" strokeWidth="2" />
                                    <path d="M9.5 12.5l1.9 2 3.1-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                  </svg>
                                </div>
                                <div className="commitTypeName">Automated Commit</div>
                                <div className="commitTypeDesc">High-trust. Protocol enforces fee locking + milestone gating.</div>
                              </button>

                              <button
                                className="commitTypeCard"
                                onClick={() => {
                                  setCommitKind("creator_reward");
                                  setCommitPath("manual");
                                  setRewardCreatorFeeMode("assisted");
                                  setCommitStep(1);
                                }}
                                disabled={busy != null}
                              >
                                <div className="commitTypeIcon" aria-hidden="true">
                                  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M4 7h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                                    <path d="M4 12h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                                    <path d="M4 17h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                                  </svg>
                                </div>
                                <div className="commitTypeName">Manual Commit</div>
                                <div className="commitTypeDesc">Lower guarantees. Clear disclosures; enforcement is self-managed.</div>
                              </button>
                            </div>

                            <div className="commitActions" style={{ marginTop: 14, justifyContent: "flex-start" }}>
                              <button
                                type="button"
                                className="commitBtnTertiary"
                                onClick={() => {
                                  setCommitKind("personal");
                                  setCommitPath("manual");
                                  setCommitStep(1);
                                }}
                                disabled={busy != null}
                              >
                                Personal commitment (time-lock)
                              </button>
                            </div>
                          </section>
                        ) : null}

                        {commitPath != null && commitKind === "creator_reward" && commitStep === 1 ? (
                          <section className="commitCard commitCardPrimary">
                            <div className="commitCardLabel">Asset</div>
                            <div className="commitCardDesc">Define the asset + metadata. Then verify token authority (required) to proceed.</div>

                            {commitPath === "manual" ? (
                              <div className="commitInlineNotice" style={{ marginTop: 12 }}>
                                Manual Commit is self-managed. CTS can provide tracking and receipts, but enforcement depends on voluntary actions and reputation.
                              </div>
                            ) : null}

                            <div className="commitFieldGroup">
                              <div className="commitField">
                                <div className="commitFieldLabel">Image URL</div>
                                <input className="commitInput" value={draftImageUrl} onChange={(e) => setDraftImageUrl(e.target.value)} placeholder="https://..." />
                              </div>
                              <div className="commitField">
                                <div className="commitFieldLabel">Name</div>
                                <input className="commitInput" value={draftName} onChange={(e) => setDraftName(e.target.value)} placeholder="Project name" />
                              </div>
                              <div className="commitField">
                                <div className="commitFieldLabel">Ticker</div>
                                <input className="commitInput" value={draftSymbol} onChange={(e) => setDraftSymbol(e.target.value)} placeholder="TICKER" />
                              </div>
                            </div>

                            <div className="commitField" style={{ marginTop: 18 }}>
                              <div className="commitFieldLabel">Description</div>
                              <input className="commitInput" value={draftDescription} onChange={(e) => setDraftDescription(e.target.value)} placeholder="Short, factual description" />
                            </div>

                            <div className="commitFieldGroup" style={{ marginTop: 18 }}>
                              <div className="commitField">
                                <div className="commitFieldLabel">Website</div>
                                <input className="commitInput" value={draftWebsiteUrl} onChange={(e) => setDraftWebsiteUrl(e.target.value)} placeholder="https://..." />
                              </div>
                              <div className="commitField">
                                <div className="commitFieldLabel">X</div>
                                <input className="commitInput" value={draftXUrl} onChange={(e) => setDraftXUrl(e.target.value)} placeholder="https://x.com/..." />
                              </div>
                            </div>

                            <div className="commitFieldGroup" style={{ marginTop: 18 }}>
                              <div className="commitField">
                                <div className="commitFieldLabel">Telegram</div>
                                <input className="commitInput" value={draftTelegramUrl} onChange={(e) => setDraftTelegramUrl(e.target.value)} placeholder="https://t.me/..." />
                              </div>
                              <div className="commitField">
                                <div className="commitFieldLabel">Discord</div>
                                <input className="commitInput" value={draftDiscordUrl} onChange={(e) => setDraftDiscordUrl(e.target.value)} placeholder="https://discord.gg/..." />
                              </div>
                            </div>

                            <div className="commitField" style={{ marginTop: 18 }}>
                              <div className="commitFieldLabel">Token Mint (Contract Address)</div>
                              <input className="commitInput" value={rewardTokenMint} onChange={(e) => setRewardTokenMint(e.target.value)} placeholder="Token mint address" />
                            </div>

                            <div className="commitField" style={{ marginTop: 18 }}>
                              <div className="commitFieldLabel">Statement</div>
                              <input
                                className="commitInput"
                                value={statement}
                                onChange={(e) => {
                                  setStatementTouched(true);
                                  setStatement(e.target.value);
                                }}
                                placeholder="Public commitment statement"
                              />
                            </div>

                            <div className="commitField" style={{ marginTop: 18 }}>
                              <div className="commitFieldLabel">Dev Wallet</div>
                              <input
                                className="commitInput"
                                value={creatorPubkey}
                                onChange={(e) => setCreatorPubkey(e.target.value)}
                                placeholder="Connect wallet"
                                readOnly={Boolean(devWalletPubkey)}
                              />
                            </div>

                            <div className="commitActions" style={{ marginTop: 14, justifyContent: "flex-start" }}>
                              <button className="commitBtnSecondary" onClick={connectDevWallet} disabled={busy != null || devVerifyBusy != null}>
                                {devVerifyBusy === "connect" ? "Connecting..." : devWalletPubkey ? "Wallet Connected" : "Connect Wallet"}
                              </button>
                              <button
                                className="commitBtnSecondary"
                                onClick={verifyDevWallet}
                                disabled={busy != null || devVerifyBusy != null || !devWalletPubkey || !rewardTokenMint.trim().length}
                              >
                                {devVerifyBusy === "verify" ? "Verifying..." : devVerify ? "Verified" : "Verify Authority"}
                              </button>
                            </div>

                            {devVerifyResult ? (
                              <div className="commitCardDesc" style={{ marginTop: 12 }}>
                                Mint authority: {devVerifyResult.mintAuthority ?? "None"}
                                <br />
                                Update authority: {devVerifyResult.updateAuthority ?? "None"}
                              </div>
                            ) : null}
                          </section>
                        ) : null}

                        {commitPath === "automated" && commitKind === "creator_reward" && commitStep === 2 ? (
                          <section className="commitCard">
                            <div className="commitCardLabel">Fees & automation</div>
                            <div className="commitCardDesc">
                              Automated Commit is system-enforced. After creation, protocol orchestration can auto-claim and lock creator fees in escrow.
                            </div>
                            <div className="commitField" style={{ marginTop: 12 }}>
                              <div className="commitFieldLabel">Mode</div>
                              <input className="commitInput" value="Managed Auto-Escrow" readOnly />
                              <div className="commitCardDesc" style={{ marginTop: 10 }}>
                                Guarantees:
                                <br />
                                - Fees can be locked without manual transfers
                                <br />
                                - Milestones gate releases
                                <br />
                                - Verifiable receipts for every unlock
                              </div>
                            </div>
                          </section>
                        ) : null}

                        {commitKind === "creator_reward" && ((commitPath === "automated" && commitStep === 3) || (commitPath === "manual" && commitStep === 2)) ? (
                          <section className="commitCard">
                            <div className="commitCardLabel">Milestones</div>
                            <div className="commitCardDesc">Define unlock amounts per milestone. Releases are on-chain transfers from escrow.</div>
                            <div className="commitMilestones">
                              {rewardMilestones.map((m, idx) => (
                                <div key={idx} className="commitMilestone">
                                  <div className="commitMilestoneNumber">{idx + 1}</div>
                                  <div className="commitMilestoneFields">
                                    <input
                                      className="commitInput commitMilestoneTitle"
                                      value={m.title}
                                      onChange={(e) =>
                                        setRewardMilestones((prev) => prev.map((x, i) => (i === idx ? { ...x, title: e.target.value } : x)))
                                      }
                                      placeholder={`Milestone ${idx + 1} title`}
                                    />
                                    <div className="commitInputWithUnit commitMilestoneAmount">
                                      <input
                                        className="commitInput"
                                        value={m.unlockSol}
                                        onChange={(e) =>
                                          setRewardMilestones((prev) => prev.map((x, i) => (i === idx ? { ...x, unlockSol: e.target.value } : x)))
                                        }
                                        inputMode="decimal"
                                        placeholder="0.00"
                                      />
                                      <div className="commitInputUnit">SOL</div>
                                    </div>
                                  </div>
                                  <button
                                    className="commitMilestoneRemove"
                                    onClick={() => setRewardMilestones((prev) => prev.filter((_, i) => i !== idx))}
                                    disabled={rewardMilestones.length <= 1 || busy != null}
                                    title="Remove milestone"
                                  >
                                    ×
                                  </button>
                                </div>
                              ))}
                            </div>
                            <button
                              className="commitBtnSecondary"
                              onClick={() => setRewardMilestones((prev) => [...prev, { title: "", unlockSol: "0.25" }])}
                              disabled={busy != null || rewardMilestones.length >= 12}
                            >
                              + Add Milestone
                            </button>
                          </section>
                        ) : null}

                        {commitKind === "creator_reward" && ((commitPath === "automated" && commitStep === 4) || (commitPath === "manual" && commitStep === 3)) ? (
                          <section className="commitCard">
                            <div className="commitCardLabel">Confirm</div>
                            <div className="commitCardDesc">Review the configuration. This will create an escrow-backed commitment record.</div>

                            {commitIssues.length ? (
                              <div className="commitIssues">
                                {commitIssues.map((x) => (
                                  <div key={x} className="commitIssue">{x}</div>
                                ))}
                              </div>
                            ) : null}

                            <div className="commitActions" style={{ marginTop: 18 }}>
                              <button className="commitBtnPrimary" onClick={createCommitment} disabled={busy === "create" || commitIssues.length > 0}>
                                {busy === "create" ? (
                                  <>
                                    <span className="commitBtnSpinner" />
                                    Creating...
                                  </>
                                ) : commitPath === "automated" ? (
                                  "Create Automated Commit"
                                ) : (
                                  "Create Manual Commit"
                                )}
                              </button>
                              <button
                                className="commitBtnSecondary"
                                type="button"
                                onClick={() => {
                                  setCommitPath(null);
                                  setCommitStep(1);
                                }}
                                disabled={busy != null}
                              >
                                Change path
                              </button>
                            </div>
                          </section>
                        ) : null}

                        {commitKind === "personal" && commitStep === 2 ? (
                          <section className="commitCard">
                            <div className="commitCardLabel">Details</div>
                            <div className="commitFieldGroup">
                              <div className="commitField">
                                <div className="commitFieldLabel">Your Wallet (Refund Address)</div>
                                <input
                                  className="commitInput"
                                  value={authority}
                                  onChange={(e) => setAuthority(e.target.value)}
                                  placeholder="Your Solana public key"
                                />
                              </div>
                              <div className="commitField">
                                <div className="commitFieldLabel">Destination on Failure</div>
                                <input
                                  className="commitInput"
                                  value={destinationOnFail}
                                  onChange={(e) => setDestinationOnFail(e.target.value)}
                                  placeholder="Where funds go if you fail"
                                />
                              </div>
                            </div>
                          </section>
                        ) : null}

                        {commitKind === "personal" && commitStep === 3 ? (
                          <section className="commitCard">
                            <div className="commitCardLabel">Funding</div>
                            <div className="commitFieldGroup">
                              <div className="commitField">
                                <div className="commitFieldLabel">Amount to Lock</div>
                                <div className="commitInputWithUnit">
                                  <input
                                    className="commitInput commitInputAmount"
                                    value={amountSol}
                                    onChange={(e) => setAmountSol(e.target.value)}
                                    inputMode="decimal"
                                    placeholder="0.00"
                                  />
                                  <div className="commitInputUnit">SOL</div>
                                </div>
                                <div className="commitQuickRow">
                                  <button type="button" className="commitQuick" onClick={() => setAmountSol("0.05")} disabled={busy != null}>
                                    0.05
                                  </button>
                                  <button type="button" className="commitQuick" onClick={() => setAmountSol("0.10")} disabled={busy != null}>
                                    0.10
                                  </button>
                                  <button type="button" className="commitQuick" onClick={() => setAmountSol("0.25")} disabled={busy != null}>
                                    0.25
                                  </button>
                                  <button type="button" className="commitQuick" onClick={() => setAmountSol("1")} disabled={busy != null}>
                                    1
                                  </button>
                                </div>
                              </div>
                              <div className="commitField">
                                <div className="commitFieldLabel">Deadline</div>
                                <input
                                  className="commitInput"
                                  type="datetime-local"
                                  value={deadlineLocal}
                                  onChange={(e) => setDeadlineLocal(e.target.value)}
                                />
                                <div className="commitQuickRow">
                                  <button type="button" className="commitQuick" onClick={() => setDeadlinePreset(24)} disabled={busy != null}>
                                    24h
                                  </button>
                                  <button type="button" className="commitQuick" onClick={() => setDeadlinePreset(24 * 3)} disabled={busy != null}>
                                    3d
                                  </button>
                                  <button type="button" className="commitQuick" onClick={() => setDeadlinePreset(24 * 7)} disabled={busy != null}>
                                    7d
                                  </button>
                                </div>
                              </div>
                            </div>
                          </section>
                        ) : null}

                        {commitKind === "personal" && commitStep === 4 ? (
                          <section className="commitCard">
                            <div className="commitCardLabel">Review</div>
                            <div className="commitCardDesc">Confirm the terms below. You will get an escrow address after creation.</div>

                            <div className="commitCardDesc" style={{ marginTop: 12 }}>
                              Funds are held in an escrow wallet controlled by this service (custodial). An admin wallet can mark success/failure and trigger on-chain transfers according to the rules shown on the dashboard.
                            </div>

                            {commitIssues.length ? (
                              <div className="commitIssues">
                                {commitIssues.map((x) => (
                                  <div key={x} className="commitIssue">{x}</div>
                                ))}
                              </div>
                            ) : null}

                            <div className="commitActions" style={{ marginTop: 18 }}>
                              <button className="commitBtnPrimary" onClick={createCommitment} disabled={busy === "create" || commitIssues.length > 0}>
                                {busy === "create" ? (
                                  <>
                                    <span className="commitBtnSpinner" />
                                    Creating...
                                  </>
                                ) : (
                                  "Create Commitment"
                                )}
                              </button>
                            </div>
                          </section>
                        ) : null}


                        {commitKind === "personal" && commitPath != null && commitStep === 1 ? (
                          <section className="commitCard commitCardPrimary">
                            <div className="commitCardLabel">Basics</div>
                            <div className="commitField">
                              <div className="commitFieldLabel">Statement</div>
                              <input
                                className="commitInput"
                                value={statement}
                                onChange={(e) => {
                                  setStatementTouched(true);
                                  setStatement(e.target.value);
                                }}
                                placeholder="What are you committing to ship?"
                              />
                            </div>
                          </section>
                        ) : null}
                      </div>
                      </section>

                      <aside className="commitSide">
                        <section className="commitSurface commitSurfacePreview">
                        <div className="commitCardLabel">Live Preview</div>
                        {commitKind === "creator_reward" && commitPath != null ? (
                          <div className="tokenBadge" style={{ marginTop: 10 }}>
                            <div className="tokenBadgeIcon" aria-hidden="true">
                              <span className="tokenBadgeFallback" />
                              {draftImageUrl ? (
                                <img
                                  className="tokenBadgeImg"
                                  src={draftImageUrl}
                                  alt=""
                                  onError={(ev) => {
                                    (ev.currentTarget as HTMLImageElement).style.display = "none";
                                  }}
                                />
                              ) : null}
                            </div>
                            <div className="tokenBadgeText">
                              <div className="tokenBadgeTitle">{draftName.trim().length ? draftName.trim() : "Untitled"}</div>
                              <div className="tokenBadgeSubtitle">{draftSymbol.trim().length ? `$${draftSymbol.trim()}` : ""}</div>
                            </div>
                          </div>
                        ) : null}
                        <div className="commitPreviewTitle">{statement.trim().length ? statement.trim() : commitPath == null ? "Choose a path to begin" : "Untitled commitment"}</div>
                        <div className="commitPreviewChips">
                          {commitPath != null ? <span className={`commitPreviewChip ${commitPath === "automated" ? "commitPreviewChipReward" : ""}`}>{commitPath === "automated" ? "automated" : "manual"}</span> : null}
                          {commitKind === "creator_reward" && commitPath != null ? (
                            <span className="commitPreviewChip">{rewardCreatorFeeMode === "managed" ? "system-enforced" : "self-managed"}</span>
                          ) : null}
                          {commitPath != null ? (
                            commitIssues.length === 0 ? (
                              <span className="commitPreviewChip commitPreviewChipReady">ready</span>
                            ) : (
                              <span className="commitPreviewChip">needs input</span>
                            )
                          ) : (
                            <span className="commitPreviewChip">choose</span>
                          )}
                        </div>

                        <div className="commitPreviewGrid">
                          {commitKind === "personal" ? (
                            <>
                              <div className="commitPreviewRow">
                                <div className="commitPreviewLabel">Amount</div>
                                <div className="commitPreviewValue">{amountLamports > 0 ? `${fmtSol(amountLamports)} SOL` : "—"}</div>
                              </div>
                              <div className="commitPreviewRow">
                                <div className="commitPreviewLabel">Deadline</div>
                                <div className="commitPreviewValue">{deadlineLocal.trim().length ? deadlineLocal.replace("T", " ") : "—"}</div>
                              </div>
                              <div className="commitPreviewRow">
                                <div className="commitPreviewLabel">Refund</div>
                                <div className="commitPreviewValue mono">{authority.trim().length ? authority.trim() : "—"}</div>
                              </div>
                              <div className="commitPreviewRow">
                                <div className="commitPreviewLabel">On fail</div>
                                <div className="commitPreviewValue mono">{destinationOnFail.trim().length ? destinationOnFail.trim() : "—"}</div>
                              </div>
                            </>
                          ) : (
                            <>
                              <div className="commitPreviewRow">
                                <div className="commitPreviewLabel">Creator</div>
                                <div className="commitPreviewValue mono">{creatorPubkey.trim().length ? creatorPubkey.trim() : "—"}</div>
                              </div>
                              <div className="commitPreviewRow">
                                <div className="commitPreviewLabel">Token gate</div>
                                <div className="commitPreviewValue mono">{rewardTokenMint.trim().length ? rewardTokenMint.trim() : "none"}</div>
                              </div>
                              <div className="commitPreviewRow">
                                <div className="commitPreviewLabel">Milestones</div>
                                <div className="commitPreviewValue">{rewardMilestonesParsed.filter((m) => m.title.length).length || 0}</div>
                              </div>
                              <div className="commitPreviewRow">
                                <div className="commitPreviewLabel">Total unlock</div>
                                <div className="commitPreviewValue">{rewardTotalUnlockLamports > 0 ? `${fmtSol(rewardTotalUnlockLamports)} SOL` : "—"}</div>
                              </div>
                            </>
                          )}
                        </div>

                        {commitIssues.length ? (
                          <div className="commitPreviewIssues">
                            {commitIssues.slice(0, 3).map((x) => (
                              <div key={x} className="commitPreviewIssue">{x}</div>
                            ))}
                            {commitIssues.length > 3 ? <div className="commitPreviewIssue">+{commitIssues.length - 3} more</div> : null}
                          </div>
                        ) : null}
                        </section>

                        <section className="commitSurface">
                        <div className="commitCardLabel">Admin Controls</div>
                        <div className="commitCardDesc">Admin actions require an admin wallet session.</div>
                        {adminAuthError ? <div className="commitError" style={{ marginTop: 10 }}>{adminAuthError}</div> : null}
                        <div className="commitAdminActions" style={{ marginTop: 10 }}>
                          <button className="commitBtnSecondary" onClick={adminSignIn} disabled={adminAuthBusy != null}>
                            {adminWalletPubkey ? "Admin Signed In" : adminAuthBusy === "signin" ? "Signing in..." : "Admin Sign In"}
                          </button>
                          {adminWalletPubkey ? (
                            <button className="commitBtnSecondary" onClick={adminSignOut} disabled={adminAuthBusy != null}>
                              {adminAuthBusy === "signout" ? "Signing out..." : "Sign Out"}
                            </button>
                          ) : null}
                        </div>

                        <div style={{ marginTop: 18 }}>
                          <div className="commitCardDesc" style={{ marginTop: 0 }}>Project Profile Editor (per token mint)</div>
                          {projectEditError ? <div className="commitError" style={{ marginTop: 10 }}>{projectEditError}</div> : null}
                          {projectEditResult?.ok ? (
                            <div className="commitSuccess" style={{ marginTop: 10 }}>
                              {projectEditResult?.action === "load"
                                ? projectEditResult?.found
                                  ? "Loaded"
                                  : "Not found"
                                : "Saved"}
                            </div>
                          ) : null}
                          <div className="commitField" style={{ marginTop: 10 }}>
                            <div className="commitFieldLabel">Token Mint</div>
                            <input
                              className="commitInput"
                              value={projectEditMint}
                              onChange={(e) => setProjectEditMint(e.target.value)}
                              placeholder="Token mint address"
                            />
                          </div>
                          <div className="commitAdminActions" style={{ marginTop: 10 }}>
                            <button
                              className="commitBtnSecondary"
                              onClick={() => setProjectEditMint(rewardTokenMint.trim())}
                              disabled={projectEditBusy != null}
                              type="button"
                            >
                              Use Reward Mint
                            </button>
                            <button className="commitBtnSecondary" onClick={adminLoadProjectProfile} disabled={projectEditBusy != null} type="button">
                              {projectEditBusy === "load" ? "Loading..." : "Load"}
                            </button>
                            <button
                              className="commitBtnSecondary"
                              onClick={adminSaveProjectProfile}
                              disabled={projectEditBusy != null || !adminWalletPubkey}
                              type="button"
                            >
                              {projectEditBusy === "save" ? "Saving..." : "Save"}
                            </button>
                          </div>

                          <div className="commitField" style={{ marginTop: 18 }}>
                            <div className="commitFieldLabel">Name</div>
                            <input className="commitInput" value={projectEditName} onChange={(e) => setProjectEditName(e.target.value)} placeholder="Project name" />
                          </div>
                          <div className="commitField" style={{ marginTop: 18 }}>
                            <div className="commitFieldLabel">Symbol</div>
                            <input className="commitInput" value={projectEditSymbol} onChange={(e) => setProjectEditSymbol(e.target.value)} placeholder="$TICKER" />
                          </div>
                          <div className="commitField" style={{ marginTop: 18 }}>
                            <div className="commitFieldLabel">Description</div>
                            <input
                              className="commitInput"
                              value={projectEditDescription}
                              onChange={(e) => setProjectEditDescription(e.target.value)}
                              placeholder="Short description (max 600 chars)"
                            />
                          </div>

                          <div className="commitField" style={{ marginTop: 18 }}>
                            <div className="commitFieldLabel">Website URL</div>
                            <input className="commitInput" value={projectEditWebsite} onChange={(e) => setProjectEditWebsite(e.target.value)} placeholder="https://..." />
                          </div>
                          <div className="commitField" style={{ marginTop: 18 }}>
                            <div className="commitFieldLabel">X URL</div>
                            <input className="commitInput" value={projectEditX} onChange={(e) => setProjectEditX(e.target.value)} placeholder="https://x.com/..." />
                          </div>
                          <div className="commitField" style={{ marginTop: 18 }}>
                            <div className="commitFieldLabel">Telegram URL</div>
                            <input className="commitInput" value={projectEditTelegram} onChange={(e) => setProjectEditTelegram(e.target.value)} placeholder="https://t.me/..." />
                          </div>
                          <div className="commitField" style={{ marginTop: 18 }}>
                            <div className="commitFieldLabel">Discord URL</div>
                            <input className="commitInput" value={projectEditDiscord} onChange={(e) => setProjectEditDiscord(e.target.value)} placeholder="https://discord.gg/..." />
                          </div>
                          <div className="commitField" style={{ marginTop: 18 }}>
                            <div className="commitFieldLabel">Image URL</div>
                            <input className="commitInput" value={projectEditImageUrl} onChange={(e) => setProjectEditImageUrl(e.target.value)} placeholder="https://..." />
                          </div>
                          <div className="commitField" style={{ marginTop: 18 }}>
                            <div className="commitFieldLabel">Metadata URI</div>
                            <input className="commitInput" value={projectEditMetadataUri} onChange={(e) => setProjectEditMetadataUri(e.target.value)} placeholder="https://..." />
                          </div>
                        </div>
                        <div className="commitAdminActions" style={{ marginTop: 10 }}>
                          <button className="commitBtnSecondary" onClick={sweep} disabled={busy === "sweep" || !adminWalletPubkey}>
                            {busy === "sweep" ? "Sweeping..." : "Sweep Expired"}
                          </button>
                        </div>
                        </section>

                        <section className="commitSurface">
                        <div className="commitListHeader">
                          <div>
                            <div className="commitCardLabel">Active Commitments</div>
                            <div className="commitCardDesc">On-chain records. Deposit SOL to escrow addresses to fund.</div>
                          </div>
                          <button
                            className="commitBtnSecondary commitBtnSmall"
                            onClick={() => loadCommitments().catch((e) => setError((e as Error).message))}
                            disabled={busy != null}
                          >
                            Refresh
                          </button>
                        </div>

                        {commitmentsLoading ? (
                          <div className="commitList" aria-hidden="true">
                            {Array.from({ length: 3 }).map((_, i) => (
                              <div key={i} className="commitListItem">
                                <div className="commitListItemMain">
                                  <div className="commitListItemInfo">
                                    <div className="skeleton skeletonLine" style={{ width: "180px" }} />
                                    <div className="commitListItemMeta" style={{ marginTop: 10 }}>
                                      <div className="skeleton skeletonLineSm" style={{ width: "120px" }} />
                                    </div>
                                    <div style={{ marginTop: 10 }}>
                                      <div className="skeleton skeletonLineSm" style={{ width: "220px" }} />
                                    </div>
                                  </div>
                                  <div className="commitListItemActions">
                                    <div className="skeleton" style={{ width: 120, height: 34, borderRadius: 999 }} />
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : commitments.length === 0 ? (
                          <div className="commitListEmpty">No commitments yet. Create one above to get started.</div>
                        ) : (
                          <div className="commitList">
                            {commitments
                              .slice()
                              .sort((a, b) => b.createdAtUnix - a.createdAtUnix)
                              .map((c) => {
                                const detail = expanded[c.id];
                                return (
                                  <div key={c.id} className="commitListItem">
                                    <div className="commitListItemMain">
                                      <div className="commitListItemInfo">
                                        <div className="commitListItemTitle">
                                          {c.kind === "creator_reward" ? "Reward Commitment" : `${lamportsToSol(c.amountLamports)} SOL`}
                                        </div>
                                        <div className="commitListItemMeta">
                                          <span className="commitListItemStatus">{c.status}</span>
                                          {c.kind === "creator_reward" ? (
                                            <>
                                              <span className={`commitListItemBadge ${String(c.creatorFeeMode ?? "assisted") === "managed" ? "commitListItemBadgeManaged" : ""}`}>
                                                {String(c.creatorFeeMode ?? "assisted") === "managed" ? "auto-escrow" : "assisted"}
                                              </span>
                                              <span>
                                                Escrowed: {lamportsToSol(c.totalFundedLamports ?? 0)} / {lamportsToSol((c.milestones ?? []).reduce((acc, m) => acc + Number(m.unlockLamports || 0), 0))} SOL
                                              </span>
                                            </>
                                          ) : (
                                            <span>Deadline: {new Date(c.deadlineUnix * 1000).toLocaleDateString()}</span>
                                          )}
                                        </div>

                                        {c.kind === "creator_reward" ? (
                                          (() => {
                                            const funded = Number(c.totalFundedLamports ?? 0);
                                            const total = (c.milestones ?? []).reduce((acc, m) => acc + Number(m.unlockLamports || 0), 0);
                                            const pct = total > 0 ? clamp01(funded / total) : 0;
                                            return (
                                              <div className="commitCompliance">
                                                <div className="commitComplianceBar" aria-hidden="true">
                                                  <div className="commitComplianceFill" style={{ width: `${Math.round(pct * 100)}%` }} />
                                                </div>
                                                <div className="commitComplianceText">Compliance: {Math.round(pct * 100)}%</div>
                                              </div>
                                            );
                                          })()
                                        ) : null}
                                      </div>
                                      <div className="commitListItemActions">
                                        <button className="commitBtnSecondary commitBtnSmall" onClick={() => router.push(`/commit/${c.id}`)}>
                                          View Dashboard
                                        </button>
                                        <button
                                          className="commitBtnSecondary commitBtnSmall"
                                          onClick={() => loadCommitmentStatus(c.id).catch((e) => setError((e as Error).message))}
                                          disabled={busy != null}
                                        >
                                          {busy === `inspect:${c.id}` ? "..." : "Inspect"}
                                        </button>
                                      </div>
                                    </div>

                                    {detail ? (
                                      <div className="commitListItemDetail">
                                        <div className="commitListItemDetailRow">
                                          <span className="commitListItemDetailLabel">Escrow</span>
                                          <span className="commitListItemDetailValue">{c.escrowPubkey}</span>
                                        </div>
                                        <div className="commitListItemDetailRow">
                                          <span className="commitListItemDetailLabel">Balance</span>
                                          <span className="commitListItemDetailValue">{lamportsToSol(detail.escrow.balanceLamports)} SOL</span>
                                        </div>
                                        {c.kind === "personal" && adminWalletPubkey ? (
                                          <div className="commitListItemAdminActions">
                                            <button
                                              className="commitBtnTertiary"
                                              onClick={() => resolve(c.id, "success").catch((e) => setError((e as Error).message))}
                                              disabled={busy === `success:${c.id}`}
                                            >
                                              {busy === `success:${c.id}` ? "..." : "Mark Success"}
                                            </button>
                                            <button
                                              className="commitBtnTertiary"
                                              onClick={() => resolve(c.id, "failure").catch((e) => setError((e as Error).message))}
                                              disabled={busy === `failure:${c.id}`}
                                            >
                                              {busy === `failure:${c.id}` ? "..." : "Mark Failure"}
                                            </button>
                                          </div>
                                        ) : null}
                                      </div>
                                    ) : null}
                                  </div>
                                );
                              })}
                          </div>
                        )}
                        </section>
                      </aside>
                    </div>
                </div>
              </div>
            ) : tab === "discover" ? (
              <div className="discoverStage" ref={timelineRef}>
                <div className="discoverWrap">
                  {error ? <div className="timelineError">{error}</div> : null}

                  <section className="discoverPanel">
                    <div className="discoverHeader">
                      <div className="discoverHeaderTop">
                        <h1 className="discoverTitle">Discover</h1>
                        <div className="timelineFilterRow">
                          <button className={`timelineFilter ${timelineFilter === "curated" ? "timelineFilterActive" : ""}`} onClick={() => setTimelineFilter("curated")}>
                            Hot
                          </button>
                          <button className={`timelineFilter ${timelineFilter === "completed" ? "timelineFilterActive" : ""}`} onClick={() => setTimelineFilter("completed")}>
                            Shipped
                          </button>
                          <button className={`timelineFilter ${timelineFilter === "reward" ? "timelineFilterActive" : ""}`} onClick={() => setTimelineFilter("reward")}>
                            Rewards
                          </button>
                          <button className={`timelineFilter ${timelineFilter === "milestones" ? "timelineFilterActive" : ""}`} onClick={() => setTimelineFilter("milestones")}>
                            Milestones
                          </button>
                          <button className={`timelineFilter ${timelineFilter === "all" ? "timelineFilterActive" : ""}`} onClick={() => setTimelineFilter("all")}>
                            All
                          </button>
                        </div>
                      </div>
                      <p className="discoverLead">
                        A high-signal discovery surface for verifiable execution: escrowed milestones, on-chain receipts, and momentum you can audit.
                      </p>

                      <div className="discoverStats">
                        <div className="discoverStat">
                          <div className="discoverStatLabel">Listed</div>
                          <div className="discoverStatValue">{fmtCompact(discoverStats.realCount)}</div>
                        </div>
                        <div className="discoverStat">
                          <div className="discoverStatLabel">Active</div>
                          <div className="discoverStatValue">{fmtCompact(discoverStats.active)}</div>
                        </div>
                        <div className="discoverStat">
                          <div className="discoverStatLabel">Funded</div>
                          <div className="discoverStatValue">{fmtCompact(discoverStats.funded)}</div>
                        </div>
                        <div className="discoverStat">
                          <div className="discoverStatLabel">Escrowed</div>
                          <div className="discoverStatValue">{fmtCompact(discoverStats.escrowedSol)} SOL</div>
                        </div>
                      </div>
                    </div>

                    <div className="discoverControls">
                      <div className="discoverControlsTop">
                        <input
                          className="timelineSearch"
                          value={timelineQuery}
                          onChange={(e) => setTimelineQuery(e.target.value)}
                          placeholder="Search project, symbol, commitment id, mint…"
                        />
                        <select className="timelineSelect" value={timelineKindFilter} onChange={(e) => setTimelineKindFilter(e.target.value as any)}>
                          <option value="all">All types</option>
                          <option value="reward">Rewards</option>
                          <option value="personal">Personal</option>
                        </select>
                        <select className="timelineSelect" value={timelineStatusFilter} onChange={(e) => setTimelineStatusFilter(e.target.value as any)}>
                          <option value="all">All status</option>
                          <option value="active">Active</option>
                          <option value="funded">Funded</option>
                          <option value="expired">Expired</option>
                          <option value="success">Success</option>
                          <option value="failure">Failure</option>
                        </select>
                        <select className="timelineSelect" value={timelineSort} onChange={(e) => setTimelineSort(e.target.value as any)}>
                          <option value="newest">New</option>
                          <option value="amount_desc">Escrowed</option>
                          <option value="oldest">Old</option>
                        </select>
                      </div>

                      <div className="discoverControlsBottom">
                        <button className="timelineRefresh" onClick={() => loadTimeline().catch((e) => setError((e as Error).message))} disabled={busy != null}>
                          Refresh
                        </button>
                        <button
                          className="timelineRefresh"
                          onClick={() => loadMoreTimeline().catch((e) => setError((e as Error).message))}
                          disabled={busy != null || timelineLoading || timelineLoadingMore || !timelineNextCursor}
                          title="Load older"
                        >
                          {timelineLoadingMore ? "Loading..." : "Load older"}
                        </button>
                      </div>
                    </div>

                    {timelineLoading ? (
                      <div className="discoverGrid" aria-hidden="true">
                        {Array.from({ length: 12 }).map((_, i) => (
                          <div key={i} className="discoverCard discoverCardDisabled">
                            <div className="discoverCardTop">
                              <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0, flex: 1 }}>
                                <div className="skeleton skeletonLineSm" style={{ width: 160 }} />
                                <div className="skeleton skeletonLineSm" style={{ width: 210 }} />
                              </div>
                              <div className="skeleton skeletonLineSm" style={{ width: 70, height: 18, borderRadius: 999 }} />
                            </div>
                            <div style={{ marginTop: 10 }}>
                              <div className="skeleton skeletonLineSm" style={{ width: 220 }} />
                              <div className="skeleton skeletonLineSm" style={{ width: 190, marginTop: 8 }} />
                            </div>
                            <div style={{ marginTop: 14 }}>
                              <div className="skeleton skeletonLineSm" style={{ width: "100%", height: 8, borderRadius: 999 }} />
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : discoverCards.length === 0 ? (
                      <div className="timelineEmpty">No results. Try clearing filters.</div>
                    ) : (
                      <div className="discoverGrid">
                        {discoverCards.map((c) => {
                          const nowUnix = Math.floor(Date.now() / 1000);
                          const target = Math.max(0, Number(c.targetLamports || 0));
                          const escrowed = Math.max(0, Number(c.escrowedLamports || 0));
                          const pct = target > 0 ? clamp01(escrowed / target) : 0;

                          const title = c.projectName || (c.projectSymbol ? `$${c.projectSymbol}` : c.tokenMint ? shortWallet(c.tokenMint) : "Project");
                          const subtitle = c.projectName && c.projectSymbol ? `$${c.projectSymbol}` : c.projectSymbol ? `$${c.projectSymbol}` : "";

                          const statusLower = String(c.status ?? "").toLowerCase();
                          const statusLabel =
                            statusLower.includes("resolved_success") || statusLower.includes("completed")
                              ? "shipped"
                              : statusLower.includes("failed") || statusLower.includes("resolved_failure")
                                ? "failed"
                                : statusLower || "active";

                          const credibilitySignals: string[] = [];
                          if (String(c.creatorFeeMode) === "managed") credibilitySignals.push("auto-escrow");
                          if (escrowed > 0) credibilitySignals.push("funds locked");
                          if (c.milestonesReleased > 0) credibilitySignals.push(`${c.milestonesReleased} released`);
                          if (c.events24h >= 5) credibilitySignals.push("high momentum");

                          const canNavigate = !c.isMock && c.commitmentId;

                          return (
                            <div
                              key={c.key}
                              className={`discoverCard ${!canNavigate ? "discoverCardDisabled" : ""}`}
                              onClick={() => {
                                if (!canNavigate) return;
                                router.push(`/commit/${encodeURIComponent(c.commitmentId)}`);
                              }}
                            >
                              <div className="discoverCardTop">
                                <div style={{ minWidth: 0, flex: 1 }}>
                                  <div className="tokenBadge">
                                    <div className="tokenBadgeIcon" aria-hidden="true">
                                      <span className="tokenBadgeFallback" />
                                      {c.projectImageUrl ? (
                                        <img
                                          className="tokenBadgeImg"
                                          src={c.projectImageUrl}
                                          alt=""
                                          onError={(ev) => {
                                            (ev.currentTarget as HTMLImageElement).style.display = "none";
                                          }}
                                        />
                                      ) : null}
                                    </div>
                                    <div className="tokenBadgeText">
                                      <div className="tokenBadgeTitle">{title}</div>
                                      <div className="tokenBadgeSubtitle">
                                        {statusLabel} · {Math.round(pct * 100)}% escrowed
                                      </div>
                                    </div>
                                  </div>
                                </div>

                                <div className="discoverPills">
                                  <span className={`discoverPill ${statusLabel === "shipped" ? "discoverPillStrong" : ""}`}>{statusLabel}</span>
                                  {c.isMock ? <span className="discoverPill">mock</span> : null}
                                </div>
                              </div>

                              <div className="discoverCardTitle">{c.statement || "Reward commitment"}</div>

                              <div className="discoverMetrics">
                                <div className="discoverMetric">
                                  <div className="discoverMetricLabel">Escrow</div>
                                  <div className="discoverMetricValue">
                                    {fmtSol(escrowed)} / {fmtSol(target)} SOL
                                  </div>
                                </div>
                                <div className="discoverMetric">
                                  <div className="discoverMetricLabel">Milestones</div>
                                  <div className="discoverMetricValue">
                                    {c.milestonesDone}/{c.milestonesTotal} done
                                  </div>
                                </div>
                                <div className="discoverMetric">
                                  <div className="discoverMetricLabel">Momentum</div>
                                  <div className="discoverMetricValue">
                                    {c.events24h} /24h · {c.events7d} /7d
                                  </div>
                                </div>
                                <div className="discoverMetric">
                                  <div className="discoverMetricLabel">Last</div>
                                  <div className="discoverMetricValue">
                                    {c.lastActivityUnix ? unixAgoShort(c.lastActivityUnix, nowUnix) : "–"}
                                  </div>
                                </div>
                              </div>

                              <div className="discoverBar" aria-hidden="true">
                                <div className="discoverBarFill" style={{ width: `${Math.round(pct * 100)}%` }} />
                              </div>

                              <div
                                className="discoverHover"
                                onClick={(ev) => {
                                  ev.stopPropagation();
                                }}
                                onKeyDown={(ev) => ev.stopPropagation()}
                              >
                                <div className="discoverHoverInner">
                                  <div className="discoverHoverRow">
                                    <div style={{ minWidth: 0, flex: 1 }}>
                                      <div className="tokenBadge">
                                        <div className="tokenBadgeIcon" aria-hidden="true">
                                          <span className="tokenBadgeFallback" />
                                          {c.projectImageUrl ? (
                                            <img
                                              className="tokenBadgeImg"
                                              src={c.projectImageUrl}
                                              alt=""
                                              onError={(ev) => {
                                                (ev.currentTarget as HTMLImageElement).style.display = "none";
                                              }}
                                            />
                                          ) : null}
                                        </div>
                                        <div className="tokenBadgeText">
                                          <div className="tokenBadgeTitle">{title}</div>
                                          <div className="tokenBadgeSubtitle">
                                            {statusLabel} · {Math.round(pct * 100)}% escrowed
                                          </div>
                                        </div>
                                      </div>
                                    </div>
                                    <div className="discoverPills">
                                      <span className="discoverPill">{c.events24h} /24h</span>
                                      <span className="discoverPill">{c.events7d} /7d</span>
                                    </div>
                                  </div>

                                  <div className="discoverHoverBody">
                                    {c.projectDesc ? <div className="discoverHoverText">{c.projectDesc}</div> : null}
                                    {c.statement ? <div className="discoverHoverText">{c.statement}</div> : null}

                                    <div className="discoverHoverSignals">
                                      {credibilitySignals.map((s) => (
                                        <span key={s} className="discoverHoverSignal">
                                          {s}
                                        </span>
                                      ))}
                                      {c.milestonesTotal > 0 ? (
                                        <span className="discoverHoverSignal">
                                          milestones {c.milestonesDone}/{c.milestonesTotal}
                                        </span>
                                      ) : null}
                                      {c.tokenMint ? <span className="discoverHoverSignal">CA {shortWallet(c.tokenMint)}</span> : null}
                                    </div>

                                    <div className="discoverHoverActions">
                                      {canNavigate ? (
                                        <button className="discoverAction discoverActionPrimary" type="button" onClick={() => router.push(`/commit/${encodeURIComponent(c.commitmentId)}`)}>
                                          Open
                                        </button>
                                      ) : null}
                                      {c.websiteUrl ? (
                                        <a className="discoverAction" href={c.websiteUrl} target="_blank" rel="noreferrer noopener">
                                          Website
                                        </a>
                                      ) : null}
                                      {c.tokenMint ? (
                                        <a
                                          className="discoverAction"
                                          href={`https://pump.fun/coin/${encodeURIComponent(c.tokenMint)}`}
                                          target="_blank"
                                          rel="noreferrer noopener"
                                        >
                                          pump.fun
                                        </a>
                                      ) : null}
                                      {c.tokenMint ? (
                                        <a
                                          className="discoverAction"
                                          href={`https://solscan.io/token/${encodeURIComponent(c.tokenMint)}`}
                                          target="_blank"
                                          rel="noreferrer noopener"
                                        >
                                          Solscan
                                        </a>
                                      ) : null}
                                      {c.tokenMint ? (
                                        <button
                                          className="discoverAction"
                                          type="button"
                                          onClick={() => copyTimeline(c.tokenMint, `${c.key}:ca`)}
                                        >
                                          {timelineCopied === `${c.key}:ca` ? "Copied" : "Copy CA"}
                                        </button>
                                      ) : null}
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </section>
                </div>
              </div>
            ) : null}
          </main>
        </div>
      </div>
    </>
  );
}
