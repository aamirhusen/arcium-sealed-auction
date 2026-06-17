import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { SealedAuction } from "../target/types/sealed_auction";
import { randomBytes } from "crypto";
import {
  awaitComputationFinalization,
  getArciumEnv,
  getCompDefAccOffset,
  getArciumAccountBaseSeed,
  getArciumProgramId,
  getArciumProgram,
  uploadCircuit,
  RescueCipher,
  deserializeLE,
  getMXEPublicKey,
  getMXEAccAddress,
  getMempoolAccAddress,
  getCompDefAccAddress,
  getExecutingPoolAccAddress,
  getComputationAccAddress,
  getClusterAccAddress,
  getLookupTableAddress,
  x25519,
} from "@arcium-hq/client";
import * as fs from "fs";
import * as os from "os";
import { expect } from "chai";

describe("SealedAuction", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.SealedAuction as Program<SealedAuction>;
  const provider = anchor.getProvider();
  const arciumProgram = getArciumProgram(provider as anchor.AnchorProvider);

  type Event = anchor.IdlEvents<(typeof program)["idl"]>;
  const awaitEvent = async <E extends keyof Event>(eventName: E): Promise<Event[E]> => {
    let listenerId: number;
    const event = await new Promise<Event[E]>((res) => {
      listenerId = program.addEventListener(eventName, (event) => res(event));
    });
    await program.removeEventListener(listenerId);
    return event;
  };

  const arciumEnv = getArciumEnv();
  const clusterAccount = getClusterAccAddress(arciumEnv.arciumClusterOffset);

  it("Runs a sealed-bid auction with private bids", async () => {
    const owner = readKpJson(`${os.homedir()}/.config/solana/id.json`);

    // Init computation definition
    console.log("Initializing compare_bids computation definition...");
    await initCompareBidsCompDef(program, owner, arciumProgram, provider);

    // Create auction
    const [auctionPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("auction"), owner.publicKey.toBuffer()],
      program.programId,
    );
    await program.methods
      .createAuction("Rare NFT #001", new anchor.BN(1000))
      .accounts({
        payer: owner.publicKey,
        auction: auctionPDA,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc({ commitment: "confirmed" });
    console.log("Auction created: Rare NFT #001");

    // Setup encryption
    const mxePublicKey = await getMXEPublicKeyWithRetry(
      provider as anchor.AnchorProvider,
      program.programId,
    );
    const privateKey = x25519.utils.randomSecretKey();
    const publicKey = x25519.getPublicKey(privateKey);
    const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);
    const cipher = new RescueCipher(sharedSecret);

    // BID 1: current highest = 0, new bid = 100
    console.log("\nBidder 1 submits SEALED bid of 100...");
    let highest = await submitBid(
      program, owner, auctionPDA, cipher, publicKey,
      BigInt(0), BigInt(100), arciumEnv, clusterAccount, provider, awaitEvent,
    );
    console.log("Highest bid after bid 1:", highest.toString());
    expect(highest).to.equal(BigInt(100));

    // BID 2: current highest = 100, new bid = 250
    console.log("\nBidder 2 submits SEALED bid of 250...");
    highest = await submitBid(
      program, owner, auctionPDA, cipher, publicKey,
      BigInt(100), BigInt(250), arciumEnv, clusterAccount, provider, awaitEvent,
    );
    console.log("Highest bid after bid 2:", highest.toString());
    expect(highest).to.equal(BigInt(250));

    // BID 3: current highest = 250, new bid = 180 (loses, stays hidden)
    console.log("\nBidder 3 submits SEALED bid of 180...");
    highest = await submitBid(
      program, owner, auctionPDA, cipher, publicKey,
      BigInt(250), BigInt(180), arciumEnv, clusterAccount, provider, awaitEvent,
    );
    console.log("Highest bid after bid 3:", highest.toString());
    expect(highest).to.equal(BigInt(250));

    console.log("\n✅ Auction complete! Winning bid: 250");
    console.log("   Losing bids (100, 180) were never revealed on-chain.");
  });

  async function submitBid(
    program: Program<SealedAuction>,
    owner: anchor.web3.Keypair,
    auctionPDA: PublicKey,
    cipher: RescueCipher,
    publicKey: Uint8Array,
    currentHighest: bigint,
    newBid: bigint,
    arciumEnv: any,
    clusterAccount: PublicKey,
    provider: anchor.Provider,
    awaitEvent: any,
  ): Promise<bigint> {
    const nonce = randomBytes(16);
    const ciphertext = cipher.encrypt([currentHighest, newBid], nonce);
    const computationOffset = new anchor.BN(randomBytes(8), "hex");
    const eventPromise = awaitEvent("bidProcessedEvent");

    await program.methods
      .submitBid(
        computationOffset,
        Array.from(ciphertext[0]),
        Array.from(ciphertext[1]),
        Array.from(publicKey),
        new anchor.BN(deserializeLE(nonce).toString()),
      )
      .accountsPartial({
        payer: owner.publicKey,
        auction: auctionPDA,
        auctionAuthority: owner.publicKey,
        computationAccount: getComputationAccAddress(
          arciumEnv.arciumClusterOffset, computationOffset,
        ),
        clusterAccount,
        mxeAccount: getMXEAccAddress(program.programId),
        mempoolAccount: getMempoolAccAddress(arciumEnv.arciumClusterOffset),
        executingPool: getExecutingPoolAccAddress(arciumEnv.arciumClusterOffset),
        compDefAccount: getCompDefAccAddress(
          program.programId,
          Buffer.from(getCompDefAccOffset("compare_bids")).readUInt32LE(),
        ),
      })
      .signers([owner])
      .rpc({ skipPreflight: true, commitment: "confirmed" });

    await awaitComputationFinalization(
      provider as anchor.AnchorProvider,
      computationOffset, program.programId, "confirmed",
    );

    const event = await eventPromise;
    return cipher.decrypt([event.highestBidCiphertext], new Uint8Array(event.nonce))[0];
  }

  async function initCompareBidsCompDef(
    program: Program<SealedAuction>,
    owner: anchor.web3.Keypair,
    arciumProgram: anchor.Program,
    provider: anchor.Provider,
  ): Promise<string> {
    const baseSeedCompDefAcc = getArciumAccountBaseSeed("ComputationDefinitionAccount");
    const offset = getCompDefAccOffset("compare_bids");
    const compDefPDA = PublicKey.findProgramAddressSync(
      [baseSeedCompDefAcc, program.programId.toBuffer(), offset],
      getArciumProgramId(),
    )[0];

    const mxeAccount = getMXEAccAddress(program.programId);
    const mxeAcc = await arciumProgram.account.mxeAccount.fetch(mxeAccount);
    const lutAddress = getLookupTableAddress(program.programId, mxeAcc.lutOffsetSlot);

    const sig = await program.methods
      .initCompareBidsCompDef()
      .accounts({
        compDefAccount: compDefPDA,
        payer: owner.publicKey,
        mxeAccount,
        addressLookupTable: lutAddress,
      })
      .signers([owner])
      .rpc({ commitment: "confirmed" });

    const rawCircuit = fs.readFileSync("build/compare_bids.arcis");
    await uploadCircuit(
      provider as anchor.AnchorProvider,
      "compare_bids", program.programId, rawCircuit, true, 500,
      { skipPreflight: true, preflightCommitment: "confirmed", commitment: "confirmed" },
    );
    return sig;
  }
});

async function getMXEPublicKeyWithRetry(
  provider: anchor.AnchorProvider,
  programId: PublicKey,
  maxRetries = 20,
  retryDelayMs = 500,
): Promise<Uint8Array> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const key = await getMXEPublicKey(provider, programId);
      if (key) return key;
    } catch (e) {}
    if (attempt < maxRetries) await new Promise((r) => setTimeout(r, retryDelayMs));
  }
  throw new Error(`Failed to fetch MXE public key after ${maxRetries} attempts`);
}

function readKpJson(path: string): anchor.web3.Keypair {
  const file = fs.readFileSync(path);
  return anchor.web3.Keypair.fromSecretKey(new Uint8Array(JSON.parse(file.toString())));
}
