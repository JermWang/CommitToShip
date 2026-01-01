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
  bannerUrl?: string | null;
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
  const [commitPath, setCommitPath] = useState<null | "automated" | "manual">("automated");
  const [commitStep, setCommitStep] = useState(1);
  const [statementTouched, setStatementTouched] = useState(false);

  const [draftName, setDraftName] = useState("");
  const [draftSymbol, setDraftSymbol] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [draftImageUrl, setDraftImageUrl] = useState("");
  const [draftBannerUrl, setDraftBannerUrl] = useState("");
  const [draftWebsiteUrl, setDraftWebsiteUrl] = useState("");
  const [draftXUrl, setDraftXUrl] = useState("");
  const [draftTelegramUrl, setDraftTelegramUrl] = useState("");
  const [draftDiscordUrl, setDraftDiscordUrl] = useState("");
  const [authority, setAuthority] = useState("");
  const [destinationOnFail, setDestinationOnFail] = useState("");
  const [amountSol, setAmountSol] = useState("0.01");
  const [creatorPubkey, setCreatorPubkey] = useState("");
  const [rewardTokenMint, setRewardTokenMint] = useState("");
  const [rewardCreatorFeeMode, setRewardCreatorFeeMode] = useState<CreatorFeeMode>("managed");
  const [rewardMilestones, setRewardMilestones] = useState<Array<{ title: string; unlockSol: string }>>([
    { title: "", unlockSol: "0.25" },
    { title: "", unlockSol: "0.25" },
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
  const [projectEditBannerUrl, setProjectEditBannerUrl] = useState("");
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
      // Creator reward mode
      if (!creatorPubkey.trim().length) issues.push("Connect your wallet.");
      
      // Manual mode requires token mint and dev verification
      if (commitPath === "manual") {
        if (!rewardTokenMint.trim().length) issues.push("Enter the token mint address.");
        if (!devVerify) issues.push("Verify your dev wallet on-chain.");
      }
      
      // Both modes require milestones
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

  function isAllowedPumpfunImageType(contentType: string): boolean {
    const ct = String(contentType || "").toLowerCase();
    return ct === "image/png" || ct === "image/jpeg" || ct === "image/jpg" || ct === "image/webp" || ct === "image/gif";
  }

  async function readImageDimensions(file: File): Promise<{ width: number; height: number }> {
    const url = URL.createObjectURL(file);
    try {
      const img = document.createElement("img");
      const dims = await new Promise<{ width: number; height: number }>((resolve, reject) => {
        img.onload = () => resolve({ width: img.naturalWidth || img.width, height: img.naturalHeight || img.height });
        img.onerror = () => reject(new Error("Failed to read image dimensions"));
        img.src = url;
      });
      return dims;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function validatePumpfunAsset(file: File, kind: "icon" | "banner"): Promise<void> {
    if (!isAllowedPumpfunImageType(file.type)) {
      throw new Error("Unsupported image type. Use .jpg, .png, .gif, or .webp (pump.fun)");
    }

    if (kind === "icon") {
      const maxBytes = 15 * 1024 * 1024;
      if (file.size > maxBytes) throw new Error("Icon must be 15MB or smaller (pump.fun)");
      const { width, height } = await readImageDimensions(file);
      if (width < 1000 || height < 1000) throw new Error("Icon must be at least 1000×1000 (pump.fun)");
      const ratio = width / Math.max(1, height);
      if (Math.abs(ratio - 1) > 0.05) throw new Error("Icon should be square (1:1) (pump.fun)");
      return;
    }

    const maxBytes = 5 * 1024 * 1024;
    if (file.size > maxBytes) throw new Error("Banner must be 5MB or smaller (pump.fun)");
    const { width, height } = await readImageDimensions(file);
    if (width < 1500 || height < 500) throw new Error("Banner should be at least 1500×500 (pump.fun)");
    const ratio = width / Math.max(1, height);
    if (Math.abs(ratio - 3) > 0.1) throw new Error("Banner should be ~3:1 aspect ratio (pump.fun)");
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

  async function uploadProjectAsset(input: { kind: "icon" | "banner"; file: File }): Promise<{ publicUrl: string; path: string }> {
    if (commitKind !== "creator_reward") throw new Error("Project uploads are only available for creator commitments");
    if (!devVerify) throw new Error("Verify your dev wallet on-chain first");
    const mint = rewardTokenMint.trim();
    if (!mint) throw new Error("Enter token mint first");

    const info = await apiPost<any>("/api/projects/assets/upload-url", {
      tokenMint: mint,
      kind: input.kind,
      contentType: input.file.type || "image/png",
      devVerify,
    });

    const signedUrl = String(info?.signedUrl ?? "");
    if (!signedUrl) throw new Error("Missing signedUrl");

    const form = new FormData();
    form.append("cacheControl", "3600");
    form.append("", input.file);

    const uploadRes = await fetch(signedUrl, {
      method: "PUT",
      headers: { "x-upsert": "true" },
      body: form,
    });

    if (!uploadRes.ok) {
      const text = await uploadRes.text().catch(() => "");
      throw new Error(`Upload failed (${uploadRes.status}) ${text}`);
    }

    const publicUrl = String(info?.publicUrl ?? "");
    const path = String(info?.path ?? "");
    if (!publicUrl) throw new Error("Missing publicUrl");
    return { publicUrl, path };
  }

  async function uploadAdminProjectAsset(input: { kind: "icon" | "banner"; file: File }): Promise<{ publicUrl: string; path: string }> {
    if (!adminWalletPubkey) throw new Error("Admin sign-in required");
    const mint = projectEditMint.trim();
    if (!mint) throw new Error("Token mint required");

    const info = await apiPost<any>("/api/admin/projects/assets/upload-url", {
      tokenMint: mint,
      kind: input.kind,
      contentType: input.file.type || "image/png",
    });

    const signedUrl = String(info?.signedUrl ?? "");
    if (!signedUrl) throw new Error("Missing signedUrl");

    const form = new FormData();
    form.append("cacheControl", "3600");
    form.append("", input.file);

    const uploadRes = await fetch(signedUrl, {
      method: "PUT",
      headers: { "x-upsert": "true" },
      body: form,
    });

    if (!uploadRes.ok) {
      const text = await uploadRes.text().catch(() => "");
      throw new Error(`Upload failed (${uploadRes.status}) ${text}`);
    }

    const publicUrl = String(info?.publicUrl ?? "");
    const path = String(info?.path ?? "");
    if (!publicUrl) throw new Error("Missing publicUrl");
    return { publicUrl, path };
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
      bannerUrl: draftBannerUrl.trim().length ? draftBannerUrl.trim() : null,
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
      setProjectEditBannerUrl((project as any)?.bannerUrl != null ? String((project as any).bannerUrl) : "");
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
            bannerUrl: (project as any)?.bannerUrl ?? null,
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
        bannerUrl: normUrl(projectEditBannerUrl),
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
            bannerUrl: (project as any)?.bannerUrl ?? null,
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
          bannerUrl: (p as any)?.bannerUrl ?? null,
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

    const minCards = 6;
    const need = Math.max(0, minCards - sorted.length);
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
      // Automated launch mode - use /api/launch
      if (commitKind === "creator_reward" && commitPath === "automated") {
        const milestones = rewardMilestones
          .map((m) => ({
            title: m.title.trim(),
            unlockLamports: Math.floor(Number(m.unlockSol) * 1_000_000_000),
          }))
          .filter((m) => m.title.length > 0);

        const launchBody = {
          name: draftName.trim(),
          symbol: draftSymbol.trim(),
          description: draftDescription.trim(),
          imageUrl: draftImageUrl,
          bannerUrl: draftBannerUrl,
          statement,
          payoutWallet: creatorPubkey.trim(),
          milestones,
          websiteUrl: draftWebsiteUrl.trim(),
          xUrl: draftXUrl.trim(),
          telegramUrl: draftTelegramUrl.trim(),
          discordUrl: draftDiscordUrl.trim(),
          devBuySol: 0.01, // Default dev buy
        };

        const launched = await apiPost<{ commitmentId: string; tokenMint: string; launchTxSig: string }>("/api/launch", launchBody);
        router.push(`/commit/${launched.commitmentId}`);
        return;
      }

      // Manual mode or personal commitment - use /api/commitments
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
    return () => {
      document.body.dataset.skin = "app";
      document.documentElement.dataset.skin = "app";
    };
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
                          <img src="/branding/white-logo.png" alt="Commit To Ship" className="heroMarkImage" />
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
              <div className="createPage" ref={commitmentRef}>
                <div className="createWrap">
                  <ClosedBetaNotice />

                  {/* Launch Mode Toggle */}
                  <div className="createModeToggle">
                    <button
                      className={`createModeBtn ${commitPath === "automated" ? "createModeBtnActive" : ""}`}
                      onClick={() => setCommitPath("automated")}
                    >
                      <svg className="createModeIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                      </svg>
                      <div className="createModeInfo">
                        <div className="createModeName">Launch with Auto-Lock</div>
                        <div className="createModeDesc">We launch your token and auto-lock fees</div>
                      </div>
                    </button>
                    <button
                      className={`createModeBtn ${commitPath === "manual" ? "createModeBtnActive" : ""}`}
                      onClick={() => setCommitPath("manual")}
                    >
                      <svg className="createModeIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                      </svg>
                      <div className="createModeInfo">
                        <div className="createModeName">Manual Lock</div>
                        <div className="createModeDesc">Already launched? Link your existing token</div>
                      </div>
                    </button>
                  </div>

                  {/* Image Upload Section */}
                  <div className="createSection">
                    <label className={`createUploadZone ${draftImageUrl ? "createUploadZoneActive" : ""}`}>
                      {draftImageUrl ? (
                        <img src={draftImageUrl} alt="Token icon" className="createPreviewImg" />
                      ) : (
                        <svg className="createUploadIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                          <rect x="3" y="3" width="18" height="18" rx="2" />
                          <circle cx="8.5" cy="8.5" r="1.5" />
                          <path d="M21 15l-5-5L5 21" />
                        </svg>
                      )}
                      <div className="createUploadText">{draftImageUrl ? "Image uploaded" : "Select image to upload"}</div>
                      <div className="createUploadHint">or drag and drop it here</div>
                      <span className="createUploadBtn">{busy === "upload:icon" ? "Uploading..." : "Select file"}</span>
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/gif"
                        style={{ display: "none" }}
                        disabled={busy != null}
                        onChange={async (e) => {
                          const f = e.currentTarget.files?.[0];
                          e.currentTarget.value = "";
                          if (!f) return;
                          setError(null);
                          setBusy("upload:icon");
                          try {
                            await validatePumpfunAsset(f, "icon");
                            const { publicUrl } = await uploadProjectAsset({ kind: "icon", file: f });
                            setDraftImageUrl(publicUrl);
                          } catch (err) {
                            setError((err as Error).message);
                          } finally {
                            setBusy(null);
                          }
                        }}
                      />
                    </label>

                    <div className="createUploadSpecs">
                      <div className="createUploadSpec">
                        <svg className="createUploadSpecIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                          <polyline points="14,2 14,8 20,8" />
                        </svg>
                        <div className="createUploadSpecTitle">File size and type</div>
                        <ul className="createUploadSpecList">
                          <li>Max 15mb, .jpg, .gif or .png</li>
                        </ul>
                      </div>
                      <div className="createUploadSpec">
                        <svg className="createUploadSpecIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                          <rect x="3" y="3" width="18" height="18" rx="2" />
                          <line x1="3" y1="9" x2="21" y2="9" />
                          <line x1="9" y1="21" x2="9" y2="9" />
                        </svg>
                        <div className="createUploadSpecTitle">Resolution</div>
                        <ul className="createUploadSpecList">
                          <li>Min. 1000×1000px, 1:1 square</li>
                        </ul>
                      </div>
                    </div>
                  </div>

                  {/* Coin Details Section */}
                  <div className="createSection">
                    <h2 className="createSectionTitle">Coin details</h2>
                    <p className="createSectionSub">Choose carefully, these can&apos;t be changed once created.</p>

                    <div className="createFieldRow">
                      <div className="createField">
                        <label className="createLabel">Coin name</label>
                        <input
                          className="createInput"
                          value={draftName}
                          onChange={(e) => setDraftName(e.target.value)}
                          placeholder="Name your coin"
                        />
                      </div>
                      <div className="createField">
                        <label className="createLabel">Ticker</label>
                        <input
                          className="createInput"
                          value={draftSymbol}
                          onChange={(e) => setDraftSymbol(e.target.value)}
                          placeholder="e.g. DOGE"
                        />
                      </div>
                    </div>

                    <div className="createField">
                      <label className="createLabel">Description <span className="createLabelOptional">(Optional)</span></label>
                      <textarea
                        className="createTextarea"
                        value={draftDescription}
                        onChange={(e) => setDraftDescription(e.target.value)}
                        placeholder="Write a short description"
                      />
                    </div>

                    {/* Token Mint - Only for Manual mode */}
                    {commitPath === "manual" ? (
                      <div className="createField">
                        <label className="createLabel">Token Mint Address</label>
                        <input
                          className="createInput"
                          value={rewardTokenMint}
                          onChange={(e) => setRewardTokenMint(e.target.value)}
                          placeholder="Paste your existing token contract address"
                        />
                        <div className="createFieldHint">The contract address of your already-launched token</div>
                      </div>
                    ) : null}

                    {/* Banner Upload - Only for Automated mode */}
                    {commitPath === "automated" ? (
                      <div className="createField">
                        <label className="createLabel">Banner Image <span className="createLabelOptional">(Optional)</span></label>
                        <label className={`createUploadZoneSmall ${draftBannerUrl ? "createUploadZoneActive" : ""}`}>
                          {draftBannerUrl ? (
                            <img src={draftBannerUrl} alt="Banner" className="createPreviewBanner" />
                          ) : (
                            <svg className="createUploadIconSmall" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                              <rect x="2" y="5" width="20" height="14" rx="2" />
                              <circle cx="8" cy="11" r="2" />
                              <path d="M22 15l-4-4-6 6" />
                            </svg>
                          )}
                          <div className="createUploadSmallText">{draftBannerUrl ? "Banner uploaded" : "Upload banner (1500×500)"}</div>
                          <input
                            type="file"
                            accept="image/png,image/jpeg,image/webp,image/gif"
                            style={{ display: "none" }}
                            disabled={busy != null}
                            onChange={async (e) => {
                              const f = e.currentTarget.files?.[0];
                              e.currentTarget.value = "";
                              if (!f) return;
                              setError(null);
                              setBusy("upload:banner");
                              try {
                                await validatePumpfunAsset(f, "banner");
                                const { publicUrl } = await uploadProjectAsset({ kind: "banner", file: f });
                                setDraftBannerUrl(publicUrl);
                              } catch (err) {
                                setError((err as Error).message);
                              } finally {
                                setBusy(null);
                              }
                            }}
                          />
                        </label>
                      </div>
                    ) : null}

                    <button
                      type="button"
                      className="createExpandBtn"
                      onClick={() => setCommitStep(commitStep === 2 ? 1 : 2)}
                      style={{ marginTop: 16 }}
                    >
                      <svg className={`createExpandIcon ${commitStep === 2 ? "createExpandIconOpen" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M6 9l6 6 6-6" />
                      </svg>
                      Add social links <span className="createLabelOptional">(Optional)</span>
                    </button>

                    {commitStep === 2 ? (
                      <div style={{ marginTop: 16 }}>
                        <div className="createFieldRow">
                          <div className="createField">
                            <label className="createLabel">Website</label>
                            <input className="createInput" value={draftWebsiteUrl} onChange={(e) => setDraftWebsiteUrl(e.target.value)} placeholder="https://..." />
                          </div>
                          <div className="createField">
                            <label className="createLabel">X (Twitter)</label>
                            <input className="createInput" value={draftXUrl} onChange={(e) => setDraftXUrl(e.target.value)} placeholder="https://x.com/..." />
                          </div>
                        </div>
                        <div className="createFieldRow">
                          <div className="createField">
                            <label className="createLabel">Telegram</label>
                            <input className="createInput" value={draftTelegramUrl} onChange={(e) => setDraftTelegramUrl(e.target.value)} placeholder="https://t.me/..." />
                          </div>
                          <div className="createField">
                            <label className="createLabel">Discord</label>
                            <input className="createInput" value={draftDiscordUrl} onChange={(e) => setDraftDiscordUrl(e.target.value)} placeholder="https://discord.gg/..." />
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </div>

                  <div className="createDivider" />

                  {/* Creator Fee Lock Section - Simplified */}
                  <div className="createSection">
                    <h2 className="createSectionTitle">Fee Lock Settings</h2>
                    <p className="createSectionSub">Lock your pump.fun creator fees to build trust with holders.</p>

                    <div className="createToggleRow">
                      <div className="createToggleLeft">
                        <div className="createToggleIcon">
                          <svg className="createToggleIconSvg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                          </svg>
                        </div>
                        <div className="createToggleInfo">
                          <div className="createToggleName">
                            Auto-Lock Fees
                            <span className="createToggleTag">Recommended</span>
                          </div>
                          <div className="createToggleDesc">Automatically lock creator fees in escrow</div>
                        </div>
                      </div>
                      <label className="createSwitch">
                        <input
                          type="checkbox"
                          className="createSwitchInput"
                          checked={rewardCreatorFeeMode === "managed"}
                          onChange={(e) => setRewardCreatorFeeMode(e.target.checked ? "managed" : "assisted")}
                        />
                        <span className="createSwitchTrack" />
                      </label>
                    </div>

                    <div className="createInfoBox">
                      <div className="createInfoTitle">How it works</div>
                      <div className="createInfoText">
                        Your pump.fun creator fees are held in escrow until you complete milestones. 
                        Holders vote to approve releases. If milestones aren&apos;t met, fees stay locked.
                      </div>
                    </div>
                  </div>

                  {/* Milestones Section */}
                  <div className="createSection">
                    <h2 className="createSectionTitle">Milestones</h2>
                    <p className="createSectionSub">Define what you&apos;ll deliver. Fees unlock as you complete each milestone.</p>

                    <div className="createMilestoneList">
                      {rewardMilestones.map((m, idx) => (
                        <div key={idx} className="createMilestone">
                          <div className="createMilestoneNum">{idx + 1}</div>
                          <div className="createMilestoneFields">
                            <input
                              className="createMilestoneInput"
                              value={m.title}
                              onChange={(e) => setRewardMilestones((prev) => prev.map((x, i) => (i === idx ? { ...x, title: e.target.value } : x)))}
                              placeholder={`Milestone ${idx + 1}`}
                            />
                            <input
                              className="createMilestoneInput"
                              value={m.unlockSol}
                              onChange={(e) => setRewardMilestones((prev) => prev.map((x, i) => (i === idx ? { ...x, unlockSol: e.target.value } : x)))}
                              placeholder="SOL"
                              inputMode="decimal"
                            />
                          </div>
                          <button
                            className="createMilestoneRemove"
                            onClick={() => setRewardMilestones((prev) => prev.filter((_, i) => i !== idx))}
                            disabled={rewardMilestones.length <= 1 || busy != null}
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>

                    <button
                      className="createAddBtn"
                      onClick={() => setRewardMilestones((prev) => [...prev, { title: "", unlockSol: "0.25" }])}
                      disabled={busy != null || rewardMilestones.length >= 12}
                    >
                      + Add milestone
                    </button>
                  </div>

                  {/* Wallet Verification - Only for Manual mode */}
                  {commitPath === "manual" ? (
                    <>
                      <div className="createDivider" />
                      <div className="createSection">
                        <h2 className="createSectionTitle">Verify Ownership</h2>
                        <p className="createSectionSub">Connect and verify your wallet to prove you&apos;re the token creator.</p>

                        <div className="createField">
                          <label className="createLabel">Creator Wallet</label>
                          <input
                            className="createInput"
                            value={creatorPubkey}
                            onChange={(e) => setCreatorPubkey(e.target.value)}
                            placeholder="Your wallet address"
                            readOnly={Boolean(devWalletPubkey)}
                          />
                        </div>

                        <div style={{ display: "flex", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
                          <button
                            className="createUploadBtn"
                            style={{ background: devWalletPubkey ? "rgba(134, 239, 172, 0.2)" : undefined, color: devWalletPubkey ? "rgba(134, 239, 172, 0.9)" : undefined }}
                            onClick={connectDevWallet}
                            disabled={busy != null || devVerifyBusy != null}
                          >
                            {devVerifyBusy === "connect" ? "Connecting..." : devWalletPubkey ? "✓ Connected" : "Connect Wallet"}
                          </button>
                          <button
                            className="createUploadBtn"
                            style={{ 
                              background: devVerify ? "rgba(134, 239, 172, 0.2)" : "rgba(255,255,255,0.1)", 
                              color: devVerify ? "rgba(134, 239, 172, 0.9)" : "rgba(255,255,255,0.7)" 
                            }}
                            onClick={verifyDevWallet}
                            disabled={busy != null || devVerifyBusy != null || !devWalletPubkey || !rewardTokenMint.trim().length}
                          >
                            {devVerifyBusy === "verify" ? "Verifying..." : devVerify ? "✓ Verified" : "Verify Authority"}
                          </button>
                        </div>

                        {devVerifyResult ? (
                          <div className="createInfoBox" style={{ marginTop: 16, marginBottom: 0 }}>
                            <div className="createInfoText">
                              Mint authority: {devVerifyResult.mintAuthority ?? "None"}<br />
                              Update authority: {devVerifyResult.updateAuthority ?? "None"}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    </>
                  ) : null}

                  {/* Connect Wallet - For Automated mode (simpler) */}
                  {commitPath === "automated" ? (
                    <>
                      <div className="createDivider" />
                      <div className="createSection">
                        <h2 className="createSectionTitle">Connect Wallet</h2>
                        <p className="createSectionSub">Connect your wallet to receive milestone payouts.</p>

                        <div className="createField">
                          <label className="createLabel">Your Wallet</label>
                          <input
                            className="createInput"
                            value={creatorPubkey}
                            onChange={(e) => setCreatorPubkey(e.target.value)}
                            placeholder="Your wallet address"
                            readOnly={Boolean(devWalletPubkey)}
                          />
                        </div>

                        <button
                          className="createUploadBtn"
                          style={{ marginTop: 12, background: devWalletPubkey ? "rgba(134, 239, 172, 0.2)" : undefined, color: devWalletPubkey ? "rgba(134, 239, 172, 0.9)" : undefined }}
                          onClick={connectDevWallet}
                          disabled={busy != null || devVerifyBusy != null}
                        >
                          {devVerifyBusy === "connect" ? "Connecting..." : devWalletPubkey ? "✓ Connected" : "Connect Wallet"}
                        </button>
                      </div>
                    </>
                  ) : null}

                  {/* Error Display */}
                  {error ? <div className="createError">{error}</div> : null}

                  {/* Commit Issues */}
                  {commitIssues.length > 0 ? (
                    <div className="createInfoBox" style={{ borderColor: "rgba(251, 191, 36, 0.3)", background: "rgba(251, 191, 36, 0.08)" }}>
                      <div className="createInfoTitle" style={{ color: "rgba(251, 191, 36, 0.9)" }}>Before you can create:</div>
                      <div className="createInfoText">
                        {commitIssues.map((issue, i) => (
                          <div key={i}>• {issue}</div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {/* Submit Button */}
                  <button
                    className="createSubmitBtn"
                    onClick={createCommitment}
                    disabled={busy === "create" || commitIssues.length > 0}
                  >
                    {busy === "create" ? "Creating..." : "Create Commitment"}
                  </button>
                </div>
              </div>
            ) : tab === "discover" ? (
              <div className="discoverStage" ref={timelineRef}>
                <div className="discoverWrap">
                  {error ? <div className="timelineError">{error}</div> : null}

                  <section className="discoverPanel">
                    <div className="discoverHeader">
                      <div className="discoverHeaderTop">
                        <h1 className="discoverTitle">Discover Projects</h1>
                        <div className="discoverStats">
                          <div className="discoverStat">
                            <div className="discoverStatLabel">Projects</div>
                            <div className="discoverStatValue">{fmtCompact(discoverStats.realCount)}</div>
                          </div>
                          <div className="discoverStat">
                            <div className="discoverStatLabel">Active</div>
                            <div className="discoverStatValue">{fmtCompact(discoverStats.active)}</div>
                          </div>
                          <div className="discoverStat">
                            <div className="discoverStatLabel">Escrowed</div>
                            <div className="discoverStatValue">{fmtCompact(discoverStats.escrowedSol)} SOL</div>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="discoverControls">
                      <div className="discoverControlsTop">
                        <div className="timelineFilterRow">
                          <button className={`timelineFilter ${timelineFilter === "curated" ? "timelineFilterActive" : ""}`} onClick={() => setTimelineFilter("curated")}>Hot</button>
                          <button className={`timelineFilter ${timelineFilter === "completed" ? "timelineFilterActive" : ""}`} onClick={() => setTimelineFilter("completed")}>Shipped</button>
                          <button className={`timelineFilter ${timelineFilter === "reward" ? "timelineFilterActive" : ""}`} onClick={() => setTimelineFilter("reward")}>Rewards</button>
                          <button className={`timelineFilter ${timelineFilter === "all" ? "timelineFilterActive" : ""}`} onClick={() => setTimelineFilter("all")}>All</button>
                        </div>
                        <select className="timelineSelect" value={timelineSort} onChange={(e) => setTimelineSort(e.target.value as any)}>
                          <option value="newest">Newest</option>
                          <option value="amount_desc">Most Escrowed</option>
                          <option value="oldest">Oldest</option>
                        </select>
                      </div>
                      <div className="discoverControlsBottom">
                        <input
                          className="timelineSearch"
                          value={timelineQuery}
                          onChange={(e) => setTimelineQuery(e.target.value)}
                          placeholder="Search by name, symbol, or address..."
                        />
                        <button className="timelineRefresh" onClick={() => loadTimeline().catch((e) => setError((e as Error).message))} disabled={busy != null}>
                          Refresh
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
                          const caKey = `${c.key}:ca`;

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
                                  <div className="discoverMetricLabel">Escrowed</div>
                                  <div className="discoverMetricValue">{fmtSol(escrowed)} SOL</div>
                                </div>
                                <div className="discoverMetric">
                                  <div className="discoverMetricLabel">Progress</div>
                                  <div className="discoverMetricValue">{c.milestonesDone}/{c.milestonesTotal}</div>
                                </div>
                                <div className="discoverMetric">
                                  <div className="discoverMetricLabel">Activity</div>
                                  <div className="discoverMetricValue">{c.events24h}/24h</div>
                                </div>
                                <div className="discoverMetric">
                                  <div className="discoverMetricLabel">Updated</div>
                                  <div className="discoverMetricValue">{c.lastActivityUnix ? unixAgoShort(c.lastActivityUnix, nowUnix) : "–"}</div>
                                </div>
                              </div>

                              <div className="discoverBar" aria-hidden="true">
                                <div className="discoverBarFill" style={{ width: `${Math.round(pct * 100)}%` }} />
                              </div>

                              <div className="discoverFoot" onClick={(ev) => ev.stopPropagation()} onKeyDown={(ev) => ev.stopPropagation()}>
                                <div className="discoverFootLeft">
                                  {c.tokenMint ? (
                                    <button
                                      className="discoverCopy"
                                      type="button"
                                      onClick={() => copyTimeline(c.tokenMint, caKey)}
                                      title="Copy contract address"
                                    >
                                      <span className="discoverCopyLabel">CA</span>
                                      <span className="discoverCopyValue mono">{shortWallet(c.tokenMint)}</span>
                                      <span className="discoverCopyHint">{timelineCopied === caKey ? "copied" : "copy"}</span>
                                    </button>
                                  ) : null}
                                </div>

                                <div className="discoverFootRight">
                                  {c.websiteUrl ? (
                                    <div className="timelineQuickLink">
                                      <a
                                        className="timelineSocialLink"
                                        href={c.websiteUrl}
                                        target="_blank"
                                        rel="noreferrer noopener"
                                        aria-label="Website"
                                        title="Website"
                                      >
                                        <SocialIcon type="website" />
                                      </a>
                                      <div className="timelineQuickHover">
                                        <div className="timelineQuickHoverTitle">Website</div>
                                        <div className="timelineQuickHoverValue">{c.websiteUrl}</div>
                                      </div>
                                    </div>
                                  ) : null}
                                  {c.xUrl ? (
                                    <div className="timelineQuickLink">
                                      <a className="timelineSocialLink" href={c.xUrl} target="_blank" rel="noreferrer noopener" aria-label="X" title="X">
                                        <SocialIcon type="x" />
                                      </a>
                                      <div className="timelineQuickHover">
                                        <div className="timelineQuickHoverTitle">X</div>
                                        <div className="timelineQuickHoverValue">{c.xUrl}</div>
                                      </div>
                                    </div>
                                  ) : null}
                                  {c.telegramUrl ? (
                                    <div className="timelineQuickLink">
                                      <a
                                        className="timelineSocialLink"
                                        href={c.telegramUrl}
                                        target="_blank"
                                        rel="noreferrer noopener"
                                        aria-label="Telegram"
                                        title="Telegram"
                                      >
                                        <SocialIcon type="telegram" />
                                      </a>
                                      <div className="timelineQuickHover">
                                        <div className="timelineQuickHoverTitle">Telegram</div>
                                        <div className="timelineQuickHoverValue">{c.telegramUrl}</div>
                                      </div>
                                    </div>
                                  ) : null}
                                  {c.discordUrl ? (
                                    <div className="timelineQuickLink">
                                      <a
                                        className="timelineSocialLink"
                                        href={c.discordUrl}
                                        target="_blank"
                                        rel="noreferrer noopener"
                                        aria-label="Discord"
                                        title="Discord"
                                      >
                                        <SocialIcon type="discord" />
                                      </a>
                                      <div className="timelineQuickHover">
                                        <div className="timelineQuickHoverTitle">Discord</div>
                                        <div className="timelineQuickHoverValue">{c.discordUrl}</div>
                                      </div>
                                    </div>
                                  ) : null}
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
  );
}
