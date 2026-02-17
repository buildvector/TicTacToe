import { NextResponse } from "next/server";
import { kv } from "@/lib/kv";
import { emptyBoard, Game } from "@/lib/game";
import { netAfterFee } from "@/lib/sol";
import { createSession, bindSessionToGame } from "@/lib/session";
import { verifyTreasuryTransferOrThrow } from "@/lib/payment";
import { Connection, PublicKey } from "@solana/web3.js";

export const runtime = "nodejs";

const TREASURY = process.env.NEXT_PUBLIC_TREASURY_PUBKEY!;

const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL ||
  process.env.SOLANA_RPC_URL ||
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
  process.env.NEXT_PUBLIC_SOLANA_RPC ||
  "https://api.devnet.solana.com";

function makeId() {
  return `g_${Math.random().toString(36).slice(2, 8)}${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function pickBetLamports(body: any): number | null {
  const v =
    body?.betLamports ??
    body?.payload?.betLamports ??
    body?.payload?.stakeLamports ??
    body?.payload?.bet ??
    null;

  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function pickCreatorPubkey(body: any): string | null {
  const v = body?.creatorPubkey ?? body?.pubkey ?? body?.payload?.creatorPubkey ?? null;
  if (!v || typeof v !== "string") return null;
  return v;
}

function pickPaymentSig(body: any): string | null {
  const v =
    body?.paymentSig ??
    body?.paymentSignature ??
    body?.txSig ??
    body?.signatureTx ??
    body?.payload?.paymentSig ??
    body?.payload?.txSig ??
    null;

  if (!v || typeof v !== "string") return null;
  return v;
}

async function paymentUsed(sig: string) {
  const usedKey = `payused:${sig}`;
  const used = await kv.get(usedKey);
  return { usedKey, used };
}

async function markPaymentUsed(usedKey: string) {
  await kv.set(usedKey, 1, { ex: 60 * 60 });
}

async function findRecentMatchingPaymentSig(args: {
  creatorPubkey: string;
  lamports: number;
}): Promise<string | null> {
  const connection = new Connection(RPC_URL, "confirmed");
  const treasuryPk = new PublicKey(TREASURY);

  const sigs = await connection.getSignaturesForAddress(treasuryPk, { limit: 25 });

  for (const s of sigs) {
    const sig = s.signature;

    const { used } = await paymentUsed(sig);
    if (used) continue;

    try {
      await verifyTreasuryTransferOrThrow({
        paymentSig: sig,
        fromPubkey: args.creatorPubkey,
        toPubkey: TREASURY,
        lamports: Number(args.lamports),
      });

      return sig;
    } catch {
      continue;
    }
  }

  return null;
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));

    const creatorPubkey = pickCreatorPubkey(body);
    const betLamports = pickBetLamports(body);

    let paymentSig = pickPaymentSig(body);

    if (!creatorPubkey || !betLamports) {
      return NextResponse.json({ error: "Bad input" }, { status: 400 });
    }

    if (!paymentSig) {
      paymentSig = await findRecentMatchingPaymentSig({
        creatorPubkey,
        lamports: betLamports,
      });

      if (!paymentSig) {
        return NextResponse.json(
          { error: "Missing paymentSig and no matching recent treasury transfer found." },
          { status: 400 }
        );
      }
    }

    const { usedKey, used } = await paymentUsed(paymentSig);
    if (used) return NextResponse.json({ error: "Payment already used" }, { status: 400 });

    await verifyTreasuryTransferOrThrow({
      paymentSig,
      fromPubkey: creatorPubkey,
      toPubkey: TREASURY,
      lamports: Number(betLamports),
    });

    await markPaymentUsed(usedKey);

    const ts = Date.now();
    const id = makeId();

    const g: Game = {
      id,
      betLamports: Number(betLamports),
      createdBy: creatorPubkey,
      potLamports: netAfterFee(Number(betLamports)), // 97%
      status: "LOBBY",

      board: emptyBoard(),
      turn: "X",

      createdAt: ts,
      updatedAt: ts,
      moves: 0,

      // xPlayer/oPlayer sættes først ved join
      xPlayer: undefined,
      oPlayer: undefined,
      joinedBy: undefined,
    };

    await kv.set(`game:${id}`, g);
    await kv.zadd("games:lobby", { score: ts, member: id });

    const sessionToken = await createSession(creatorPubkey);
    await bindSessionToGame(sessionToken, id);

    return NextResponse.json({ ok: true, gameId: id, sessionToken });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Server error" }, { status: 500 });
  }
}
