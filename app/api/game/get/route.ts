import { NextResponse } from "next/server";
import { kv } from "@/lib/kv";
import { now, autoMoveIndex, emptyBoard } from "@/lib/game";
import { payoutFromTreasury } from "@/lib/sol";
import { PublicKey } from "@solana/web3.js";

export const runtime = "nodejs";

const MOVE_MS = 20_000;

const LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

function other(turn: "X" | "O") {
  return turn === "X" ? "O" : "X";
}

function winnerOf(board: any[]): "X" | "O" | null {
  for (const [a, b, c] of LINES) {
    const v = board[a];
    if (v && v === board[b] && v === board[c]) return v as "X" | "O";
  }
  return null;
}

function isFull(board: any[]) {
  return board.every((x) => x === "X" || x === "O");
}

function applyTurnMove(g: any, index: number) {
  if (!Array.isArray(g.board) || g.board.length !== 9) g.board = emptyBoard();
  if (index < 0 || index > 8) return { ok: false, error: "Bad index" };
  if (g.board[index]) return { ok: false, error: "Cell occupied" };

  const mark: "X" | "O" = g.turn === "O" ? "O" : "X";
  g.board[index] = mark;
  g.moves = Number(g.moves ?? 0) + 1;

  const w = winnerOf(g.board);
  if (w) {
    const winnerPk = w === "X" ? g.xPlayer : g.oPlayer;
    g.status = "FINISHED";
    g.winner = w;
    g.winnerPubkey = winnerPk;
    g.endedReason = "WIN";
    g.updatedAt = now();
    return { ok: true, finished: true, draw: false };
  }

  if (isFull(g.board)) {
    g.board = emptyBoard();
    g.moves = 0;
    g.draws = Number(g.draws ?? 0) + 1;
    g.status = "PLAYING";
    g.turn = other(mark);
    g.deadlineAt = now() + MOVE_MS;
    g.updatedAt = now();
    return { ok: true, finished: false, draw: true };
  }

  g.turn = other(mark);
  g.deadlineAt = now() + MOVE_MS;
  g.updatedAt = now();
  return { ok: true, finished: false, draw: false };
}

async function acquireLock(key: string, seconds = 10) {
  try {
    const r = await kv.set(key, "1", { nx: true, ex: seconds });
    return !!r;
  } catch {
    const existing = await kv.get(key);
    if (existing) return false;
    await kv.set(key, "1", { ex: seconds });
    return true;
  }
}

async function maybePayout(gameId: string, g: any) {
  if (g.status !== "FINISHED" || !g.winner) return { paid: false, sig: null as string | null };
  if (g.payoutSig && g.winnerPubkey) return { paid: true, sig: g.payoutSig as string };

  const locked = await acquireLock(`payoutlock:${gameId}`, 15);
  if (!locked) return { paid: false, sig: null };

  const fresh = (await kv.get<any>(`game:${gameId}`)) ?? g;
  if (fresh.payoutSig && fresh.winnerPubkey) return { paid: true, sig: fresh.payoutSig as string };

  const winnerPk = fresh.winnerPubkey || (fresh.winner === "X" ? fresh.xPlayer : fresh.oPlayer);
  fresh.winnerPubkey = winnerPk;
  fresh.endedReason = "WIN";
  fresh.updatedAt = now();
  await kv.set(`game:${gameId}`, fresh);

  const sig = await payoutFromTreasury(new PublicKey(winnerPk), Number(fresh.potLamports));
  fresh.payoutSig = sig;
  fresh.updatedAt = now();
  await kv.set(`game:${gameId}`, fresh);

  try {
    const item = {
      at: now(),
      gameId,
      betLamports: fresh.betLamports,
      winner: winnerPk,
      loser: winnerPk === fresh.createdBy ? fresh.joinedBy : fresh.createdBy,
      payoutSig: sig,
    };
    await kv.lpush("games:history", item);
    await kv.ltrim("games:history", 0, 9);
  } catch {}

  return { paid: true, sig };
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const gameId = searchParams.get("gameId");
  if (!gameId) return NextResponse.json({ error: "Missing gameId" }, { status: 400 });

  const g = await kv.get<any>(`game:${gameId}`);
  if (!g) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let payoutSig: string | null = g.payoutSig ?? null;

  const serverNow = now();

  // ✅ Strong self-heal of timer
  if (g.status === "PLAYING") {
    const d = Number(g.deadlineAt);
    const moves = Number(g.moves ?? 0);

    const remainingMs = Number.isFinite(d) ? d - serverNow : NaN;

    // Fix cases:
    // - missing/invalid
    // - expired or far in future
    // - suspiciously short RIGHT after game start (moves === 0) => your “3 seconds” bug
    const needsFix =
      !Number.isFinite(d) ||
      remainingMs <= 0 ||
      remainingMs > MOVE_MS + 2_000 ||
      (moves === 0 && remainingMs < MOVE_MS - 2_000);

    if (needsFix) {
      g.deadlineAt = serverNow + MOVE_MS;
      g.updatedAt = serverNow;
      await kv.set(`game:${gameId}`, g);
    }
  }

  // auto-move on server if deadline passed
  if (g.status === "PLAYING" && g.deadlineAt && now() > Number(g.deadlineAt)) {
    const idx = autoMoveIndex(g);
    if (idx >= 0) {
      applyTurnMove(g, idx);
    } else {
      g.board = emptyBoard();
      g.moves = 0;
      g.turn = other(g.turn === "O" ? "O" : "X");
      g.deadlineAt = now() + MOVE_MS;
      g.updatedAt = now();
    }

    await kv.set(`game:${gameId}`, g);

    if (g.status === "FINISHED" && g.winner) {
      const p = await maybePayout(gameId, g);
      payoutSig = p.sig;
    }
  }

  const deadlineAt =
    g?.status === "PLAYING" && g?.deadlineAt ? Number(g.deadlineAt) : null;

  const serverSecondsLeft =
    deadlineAt && Number.isFinite(deadlineAt)
      ? Math.max(0, Math.ceil((deadlineAt - serverNow) / 1000))
      : 0;

  return NextResponse.json({
    ok: true,
    game: g,
    payoutSig,
    serverNow,
    serverSecondsLeft,
  });
}
