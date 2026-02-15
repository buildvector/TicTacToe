import { NextResponse } from "next/server";
import { kv } from "@/lib/kv";
import { now, autoMoveIndex, applyMove } from "@/lib/game";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const gameId = searchParams.get("gameId");
  if (!gameId) return NextResponse.json({ error: "Missing gameId" }, { status: 400 });

  const g = await kv.get<any>(`game:${gameId}`);
  if (!g) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // server-side auto-move
  if (g.status === "PLAYING" && g.deadlineAt && now() > g.deadlineAt) {
    const idx = autoMoveIndex(g);
    if (idx >= 0) applyMove(g, idx);
    g.updatedAt = now();
    await kv.set(`game:${gameId}`, g);
  }

  return NextResponse.json({ game: g });
}
