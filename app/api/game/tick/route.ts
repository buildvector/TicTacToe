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
    g.status = "FINISHED";
    g.winner = w; // "X" | "O"
    g.updatedAt = now();
    return { ok: true, finished: true, draw: false };
  }

  if (isFull(g.board)) {
    // DRAW => clear board and continue, keep order (i.e., next turn continues)
    g.board = emptyBoard();
    g.moves = 0;
    g.draws = Number(g.draws ?? 0) + 1;
    g.status = "PLAYING";
    g.turn = other(mark);
    g.deadlineAt = now() + MOVE_MS;
    g.updatedAt = now();
    return { ok: true, finished: false, draw: true };
  }

  // normal continue
  g.turn = other(mark);
  g.deadlineAt = now() + MOVE_MS;
  g.updatedAt = now();
  return { ok: true, finished: false, draw: false };
}

async function acquireLock(key: string, seconds = 10) {
  // Upstash Redis supports NX via options.
  try {
    const r = await kv.set(key, "1", { nx: true, ex: seconds });
    // Some clients return "OK", some return true-ish, some return null
    return !!r;
  } catch {
    // Fallback (not atomic, but better than nothing)
    const existing = await kv.get(key);
    if (existing) return false;
    await kv.set(key, "1", { ex: seconds });
    return true;
  }
}

async function maybePayout(gameId: string, g: any) {
  if (g.status !== "FINISHED" || !g.winner) return { paid: false, sig: null as string | null };

  // already paid
  if (g.payoutSig && g.winnerPubkey) return { paid: true, sig: g.payoutSig as string };

  // lock to prevent double payout
  const locked = await acquireLock(`payoutlock:${gameId}`, 15);
  if (!locked) return { paid: false, sig: null };

  // re-check after lock
  const fresh = (await kv.get<any>(`game:${gameId}`)) ?? g;
  if (fresh.payoutSig && fresh.winnerPubkey) return { paid: true, sig: fresh.payoutSig as string };

  const winnerPk = fresh.winner === "X" ? fresh.xPlayer : fresh.oPlayer;
  fresh.winnerPubkey = winnerPk;
  fresh.endedReason = "WIN";

  // store pending first
  fresh.updatedAt = now();
  await kv.set(`game:${gameId}`, fresh);

  const sig = await payoutFromTreasury(new PublicKey(winnerPk), Number(fresh.potLamports));
  fresh.payoutSig = sig;
  fresh.updatedAt = now();
  await kv.set(`game:${gameId}`, fresh);

  // history best-effort
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

export async function POST(req: Request) {
  try {
    const { gameId } = await req.json();
    if (!gameId) return NextResponse.json({ error: "Missing gameId" }, { status: 400 });

    const g = await kv.get<any>(`game:${gameId}`);
    if (!g) return NextResponse.json({ error: "Not found" }, { status: 404 });

    if (g.status !== "PLAYING") {
      return NextResponse.json({ ok: true, game: g, payoutSig: g.payoutSig ?? null });
    }

    // If deadline passed => auto-move once
    if (g.deadlineAt && now() > Number(g.deadlineAt)) {
      const idx = autoMoveIndex(g);
      if (idx >= 0) {
        applyTurnMove(g, idx);
        await kv.set(`game:${gameId}`, g);

        // payout if the auto-move ended the game
        if (g.status === "FINISHED" && g.winner) {
          const p = await maybePayout(gameId, g);
          const gg = (await kv.get<any>(`game:${gameId}`)) ?? g;
          return NextResponse.json({ ok: true, game: gg, payoutSig: p.sig });
        }
      } else {
        // no available moves => treat as draw-continue (board weird state) - just reset
        g.board = emptyBoard();
        g.moves = 0;
        g.turn = other(g.turn === "O" ? "O" : "X");
        g.deadlineAt = now() + MOVE_MS;
        g.updatedAt = now();
        await kv.set(`game:${gameId}`, g);
      }
    }

    return NextResponse.json({ ok: true, game: g, payoutSig: g.payoutSig ?? null });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Server error" }, { status: 500 });
  }
}
