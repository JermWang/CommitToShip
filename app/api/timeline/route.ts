import { NextResponse } from "next/server";

import { CommitmentKind, CommitmentRecord, RewardMilestone, listCommitments, publicView } from "../../lib/escrowStore";
import { getSafeErrorMessage } from "../../lib/safeError";

export const runtime = "nodejs";

type TimelineEventType =
  | "commitment_created"
  | "commitment_resolved_success"
  | "commitment_resolved_failure"
  | "reward_milestone_completed"
  | "reward_milestone_claimable"
  | "reward_milestone_released"
  | "reward_commitment_completed";

export type TimelineEvent = {
  id: string;
  type: TimelineEventType;
  kind: CommitmentKind;
  timestampUnix: number;

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

function maxOrNull(values: Array<number | undefined | null>): number | null {
  let best: number | null = null;
  for (const v of values) {
    if (v == null) continue;
    if (!Number.isFinite(v)) continue;
    if (best == null || v > best) best = v;
  }
  return best;
}

function pushRewardMilestoneEvents(input: { record: CommitmentRecord; events: TimelineEvent[] }) {
  const { record, events } = input;
  const milestones: RewardMilestone[] = Array.isArray(record.milestones) ? (record.milestones as RewardMilestone[]) : [];

  for (const m of milestones) {
    if (m.completedAtUnix != null) {
      events.push({
        id: `${record.id}:milestone:${m.id}:completed:${m.completedAtUnix}`,
        type: "reward_milestone_completed",
        kind: record.kind,
        timestampUnix: Number(m.completedAtUnix),
        commitmentId: record.id,
        statement: record.statement,
        status: record.status,
        escrowPubkey: record.escrowPubkey,
        authority: record.authority,
        destinationOnFail: record.destinationOnFail,
        creatorPubkey: record.creatorPubkey,
        milestoneId: m.id,
        milestoneTitle: m.title,
        unlockLamports: Number(m.unlockLamports || 0),
      });
    }

    const becameClaimableAtUnix =
      (m as any).becameClaimableAtUnix != null
        ? Number((m as any).becameClaimableAtUnix)
        : m.status !== "locked" && m.claimableAtUnix != null
          ? Number(m.claimableAtUnix)
          : null;

    if (becameClaimableAtUnix != null) {
      events.push({
        id: `${record.id}:milestone:${m.id}:claimable:${becameClaimableAtUnix}`,
        type: "reward_milestone_claimable",
        kind: record.kind,
        timestampUnix: becameClaimableAtUnix,
        commitmentId: record.id,
        statement: record.statement,
        status: record.status,
        escrowPubkey: record.escrowPubkey,
        authority: record.authority,
        destinationOnFail: record.destinationOnFail,
        creatorPubkey: record.creatorPubkey,
        milestoneId: m.id,
        milestoneTitle: m.title,
        unlockLamports: Number(m.unlockLamports || 0),
      });
    }

    if (m.releasedAtUnix != null) {
      events.push({
        id: `${record.id}:milestone:${m.id}:released:${m.releasedAtUnix}`,
        type: "reward_milestone_released",
        kind: record.kind,
        timestampUnix: Number(m.releasedAtUnix),
        commitmentId: record.id,
        statement: record.statement,
        status: record.status,
        escrowPubkey: record.escrowPubkey,
        authority: record.authority,
        destinationOnFail: record.destinationOnFail,
        creatorPubkey: record.creatorPubkey,
        milestoneId: m.id,
        milestoneTitle: m.title,
        unlockLamports: Number(m.unlockLamports || 0),
        txSig: m.releasedTxSig,
      });
    }
  }

  if (record.status === "completed") {
    const completedAt = maxOrNull([
      ...milestones.map((m) => m.releasedAtUnix),
      ...milestones.map((m) => ((m as any).becameClaimableAtUnix != null ? Number((m as any).becameClaimableAtUnix) : m.claimableAtUnix)),
      ...milestones.map((m) => m.completedAtUnix),
      record.createdAtUnix,
    ]);

    if (completedAt != null) {
      events.push({
        id: `${record.id}:reward_commitment_completed:${completedAt}`,
        type: "reward_commitment_completed",
        kind: record.kind,
        timestampUnix: completedAt,
        commitmentId: record.id,
        statement: record.statement,
        status: record.status,
        escrowPubkey: record.escrowPubkey,
        authority: record.authority,
        destinationOnFail: record.destinationOnFail,
        creatorPubkey: record.creatorPubkey,
      });
    }
  }
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") ?? "80") || 80));

    const rows = await listCommitments();

    const events: TimelineEvent[] = [];

    for (const record of rows) {
      const base = {
        kind: record.kind,
        commitmentId: record.id,
        statement: record.statement,
        status: record.status,
        escrowPubkey: record.escrowPubkey,
        authority: record.authority,
        destinationOnFail: record.destinationOnFail,
        creatorPubkey: record.creatorPubkey,
      };

      events.push({
        id: `${record.id}:created:${record.createdAtUnix}`,
        type: "commitment_created",
        timestampUnix: record.createdAtUnix,
        amountLamports: record.kind === "personal" ? Number(record.amountLamports || 0) : undefined,
        ...base,
      });

      if (record.status === "resolved_success" && record.resolvedAtUnix != null) {
        events.push({
          id: `${record.id}:resolved_success:${record.resolvedAtUnix}`,
          type: "commitment_resolved_success",
          timestampUnix: Number(record.resolvedAtUnix),
          amountLamports: Number(record.amountLamports || 0),
          txSig: record.resolvedTxSig,
          ...base,
        });
      }

      if (record.status === "resolved_failure" && record.resolvedAtUnix != null) {
        events.push({
          id: `${record.id}:resolved_failure:${record.resolvedAtUnix}`,
          type: "commitment_resolved_failure",
          timestampUnix: Number(record.resolvedAtUnix),
          amountLamports: Number(record.amountLamports || 0),
          txSig: record.resolvedTxSig,
          ...base,
        });
      }

      if (record.kind === "creator_reward") {
        pushRewardMilestoneEvents({ record, events });
      }
    }

    events.sort((a, b) => b.timestampUnix - a.timestampUnix);

    return NextResponse.json({
      events: events.slice(0, limit),
      commitments: rows.map(publicView),
    });
  } catch (e) {
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}
