"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import toast, { Toaster } from "react-hot-toast";

type Game = any;

const TREASURY = process.env.NEXT_PUBLIC_TREASURY_PUBKEY!;
const FEE_BPS = 300;

const BET_PRESETS_SOL = [0.1, 0.25, 0.5, 1] as const;
const MIN_BET_SOL = 0.1;
const MAX_BET_SOL = 5;

const WalletMultiButton = dynamic(
  async () => (await import("@solana/wallet-adapter-react-ui")).WalletMultiButton,
  { ssr: false }
);

function net(lamports: number) {
  return Math.floor((lamports * (10_000 - FEE_BPS)) / 10_000);
}

async function fetchJson(url: string, init?: RequestInit) {
  const res = await fetch(url, { ...init, cache: "no-store" });
  const text = await res.text();
  let data: any = null;

  if (text && text.trim().length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Non-JSON response (${res.status}): ${text.slice(0, 120)}`);
    }
  }

  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

function sessionKey(pubkey: string, gameId: string) {
  return `ttt_session:${pubkey}:${gameId}`;
}

function short(pk?: string) {
  if (!pk) return "—";
  return `${pk.slice(0, 4)}…${pk.slice(-4)}`;
}

function txUrl(sig: string) {
  return `https://solscan.io/tx/${sig}`;
}

export default function Page() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();

  const [mounted, setMounted] = useState(false);

  const [betSol, setBetSol] = useState<number>(BET_PRESETS_SOL[0]);
  const [custom, setCustom] = useState<string>(String(BET_PRESETS_SOL[0]));

  const [lobby, setLobby] = useState<Game[]>([]);
  const [history, setHistory] = useState<any[]>([]);
  const [gameId, setGameId] = useState<string | null>(null);
  const [game, setGame] = useState<Game | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);

  const [sessionToken, setSessionToken] = useState<string | null>(null);

  // ✅ serverNow ~= Date.now() + serverOffsetMs
  const [serverOffsetMs, setServerOffsetMs] = useState(0);
  const lastServerNowRef = useRef<number>(0);

  useEffect(() => setMounted(true), []);

  const betLamports = useMemo(() => Math.floor(betSol * LAMPORTS_PER_SOL), [betSol]);
  const feeLamports = useMemo(
    () => Math.max(1, Math.floor((betLamports * FEE_BPS) / 10_000)),
    [betLamports]
  );
  const potLamports = useMemo(
    () => Math.max(0, betLamports - feeLamports),
    [betLamports, feeLamports]
  );

  const parsedCustom = useMemo(() => {
    const n = Number(String(custom).replace(",", "."));
    if (!Number.isFinite(n)) return null;
    return n;
  }, [custom]);

  const customError = useMemo(() => {
    if (custom.trim().length === 0) return null;
    if (parsedCustom === null) return "Invalid number";
    if (parsedCustom < MIN_BET_SOL) return `Min ${MIN_BET_SOL} SOL`;
    if (parsedCustom > MAX_BET_SOL) return `Max ${MAX_BET_SOL} SOL (MVP)`;
    return null;
  }, [custom, parsedCustom]);

  const applyCustom = () => {
    if (parsedCustom === null) return;
    if (parsedCustom < MIN_BET_SOL || parsedCustom > MAX_BET_SOL) return;
    const v = Number(parsedCustom.toFixed(4));
    setBetSol(v);
    setCustom(String(v));
  };

  const serverNow = () => Date.now() + serverOffsetMs;

  function updateServerOffsetFrom(serverNowMs?: any) {
    const sn = Number(serverNowMs);
    if (!Number.isFinite(sn) || sn <= 0) return;

    // avoid jitter
    if (sn !== lastServerNowRef.current) {
      lastServerNowRef.current = sn;
      setServerOffsetMs(sn - Date.now());
    }
  }

  const refreshLobby = async () => {
    const j = await fetchJson("/api/game/list");
    setLobby(j.games ?? []);
  };

  const refreshHistory = async () => {
    const hj = await fetchJson("/api/game/history");
    setHistory(hj.history ?? []);
  };

  useEffect(() => {
    let alive = true;

    (async () => {
      try {
        await refreshLobby();
        await refreshHistory();
      } catch {}
    })();

    const t = setInterval(async () => {
      if (!alive) return;
      try {
        await refreshLobby();
        await refreshHistory();
      } catch {}
    }, 1500);

    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // poll current game (also sync server clock from API)
  useEffect(() => {
    if (!gameId) return;
    const t = setInterval(async () => {
      try {
        const j = await fetchJson(`/api/game/get?gameId=${encodeURIComponent(gameId)}`);
        updateServerOffsetFrom(j.serverNow);
        setGame(j.game);
      } catch {}
    }, 900);
    return () => clearInterval(t);
  }, [gameId]);

  // ✅ countdown uses serverNow()
  useEffect(() => {
    if (!game || game.status !== "PLAYING" || !game.deadlineAt) {
      setSecondsLeft(0);
      return;
    }

    const tick = () => {
      const remainingMs = Number(game.deadlineAt) - serverNow();
      const remaining = Math.max(0, Math.ceil(remainingMs / 1000));
      setSecondsLeft(remaining);
    };

    tick();
    const interval = setInterval(tick, 200);
    return () => clearInterval(interval);
  }, [game?.deadlineAt, game?.status, game?.updatedAt, serverOffsetMs]);

  // restore session token
  useEffect(() => {
    if (!publicKey || !gameId) return;
    const key = sessionKey(publicKey.toBase58(), gameId);
    const t = localStorage.getItem(key);
    if (t) setSessionToken(t);
  }, [publicKey, gameId]);

  async function payToTreasury(lamports: number) {
    if (!publicKey) throw new Error("Connect wallet");

    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: publicKey,
        toPubkey: new PublicKey(TREASURY),
        lamports,
      })
    );

    const sig = await sendTransaction(tx, connection);
    await connection.confirmTransaction(sig, "confirmed");
    return sig;
  }

  async function createGame() {
    try {
      if (!publicKey) return toast.error("Connect wallet first");

      const bet = Number(betSol);
      if (!bet || bet <= 0) return toast.error("Bad bet");

      const lamports = Math.floor(bet * LAMPORTS_PER_SOL);

      toast.loading("Paying bet to treasury...");
      const paymentSig = await payToTreasury(lamports);
      toast.dismiss();

      const j = await fetchJson("/api/game/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          creatorPubkey: publicKey.toBase58(),
          betLamports: lamports,
          paymentSig,
        }),
      });

      setGameId(j.gameId);
      setSessionToken(j.sessionToken);
      localStorage.setItem(sessionKey(publicKey.toBase58(), j.gameId), j.sessionToken);

      toast.success("Game created");
    } catch (e: any) {
      toast.dismiss();
      toast.error(e?.message ?? "Error");
    }
  }

  async function cancelGame(id: string) {
    try {
      if (!publicKey) return toast.error("Connect wallet first");

      const tok = sessionToken || localStorage.getItem(sessionKey(publicKey.toBase58(), id));
      if (!tok) return toast.error("Missing session (refresh → re-create/join)");

      toast.loading("Refunding 97%...");
      await fetchJson("/api/game/leave", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId: id, sessionToken: tok }),
      });

      toast.dismiss();
      toast.success("Canceled + refunded");
      setGameId(null);
      setGame(null);
      setSessionToken(null);
    } catch (e: any) {
      toast.dismiss();
      toast.error(e?.message ?? "Error");
    }
  }

  async function joinGame(id: string, betLamports: number) {
    try {
      if (!publicKey) return toast.error("Connect wallet first");

      toast.loading("Paying bet to treasury...");
      const paymentSig = await payToTreasury(Number(betLamports));
      toast.dismiss();

      const j = await fetchJson("/api/game/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gameId: id,
          joinerPubkey: publicKey.toBase58(),
          paymentSig,
        }),
      });

      // If join route also returns serverNow in future, we’ll use it (safe)
      updateServerOffsetFrom(j.serverNow);

      setGameId(id);
      setGame(j.game);

      setSessionToken(j.sessionToken);
      localStorage.setItem(sessionKey(publicKey.toBase58(), id), j.sessionToken);

      toast.success("Joined game");
    } catch (e: any) {
      toast.dismiss();
      toast.error(e?.message ?? "Error");
    }
  }

  async function move(i: number) {
    try {
      if (!publicKey || !gameId) return;

      const tok = sessionToken || localStorage.getItem(sessionKey(publicKey.toBase58(), gameId));
      if (!tok) return toast.error("Missing session (refresh → re-join)");

      const j = await fetchJson("/api/game/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId, index: i, sessionToken: tok }),
      });

      updateServerOffsetFrom(j.serverNow);
      setGame(j.game);

      if (j.game?.status === "FINISHED" && j.game?.winnerPubkey) {
        const win = j.game.winnerPubkey === publicKey.toBase58();
        toast.success(win ? "You Win 🏆" : "You Lose 😭");
      }
    } catch (e: any) {
      toast.error(e?.message ?? "Move error");
    }
  }

  const me = publicKey?.toBase58();
  const inGame = !!gameId;

  const myMark = useMemo(() => {
    if (!game || !me) return null;
    if (game.xPlayer === me) return "X";
    if (game.oPlayer === me) return "O";
    return null;
  }, [game, me]);

  const myTurn = useMemo(() => {
    if (!game || !me || game.status !== "PLAYING") return false;
    const current = game.turn === "X" ? game.xPlayer : game.oPlayer;
    return current === me;
  }, [game, me]);

  const cellSize = "clamp(72px, 22vw, 110px)";

  return (
    <main className="bg-casino">
      <Toaster />

      <div className="casino-wrap ttt-container">
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
          <div style={{ display: "grid", gap: 6, maxWidth: 640 }}>
            <div style={{ fontSize: 30, fontWeight: 700, letterSpacing: -0.2 }}>Tic Tac Toe</div>
            <div className="ttt-dim" style={{ fontSize: 13 }}>
              Premium P2P tic-tac-toe. Both players deposit to the same pot. Winner paid out server-side.
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <span className="ttt-item" style={{ padding: "6px 10px", borderRadius: 999, fontSize: 12 }}>3% fee / deposit</span>
              <span className="ttt-item" style={{ padding: "6px 10px", borderRadius: 999, fontSize: 12 }}>Refund 97%</span>
              <span className="ttt-item" style={{ padding: "6px 10px", borderRadius: 999, fontSize: 12 }}>No house edge</span>
            </div>
          </div>

          <div>{mounted ? <WalletMultiButton /> : <div style={{ width: 170, height: 40 }} />}</div>
        </div>

        {!inGame && (
          <div className="ttt-mt26 ttt-grid2">
            {/* LEFT column */}
            <div style={{ display: "grid", gap: 18 }}>
              {/* Create card */}
              <section className="glass glass-rim glass-noise" style={{ borderRadius: 24, padding: 20 }}>
                <div className="ttt-row">
                  <div>
                    <div style={{ fontSize: 16, fontWeight: 700 }}>Create game</div>
                    <div className="ttt-dim" style={{ fontSize: 12, marginTop: 4 }}>
                      Deposit goes to the pot. <span style={{ color: "rgba(255,255,255,.85)" }}>3%</span> fee is taken instantly.
                    </div>
                  </div>
                  <div className="ttt-dim" style={{ fontSize: 12 }}>min {MIN_BET_SOL} SOL</div>
                </div>

                {/* Bet buttons */}
                <div className="ttt-mt18" style={{ display: "grid", gap: 10 }}>
                  <div style={{ fontSize: 11, letterSpacing: 1.2, opacity: 0.7 }}>BET SIZE</div>

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
                    {BET_PRESETS_SOL.map((x) => {
                      const active = betSol === x;
                      return (
                        <button
                          key={x}
                          onClick={() => {
                            setBetSol(x);
                            setCustom(String(x));
                          }}
                          className="ring-violet-hover"
                          style={{
                            borderRadius: 16,
                            border: active ? "1px solid rgba(255,255,255,0.18)" : "1px solid rgba(255,255,255,0.10)",
                            background: active ? "rgba(255,255,255,0.92)" : "rgba(255,255,255,0.06)",
                            color: active ? "#0a0a0a" : "rgba(255,255,255,0.92)",
                            padding: "12px 12px",
                            textAlign: "left",
                            boxShadow: active ? "0 16px 50px rgba(0,0,0,0.45)" : undefined,
                            cursor: "pointer",
                          }}
                        >
                          <div style={{ fontSize: 13, fontWeight: 800 }}>{x} SOL</div>
                          <div style={{ fontSize: 12, opacity: active ? 0.75 : 0.6 }}>{active ? "Selected" : "Click to select"}</div>
                        </button>
                      );
                    })}
                  </div>

                  {/* Custom bet */}
                  <div className="ttt-mt12" style={{ display: "grid", gap: 8 }}>
                    <div style={{ fontSize: 11, letterSpacing: 1.2, opacity: 0.7 }}>CUSTOM BET (SOL)</div>

                    <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                      <input
                        value={custom}
                        onChange={(e) => setCustom(e.target.value)}
                        placeholder={`e.g. ${MIN_BET_SOL}`}
                        className="input-premium"
                        style={{ flex: 1, borderRadius: 14, padding: "12px 14px", outline: "none", color: "rgba(255,255,255,.92)" }}
                      />

                      <button
                        onClick={applyCustom}
                        disabled={!!customError || parsedCustom === null}
                        className="btn-premium ring-violet-hover"
                        style={{
                          borderRadius: 14,
                          padding: "12px 16px",
                          fontWeight: 900,
                          color: "rgba(255,255,255,0.92)",
                          opacity: !!customError || parsedCustom === null ? 0.55 : 1,
                          cursor: !!customError || parsedCustom === null ? "not-allowed" : "pointer",
                        }}
                      >
                        Apply
                      </button>
                    </div>

                    {customError ? <div style={{ fontSize: 12, color: "rgba(252,165,165,0.95)" }}>{customError}</div> : null}

                    <div className="ttt-dim" style={{ fontSize: 12 }}>
                      MVP limits: {MIN_BET_SOL} – {MAX_BET_SOL} SOL.
                    </div>
                  </div>
                </div>

                {/* Breakdown */}
                <div className="ttt-mt18 ttt-item ttt-itemPad" style={{ alignItems: "stretch", gap: 14, flexDirection: "column" }}>
                  <div className="ttt-row">
                    <div className="ttt-dim" style={{ fontSize: 12 }}>Fee (3%)</div>
                    <div className="mono" style={{ fontWeight: 800, fontSize: 12 }}>{(feeLamports / 1e9).toFixed(6)} SOL</div>
                  </div>

                  <div className="ttt-row">
                    <div className="ttt-dim" style={{ fontSize: 12 }}>Pot (after fee)</div>
                    <div className="mono" style={{ fontWeight: 800, fontSize: 12 }}>{(potLamports / 1e9).toFixed(6)} SOL</div>
                  </div>

                  <div style={{ height: 1, background: "rgba(255,255,255,0.10)" }} />

                  <div className="ttt-row">
                    <div className="ttt-dim" style={{ fontSize: 12 }}>Potential payout</div>
                    <div className="mono" style={{ fontWeight: 900, fontSize: 12 }}>{((potLamports * 2) / 1e9).toFixed(6)} SOL</div>
                  </div>

                  <div className="ttt-dim" style={{ fontSize: 12 }}>Winner receives both pots (2×). No house edge.</div>
                </div>

                {/* CTA */}
                <div className="ttt-mt18" style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
                  <button
                    onClick={createGame}
                    className="ring-violet-hover"
                    style={{
                      borderRadius: 16,
                      padding: "12px 18px",
                      minWidth: 190,
                      fontWeight: 900,
                      border: "1px solid rgba(255,255,255,0.18)",
                      background: "rgba(255,255,255,0.92)",
                      color: "#0a0a0a",
                      boxShadow: "0 18px 60px rgba(0,0,0,0.55)",
                      cursor: "pointer",
                    }}
                  >
                    Create & deposit
                  </button>

                  <div className="ttt-dim" style={{ fontSize: 12 }}>You will sign a transfer in Phantom.</div>
                </div>
              </section>

              {/* History */}
              <section className="glass glass-rim glass-noise" style={{ borderRadius: 24, padding: 20 }}>
                <div className="ttt-row">
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 800 }}>Last 10 games</div>
                    <div className="ttt-dim" style={{ fontSize: 12, marginTop: 4 }}>Global recent payouts</div>
                  </div>

                  <button
                    onClick={async () => {
                      try {
                        await refreshHistory();
                        toast.success("History refreshed");
                      } catch {
                        toast.error("History refresh failed");
                      }
                    }}
                    className="btn-premium ring-violet-hover"
                    style={{ borderRadius: 14, padding: "10px 14px", fontWeight: 900, color: "rgba(255,255,255,0.92)", cursor: "pointer" }}
                  >
                    Refresh
                  </button>
                </div>

                <div className="ttt-mt12" style={{ display: "grid", gap: 10 }}>
                  {history.length === 0 && <div className="ttt-dim" style={{ fontSize: 13 }}>No games yet…</div>}

                  {history.map((h, i) => (
                    <div key={i} className="ttt-item">
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 800 }}>{h.gameId}</div>
                        <div className="ttt-dim" style={{ fontSize: 12, marginTop: 2 }}>
                          winner{" "}
                          <span className="mono" style={{ color: "rgba(255,255,255,.9)" }}>{short(String(h.winner))}</span> · bet{" "}
                          {(Number(h.betLamports) / 1e9).toFixed(4)} SOL
                        </div>
                        <div className="ttt-dim" style={{ fontSize: 12 }}>sig {String(h.payoutSig).slice(0, 10)}…</div>
                      </div>

                      <div style={{ flexShrink: 0 }}>
                        {h.payoutSig ? (
                          <a
                            href={txUrl(String(h.payoutSig))}
                            target="_blank"
                            rel="noreferrer"
                            className="btn-premium ring-violet-hover"
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              justifyContent: "center",
                              borderRadius: 12,
                              padding: "10px 12px",
                              fontWeight: 900,
                              color: "rgba(255,255,255,0.92)",
                              cursor: "pointer",
                            }}
                          >
                            View tx
                          </a>
                        ) : (
                          <span className="ttt-dim" style={{ fontSize: 12 }}>—</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            </div>

            {/* Open games */}
            <section className="glass glass-rim glass-noise" style={{ borderRadius: 24, padding: 20 }}>
              <div className="ttt-row">
                <div>
                  <div style={{ fontSize: 14, fontWeight: 800 }}>Open games</div>
                  <div className="ttt-dim" style={{ fontSize: 12, marginTop: 4 }}>Join an open game. Deposit goes to the pot.</div>
                </div>

                <button
                  onClick={async () => {
                    try {
                      await refreshLobby();
                      toast.success("Refreshed");
                    } catch {
                      toast.error("Refresh failed");
                    }
                  }}
                  className="btn-premium ring-violet-hover"
                  style={{ borderRadius: 14, padding: "10px 14px", fontWeight: 900, color: "rgba(255,255,255,0.92)", cursor: "pointer" }}
                >
                  Refresh
                </button>
              </div>

              <div className="ttt-mt12 ttt-dim" style={{ fontSize: 12 }}>{lobby.length} open</div>

              <div className="ttt-mt12" style={{ display: "grid", gap: 10 }}>
                {lobby.length === 0 && <div className="ttt-dim" style={{ fontSize: 13 }}>No open games.</div>}

                {lobby.map((g) => (
                  <div key={g.id} className="ttt-item">
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 900 }}>{(g.betLamports / 1e9).toFixed(4)} SOL</div>
                      <div className="ttt-dim" style={{ fontSize: 12, marginTop: 2 }}>
                        Pot if joined: {((net(g.betLamports) * 2) / 1e9).toFixed(4)} SOL
                      </div>
                      <div className="ttt-dim" style={{ fontSize: 12 }}>
                        Game <span className="mono">{g.id}</span>
                      </div>
                    </div>

                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <button
                        onClick={() => joinGame(g.id, g.betLamports)}
                        className="ring-violet-hover"
                        style={{
                          borderRadius: 14,
                          padding: "10px 14px",
                          minWidth: 120,
                          fontWeight: 900,
                          border: "1px solid rgba(255,255,255,0.18)",
                          background: "rgba(255,255,255,0.92)",
                          color: "#0a0a0a",
                          boxShadow: "0 16px 50px rgba(0,0,0,0.45)",
                          cursor: "pointer",
                        }}
                      >
                        Join
                      </button>

                      {me && g.createdBy === me && (
                        <button
                          onClick={() => cancelGame(g.id)}
                          className="btn-premium ring-violet-hover"
                          style={{ borderRadius: 14, padding: "10px 12px", fontWeight: 900, color: "rgba(255,255,255,0.92)", cursor: "pointer" }}
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}

        {/* In-game */}
        {inGame && (
          <section className="glass glass-rim glass-noise ttt-mt26" style={{ borderRadius: 24, padding: 16 }}>
            <div className="ttt-row" style={{ flexWrap: "wrap" }}>
              <div style={{ display: "grid", gap: 6 }}>
                <div>
                  <span className="ttt-dim" style={{ fontSize: 12 }}>Game</span>{" "}
                  <span className="mono" style={{ fontWeight: 900 }}>{gameId}</span>
                </div>

                <div className="ttt-dim" style={{ fontSize: 12 }}>
                  You are: <b style={{ color: "rgba(255,255,255,.92)" }}>{myMark ?? "spectator"}</b> · Turn:{" "}
                  <b style={{ color: "rgba(255,255,255,.92)" }}>{game?.turn ?? "-"}</b> · Your turn:{" "}
                  <b style={{ color: "rgba(255,255,255,.92)" }}>{myTurn ? "YES" : "NO"}</b>
                </div>

                <div className="ttt-dim" style={{ fontSize: 12 }}>
                  Time left: <b style={{ color: "rgba(255,255,255,.92)" }}>{secondsLeft}s</b> (auto move at 0)
                </div>

                <div className="ttt-dim" style={{ fontSize: 12 }}>
                  Pot:{" "}
                  <b style={{ color: "rgba(255,255,255,.92)" }}>
                    {((game?.potLamports ?? 0) / 1e9).toFixed(4)} SOL
                  </b>
                </div>
              </div>

              <button
                onClick={() => {
                  setGameId(null);
                  setGame(null);
                  setSessionToken(null);
                }}
                className="btn-premium ring-violet-hover"
                style={{ borderRadius: 14, padding: "10px 14px", fontWeight: 900, color: "rgba(255,255,255,0.92)", cursor: "pointer" }}
              >
                Back to lobby
              </button>
            </div>

            <div
              style={{
                marginTop: 12,
                display: "grid",
                gridTemplateColumns: `repeat(3, ${cellSize})`,
                gap: 10,
                justifyContent: "center",
                alignItems: "center",
              }}
            >
              {(game?.board ?? Array(9).fill(null)).map((c: any, i: number) => (
                <button
                  key={i}
                  onClick={() => move(i)}
                  disabled={!myTurn || game?.status !== "PLAYING"}
                  className="ttt-cell"
                  style={{ width: cellSize, height: cellSize, fontSize: "clamp(28px, 7.5vw, 44px)", borderRadius: 18 }}
                >
                  {c ?? ""}
                </button>
              ))}
            </div>

            {game?.status === "FINISHED" && (
              <div className="ttt-mt18 ttt-item">
                <b>{game?.winnerPubkey === me ? "You Win 🏆" : "You Lose 😭"}</b>
                <div className="ttt-dim" style={{ fontSize: 12 }}>Click “Back to lobby”.</div>
              </div>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
