import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";

import { sendAndConfirm } from "./rpc";
import { keypairFromBase58Secret } from "./solana";

const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

const COLLECT_CREATOR_FEE_DISCRIMINATOR = Buffer.from([20, 22, 86, 123, 198, 28, 219, 132]);
const CREATOR_VAULT_SEED = Buffer.from("creator-vault");
const EVENT_AUTHORITY_SEED = Buffer.from("__event_authority");

function getFeePayerKeypair(): Keypair {
  const secret = process.env.ESCROW_FEE_PAYER_SECRET_KEY;
  if (!secret) {
    throw new Error("ESCROW_FEE_PAYER_SECRET_KEY is required for Pump.fun claims");
  }
  return keypairFromBase58Secret(secret);
}

export function getPumpProgramId(): PublicKey {
  return PUMP_PROGRAM_ID;
}

export function getPumpEventAuthorityPda(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([EVENT_AUTHORITY_SEED], PUMP_PROGRAM_ID);
  return pda;
}

export function getCreatorVaultPda(creator: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([CREATOR_VAULT_SEED, creator.toBuffer()], PUMP_PROGRAM_ID);
  return pda;
}

export async function getClaimableCreatorFeeLamports(input: {
  connection: Connection;
  creator: PublicKey;
}): Promise<{ creatorVault: PublicKey; vaultBalanceLamports: number; rentExemptMinLamports: number; claimableLamports: number }> {
  const { connection, creator } = input;
  const creatorVault = getCreatorVaultPda(creator);

  const [vaultBalanceLamports, rentExemptMinLamports] = await Promise.all([
    connection.getBalance(creatorVault),
    connection.getMinimumBalanceForRentExemption(0),
  ]);

  const claimableLamports = Math.max(0, vaultBalanceLamports - rentExemptMinLamports);

  return { creatorVault, vaultBalanceLamports, rentExemptMinLamports, claimableLamports };
}

export function buildCollectCreatorFeeInstruction(input: { creator: PublicKey }): { ix: TransactionInstruction; creatorVault: PublicKey } {
  const creatorVault = getCreatorVaultPda(input.creator);
  const eventAuthority = getPumpEventAuthorityPda();

  const ix = new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys: [
      { pubkey: input.creator, isSigner: false, isWritable: true },
      { pubkey: creatorVault, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: COLLECT_CREATOR_FEE_DISCRIMINATOR,
  });

  return { ix, creatorVault };
}

export async function buildUnsignedClaimCreatorFeesTx(input: {
  connection: Connection;
  creator: PublicKey;
}): Promise<{ tx: Transaction; creatorVault: PublicKey; claimableLamports: number; rentExemptMinLamports: number; vaultBalanceLamports: number }> {
  const { connection, creator } = input;

  const claimable = await getClaimableCreatorFeeLamports({ connection, creator });

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("processed");
  const { ix, creatorVault } = buildCollectCreatorFeeInstruction({ creator });

  const tx = new Transaction();
  tx.feePayer = creator;
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.add(ix);

  return {
    tx,
    creatorVault,
    claimableLamports: claimable.claimableLamports,
    rentExemptMinLamports: claimable.rentExemptMinLamports,
    vaultBalanceLamports: claimable.vaultBalanceLamports,
  };
}

export async function claimCreatorFees(input: {
  connection: Connection;
  creator: PublicKey;
}): Promise<{ signature: string; claimableLamports: number; creatorVault: PublicKey }> {
  const { connection, creator } = input;

  const { creatorVault, claimableLamports } = await getClaimableCreatorFeeLamports({ connection, creator });
  if (claimableLamports <= 0) {
    throw new Error("No claimable creator fees");
  }

  const feePayer = getFeePayerKeypair();
  const eventAuthority = getPumpEventAuthorityPda();

  const ix = new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys: [
      { pubkey: creator, isSigner: false, isWritable: true },
      { pubkey: creatorVault, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: COLLECT_CREATOR_FEE_DISCRIMINATOR,
  });

  const tx = new Transaction();
  tx.feePayer = feePayer.publicKey;
  tx.add(ix);

  const signature = await sendAndConfirm({ connection, tx, signers: [feePayer] });
  return { signature, claimableLamports, creatorVault };
}
