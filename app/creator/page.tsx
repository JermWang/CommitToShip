"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import bs58 from "bs58";
import { useToast } from "@/app/components/ToastProvider";
import styles from "./CreatorDashboard.module.css";

type MilestoneData = {
  id: string;
  title: string;
  unlockLamports: number;
  unlockPercent?: number;
  dueAtUnix?: number;
  reviewOpenedAtUnix?: number;
  status: "locked" | "approved" | "failed" | "claimable" | "released";
  completedAtUnix?: number;
  claimableAtUnix?: number;
  releasedAtUnix?: number;
  releasedTxSig?: string;
  autoKind?: "market_cap";
  marketCapThresholdUsd?: number;
  requireNoMintAuthority?: boolean;
  autoConfirmedAtUnix?: number;
  index: number;
  approvalCount: number;
  approvalThreshold: number;
};

type WithdrawalData = {
  milestoneId: string;
  milestoneTitle: string;
  amountLamports: number;
  releasedAtUnix?: number;
  txSig: string;
  solscanUrl: string;
};

type FailureTransferData = {
  kind: "milestone_failure_buyback" | "milestone_failure_voter_pot_to_treasury";
  milestoneId: string;
  distributionId: string;
  amountLamports: number;
  createdAtUnix: number;
  txSig: string;
  solscanUrl: string;
};

type VoterPayoutData = {
  kind: "milestone_failure_voter_claim";
  milestoneId: string;
  distributionId: string;
  walletPubkey: string;
  claimedAtUnix: number;
  amountLamports: number;
  txSig: string;
  solscanUrl: string;
};

type ProjectData = {
  commitment: {
    id: string;
    statement?: string;
    status: string;
    creatorPubkey?: string;
    creatorFeeMode?: "managed" | "assisted" | null;
    tokenMint?: string;
    createdAtUnix: number;
    escrowPubkey: string;
    totalFundedLamports: number;
    unlockedLamports: number;
  };
  projectProfile?: {
    name?: string;
    symbol?: string;
    imageUrl?: string;
    description?: string;
  } | null;
  escrow: {
    balanceLamports: number;
    releasedLamports: number;
    unlockedLamports: number;
    claimableLamports: number;
    pendingLamports: number;
  };
  milestones: MilestoneData[];
  stats: {
    milestonesTotal: number;
    milestonesCompleted: number;
    milestonesReleased: number;
    milestonesClaimable: number;
  };
  withdrawals: WithdrawalData[];
  failureTransfers?: FailureTransferData[];
  voterPayouts?: VoterPayoutData[];
};

type SummaryData = {
  totalProjects: number;
  activeProjects: number;
  completedProjects: number;
  failedProjects: number;
  totalMilestones: number;
  completedMilestones: number;
  releasedMilestones: number;
  claimableMilestones: number;
  totalEarnedLamports: number;
  totalReleasedLamports: number;
  totalClaimableLamports: number;
  totalPendingLamports: number;
};

type CreatorData = {
  wallet: string;
  projects: ProjectData[];
  summary: SummaryData;
};

function fmtSol(lamports: number): string {
  const sol = lamports / 1_000_000_000;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(sol);
}

function parseUsdShorthand(rawInput: string): number | null {
  const raw = String(rawInput ?? "")
    .trim()
    .toLowerCase()
    .replace(/[$,_\s]/g, "");
  if (!raw) return null;

  const m = raw.match(/^([0-9]+(?:\.[0-9]+)?)([kmb])?$/);
  if (!m) return null;

  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;

  const suf = String(m[2] ?? "");
  const mult = suf === "k" ? 1_000 : suf === "m" ? 1_000_000 : suf === "b" ? 1_000_000_000 : 1;

  const out = Math.floor(n * mult);
  if (!Number.isFinite(out) || out <= 0) return null;
  if (!Number.isSafeInteger(out)) return null;
  return out;
}

function fmtUsdShort(value: number): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "0";
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(abs / 1_000_000_000)}B`;
  if (abs >= 1_000_000) return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(abs / 1_000_000)}M`;
  if (abs >= 1_000) return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(abs / 1_000)}K`;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(abs);
}

function shortWallet(pk: string): string {
  const s = String(pk ?? "").trim();
  if (!s) return "";
  if (s.length <= 10) return s;
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function effectiveUnlockLamports(m: MilestoneData, totalFundedLamports: number): number {
  const explicit = Number(m.unlockLamports ?? 0);
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  const pct = Number(m.unlockPercent ?? 0);
  const total = Number(totalFundedLamports ?? 0);
  if (!Number.isFinite(pct) || pct <= 0) return 0;
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.floor((total * pct) / 100);
}

function formatDate(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatDateTime(unix: number): string {
  return new Date(unix * 1000).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function sweepMessage(input: { commitmentId: string; timestampUnix: number }): string {
  return `Commit To Ship\nEscrow Sweep\nCommitment: ${input.commitmentId}\nTimestamp: ${input.timestampUnix}`;
}

function toDatetimeLocalValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toDatetimeLocalValueFromUnix(unix?: number): string {
  const n = Number(unix ?? 0);
  if (!Number.isFinite(n) || n <= 0) return "";
  return toDatetimeLocalValue(new Date(n * 1000));
}

async function readJsonSafe(res: Response): Promise<any> {
  const text = await res.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

function makeRequestId(): string {
  const c: any = globalThis as any;
  const uuid = c?.crypto?.randomUUID;
  if (typeof uuid === "function") return uuid.call(c.crypto);
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

type TimeFilter = "all" | "30d" | "90d" | "1y";
type StatusFilter = "all" | "active" | "completed" | "failed";

function CreatorDashboardPage() {
  const router = useRouter();
  const pathname = usePathname();
  const embedded = Boolean(pathname && pathname.startsWith("/dashboard"));
  const toast = useToast();
  const { publicKey, connected, signMessage } = useWallet();
  const { setVisible } = useWalletModal();

  const [milestoneBusy, setMilestoneBusy] = useState<string | null>(null);
  const [milestoneManagerOpen, setMilestoneManagerOpen] = useState<boolean>(true);
  const [milestoneReviewMode, setMilestoneReviewMode] = useState<Record<string, "deadline" | "now">>({});

  const [newMilestoneTitle, setNewMilestoneTitle] = useState<string>("");
  const [newMilestoneUnlockPercent, setNewMilestoneUnlockPercent] = useState<string>("25");
  const [newMilestoneDueLocal, setNewMilestoneDueLocal] = useState<string>(() => toDatetimeLocalValue(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)));
  const [newMilestoneKind, setNewMilestoneKind] = useState<"manual" | "market_cap">("manual");
  const [newMilestoneThresholdUsd, setNewMilestoneThresholdUsd] = useState<string>("10m");

  const [editingMilestoneId, setEditingMilestoneId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState<string>("");
  const [editUnlockPercent, setEditUnlockPercent] = useState<string>("");
  const [editDueLocal, setEditDueLocal] = useState<string>("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<CreatorData | null>(null);

  const [sweepBusy, setSweepBusy] = useState(false);

  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [timeFilter, setTimeFilter] = useState<TimeFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const fetchCreatorData = useCallback(async (wallet: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/creator/${encodeURIComponent(wallet)}`);
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || `Failed to fetch (${res.status})`);
      }
      const json = await res.json();
      setData(json);
      if (json.projects?.length > 0 && !selectedProjectId) {
        setSelectedProjectId(json.projects[0].commitment.id);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [selectedProjectId]);

  useEffect(() => {
    if (connected && publicKey) {
      fetchCreatorData(publicKey.toBase58());
    } else {
      setData(null);
    }
  }, [connected, publicKey, fetchCreatorData]);

  const filteredProjects = useMemo(() => {
    if (!data?.projects) return [];
    let projects = data.projects;

    // Time filter
    if (timeFilter !== "all") {
      const now = Math.floor(Date.now() / 1000);
      const days = timeFilter === "30d" ? 30 : timeFilter === "90d" ? 90 : 365;
      const cutoff = now - days * 86400;
      projects = projects.filter((p) => p.commitment.createdAtUnix >= cutoff);
    }

    // Status filter
    if (statusFilter !== "all") {
      projects = projects.filter((p) => {
        const s = p.commitment.status.toLowerCase();
        if (statusFilter === "active") return s === "active" || s === "created";
        if (statusFilter === "completed") return s === "completed" || s === "resolved_success";
        if (statusFilter === "failed") return s === "failed" || s === "resolved_failure";
        return true;
      });
    }

    return projects;
  }, [data, timeFilter, statusFilter]);

  const selectedProject = useMemo(() => {
    if (!selectedProjectId || !data?.projects) return null;
    return data.projects.find((p) => p.commitment.id === selectedProjectId) ?? null;
  }, [selectedProjectId, data]);

  const handleConnectWallet = () => {
    setVisible(true);
  };

  const signerPubkey = useMemo(() => (publicKey ? publicKey.toBase58() : ""), [publicKey]);

  const selectedAllocatedPercent = useMemo(() => {
    if (!selectedProject) return 0;
    const total = Number(selectedProject.commitment.totalFundedLamports ?? 0);
    return selectedProject.milestones.reduce((acc, m) => {
      const explicitLamports = Number(m.unlockLamports ?? 0);
      if (Number.isFinite(total) && total > 0 && Number.isFinite(explicitLamports) && explicitLamports > 0) {
        return acc + (explicitLamports / total) * 100;
      }
      return acc + (Number(m.unlockPercent ?? 0) || 0);
    }, 0);
  }, [selectedProject]);

  const canManageSelectedProject = useMemo(() => {
    if (!selectedProject) return false;
    const creatorPk = String(selectedProject.commitment.creatorPubkey ?? "").trim();
    if (!creatorPk) return false;
    return Boolean(signerPubkey) && signerPubkey === creatorPk;
  }, [selectedProject, signerPubkey]);

  const selectedProjectCreatorPk = useMemo(() => {
    if (!selectedProject) return "";
    return String(selectedProject.commitment.creatorPubkey ?? "").trim();
  }, [selectedProject]);

  const signText = useCallback(async (message: string): Promise<string> => {
    if (!publicKey) throw new Error("Connect wallet first");
    if (!signMessage) throw new Error("Wallet does not support message signing");
    const bytes = new TextEncoder().encode(message);
    const sig = await signMessage(bytes);
    return bs58.encode(sig);
  }, [publicKey, signMessage]);

  const postJson = useCallback(async (url: string, body: any) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
      cache: "no-store",
    });
    const json = await readJsonSafe(res);
    if (!res.ok) throw new Error(json?.error ?? `Request failed (${res.status})`);
    return json;
  }, []);

  const refreshSelected = useCallback(async () => {
    if (!publicKey) return;
    await fetchCreatorData(publicKey.toBase58());
  }, [fetchCreatorData, publicKey]);

  const submitSweepNow = useCallback(async () => {
    if (!selectedProject) return;
    const commitmentId = selectedProject.commitment.id;

    const creatorPk = String(selectedProject.commitment.creatorPubkey ?? "").trim();
    if (creatorPk && signerPubkey && signerPubkey !== creatorPk) {
      toast({ kind: "error", message: `Connect the creator wallet (${shortWallet(creatorPk)}) to trigger a sweep.` });
      return;
    }

    const mode = String(selectedProject.commitment.creatorFeeMode ?? "").trim();
    if (mode !== "managed") {
      toast({ kind: "error", message: "This project is not in managed mode. Sweeps are server-side for managed commitments only." });
      return;
    }

    setSweepBusy(true);
    try {
      const timestampUnix = Math.floor(Date.now() / 1000);
      const message = sweepMessage({ commitmentId, timestampUnix });
      const signatureB58 = await signText(message);

      const res = await postJson(`/api/commitments/${encodeURIComponent(commitmentId)}/escrow/sweep`, {
        timestampUnix,
        signatureB58,
      });

      const txSig = String(res?.result?.signature ?? "").trim();
      const solscanUrl = String(res?.solscanUrl ?? "").trim();

      if (txSig && solscanUrl) {
        toast({ kind: "success", message: "Sweep submitted. View on Solscan." });
        window.open(solscanUrl, "_blank", "noopener,noreferrer");
      } else {
        const swept = Boolean(res?.result?.swept);
        toast({ kind: "success", message: swept ? "Sweep completed" : "No claimable creator fees" });
      }

      await refreshSelected();
    } catch (e) {
      toast({ kind: "error", message: (e as Error).message });
    } finally {
      setSweepBusy(false);
    }
  }, [postJson, refreshSelected, selectedProject, signText, signerPubkey, toast]);

  const milestoneAddMessage = useCallback((input: { commitmentId: string; requestId: string; title: string; unlockPercent: number; dueAtUnix: number }): string => {
    return `Commit To Ship\nAdd Milestone\nCommitment: ${input.commitmentId}\nRequest: ${input.requestId}\nTitle: ${input.title}\nUnlockPercent: ${input.unlockPercent}\nDueAtUnix: ${input.dueAtUnix}`;
  }, []);

  const milestoneAddMarketCapMessage = useCallback((input: { commitmentId: string; requestId: string; title: string; unlockPercent: number; thresholdUsd: number }): string => {
    return `Commit To Ship\nAdd Market Cap Milestone\nCommitment: ${input.commitmentId}\nRequest: ${input.requestId}\nTitle: ${input.title}\nUnlockPercent: ${input.unlockPercent}\nThresholdUsd: ${input.thresholdUsd}`;
  }, []);

  const milestoneCompleteMessage = useCallback((input: { commitmentId: string; milestoneId: string; review?: "early" }): string => {
    const base = `Commit To Ship\nMilestone Completion\nCommitment: ${input.commitmentId}\nMilestone: ${input.milestoneId}`;
    if (input.review === "early") return `${base}\nReview: early`;
    return base;
  }, []);

  const milestoneClaimMessage = useCallback((input: { commitmentId: string; milestoneId: string }): string => {
    return `Commit To Ship\nMilestone Claim\nCommitment: ${input.commitmentId}\nMilestone: ${input.milestoneId}`;
  }, []);

  const milestoneEditMessage = useCallback((input: { commitmentId: string; milestoneId: string; requestId: string; title: string; unlockPercent: number; dueAtUnix: number }): string => {
    return `Commit To Ship\nEdit Milestone\nCommitment: ${input.commitmentId}\nMilestone: ${input.milestoneId}\nRequest: ${input.requestId}\nTitle: ${input.title}\nUnlockPercent: ${input.unlockPercent}\nDueAtUnix: ${input.dueAtUnix}`;
  }, []);

  const submitAddMilestone = useCallback(async () => {
    if (!selectedProject) return;
    const commitmentId = selectedProject.commitment.id;

    const creatorPk = String(selectedProject.commitment.creatorPubkey ?? "").trim();
    if (creatorPk && signerPubkey && signerPubkey !== creatorPk) {
      toast({ kind: "error", message: `Connect the creator wallet (${shortWallet(creatorPk)}) to manage milestones.` });
      return;
    }

    const title = String(newMilestoneTitle ?? "").trim();
    if (!title) {
      toast({ kind: "error", message: "Milestone title required" });
      return;
    }

    const unlockPercent = Math.floor(Number(newMilestoneUnlockPercent));
    if (!Number.isFinite(unlockPercent) || unlockPercent <= 0 || unlockPercent > 100) {
      toast({ kind: "error", message: "Unlock percentage must be between 1 and 100" });
      return;
    }

    const totalNext = selectedAllocatedPercent + unlockPercent;
    if (totalNext > 100) {
      toast({ kind: "error", message: `Total allocation cannot exceed 100% (would be ${totalNext}%).` });
      return;
    }

    const requestId = makeRequestId();

    const isMarketCap = newMilestoneKind === "market_cap";
    const message = isMarketCap
      ? milestoneAddMarketCapMessage({
          commitmentId,
          requestId,
          title,
          unlockPercent,
          thresholdUsd: parseUsdShorthand(newMilestoneThresholdUsd) ?? 0,
        })
      : milestoneAddMessage({
          commitmentId,
          requestId,
          title,
          unlockPercent,
          dueAtUnix: Math.floor(new Date(String(newMilestoneDueLocal ?? "")).getTime() / 1000),
        });

    setMilestoneBusy("add");
    try {
      if (isMarketCap) {
        const tokenMint = String(selectedProject.commitment.tokenMint ?? "").trim();
        if (!tokenMint) {
          toast({ kind: "error", message: "Token mint required for market cap milestones" });
          return;
        }

        const thresholdUsd = parseUsdShorthand(newMilestoneThresholdUsd);
        if (!thresholdUsd) {
          toast({ kind: "error", message: "Market cap threshold required (e.g. 10m, 250k)" });
          return;
        }

        const signature = await signText(message);
        await postJson(`/api/commitments/${encodeURIComponent(commitmentId)}/milestones/add-marketcap`, {
          requestId,
          title,
          unlockPercent,
          thresholdUsd,
          message,
          signature,
        });
      } else {
        const dueAtMs = new Date(String(newMilestoneDueLocal ?? "")).getTime();
        if (!Number.isFinite(dueAtMs) || dueAtMs <= 0) {
          toast({ kind: "error", message: "Due date required" });
          return;
        }
        const dueAtUnix = Math.floor(dueAtMs / 1000);

        const signature = await signText(message);
        await postJson(`/api/commitments/${encodeURIComponent(commitmentId)}/milestones/add`, {
          requestId,
          title,
          unlockPercent,
          dueAtUnix,
          message,
          signature,
        });
      }
      setNewMilestoneTitle("");
      setNewMilestoneUnlockPercent("25");
      setNewMilestoneDueLocal(toDatetimeLocalValue(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)));
      setNewMilestoneThresholdUsd("10m");
      toast({ kind: "success", message: "Milestone added" });
      await refreshSelected();
    } catch (e) {
      toast({ kind: "error", message: (e as Error).message });
    } finally {
      setMilestoneBusy(null);
    }
  }, [milestoneAddMarketCapMessage, milestoneAddMessage, newMilestoneDueLocal, newMilestoneKind, newMilestoneThresholdUsd, newMilestoneTitle, newMilestoneUnlockPercent, postJson, refreshSelected, selectedAllocatedPercent, selectedProject, signText, signerPubkey, toast]);

  const submitCompleteMilestone = useCallback(async (milestoneId: string, opts?: { review?: "early" }) => {
    if (!selectedProject) return;
    const commitmentId = selectedProject.commitment.id;
    const creatorPk = String(selectedProject.commitment.creatorPubkey ?? "").trim();
    if (creatorPk && signerPubkey && signerPubkey !== creatorPk) {
      toast({ kind: "error", message: `Connect the creator wallet (${shortWallet(creatorPk)}) to manage milestones.` });
      return;
    }

    const review = opts?.review;
    const message = milestoneCompleteMessage({ commitmentId, milestoneId, review });
    setMilestoneBusy(`complete:${milestoneId}`);
    try {
      const signature = await signText(message);
      await postJson(`/api/commitments/${encodeURIComponent(commitmentId)}/milestones/${encodeURIComponent(milestoneId)}/complete`, {
        message,
        signature,
        review,
      });
      toast({ kind: "success", message: "Milestone marked complete" });
      await refreshSelected();
    } catch (e) {
      toast({ kind: "error", message: (e as Error).message });
    } finally {
      setMilestoneBusy(null);
    }
  }, [milestoneCompleteMessage, postJson, refreshSelected, selectedProject, signText, signerPubkey, toast]);

  const submitClaimMilestone = useCallback(async (milestoneId: string) => {
    if (!selectedProject) return;
    const commitmentId = selectedProject.commitment.id;
    const creatorPk = String(selectedProject.commitment.creatorPubkey ?? "").trim();
    if (creatorPk && signerPubkey && signerPubkey !== creatorPk) {
      toast({ kind: "error", message: `Connect the creator wallet (${shortWallet(creatorPk)}) to claim.` });
      return;
    }

    const message = milestoneClaimMessage({ commitmentId, milestoneId });
    setMilestoneBusy(`claim:${milestoneId}`);
    try {
      const signature = await signText(message);
      await postJson(`/api/commitments/${encodeURIComponent(commitmentId)}/milestones/${encodeURIComponent(milestoneId)}/claim`, {
        message,
        signature,
      });
      toast({ kind: "success", message: "Milestone claimed" });
      await refreshSelected();
    } catch (e) {
      toast({ kind: "error", message: (e as Error).message });
    } finally {
      setMilestoneBusy(null);
    }
  }, [milestoneClaimMessage, postJson, refreshSelected, selectedProject, signText, signerPubkey, toast]);

  const beginEditMilestone = useCallback((m: MilestoneData) => {
    setEditingMilestoneId(m.id);
    setEditTitle(String(m.title ?? ""));
    setEditUnlockPercent(String(Number(m.unlockPercent ?? 0) || ""));
    setEditDueLocal(toDatetimeLocalValueFromUnix(m.dueAtUnix));
  }, []);

  const cancelEditMilestone = useCallback(() => {
    setEditingMilestoneId(null);
    setEditTitle("");
    setEditUnlockPercent("");
    setEditDueLocal("");
  }, []);

  const submitEditMilestone = useCallback(async (milestoneId: string) => {
    if (!selectedProject) return;
    const commitmentId = selectedProject.commitment.id;

    const creatorPk = String(selectedProject.commitment.creatorPubkey ?? "").trim();
    if (creatorPk && signerPubkey && signerPubkey !== creatorPk) {
      toast({ kind: "error", message: `Connect the creator wallet (${shortWallet(creatorPk)}) to edit milestones.` });
      return;
    }

    const title = String(editTitle ?? "").trim();
    if (!title) {
      toast({ kind: "error", message: "Milestone title required" });
      return;
    }
    const unlockPercent = Math.floor(Number(editUnlockPercent));
    if (!Number.isFinite(unlockPercent) || unlockPercent <= 0 || unlockPercent > 100) {
      toast({ kind: "error", message: "Unlock percentage must be between 1 and 100" });
      return;
    }
    const dueAtMs = new Date(String(editDueLocal ?? "")).getTime();
    if (!Number.isFinite(dueAtMs) || dueAtMs <= 0) {
      toast({ kind: "error", message: "Due date required" });
      return;
    }
    const dueAtUnix = Math.floor(dueAtMs / 1000);

    const existing = selectedProject.milestones.find((x) => x.id === milestoneId);
    const totalFunded = Number(selectedProject.commitment.totalFundedLamports ?? 0);
    const existingLamports = Number(existing?.unlockLamports ?? 0);
    const existingPct =
      Number.isFinite(totalFunded) && totalFunded > 0 && Number.isFinite(existingLamports) && existingLamports > 0
        ? (existingLamports / totalFunded) * 100
        : Number(existing?.unlockPercent ?? 0) || 0;
    const totalNext = selectedAllocatedPercent - existingPct + unlockPercent;
    if (totalNext > 100) {
      toast({ kind: "error", message: `Total allocation cannot exceed 100% (would be ${totalNext}%).` });
      return;
    }

    const requestId = makeRequestId();
    const message = milestoneEditMessage({ commitmentId, milestoneId, requestId, title, unlockPercent, dueAtUnix });

    setMilestoneBusy(`edit:${milestoneId}`);
    try {
      const signature = await signText(message);
      await postJson(`/api/commitments/${encodeURIComponent(commitmentId)}/milestones/${encodeURIComponent(milestoneId)}/edit`, {
        requestId,
        title,
        unlockPercent,
        dueAtUnix,
        message,
        signature,
      });
      toast({ kind: "success", message: "Milestone updated" });
      cancelEditMilestone();
      await refreshSelected();
    } catch (e) {
      toast({ kind: "error", message: (e as Error).message });
    } finally {
      setMilestoneBusy(null);
    }
  }, [cancelEditMilestone, editDueLocal, editTitle, editUnlockPercent, milestoneEditMessage, postJson, refreshSelected, selectedAllocatedPercent, selectedProject, signText, signerPubkey, toast]);

  if (!connected) {
    return (
      <div className={styles.page}>
        <div className={styles.connectPrompt}>
          <img className={styles.connectIcon} src="/branding/white-logo.png" alt="" />
          <h1 className={styles.connectTitle}>Creator Dashboard</h1>
          <p className={styles.connectSubtitle}>
            Connect your wallet to view your projects, milestones, and earnings.
          </p>
          <button className={styles.connectBtn} onClick={handleConnectWallet}>
            Connect Wallet
          </button>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className={styles.page}>
        <div className={styles.loading}>
          <div className={styles.spinner} />
          <p>Loading your dashboard...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.page}>
        <div className={styles.error}>
          <p>Error: {error}</p>
          <button className={styles.retryBtn} onClick={() => publicKey && fetchCreatorData(publicKey.toBase58())}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!data || data.projects.length === 0) {
    return (
      <div className={styles.page}>
        <div className={styles.empty}>
          <img className={styles.emptyIcon} src="/branding/white-logo.png" alt="" />
          <h2>No Projects Yet</h2>
          <p>You haven&apos;t created any projects with CommitToShip yet.</p>
          <button className={styles.createBtn} onClick={() => { window.scrollTo({ top: 0, behavior: "instant" }); router.push("/?tab=commit"); }}>
            Create Your First Project
          </button>
        </div>
      </div>
    );
  }

  const summary = data.summary;

  return (
    <div className={styles.page} style={embedded ? ({ padding: 0, maxWidth: "none" } as any) : undefined}>
      {!embedded ? (
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <h1 className={styles.title}>Creator Dashboard</h1>
            <p className={styles.wallet}>
              <span className={styles.walletDot} />
              {shortWallet(data.wallet)}
            </p>
          </div>
          <button className={styles.refreshBtn} onClick={() => publicKey && fetchCreatorData(publicKey.toBase58())}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M23 4v6h-6M1 20v-6h6" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
            Refresh
          </button>
        </div>
      ) : null}

      {/* Summary Cards */}
      <div className={styles.summaryGrid}>
        <div className={styles.summaryCard}>
          <div className={styles.summaryLabel}>Total Earned</div>
          <div className={styles.summaryValue}>{fmtSol(summary.totalEarnedLamports)} SOL</div>
        </div>
        <div className={styles.summaryCard}>
          <div className={styles.summaryLabel}>Released</div>
          <div className={`${styles.summaryValue} ${styles.summaryValueGreen}`}>
            {fmtSol(summary.totalReleasedLamports)} SOL
          </div>
        </div>
        <div className={styles.summaryCard}>
          <div className={styles.summaryLabel}>Claimable</div>
          <div className={`${styles.summaryValue} ${styles.summaryValueBlue}`}>
            {fmtSol(summary.totalClaimableLamports)} SOL
          </div>
        </div>
        <div className={styles.summaryCard}>
          <div className={styles.summaryLabel}>Pending</div>
          <div className={styles.summaryValue}>{fmtSol(summary.totalPendingLamports)} SOL</div>
        </div>
      </div>

      {/* Stats Row */}
      <div className={styles.statsRow}>
        <div className={styles.stat}>
          <span className={styles.statValue}>{summary.totalProjects}</span>
          <span className={styles.statLabel}>Projects</span>
        </div>
        <div className={styles.stat}>
          <span className={`${styles.statValue} ${styles.statValueGreen}`}>{summary.activeProjects}</span>
          <span className={styles.statLabel}>Active</span>
        </div>
        <div className={styles.stat}>
          <span className={`${styles.statValue} ${styles.statValueBlue}`}>{summary.completedProjects}</span>
          <span className={styles.statLabel}>Completed</span>
        </div>
        <div className={styles.stat}>
          <span className={`${styles.statValue} ${styles.statValueOrange}`}>{summary.failedProjects}</span>
          <span className={styles.statLabel}>Failed</span>
        </div>
        <div className={styles.statDivider} />
        <div className={styles.stat}>
          <span className={styles.statValue}>{summary.totalMilestones}</span>
          <span className={styles.statLabel}>Milestones</span>
        </div>
        <div className={styles.stat}>
          <span className={`${styles.statValue} ${styles.statValueGreen}`}>{summary.releasedMilestones}</span>
          <span className={styles.statLabel}>Released</span>
        </div>
        <div className={styles.stat}>
          <span className={`${styles.statValue} ${styles.statValueBlue}`}>{summary.claimableMilestones}</span>
          <span className={styles.statLabel}>Claimable</span>
        </div>
      </div>

      {/* Filters */}
      <div className={styles.filters}>
        <div className={styles.filterGroup}>
          <label className={styles.filterLabel}>Time</label>
          <select
            className={styles.filterSelect}
            value={timeFilter}
            onChange={(e) => setTimeFilter(e.target.value as TimeFilter)}
          >
            <option value="all">All Time</option>
            <option value="30d">Last 30 Days</option>
            <option value="90d">Last 90 Days</option>
            <option value="1y">Last Year</option>
          </select>
        </div>
        <div className={styles.filterGroup}>
          <label className={styles.filterLabel}>Status</label>
          <select
            className={styles.filterSelect}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          >
            <option value="all">All Status</option>
            <option value="active">Active</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
          </select>
        </div>
      </div>

      {/* Main Content */}
      <div className={styles.mainContent}>
        {/* Project List */}
        <div className={styles.projectList}>
          <div className={styles.projectListHeader}>Your Projects ({filteredProjects.length})</div>
          {filteredProjects.map((project) => {
            const isSelected = project.commitment.id === selectedProjectId;
            const name = project.projectProfile?.name || project.projectProfile?.symbol || "Project";
            const symbol = project.projectProfile?.symbol ? `$${project.projectProfile.symbol}` : "";
            const status = project.commitment.status;
            const statusClass =
              status === "active" || status === "created"
                ? styles.statusActive
                : status === "completed" || status === "resolved_success"
                ? styles.statusCompleted
                : styles.statusFailed;

            return (
              <div
                key={project.commitment.id}
                className={`${styles.projectItem} ${isSelected ? styles.projectItemSelected : ""}`}
                onClick={() => setSelectedProjectId(project.commitment.id)}
              >
                <div className={styles.projectItemImage}>
                  {project.projectProfile?.imageUrl ? (
                    <img src={project.projectProfile.imageUrl} alt="" />
                  ) : null}
                </div>
                <div className={styles.projectItemInfo}>
                  <div className={styles.projectItemName}>
                    {name} {symbol && <span className={styles.projectItemSymbol}>{symbol}</span>}
                  </div>
                  <div className={styles.projectItemMeta}>
                    <span className={statusClass}>{status}</span>
                    <span className={styles.projectItemDot}>·</span>
                    <span>{formatDate(project.commitment.createdAtUnix)}</span>
                  </div>
                </div>
                <div className={styles.projectItemStats}>
                  <div className={styles.projectItemSol}>{fmtSol(project.escrow.releasedLamports + project.escrow.claimableLamports)} SOL</div>
                  <div className={styles.projectItemProgress}>
                    {project.stats.milestonesReleased}/{project.stats.milestonesTotal}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Project Detail */}
        {selectedProject ? (
          <div className={styles.projectDetail}>
            <div className={styles.detailHeader}>
              <div className={styles.detailImage}>
                {selectedProject.projectProfile?.imageUrl ? (
                  <img src={selectedProject.projectProfile.imageUrl} alt="" />
                ) : null}
              </div>
              <div className={styles.detailInfo}>
                <h2 className={styles.detailName}>
                  {selectedProject.projectProfile?.name || "Project"}
                  {selectedProject.projectProfile?.symbol && (
                    <span className={styles.detailSymbol}>${selectedProject.projectProfile.symbol}</span>
                  )}
                </h2>
                <p className={styles.detailStatement}>{selectedProject.commitment.statement || "No statement"}</p>
                <div className={styles.detailMeta}>
                  <span>Created {formatDate(selectedProject.commitment.createdAtUnix)}</span>
                  <span className={styles.detailDot}>·</span>
                  <a
                    href={`/commit/${encodeURIComponent(selectedProject.commitment.id)}`}
                    className={styles.detailLink}
                  >
                    View Public Page →
                  </a>
                </div>
              </div>
            </div>

            {/* Escrow Stats */}
            <div className={styles.escrowStats}>
              <div className={styles.escrowStat}>
                <div className={styles.escrowStatLabel}>Escrow Balance</div>
                <div className={styles.escrowStatValue}>{fmtSol(selectedProject.escrow.balanceLamports)} SOL</div>
              </div>
              <div className={styles.escrowStat}>
                <div className={styles.escrowStatLabel}>Released</div>
                <div className={`${styles.escrowStatValue} ${styles.escrowStatValueGreen}`}>
                  {fmtSol(selectedProject.escrow.releasedLamports)} SOL
                </div>
              </div>
              <div className={styles.escrowStat}>
                <div className={styles.escrowStatLabel}>Claimable</div>
                <div className={`${styles.escrowStatValue} ${styles.escrowStatValueBlue}`}>
                  {fmtSol(selectedProject.escrow.claimableLamports)} SOL
                </div>
              </div>
              <div className={styles.escrowStat}>
                <div className={styles.escrowStatLabel}>Pending</div>
                <div className={styles.escrowStatValue}>{fmtSol(selectedProject.escrow.pendingLamports)} SOL</div>
              </div>
            </div>

            {/* Claim Button */}
            {selectedProject.escrow.claimableLamports > 0 && (
              <div className={styles.claimSection}>
                <div className={styles.claimInfo}>
                  <div className={styles.claimAmount}>
                    {fmtSol(selectedProject.escrow.claimableLamports)} SOL
                  </div>
                  <div className={styles.claimLabel}>Ready to claim</div>
                </div>
                <a
                  href={`/commit/${encodeURIComponent(selectedProject.commitment.id)}`}
                  className={styles.claimBtn}
                >
                  Claim Fees →
                </a>
              </div>
            )}

            {String(selectedProject.commitment.creatorFeeMode ?? "") === "managed" ? (
              <div className={styles.claimSection}>
                <div className={styles.claimInfo}>
                  <div className={styles.claimAmount}>Sweep creator fees</div>
                  <div className={styles.claimLabel}>Move claimable Pump.fun fees into escrow</div>
                </div>
                <button
                  type="button"
                  className={styles.claimBtn}
                  onClick={submitSweepNow}
                  disabled={sweepBusy || !canManageSelectedProject}
                >
                  {sweepBusy ? "Sweeping…" : "Sweep now →"}
                </button>
              </div>
            ) : null}

            {/* Milestones */}
            <div className={styles.milestonesSection}>
              <div className={styles.milestonesSectionHeader}>
                <h3>Milestones</h3>
                <div className={styles.milestonesHeaderRight}>
                  <span className={styles.milestonesCount}>
                    {selectedProject.stats.milestonesReleased}/{selectedProject.stats.milestonesTotal} released
                  </span>
                </div>
              </div>

              <div className={styles.milestoneManagerCard}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                  <div style={{ minWidth: 220 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "rgba(255,255,255,0.9)" }}>Milestone Manager</div>
                    <div style={{ fontSize: 12, color: "rgba(255,255,255,0.55)", marginTop: 4 }}>
                      Define deliverables and how fees unlock. Totals should add to 100% before you start completing milestones.
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{
                      padding: "8px 10px",
                      borderRadius: 999,
                      border: `1px solid ${selectedAllocatedPercent >= 99.5 ? "rgba(134,239,172,0.25)" : "rgba(96,165,250,0.22)"}`,
                      background: selectedAllocatedPercent >= 99.5 ? "rgba(134,239,172,0.10)" : "rgba(96,165,250,0.10)",
                      fontSize: 12,
                      fontWeight: 700,
                      color: selectedAllocatedPercent >= 99.5 ? "rgba(134,239,172,0.95)" : "rgba(96,165,250,0.95)",
                    }}>
                      {Math.round(selectedAllocatedPercent)}% allocated
                    </div>
                    <button
                      type="button"
                      className={styles.refreshBtn}
                      onClick={() => setMilestoneManagerOpen((v) => !v)}
                      disabled={milestoneBusy != null}
                    >
                      {milestoneManagerOpen ? "Hide" : "Show"}
                    </button>
                  </div>
                </div>

                {!canManageSelectedProject ? (
                  <div style={{ marginTop: 10, fontSize: 12, color: "rgba(255,255,255,0.55)" }}>
                    Milestone actions require the creator wallet: <span style={{ fontFamily: "monospace" }}>{shortWallet(selectedProjectCreatorPk || "")}</span>
                  </div>
                ) : null}

                {milestoneManagerOpen ? (
                  <div style={{ marginTop: 12 }}>
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                      <select
                        value={newMilestoneKind}
                        onChange={(e) => setNewMilestoneKind(e.target.value === "market_cap" ? "market_cap" : "manual")}
                        disabled={milestoneBusy != null}
                        style={{
                          width: 200,
                          padding: "10px 12px",
                          borderRadius: 10,
                          border: "1px solid rgba(255,255,255,0.15)",
                          background: "rgba(0,0,0,0.30)",
                          color: "#fff",
                          fontSize: 13,
                        }}
                      >
                        <option value="manual">Manual milestone</option>
                        <option value="market_cap">Market cap milestone</option>
                      </select>
                      <input
                        value={newMilestoneTitle}
                        onChange={(e) => setNewMilestoneTitle(e.target.value)}
                        placeholder="Milestone title"
                        disabled={milestoneBusy != null}
                        style={{
                          flex: 1,
                          minWidth: 220,
                          padding: "10px 12px",
                          borderRadius: 10,
                          border: "1px solid rgba(255,255,255,0.15)",
                          background: "rgba(0,0,0,0.30)",
                          color: "#fff",
                          fontSize: 13,
                        }}
                      />
                      {newMilestoneKind === "market_cap" ? (
                        <input
                          value={newMilestoneThresholdUsd}
                          onChange={(e) => setNewMilestoneThresholdUsd(e.target.value)}
                          placeholder="Market cap threshold (e.g. 10m)"
                          disabled={milestoneBusy != null}
                          style={{
                            width: 220,
                            padding: "10px 12px",
                            borderRadius: 10,
                            border: "1px solid rgba(255,255,255,0.15)",
                            background: "rgba(0,0,0,0.30)",
                            color: "#fff",
                            fontSize: 13,
                          }}
                        />
                      ) : (
                        <input
                          type="datetime-local"
                          value={newMilestoneDueLocal}
                          onChange={(e) => setNewMilestoneDueLocal(e.target.value)}
                          disabled={milestoneBusy != null}
                          style={{
                            width: 220,
                            padding: "10px 12px",
                            borderRadius: 10,
                            border: "1px solid rgba(255,255,255,0.15)",
                            background: "rgba(0,0,0,0.30)",
                            color: "#fff",
                            fontSize: 13,
                          }}
                        />
                      )}
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <input
                          value={newMilestoneUnlockPercent}
                          onChange={(e) => setNewMilestoneUnlockPercent(e.target.value.replace(/[^0-9]/g, ""))}
                          inputMode="numeric"
                          maxLength={3}
                          disabled={milestoneBusy != null}
                          style={{
                            width: 70,
                            textAlign: "center",
                            padding: "10px 12px",
                            borderRadius: 10,
                            border: "1px solid rgba(255,255,255,0.15)",
                            background: "rgba(0,0,0,0.30)",
                            color: "#fff",
                            fontSize: 13,
                          }}
                        />
                        <span style={{ fontSize: 12, color: "rgba(255,255,255,0.55)" }}>%</span>
                      </div>
                      <button
                        type="button"
                        className={styles.claimBtn}
                        onClick={submitAddMilestone}
                        aria-disabled={milestoneBusy != null || !canManageSelectedProject}
                        disabled={milestoneBusy != null || !canManageSelectedProject}
                        style={{
                          padding: "10px 16px",
                          fontSize: 13,
                          borderRadius: 10,
                        }}
                      >
                        {milestoneBusy === "add" ? "Submitting…" : "Sign & Add"}
                      </button>
                    </div>
                    <div style={{ marginTop: 10, fontSize: 12, color: "rgba(255,255,255,0.50)" }}>
                      Adding milestones uses a wallet signature only. No funds move during setup.
                    </div>
                  </div>
                ) : null}
              </div>

              <div className={styles.milestonesList}>
                {selectedProject.milestones.map((m) => {
                  const statusClass =
                    m.status === "released"
                      ? styles.milestoneReleased
                      : m.status === "claimable"
                      ? styles.milestoneClaimable
                      : styles.milestoneLocked;

                  const isEditing = editingMilestoneId === m.id;
                  const canEdit = canManageSelectedProject && m.completedAtUnix == null && m.status === "locked";
                  const canComplete = canManageSelectedProject && m.completedAtUnix == null && m.status === "locked";
                  const reviewOpenedAtUnix = Number((m as any)?.reviewOpenedAtUnix ?? 0);
                  const reviewIsOpen = Number.isFinite(reviewOpenedAtUnix) && reviewOpenedAtUnix > 0;
                  const canOpenReviewNow = canManageSelectedProject && m.status === "locked" && m.completedAtUnix != null && !reviewIsOpen;
                  const canClaim = canManageSelectedProject && m.status === "claimable";
                  const dueLabel = m.dueAtUnix ? `Due ${formatDate(m.dueAtUnix)}` : "";
                  const unlockLamports = effectiveUnlockLamports(m, selectedProject.commitment.totalFundedLamports);
                  const reviewMode = milestoneReviewMode[m.id] ?? "deadline";
                  const approvalCount = Number((m as any).approvalCount ?? 0);
                  const approvalGoal = Number((m as any).approvalThreshold ?? 0);
                  const approvalPct = approvalGoal > 0 ? Math.max(0, Math.min(1, approvalCount / approvalGoal)) : 0;

                  return (
                    <div key={m.id} className={`${styles.milestoneItem} ${statusClass}`}>
                      <div className={styles.milestoneIndex}>{m.index}</div>
                      <div className={styles.milestoneInfo}>
                        <div className={styles.milestoneTitle}>{m.title || `Milestone ${m.index}`}</div>
                        <div className={styles.milestoneMeta}>
                          <span className={styles.milestoneStatus}>{m.status}</span>
                          {m.unlockPercent != null ? (
                            <>
                              <span className={styles.milestoneDot}>·</span>
                              <span>{m.unlockPercent}%</span>
                            </>
                          ) : null}
                          {(m as any).autoKind === "market_cap" ? (
                            <>
                              <span className={styles.milestoneDot}>·</span>
                              <span>Market cap ${fmtUsdShort(Number((m as any).marketCapThresholdUsd ?? 0))}</span>
                            </>
                          ) : null}
                          {dueLabel ? (
                            <>
                              <span className={styles.milestoneDot}>·</span>
                              <span>{dueLabel}</span>
                            </>
                          ) : null}
                          {m.status === "locked" && m.completedAtUnix && approvalGoal > 0 && (
                            <>
                              <span className={styles.milestoneDot}>·</span>
                              <div className={styles.milestoneApprovalProgress}>
                                <div className={styles.milestoneApprovalMeta}>
                                  {Math.floor(approvalCount)}/{Math.floor(approvalGoal)}
                                </div>
                                <div className={styles.milestoneApprovalBar} aria-hidden="true">
                                  <div className={styles.milestoneApprovalFill} style={{ width: `${Math.round(approvalPct * 100)}%` }} />
                                </div>
                              </div>
                            </>
                          )}
                          {m.releasedAtUnix && (
                            <>
                              <span className={styles.milestoneDot}>·</span>
                              <span>Released {formatDate(m.releasedAtUnix)}</span>
                            </>
                          )}
                        </div>

                        {isEditing ? (
                          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                              <input
                                value={editTitle}
                                onChange={(e) => setEditTitle(e.target.value)}
                                disabled={milestoneBusy != null}
                                style={{
                                  flex: 1,
                                  minWidth: 220,
                                  padding: "10px 12px",
                                  borderRadius: 10,
                                  border: "1px solid rgba(255,255,255,0.15)",
                                  background: "rgba(0,0,0,0.30)",
                                  color: "#fff",
                                  fontSize: 13,
                                }}
                              />
                              <input
                                type="datetime-local"
                                value={editDueLocal}
                                onChange={(e) => setEditDueLocal(e.target.value)}
                                disabled={milestoneBusy != null}
                                style={{
                                  width: 220,
                                  padding: "10px 12px",
                                  borderRadius: 10,
                                  border: "1px solid rgba(255,255,255,0.15)",
                                  background: "rgba(0,0,0,0.30)",
                                  color: "#fff",
                                  fontSize: 13,
                                }}
                              />
                              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                <input
                                  value={editUnlockPercent}
                                  onChange={(e) => setEditUnlockPercent(e.target.value.replace(/[^0-9]/g, ""))}
                                  inputMode="numeric"
                                  maxLength={3}
                                  disabled={milestoneBusy != null}
                                  style={{
                                    width: 70,
                                    textAlign: "center",
                                    padding: "10px 12px",
                                    borderRadius: 10,
                                    border: "1px solid rgba(255,255,255,0.15)",
                                    background: "rgba(0,0,0,0.30)",
                                    color: "#fff",
                                    fontSize: 13,
                                  }}
                                />
                                <span style={{ fontSize: 12, color: "rgba(255,255,255,0.55)" }}>%</span>
                              </div>
                            </div>
                            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                              <button
                                type="button"
                                className={styles.refreshBtn}
                                onClick={() => submitEditMilestone(m.id)}
                                disabled={milestoneBusy != null}
                              >
                                {milestoneBusy === `edit:${m.id}` ? "Saving…" : "Sign & Save"}
                              </button>
                              <button
                                type="button"
                                className={styles.refreshBtn}
                                onClick={cancelEditMilestone}
                                disabled={milestoneBusy != null}
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </div>
                      <div className={styles.milestoneAmount}>{fmtSol(unlockLamports)} SOL</div>

                      <div className={styles.milestoneActions}>
                        {canEdit && !isEditing ? (
                          <button
                            type="button"
                            className={styles.refreshBtn}
                            onClick={() => beginEditMilestone(m)}
                            disabled={milestoneBusy != null}
                          >
                            Edit
                          </button>
                        ) : null}

                        {canComplete || canOpenReviewNow ? (
                          <>
                            {canComplete ? (
                              <>
                                <select
                                  className={styles.milestoneActionSelect}
                                  value={reviewMode}
                                  onChange={(e) => {
                                    const v = String(e.target.value) === "now" ? "now" : "deadline";
                                    setMilestoneReviewMode((prev) => ({ ...prev, [m.id]: v }));
                                  }}
                                  disabled={milestoneBusy != null}
                                >
                                  <option value="deadline">Review at deadline</option>
                                  <option value="now">Open review now</option>
                                </select>
                                <button
                                  type="button"
                                  className={styles.claimBtn}
                                  onClick={() => submitCompleteMilestone(m.id, reviewMode === "now" ? { review: "early" } : undefined)}
                                  disabled={milestoneBusy != null}
                                  style={{
                                    padding: "10px 14px",
                                    fontSize: 13,
                                    borderRadius: 10,
                                  }}
                                >
                                  {milestoneBusy === `complete:${m.id}`
                                    ? "Submitting…"
                                    : reviewMode === "now"
                                      ? "Sign & Submit for Review"
                                      : "Sign & Complete"}
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                className={styles.claimBtn}
                                onClick={() => submitCompleteMilestone(m.id, { review: "early" })}
                                disabled={milestoneBusy != null}
                                style={{
                                  padding: "10px 14px",
                                  fontSize: 13,
                                  borderRadius: 10,
                                }}
                              >
                                {milestoneBusy === `complete:${m.id}` ? "Submitting…" : "Open review now"}
                              </button>
                            )}
                          </>
                        ) : null}
                        {canClaim ? (
                          <button
                            type="button"
                            className={styles.claimBtn}
                            onClick={() => submitClaimMilestone(m.id)}
                            disabled={milestoneBusy != null}
                            style={{
                              padding: "10px 14px",
                              fontSize: 13,
                              borderRadius: 10,
                            }}
                          >
                            {milestoneBusy === `claim:${m.id}` ? "Claiming…" : "Sign & Claim"}
                          </button>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Withdrawal History */}
            <div className={styles.withdrawalsSection}>
              <h3 className={styles.withdrawalsHeader}>Withdrawals</h3>
              <div className={styles.withdrawalsList}>
                {selectedProject.withdrawals.length === 0 ? (
                  <div className={styles.withdrawalsEmpty}>No withdrawals yet.</div>
                ) : (
                  selectedProject.withdrawals
                    .slice()
                    .sort((a, b) => Number(b.releasedAtUnix ?? 0) - Number(a.releasedAtUnix ?? 0))
                    .map((w) => (
                      <div key={w.txSig} className={styles.withdrawalItem}>
                        <div className={styles.withdrawalInfo}>
                          <div className={styles.withdrawalTitle}>{w.milestoneTitle}</div>
                          <div className={styles.withdrawalDate}>
                            {w.releasedAtUnix ? formatDateTime(w.releasedAtUnix) : "—"}
                          </div>
                        </div>
                        <div className={styles.withdrawalAmount}>{fmtSol(w.amountLamports)} SOL</div>
                        <a
                          href={w.solscanUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={styles.withdrawalLink}
                          title="View on Solscan"
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                            <polyline points="15 3 21 3 21 9" />
                            <line x1="10" y1="14" x2="21" y2="3" />
                          </svg>
                        </a>
                      </div>
                    ))
                )}
              </div>
            </div>

            <div className={styles.withdrawalsSection}>
              <h3 className={styles.withdrawalsHeader}>On-Chain Activity</h3>
              <div className={styles.withdrawalsList}>
                {(() => {
                  const events = ([] as Array<
                    | ({ kind: "milestone_release" } & WithdrawalData)
                    | FailureTransferData
                    | VoterPayoutData
                  >)
                    .concat(selectedProject.withdrawals.map((w) => ({ ...w, kind: "milestone_release" as const })))
                    .concat((selectedProject.failureTransfers ?? []) as any)
                    .concat((selectedProject.voterPayouts ?? []) as any)
                    .sort((a: any, b: any) => {
                      const ta = Number(a.releasedAtUnix ?? a.claimedAtUnix ?? a.createdAtUnix ?? 0);
                      const tb = Number(b.releasedAtUnix ?? b.claimedAtUnix ?? b.createdAtUnix ?? 0);
                      return tb - ta;
                    });

                  if (events.length === 0) {
                    return <div className={styles.withdrawalsEmpty}>No on-chain activity recorded yet.</div>;
                  }

                  return events.map((evt: any) => {
                    const title =
                      evt.kind === "milestone_release"
                        ? `Milestone release: ${String(evt.milestoneTitle ?? "") || evt.milestoneId}`
                        : evt.kind === "milestone_failure_buyback"
                          ? `Milestone failure buyback: ${String(evt.milestoneId)}`
                          : evt.kind === "milestone_failure_voter_pot_to_treasury"
                            ? `Milestone failure voter pot: ${String(evt.milestoneId)}`
                            : evt.kind === "milestone_failure_voter_claim"
                              ? `Voter claim: ${shortWallet(String(evt.walletPubkey ?? ""))}`
                              : "Transfer";

                    const unix = Number(evt.releasedAtUnix ?? evt.claimedAtUnix ?? evt.createdAtUnix ?? 0);
                    return (
                      <div key={`${evt.kind}:${evt.txSig}`} className={styles.withdrawalItem}>
                        <div className={styles.withdrawalInfo}>
                          <div className={styles.withdrawalTitle}>{title}</div>
                          <div className={styles.withdrawalDate}>{unix > 0 ? formatDateTime(unix) : "—"}</div>
                        </div>
                        <div className={styles.withdrawalAmount}>{fmtSol(Number(evt.amountLamports ?? 0))} SOL</div>
                        <a
                          href={String(evt.solscanUrl ?? "")}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={styles.withdrawalLink}
                          title="View on Solscan"
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                            <polyline points="15 3 21 3 21 9" />
                            <line x1="10" y1="14" x2="21" y2="3" />
                          </svg>
                        </a>
                      </div>
                    );
                  });
                })()}
              </div>
            </div>
          </div>
        ) : (
          <div className={styles.noSelection}>
            <p>Select a project to view details</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default CreatorDashboardPage;
