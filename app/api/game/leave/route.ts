import { NextResponse } from "next/server";
import { kv } from "@/lib/kv";
import { PublicKey } from "@solana/web3.js";
import { payoutFromTreasury, netAfterFee } from "@/lib/sol";
import { now } from "@/lib/game";
import { requireSession } from "@/lib/session";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const { gameId, sessionToken } = await req.json();

    if (!gameId || !sessionToken) {
      return NextResponse.json({ error: "Bad input" }, { status: 400 });
    }

    const s = await requireSession(sessionToken, gameId);
    if (!s.ok) return NextResponse.json({ error: s.error }, { status: 401 });

    const playerPubkey = s.session.pubkey;

    const g = await kv.get<any>(`game:${gameId}`);
    if (!g) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // Only creator can cancel in lobby
    if (g.status === "LOBBY" && g.createdBy === playerPubkey) {
      if (g.refundSig) return NextResponse.json({ ok: true, refundSig: g.refundSig, game: g });

      const refund = netAfterFee(Number(g.betLamports)); // 97%
      g.status = "FINISHED";
      g.endedReason = "LEAVE";
      g.updatedAt = now();

      await kv.set(`game:${gameId}`, g);
      await kv.zrem("games:lobby", gameId);

      const sig = await payoutFromTreasury(new PublicKey(playerPubkey), refund);
      g.refundSig = sig;
      g.updatedAt = now();
      await kv.set(`game:${gameId}`, g);

      return NextResponse.json({ ok: true, refundSig: sig, game: g });
    }

    return NextResponse.json({ error: "Leave not allowed here" }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Server error" }, { status: 500 });
  }
}
