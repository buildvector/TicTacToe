import { NextResponse } from "next/server";
import { kv } from "@/lib/kv";
import { now, emptyBoard } from "@/lib/game";
import { netAfterFee } from "@/lib/sol";
import { createSession, bindSessionToGame } from "@/lib/session";
import { verifyTreasuryTransferOrThrow } from "@/lib/payment";

export const runtime = "nodejs";

const TREASURY = process.env.NEXT_PUBLIC_TREASURY_PUBKEY!;

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const gameId = String(body?.gameId ?? "");
    const joinerPubkey = String(body?.joinerPubkey ?? "");
    const paymentSig = String(body?.paymentSig ?? "");

    if (!gameId || !joinerPubkey || !paymentSig) {
      return NextResponse.json({ error: "Bad input" }, { status: 400 });
    }

    const g = await kv.get<any>(`game:${gameId}`);
    if (!g) return NextResponse.json({ error: "Not found" }, { status: 404 });

    if (g.status !== "LOBBY") {
      return NextResponse.json({ error: "Not joinable" }, { status: 400 });
    }

    if (String(g.createdBy) === joinerPubkey) {
      return NextResponse.json({ error: "Same wallet" }, { status: 400 });
    }

    const betLamports = Number(g.betLamports);
    if (!Number.isFinite(betLamports) || betLamports <= 0) {
      return NextResponse.json({ error: "Corrupt game: bad betLamports" }, { status: 500 });
    }

    // Anti-replay: ensure paymentSig not used before
    const usedKey = `payused:${paymentSig}`;
    const used = await kv.get(usedKey);
    if (used) return NextResponse.json({ error: "Payment already used" }, { status: 400 });

    // Verify joiner paid EXACT betLamports to treasury
    await verifyTreasuryTransferOrThrow({
      paymentSig,
      fromPubkey: joinerPubkey,
      toPubkey: TREASURY,
      lamports: betLamports,
    });

    // Mark payment used (TTL 1 hour)
    await kv.set(usedKey, 1, { ex: 60 * 60 });

    // Join logic
    g.joinedBy = joinerPubkey;

    const creatorNet = Number(g.potLamports);
    const joinerNet = netAfterFee(betLamports);

    g.potLamports = (Number.isFinite(creatorNet) ? creatorNet : 0) + joinerNet;

    const flip = (String(g.seed).length + joinerPubkey.length + betLamports) % 2;
    if (flip === 0) {
      g.xPlayer = g.createdBy;
      g.oPlayer = g.joinedBy;
    } else {
      g.xPlayer = g.joinedBy;
      g.oPlayer = g.createdBy;
    }

    g.board = emptyBoard();
    g.turn = "X";
    g.status = "PLAYING";
    g.deadlineAt = now() + 20_000;
    g.moves = 0;
    g.updatedAt = now();

    await kv.set(`game:${gameId}`, g);
    await kv.zrem("games:lobby", gameId);

    const sessionToken = await createSession(joinerPubkey);
    await bindSessionToGame(sessionToken, gameId);

    return NextResponse.json({ ok: true, game: g, sessionToken });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "Server error" },
      { status: 500 }
    );
  }
}
