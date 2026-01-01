import { notFound } from "next/navigation";
import { PublicKey } from "@solana/web3.js";

import styles from "./CommitDashboard.module.css";
import CommitDashboardClient from "./CommitDashboardClient";

import {
  RewardMilestone,
  getCommitment,
  getRewardApprovalThreshold,
  getRewardMilestoneApprovalCounts,
  normalizeRewardMilestonesClaimable,
  sumReleasedLamports,
  updateRewardTotalsAndMilestones,
} from "../../lib/escrowStore";
import { getBalanceLamports, getChainUnixTime, getConnection } from "../../lib/solana";
import { getSafeErrorMessage } from "../../lib/safeError";

export const runtime = "nodejs";

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function fmtSol(lamports: number): string {
  const sol = lamports / 1_000_000_000;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(sol);
}

function humanRelative(seconds: number): string {
  const abs = Math.abs(seconds);
  const day = 86400;
  const hour = 3600;
  const min = 60;

  if (abs >= day) {
    const d = Math.round(abs / day);
    return `${d} day${d === 1 ? "" : "s"}`;
  }
  if (abs >= hour) {
    const h = Math.round(abs / hour);
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  const m = Math.max(1, Math.round(abs / min));
  return `${m} min`;
}

function statusLabel(status: string): string {
  switch (status) {
    case "created":
      return "Active";
    case "active":
      return "Active";
    case "resolving":
      return "Resolving";
    case "resolved_success":
      return "Success";
    case "resolved_failure":
      return "Failure";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    default:
      return status;
  }
}

function computeUnlockedLamports(milestones: RewardMilestone[]): number {
  return milestones.reduce((acc, m) => {
    if (m.status === "claimable" || m.status === "released") return acc + Number(m.unlockLamports || 0);
    return acc;
  }, 0);
}

function clusterQuery(): string {
  const c = (process.env.NEXT_PUBLIC_SOLANA_CLUSTER || "mainnet-beta").trim();
  if (!c || c === "mainnet-beta") return "";
  return `?cluster=${encodeURIComponent(c)}`;
}

export default async function CommitDashboardPage({ params }: { params: { id: string } }) {
  const id = params.id;

  try {
    const record = await getCommitment(id);
    if (!record) notFound();

    const connection = getConnection();
    const escrowPk = new PublicKey(record.escrowPubkey);

    const [balanceLamports, nowUnix] = await Promise.all([
      getBalanceLamports(connection, escrowPk),
      getChainUnixTime(connection),
    ]);

    if (record.kind === "creator_reward") {
    const milestones: RewardMilestone[] = Array.isArray(record.milestones) ? (record.milestones.slice() as RewardMilestone[]) : [];
    const approvalCounts = await getRewardMilestoneApprovalCounts(id);
    const approvalThreshold = getRewardApprovalThreshold();
    const normalized = normalizeRewardMilestonesClaimable({ milestones, nowUnix, approvalCounts, approvalThreshold });
    const unlockedLamports = computeUnlockedLamports(normalized.milestones);

    const releasedLamports = sumReleasedLamports(normalized.milestones);
    const totalFundedLamports = Math.max(record.totalFundedLamports ?? 0, balanceLamports + releasedLamports);

    const allReleased = normalized.milestones.length > 0 && normalized.milestones.every((m) => m.status === "released");
    const nextStatus = allReleased ? "completed" : (record.status === "completed" ? "completed" : "active");

    const shouldPersist =
      normalized.changed ||
      unlockedLamports !== Number(record.unlockedLamports ?? 0) ||
      totalFundedLamports !== Number(record.totalFundedLamports ?? 0) ||
      nextStatus !== record.status;

    const updated = shouldPersist
      ? await updateRewardTotalsAndMilestones({
          id,
          milestones: normalized.milestones,
          unlockedLamports,
          totalFundedLamports,
          status: nextStatus,
        })
      : record;

    const statement = (updated as any).statement ? String((updated as any).statement) : "";
    const statementText = statement.trim().length > 0 ? statement.trim() : "Reward Commitment";

    const nextMilestone = (updated.milestones ?? []).find((m) => m.status !== "released") ?? null;
    const nextUnlockLamports = nextMilestone ? Number(nextMilestone.unlockLamports || 0) : 0;
    const nextCoverage = nextUnlockLamports > 0 ? clamp01(balanceLamports / nextUnlockLamports) : 1;

    const milestoneTotalUnlockLamports = (updated.milestones ?? []).reduce((acc, m) => acc + Number(m.unlockLamports || 0), 0);
    const compliance = milestoneTotalUnlockLamports > 0 ? clamp01(totalFundedLamports / milestoneTotalUnlockLamports) : 0;
    const feeMode = (updated as any).creatorFeeMode === "managed" ? "managed" : "assisted";

    const explorerUrl = `https://explorer.solana.com/address/${updated.escrowPubkey}${clusterQuery()}`;

    const guidance = (() => {
      if (updated.status === "completed") return "All milestones have been released. This page stays as the permanent receipt.";
      if (balanceLamports <= 0) return "Set your creator-reward destination to this escrow address (or transfer manually). Funds accumulate here over time.";
      return "When you complete a milestone, mark it complete. After the delay, it becomes claimable and can be released by admin.";
    })();

    return (
      <div className={styles.page}>
        <div className={styles.wrap}>
          <div className={styles.headerRow}>
            <div className={styles.brand}>
              <img className={styles.brandMark} src="/branding/white-logo.png" alt="Commit To Ship" />
              <div className={styles.brandTitle}>Commit Dashboard</div>
            </div>

            <div className={styles.topMeta}>
              <span>On-chain</span>
              <span className={styles.dot} />
              <span>Updated {new Date(nowUnix * 1000).toLocaleString()}</span>
            </div>
          </div>

          <section className={`${styles.surface} ${styles.hero}`}>
            <div className={styles.heroInner}>
              <div className={styles.heroTop}>
                <h1 className={`${styles.statement} ${statementText === "Reward Commitment" ? styles.statementFallback : ""}`}>{statementText}</h1>

                <div className={styles.heroMetaRight}>
                  <div className={styles.heroPills}>
                    <span className={styles.statusPill}>
                      <span className={styles.statusDot} />
                      <span>{statusLabel(updated.status)}</span>
                    </span>
                    <span className={`${styles.statusPill} ${styles.modePill} ${feeMode === "managed" ? styles.modePillManaged : ""}`}>
                      <span>{feeMode === "managed" ? "Auto-Escrow" : "Assisted"}</span>
                    </span>
                  </div>
                  <div className={styles.heroMetaLines}>
                    <div>Unlocked {fmtSol(unlockedLamports)} SOL</div>
                    {nextMilestone ? <div>Next unlock {fmtSol(nextUnlockLamports)} SOL</div> : <div>All milestones released</div>}
                  </div>
                  <div className={styles.complianceWrap}>
                    <div className={styles.complianceTrack} aria-hidden="true">
                      <div className={styles.complianceFill} style={{ width: `${Math.round(compliance * 100)}%` }} />
                    </div>
                    <div className={styles.complianceText}>
                      Escrowed {fmtSol(totalFundedLamports)} / {fmtSol(milestoneTotalUnlockLamports)} SOL ({Math.round(compliance * 100)}%)
                    </div>
                  </div>
                </div>
              </div>

              <div className={styles.heroBottom}>
                <div className={styles.amountRow}>
                  <div className={styles.amount}>{fmtSol(totalFundedLamports)}</div>
                  <div className={styles.amountUnit}>SOL funded</div>
                </div>

                <div className={styles.progressWrap}>
                  <div className={styles.progressTrack}>
                    <div className={styles.progressFill} style={{ width: `${Math.round(nextCoverage * 100)}%` }} />
                  </div>
                </div>

                <div className={styles.guidance}>{guidance}</div>
              </div>
            </div>
          </section>

          <section className={`${styles.surface} ${styles.lowerSurface}`}>
            <CommitDashboardClient
              id={updated.id}
              kind={updated.kind}
              amountLamports={Number((updated as any).amountLamports ?? 0)}
              escrowPubkey={updated.escrowPubkey}
              destinationOnFail={updated.destinationOnFail}
              authority={updated.authority}
              statement={statementText}
              status={updated.status}
              canMarkSuccess={false}
              canMarkFailure={updated.status !== "completed" && updated.status !== "failed"}
              explorerUrl={explorerUrl}
              creatorPubkey={updated.creatorPubkey ?? null}
              creatorFeeMode={(updated as any).creatorFeeMode ?? null}
              tokenMint={updated.tokenMint ?? null}
              milestones={updated.milestones ?? []}
              approvalCounts={approvalCounts}
              approvalThreshold={approvalThreshold}
              totalFundedLamports={totalFundedLamports}
              unlockedLamports={unlockedLamports}
              balanceLamports={balanceLamports}
              milestoneTotalUnlockLamports={milestoneTotalUnlockLamports}
              nowUnix={nowUnix}
            />
          </section>

          <div className={styles.smallNote}>
            This dashboard is a calm view of what’s true: the escrow address, the funded balance, and which milestones are unlockable.
          </div>
        </div>
      </div>
    );
    }

      const funded = balanceLamports >= record.amountLamports;
      const expired = nowUnix > record.deadlineUnix;

      const dueInSeconds = record.deadlineUnix - nowUnix;
      const timingLine = expired ? `Past due by ${humanRelative(dueInSeconds)}` : `Due in ${humanRelative(dueInSeconds)}`;

      const statement = (record as any).statement ? String((record as any).statement) : "";
      const statementText = statement.trim().length > 0 ? statement.trim() : "Commitment";

      const canMarkSuccess = record.status === "created" && !expired;
      const canMarkFailure = record.status === "created" && expired;

      const explorerUrl = `https://explorer.solana.com/address/${record.escrowPubkey}${clusterQuery()}`;

      const totalWindowSeconds = Math.max(1, record.deadlineUnix - record.createdAtUnix);
      const elapsedSeconds = nowUnix - record.createdAtUnix;
      const progress = clamp01(elapsedSeconds / totalWindowSeconds);

      const guidance = (() => {
        if (record.status === "resolved_success" || record.status === "resolved_failure") {
          return "Resolution is recorded. This page stays here as a permanent receipt.";
        }

        if (!funded) {
          return "Fund the escrow by sending SOL to the escrow address. Once funded, your commitment becomes enforceable.";
        }

        if (!expired) {
          return "Escrow is funded. You can reclaim before the deadline, or let it stand until time runs out.";
        }

        return "The deadline has passed. If this must be resolved, mark the outcome.";
      })();

      return (
        <div className={styles.page}>
          <div className={styles.wrap}>
            <div className={styles.headerRow}>
              <div className={styles.brand}>
                <img className={styles.brandMark} src="/branding/white-logo.png" alt="Commit To Ship" />
                <div className={styles.brandTitle}>Commit Dashboard</div>
              </div>

              <div className={styles.topMeta}>
                <span>On-chain</span>
                <span className={styles.dot} />
                <span>Updated {new Date(nowUnix * 1000).toLocaleString()}</span>
              </div>
            </div>

            <section className={`${styles.surface} ${styles.hero}`}>
              <div className={styles.heroInner}>
                <div className={styles.heroTop}>
                  <h1 className={`${styles.statement} ${statementText === "Commitment" ? styles.statementFallback : ""}`}>{statementText}</h1>

                  <div className={styles.heroMetaRight}>
                    <span className={styles.statusPill}>
                      <span className={styles.statusDot} />
                      <span>{statusLabel(record.status)}</span>
                    </span>
                    <div className={styles.heroMetaLines}>
                      <div>{funded ? "Escrow funded" : "Not funded yet"}</div>
                      <div>{timingLine}</div>
                      <div>{new Date(record.deadlineUnix * 1000).toLocaleString()}</div>
                    </div>
                  </div>
                </div>

                <div className={styles.heroBottom}>
                  <div className={styles.amountRow}>
                    <div className={styles.amount}>{fmtSol(record.amountLamports)}</div>
                    <div className={styles.amountUnit}>SOL locked</div>
                  </div>

                  <div className={styles.progressWrap}>
                    <div className={styles.progressTrack}>
                      <div className={styles.progressFill} style={{ width: `${Math.round(progress * 100)}%` }} />
                    </div>
                  </div>

                  <div className={styles.guidance}>{guidance}</div>
                </div>
              </div>
            </section>

            <section className={`${styles.surface} ${styles.lowerSurface}`}>
              <CommitDashboardClient
                id={record.id}
                kind={record.kind}
                amountLamports={record.amountLamports}
                escrowPubkey={record.escrowPubkey}
                destinationOnFail={record.destinationOnFail}
                authority={record.authority}
                statement={statementText}
                status={record.status}
                canMarkSuccess={canMarkSuccess}
                canMarkFailure={canMarkFailure}
                explorerUrl={explorerUrl}
                creatorPubkey={record.creatorPubkey ?? null}
                milestones={record.milestones ?? []}
                totalFundedLamports={record.totalFundedLamports ?? 0}
                unlockedLamports={record.unlockedLamports ?? 0}
                balanceLamports={balanceLamports}
                nowUnix={nowUnix}
              />
            </section>
            <div className={styles.smallNote}>
              This dashboard is a calm view of what’s true: the escrow address, the deadline, and the current state on-chain.
            </div>
          </div>
        </div>
    );
  } catch (e) {
    const msg = getSafeErrorMessage(e);
    return (
      <div className={styles.page}>
        <div className={styles.wrap}>
          <section className={`${styles.surface} ${styles.lowerSurface}`}>
            <div className={styles.smallNote} style={{ color: "rgba(180, 40, 60, 0.86)" }}>
              {msg}
            </div>
          </section>
        </div>
      </div>
    );
  }
}
