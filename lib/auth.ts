import nacl from "tweetnacl";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { kv } from "@/lib/kv";

const MAX_SKEW_MS = 5 * 60 * 1000; // 5 min

export type SignedRequest<T> = {
  pubkey: string;
  message: string;    // exact string signed
  signature: string;  // base58
  payload: T;         // parsed payload you expect
};

export function buildMessage(action: string, payload: any, ts: number, nonce: string) {
  // IMPORTANT: message must be identical client+server
  return JSON.stringify({ action, ts, nonce, payload });
}

export async function verifySignedAction<T>(
  action: string,
  body: SignedRequest<T>
): Promise<{ ok: true; pubkey: PublicKey; payload: T } | { ok: false; error: string }> {
  try {
    if (!body?.pubkey || !body?.message || !body?.signature || body?.payload === undefined) {
      return { ok: false, error: "Missing signed fields" };
    }

    // 1) Pubkey validity
    let pk: PublicKey;
    try {
      pk = new PublicKey(body.pubkey);
    } catch {
      return { ok: false, error: "Invalid pubkey" };
    }

    // 2) Parse message and basic checks
    let parsed: any;
    try {
      parsed = JSON.parse(body.message);
    } catch {
      return { ok: false, error: "Message is not valid JSON" };
    }

    if (parsed?.action !== action) return { ok: false, error: "Wrong action" };

    const ts = Number(parsed?.ts);
    if (!Number.isFinite(ts)) return { ok: false, error: "Bad ts" };

    const nonce = String(parsed?.nonce ?? "");
    if (!nonce || nonce.length < 8) return { ok: false, error: "Bad nonce" };

    const now = Date.now();
    if (Math.abs(now - ts) > MAX_SKEW_MS) return { ok: false, error: "Signature expired" };

    // 3) Ensure message payload matches body.payload EXACTLY
    // (prevents someone signing one thing and sending another)
    const msgPayload = parsed?.payload;
    if (JSON.stringify(msgPayload) !== JSON.stringify(body.payload)) {
      return { ok: false, error: "Payload mismatch" };
    }

    // 4) Verify signature
    let sigBytes: Uint8Array;
    try {
      sigBytes = bs58.decode(body.signature);
    } catch {
      return { ok: false, error: "Bad signature encoding" };
    }

    const msgBytes = new TextEncoder().encode(body.message);
    const pubBytes = pk.toBytes();
    const ok = nacl.sign.detached.verify(msgBytes, sigBytes, pubBytes);
    if (!ok) return { ok: false, error: "Invalid signature" };

    // 5) Replay protection (nonce single-use per pubkey+action)
    const nonceKey = `nonce:${action}:${body.pubkey}:${nonce}`;
    const exists = await kv.get(nonceKey);
    if (exists) return { ok: false, error: "Replay detected" };

    // mark used (10 minutes)
    await kv.set(nonceKey, 1, { ex: 60 * 10 });

    return { ok: true, pubkey: pk, payload: body.payload };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "Verify failed" };
  }
}
