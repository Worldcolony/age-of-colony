#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */

// Read-only TxLINE score validation bridge.
// IDL and validation shape follow the official Apache-2.0 txodds/tx-on-chain examples.
const anchor = require("@coral-xyz/anchor");
const BN = require("bn.js");
const txoracleIdl = require("./txoracle-mainnet.json");

const DEFAULT_MAINNET_RPC = "https://api.mainnet-beta.solana.com";
// An existing system-owned account is needed as the fee payer for simulation.
// sigVerify remains disabled and no transaction is sent, so this account cannot be charged.
const DEFAULT_SIMULATION_PAYER = "CzYQ2kFnBxsNEt9Zy34vQ3n5fSDhvA4o4XaTnq1rLvyr";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function mapProof(nodes, label) {
  if (!Array.isArray(nodes)) throw new Error(`${label} must be an array`);
  return nodes.map((node, index) => {
    const hash = Array.from(node?.hash || []);
    if (hash.length !== 32) throw new Error(`${label}[${index}].hash must contain 32 bytes`);
    return { hash, isRightSibling: Boolean(node?.isRightSibling) };
  });
}

function assertProofShape(proof) {
  if (!proof || typeof proof !== "object") throw new Error("proof is required");
  if (!proof.summary || !proof.summary.updateStats) throw new Error("proof.summary.updateStats is required");
  if (!Array.isArray(proof.statsToProve) || proof.statsToProve.length === 0) {
    throw new Error("proof.statsToProve must contain at least one statistic");
  }
  if (!Array.isArray(proof.statProofs) || proof.statProofs.length !== proof.statsToProve.length) {
    throw new Error("proof.statProofs must match proof.statsToProve");
  }
}

async function main() {
  const input = JSON.parse(await readStdin());
  if ((input.network || "mainnet") !== "mainnet") {
    throw new Error("The current validator supports TxLINE mainnet proofs only");
  }

  const proof = input.proof;
  assertProofShape(proof);

  const connection = new anchor.web3.Connection(
    process.env.TXLINE_SOLANA_RPC_URL || process.env.SOLANA_RPC_URL || DEFAULT_MAINNET_RPC,
    "confirmed",
  );
  const simulationPayer = new anchor.web3.PublicKey(
    process.env.TXLINE_SOLANA_SIMULATION_PAYER || DEFAULT_SIMULATION_PAYER,
  );
  const wallet = {
    publicKey: simulationPayer,
    signTransaction: async (transaction) => transaction,
    signAllTransactions: async (transactions) => transactions,
  };
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const program = new anchor.Program(txoracleIdl, provider);

  const targetTs = proof.summary.updateStats.minTimestamp;
  const epochDay = Math.floor(targetTs / 86_400_000);
  const [dailyScoresPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("daily_scores_roots"), new BN(epochDay).toBuffer("le", 2)],
    program.programId,
  );

  const payload = {
    ts: new BN(targetTs),
    fixtureSummary: {
      fixtureId: new BN(proof.summary.fixtureId),
      updateStats: {
        updateCount: proof.summary.updateStats.updateCount,
        minTimestamp: new BN(proof.summary.updateStats.minTimestamp),
        maxTimestamp: new BN(proof.summary.updateStats.maxTimestamp),
      },
      eventsSubTreeRoot: Array.from(proof.summary.eventStatsSubTreeRoot),
    },
    fixtureProof: mapProof(proof.subTreeProof, "subTreeProof"),
    mainTreeProof: mapProof(proof.mainTreeProof, "mainTreeProof"),
    eventStatRoot: Array.from(proof.eventStatRoot),
    stats: proof.statsToProve.map((stat, index) => ({
      stat,
      statProof: mapProof(proof.statProofs[index], `statProofs[${index}]`),
    })),
  };

  // Every proven stat is compared with its exact committed value. This verifies both
  // Merkle inclusion and the final score values returned by TxLINE.
  const strategy = {
    geometricTargets: [],
    distancePredicate: null,
    discretePredicates: proof.statsToProve.map((stat, index) => ({
      single: {
        index,
        predicate: { threshold: stat.value, comparison: { equalTo: {} } },
      },
    })),
  };

  const rootAccount = await connection.getAccountInfo(dailyScoresPda, "confirmed");
  if (!rootAccount) throw new Error(`Daily score root account ${dailyScoresPda.toBase58()} was not found`);

  const verified = await program.methods
    .validateStatV2(payload, strategy)
    .accounts({ dailyScoresMerkleRoots: dailyScoresPda })
    .preInstructions([
      anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ])
    .view();

  process.stdout.write(JSON.stringify({
    verified: Boolean(verified),
    network: "mainnet",
    programId: program.programId.toBase58(),
    dailyScoresPda: dailyScoresPda.toBase58(),
    rootAccountExists: true,
    rootAccountOwner: rootAccount.owner.toBase58(),
    epochDay,
    stats: proof.statsToProve,
  }));
}

main().catch((error) => {
  const simulation = error?.simulationResponse;
  process.stderr.write(JSON.stringify({
    error: error?.message || error?.name || String(error),
    simulationError: simulation?.err || null,
    logs: simulation?.logs || [],
  }));
  process.exit(1);
});
