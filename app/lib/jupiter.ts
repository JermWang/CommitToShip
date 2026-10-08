export type JupiterQuoteResponse = {
  raw?: any;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold?: string;
  slippageBps?: number;
  priceImpactPct?: string;
  routePlan?: any[];
  contextSlot?: number;
};

export type JupiterSwapResponse = {
  swapTransaction: string;
  lastValidBlockHeight?: number;
};

// The legacy quote-api.jup.ag / price.jup.ag hosts have been retired. lite-api.jup.ag is the free, keyless tier
// (set JUPITER_API_BASE_URL=https://api.jup.ag and JUPITER_API_KEY for a dedicated key/rate limit).
function apiBase(): string {
  const raw = String(process.env.JUPITER_API_BASE_URL ?? "").trim().replace(/\/+$/, "");
  return raw || "https://lite-api.jup.ag";
}

function apiHeaders(extra?: Record<string, string>): Record<string, string> {
  const key = String(process.env.JUPITER_API_KEY ?? "").trim();
  return { ...(key ? { "x-api-key": key } : {}), ...(extra ?? {}) };
}

function timeoutMs(): number {
  const raw = Number(process.env.JUPITER_TIMEOUT_MS ?? "");
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return 8_000;
}

export async function jupiterQuote(input: {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps: number;
}): Promise<JupiterQuoteResponse> {
  const inputMint = String(input.inputMint ?? "").trim();
  const outputMint = String(input.outputMint ?? "").trim();
  const amount = String(input.amount ?? "").trim();
  const slippageBps = Math.floor(Number(input.slippageBps ?? 0));

  if (!inputMint) throw new Error("inputMint is required");
  if (!outputMint) throw new Error("outputMint is required");
  if (!amount) throw new Error("amount is required");
  if (!Number.isFinite(slippageBps) || slippageBps <= 0) throw new Error("Invalid slippageBps");

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs());

  try {
    const url = new URL(`${apiBase()}/swap/v1/quote`);
    url.searchParams.set("inputMint", inputMint);
    url.searchParams.set("outputMint", outputMint);
    url.searchParams.set("amount", amount);
    url.searchParams.set("slippageBps", String(slippageBps));

    const res = await fetch(url.toString(), { method: "GET", headers: apiHeaders(), cache: "no-store", signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const details = text.trim() ? `: ${text.slice(0, 240)}` : "";
      throw new Error(`Jupiter quote failed (${res.status})${details}`);
    }

    const json = (await res.json().catch(() => null)) as any;
    const data = json?.data && typeof json.data === "object" ? json.data : json;
    if (!data || typeof data !== "object") throw new Error("Jupiter returned empty quote");

    const q: JupiterQuoteResponse = {
      raw: data,
      inputMint: String(data.inputMint ?? inputMint),
      outputMint: String(data.outputMint ?? outputMint),
      inAmount: String(data.inAmount ?? ""),
      outAmount: String(data.outAmount ?? ""),
      otherAmountThreshold: data.otherAmountThreshold == null ? undefined : String(data.otherAmountThreshold),
      slippageBps: data.slippageBps == null ? undefined : Number(data.slippageBps),
      priceImpactPct: data.priceImpactPct == null ? undefined : String(data.priceImpactPct),
      routePlan: Array.isArray(data.routePlan) ? data.routePlan : undefined,
      contextSlot: data.contextSlot == null ? undefined : Number(data.contextSlot),
    };

    if (!q.inputMint || !q.outputMint || !q.inAmount || !q.outAmount) {
      throw new Error("Jupiter quote missing required fields");
    }

    return q;
  } finally {
    clearTimeout(t);
  }
}

/** Default priority fee for Jupiter swaps: "high" level, capped at 0.001 SOL (override with JUPITER_PRIORITY_MAX_LAMPORTS). */
function defaultPrioritizationFee(): { priorityLevelWithMaxLamports: { priorityLevel: "medium" | "high" | "veryHigh"; maxLamports: number } } {
  const raw = Number(process.env.JUPITER_PRIORITY_MAX_LAMPORTS ?? "");
  const maxLamports = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1_000_000;
  return { priorityLevelWithMaxLamports: { priorityLevel: "high", maxLamports } };
}

export async function jupiterSwapTx(input: {
  quoteResponse: JupiterQuoteResponse;
  userPublicKey: string;
  /** Optional override of Jupiter's prioritizationFeeLamports (default: high, max 1_000_000 lamports). */
  prioritizationFeeLamports?: unknown;
}): Promise<JupiterSwapResponse> {
  const userPublicKey = String(input.userPublicKey ?? "").trim();
  if (!userPublicKey) throw new Error("userPublicKey is required");

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs());

  try {
    const url = `${apiBase()}/swap/v1/swap`;
    const quoteResponse = (input.quoteResponse as any)?.raw ?? input.quoteResponse;
    const body: Record<string, unknown> = {
      quoteResponse,
      userPublicKey,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: input.prioritizationFeeLamports ?? defaultPrioritizationFee(),
    };

    const res = await fetch(url, {
      method: "POST",
      headers: apiHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(body),
      cache: "no-store",
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const details = text.trim() ? `: ${text.slice(0, 240)}` : "";
      throw new Error(`Jupiter swap failed (${res.status})${details}`);
    }

    const json = (await res.json().catch(() => null)) as any;
    const swapTransaction = String(json?.swapTransaction ?? "").trim();
    if (!swapTransaction) throw new Error("Jupiter returned empty swap transaction");

    const lastValidBlockHeight = json?.lastValidBlockHeight == null ? undefined : Number(json.lastValidBlockHeight);

    return { swapTransaction, lastValidBlockHeight };
  } finally {
    clearTimeout(t);
  }
}

/** USD price for a mint from Jupiter's price API (v3). Returns null when Jupiter has no price for the token. */
export async function jupiterUsdPrice(mint: string): Promise<number | null> {
  const id = String(mint ?? "").trim();
  if (!id) return null;

  try {
    const res = await fetch(`${apiBase()}/price/v3?ids=${encodeURIComponent(id)}`, {
      headers: apiHeaders(),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs()),
    });
    if (!res.ok) return null;
    const json = (await res.json().catch(() => null)) as any;
    const price = Number(json?.[id]?.usdPrice);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}
