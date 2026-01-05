import { notFound } from "next/navigation";
import { PublicKey } from "@solana/web3.js";

import styles from "./CommitDashboard.module.css";
import CommitDashboardClient from "./CommitDashboardClient";

import {
  RewardMilestone,
  getCommitment,
  getRewardApprovalThreshold,
  getRewardMilestoneVoteCounts,
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

// Mock project data for demo purposes
const MOCK_PROJECTS: Record<string, any> = {
  "nekoai": {
    name: "NekoAI",
    symbol: "NEKO",
    imageUrl: "https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?w=200&h=200&fit=crop",
    description: "An autonomous AI agent that trades memecoins while you sleep. Built on Solana with on-chain transparency.",
    websiteUrl: "https://nekoai.fun",
    xUrl: "https://x.com/nekoai",
    telegramUrl: "https://t.me/nekoai",
    discordUrl: "https://discord.gg/nekoai",
    tokenMint: "NEKO9o9w4xD4mQdK9mZ2bYJrQyR2YVx7QxF1X9mZp1",
    statement: "Ship autonomous trading bot v2 + public PnL dashboard",
    escrowedLamports: 42_500_000_000,
    targetLamports: 60_000_000_000,
    milestones: [
      { id: "m1", title: "Trading Bot Alpha", description: "Launch alpha version of the autonomous trading bot with basic strategies", unlockLamports: 15_000_000_000, status: "released", unlockDelaySeconds: 86400 },
      { id: "m2", title: "PnL Dashboard", description: "Build public dashboard showing real-time profit and loss metrics", unlockLamports: 15_000_000_000, status: "claimable", unlockDelaySeconds: 86400 },
      { id: "m3", title: "Multi-Strategy Support", description: "Add support for multiple trading strategies and risk profiles", unlockLamports: 15_000_000_000, status: "pending", unlockDelaySeconds: 86400 },
      { id: "m4", title: "Mobile App", description: "Launch iOS and Android apps for monitoring trades on the go", unlockLamports: 15_000_000_000, status: "pending", unlockDelaySeconds: 86400 },
    ],
  },
  "gigachad": {
    name: "GigaChad",
    symbol: "GIGA",
    imageUrl: "https://images.unsplash.com/photo-1583121274602-3e2820c69888?w=200&h=200&fit=crop",
    description: "The ultimate chad token. Community-driven with milestone-locked dev funds. No rugs, only gains.",
    websiteUrl: "https://gigachad.io",
    xUrl: "https://x.com/gigachadtoken",
    telegramUrl: "https://t.me/gigachadtoken",
    discordUrl: "",
    tokenMint: "GIGA9o9w4xD4mQdK9mZ2bYJrQyR2YVx7QxF1X9mZp2",
    statement: "Launch staking platform + NFT collection for holders",
    escrowedLamports: 85_200_000_000,
    targetLamports: 85_200_000_000,
    milestones: [
      { id: "m1", title: "Staking Platform", description: "Deploy staking contracts with competitive APY for $GIGA holders", unlockLamports: 28_400_000_000, status: "released", unlockDelaySeconds: 86400 },
      { id: "m2", title: "NFT Collection", description: "Launch 10,000 unique GigaChad NFTs with holder benefits", unlockLamports: 28_400_000_000, status: "pending", unlockDelaySeconds: 86400 },
      { id: "m3", title: "DAO Governance", description: "Implement on-chain voting for community proposals", unlockLamports: 28_400_000_000, status: "pending", unlockDelaySeconds: 86400 },
    ],
  },
  "froggies": {
    name: "Froggies",
    symbol: "FROG",
    imageUrl: "https://images.unsplash.com/photo-1559253664-ca249d4608c6?w=200&h=200&fit=crop",
    description: "Ribbit your way to the moon. Frog-themed DeFi with locked liquidity and transparent milestones.",
    websiteUrl: "https://froggies.lol",
    xUrl: "https://x.com/froggiestoken",
    telegramUrl: "",
    discordUrl: "https://discord.gg/froggies",
    tokenMint: "FROG9o9w4xD4mQdK9mZ2bYJrQyR2YVx7QxF1X9mZp3",
    statement: "Ship DEX aggregator + frog NFT breeding game",
    escrowedLamports: 18_300_000_000,
    targetLamports: 35_000_000_000,
    milestones: [
      { id: "m1", title: "DEX Aggregator", description: "Build aggregator to find best swap rates across Solana DEXs", unlockLamports: 7_000_000_000, status: "released", unlockDelaySeconds: 86400 },
      { id: "m2", title: "Frog NFT Collection", description: "Launch genesis collection of 5,000 unique frog NFTs", unlockLamports: 7_000_000_000, status: "claimable", unlockDelaySeconds: 86400 },
      { id: "m3", title: "Breeding Game", description: "Implement NFT breeding mechanics with trait inheritance", unlockLamports: 7_000_000_000, status: "pending", unlockDelaySeconds: 86400 },
      { id: "m4", title: "Lily Pad Staking", description: "Stake frogs on lily pads to earn $FROG rewards", unlockLamports: 7_000_000_000, status: "pending", unlockDelaySeconds: 86400 },
      { id: "m5", title: "Frog Racing", description: "PvP racing game with wagering and tournaments", unlockLamports: 7_000_000_000, status: "pending", unlockDelaySeconds: 86400 },
    ],
  },
  "solwolf": {
    name: "SolWolf",
    symbol: "WOLF",
    imageUrl: "https://images.unsplash.com/photo-1564466809058-bf4114d55352?w=200&h=200&fit=crop",
    description: "Pack mentality meets DeFi. Wolf-themed token with community governance and escrowed dev funds.",
    websiteUrl: "https://solwolf.io",
    xUrl: "https://x.com/solwolftoken",
    telegramUrl: "https://t.me/solwolf",
    discordUrl: "https://discord.gg/solwolf",
    tokenMint: "WOLF9o9w4xD4mQdK9mZ2bYJrQyR2YVx7QxF1X9mZp4",
    statement: "Launch DAO voting + pack rewards system",
    escrowedLamports: 31_700_000_000,
    targetLamports: 50_000_000_000,
    milestones: [
      { id: "m1", title: "Pack Formation", description: "Create pack system where holders can form groups for bonus rewards", unlockLamports: 12_500_000_000, status: "released", unlockDelaySeconds: 86400 },
      { id: "m2", title: "DAO Voting", description: "Implement on-chain governance for pack decisions", unlockLamports: 12_500_000_000, status: "pending", unlockDelaySeconds: 86400 },
      { id: "m3", title: "Hunt Rewards", description: "Weekly hunt events with prize pools for active packs", unlockLamports: 12_500_000_000, status: "pending", unlockDelaySeconds: 86400 },
      { id: "m4", title: "Territory Wars", description: "Pack vs pack competition for territory control and rewards", unlockLamports: 12_500_000_000, status: "pending", unlockDelaySeconds: 86400 },
    ],
  },
  "pixelape": {
    name: "PixelApe",
    symbol: "PXAP",
    imageUrl: "https://images.unsplash.com/photo-1540573133985-87b6da6d54a9?w=200&h=200&fit=crop",
    description: "Retro pixel art meets ape culture. Play-to-earn arcade games with on-chain high scores.",
    websiteUrl: "https://pixelape.gg",
    xUrl: "https://x.com/pixelapegg",
    telegramUrl: "https://t.me/pixelape",
    discordUrl: "",
    tokenMint: "PXAP9o9w4xD4mQdK9mZ2bYJrQyR2YVx7QxF1X9mZp5",
    statement: "Ship arcade game suite + leaderboard rewards",
    escrowedLamports: 22_400_000_000,
    targetLamports: 22_400_000_000,
    milestones: [
      { id: "m1", title: "Arcade Alpha", description: "Launch first 3 retro arcade games with $PXAP integration", unlockLamports: 7_500_000_000, status: "released", unlockDelaySeconds: 86400 },
      { id: "m2", title: "Leaderboards", description: "On-chain high score tracking with weekly prize pools", unlockLamports: 7_500_000_000, status: "released", unlockDelaySeconds: 86400 },
      { id: "m3", title: "Tournament Mode", description: "Competitive brackets with entry fees and winner payouts", unlockLamports: 7_400_000_000, status: "claimable", unlockDelaySeconds: 86400 },
    ],
  },
  "moonrocket": {
    name: "MoonRocket",
    symbol: "ROCKET",
    imageUrl: "https://images.unsplash.com/photo-1516849841032-87cbac4d88f7?w=200&h=200&fit=crop",
    description: "To the moon and beyond! Space-themed memecoin with locked LP and milestone-based roadmap.",
    websiteUrl: "https://moonrocket.space",
    xUrl: "https://x.com/moonrocketcoin",
    telegramUrl: "https://t.me/moonrocket",
    discordUrl: "https://discord.gg/moonrocket",
    tokenMint: "MOON9o9w4xD4mQdK9mZ2bYJrQyR2YVx7QxF1X9mZp6",
    statement: "Launch launchpad platform + rocket NFT collection",
    escrowedLamports: 56_800_000_000,
    targetLamports: 80_000_000_000,
    milestones: [
      { id: "m1", title: "Launchpad Beta", description: "Token launchpad for vetted projects with fair launch mechanics", unlockLamports: 16_000_000_000, status: "released", unlockDelaySeconds: 86400 },
      { id: "m2", title: "Rocket NFTs", description: "10,000 unique rocket NFTs with utility in the ecosystem", unlockLamports: 16_000_000_000, status: "released", unlockDelaySeconds: 86400 },
      { id: "m3", title: "Mission Control", description: "Dashboard for tracking all launched projects and metrics", unlockLamports: 16_000_000_000, status: "claimable", unlockDelaySeconds: 86400 },
      { id: "m4", title: "Interstellar Staking", description: "Stake rockets to earn from launchpad fees", unlockLamports: 16_000_000_000, status: "pending", unlockDelaySeconds: 86400 },
      { id: "m5", title: "Galaxy Governance", description: "DAO voting on which projects get launched", unlockLamports: 16_000_000_000, status: "pending", unlockDelaySeconds: 86400 },
    ],
  },
};

export default async function CommitDashboardPage({ params }: { params: { id: string } }) {
  const id = params.id;

  // Handle mock project IDs
  if (id.startsWith("mock-")) {
    const mockKey = id.replace("mock-", "");
    const mockProject = MOCK_PROJECTS[mockKey];
    if (!mockProject) notFound();

    const nowUnix = Math.floor(Date.now() / 1000);
    const milestones = mockProject.milestones;
    const releasedLamports = milestones.filter((m: any) => m.status === "released").reduce((acc: number, m: any) => acc + m.unlockLamports, 0);
    const unlockedLamports = milestones.filter((m: any) => m.status === "claimable" || m.status === "released").reduce((acc: number, m: any) => acc + m.unlockLamports, 0);
    const totalTarget = milestones.reduce((acc: number, m: any) => acc + m.unlockLamports, 0);
    const compliance = totalTarget > 0 ? clamp01(mockProject.escrowedLamports / totalTarget) : 0;

    return (
      <div className={styles.page}>
        <div className={styles.wrap}>
          <div className={styles.headerRow}>
            <div className={styles.topMeta}>
              <span>Demo Project</span>
              <span className={styles.dot} />
              <span>Updated {new Date(nowUnix * 1000).toLocaleString()}</span>
            </div>
          </div>

          <section className={`${styles.surface} ${styles.hero}`}>
            <div className={styles.heroInner}>
              <div className={styles.heroTop}>
                <h1 className={styles.statement}>{mockProject.statement}</h1>

                <div className={styles.heroMetaRight}>
                  <div className={styles.heroPills}>
                    <span className={styles.statusPill}>
                      <span className={styles.statusDot} />
                      <span>Active</span>
                    </span>
                    <span className={`${styles.statusPill} ${styles.modePill} ${styles.modePillManaged}`}>
                      <span>Auto-Escrow</span>
                    </span>
                  </div>
                  <div className={styles.heroMetaLines}>
                    <div>Unlocked {fmtSol(unlockedLamports)} SOL</div>
                    <div>Released {fmtSol(releasedLamports)} SOL</div>
                  </div>
                </div>
              </div>

              <div className={styles.heroBottom}>
                <div className={styles.amountRow}>
                  <span className={styles.amount}>{fmtSol(mockProject.escrowedLamports)}</span>
                  <span className={styles.amountUnit}>SOL escrowed</span>
                </div>

                <div className={styles.progressWrap}>
                  <div className={styles.progressTrack}>
                    <div className={styles.progressFill} style={{ width: `${Math.round(compliance * 100)}%` }} />
                  </div>
                </div>

                <p className={styles.guidance}>
                  This is a demo project showcasing how CommitToShip works. Real projects have on-chain escrow and verifiable milestones.
                </p>
              </div>
            </div>
          </section>

          <section className={`${styles.surface} ${styles.lowerSurface}`}>
            <CommitDashboardClient
              id={`mock-${mockKey}`}
              kind="creator_reward"
              amountLamports={mockProject.escrowedLamports}
              escrowPubkey="DemoEscrowAddress1111111111111111111111111"
              destinationOnFail=""
              authority=""
              statement={mockProject.statement}
              status="active"
              canMarkSuccess={false}
              canMarkFailure={false}
              explorerUrl="#"
              tokenMint={mockProject.tokenMint}
              milestones={milestones}
              approvalCounts={{}}
              approvalThreshold={1}
              totalFundedLamports={mockProject.escrowedLamports}
              unlockedLamports={unlockedLamports}
              balanceLamports={mockProject.escrowedLamports - releasedLamports}
              milestoneTotalUnlockLamports={totalTarget}
              nowUnix={nowUnix}
              projectProfile={{
                name: mockProject.name,
                symbol: mockProject.symbol,
                imageUrl: mockProject.imageUrl,
                description: mockProject.description,
                websiteUrl: mockProject.websiteUrl,
                xUrl: mockProject.xUrl,
                telegramUrl: mockProject.telegramUrl,
                discordUrl: mockProject.discordUrl,
              }}
            />
          </section>

          <div className={styles.smallNote}>
            This is a demo project. Real commitments have on-chain escrow addresses and verifiable milestone releases.
          </div>
        </div>
      </div>
    );
  }

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
    const voteCounts = await getRewardMilestoneVoteCounts(id);
    const approvalCounts = voteCounts.approvalCounts;
    const approvalThreshold = getRewardApprovalThreshold();
    const normalized = normalizeRewardMilestonesClaimable({
      milestones,
      nowUnix,
      approvalCounts,
      rejectCounts: voteCounts.rejectCounts,
      approvalThreshold,
    });
    const unlockedLamports = computeUnlockedLamports(normalized.milestones);

    const releasedLamports = sumReleasedLamports(normalized.milestones);
    const totalFundedLamports = Math.max(0, balanceLamports + releasedLamports);

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
              canMarkFailure={false}
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
