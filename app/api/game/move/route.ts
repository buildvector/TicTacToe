import { NextResponse } from "next/server";
import { kv } from "@/lib/kv";
import { applyMove, other } from "@/lib/game";
import { payoutFromTreasury } from "@/lib/sol";
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { requireSession } from "@/lib/session";
import { nowMs } from "@/lib/clock";

export const runtime = "nodejs";

// ✅ Turn timeout (ms). Keep in sync with join route.
const MOVE_MS = Number(process.env.MOVE_MS ?? "90000");

// SolArena leaderboard integration
const SOLARENA_MATCH_URL =
  process.env.SOLARENA_MATCH_URL?.trim() ||
  "https://sol-arena-web.vercel.app/api/match";

const SOLARENA_GAME_KEY = process.env.SOLARENA_GAME_KEY?.trim() || "";

async function acquireLock(key: string, seconds = 10) {
  const r = await kv.set(key, "1", { nx: true, ex: seconds });
  return !!r;
}

type SolarenaResult = "win" | "play" | "loss";

async function postSolarenaEvent(params: {
  wallet: string;
  result: SolarenaResult;
  amountSol: number;
  gameId: string;
  reason: string;
  payoutSig?: string | null;
  role: "winner" | "loser";
}) {
  try {
    if (!params.wallet) return;

    // Only post if key exists (local dev OK too – you have it in .env.local)
    if (!SOLARENA_GAME_KEY) {
      console.log("[ttt] SOLARENA_GAME_KEY missing -> skip posting", params.result);
      return;
    }

    // allow 0 for loser if you ever want, but for volume fairness we typically want >0
    if (!Number.isFinite(params.amountSol) || params.amountSol < 0) {
      console.log("[ttt] amountSol invalid -> skip posting", params.amountSol);
      return;
    }

    const res = await fetch(SOLARENA_MATCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-game-key": SOLARENA_GAME_KEY,
      },
      body: JSON.stringify({
        wallet: params.wallet,
        game: "ttt",
        result: params.result,
        amountSol: params.amountSol,
        // meta used for debugging + dedupe on solarena-web side
        meta: JSON.stringify({
          source: "ttt",
          gameId: params.gameId,
          reason: params.reason,
          role: params.role,
          payoutSig: params.payoutSig ?? null,
        }),
      }),
    });

    const txt = await res.text().catch(() => "");
    console.log(`[ttt] posted ${params.result}/${params.role} ->`, res.status, txt.slice(0, 200));
  } catch (e: any) {
    console.log("[ttt] failed to post event", e?.message ?? e);
  }
}

function noStore(res: NextResponse) {
  res.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.headers.set("Pragma", "no-cache");
  return res;
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

  // ensure winnerPubkey exists
  fresh.winnerPubkey = winnerPk;
  fresh.endedReason = fresh.endedReason ?? "WIN";
  fresh.updatedAt = await nowMs();
  await kv.set(`game:${gameId}`, fresh);

  // determine loser wallet
  const loserPk =
    winnerPk === String(fresh.createdBy) ? String(fresh.joinedBy ?? "") : String(fresh.createdBy ?? "");

  // amount logic:
  // - winner gets pot volume (the payout volume)
  // - loser gets bet volume (so volume is fair / not all on winner)
  const potSol = Number(fresh.potLamports ?? 0) / LAMPORTS_PER_SOL;
  const betSol = Number(fresh.betLamports ?? 0) / LAMPORTS_PER_SOL;

  // ✅ Dedup lock so we only post once even if multiple routes reach payout
  const posted = await acquireLock(`solarena:posted:${gameId}`, 60 * 60);
  if (posted) {
    // winner: win
    if (winnerPk && potSol > 0) {
      await postSolarenaEvent({
        wallet: winnerPk,
        result: "win",
        amountSol: potSol,
        gameId,
        reason: String(fresh.endedReason ?? "WIN"),
        payoutSig: null,
        role: "winner",
      });
    }

    // loser: play (counts as volume + participation)
    if (loserPk && betSol > 0) {
      await postSolarenaEvent({
        wallet: loserPk,
        result: "play",
        amountSol: betSol,
        gameId,
        reason: String(fresh.endedReason ?? "WIN"),
        payoutSig: null,
        role: "loser",
      });
    }
  }

  // payout
  const sig = await payoutFromTreasury(new PublicKey(winnerPk), Number(fresh.potLamports));
  fresh.payoutSig = sig;
  fresh.updatedAt = await nowMs();
  await kv.set(`game:${gameId}`, fresh);

  // optional: store history
  try {
    const item = {
      at: Date.now(),
      gameId,
      betLamports: fresh.betLamports,
      winner: winnerPk,
      loser: loserPk || null,
      payoutSig: sig,
      endedReason: fresh.endedReason ?? "WIN",
    };
    await kv.lpush("games:history", item);
    await kv.ltrim("games:history", 0, 9);
  } catch {}

  return { paid: true, sig };
}

function ensureDeadline(g: any, serverNow: number) {
  if (!Number.isFinite(Number(g.deadlineAt)) || Number(g.deadlineAt) <= 0) {
    g.turnStartedAt = serverNow;
    g.deadlineAt = serverNow + MOVE_MS;
    g.moveMs = MOVE_MS;
  }
}

function computeTimeoutWinner(g: any) {
  const winnerMark = other(g.turn);
  const winnerPk = winnerMark === "X" ? g.xPlayer : g.oPlayer;
  return { winnerMark, winnerPk };
}

async function applyTimeoutIfExpired(gameId: string, g: any, serverNow: number) {
  ensureDeadline(g, serverNow);

  const deadlineAt = Number(g.deadlineAt);
  if (!Number.isFinite(deadlineAt) || deadlineAt <= 0) return { didTimeout: false };
  if (serverNow <= deadlineAt) return { didTimeout: false };

  if (g.status === "FINISHED") return { didTimeout: true };

  const locked = await acquireLock(`timeoutlock:${gameId}`, 15);
  if (!locked) return { didTimeout: true };

  const fresh = (await kv.get<any>(`game:${gameId}`)) ?? g;
  if (fresh.status === "FINISHED") return { didTimeout: true };
  if (fresh.status !== "PLAYING") return { didTimeout: false };

  ensureDeadline(fresh, serverNow);
  const freshDeadline = Number(fresh.deadlineAt);
  if (serverNow <= freshDeadline) return { didTimeout: false };

  const { winnerMark, winnerPk } = computeTimeoutWinner(fresh);
  if (!winnerPk) return { didTimeout: false };

  fresh.status = "FINISHED";
  fresh.winner = winnerMark;
  fresh.winnerPubkey = winnerPk;
  fresh.endedReason = "TIMEOUT";
  fresh.updatedAt = serverNow;

  await kv.set(`game:${gameId}`, fresh);

  // ✅ No posting here anymore — handled once inside maybePayout (single source of truth)
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
      return noStore(NextResponse.json({ error: "Bad input" }, { status: 400 }));
    }

    const s = await requireSession(sessionToken, gameId);
    if (!s.ok) return noStore(NextResponse.json({ error: s.error }, { status: 401 }));

    const playerPubkey = s.session.pubkey;

    const g = await kv.get<any>(`game:${gameId}`);
    if (!g) return noStore(NextResponse.json({ error: "Not found" }, { status: 404 }));

    if (g.status === "FINISHED") {
      return noStore(NextResponse.json({ ok: true, game: g, payoutSig: g.payoutSig ?? null }));
    }

    if (g.status !== "PLAYING") {
      return noStore(NextResponse.json({ error: "Not playing" }, { status: 400 }));
    }

    const serverNow = await nowMs();

    // ✅ Always apply timeout check first
    const t = await applyTimeoutIfExpired(gameId, g, serverNow);
    if (t.didTimeout) {
      return noStore(
        NextResponse.json({
          ok: true,
          game: t.game ?? g,
          payoutSig: t.payoutSig ?? null,
          serverNowMs: serverNow,
        })
      );
    }

    ensureDeadline(g, serverNow);

    // CLAIM action
    if (action === "CLAIM") {
      if (serverNow <= Number(g.deadlineAt)) {
        return noStore(NextResponse.json({ error: "Not timed out yet" }, { status: 400 }));
      }

      const t2 = await applyTimeoutIfExpired(gameId, g, serverNow);
      const gg = (await kv.get<any>(`game:${gameId}`)) ?? g;
      return noStore(
        NextResponse.json({
          ok: true,
          game: gg,
          payoutSig: t2.payoutSig ?? null,
          serverNowMs: serverNow,
        })
      );
    }

    // MOVE action
    if (action !== "MOVE") {
      return noStore(NextResponse.json({ error: "Bad action" }, { status: 400 }));
    }

    if (indexRaw === undefined || indexRaw === null) {
      return noStore(NextResponse.json({ error: "Missing index" }, { status: 400 }));
    }

    const index = Number(indexRaw);
    if (!Number.isFinite(index)) {
      return noStore(NextResponse.json({ error: "Bad index" }, { status: 400 }));
    }

    const currentPlayer = g.turn === "X" ? g.xPlayer : g.oPlayer;
    if (currentPlayer !== playerPubkey) {
      return noStore(NextResponse.json({ error: "Not your turn" }, { status: 400 }));
    }

    const res = applyMove(g, index);
    if (!res.ok) {
      await kv.set(`game:${gameId}`, g);
      return noStore(NextResponse.json({ error: res.error }, { status: 400 }));
    }

    // If winner -> payout (and posting) happens inside maybePayout
    if (g.status === "FINISHED" && g.winner) {
      g.winnerPubkey = g.winner === "X" ? g.xPlayer : g.oPlayer;
      g.endedReason = g.endedReason ?? "WIN";
      g.updatedAt = await nowMs();
      await kv.set(`game:${gameId}`, g);

      const p = await maybePayout(gameId, g);
      const gg = (await kv.get<any>(`game:${gameId}`)) ?? g;

      return noStore(
        NextResponse.json({
          ok: true,
          game: gg,
          payoutSig: p.sig,
          serverNowMs: await nowMs(),
        })
      );
    }

    // successful move: restart timer
    const ts = await nowMs();
    g.turnStartedAt = ts;
    g.deadlineAt = ts + MOVE_MS;
    g.moveMs = MOVE_MS;
    g.updatedAt = ts;

    await kv.set(`game:${gameId}`, g);

    return noStore(NextResponse.json({ ok: true, game: g, serverNowMs: ts }));
  } catch (e: any) {
    return noStore(NextResponse.json({ error: e?.message ?? "Server error" }, { status: 500 }));
  }
}