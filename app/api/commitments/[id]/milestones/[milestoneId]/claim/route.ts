import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";

import { checkRateLimit } from "../../../../../../lib/rateLimit";
import { auditLog } from "../../../../../../lib/auditLog";
import {
  RewardMilestone,
  deleteRewardMilestonePayoutClaim,
  getMilestoneFailureReservedLamports,
  getCommitment,
  getEscrowSignerRef,
  getRewardApprovalThreshold,
  getRewardMilestoneVoteCounts,
  normalizeRewardMilestonesClaimable,
  publicView,
  setRewardMilestonePayoutClaimTxSig,
  sumReleasedLamports,
  tryAcquireRewardMilestonePayoutClaim,
  updateRewardTotalsAndMilestones,
} from "../../../../../../lib/escrowStore";
import {
  getBalanceLamports,
  getChainUnixTime,
  getConnection,
  closeNativeWsolTokenAccounts,
  findSystemTransferSignature,
  keypairFromBase58Secret,
  transferLamports,
  transferLamportsFromPrivyWallet,
} from "../../../../../../lib/solana";
import { getSafeErrorMessage } from "../../../../../../lib/safeError";

export const runtime = "nodejs";

function isRewardPayoutsEnabled(): boolean {
  const raw = String(process.env.CTS_ENABLE_REWARD_PAYOUTS ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function computeUnlockedLamports(milestones: RewardMilestone[]): number {
  return milestones.reduce((acc, m) => {
    if (m.status === "claimable" || m.status === "released") return acc + Number(m.unlockLamports || 0);
    return acc;
  }, 0);
}

function milestoneClaimMessage(input: { commitmentId: string; milestoneId: string }): string {
  return `Commit To Ship\nMilestone Claim\nCommitment: ${input.commitmentId}\nMilestone: ${input.milestoneId}`;
}

export async function POST(req: Request, ctx: { params: { id: string; milestoneId: string } }) {
  const rl = await checkRateLimit(req, { keyPrefix: "milestone:claim", limit: 30, windowSeconds: 60 });
  if (!rl.allowed) {
    const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
    res.headers.set("retry-after", String(rl.retryAfterSeconds));
    return res;
  }

  if (!isRewardPayoutsEnabled()) {
    return NextResponse.json(
      {
        error: "Reward payouts are disabled",
        hint: "Set CTS_ENABLE_REWARD_PAYOUTS=1 (or true) to enable milestone claims.",
      },
      { status: 503 }
    );
  }

  const id = ctx.params.id;
  const milestoneId = ctx.params.milestoneId;

  const body = (await req.json().catch(() => null)) as any;

  try {
    const record = await getCommitment(id);
    if (!record) return NextResponse.json({ error: "Not found" }, { status: 404 });

    if (record.kind !== "creator_reward") {
      return NextResponse.json({ error: "Not a reward commitment" }, { status: 400 });
    }

    if (record.status === "failed") {
      return NextResponse.json({ error: "Commitment is failed" }, { status: 409 });
    }

    if (!record.creatorPubkey) {
      return NextResponse.json({ error: "Missing creator pubkey" }, { status: 500 });
    }

    const signatureB58 = typeof body?.signature === "string" ? body.signature.trim() : "";
    if (!signatureB58) {
      const message = milestoneClaimMessage({ commitmentId: id, milestoneId });
      return NextResponse.json(
        {
          error: "signature required",
          message,
          creatorPubkey: record.creatorPubkey,
        },
        { status: 400 }
      );
    }

    const expectedMessage = milestoneClaimMessage({ commitmentId: id, milestoneId });
    const providedMessage = typeof body?.message === "string" ? body.message : expectedMessage;
    if (providedMessage !== expectedMessage) {
      return NextResponse.json({ error: "Invalid message" }, { status: 400 });
    }

    const signature = bs58.decode(signatureB58);
    const creatorPk = new PublicKey(record.creatorPubkey);

    const ok = nacl.sign.detached.verify(new TextEncoder().encode(expectedMessage), signature, creatorPk.toBytes());
    if (!ok) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });

    const connection = getConnection();
    const escrowPk = new PublicKey(record.escrowPubkey);

    const [balanceLamports0, nowUnix] = await Promise.all([getBalanceLamports(connection, escrowPk), getChainUnixTime(connection)]);
    const nowWallUnix = Math.floor(Date.now() / 1000);
    const nowEffectiveUnix = Math.max(nowUnix, nowWallUnix);
    let balanceLamports = balanceLamports0;

    const milestones: RewardMilestone[] = Array.isArray(record.milestones) ? (record.milestones.slice() as RewardMilestone[]) : [];
    const idx = milestones.findIndex((m: RewardMilestone) => m.id === milestoneId);
    if (idx < 0) return NextResponse.json({ error: "Milestone not found" }, { status: 404 });

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
    const effectiveMilestones = normalized.milestones;

    const m = effectiveMilestones[idx];

    if (m.status === "released") {
      return NextResponse.json({ error: "Already released", commitment: publicView(record) }, { status: 409 });
    }

    if (m.status !== "claimable") {
      return NextResponse.json(
        {
          error: "Milestone not claimable",
          nowUnix,
          milestone: m,
          commitment: publicView(record),
        },
        { status: 400 }
      );
    }

    const unlockLamports = Number(m.unlockLamports);
    if (!Number.isFinite(unlockLamports) || unlockLamports <= 0) {
      return NextResponse.json({ error: "Invalid milestone unlock amount" }, { status: 500 });
    }

    const escrowRef = getEscrowSignerRef(record);
    const to = creatorPk;

    const reservedLamports = await getMilestoneFailureReservedLamports(id);
    let availableLamports = Math.max(0, Math.floor(balanceLamports - reservedLamports));

    if (availableLamports < unlockLamports) {
      try {
        await closeNativeWsolTokenAccounts({
          connection,
          owner: escrowPk,
          destination: escrowPk,
          signer:
            escrowRef.kind === "privy"
              ? { kind: "privy", walletId: escrowRef.walletId }
              : { kind: "keypair", keypair: keypairFromBase58Secret(escrowRef.escrowSecretKeyB58) },
        });
        balanceLamports = await getBalanceLamports(connection, escrowPk);
        availableLamports = Math.max(0, Math.floor(balanceLamports - reservedLamports));
      } catch (e) {
        void e;
      }
    }

    if (availableLamports < unlockLamports) {
      return NextResponse.json(
        {
          error: "Escrow underfunded for this release",
          balanceLamports,
          reservedLamports,
          availableLamports,
          requiredLamports: unlockLamports,
          commitment: publicView(record),
        },
        { status: 400 }
      );
    }

    const claim = await tryAcquireRewardMilestonePayoutClaim({
      commitmentId: id,
      milestoneId,
      createdAtUnix: nowUnix,
      toPubkey: to.toBase58(),
      amountLamports: unlockLamports,
    });

    if (!claim.acquired) {
      const existing = claim.existing;
      if (existing.toPubkey !== to.toBase58() || Number(existing.amountLamports) !== unlockLamports) {
        return NextResponse.json(
          {
            error: "Existing claim has mismatched payout details",
            existing,
            expected: { toPubkey: to.toBase58(), amountLamports: unlockLamports },
          },
          { status: 409 }
        );
      }

      const recoveredTxSig =
        existing.txSig ??
        (await findSystemTransferSignature({
          connection,
          fromPubkey: escrowPk,
          toPubkey: to,
          lamports: unlockLamports,
          minBlockTimeUnix: Number(existing.createdAtUnix ?? 0) > 0 ? Number(existing.createdAtUnix) - 300 : undefined,
          maxTransactionsToInspect: 250,
        }));

      if (recoveredTxSig) {
        if (!existing.txSig) {
          await setRewardMilestonePayoutClaimTxSig({ commitmentId: id, milestoneId, txSig: recoveredTxSig });
        }

        const nextMilestones = effectiveMilestones.slice();
        if (nextMilestones[idx]?.status !== "released") {
          nextMilestones[idx] = {
            ...m,
            status: "released",
            releasedAtUnix: nowUnix,
            releasedTxSig: recoveredTxSig,
          };
        }

        const unlockedLamportsNext = computeUnlockedLamports(nextMilestones);
        const releasedLamports = sumReleasedLamports(nextMilestones);
        let balanceLamportsAfter = balanceLamports;
        try {
          balanceLamportsAfter = await getBalanceLamports(connection, escrowPk);
        } catch {
          balanceLamportsAfter = balanceLamports;
        }
        const totalFundedLamports = Math.max(0, balanceLamportsAfter + releasedLamports);
        const allReleased = nextMilestones.length > 0 && nextMilestones.every((x) => x.status === "released");

        const updated = await updateRewardTotalsAndMilestones({
          id,
          milestones: nextMilestones,
          unlockedLamports: unlockedLamportsNext,
          totalFundedLamports,
          status: allReleased ? "completed" : "active",
        });

        return NextResponse.json({
          ok: true,
          nowUnix,
          signature: recoveredTxSig,
          commitment: publicView(updated),
          idempotent: true,
          recovered: !existing.txSig,
        });
      }

      const ageSeconds = nowEffectiveUnix - Number(existing.createdAtUnix ?? 0);
      if (Number.isFinite(ageSeconds) && ageSeconds > 120) {
        await deleteRewardMilestonePayoutClaim({ commitmentId: id, milestoneId });

        const reacquired = await tryAcquireRewardMilestonePayoutClaim({
          commitmentId: id,
          milestoneId,
          createdAtUnix: nowEffectiveUnix,
          toPubkey: to.toBase58(),
          amountLamports: unlockLamports,
        });

        if (!reacquired.acquired) {
          return NextResponse.json(
            {
              error: "Claim already in progress",
              existing: reacquired.existing,
              hint: "A payout claim record exists but no tx signature is recorded yet. If this persists, an admin can reconcile/reset the claim.",
            },
            { status: 409 }
          );
        }

        try {
          const { signature: txSig } =
            escrowRef.kind === "privy"
              ? await transferLamportsFromPrivyWallet({
                  connection,
                  walletId: escrowRef.walletId,
                  fromPubkey: escrowPk,
                  to,
                  lamports: unlockLamports,
                })
              : await transferLamports({
                  connection,
                  from: keypairFromBase58Secret(escrowRef.escrowSecretKeyB58),
                  to,
                  lamports: unlockLamports,
                });

          await setRewardMilestonePayoutClaimTxSig({ commitmentId: id, milestoneId, txSig });

          const nextMilestones = effectiveMilestones.slice();
          nextMilestones[idx] = {
            ...m,
            status: "released",
            releasedAtUnix: nowUnix,
            releasedTxSig: txSig,
          };

          const unlockedLamportsNext = computeUnlockedLamports(nextMilestones);
          const releasedLamports = sumReleasedLamports(nextMilestones);
          let balanceLamportsAfter = balanceLamports;
          try {
            balanceLamportsAfter = await getBalanceLamports(connection, escrowPk);
          } catch {
            balanceLamportsAfter = balanceLamports;
          }
          const totalFundedLamports = Math.max(0, balanceLamportsAfter + releasedLamports);

          const allReleased = nextMilestones.length > 0 && nextMilestones.every((x) => x.status === "released");

          const updated = await updateRewardTotalsAndMilestones({
            id,
            milestones: nextMilestones,
            unlockedLamports: unlockedLamportsNext,
            totalFundedLamports,
            status: allReleased ? "completed" : "active",
          });

          return NextResponse.json({
            ok: true,
            nowUnix,
            signature: txSig,
            commitment: publicView(updated),
            retried: true,
          });
        } catch (e) {
          const safe = getSafeErrorMessage(e);
          if (safe === "RPC error (blockhash expired)") {
            const recoveredTxSig = await findSystemTransferSignature({
              connection,
              fromPubkey: escrowPk,
              toPubkey: to,
              lamports: unlockLamports,
              minBlockTimeUnix: Math.max(0, nowUnix - 900),
              maxTransactionsToInspect: 200,
            });

            if (recoveredTxSig) {
              await setRewardMilestonePayoutClaimTxSig({ commitmentId: id, milestoneId, txSig: recoveredTxSig });

              const nextMilestones = effectiveMilestones.slice();
              nextMilestones[idx] = {
                ...m,
                status: "released",
                releasedAtUnix: nowUnix,
                releasedTxSig: recoveredTxSig,
              };

              const unlockedLamportsNext = computeUnlockedLamports(nextMilestones);
              const releasedLamports = sumReleasedLamports(nextMilestones);
              let balanceLamportsAfter = balanceLamports;
              try {
                balanceLamportsAfter = await getBalanceLamports(connection, escrowPk);
              } catch {
                balanceLamportsAfter = balanceLamports;
              }
              const totalFundedLamports = Math.max(0, balanceLamportsAfter + releasedLamports);
              const allReleased = nextMilestones.length > 0 && nextMilestones.every((x) => x.status === "released");

              const updated = await updateRewardTotalsAndMilestones({
                id,
                milestones: nextMilestones,
                unlockedLamports: unlockedLamportsNext,
                totalFundedLamports,
                status: allReleased ? "completed" : "active",
              });

              return NextResponse.json({
                ok: true,
                nowUnix,
                signature: recoveredTxSig,
                commitment: publicView(updated),
                recovered: true,
              });
            }

            await deleteRewardMilestonePayoutClaim({ commitmentId: id, milestoneId });
            await auditLog("creator_reward_milestone_claim_error", {
              commitmentId: id,
              milestoneId,
              error: safe,
              clearedClaim: true,
            });
            return NextResponse.json(
              {
                error: safe,
                hint: "Temporary RPC issue while sending the payout transaction. Please retry the claim.",
              },
              { status: 503 }
            );
          }

          await auditLog("creator_reward_milestone_claim_error", { commitmentId: id, milestoneId, error: safe });
          return NextResponse.json({ error: safe }, { status: 500 });
        }
      }

      return NextResponse.json(
        {
          error: "Claim already in progress",
          existing,
          hint: "A payout claim record exists but no tx signature is recorded yet. If this persists, an admin can reconcile/reset the claim.",
        },
        { status: 409 }
      );
    }

    try {
      const { signature: txSig } =
        escrowRef.kind === "privy"
          ? await transferLamportsFromPrivyWallet({
              connection,
              walletId: escrowRef.walletId,
              fromPubkey: escrowPk,
              to,
              lamports: unlockLamports,
            })
          : await transferLamports({
              connection,
              from: keypairFromBase58Secret(escrowRef.escrowSecretKeyB58),
              to,
              lamports: unlockLamports,
            });

      await setRewardMilestonePayoutClaimTxSig({ commitmentId: id, milestoneId, txSig });

      const nextMilestones = effectiveMilestones.slice();
      nextMilestones[idx] = {
        ...m,
        status: "released",
        releasedAtUnix: nowUnix,
        releasedTxSig: txSig,
      };

      const unlockedLamportsNext = computeUnlockedLamports(nextMilestones);
      const releasedLamports = sumReleasedLamports(nextMilestones);
      let balanceLamportsAfter = balanceLamports;
      try {
        balanceLamportsAfter = await getBalanceLamports(connection, escrowPk);
      } catch {
        balanceLamportsAfter = balanceLamports;
      }
      const totalFundedLamports = Math.max(0, balanceLamportsAfter + releasedLamports);

      const allReleased = nextMilestones.length > 0 && nextMilestones.every((x) => x.status === "released");

      const updated = await updateRewardTotalsAndMilestones({
        id,
        milestones: nextMilestones,
        unlockedLamports: unlockedLamportsNext,
        totalFundedLamports,
        status: allReleased ? "completed" : "active",
      });

      await auditLog("creator_reward_milestone_claim_ok", { commitmentId: id, milestoneId, signature: txSig });

      return NextResponse.json({
        ok: true,
        nowUnix,
        signature: txSig,
        commitment: publicView(updated),
      });
    } catch (e) {
      const safe = getSafeErrorMessage(e);
      if (safe === "RPC error (blockhash expired)") {
        const recoveredTxSig = await findSystemTransferSignature({
          connection,
          fromPubkey: escrowPk,
          toPubkey: to,
          lamports: unlockLamports,
          minBlockTimeUnix: Math.max(0, nowUnix - 900),
          maxTransactionsToInspect: 200,
        });

        if (recoveredTxSig) {
          await setRewardMilestonePayoutClaimTxSig({ commitmentId: id, milestoneId, txSig: recoveredTxSig });

          const nextMilestones = effectiveMilestones.slice();
          nextMilestones[idx] = {
            ...m,
            status: "released",
            releasedAtUnix: nowUnix,
            releasedTxSig: recoveredTxSig,
          };

          const unlockedLamportsNext = computeUnlockedLamports(nextMilestones);
          const releasedLamports = sumReleasedLamports(nextMilestones);
          let balanceLamportsAfter = balanceLamports;
          try {
            balanceLamportsAfter = await getBalanceLamports(connection, escrowPk);
          } catch {
            balanceLamportsAfter = balanceLamports;
          }
          const totalFundedLamports = Math.max(0, balanceLamportsAfter + releasedLamports);
          const allReleased = nextMilestones.length > 0 && nextMilestones.every((x) => x.status === "released");

          const updated = await updateRewardTotalsAndMilestones({
            id,
            milestones: nextMilestones,
            unlockedLamports: unlockedLamportsNext,
            totalFundedLamports,
            status: allReleased ? "completed" : "active",
          });

          return NextResponse.json({
            ok: true,
            nowUnix,
            signature: recoveredTxSig,
            commitment: publicView(updated),
            recovered: true,
          });
        }

        await deleteRewardMilestonePayoutClaim({ commitmentId: id, milestoneId });
        await auditLog("creator_reward_milestone_claim_error", {
          commitmentId: id,
          milestoneId,
          error: safe,
          clearedClaim: true,
        });
        return NextResponse.json(
          {
            error: safe,
            hint: "Temporary RPC issue while sending the payout transaction. Please retry the claim.",
          },
          { status: 503 }
        );
      }

      await auditLog("creator_reward_milestone_claim_error", { commitmentId: id, milestoneId, error: safe });
      return NextResponse.json({ error: safe }, { status: 500 });
    }
  } catch (e) {
    await auditLog("creator_reward_milestone_claim_error", { commitmentId: id, milestoneId, error: getSafeErrorMessage(e) });
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}
