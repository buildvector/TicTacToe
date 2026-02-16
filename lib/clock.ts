// lib/clock.ts
import { kv } from "@/lib/kv";

/**
 * Stable server time across Vercel instances.
 * Uses Redis TIME if available (Upstash), fallback to Date.now().
 */
export async function nowMs(): Promise<number> {
  // 1) Upstash Redis client often has `.time()`
  try {
    const anyKv = kv as any;

    if (typeof anyKv.time === "function") {
      const t = await anyKv.time(); // usually [seconds, microseconds] as strings
      const sec = Number(t?.[0]);
      const micro = Number(t?.[1]);
      if (Number.isFinite(sec) && Number.isFinite(micro)) {
        return sec * 1000 + Math.floor(micro / 1000);
      }
    }

    // 2) Some clients expose sendCommand(["TIME"])
    if (typeof anyKv.sendCommand === "function") {
      const t = await anyKv.sendCommand(["TIME"]);
      const sec = Number(t?.[0]);
      const micro = Number(t?.[1]);
      if (Number.isFinite(sec) && Number.isFinite(micro)) {
        return sec * 1000 + Math.floor(micro / 1000);
      }
    }
  } catch {
    // ignore -> fallback
  }

  return Date.now();
}
