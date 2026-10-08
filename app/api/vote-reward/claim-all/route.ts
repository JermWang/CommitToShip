import { handleVoteRewardClaimAll } from "../../../lib/payoutClaimStore";

export const runtime = "nodejs";

/**
 * Claims every unclaimed vote reward of the wallet for one commitment in a single user-signed transaction.
 * prepare -> unsigned tx (user pays fees); finalize -> exact-match check (no extra / nonce instructions), claim rows
 * recorded with the signature BEFORE broadcast, faucet co-signs, same bytes rebroadcast until final.
 */
export async function POST(req: Request) {
  return handleVoteRewardClaimAll(req, { global: false });
}
