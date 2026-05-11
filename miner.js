require("dotenv").config();

const { ethers } = require("ethers");
const { execFile } = require("child_process");
const path = require("path");

const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = "0xAC7b5d06fa1e77D08aea40d46cB7C5923A87A0cc";

let GPU_GRID = process.env.GPU_BLOCKS;
let GPU_BLOCK = process.env.GPU_THREADS;

const MINER_BIN = path.join(__dirname, process.platform === "win32" ? "keccak_miner.exe" : "keccak_miner");
const QUERY_BIN = path.join(__dirname, process.platform === "win32" ? "device_query.exe" : "device_query");

const fs = require("fs");
const { execFileSync } = require("child_process");

function compileCuda(binPath, srcPath, extraArgs = []) {
  if (fs.existsSync(binPath)) return;
  console.log(`Compiling ${srcPath}...`);
  
  if (process.platform === "win32") {
    const batPath = path.join(__dirname, "temp_build.bat");
    const cmd = `nvcc ${extraArgs.join(" ")} -o ${binPath} ${srcPath}`;
    fs.writeFileSync(batPath, `@echo off\nset "PATH=%PATH:"=%"\n${cmd}\n`);
    execFileSync(batPath, { stdio: "inherit", shell: true });
    fs.unlinkSync(batPath);
  } else {
    execFileSync("nvcc", [...extraArgs, "-o", binPath, srcPath], { stdio: "inherit" });
  }
}

function setupGpu() {
  compileCuda(QUERY_BIN, "cuda/device_query.cu");
  
  let smCount = 16;
  let maxThreads = 1024;
  try {
    const output = execFileSync(QUERY_BIN, { encoding: "utf8" }).trim();
    const parts = output.split(",");
    smCount = parseInt(parts[0]);
    maxThreads = parseInt(parts[1]);
    console.log(`Auto-detected GPU: ${smCount} SMs, Max Threads/Block: ${maxThreads}`);
  } catch (err) {
    console.error("Failed to query GPU properties, using defaults.", err.message);
  }

  if (!GPU_BLOCK) GPU_BLOCK = Math.min(256, maxThreads).toString();
  if (!GPU_GRID) GPU_GRID = (smCount * 4096).toString();
  
  compileCuda(MINER_BIN, "cuda/keccak_miner.cu", ["-O3"]);
}

const ABI = [
  "function getChallenge(address miner) view returns (bytes32)",
  "function miningState() view returns (uint256 era,uint256 reward,uint256 difficulty,uint256 minted,uint256 remaining,uint256 epoch,uint256 epochBlocksLeft_)",
  "function mine(uint256 nonce)"
];

function requireEnv() {
  if (!RPC_URL || !PRIVATE_KEY) {
    console.error("Isi RPC_URL dan PRIVATE_KEY di file .env dulu.");
    process.exit(1);
  }
  if (!PRIVATE_KEY.startsWith("0x")) {
    console.error("PRIVATE_KEY harus diawali 0x.");
    process.exit(1);
  }
}

function difficultyToHex(difficulty) {
  let hex = difficulty.toString(16);
  return hex;
}

function runGpuMiner(challengeHex, difficultyHex, startNonce, signal) {
  return new Promise((resolve, reject) => {
    const args = [challengeHex, difficultyHex, startNonce.toString(), GPU_GRID, GPU_BLOCK];

    console.log(`\nLaunching GPU miner...`);
    console.log(`  Grid: ${GPU_GRID} blocks x ${GPU_BLOCK} threads = ${parseInt(GPU_GRID) * parseInt(GPU_BLOCK)} threads/batch`);

    const { spawn } = require("child_process");
    const proc = spawn(MINER_BIN, args, { signal });
    let stdoutData = "";
    let stderrData = "";

    proc.stdout.on("data", (data) => {
      stdoutData += data.toString();
    });

    proc.stderr.on("data", (data) => {
      const text = data.toString();
      stderrData += text;
      process.stdout.write(text);
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`GPU miner error code ${code}\n${stderrData}`));
        return;
      }

      const nonce = stdoutData.trim();
      if (!nonce) {
        reject(new Error("GPU miner returned empty result"));
        return;
      }

      resolve(BigInt(nonce));
    });

    proc.on("error", (err) => {
      if (err.name === "AbortError") {
        reject(new Error("CHALLENGE_UPDATED"));
      } else {
        reject(new Error(`Failed to start GPU miner: ${err.message}`));
      }
    });
  });
}

async function main() {
  requireEnv();

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);

  console.log("=== HASH256 GPU Miner (CUDA) ===");
  console.log("Wallet:", wallet.address);
  console.log("Contract:", CONTRACT_ADDRESS);
  console.log("RPC:", RPC_URL);
  console.log("");

  setupGpu();

  let mineCount = 0;

  while (true) {
    try {
      const state = await contract.miningState();
      const difficulty = BigInt(state.difficulty.toString());
      const challenge = await contract.getChallenge(wallet.address);

      console.log("\n--- Mining Round", ++mineCount, "---");
      console.log("Era:", state.era.toString());
      console.log("Reward:", ethers.formatUnits(state.reward, 18), "HASH");
      console.log("Difficulty:", difficulty.toString());
      console.log("Epoch:", state.epoch.toString());
      console.log("Challenge:", challenge);

      // Strip 0x prefix for the CUDA miner
      const challengeHex = challenge.slice(2);
      const difficultyHex = difficultyToHex(difficulty);

      // Random start nonce to avoid collisions with other miners
      const startNonce = Math.floor(Math.random() * 1_000_000_000_000);

      const ac = new AbortController();
      const signal = ac.signal;

      // Background polling
      const pollInterval = setInterval(async () => {
        try {
          const currentChallenge = await contract.getChallenge(wallet.address);
          if (currentChallenge !== challenge) {
            console.log("\n[!] Challenge updated by network. Aborting stale round...");
            ac.abort();
          }
        } catch (err) {
          // ignore network errors during polling
        }
      }, 5000);

      const startTime = Date.now();
      let nonce;
      try {
        nonce = await runGpuMiner(challengeHex, difficultyHex, startNonce, signal);
      } finally {
        clearInterval(pollInterval);
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

      console.log(`\nFOUND nonce: ${nonce.toString()} (${elapsed}s)`);

      // Verify locally before submitting
      const hash = ethers.solidityPackedKeccak256(
        ["bytes32", "uint256"],
        [challenge, nonce]
      );
      const hashNum = BigInt(hash);

      if (hashNum >= difficulty) {
        console.error("WARNING: Local verification failed! Hash >= difficulty. Skipping...");
        continue;
      }

      console.log("Hash:", hash);
      console.log("Verified locally OK");

      // Submit transaction
      console.log("Submitting mine(nonce) tx...");
      const tx = await contract.mine(nonce);
      console.log("TX sent:", tx.hash);

      const receipt = await tx.wait();
      if (receipt.status === 1) {
        console.log("SUCCESS! Block:", receipt.blockNumber);
        console.log("Gas used:", receipt.gasUsed.toString());
      } else {
        console.log("TX reverted in block:", receipt.blockNumber);
      }

    } catch (err) {
      if (err.message === "CHALLENGE_UPDATED") {
        continue;
      }
      console.error("Error:", err.shortMessage || err.message);
      console.log("Retrying in 5s...");
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

main().catch((err) => {
  console.error(err.shortMessage || err.message || err);
  process.exit(1);
});
