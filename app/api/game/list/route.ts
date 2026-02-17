import { NextResponse } from "next/server";
import { kv } from "@/lib/kv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const noStoreHeaders = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  Pragma: "no-cache",
};

export async function GET() {
  const ids = await kv.zrange<string[]>("games:lobby", 0, 50, { rev: true });

  const games: any[] = [];

  for (const id of ids) {
    const g = await kv.get<any>(`game:${id}`);

    // cleanup: remove dead/stale ids
    if (!g || g.status !== "LOBBY") {
      try {
        await kv.zrem("games:lobby", id);
      } catch {}
      continue;
    }

    games.push(g);
  }

  return NextResponse.json({ games }, { headers: noStoreHeaders });
}
