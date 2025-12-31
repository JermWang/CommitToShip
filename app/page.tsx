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

  const router = useRouter();
  const searchParams = useSearchParams();

  const [tab, setTab] = useState<"landing" | "commit" | "discover">("landing");

  const [statement, setStatement] = useState("");
  const [commitKind, setCommitKind] = useState<"personal" | "creator_reward">("personal");
  const [commitStep, setCommitStep] = useState(1);
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

  const [timelineEvents, setTimelineEvents] = useState<TimelineEvent[]>([]);
  const [timelineCommitments, setTimelineCommitments] = useState<CommitmentSummary[]>([]);
  const [timelineExpanded, setTimelineExpanded] = useState<Record<string, boolean>>({});
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
    if (commitKind === "creator_reward") return ["Basics", "Creator", "Milestones", "Review"];
    return ["Basics", "Details", "Funding", "Review"];
  }, [commitKind]);

  const maxCommitStep = commitSteps.length;

  const commitIssues = useMemo(() => {
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
  }, [amountLamports, authority, commitKind, creatorPubkey, deadlineLocal, destinationOnFail, rewardMilestonesParsed, statement]);

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
    const data = await apiGet<TimelineResponse>(`/api/timeline?limit=120`);
    setTimelineEvents(Array.isArray(data.events) ? data.events : []);
    setTimelineCommitments(Array.isArray(data.commitments) ? data.commitments : []);
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
    const { commitments } = await apiGet<{ commitments: CommitmentSummary[] }>("/api/commitments");
    setCommitments(commitments);
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
      const created = await apiPost<{ id: string }>("/api/commitments", body);
      router.push(`/commit/${created.id}`);
    } finally {
      setBusy(null);
    }
  }

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
  }, [commitKind]);

  useEffect(() => {
    if (tab !== "discover") return;
    loadTimeline().catch((e) => setError((e as Error).message));
  }, [tab]);

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
          <header className="appShellTopbar">
            <div className="appShellTopbarTitle">{tab === "commit" ? "Create" : tab === "discover" ? "Discover" : "Landing"}</div>
            <div className="appShellTopbarActions">
              <button
                className="appShellTopbarBtn"
                onClick={() => (tab === "discover" ? loadTimeline() : loadCommitments()).catch((e) => setError((e as Error).message))}
                disabled={busy != null}
              >
                Refresh
              </button>
            </div>
          </header>

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
                          dev fees in on-chain escrow. Set milestones; holders vote to approve releases. If you miss, fees stay locked or route to the chosen destination.
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
                  {error ? <div className="commitError">{error}</div> : null}

                  <section className="unifiedPanel">
                    <div className="commitLayout">
                      <section className="commitSurface commitSurfaceMain">
                      <div className="commitHero commitHeroInSurface" ref={commitmentRef}>
                        <h1 className="commitHeroTitle">Create Commitment</h1>
                        <p className="commitHeroLead">Lock SOL on-chain with a deadline. Choose your commitment type and define the terms.</p>
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
                                  disabled={busy != null}
                                  role="tab"
                                  aria-selected={active}
                                >
                                  <span className="commitWizardStepIndex">{step}</span>
                                  <span className="commitWizardStepLabel">{label}</span>
                                </button>
                              );
                            })}
                          </div>

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
                        </div>

                        {commitStep === 1 ? (
                          <section className="commitCard commitCardPrimary">
                            <div className="commitCardLabel">Basics</div>

                            <div className="commitField">
                              <div className="commitFieldLabel">Statement</div>
                              <input
                                className="commitInput"
                                value={statement}
                                onChange={(e) => setStatement(e.target.value)}
                                placeholder="What are you committing to ship?"
                              />
                            </div>

                            <div className="commitField" style={{ marginTop: 18 }}>
                              <div className="commitFieldLabel">Commitment Type</div>
                              <div className="commitTypeGrid">
                                <button
                                  className={`commitTypeCard ${commitKind === "personal" ? "commitTypeCardActive" : ""}`}
                                  onClick={() => setCommitKind("personal")}
                                  disabled={busy != null}
                                >
                                  <div className="commitTypeIcon">P</div>
                                  <div className="commitTypeName">Personal</div>
                                  <div className="commitTypeDesc">Time-bound commitment with escrow</div>
                                </button>
                                <button
                                  className={`commitTypeCard ${commitKind === "creator_reward" ? "commitTypeCardActive" : ""}`}
                                  onClick={() => setCommitKind("creator_reward")}
                                  disabled={busy != null}
                                >
                                  <div className="commitTypeIcon" aria-hidden="true">
                                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
                                      <circle cx="12" cy="12" r="6" stroke="currentColor" strokeWidth="2" />
                                      <circle cx="12" cy="12" r="2" stroke="currentColor" strokeWidth="2" />
                                    </svg>
                                  </div>
                                  <div className="commitTypeName">Creator Reward</div>
                                  <div className="commitTypeDesc">Milestone-based fund unlocking</div>
                                </button>
                              </div>
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

                        {commitKind === "creator_reward" && commitStep === 2 ? (
                          <>
                            <section className="commitCard">
                              <div className="commitCardLabel">Creator</div>
                              <div className="commitField">
                                <div className="commitFieldLabel">Dev Wallet (Receives Released Rewards)</div>
                                <input
                                  className="commitInput"
                                  value={creatorPubkey}
                                  onChange={(e) => setCreatorPubkey(e.target.value)}
                                  placeholder="Connect your wallet"
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
                                  {devVerifyBusy === "verify" ? "Verifying..." : devVerify ? "Verified" : "Verify On-Chain"}
                                </button>
                              </div>
                              {devVerifyResult ? (
                                <div className="commitCardDesc" style={{ marginTop: 12 }}>
                                  Mint authority: {devVerifyResult.mintAuthority ?? "None"}
                                  <br />
                                  Update authority: {devVerifyResult.updateAuthority ?? "None"}
                                </div>
                              ) : null}

                              <div className="commitField" style={{ marginTop: 18 }}>
                                <div className="commitFieldLabel">Creator Fee Escrow Mode</div>
                                <select
                                  className="commitInput"
                                  value={rewardCreatorFeeMode}
                                  onChange={(e) => setRewardCreatorFeeMode(e.target.value as CreatorFeeMode)}
                                  disabled={busy != null}
                                >
                                  <option value="managed">Managed Auto-Escrow (Verified)</option>
                                  <option value="assisted">Assisted (Self-custody)</option>
                                </select>
                                <div className="commitCardDesc" style={{ marginTop: 10 }}>
                                  Managed permits CTS to auto-claim and auto-escrow fees. Assisted means CTS can help, but escrow deposits are voluntary.
                                </div>
                              </div>
                            </section>

                            <section className="commitCard">
                              <div className="commitCardLabel">Token</div>
                              <div className="commitCardDesc">Enter the token contract address (mint). This is used for dev verification and can also enable holder-gated approvals.</div>
                              <div className="commitField">
                                <div className="commitFieldLabel">Token Contract Address</div>
                                <input
                                  className="commitInput"
                                  value={rewardTokenMint}
                                  onChange={(e) => setRewardTokenMint(e.target.value)}
                                  placeholder="Token mint address"
                                />
                              </div>
                            </section>
                          </>
                        ) : null}

                        {commitKind === "creator_reward" && commitStep === 3 ? (
                          <section className="commitCard">
                            <div className="commitCardLabel">Milestones</div>
                            <div className="commitCardDesc">Define unlock amounts per milestone. Funds are released from escrow as milestones complete.</div>
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

                        {commitKind === "creator_reward" && commitStep === 4 ? (
                          <section className="commitCard">
                            <div className="commitCardLabel">Review</div>
                            <div className="commitCardDesc">Confirm the terms below. You will get an escrow address after creation.</div>

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
                                  "Create Reward Commitment"
                                )}
                              </button>
                            </div>
                          </section>
                        ) : null}
                      </div>
                      </section>

                      <aside className="commitSide">
                        <section className="commitSurface commitSurfacePreview">
                        <div className="commitCardLabel">Live Preview</div>
                        <div className="commitPreviewTitle">{statement.trim().length ? statement.trim() : "Untitled commitment"}</div>
                        <div className="commitPreviewChips">
                          <span className={`commitPreviewChip ${commitKind === "creator_reward" ? "commitPreviewChipReward" : ""}`}>{commitKind === "creator_reward" ? "reward" : "personal"}</span>
                          {commitKind === "creator_reward" ? <span className="commitPreviewChip">{rewardCreatorFeeMode === "managed" ? "auto-escrow" : "assisted"}</span> : null}
                          {commitIssues.length === 0 ? <span className="commitPreviewChip commitPreviewChipReady">ready</span> : <span className="commitPreviewChip">needs input</span>}
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

                        {commitments.length === 0 ? (
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
                  </section>
                </div>
              </div>
            ) : tab === "discover" ? (
              <div className="timelineStage" ref={timelineRef}>
                <div className="timelineWrap">
                  {error ? <div className="timelineError">{error}</div> : null}

                  <section className="unifiedPanel">
                    <div className="timelineHero">
                      <div className="timelineHeroMark">
                        <img src="/branding/svg-logo.svg" alt="Commit To Ship" className="timelineHeroMarkImg" />
                      </div>
                      <h1 className="timelineHeroTitle">Discovery Timeline</h1>
                      <p className="timelineHeroLead">A living record of execution. No posts. Only verifiable commitment events.</p>
                    </div>

                    <div className="timelineControls">
                    <div className="timelineFilterRow">
                      <button className={`timelineFilter ${timelineFilter === "curated" ? "timelineFilterActive" : ""}`} onClick={() => setTimelineFilter("curated")}>
                        Curated
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

                    <div className="timelineToolRow">
                      <input
                        className="timelineSearch"
                        value={timelineQuery}
                        onChange={(e) => setTimelineQuery(e.target.value)}
                        placeholder="Search commitment id, escrow, tx, statement…"
                      />

                      <select className="timelineSelect" value={timelineKindFilter} onChange={(e) => setTimelineKindFilter(e.target.value as any)}>
                        <option value="all">All kinds</option>
                        <option value="personal">Personal</option>
                        <option value="reward">Reward</option>
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
                        <option value="newest">Newest</option>
                        <option value="oldest">Oldest</option>
                        <option value="amount_desc">Largest amount</option>
                      </select>

                      <button className="timelineRefresh" onClick={() => loadTimeline().catch((e) => setError((e as Error).message))} disabled={busy != null}>
                        Refresh
                      </button>
                    </div>

                    </div>

                    {filteredTimeline.length === 0 ? (
                      <div className="timelineEmpty">No events yet. Create a commitment to start generating verifiable activity.</div>
                    ) : (
                      <div className="timelineRail">
                        {filteredTimeline.map((e) => {
                        const open = Boolean(timelineExpanded[e.id]);
                        const commit = timelineCommitmentsById[String(e.commitmentId)];
                        const tokenMint = typeof commit?.tokenMint === "string" ? commit.tokenMint.trim() : "";

                        const project = tokenMint ? projectsByMint[tokenMint] : undefined;
                        const projectName = project?.name != null ? String(project.name) : "";
                        const projectSymbol = project?.symbol != null ? String(project.symbol) : "";
                        const projectWebsite = project?.websiteUrl != null ? String(project.websiteUrl) : "";
                        const projectDesc = project?.description != null ? String(project.description) : "";

                        const actorPk = String(e.creatorPubkey ?? e.authority ?? "").trim();
                        const actorProfile = actorPk.length ? profilesByWallet[actorPk] : undefined;
                        const actorLabel = actorProfile?.displayName?.trim() ? String(actorProfile.displayName) : actorPk ? shortWallet(actorPk) : "Unknown";
                        const actorBio = actorProfile?.bio != null ? String(actorProfile.bio) : "";

                        const primaryTitle =
                          e.statement && e.statement.trim().length ? e.statement.trim() : e.kind === "creator_reward" ? "Reward commitment" : "Commitment";
                        const rightAmount =
                          e.unlockLamports != null
                            ? `${fmtSol(e.unlockLamports)} SOL`
                            : e.amountLamports != null
                              ? `${fmtSol(e.amountLamports)} SOL`
                              : "";

                        const escrowCopyKey = `${e.id}:escrow`;
                        const txCopyKey = `${e.id}:tx`;
                        const caCopyKey = `${e.id}:ca`;

                        return (
                          <div key={e.id} className={`timelineReceipt ${open ? "timelineReceiptOpen" : ""}`}>
                            <div
                              className="timelineReceiptTop"
                              role="button"
                              tabIndex={0}
                              onClick={() => setTimelineExpanded((prev) => ({ ...prev, [e.id]: !open }))}
                              onKeyDown={(ev) => {
                                if (ev.key === "Enter" || ev.key === " ") {
                                  ev.preventDefault();
                                  setTimelineExpanded((prev) => ({ ...prev, [e.id]: !open }));
                                }
                              }}
                              aria-expanded={open}
                            >
                              <div className="timelineReceiptLeft">
                                {actorPk ? (
                                  <div
                                    className="timelineActor"
                                    onClick={(ev) => ev.stopPropagation()}
                                    onKeyDown={(ev) => ev.stopPropagation()}
                                  >
                                    <a
                                      className="timelineActorLink"
                                      href={`/u/${encodeURIComponent(actorPk)}`}
                                      onClick={(ev) => ev.stopPropagation()}
                                      onKeyDown={(ev) => ev.stopPropagation()}
                                    >
                                      {actorProfile?.avatarUrl ? (
                                        <img className="timelineActorAvatar" src={String(actorProfile.avatarUrl)} alt="" />
                                      ) : (
                                        <span className="timelineActorAvatarFallback" />
                                      )}
                                      <span className="timelineActorName">{actorLabel}</span>
                                    </a>
                                    {actorBio && actorBio.trim().length ? <div className="timelineActorBio">{actorBio}</div> : null}
                                  </div>
                                ) : null}

                                <div className="timelineReceiptKicker">
                                  <span className={`timelineChip ${e.kind === "creator_reward" ? "timelineChipReward" : ""}`}>
                                    {e.kind === "creator_reward" ? "reward" : "personal"}
                                  </span>
                                  {e.kind === "creator_reward" ? (
                                    <span
                                      className={`timelineChip ${String(e.creatorFeeMode ?? "assisted") === "managed" ? "timelineChipModeManaged" : "timelineChipModeAssisted"}`}
                                    >
                                      {String(e.creatorFeeMode ?? "assisted") === "managed" ? "auto-escrow" : "assisted"}
                                    </span>
                                  ) : null}
                                  <span className="timelineChip timelineChipType">{typeLabel(e.type)}</span>
                                  <span className="timelineChip timelineChipStatus">{e.status}</span>
                                </div>
                                <div className="timelineReceiptTitle">{primaryTitle}</div>
                                {e.milestoneTitle ? <div className="timelineReceiptSub">{e.milestoneTitle}</div> : null}

                                {projectName || projectSymbol || projectWebsite || projectDesc || project?.xUrl || project?.telegramUrl || project?.discordUrl ? (
                                  <div className="timelineProjectMeta">
                                    {projectName || projectSymbol ? (
                                      <div className="timelineProjectName">
                                        {projectName ? projectName : null}
                                        {projectName && projectSymbol ? " · " : null}
                                        {projectSymbol ? `$${projectSymbol}` : null}
                                      </div>
                                    ) : null}
                                    {projectDesc && projectDesc.trim().length ? <div className="timelineProjectDesc">{projectDesc}</div> : null}
                                    <div className="timelineSocialRow" onClick={(ev) => ev.stopPropagation()} onKeyDown={(ev) => ev.stopPropagation()}>
                                      {projectWebsite ? (
                                        <a
                                          className="timelineSocialLink"
                                          href={projectWebsite}
                                          target="_blank"
                                          rel="noreferrer noopener"
                                          title="Website"
                                        >
                                          <SocialIcon type="website" />
                                        </a>
                                      ) : null}
                                      {project?.xUrl ? (
                                        <a
                                          className="timelineSocialLink"
                                          href={String(project.xUrl)}
                                          target="_blank"
                                          rel="noreferrer noopener"
                                          title="X / Twitter"
                                        >
                                          <SocialIcon type="x" />
                                        </a>
                                      ) : null}
                                      {project?.telegramUrl ? (
                                        <a
                                          className="timelineSocialLink"
                                          href={String(project.telegramUrl)}
                                          target="_blank"
                                          rel="noreferrer noopener"
                                          title="Telegram"
                                        >
                                          <SocialIcon type="telegram" />
                                        </a>
                                      ) : null}
                                      {project?.discordUrl ? (
                                        <a
                                          className="timelineSocialLink"
                                          href={String(project.discordUrl)}
                                          target="_blank"
                                          rel="noreferrer noopener"
                                          title="Discord"
                                        >
                                          <SocialIcon type="discord" />
                                        </a>
                                      ) : null}
                                    </div>
                                  </div>
                                ) : null}

                                {tokenMint ? (
                                  <div
                                    className="timelineQuickLinks"
                                    onClick={(ev) => ev.stopPropagation()}
                                    onKeyDown={(ev) => ev.stopPropagation()}
                                  >
                                    {projectWebsite ? (
                                      <div className="timelineQuickLink">
                                        <a
                                          className="timelineQuickLinkAnchor"
                                          href={projectWebsite}
                                          target="_blank"
                                          rel="noreferrer noopener"
                                        >
                                          Website
                                        </a>
                                        <div className="timelineQuickHover">
                                          <div className="timelineQuickHoverTitle">Website</div>
                                          <div className="timelineQuickHoverValue">{projectWebsite}</div>
                                        </div>
                                      </div>
                                    ) : null}

                                    <div className="timelineQuickLink">
                                      <button className="timelineQuickLinkBtn" type="button" onClick={() => copyTimeline(tokenMint, caCopyKey)}>
                                        {timelineCopied === caCopyKey ? "Copied CA" : `CA ${shortWallet(tokenMint)}`}
                                      </button>
                                      <div className="timelineQuickHover">
                                        <div className="timelineQuickHoverTitle">Contract</div>
                                        <div className="timelineQuickHoverValue mono">{tokenMint}</div>
                                        <div className="timelineQuickHoverLinks">
                                          <a
                                            className="timelineQuickHoverLink"
                                            href={`https://solscan.io/token/${encodeURIComponent(tokenMint)}`}
                                            target="_blank"
                                            rel="noreferrer noopener"
                                          >
                                            Solscan
                                          </a>
                                          <a
                                            className="timelineQuickHoverLink"
                                            href={`https://pump.fun/coin/${encodeURIComponent(tokenMint)}`}
                                            target="_blank"
                                            rel="noreferrer noopener"
                                          >
                                            pump.fun
                                          </a>
                                          <a
                                            className="timelineQuickHoverLink"
                                            href={`https://dexscreener.com/solana/${encodeURIComponent(tokenMint)}`}
                                            target="_blank"
                                            rel="noreferrer noopener"
                                          >
                                            Dexscreener
                                          </a>
                                        </div>
                                      </div>
                                    </div>

                                    {e.txSig ? (
                                      <div className="timelineQuickLink">
                                        <button
                                          className="timelineQuickLinkBtn"
                                          type="button"
                                          onClick={() => copyTimeline(String(e.txSig), txCopyKey)}
                                        >
                                          {timelineCopied === txCopyKey ? "Copied tx" : "Tx"}
                                        </button>
                                        <div className="timelineQuickHover">
                                          <div className="timelineQuickHoverTitle">Transaction</div>
                                          <div className="timelineQuickHoverValue mono">{String(e.txSig)}</div>
                                          <div className="timelineQuickHoverLinks">
                                            <a
                                              className="timelineQuickHoverLink"
                                              href={`https://solscan.io/tx/${encodeURIComponent(String(e.txSig))}`}
                                              target="_blank"
                                              rel="noreferrer noopener"
                                            >
                                              Solscan
                                            </a>
                                          </div>
                                        </div>
                                      </div>
                                    ) : null}
                                  </div>
                                ) : null}

                                {e.kind === "creator_reward"
                                  ? (() => {
                                      const funded = Number(e.totalFundedLamports ?? 0);
                                      const total = Number(e.milestoneTotalUnlockLamports ?? 0);
                                      const pct = total > 0 ? clamp01(funded / total) : 0;
                                      return (
                                        <div className="timelineCompliance">
                                          <div className="timelineComplianceBar" aria-hidden="true">
                                            <div className="timelineComplianceFill" style={{ width: `${Math.round(pct * 100)}%` }} />
                                          </div>
                                          <div className="timelineComplianceText">
                                            Escrowed {fmtSol(funded)} / {fmtSol(total)} SOL ({Math.round(pct * 100)}%)
                                          </div>
                                        </div>
                                      );
                                    })()
                                  : null}
                              </div>

                              <div className="timelineReceiptRight">
                                {rightAmount ? <div className="timelineReceiptAmount">{rightAmount}</div> : null}
                                <div className="timelineReceiptTime">{humanTime(e.timestampUnix)}</div>
                              </div>
                            </div>

                            {open ? (
                              <div className="timelineReceiptBody">
                                <div className="timelineReceiptActions">
                                  <button className="timelineActionBtn" type="button" onClick={() => router.push(`/commit/${e.commitmentId}`)}>
                                    View dashboard
                                  </button>
                                  <button className="timelineActionBtn" type="button" onClick={() => copyTimeline(e.escrowPubkey, escrowCopyKey)}>
                                    {timelineCopied === escrowCopyKey ? "Copied escrow" : "Copy escrow"}
                                  </button>
                                  {e.txSig ? (
                                    <button className="timelineActionBtn" type="button" onClick={() => copyTimeline(e.txSig as string, txCopyKey)}>
                                      {timelineCopied === txCopyKey ? "Copied tx" : "Copy tx"}
                                    </button>
                                  ) : null}
                                  {tokenMint ? (
                                    <button className="timelineActionBtn" type="button" onClick={() => copyTimeline(tokenMint, caCopyKey)}>
                                      {timelineCopied === caCopyKey ? "Copied CA" : "Copy CA"}
                                    </button>
                                  ) : null}
                                </div>

                                <div className="timelineReceiptGrid">
                                  <div className="timelineReceiptRow">
                                    <div className="timelineReceiptLabel">Commitment</div>
                                    <div className="timelineReceiptValue mono">{e.commitmentId}</div>
                                  </div>
                                  <div className="timelineReceiptRow">
                                    <div className="timelineReceiptLabel">Escrow</div>
                                    <div className="timelineReceiptValue mono">{e.escrowPubkey}</div>
                                  </div>
                                  {e.creatorPubkey ? (
                                    <div className="timelineReceiptRow">
                                      <div className="timelineReceiptLabel">Creator</div>
                                      <div className="timelineReceiptValue">
                                        {(() => {
                                          const pk = String(e.creatorPubkey);
                                          const p = profilesByWallet[pk];
                                          const label = p?.displayName?.trim() ? String(p.displayName) : shortWallet(pk);
                                          return (
                                            <a className="timelineProfileLink" href={`/u/${encodeURIComponent(pk)}`}>
                                              {p?.avatarUrl ? (
                                                <img className="timelineProfileAvatar" src={String(p.avatarUrl)} alt="" />
                                              ) : (
                                                <span className="timelineProfileAvatarFallback" />
                                              )}
                                              <span className="mono">{label}</span>
                                            </a>
                                          );
                                        })()}
                                      </div>
                                    </div>
                                  ) : null}
                                  {e.authority ? (
                                    <div className="timelineReceiptRow">
                                      <div className="timelineReceiptLabel">Authority</div>
                                      <div className="timelineReceiptValue">
                                        {(() => {
                                          const pk = String(e.authority);
                                          const p = profilesByWallet[pk];
                                          const label = p?.displayName?.trim() ? String(p.displayName) : shortWallet(pk);
                                          return (
                                            <a className="timelineProfileLink" href={`/u/${encodeURIComponent(pk)}`}>
                                              {p?.avatarUrl ? (
                                                <img className="timelineProfileAvatar" src={String(p.avatarUrl)} alt="" />
                                              ) : (
                                                <span className="timelineProfileAvatarFallback" />
                                              )}
                                              <span className="mono">{label}</span>
                                            </a>
                                          );
                                        })()}
                                      </div>
                                    </div>
                                  ) : null}
                                  {e.txSig ? (
                                    <div className="timelineReceiptRow">
                                      <div className="timelineReceiptLabel">Tx</div>
                                      <div className="timelineReceiptValue mono">{e.txSig}</div>
                                    </div>
                                  ) : null}
                                  {tokenMint ? (
                                    <div className="timelineReceiptRow">
                                      <div className="timelineReceiptLabel">CA</div>
                                      <div className="timelineReceiptValue mono">{tokenMint}</div>
                                    </div>
                                  ) : null}
                                </div>
                              </div>
                            ) : null}
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
