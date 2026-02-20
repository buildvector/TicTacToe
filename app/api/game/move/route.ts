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

async function hasMarker(key: string) {
  const v = await kv.get<string>(key);
  return !!v;
}

async function setMarker(key: string, seconds: number) {
  await kv.set(key, "1", { ex: seconds });
}

type SolarenaResult = "win" | "play" | "loss";

function noStore(res: NextResponse) {
  res.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.headers.set("Pragma", "no-cache");
  return res;
}

async function fetchWithTimeout(url: string, init: RequestInit, ms = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

async function postSolarenaEvent(params: {
  wallet: string;
  result: SolarenaResult;
  amountSol: number;
  gameId: string;
  reason: string;
  payoutSig?: string | null;
  role: "winner" | "loser";
}) {
  if (!params.wallet) return { ok: false, status: 0, body: "missing wallet" };

  if (!SOLARENA_GAME_KEY) {
    console.log("[ttt] SOLARENA_GAME_KEY missing -> skip posting", {
      result: params.result,
      role: params.role,
    });
    return { ok: false, status: 0, body: "missing key" };
  }

  if (!Number.isFinite(params.amountSol) || params.amountSol < 0) {
    console.log("[ttt] amountSol invalid -> skip posting", params.amountSol);
    return { ok: false, status: 0, body: "bad amountSol" };
  }

  const payload = {
    wallet: params.wallet,
    game: "ttt",
    result: params.result,
    amountSol: params.amountSol,
    meta: JSON.stringify({
      source: "ttt",
      gameId: params.gameId,
      reason: params.reason,
      role: params.role,
      payoutSig: params.payoutSig ?? null,
    }),
  };

  console.log("[ttt] -> post /api/match", {
    url: SOLARENA_MATCH_URL,
    wallet: params.wallet,
    result: params.result,
    role: params.role,
    amountSol: params.amountSol,
  });

  try {
    const res = await fetchWithTimeout(
      SOLARENA_MATCH_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-game-key": SOLARENA_GAME_KEY,
        },
        body: JSON.stringify(payload),
      },
      8000
    );

    const txt = await res.text().catch(() => "");
    console.log(`[ttt] <- /api/match ${params.result}/${params.role}`, res.status, txt.slice(0, 200));

    return { ok: res.ok, status: res.status, body: txt };
  } catch (e: any) {
    console.log("[ttt] /api/match fetch failed", e?.name, e?.message ?? e);
    return { ok: false, status: 0, body: String(e?.message ?? e) };
  }
}

/**
 * Post once per gameId, but ONLY mark posted when it actually succeeded.
 * Also add a short backoff lock so polling doesn't spam Solarena.
 */
async function maybePostSolarenaOnce(gameId: string, g: any, payoutSig: string | null) {
  const postedKey = `solarena:posted:${gameId}`;
  const tryLockKey = `solarena:trylock:${gameId}`;

  // already posted successfully
  if (await hasMarker(postedKey)) return;

  // short backoff so repeated calls don't spam while match endpoint is failing
  const canTry = await acquireLock(tryLockKey, 15);
  if (!canTry) return;

  const winnerPk =
    String(g.winnerPubkey || "") ||
    String(g.winner === "X" ? g.xPlayer : g.oPlayer);

  const loserPk =
    winnerPk === String(g.createdBy) ? String(g.joinedBy ?? "") : String(g.createdBy ?? "");

  const potSol = Number(g.potLamports ?? 0) / LAMPORTS_PER_SOL;
  const betSol = Number(g.betLamports ?? 0) / LAMPORTS_PER_SOL;

  // If these are weirdly 0, log it – payout can still succeed with lamports but we'd like to know
  console.log("[ttt] maybePostSolarenaOnce", {
    gameId,
    winnerPk,
    loserPk,
    potSol,
    betSol,
    endedReason: g.endedReason,
    hasKey: !!SOLARENA_GAME_KEY,
  });

  // winner win event
  const w = await postSolarenaEvent({
    wallet: winnerPk,
    result: "win",
    amountSol: potSol,
    gameId,
    reason: String(g.endedReason ?? "WIN"),
    payoutSig,
    role: "winner",
  });

  // loser play event (volume+participation)
  const l = await postSolarenaEvent({
    wallet: loserPk,
    result: "play",
    amountSol: betSol,
    gameId,
    reason: String(g.endedReason ?? "WIN"),
    payoutSig,
    role: "loser",
  });

  // Mark as posted ONLY if both calls succeeded (2xx)
  if (w.ok && l.ok) {
    await setMarker(postedKey, 60 * 60 * 24 * 7); // 7 days
    console.log("[ttt] solarena posted OK -> marked", postedKey);
  } else {
    console.log("[ttt] solarena post NOT ok -> will retry later", {
      winner: { ok: w.ok, status: w.status },
      loser: { ok: l.ok, status: l.status },
    });
    // no marker => next call can retry (but tryLock prevents spamming)
  }
}

async function maybePayout(gameId: string, g: any) {
  if (g.status !== "FINISHED" || !g.winner) return { paid: false, sig: null as string | null };
  if (g.payoutSig && g.winnerPubkey) return { paid: true, sig: g.payoutSig as string };

  const locked = await acquireLock(`payoutlock:${gameId}`, 15);
  if (!locked) return { paid: false, sig: null };

  const fresh = (await kv.get<any>(`game:${gameId}`)) ?? g;
  if (fresh.payoutSig && fresh.winnerPubkey) {
    // Payout already happened elsewhere; try posting (with payoutSig known)
    await maybePostSolarenaOnce(gameId, fresh, fresh.payoutSig as string);
    return { paid: true, sig: fresh.payoutSig as string };
  }

  const winnerPk =
    String(fresh.winnerPubkey || "") ||
    String(fresh.winner === "X" ? fresh.xPlayer : fresh.oPlayer);

  if (!winnerPk) return { paid: false, sig: null };

  // ensure winnerPubkey exists
  fresh.winnerPubkey = winnerPk;
  fresh.endedReason = fresh.endedReason ?? "WIN";
  fresh.updatedAt = await nowMs();
  await kv.set(`game:${gameId}`, fresh);

  // payout first (so we can include payoutSig in solarena meta)
  const sig = await payoutFromTreasury(new PublicKey(winnerPk), Number(fresh.potLamports));

  fresh.payoutSig = sig;
  fresh.updatedAt = await nowMs();
  await kv.set(`game:${gameId}`, fresh);

  // Now post (idempotent + retries)
  await maybePostSolarenaOnce(gameId, fresh, sig);

  // optional: store history
  try {
    const loserPk =
      winnerPk === String(fresh.createdBy) ? String(fresh.joinedBy ?? "") : String(fresh.createdBy ?? "");

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

    // If winner -> payout + leaderboard post
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