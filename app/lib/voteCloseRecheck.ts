import { PublicKey } from "@solana/web3.js";

import { getServerCommitment, withRetry } from "./rpc";
import { getAssociatedTokenAddress, getConnection, getTokenBalanceForMint, getTokenProgramIdForMint } from "./solana";

/**
 * Close-time holder re-check for milestone votes (owner decision: 1 wallet = 1 vote with a $20 minimum, but a vote only
 * counts if the wallet STILL holds at least the minimum when the vote window closes).
 *
 * Balances are read in as few RPC calls as possible so the snapshot is (close to) a single slot: every voter's
 * associated token account is fetched with getMultipleAccounts (100 per call, all chunks in parallel). Only voters whose
 * ATA alone is below their minimum get a second look across all of their token accounts for the mint (non-ATA
 * holdings), also in parallel. Any RPC failure fails the whole batch - nothing is persisted from a partial read, so a
 * bag can never be counted twice by being moved between wallets between two partial passes.
 */

export type CloseBalanceFetchInput = {
  mint: string;
  owners: string[];
  /** Per-owner minimum (raw units). Owners whose ATA is already >= this skip the slower all-accounts lookup. */
  minAmountRawByOwner: Map<string, bigint>;
};

export type CloseBalanceFetchResult = {
  balances: Map<string, bigint>;
  slot: number | null;
};

export type CloseBalanceFetcher = (input: CloseBalanceFetchInput) => Promise<CloseBalanceFetchResult>;

let fetcherOverride: CloseBalanceFetcher | null = null;

/** Test hook: replace the on-chain balance reader (used by the scratchpad node tests with mocked balances). */
export function setCloseBalanceFetcherForTests(fn: CloseBalanceFetcher | null): void {
  fetcherOverride = fn;
}

export async function fetchCloseBalances(input: CloseBalanceFetchInput): Promise<CloseBalanceFetchResult> {
  if (fetcherOverride) return fetcherOverride(input);
  return defaultFetchCloseBalances(input);
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

async function defaultFetchCloseBalances(input: CloseBalanceFetchInput): Promise<CloseBalanceFetchResult> {
  const connection = getConnection();
  const commitment = getServerCommitment();
  const mintPk = new PublicKey(input.mint);
  const tokenProgram = await getTokenProgramIdForMint({ connection, mint: mintPk });

  const owners = Array.from(new Set(input.owners.map((o) => new PublicKey(o).toBase58())));
  const atas = owners.map((o) => getAssociatedTokenAddress({ owner: new PublicKey(o), mint: mintPk, tokenProgram }));

  const balances = new Map<string, bigint>();
  let slot: number | null = null;

  const chunks = chunk(
    owners.map((owner, i) => ({ owner, ata: atas[i] })),
    100
  );
  const results = await Promise.all(
    chunks.map((c) => withRetry(() => connection.getMultipleAccountsInfoAndContext(c.map((x) => x.ata), commitment)))
  );

  results.forEach((res, ci) => {
    const s = Number(res?.context?.slot);
    if (Number.isFinite(s) && (slot == null || s < slot)) slot = s;
    const c = chunks[ci];
    res.value.forEach((acc, i) => {
      const owner = c[i].owner;
      let amount = 0n;
      if (acc && acc.owner.equals(tokenProgram) && acc.data.length >= 72) {
        const data = Buffer.from(acc.data);
        const accMint = new PublicKey(data.subarray(0, 32));
        const accOwner = new PublicKey(data.subarray(32, 64));
        if (accMint.equals(mintPk) && accOwner.toBase58() === owner) amount = data.readBigUInt64LE(64);
      }
      balances.set(owner, amount);
    });
  });

  // Holders that keep tokens outside their ATA: one all-accounts lookup each, in parallel (bounded).
  const needsFull = owners.filter((o) => {
    const min = input.minAmountRawByOwner.get(o) ?? 1n;
    return (balances.get(o) ?? 0n) < (min > 0n ? min : 1n);
  });
  await mapLimit(needsFull, 8, async (owner) => {
    const full = await getTokenBalanceForMint({ connection, owner: new PublicKey(owner), mint: mintPk });
    if (full.amountRaw > (balances.get(owner) ?? 0n)) balances.set(owner, full.amountRaw);
  });

  return { balances, slot };
}
