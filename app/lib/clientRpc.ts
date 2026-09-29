import { clusterApiUrl, type Connection } from "@solana/web3.js";

const PUBLIC_MAINNET = "https://api.mainnet-beta.solana.com";

/**
 * RPC endpoint for browser code. Defaults to the same-origin /api/rpc proxy (private key, no browser throttling).
 * Set NEXT_PUBLIC_SOLANA_RPC_URL to a dedicated, domain-restricted endpoint to bypass the proxy.
 * Note: `origin` is only available in the browser; on the server this falls back to the public cluster URL,
 * which is never actually used to send requests during SSR.
 */
export function getClientRpcEndpoint(): string {
  const explicit = String(process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "").trim();
  const cluster = String(process.env.NEXT_PUBLIC_SOLANA_CLUSTER ?? "mainnet-beta").trim();

  if (explicit && explicit !== PUBLIC_MAINNET) return explicit;

  if (cluster === "mainnet-beta" && typeof window !== "undefined") return `${window.location.origin}/api/rpc`;

  if (cluster === "devnet" || cluster === "testnet" || cluster === "mainnet-beta") return clusterApiUrl(cluster);
  return PUBLIC_MAINNET;
}

/** Confirms a signature by polling (no websocket needed, so it works through the HTTP proxy). */
export async function confirmSignaturePolling(input: {
  connection: Connection;
  signature: string;
  lastValidBlockHeight?: number;
  timeoutMs?: number;
}): Promise<void> {
  const deadline = Date.now() + (input.timeoutMs ?? 90_000);
  while (Date.now() < deadline) {
    const st = await input.connection.getSignatureStatuses([input.signature], { searchTransactionHistory: true });
    const s = st?.value?.[0];
    if (s?.err) throw new Error(`Transaction failed: ${JSON.stringify(s.err)}`);
    if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") return;

    if (input.lastValidBlockHeight) {
      const height = await input.connection.getBlockHeight("confirmed");
      if (height > input.lastValidBlockHeight) throw new Error("Transaction expired before it was confirmed");
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("Timed out waiting for confirmation");
}
