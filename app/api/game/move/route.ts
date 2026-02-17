import { NextResponse } from "next/server";
import { kv } from "@/lib/kv";
import { applyMove, other } from "@/lib/game";
import { payoutFromTreasury } from "@/lib/sol";
import { PublicKey } from "@solana/web3.js";
import { requireSession } from "@/lib/session";
import { nowMs } from "@/lib/clock";

export const runtime = "nodejs";

// ✅ Turn timeout (ms). Keep in sync with join route.
const MOVE_MS = Number(process.env.MOVE_MS ?? "90000");

async function acquireLock(key: string, seconds = 10) {
  const r = await kv.set(key, "1", { nx: true, ex: seconds });
  return !!r;
}

async function maybePayout(gameId: string, g: any) {
  if (g.status !== "FINISHED" || !g.winner) return { paid: false, sig: null as string | null };
  if (g.payoutSig && g.winnerPubkey) return { paid: true, sig: g.payoutSig as string };

  const locked = await acquireLock(`payoutlock:${gameId}`, 15);
  if (!locked) return { paid: false, sig: null };

  const fresh = (await kv.get<any>(`game:${gameId}`)) ?? g;
  if (fresh.payoutSig && fresh.winnerPubkey) return { paid: true, sig: fresh.payoutSig as string };

  const winnerPk =
    fresh.winnerPubkey ||
    (fresh.winner === "X" ? fresh.xPlayer : fresh.oPlayer);

  if (!winnerPk) return { paid: false, sig: null };

  fresh.winnerPubkey = winnerPk;
  fresh.endedReason = fresh.endedReason ?? "WIN";
  fresh.updatedAt = await nowMs();
  await kv.set(`game:${gameId}`, fresh);

  const sig = await payoutFromTreasury(new PublicKey(winnerPk), Number(fresh.potLamports));
  fresh.payoutSig = sig;
  fresh.updatedAt = await nowMs();
  await kv.set(`game:${gameId}`, fresh);

  try {
    const item = {
      at: Date.now(),
      gameId,
      betLamports: fresh.betLamports,
      winner: winnerPk,
      loser: winnerPk === fresh.createdBy ? fresh.joinedBy : fresh.createdBy,
      payoutSig: sig,
      endedReason: fresh.endedReason ?? "WIN",
    };
    await kv.lpush("games:history", item);
    await kv.ltrim("games:history", 0, 9);
  } catch {}

  return { paid: true, sig };
}

function ensureDeadline(g: any, serverNow: number) {
  // If older game objects are missing timer fields, initialize once.
  if (!Number.isFinite(Number(g.deadlineAt)) || Number(g.deadlineAt) <= 0) {
    g.turnStartedAt = serverNow;
    g.deadlineAt = serverNow + MOVE_MS;
    g.moveMs = MOVE_MS;
  }
}

function computeTimeoutWinner(g: any) {
  // The player whose turn it currently is timed out -> other(turn) wins.
  const winnerMark = other(g.turn);
  const winnerPk = winnerMark === "X" ? g.xPlayer : g.oPlayer;
  return { winnerMark, winnerPk };
}

async function applyTimeoutIfExpired(gameId: string, g: any, serverNow: number) {
  ensureDeadline(g, serverNow);

  const deadlineAt = Number(g.deadlineAt);
  if (!Number.isFinite(deadlineAt) || deadlineAt <= 0) return { didTimeout: false };

  if (serverNow <= deadlineAt) return { didTimeout: false };

  // Already finished?
  if (g.status === "FINISHED") return { didTimeout: true };

  const locked = await acquireLock(`timeoutlock:${gameId}`, 15);
  if (!locked) return { didTimeout: true };

  const fresh = (await kv.get<any>(`game:${gameId}`)) ?? g;
  if (fresh.status === "FINISHED") return { didTimeout: true };

  // Only timeout if still PLAYING
  if (fresh.status !== "PLAYING") return { didTimeout: false };

  ensureDeadline(fresh, serverNow);
  const freshDeadline = Number(fresh.deadlineAt);
  if (serverNow <= freshDeadline) return { didTimeout: false };

  const { winnerMark, winnerPk } = computeTimeoutWinner(fresh);
  if (!winnerPk) {
    // Shouldn't happen, but don't brick state.
    return { didTimeout: false };
  }

  fresh.status = "FINISHED";
  fresh.winner = winnerMark;
  fresh.winnerPubkey = winnerPk;
  fresh.endedReason = "TIMEOUT";
  fresh.updatedAt = serverNow;

  await kv.set(`game:${gameId}`, fresh);

  const p = await maybePayout(gameId, fresh);
  const gg = (await kv.get<any>(`game:${gameId}`)) ?? fresh;

  return { didTimeout: true, game: gg, payoutSig: p.sig ?? null };
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));

    const gameId = String(body?.gameId ?? "");
    const sessionToken = String(body?.sessionToken ?? "");

    // action: "MOVE" | "CLAIM"
    const action = String(body?.action ?? "MOVE").toUpperCase();
    const indexRaw = body?.index;

    if (!gameId || !sessionToken) {
      return NextResponse.json({ error: "Bad input" }, { status: 400 });
    }

    const s = await requireSession(sessionToken, gameId);
    if (!s.ok) return NextResponse.json({ error: s.error }, { status: 401 });

    const playerPubkey = s.session.pubkey;

    const g = await kv.get<any>(`game:${gameId}`);
    if (!g) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // If already finished, just return
    if (g.status === "FINISHED") {
      return NextResponse.json({ ok: true, game: g, payoutSig: g.payoutSig ?? null });
    }

    if (g.status !== "PLAYING") {
      return NextResponse.json({ error: "Not playing" }, { status: 400 });
    }

    const serverNow = await nowMs();

    // ✅ Always apply timeout check first (covers "first move never taken")
    const t = await applyTimeoutIfExpired(gameId, g, serverNow);
    if (t.didTimeout) {
      // If timeout happened, return updated state.
      return NextResponse.json({ ok: true, game: t.game ?? g, payoutSig: t.payoutSig ?? null, serverNowMs: serverNow });
    }

    // Ensure timer exists even on older games
    ensureDeadline(g, serverNow);

    // CLAIM action: user asks server to check timeout and award win if expired.
    if (action === "CLAIM") {
      // Not expired => reject
      if (serverNow <= Number(g.deadlineAt)) {
        return NextResponse.json({ error: "Not timed out yet" }, { status: 400 });
      }

      // Re-run (will timeout now)
      const t2 = await applyTimeoutIfExpired(gameId, g, serverNow);
      const gg = (await kv.get<any>(`game:${gameId}`)) ?? g;
      return NextResponse.json({ ok: true, game: gg, payoutSig: t2.payoutSig ?? null, serverNowMs: serverNow });
    }

    // MOVE action
    if (action !== "MOVE") {
      return NextResponse.json({ error: "Bad action" }, { status: 400 });
    }

    if (indexRaw === undefined || indexRaw === null) {
      return NextResponse.json({ error: "Missing index" }, { status: 400 });
    }

    const index = Number(indexRaw);
    if (!Number.isFinite(index)) {
      return NextResponse.json({ error: "Bad index" }, { status: 400 });
    }

    const currentPlayer = g.turn === "X" ? g.xPlayer : g.oPlayer;
    if (currentPlayer !== playerPubkey) {
      return NextResponse.json({ error: "Not your turn" }, { status: 400 });
    }

    const res = applyMove(g, index);
    if (!res.ok) {
      await kv.set(`game:${gameId}`, g);
      return NextResponse.json({ error: res.error }, { status: 400 });
    }

    // If winner, set winnerPubkey before payout
    if (g.status === "FINISHED" && g.winner) {
      g.winnerPubkey = g.winner === "X" ? g.xPlayer : g.oPlayer;
      g.endedReason = g.endedReason ?? "WIN";
      g.updatedAt = await nowMs();
      await kv.set(`game:${gameId}`, g);

      const p = await maybePayout(gameId, g);
      const gg = (await kv.get<any>(`game:${gameId}`)) ?? g;
      return NextResponse.json({ ok: true, game: gg, payoutSig: p.sig, serverNowMs: await nowMs() });
    }

    // ✅ Successful move: restart timer for next turn
    const ts = await nowMs();
    g.turnStartedAt = ts;
    g.deadlineAt = ts + MOVE_MS;
    g.moveMs = MOVE_MS;
    g.updatedAt = ts;

    await kv.set(`game:${gameId}`, g);

    return NextResponse.json({ ok: true, game: g, serverNowMs: ts });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Server error" }, { status: 500 });
  }
}
