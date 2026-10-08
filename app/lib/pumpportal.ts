import { PublicKey, VersionedTransaction } from "@solana/web3.js";

/**
 * DEPRECATED for server-side signing: escrow sweeps now build PumpSwap `collect_coin_creator_fee` locally
 * (see escrowSweep.ts). This remains only for callers that want PumpPortal's unsigned transaction; anything that is
 * going to be signed by a server-held key MUST pass it through `assertPumpPortalCollectTxIsSafe` first.
 */
export async function pumpportalBuildCollectCreatorFeeTxBase64(input: {
  publicKey: string;
  priorityFee?: number;
  timeoutMs?: number;
}): Promise<{ txBase64: string }> {
  const publicKey = String(input.publicKey ?? "").trim();
  if (!publicKey) throw new Error("publicKey is required");

  const body: any = {
    publicKey,
    action: "collectCreatorFee",
    priorityFee: typeof input.priorityFee === "number" ? input.priorityFee : 0.000001,
  };

  const res = await fetch("https://pumpportal.fun/api/trade-local", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(Math.max(1_000, Number(input.timeoutMs ?? 10_000))),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const details = text.trim() ? `: ${text.slice(0, 240)}` : "";
    throw new Error(`PumpPortal request failed (${res.status})${details}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error("PumpPortal returned empty transaction");

  return { txBase64: buf.toString("base64") };
}

const ALLOWED_PROGRAMS = new Map<string, Array<Buffer | null>>([
  // pump.fun: collect_creator_fee
  ["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", [Buffer.from([20, 22, 86, 123, 198, 28, 219, 132])]],
  // PumpSwap: collect_coin_creator_fee
  ["pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", [Buffer.from([160, 57, 89, 42, 181, 139, 43, 66])]],
  // Compute budget, ATA (create idempotent), SPL token (close account) - any data
  ["ComputeBudget111111111111111111111111111111", [null]],
  ["ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", [Buffer.from([1])]],
  ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", [Buffer.from([9])]],
]);

/**
 * Deserializes a PumpPortal transaction and refuses it unless every instruction is one of the expected creator-fee
 * collection instructions (no system transfers, no token transfers, no unknown programs, no lookup tables).
 */
export function assertPumpPortalCollectTxIsSafe(input: { txBase64: string; expectedFeePayer: PublicKey }): VersionedTransaction {
  const tx = VersionedTransaction.deserialize(Buffer.from(input.txBase64, "base64"));
  const msg = tx.message;
  if (msg.addressTableLookups?.length) throw new Error("PumpPortal transaction uses address lookup tables; refusing to sign");
  const keys = msg.staticAccountKeys;
  if (!keys[0]?.equals(input.expectedFeePayer)) throw new Error("PumpPortal transaction has an unexpected fee payer");
  for (const ix of msg.compiledInstructions) {
    const program = keys[ix.programIdIndex]?.toBase58() ?? "";
    const allowed = ALLOWED_PROGRAMS.get(program);
    if (!allowed) throw new Error(`PumpPortal transaction calls an unexpected program (${program}); refusing to sign`);
    const data = Buffer.from(ix.data);
    const ok = allowed.some((prefix) => prefix == null || (data.length >= prefix.length && data.subarray(0, prefix.length).equals(prefix)));
    if (!ok) throw new Error(`PumpPortal transaction has an unexpected instruction for ${program}; refusing to sign`);
  }
  return tx;
}
