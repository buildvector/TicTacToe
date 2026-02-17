import { NextResponse } from "next/server";
import { kv } from "@/lib/kv";
import { PublicKey } from "@solana/web3.js";
import { payoutFromTreasury, netAfterFee } from "@/lib/sol";
import { requireSession } from "@/lib/session";
import { nowMs } from "@/lib/clock";

export const runtime = "nodejs";

async function acquireLock(key: string, seconds = 15) {
  // atomic NX lock (Upstash)
  const r = await kv.set(key, "1", { nx: true, ex: seconds });
  return !!r;
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const gameId = String(body?.gameId ?? "");
    const sessionToken = String(body?.sessionToken ?? "");

    if (!gameId || !sessionToken) {
      return NextResponse.json({ error: "Bad input" }, { status: 400 });
    }

    const s = await requireSession(sessionToken, gameId);
    if (!s.ok) return NextResponse.json({ error: s.error }, { status: 401 });

    const playerPubkey = s.session.pubkey;

    const g = await kv.get<any>(`game:${gameId}`);
    if (!g) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // ✅ Only creator can cancel BEFORE anyone joins
    const isCreator = String(g.createdBy) === playerPubkey;
    const isLobby = g.status === "LOBBY";
    const noJoiner = !g.joinedBy;

    if (!(isCreator && isLobby && noJoiner)) {
      return NextResponse.json({ error: "Leave not allowed here" }, { status: 400 });
    }

    // If already refunded, just return
    if (g.refundSig) {
      return NextResponse.json({ ok: true, refundSig: g.refundSig, game: g });
    }

    // ✅ Prevent double-refunds (race conditions)
    const locked = await acquireLock(`refundlock:${gameId}`, 20);
    if (!locked) {
      const fresh = await kv.get<any>(`game:${gameId}`);
      return NextResponse.json({ ok: true, game: fresh ?? g, note: "lock-busy" });
    }

    // Re-read after lock
    const fresh = (await kv.get<any>(`game:${gameId}`)) ?? g;

    // If state changed while we waited for lock, stop.
    const stillOk =
      String(fresh.createdBy) === playerPubkey &&
      fresh.status === "LOBBY" &&
      !fresh.joinedBy;

    if (!stillOk) {
      return NextResponse.json({ error: "Leave not allowed here" }, { status: 400 });
    }

    if (fresh.refundSig) {
      return NextResponse.json({ ok: true, refundSig: fresh.refundSig, game: fresh });
    }

    const ts = await nowMs();

    // Refund is 97% of creator deposit
    const refundLamports = netAfterFee(Number(fresh.betLamports));

    // Mark ended BEFORE payout (so repeated calls don't race)
    fresh.status = "FINISHED";
    fresh.endedReason = "CANCELLED";
    fresh.winner = null;
    fresh.winnerPubkey = null;
    fresh.updatedAt = ts;

    await kv.set(`game:${gameId}`, fresh);
    await kv.zrem("games:lobby", gameId);

    const sig = await payoutFromTreasury(new PublicKey(playerPubkey), refundLamports);

    fresh.refundSig = sig;
    fresh.updatedAt = await nowMs();
    await kv.set(`game:${gameId}`, fresh);

    return NextResponse.json({ ok: true, refundSig: sig, game: fresh });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Server error" }, { status: 500 });
  }
}
