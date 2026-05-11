require("dotenv").config();

const { ethers } = require("ethers");
const { spawn, execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const https = require("https");

// ─── Config ───────────────────────────────────────────────────────────────────
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = "0xAC7b5d06fa1e77D08aea40d46cB7C5923A87A0cc";

// Telegram config
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

// Gas strategy: how aggressive to bid
const GAS_MULTIPLIER = BigInt(process.env.GAS_MULTIPLIER || "5"); // 5x priority fee
const GAS_TIP_GWEI = process.env.GAS_TIP_GWEI; // optional: fixed tip in gwei

const MINER_BIN = path.join(__dirname, process.platform === "win32" ? "keccak_miner.exe" : "keccak_miner");
const QUERY_BIN = path.join(__dirname, process.platform === "win32" ? "device_query.exe" : "device_query");

const ABI = [
  "function getChallenge(address miner) view returns (bytes32)",
  "function miningState() view returns (uint256 era,uint256 reward,uint256 difficulty,uint256 minted,uint256 remaining,uint256 epoch,uint256 epochBlocksLeft_)",
  "function mine(uint256 nonce)"
];

// ─── Telegram ─────────────────────────────────────────────────────────────────
function sendTelegram(message) {
  return new Promise((resolve) => {
    const data = JSON.stringify({ chat_id: TG_CHAT_ID, text: message, parse_mode: "HTML" });
    const options = {
      hostname: "api.telegram.org",
      path: `/bot${TG_BOT_TOKEN}/sendMessage`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
    };
    const req = https.request(options, (res) => {
      res.resume();
      resolve();
    });
    req.on("error", () => resolve()); // don't crash on telegram failure
    req.write(data);
    req.end();
  });
}

async function notifySuccess(block, gasUsed, txHash, reward, elapsed) {
  const msgs = [
    `🏆 <b>HASH MINED!</b>\n\nBlock: ${block}\nReward: ${reward} HASH\nTime: ${elapsed}s\nGas: ${gasUsed}`,
    `🔗 TX: https://etherscan.io/tx/${txHash}`,
    `⛏️ Mining continues...`,
    `📊 Stats update coming soon`,
    `✅ All systems operational`,
  ];

  for (let i = 0; i < msgs.length; i++) {
    await sendTelegram(msgs[i]);
    if (i < msgs.length - 1) {
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function requireEnv() {
  if (!RPC_URL || !PRIVATE_KEY) {
    console.error("Set RPC_URL and PRIVATE_KEY in .env file.");
    process.exit(1);
  }
  if (!PRIVATE_KEY.startsWith("0x")) {
    console.error("PRIVATE_KEY must start with 0x.");
    process.exit(1);
  }
}

function compileCuda(binPath, srcPath, extraArgs = []) {
  if (fs.existsSync(binPath)) return;
  console.log(`Compiling ${srcPath}...`);
  if (process.platform === "win32") {
    const batPath = path.join(__dirname, "temp_build.bat");
    const cmd = `nvcc ${extraArgs.join(" ")} -o "${binPath}" "${srcPath}"`;
    fs.writeFileSync(batPath, `@echo off\nset "PATH=%PATH:"=%"\n${cmd}\n`);
    execFileSync(batPath, { stdio: "inherit", shell: true });
    fs.unlinkSync(batPath);
  } else {
    execFileSync("nvcc", [...extraArgs, "-o", binPath, srcPath], { stdio: "inherit" });
  }
}

function detectGpus() {
  compileCuda(QUERY_BIN, "cuda/device_query.cu");

  let gpus = [];
  try {
    const output = execFileSync(QUERY_BIN, { encoding: "utf8" }).trim();
    const lines = output.split("\n");
    const numDevices = parseInt(lines[0]);

    for (let i = 1; i <= numDevices; i++) {
      const parts = lines[i].split(",");
      gpus.push({
        id: parseInt(parts[0]),
        name: parts[1],
        smCount: parseInt(parts[2]),
        maxThreads: parseInt(parts[3]),
      });
    }
  } catch (err) {
    console.error("Failed to detect GPUs:", err.message);
    gpus = [{ id: 0, name: "Unknown", smCount: 64, maxThreads: 1024 }];
  }

  return gpus;
}

function getGpuConfig(gpu) {
  const blockSize = Math.min(256, gpu.maxThreads);
  const gridSize = gpu.smCount * 128;
  return { gridSize, blockSize };
}

// ─── Multi-GPU Mining ─────────────────────────────────────────────────────────
function launchGpuWorker(deviceId, challengeHex, difficultyHex, startNonce, gridSize, blockSize) {
  const args = [challengeHex, difficultyHex, startNonce.toString(), gridSize.toString(), blockSize.toString(), deviceId.toString()];

  const proc = spawn(MINER_BIN, args);
  let stdoutData = "";

  proc.stdout.on("data", (data) => {
    stdoutData += data.toString();
  });

  proc.stderr.on("data", (data) => {
    process.stderr.write(data.toString());
  });

  return {
    proc,
    promise: new Promise((resolve, reject) => {
      proc.on("close", (code) => {
        if (code === null || code !== 0) {
          reject(new Error(`GPU ${deviceId} exited with code ${code}`));
          return;
        }
        const nonce = stdoutData.trim();
        if (!nonce) {
          reject(new Error(`GPU ${deviceId} returned empty result`));
          return;
        }
        resolve(BigInt(nonce));
      });
      proc.on("error", (err) => {
        reject(err);
      });
    }),
    deviceId,
  };
}

function runMultiGpuMiner(gpus, challengeHex, difficultyHex, signal) {
  return new Promise((resolve, reject) => {
    const NONCE_SPACING = 1_000_000_000_000_000;

    const workers = [];
    let resolved = false;

    for (let i = 0; i < gpus.length; i++) {
      const gpu = gpus[i];
      const config = getGpuConfig(gpu);
      const baseNonce = Math.floor(Math.random() * 1_000_000_000_000) + (i * NONCE_SPACING);

      const worker = launchGpuWorker(
        gpu.id, challengeHex, difficultyHex, baseNonce, config.gridSize, config.blockSize
      );
      workers.push(worker);

      worker.promise.then((nonce) => {
        if (!resolved) {
          resolved = true;
          for (const w of workers) {
            if (w.deviceId !== worker.deviceId) {
              try { w.proc.kill("SIGKILL"); } catch (e) {}
            }
          }
          resolve(nonce);
        }
      }).catch((err) => {
        if (!resolved) {
          const allDead = workers.every(w => w.proc.killed || w.proc.exitCode !== null);
          if (allDead) {
            reject(err);
          }
        }
      });
    }

    const onAbort = () => {
      if (!resolved) {
        resolved = true;
        for (const w of workers) {
          try { w.proc.kill("SIGKILL"); } catch (e) {}
        }
        reject(new Error("CHALLENGE_UPDATED"));
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });

    Promise.allSettled(workers.map(w => w.promise)).then(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  requireEnv();

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);

  console.log("╔══════════════════════════════════════════╗");
  console.log("║   HASH256 Multi-GPU Miner (CUDA)        ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log("");
  console.log("Wallet:", wallet.address);
  console.log("Contract:", CONTRACT_ADDRESS);
  console.log("RPC:", RPC_URL);
  console.log("Gas strategy:", GAS_TIP_GWEI ? `Fixed ${GAS_TIP_GWEI} gwei tip` : `${GAS_MULTIPLIER}x priority fee`);
  console.log("Telegram:", TG_BOT_TOKEN ? "Enabled" : "Disabled");
  console.log("");

  // Detect and configure GPUs
  const gpus = detectGpus();
  console.log(`Detected ${gpus.length} GPU(s):`);
  let totalThreadsPerBatch = 0;
  for (const gpu of gpus) {
    const config = getGpuConfig(gpu);
    const threadsPerBatch = config.gridSize * config.blockSize;
    totalThreadsPerBatch += threadsPerBatch;
    console.log(`  [GPU ${gpu.id}] ${gpu.name} | ${gpu.smCount} SMs | Grid: ${config.gridSize}x${config.blockSize} = ${(threadsPerBatch / 1000000).toFixed(1)}M threads/batch`);
  }
  console.log(`  Total parallel threads: ${(totalThreadsPerBatch / 1000000).toFixed(1)}M per batch`);
  console.log("");

  // Build CUDA binary
  compileCuda(MINER_BIN, "cuda/keccak_miner.cu", ["-O3"]);
  console.log("CUDA binary ready.\n");

  // Send startup notification
  await sendTelegram(`⛏️ <b>Miner Started</b>\n\nGPUs: ${gpus.length}\nWallet: <code>${wallet.address}</code>`);

  let mineCount = 0;
  let successCount = 0;

  while (true) {
    try {
      const state = await contract.miningState();
      const difficulty = BigInt(state.difficulty.toString());
      const challenge = await contract.getChallenge(wallet.address);
      const rewardStr = ethers.formatUnits(state.reward, 18);

      console.log(`\n${"═".repeat(50)}`);
      console.log(`Mining Round #${++mineCount} | Wins: ${successCount}`);
      console.log(`${"═".repeat(50)}`);
      console.log("Era:", state.era.toString());
      console.log("Reward:", rewardStr, "HASH");
      console.log("Difficulty:", difficulty.toString());
      console.log("Epoch:", state.epoch.toString());
      console.log("Challenge:", challenge);

      const challengeHex = challenge.slice(2);
      const difficultyHex = difficulty.toString(16);

      const ac = new AbortController();
      const signal = ac.signal;

      // Background polling - check every 2s if challenge changed
      const pollInterval = setInterval(async () => {
        try {
          const currentChallenge = await contract.getChallenge(wallet.address);
          if (currentChallenge !== challenge) {
            console.log("\n[!] Challenge changed! Someone else mined. Aborting...");
            ac.abort();
          }
        } catch (err) {
          // ignore
        }
      }, 2000);

      const startTime = Date.now();
      let nonce;
      try {
        nonce = await runMultiGpuMiner(gpus, challengeHex, difficultyHex, signal);
      } finally {
        clearInterval(pollInterval);
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(`\n✓ FOUND nonce: ${nonce.toString()} (${elapsed}s)`);

      // Verify locally
      const hash = ethers.solidityPackedKeccak256(
        ["bytes32", "uint256"],
        [challenge, nonce]
      );
      const hashNum = BigInt(hash);

      if (hashNum >= difficulty) {
        console.error("WARNING: Local verification FAILED. Skipping...");
        continue;
      }

      console.log("Hash:", hash);
      console.log("Local verification: OK");

      // Re-check challenge before spending gas
      const freshChallenge = await contract.getChallenge(wallet.address);
      if (freshChallenge !== challenge) {
        console.log("Challenge changed before TX submit. Skipping stale nonce...");
        continue;
      }

      // ─── Aggressive Gas Strategy ───────────────────────────────────────
      console.log("\nSubmitting mine(nonce) tx...");
      const feeData = await provider.getFeeData();

      let maxPriorityFee;
      if (GAS_TIP_GWEI) {
        // Fixed tip mode
        maxPriorityFee = ethers.parseUnits(GAS_TIP_GWEI, "gwei");
      } else {
        // Multiplier mode: network priority * multiplier, minimum 1 gwei
        const basePriority = feeData.maxPriorityFeePerGas || ethers.parseUnits("0.1", "gwei");
        maxPriorityFee = basePriority * GAS_MULTIPLIER;
        const minTip = ethers.parseUnits("1", "gwei");
        if (maxPriorityFee < minTip) maxPriorityFee = minTip;
      }

      // maxFee = baseFee * 2 + priority (ensures inclusion even if baseFee spikes)
      const baseFee = feeData.maxFeePerGas - (feeData.maxPriorityFeePerGas || 0n);
      const maxFee = baseFee * 2n + maxPriorityFee;

      console.log(`  Priority: ${ethers.formatUnits(maxPriorityFee, "gwei")} gwei`);
      console.log(`  MaxFee: ${ethers.formatUnits(maxFee, "gwei")} gwei`);

      const tx = await contract.mine(nonce, {
        maxFeePerGas: maxFee,
        maxPriorityFeePerGas: maxPriorityFee,
        gasLimit: 150000n, // tighter limit = less risk
      });
      console.log("TX sent:", tx.hash);

      // Wait with 45s timeout (faster retry on stuck TX)
      const receipt = await Promise.race([
        tx.wait(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("TX_TIMEOUT")), 45000))
      ]);

      if (receipt.status === 1) {
        successCount++;
        console.log(`\n🏆 SUCCESS! Mined in block ${receipt.blockNumber}`);
        console.log(`   Gas used: ${receipt.gasUsed.toString()}`);
        console.log(`   https://etherscan.io/tx/${tx.hash}`);
        console.log(`   Total wins: ${successCount}`);

        // Telegram notification (5 messages, 5s interval)
        notifySuccess(receipt.blockNumber, receipt.gasUsed.toString(), tx.hash, rewardStr, elapsed);
      } else {
        console.log("TX reverted in block:", receipt.blockNumber);
      }

    } catch (err) {
      if (err.message === "CHALLENGE_UPDATED") {
        console.log("Restarting with new challenge...\n");
        continue;
      }
      if (err.message === "TX_TIMEOUT") {
        console.log("TX pending too long. Moving to next round...");
        continue;
      }
      console.error("Error:", err.shortMessage || err.message);
      console.log("Retrying in 3s...");
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

main().catch((err) => {
  console.error(err.shortMessage || err.message || err);
  process.exit(1);
});
