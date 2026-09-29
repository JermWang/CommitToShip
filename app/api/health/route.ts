import { NextResponse } from "next/server";

import { hasDatabase, getPool } from "../../lib/db";
import { getConnection } from "../../lib/solana";
import { getSafeErrorMessage } from "../../lib/safeError";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type HealthStatus = "ok" | "degraded" | "error";

type HealthCheck = {
  name: string;
  status: HealthStatus;
  latencyMs?: number;
  error?: string;
};

/**
 * GET /api/health
 * 
 * Health check endpoint for monitoring system status.
 * Returns status of:
 * - Database connectivity
 * - Solana RPC connectivity
 * - Overall system health
 */
export async function GET() {
  const checks: HealthCheck[] = [];
  const startTime = Date.now();

  // Check database connectivity
  const dbCheck = await checkDatabase();
  checks.push(dbCheck);

  // Check Solana RPC connectivity
  const solanaCheck = await checkSolanaRpc();
  checks.push(solanaCheck);

  // Determine overall status
  const hasError = checks.some((c) => c.status === "error");
  const hasDegraded = checks.some((c) => c.status === "degraded");
  const overallStatus: HealthStatus = hasError ? "error" : hasDegraded ? "degraded" : "ok";

  const response = {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    checks,
    totalLatencyMs: Date.now() - startTime,
  };

  const httpStatus = overallStatus === "ok" ? 200 : overallStatus === "degraded" ? 200 : 503;
  return NextResponse.json(response, { status: httpStatus });
}

async function checkDatabase(): Promise<HealthCheck> {
  const start = Date.now();
  
  if (!hasDatabase()) {
    return {
      name: "database",
      status: "degraded",
      latencyMs: Date.now() - start,
      error: "Database not configured (mock mode)",
    };
  }

  try {
    const pool = getPool();
    const result = await pool.query("SELECT 1 as ok");
    const ok = result.rows[0]?.ok === 1;
    
    return {
      name: "database",
      status: ok ? "ok" : "error",
      latencyMs: Date.now() - start,
      error: ok ? undefined : "Query returned unexpected result",
    };
  } catch (e) {
    return {
      name: "database",
      status: "error",
      latencyMs: Date.now() - start,
      error: getSafeErrorMessage(e),
    };
  }
}

async function checkSolanaRpc(): Promise<HealthCheck> {
  const start = Date.now();
  
  try {
    const connection = getConnection();
    const slot = await connection.getSlot("confirmed");
    
    if (!Number.isFinite(slot) || slot <= 0) {
      return {
        name: "solana_rpc",
        status: "error",
        latencyMs: Date.now() - start,
        error: "Invalid slot returned",
      };
    }

    const latencyMs = Date.now() - start;
    
    // Consider degraded if RPC is slow (>2s)
    const status: HealthStatus = latencyMs > 2000 ? "degraded" : "ok";
    
    return {
      name: "solana_rpc",
      status,
      latencyMs,
      error: status === "degraded" ? "High latency" : undefined,
    };
  } catch (e) {
    return {
      name: "solana_rpc",
      status: "error",
      latencyMs: Date.now() - start,
      error: getSafeErrorMessage(e),
    };
  }
}
