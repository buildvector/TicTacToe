// lib/payment.ts
import { Connection, PublicKey } from "@solana/web3.js";

function conn() {
  const rpc = process.env.NEXT_PUBLIC_SOLANA_RPC;
  if (!rpc) throw new Error("Missing NEXT_PUBLIC_SOLANA_RPC");
  return new Connection(rpc, "confirmed");
}

export async function verifyTreasuryTransferOrThrow(args: {
  paymentSig: string;
  fromPubkey: string;
  toPubkey: string;
  lamports: number;
  maxAgeMs?: number;
}) {
  const { paymentSig, fromPubkey, toPubkey, lamports, maxAgeMs = 2 * 60 * 1000 } = args;

  if (!paymentSig) throw new Error("Missing paymentSig");
  if (!fromPubkey) throw new Error("Missing fromPubkey");
  if (!toPubkey) throw new Error("Missing toPubkey");
  if (!Number.isFinite(lamports) || lamports <= 0) throw new Error("Bad lamports");

  const connection = conn();

  const tx = await connection.getTransaction(paymentSig, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });

  if (!tx) throw new Error("Payment tx not found/confirmed yet");
  if (tx.meta?.err) throw new Error("Payment tx failed");

  // recency check
  const bt = tx.blockTime ? tx.blockTime * 1000 : 0;
  if (!bt) throw new Error("Payment tx missing blockTime");
  if (Date.now() - bt > maxAgeMs) throw new Error("Payment tx too old");

  const from = new PublicKey(fromPubkey).toBase58();
  const to = new PublicKey(toPubkey).toBase58();

  // Find account indices
  // getTransaction gives message.accountKeys as PublicKey[] (legacy) or objects for v0 in some cases.
  const keys = (tx.transaction.message as any).accountKeys as any[];

  const keyToBase58 = (k: any) => {
    if (!k) return "";
    if (typeof k === "string") return k;
    if (k?.pubkey) return String(k.pubkey); // sometimes parsed-ish
    if (typeof k.toBase58 === "function") return k.toBase58();
    return String(k);
  };

  const idxFrom = keys.findIndex((k) => keyToBase58(k) === from);
  const idxTo = keys.findIndex((k) => keyToBase58(k) === to);

  if (idxFrom === -1) throw new Error("Payment tx missing from account");
  if (idxTo === -1) throw new Error("Payment tx missing to account");

  const pre = tx.meta?.preBalances ?? [];
  const post = tx.meta?.postBalances ?? [];

  if (!pre[idxFrom] && pre[idxFrom] !== 0) throw new Error("Missing preBalances[from]");
  if (!post[idxFrom] && post[idxFrom] !== 0) throw new Error("Missing postBalances[from]");
  if (!pre[idxTo] && pre[idxTo] !== 0) throw new Error("Missing preBalances[to]");
  if (!post[idxTo] && post[idxTo] !== 0) throw new Error("Missing postBalances[to]");

  const deltaFrom = BigInt(post[idxFrom]) - BigInt(pre[idxFrom]); // negative (spent)
  const deltaTo = BigInt(post[idxTo]) - BigInt(pre[idxTo]); // positive (received)

  // "to" must receive exactly lamports
  if (deltaTo !== BigInt(lamports)) {
    throw new Error("Payment tx does not match required treasury transfer (to delta mismatch)");
  }

  // "from" must have spent at least lamports (it also pays tx fee)
  if (deltaFrom > -BigInt(lamports)) {
    throw new Error("Payment tx does not match required treasury transfer (from delta too small)");
  }

  return true;
}
