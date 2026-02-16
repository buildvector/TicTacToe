// app/api/game/join/route.ts
import { NextResponse } from "next/server";
import { kv } from "@/lib/kv";
import { emptyBoard } from "@/lib/game";
import { netAfterFee } from "@/lib/sol";
import { createSession, bindSessionToGame } from "@/lib/session";
import { verifyTreasuryTransferOrThrow } from "@/lib/payment";
import { nowMs } from "@/lib/clock";

export const runtime = "nodejs";

const TREASURY = process.env.NEXT_PUBLIC_TREASURY_PUBKEY!;
const MOVE_MS = 20_000;

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

    const usedKey = `payused:${paymentSig}`;
    const used = await kv.get(usedKey);
    if (used) return NextResponse.json({ error: "Payment already used" }, { status: 400 });

    await verifyTreasuryTransferOrThrow({
      paymentSig,
      fromPubkey: joinerPubkey,
      toPubkey: TREASURY,
      lamports: betLamports,
    });

    await kv.set(usedKey, 1, { ex: 60 * 60 });

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

    const ts = await nowMs();

    g.board = emptyBoard();
    g.turn = "X";
    g.status = "PLAYING";
    g.deadlineAt = ts + MOVE_MS; // ✅ stable clock
    g.moves = 0;
    g.updatedAt = ts;

    await kv.set(`game:${gameId}`, g);
    await kv.zrem("games:lobby", gameId);

    const sessionToken = await createSession(joinerPubkey);
    await bindSessionToGame(sessionToken, gameId);

    return NextResponse.json({ ok: true, game: g, sessionToken });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Server error" }, { status: 500 });
  }
}
