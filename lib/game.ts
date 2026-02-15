export type Cell = "X" | "O" | null;

export type GameStatus = "LOBBY" | "PLAYING" | "FINISHED";

export type Game = {
  id: string;
  betLamports: number;

  createdBy: string;   // pubkey base58
  joinedBy?: string;   // pubkey base58

  potLamports: number; // sum of net deposits (97%+97%)
  status: GameStatus;

  board: Cell[];       // 9
  turn: "X" | "O";     // whose turn to place
  xPlayer?: string;    // pubkey
  oPlayer?: string;    // pubkey

  createdAt: number;
  updatedAt: number;

  deadlineAt?: number; // move deadline ms epoch
  seed?: string;       // random seed for deterministic auto-move
  moves: number;

  winner?: "X" | "O";
  winnerPubkey?: string;
  endedReason?: "WIN" | "LEAVE";
};

const LINES = [
  [0,1,2],[3,4,5],[6,7,8],
  [0,3,6],[1,4,7],[2,5,8],
  [0,4,8],[2,4,6],
] as const;

export function now() { return Date.now(); }

export function emptyBoard(): Cell[] { return Array(9).fill(null); }

export function winnerOf(board: Cell[]) {
  for (const [a,b,c] of LINES) {
    const v = board[a];
    if (v && v === board[b] && v === board[c]) return v; // X/O
  }
  return null;
}

export function isDraw(board: Cell[]) {
  return board.every(c => c !== null) && !winnerOf(board);
}

export function startTimers(g: Game, ms = 20_000) {
  g.deadlineAt = now() + ms;
}

export function other(turn: "X"|"O") { return turn === "X" ? "O" : "X"; }

// deterministic “random” auto choice (simple hash)
function hashToIndex(seed: string) {
  let h = 2166136261;
  for (let i=0;i<seed.length;i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

export function autoMoveIndex(g: Game) {
  const empties = g.board.map((c,i)=>c===null?i:-1).filter(i=>i>=0);
  if (!empties.length) return -1;
  const idx = hashToIndex(`${g.seed}|${g.moves}|${g.turn}`) % empties.length;
  return empties[idx];
}

export function applyMove(g: Game, index: number) {
  if (g.status !== "PLAYING") return { ok:false, error:"Not playing" };
  if (index < 0 || index > 8) return { ok:false, error:"Bad index" };
  if (g.board[index] !== null) return { ok:false, error:"Occupied" };

  g.board[index] = g.turn;
  g.moves += 1;

  const w = winnerOf(g.board);
  if (w) {
    g.winner = w;
    g.status = "FINISHED";
    return { ok:true, finished:true, winner:w };
  }

  // draw => clear board and continue with SAME turn order (next turn already flips)
  if (isDraw(g.board)) {
    g.board = emptyBoard();
    // keep continuing: flip turn for “same order continuing”
    g.turn = other(g.turn);
    startTimers(g);
    g.updatedAt = now();
    return { ok:true, drawReset:true };
  }

  g.turn = other(g.turn);
  startTimers(g);
  g.updatedAt = now();
  return { ok:true };
}
