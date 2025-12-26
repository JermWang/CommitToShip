import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";

import { isAdminRequestAsync } from "../../../lib/adminAuth";
import { verifyAdminOrigin } from "../../../lib/adminSession";
import { claimForResolution, finalizeResolution, getEscrowSecretKeyB58, listCommitments, releaseResolutionClaim } from "../../../lib/escrowStore";
import { getChainUnixTime, getConnection, keypairFromBase58Secret, transferAllLamports } from "../../../lib/solana";
import { getSafeErrorMessage } from "../../../lib/safeError";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    verifyAdminOrigin(req);
    if (!(await isAdminRequestAsync(req))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const connection = getConnection();
    const nowUnix = await getChainUnixTime(connection);

    const commitments = await listCommitments();

    const results: Array<{ id: string; status: string; signature?: string; error?: string }> = [];

    for (const c of commitments) {
      if (c.kind !== "personal") continue;
      if (c.status !== "created") continue;
      if (nowUnix <= c.deadlineUnix) continue;

      const claimed = await claimForResolution(c.id);
      if (!claimed) continue;

      if (nowUnix <= claimed.deadlineUnix) {
        await releaseResolutionClaim(claimed.id);
        continue;
      }

      try {
        const escrow = keypairFromBase58Secret(getEscrowSecretKeyB58(claimed));
        const to = new PublicKey(claimed.destinationOnFail);

        const { signature } = await transferAllLamports({ connection, from: escrow, to });

        await finalizeResolution({
          id: claimed.id,
          status: "resolved_failure",
          resolvedAtUnix: nowUnix,
          resolvedTxSig: signature,
        });

        results.push({ id: claimed.id, status: "resolved_failure", signature });
      } catch (e) {
        await releaseResolutionClaim(claimed.id);
        results.push({ id: claimed.id, status: "error", error: getSafeErrorMessage(e) });
      }
    }

    return NextResponse.json({ nowUnix, results });
  } catch (e) {
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}
