// lib/clock.ts
import { kv } from "@/lib/kv";

/**
 * Stable server time across Vercel instances.
 * Uses Redis TIME if available (Upstash), fallback to Date.now().
 */
export async function nowMs(): Promise<number> {
  try {
    const anyKv = kv as any;

    if (typeof anyKv.time === "function") {
      const t = await anyKv.time(); // [seconds, microseconds]
      const sec = Number(t?.[0]);
      const micro = Number(t?.[1]);
      if (Number.isFinite(sec) && Number.isFinite(micro)) {
        return sec * 1000 + Math.floor(micro / 1000);
      }
    }

    if (typeof anyKv.sendCommand === "function") {
      const t = await anyKv.sendCommand(["TIME"]);
      const sec = Number(t?.[0]);
      const micro = Number(t?.[1]);
      if (Number.isFinite(sec) && Number.isFinite(micro)) {
        return sec * 1000 + Math.floor(micro / 1000);
      }
    }
  } catch {
    // ignore
  }

  return Date.now();
}
