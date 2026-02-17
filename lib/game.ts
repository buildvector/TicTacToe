export type Cell = "X" | "O" | null;

export type GameStatus = "LOBBY" | "PLAYING" | "FINISHED";

export type EndedReason = "WIN" | "LEAVE" | "TIMEOUT" | "CANCELLED";

export type Game = {
  id: string;
  betLamports: number;

  createdBy: string;
  joinedBy?: string;

  potLamports: number;
  status: GameStatus;

  board: Cell[];     // 9
  turn: "X" | "O";   // who places next
  xPlayer?: string;  // pubkey
  oPlayer?: string;  // pubkey

  createdAt: number;
  updatedAt: number;

  moves: number;

  // ✅ Turn timer fields (server authority)
  turnStartedAt?: number;
  deadlineAt?: number;
  moveMs?: number;

  winner?: "X" | "O";
  winnerPubkey?: string;
  endedReason?: EndedReason;
};

const LINES = [
  [0, 1, 2],[3, 4, 5],[6, 7, 8],
  [0, 3, 6],[1, 4, 7],[2, 5, 8],
  [0, 4, 8],[2, 4, 6],
] as const;

export function now() { return Date.now(); }

export function emptyBoard(): Cell[] { return Array(9).fill(null); }

export function other(t: "X" | "O") { return t === "X" ? "O" : "X"; }

export function winnerOf(board: Cell[]) {
  for (const [a, b, c] of LINES) {
    const v = board[a];
    if (v && v === board[b] && v === board[c]) return v; // X/O
  }
  return null;
}

export function isDraw(board: Cell[]) {
  return board.every((c) => c !== null) && !winnerOf(board);
}

/**
 * Apply a player move.
 * - No deadlines here (handled server-side)
 * - If draw: reset board and continue (endless)
 */
export function applyMove(g: Game, index: number) {
  if (g.status !== "PLAYING") return { ok: false, error: "Not playing" };
  if (index < 0 || index > 8) return { ok: false, error: "Bad index" };
  if (g.board[index] !== null) return { ok: false, error: "Occupied" };

  g.board[index] = g.turn;
  g.moves += 1;

  const w = winnerOf(g.board);
  if (w) {
    g.winner = w;
    g.status = "FINISHED";
    g.updatedAt = now();
    return { ok: true, finished: true, winner: w };
  }

  // Endless draw: clear board and keep going
  if (isDraw(g.board)) {
    g.board = emptyBoard();
    g.turn = other(g.turn);
    g.updatedAt = now();
    return { ok: true, drawReset: true };
  }

  g.turn = other(g.turn);
  g.updatedAt = now();
  return { ok: true };
}
