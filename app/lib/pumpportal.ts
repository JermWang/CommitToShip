export async function pumpportalBuildCollectCreatorFeeTxBase64(input: {
  publicKey: string;
  priorityFee?: number;
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
