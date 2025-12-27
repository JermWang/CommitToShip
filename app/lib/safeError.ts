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

  out = out.replace(/([a-z0-9-]+\.)*supabase\.co/gi, "[redacted]");

  return out;
}

export function getSafeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();

  if (lower.includes("database_url is required")) return "DATABASE_URL is required";

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

  return redactSensitive(raw);
}
