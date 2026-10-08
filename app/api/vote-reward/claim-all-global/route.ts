import { handleVoteRewardClaimAll } from "../../../lib/payoutClaimStore";

export const runtime = "nodejs";

/** Same as /api/vote-reward/claim-all across every commitment (single mint / faucet).
 */
export async function POST(req: Request) {
  return handleVoteRewardClaimAll(req, { global: true });
}
