export function redactSensitive(input: string): string {
  let out = String(input ?? "");

  out = out.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, (m) => {
    try {
      const at = m.indexOf("@");
      if (at > 0) return `postgres://[redacted]${m.slice(at)}`;
    } catch {
      // ignore
    }
    return "postgres://[redacted]";
  });

  out = out.replace(/\/\/([^\/\s@]+):([^\/\s@]+)@/g, "//$1:[redacted]@");


  return out;
}

export function getSafeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();

  if (lower.includes("database_url is required")) return "DATABASE_URL is required";

  if (lower.includes("privy_app_id") && lower.includes("privy_app_secret") && lower.includes("required")) {
    return "PRIVY_APP_ID and PRIVY_APP_SECRET are required";
  }

  if (lower.includes("escrow_fee_payer_secret_key") && lower.includes("required")) {
    return "ESCROW_FEE_PAYER_SECRET_KEY is required";
  }

  if (lower.includes("solana_rpc_url") && lower.includes("required")) {
    return "SOLANA_RPC_URL is required";
  }

  if (lower.startsWith("privy request failed")) {
    return raw;
  }

  if (lower.startsWith("pumpportal request failed")) {
    return raw;
  }

  if (lower.includes("transaction confirmation timeout")) {
    return "Transaction confirmation timeout";
  }

  if (lower.includes("cts_vote_reward_faucet_owner_secret_key") && lower.includes("required")) {
    return "Vote reward claim service not configured";
  }

  if (lower.includes("cts_vote_reward_faucet_privy_wallet_id") && lower.includes("required")) {
    return "Vote reward claim service not configured";
  }

  if (lower.includes("faucet owner secret key") && lower.includes("does not match")) {
    return "Vote reward claim service configuration error";
  }

  if (lower.includes("transaction signature mismatch")) {
    return "Transaction signature mismatch";
  }

  if (lower.includes("missing signature") || lower.includes("signature verification failed")) {
    return "Transaction is missing required signatures";
  }

  if (lower.includes("insufficient funds") || lower.includes("insufficient lamports")) {
    return "Insufficient SOL for transaction fees";
  }

  if (lower.includes("blockhash not found") || lower.includes("blockhash") && lower.includes("expired")) {
    return "RPC error (blockhash expired)";
  }

  if (lower.includes("transaction simulation failed")) {
    return "Transaction simulation failed";
  }

  if (lower.includes("cts_mock_mode")) return "Service configuration error";

  if (lower.includes("invalid database_url")) return "Invalid DATABASE_URL";

  if (
    lower.includes("getaddrinfo") ||
    lower.includes("enotfound") ||
    lower.includes("eai_again") ||
    lower.includes("econnrefused") ||
    lower.includes("etimedout") ||
    lower.includes("timeout") ||
    (lower.includes("enoent") && lower.includes(".s.pgsql"))
  ) {
    return "Database connection failed";
  }

  if (lower.includes("password authentication failed") || lower.includes("28p01")) {
    return "Database authentication failed";
  }

  // Avoid leaking internal Postgres errors (especially schema init races) to end users.
  if (lower.includes("pg_type_typname_nsp_index") || (lower.includes("duplicate key value") && lower.includes("unique constraint"))) {
    return "Service temporarily unavailable";
  }

  // In production, prefer a generic message for unknown errors.
  if (process.env.NODE_ENV === "production") {
    return "Service error";
  }

  return redactSensitive(raw);
}
