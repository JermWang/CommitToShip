import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";

import { isAdminRequestAsync } from "../../../lib/adminAuth";
import { verifyAdminOrigin } from "../../../lib/adminSession";
import { getChainUnixTime, getConnection } from "../../../lib/solana";
import { claimCreatorFees, getClaimableCreatorFeeLamports } from "../../../lib/pumpfun";
import { getSafeErrorMessage } from "../../../lib/safeError";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    verifyAdminOrigin(req);
    if (!(await isAdminRequestAsync(req))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json().catch(() => null)) as any;
    const creatorPubkeyRaw = typeof body?.creatorPubkey === "string" ? body.creatorPubkey.trim() : "";

    if (!creatorPubkeyRaw) {
      return NextResponse.json({ error: "creatorPubkey is required" }, { status: 400 });
    }

    const creator = new PublicKey(creatorPubkeyRaw);

    const connection = getConnection();
    const nowUnix = await getChainUnixTime(connection);

    const before = await getClaimableCreatorFeeLamports({ connection, creator });

    const { signature, claimableLamports, creatorVault } = await claimCreatorFees({ connection, creator });

    const after = await getClaimableCreatorFeeLamports({ connection, creator });

    return NextResponse.json({
      ok: true,
      nowUnix,
      signature,
      creator: creator.toBase58(),
      creatorVault: creatorVault.toBase58(),
      claimableLamports,
      before,
      after,
    });
  } catch (e) {
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}
