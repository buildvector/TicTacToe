import { NextResponse } from "next/server";
import { kv } from "@/lib/kv";

export async function GET() {
  const items = await kv.lrange<any[]>("games:history", 0, 9);
  return NextResponse.json({ history: items ?? [] });
}
