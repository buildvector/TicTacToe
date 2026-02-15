// lib/sol.ts
import {
    Connection,
    Keypair,
    PublicKey,
    SystemProgram,
    Transaction,
  } from "@solana/web3.js";
  import bs58 from "bs58";
  
  export function solConn() {
    return new Connection(process.env.NEXT_PUBLIC_SOLANA_RPC!, "confirmed");
  }
  
  function parseSecretKey(input: string): Uint8Array {
    const raw = input.trim();
  
    // Case A: JSON array string: "[1,2,3,...]"
    if (raw.startsWith("[") && raw.endsWith("]")) {
      let arr: unknown;
      try {
        arr = JSON.parse(raw);
      } catch {
        throw new Error("TREASURY_SECRET_KEY_BASE58 looks like JSON but failed to parse");
      }
      if (!Array.isArray(arr)) throw new Error("Secret key JSON is not an array");
      if (arr.length < 32) throw new Error("Secret key JSON array too short");
  
      const nums = arr.map((n) => {
        if (typeof n !== "number" || !Number.isFinite(n)) {
          throw new Error("Secret key JSON array contains non-numbers");
        }
        return n;
      });
  
      return Uint8Array.from(nums);
    }
  
    // Case B: base58 string
    // Strip wrapping quotes if user pasted with quotes
    const cleaned = raw.replace(/^"+|"+$/g, "");
    try {
      return bs58.decode(cleaned);
    } catch {
      throw new Error("TREASURY_SECRET_KEY_BASE58 is not valid base58 (and not JSON array)");
    }
  }
  
  export function treasuryKeypair() {
    const s = process.env.TREASURY_SECRET_KEY_BASE58;
    if (!s) throw new Error("Missing TREASURY_SECRET_KEY_BASE58");
  
    const secretBytes = parseSecretKey(s);
    return Keypair.fromSecretKey(secretBytes);
  }
  
  export function treasuryPubkey() {
    const pk = process.env.NEXT_PUBLIC_TREASURY_PUBKEY;
    if (!pk) throw new Error("Missing NEXT_PUBLIC_TREASURY_PUBKEY");
    return new PublicKey(pk);
  }
  
  export function feeBps() {
    return Number(process.env.FEE_BPS ?? "300");
  }
  
  export function netAfterFee(lamports: number) {
    const bps = feeBps();
    return Math.floor((lamports * (10_000 - bps)) / 10_000);
  }
  
  export function buildPayToTreasuryTx(payer: PublicKey, lamports: number) {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer,
        toPubkey: treasuryPubkey(),
        lamports,
      })
    );
    tx.feePayer = payer;
    return tx;
  }
  
  export async function payoutFromTreasury(to: PublicKey, lamports: number) {
    const connection = solConn();
    const treasury = treasuryKeypair();
  
    const bal = await connection.getBalance(treasury.publicKey, "confirmed");
    // buffer for fees
    const buffer = 10_000; // 0.00001 SOL
    if (bal < lamports + buffer) {
      throw new Error(
        `Treasury insufficient funds. Balance=${bal} lamports, need=${lamports + buffer}`
      );
    }
  
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: treasury.publicKey,
        toPubkey: to,
        lamports,
      })
    );
  
    tx.feePayer = treasury.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  
    tx.sign(treasury);
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await connection.confirmTransaction(sig, "confirmed");
    return sig;
  }
  
  