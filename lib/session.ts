// lib/session.ts
import { kv } from "@/lib/kv";

const SESSION_TTL_SEC = 60 * 30; // 30 min

function randToken() {
  // browser-safe random-ish token for server-side use
  return `st_${Math.random().toString(36).slice(2)}${Math.random()
    .toString(36)
    .slice(2)}${Date.now().toString(36)}`;
}

export type Session = {
  pubkey: string;
  createdAt: number;
  // Optional binding to a game (useful for moves)
  gameId?: string;
};

export async function createSession(pubkey: string, gameId?: string) {
  const token = randToken();
  const s: Session = { pubkey, createdAt: Date.now(), gameId };
  await kv.set(`session:${token}`, s, { ex: SESSION_TTL_SEC });
  return token;
}

export async function getSession(token: string) {
  if (!token) return null;
  const s = await kv.get<Session>(`session:${token}`);
  return s ?? null;
}

export async function bindSessionToGame(token: string, gameId: string) {
  const s = await getSession(token);
  if (!s) return false;
  s.gameId = gameId;
  await kv.set(`session:${token}`, s, { ex: SESSION_TTL_SEC });
  return true;
}

export async function requireSession(token: string, gameId?: string) {
  const s = await getSession(token);
  if (!s) return { ok: false as const, error: "Invalid/expired session" };

  if (gameId && s.gameId && s.gameId !== gameId) {
    return { ok: false as const, error: "Session not valid for this game" };
  }

  return { ok: true as const, session: s };
}
