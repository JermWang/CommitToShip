"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import styles from "./CreatorDashboard.module.css";

type MilestoneData = {
  id: string;
  title: string;
  unlockLamports: number;
  status: "locked" | "claimable" | "released";
  completedAtUnix?: number;
  claimableAtUnix?: number;
  releasedAtUnix?: number;
  releasedTxSig?: string;
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

type ProjectData = {
  commitment: {
    id: string;
    statement?: string;
    status: string;
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

function shortWallet(pk: string): string {
  const s = String(pk ?? "").trim();
  if (!s) return "";
  if (s.length <= 10) return s;
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
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

type TimeFilter = "all" | "30d" | "90d" | "1y";
type StatusFilter = "all" | "active" | "completed" | "failed";

export default function CreatorDashboardPage() {
  const router = useRouter();
  const { publicKey, connected } = useWallet();
  const { setVisible } = useWalletModal();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<CreatorData | null>(null);

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

  if (!connected) {
    return (
      <div className={styles.page}>
        <div className={styles.connectPrompt}>
          <div className={styles.connectIcon}>👤</div>
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
          <div className={styles.emptyIcon}>📦</div>
          <h2>No Projects Yet</h2>
          <p>You haven&apos;t created any projects with CommitToShip yet.</p>
          <button className={styles.createBtn} onClick={() => router.push("/?tab=create")}>
            Create Your First Project
          </button>
        </div>
      </div>
    );
  }

  const summary = data.summary;

  return (
    <div className={styles.page}>
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

            {/* Milestones */}
            <div className={styles.milestonesSection}>
              <div className={styles.milestonesSectionHeader}>
                <h3>Milestones</h3>
                <span className={styles.milestonesCount}>
                  {selectedProject.stats.milestonesReleased}/{selectedProject.stats.milestonesTotal} released
                </span>
              </div>
              <div className={styles.milestonesList}>
                {selectedProject.milestones.map((m) => {
                  const statusClass =
                    m.status === "released"
                      ? styles.milestoneReleased
                      : m.status === "claimable"
                      ? styles.milestoneClaimable
                      : styles.milestoneLocked;

                  return (
                    <div key={m.id} className={`${styles.milestoneItem} ${statusClass}`}>
                      <div className={styles.milestoneIndex}>{m.index}</div>
                      <div className={styles.milestoneInfo}>
                        <div className={styles.milestoneTitle}>{m.title || `Milestone ${m.index}`}</div>
                        <div className={styles.milestoneMeta}>
                          <span className={styles.milestoneStatus}>{m.status}</span>
                          {m.status === "locked" && m.completedAtUnix && (
                            <>
                              <span className={styles.milestoneDot}>·</span>
                              <span>Awaiting {m.approvalCount}/{m.approvalThreshold} votes</span>
                            </>
                          )}
                          {m.releasedAtUnix && (
                            <>
                              <span className={styles.milestoneDot}>·</span>
                              <span>Released {formatDate(m.releasedAtUnix)}</span>
                            </>
                          )}
                        </div>
                      </div>
                      <div className={styles.milestoneAmount}>{fmtSol(m.unlockLamports)} SOL</div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Withdrawal History */}
            {selectedProject.withdrawals.length > 0 && (
              <div className={styles.withdrawalsSection}>
                <h3 className={styles.withdrawalsHeader}>Withdrawal History</h3>
                <div className={styles.withdrawalsList}>
                  {selectedProject.withdrawals.map((w) => (
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
                  ))}
                </div>
              </div>
            )}
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
