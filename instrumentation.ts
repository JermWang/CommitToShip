/**
 * Runs once when the Next.js server starts.
 * Boots the background scheduler + schema warm-up (see app/lib/boot.ts). Node runtime only.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startBackgroundServices } = await import("./app/lib/boot");
    startBackgroundServices();
  }
}
