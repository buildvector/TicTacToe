import { NextResponse } from "next/server";
import { kv } from "@/lib/kv";
import { nowMs } from "@/lib/clock";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const noStoreHeaders = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  Pragma: "no-cache",
};

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const gameId = searchParams.get("gameId");
  if (!gameId) return NextResponse.json({ error: "Missing gameId" }, { status: 400, headers: noStoreHeaders });

  const g = await kv.get<any>(`game:${gameId}`);
  if (!g) return NextResponse.json({ error: "Not found" }, { status: 404, headers: noStoreHeaders });

  // ✅ Provide stable server time for UI countdown
  const serverNowMs = await nowMs();

  return NextResponse.json({ ok: true, game: g, serverNowMs }, { headers: noStoreHeaders });
}
