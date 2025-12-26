import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";

import { isAdminRequestAsync } from "../../../../lib/adminAuth";
import { verifyAdminOrigin } from "../../../../lib/adminSession";
import { claimForResolution, finalizeResolution, getCommitment, getEscrowSecretKeyB58, publicView, releaseResolutionClaim } from "../../../../lib/escrowStore";
import { getChainUnixTime, getConnection, keypairFromBase58Secret, transferAllLamports } from "../../../../lib/solana";
import { getSafeErrorMessage } from "../../../../lib/safeError";

export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: { id: string } }) {
  try {
    verifyAdminOrigin(req);
    if (!(await isAdminRequestAsync(req))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const id = ctx.params.id;

    const current = await getCommitment(id);
    if (!current) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (current.kind !== "personal") {
      return NextResponse.json({ error: "This endpoint is only for personal commitments" }, { status: 400 });
    }

    const claimed = await claimForResolution(id);
    if (!claimed) {
      return NextResponse.json({ error: "Already resolving/resolved", commitment: publicView(current) }, { status: 409 });
    }

    const connection = getConnection();
    const nowUnix = await getChainUnixTime(connection);

    if (nowUnix <= claimed.deadlineUnix) {
      await releaseResolutionClaim(id);
      return NextResponse.json({ error: "Too early (deadline not yet passed)" }, { status: 400 });
    }

    const escrow = keypairFromBase58Secret(getEscrowSecretKeyB58(claimed));
    const to = new PublicKey(claimed.destinationOnFail);

    try {
      const { signature, amountLamports } = await transferAllLamports({ connection, from: escrow, to });

      const updated = await finalizeResolution({
        id,
        status: "resolved_failure",
        resolvedAtUnix: nowUnix,
        resolvedTxSig: signature,
      });

      return NextResponse.json({
        ok: true,
        signature,
        amountLamports,
        commitment: publicView(updated),
      });
    } catch (e) {
      await releaseResolutionClaim(id);
      return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
    }
  } catch (e) {
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}
