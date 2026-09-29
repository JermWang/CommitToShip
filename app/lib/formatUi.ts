const nf2 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function fmtNumber2(value: unknown): string {
  if (typeof value === "bigint") {
    return fmtNumber2(value.toString());
  }

  if (typeof value === "string") {
    const raw = value.trim();
    if (!raw) return "0.00";
    const normalized = raw.replace(/,/g, "");

    const m = normalized.match(/^(-)?(\d+)(?:\.(\d+))?$/);
    if (m) {
      const neg = Boolean(m[1]);
      const intPart = m[2] ?? "0";
      const fracPart = m[3] ?? "";

      const frac3 = (fracPart + "000").slice(0, 3);
      const first2 = frac3.slice(0, 2);
      const third = Number(frac3.slice(2, 3) || "0");

      let cents = BigInt(intPart) * 100n + BigInt(first2 || "0");
      if (third >= 5) cents += 1n;

      const whole = cents / 100n;
      const dec = cents % 100n;
      const wholeStr = whole
        .toString()
        .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      const out = `${wholeStr}.${dec.toString().padStart(2, "0")}`;
      return neg && cents !== 0n ? `-${out}` : out;
    }
  }

  const n = Number(value);
  if (!Number.isFinite(n)) return "0.00";
  return nf2.format(n);
}

export function fmtSolFromLamports2(lamports: unknown): string {
  const n = Number(lamports);
  if (!Number.isFinite(n)) return "0.00";
  const sol = n / 1_000_000_000;
  // Tiny balances (fresh escrows) would otherwise all read "0.00" - show a few more digits instead.
  if (sol > 0 && sol < 0.01) {
    if (sol < 0.0001) return "<0.0001";
    return new Intl.NumberFormat("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 4 }).format(sol);
  }
  return fmtNumber2(sol);
}
