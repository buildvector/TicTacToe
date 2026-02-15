import { NextResponse } from "next/server";
import { kv } from "@/lib/kv";

export async function GET() {
  const ids = await kv.zrange<string[]>("games:lobby", 0, 50, { rev: true });
  const games = [];
  for (const id of ids) {
    const g = await kv.get<any>(`game:${id}`);
    if (g && g.status === "LOBBY") games.push(g);
  }
  return NextResponse.json({ games });
}
