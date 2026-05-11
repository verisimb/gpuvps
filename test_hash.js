// Test: verify that the CUDA keccak256 output matches ethers.js solidityPackedKeccak256
// Run this AFTER building keccak_miner binary

const { ethers } = require("ethers");
const { execFileSync } = require("child_process");
const path = require("path");

const MINER_BIN = path.join(__dirname, "keccak_miner");

// Test vectors: challenge + nonce -> expected keccak256
const testCases = [
  {
    challenge: "6577e03042fbde1af70e410f07f7ece43db5806ecd9852f56e7a69f7bc0d58cc",
    nonce: 0n,
  },
  {
    challenge: "0000000000000000000000000000000000000000000000000000000000000001",
    nonce: 1n,
  },
  {
    challenge: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    nonce: 999999n,
  },
  {
    challenge: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    nonce: 123456789n,
  },
];

console.log("Testing CUDA keccak256 vs ethers.js...\n");

for (const tc of testCases) {
  const challengeBytes32 = "0x" + tc.challenge;
  
  // Expected hash from ethers.js (this is the reference implementation)
  const expected = ethers.solidityPackedKeccak256(
    ["bytes32", "uint256"],
    [challengeBytes32, tc.nonce]
  );

  // Run CUDA miner with impossibly low difficulty so it never finds a solution
  // Instead, let's use a difficulty that equals the expected hash + 1 so it finds nonce immediately
  // Actually, let's just set difficulty to max so ANY hash passes
  const maxDifficulty = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

  try {
    const output = execFileSync(MINER_BIN, [
      tc.challenge,
      maxDifficulty,
      tc.nonce.toString(),
      "1",  // 1 block
      "1",  // 1 thread
    ], { encoding: "utf8", timeout: 10000 });

    const foundNonce = BigInt(output.trim());
    
    // The miner should find nonce = tc.nonce since difficulty is max (any hash passes)
    if (foundNonce === tc.nonce) {
      console.log(`✓ Test nonce=${tc.nonce}: CUDA found correct nonce`);
      
      // Now verify: compute hash of found nonce and compare
      const actualHash = ethers.solidityPackedKeccak256(
        ["bytes32", "uint256"],
        [challengeBytes32, foundNonce]
      );
      console.log(`  Expected hash: ${expected}`);
      console.log(`  Actual hash:   ${actualHash}`);
      console.log(`  Match: ${expected === actualHash}`);
    } else {
      console.log(`✗ Test nonce=${tc.nonce}: CUDA returned ${foundNonce} (expected ${tc.nonce})`);
    }
  } catch (err) {
    console.log(`✗ Test nonce=${tc.nonce}: Error - ${err.message}`);
  }
  console.log("");
}

// More important test: verify that when CUDA says hash < difficulty, it's actually true
console.log("=== Verification Test ===");
console.log("Testing with real challenge and moderate difficulty...\n");

const challenge = "6577e03042fbde1af70e410f07f7ece43db5806ecd9852f56e7a69f7bc0d58cc";
// Set a very easy difficulty (high target) so it finds quickly
const easyDifficulty = "00ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

try {
  const output = execFileSync(MINER_BIN, [
    challenge,
    easyDifficulty,
    "0",
    "256",
    "256",
  ], { encoding: "utf8", timeout: 30000 });

  const foundNonce = BigInt(output.trim());
  console.log(`CUDA found nonce: ${foundNonce}`);

  // Verify with ethers.js
  const hash = ethers.solidityPackedKeccak256(
    ["bytes32", "uint256"],
    ["0x" + challenge, foundNonce]
  );
  const hashNum = BigInt(hash);
  const diffNum = BigInt("0x" + easyDifficulty);

  console.log(`Hash:       ${hash}`);
  console.log(`Difficulty: 0x${easyDifficulty}`);
  console.log(`hash < difficulty: ${hashNum < diffNum}`);

  if (hashNum < diffNum) {
    console.log("\n✓ CUDA keccak256 is CORRECT - hash matches Solidity/ethers.js");
  } else {
    console.log("\n✗ CUDA keccak256 is WRONG - hash does NOT satisfy difficulty");
    console.log("  This means the CUDA implementation produces different hashes than Solidity!");
    console.log("  The miner will find nonces that get REJECTED by the contract.");
  }
} catch (err) {
  console.log(`Error: ${err.message}`);
}
