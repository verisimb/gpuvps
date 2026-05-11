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

// Primary RPC for reads + WebSocket. Use WSS if available.
const WS_URL = process.env.WS_URL || (RPC_URL ? RPC_URL.replace(/^https/, "wss") : null);

// Multi-RPC broadcast endpoints (TX submission only)
// Comma-separated list. Public endpoints + private builders if available.
const BROADCAST_URLS = (process.env.BROADCAST_URLS || [
  "https://rpc.flashbots.net",
  "https://rpc.titanbuilder.xyz",
  "https://rpc.beaverbuild.org",
  "https://rpc.mevblocker.io",
  "https://1rpc.io/eth",
  "https://ethereum-rpc.publicnode.com",
  "https://rpc.ankr.com/eth",
].join(",")).split(",").map(s => s.trim()).filter(Boolean);

// Telegram
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

// Gas strategy
const GAS_MULTIPLIER = BigInt(process.env.GAS_MULTIPLIER || "5");
const GAS_TIP_GWEI = process.env.GAS_TIP_GWEI;
const MEMPOOL_OUTBID_PCT = BigInt(process.env.MEMPOOL_OUTBID_PCT || "15"); // +15% over competitor
const MIN_TIP_GWEI = process.env.MIN_TIP_GWEI || "1";
const MAX_TIP_GWEI = process.env.MAX_TIP_GWEI || "50";

const MINER_BIN = path.join(__dirname, process.platform === "win32" ? "keccak_miner.exe" : "keccak_miner");
const QUERY_BIN = path.join(__dirname, process.platform === "win32" ? "device_query.exe" : "device_query");

const ABI = [
  "function getChallenge(address miner) view returns (bytes32)",
  "function miningState() view returns (uint256 era,uint256 reward,uint256 difficulty,uint256 minted,uint256 remaining,uint256 epoch,uint256 epochBlocksLeft_)",
  "function mine(uint256 nonce)"
];

// Selector for mine(uint256): keccak256("mine(uint256)")[0..4]
const MINE_SELECTOR = "0x4d474898";

// ─── Telegram ─────────────────────────────────────────────────────────────────
function sendTelegram(message) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return Promise.resolve();
  return new Promise((resolve) => {
    const data = JSON.stringify({ chat_id: TG_CHAT_ID, text: message, parse_mode: "HTML", disable_web_page_preview: true });
    const options = {
      hostname: "api.telegram.org",
      path: `/bot${TG_BOT_TOKEN}/sendMessage`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
    };
    const req = https.request(options, (res) => { res.resume(); resolve(); });
    req.on("error", () => resolve());
    req.write(data);
    req.end();
  });
}

async function notifySuccess(block, gasUsed, txHash, reward, elapsed, tipGwei) {
  const msgs = [
    `🏆 <b>HASH MINED!</b>\n\nBlock: ${block}\nReward: ${reward} HASH\nTime: ${elapsed}s\nGas: ${gasUsed}\nTip: ${tipGwei} gwei`,
    `🔗 https://etherscan.io/tx/${txHash}`,
    `⛏️ Mining continues...`,
    `📊 Winrate stats available in logs`,
    `✅ All systems operational`,
  ];
  for (let i = 0; i < msgs.length; i++) {
    await sendTelegram(msgs[i]);
    if (i < msgs.length - 1) await new Promise(r => setTimeout(r, 5000));
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function requireEnv() {
  if (!RPC_URL || !PRIVATE_KEY) {
    console.error("Set RPC_URL and PRIVATE_KEY in .env");
    process.exit(1);
  }
  if (!PRIVATE_KEY.startsWith("0x")) {
    console.error("PRIVATE_KEY must start with 0x");
    process.exit(1);
  }
}

function compileCuda(binPath, srcPath, extraArgs = []) {
  if (fs.existsSync(binPath)) return;
  console.log(`Compiling ${srcPath}...`);
  execFileSync("nvcc", [...extraArgs, "-o", binPath, srcPath], { stdio: "inherit" });
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

// ─── GPU Workers ──────────────────────────────────────────────────────────────
function launchGpuWorker(deviceId, challengeHex, difficultyHex, startNonce, gridSize, blockSize) {
  const args = [challengeHex, difficultyHex, startNonce.toString(), gridSize.toString(), blockSize.toString(), deviceId.toString()];
  const proc = spawn(MINER_BIN, args);
  let stdoutData = "";

  proc.stdout.on("data", (data) => { stdoutData += data.toString(); });
  proc.stderr.on("data", (data) => { process.stderr.write(data.toString()); });

  return {
    proc,
    promise: new Promise((resolve, reject) => {
      proc.on("close", (code) => {
        if (code === null || code !== 0) {
          reject(new Error(`GPU ${deviceId} exited with code ${code}`));
          return;
        }
        const nonce = stdoutData.trim();
        if (!nonce) { reject(new Error(`GPU ${deviceId} empty result`)); return; }
        resolve(BigInt(nonce));
      });
      proc.on("error", reject);
    }),
    deviceId,
  };
}

function runMultiGpuMiner(gpus, challengeHex, difficultyHex, signal) {
  return new Promise((resolve, reject) => {
    const NONCE_SPACING = 1_000_000_000_000_000n;
    const workers = [];
    let resolved = false;

    for (let i = 0; i < gpus.length; i++) {
      const gpu = gpus[i];
      const config = getGpuConfig(gpu);
      const randomBase = BigInt(Math.floor(Math.random() * 1_000_000_000_000));
      const baseNonce = randomBase + BigInt(i) * NONCE_SPACING;

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
          if (allDead) reject(err);
        }
      });
    }

    const onAbort = () => {
      if (!resolved) {
        resolved = true;
        for (const w of workers) { try { w.proc.kill("SIGKILL"); } catch (e) {} }
        reject(new Error("CHALLENGE_UPDATED"));
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.allSettled(workers.map(w => w.promise)).then(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

// ─── Multi-RPC Broadcast ──────────────────────────────────────────────────────
// Sends raw TX to all broadcast endpoints in parallel. Returns when any succeed.
async function broadcastTx(rawTx, urls) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    method: "eth_sendRawTransaction",
    params: [rawTx],
    id: 1,
  });

  const promises = urls.map(url => sendRawToEndpoint(url, body));
  const results = await Promise.allSettled(promises);

  const succeeded = [];
  const failed = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled" && r.value.success) {
      succeeded.push({ url: urls[i], hash: r.value.hash });
    } else {
      const err = r.status === "fulfilled" ? r.value.error : r.reason.message;
      failed.push({ url: urls[i], err: (err || "unknown").toString().slice(0, 80) });
    }
  }
  return { succeeded, failed };
}

function sendRawToEndpoint(url, body) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? require("https") : require("http");
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      timeout: 3000,
    };
    const req = lib.request(opts, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.result) {
            resolve({ success: true, hash: parsed.result });
          } else {
            resolve({ success: false, error: parsed.error ? parsed.error.message : "no result" });
          }
        } catch (e) {
          resolve({ success: false, error: "parse error" });
        }
      });
    });
    req.on("error", (err) => resolve({ success: false, error: err.message }));
    req.on("timeout", () => { req.destroy(); resolve({ success: false, error: "timeout" }); });
    req.write(body);
    req.end();
  });
}

// ─── Pre-signed TX Builder ────────────────────────────────────────────────────
async function buildAndSignMineTx(wallet, provider, nonce, accountNonce, chainId, gasState) {
  const data = MINE_SELECTOR + nonce.toString(16).padStart(64, "0");

  const tx = {
    type: 2,
    chainId,
    nonce: accountNonce,
    to: CONTRACT_ADDRESS,
    data,
    value: 0n,
    gasLimit: 150000n,
    maxFeePerGas: gasState.maxFee,
    maxPriorityFeePerGas: gasState.maxPriority,
  };

  return await wallet.signTransaction(tx);
}

// ─── Gas State (refreshed on each block) ──────────────────────────────────────
class GasOracle {
  constructor(provider) {
    this.provider = provider;
    this.maxFee = ethers.parseUnits("30", "gwei");
    this.maxPriority = ethers.parseUnits("2", "gwei");
    this.baseFee = ethers.parseUnits("20", "gwei");
    this.lastUpdate = 0;
  }

  async refresh() {
    try {
      const feeData = await this.provider.getFeeData();
      const basePriority = feeData.maxPriorityFeePerGas || ethers.parseUnits("0.5", "gwei");

      let priority;
      if (GAS_TIP_GWEI) {
        priority = ethers.parseUnits(GAS_TIP_GWEI, "gwei");
      } else {
        priority = basePriority * GAS_MULTIPLIER;
        const minTip = ethers.parseUnits(MIN_TIP_GWEI, "gwei");
        const maxTip = ethers.parseUnits(MAX_TIP_GWEI, "gwei");
        if (priority < minTip) priority = minTip;
        if (priority > maxTip) priority = maxTip;
      }

      const baseFee = (feeData.maxFeePerGas || ethers.parseUnits("20", "gwei")) - basePriority;
      this.baseFee = baseFee;
      this.maxPriority = priority;
      this.maxFee = baseFee * 2n + priority;
      this.lastUpdate = Date.now();
    } catch (err) {
      // keep previous values on error
    }
  }

  // Outbid a competitor priority fee
  outbid(competitorTip) {
    const outbidAmount = (competitorTip * (100n + MEMPOOL_OUTBID_PCT)) / 100n;
    if (outbidAmount > this.maxPriority) {
      const maxTip = ethers.parseUnits(MAX_TIP_GWEI, "gwei");
      this.maxPriority = outbidAmount > maxTip ? maxTip : outbidAmount;
      this.maxFee = this.baseFee * 2n + this.maxPriority;
    }
  }

  snapshot() {
    return { maxFee: this.maxFee, maxPriority: this.maxPriority };
  }
}

// ─── Mempool Monitor (detect competitor mine() TXs) ───────────────────────────
class MempoolMonitor {
  constructor(wsUrl, gasOracle) {
    this.wsUrl = wsUrl;
    this.gasOracle = gasOracle;
    this.ws = null;
    this.highestCompetitorTip = 0n;
    this.onCompetitor = null;
  }

  start() {
    if (!this.wsUrl || !this.wsUrl.startsWith("ws")) {
      console.log("Mempool monitor: WS URL not available, skipping");
      return;
    }
    const WebSocket = require("ws");
    try {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.on("open", () => {
        console.log("Mempool monitor: WebSocket connected");
        this.ws.send(JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_subscribe",
          params: ["alchemy_pendingTransactions", { toAddress: [CONTRACT_ADDRESS] }]
        }));
        // Fallback: simple newPendingTransactions
        this.ws.send(JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "eth_subscribe",
          params: ["newPendingTransactions"]
        }));
      });
      this.ws.on("message", (msg) => {
        try {
          const data = JSON.parse(msg.toString());
          if (data.method === "eth_subscription" && data.params && data.params.result) {
            const tx = data.params.result;
            // alchemy_pendingTransactions returns full tx object
            if (typeof tx === "object" && tx.to && tx.to.toLowerCase() === CONTRACT_ADDRESS.toLowerCase()) {
              if (tx.input && tx.input.startsWith(MINE_SELECTOR)) {
                const tip = BigInt(tx.maxPriorityFeePerGas || "0");
                if (tip > this.highestCompetitorTip) {
                  this.highestCompetitorTip = tip;
                  this.gasOracle.outbid(tip);
                  if (this.onCompetitor) this.onCompetitor(tx, tip);
                }
              }
            }
          }
        } catch (e) {
          // ignore parse errors
        }
      });
      this.ws.on("error", (err) => {
        console.log("Mempool WS error:", err.message);
      });
      this.ws.on("close", () => {
        if (!this._loggedReconnect) {
          console.log("Mempool WS: reconnecting (further reconnects silent)");
          this._loggedReconnect = true;
        }
        setTimeout(() => this.start(), 5000);
      });
    } catch (err) {
      console.log("Mempool monitor init failed:", err.message);
    }
  }

  stop() {
    if (this.ws) { try { this.ws.close(); } catch (e) {} }
  }

  reset() {
    this.highestCompetitorTip = 0n;
  }
}

// ─── Block/Challenge Watcher (WebSocket) ──────────────────────────────────────
class ChallengeWatcher {
  constructor(wsProvider, contract, wallet) {
    this.wsProvider = wsProvider;
    this.contract = contract;
    this.wallet = wallet;
    this.currentChallenge = null;
    this.currentDifficulty = null;
    this.currentReward = null;
    this.currentEpoch = null;
    this.onChange = null;
    this.blockHandler = null;
  }

  async start() {
    await this.refresh();
    // Always start polling as reliable fallback
    this.startPolling();
    // Also try WS block subscription for faster detection
    try {
      this.blockHandler = async () => { await this.refresh(); };
      this.wsProvider.on("block", this.blockHandler);
      console.log("Block watcher: WS subscribed + polling every 2s");
    } catch (err) {
      console.log("Block watcher: WS failed, using polling only:", err.message);
    }
  }

  startPolling() {
    this.pollTimer = setInterval(() => { this.refresh().catch(() => {}); }, 2000);
  }

  async refresh() {
    try {
      const [challenge, state] = await Promise.all([
        this.contract.getChallenge(this.wallet.address),
        this.contract.miningState(),
      ]);
      const changed = this.currentChallenge && this.currentChallenge !== challenge;
      this.currentChallenge = challenge;
      this.currentDifficulty = BigInt(state.difficulty.toString());
      this.currentReward = state.reward;
      this.currentEpoch = state.epoch;
      if (changed && this.onChange) {
        this.onChange(challenge);
      } else if (this.currentChallenge) {
        console.log(`[CHECK] Challenge still valid | Epoch: ${state.epoch.toString()}`);
      }
    } catch (err) {
      console.log(`[CHECK] RPC error: ${err.message ? err.message.slice(0, 50) : "unknown"}`);
    }
  }

  stop() {
    if (this.blockHandler) {
      try { this.wsProvider.off("block", this.blockHandler); } catch (e) {}
    }
    if (this.pollTimer) clearInterval(this.pollTimer);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  requireEnv();

  const httpProvider = new ethers.JsonRpcProvider(RPC_URL);

  // Try WebSocket provider if URL looks like wss
  let wsProvider = null;
  if (WS_URL && WS_URL.startsWith("ws")) {
    try {
      wsProvider = new ethers.WebSocketProvider(WS_URL);
      console.log("WebSocket provider: connected");
    } catch (err) {
      console.log("WS provider failed:", err.message);
    }
  }
  const readProvider = wsProvider || httpProvider;

  const wallet = new ethers.Wallet(PRIVATE_KEY, httpProvider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, readProvider);
  const network = await httpProvider.getNetwork();
  const chainId = Number(network.chainId);

  console.log("╔══════════════════════════════════════════════╗");
  console.log("║  HASH256 Optimized Multi-GPU Miner v2        ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log("Wallet:", wallet.address);
  console.log("Contract:", CONTRACT_ADDRESS);
  console.log("Chain ID:", chainId);
  console.log("Primary RPC:", RPC_URL);
  console.log("Broadcast RPCs:", BROADCAST_URLS.length);
  BROADCAST_URLS.forEach(u => console.log("  -", u));
  console.log("Gas:", GAS_TIP_GWEI ? `Fixed ${GAS_TIP_GWEI} gwei` : `${GAS_MULTIPLIER}x, outbid +${MEMPOOL_OUTBID_PCT}%`);
  console.log("Telegram:", (TG_BOT_TOKEN && TG_CHAT_ID) ? "Enabled" : "Disabled");
  console.log("");

  // Detect GPUs
  const gpus = detectGpus();
  console.log(`Detected ${gpus.length} GPU(s):`);
  let totalThreadsPerBatch = 0;
  for (const gpu of gpus) {
    const config = getGpuConfig(gpu);
    const threadsPerBatch = config.gridSize * config.blockSize;
    totalThreadsPerBatch += threadsPerBatch;
    console.log(`  [GPU ${gpu.id}] ${gpu.name} | ${gpu.smCount} SMs | ${config.gridSize}x${config.blockSize} = ${(threadsPerBatch / 1e6).toFixed(1)}M threads/batch`);
  }
  console.log(`  Total: ${(totalThreadsPerBatch / 1e6).toFixed(1)}M threads/batch\n`);

  // Build CUDA binary
  compileCuda(MINER_BIN, "cuda/keccak_miner.cu", ["-O3"]);
  console.log("CUDA binary ready.\n");

  // Init gas oracle
  const gasOracle = new GasOracle(httpProvider);
  await gasOracle.refresh();

  // Refresh gas on every new block (no wasted RPC calls)
  if (wsProvider) {
    wsProvider.on("block", () => gasOracle.refresh().catch(() => {}));
  } else {
    setInterval(() => gasOracle.refresh().catch(() => {}), 6000);
  }

  // Init mempool monitor
  const mempool = new MempoolMonitor(WS_URL, gasOracle);
  mempool.onCompetitor = (tx, tip) => {
    console.log(`[MEMPOOL] Competitor mine() @ ${ethers.formatUnits(tip, "gwei")} gwei tip -> outbidding`);
  };
  mempool.start();

  // Init challenge watcher
  const watcher = new ChallengeWatcher(readProvider, contract, wallet);
  await watcher.start();

  // Pre-fetch account nonce
  let accountNonce = await httpProvider.getTransactionCount(wallet.address, "pending");

  await sendTelegram(`⛏️ <b>Miner v2 Started</b>\nGPUs: ${gpus.length}\nBroadcast RPCs: ${BROADCAST_URLS.length}\nWallet: <code>${wallet.address}</code>`);

  let roundCount = 0;
  let successCount = 0;
  let revertCount = 0;
  let staleSkipCount = 0;

  while (true) {
    try {
      // Use cached state from watcher (instant, no RPC)
      if (!watcher.currentChallenge) await watcher.refresh();
      const challenge = watcher.currentChallenge;
      const difficulty = watcher.currentDifficulty;
      const reward = watcher.currentReward;
      const epoch = watcher.currentEpoch;

      const rewardStr = ethers.formatUnits(reward, 18);

      console.log(`\n${"═".repeat(52)}`);
      console.log(`Round #${++roundCount} | Wins: ${successCount} | Reverts: ${revertCount} | Stale: ${staleSkipCount}`);
      console.log(`${"═".repeat(52)}`);
      console.log("Epoch:", epoch.toString(), "| Reward:", rewardStr, "HASH");
      console.log("Difficulty:", difficulty.toString());
      console.log("Challenge:", challenge);

      const challengeHex = challenge.slice(2);
      const difficultyHex = difficulty.toString(16);

      const ac = new AbortController();
      const signal = ac.signal;

      // Abort mining as soon as challenge changes (WS instant detection)
      watcher.onChange = () => {
        console.log("\n[!] Challenge changed (WS instant). Aborting.");
        ac.abort();
      };

      // Reset mempool competitor tracking for this round
      mempool.reset();

      const startTime = Date.now();
      let nonce;
      try {
        nonce = await runMultiGpuMiner(gpus, challengeHex, difficultyHex, signal);
      } finally {
        watcher.onChange = null;
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(`\n✓ FOUND nonce: ${nonce.toString()} (${elapsed}s)`);

      // Verify locally
      const hash = ethers.solidityPackedKeccak256(["bytes32", "uint256"], [challenge, nonce]);
      if (BigInt(hash) >= difficulty) {
        console.error("WARNING: Local verification FAILED. Skipping...");
        continue;
      }
      console.log("Hash:", hash, "| Local verify: OK");

      // Re-check challenge (may have changed right before submit)
      await watcher.refresh();
      if (watcher.currentChallenge !== challenge) {
        console.log("Challenge changed before submit, skipping stale nonce");
        staleSkipCount++;
        continue;
      }

      // Build and sign TX using current gas state
      const gasState = gasOracle.snapshot();
      console.log(`Gas: maxFee=${ethers.formatUnits(gasState.maxFee, "gwei")} gwei | tip=${ethers.formatUnits(gasState.maxPriority, "gwei")} gwei`);

      // Refresh account nonce (may have changed from previous success)
      const latestNonce = await httpProvider.getTransactionCount(wallet.address, "pending");
      if (latestNonce > accountNonce) accountNonce = latestNonce;

      const rawTx = await buildAndSignMineTx(wallet, httpProvider, nonce, accountNonce, chainId, gasState);

      // Multi-RPC broadcast
      console.log(`Broadcasting TX to ${BROADCAST_URLS.length} endpoints in parallel...`);
      const submitStart = Date.now();
      const { succeeded, failed } = await broadcastTx(rawTx, BROADCAST_URLS);
      const submitMs = Date.now() - submitStart;

      if (succeeded.length === 0) {
        console.log(`All ${BROADCAST_URLS.length} broadcasts failed in ${submitMs}ms:`);
        failed.slice(0, 3).forEach(f => console.log(`  ${f.url}: ${f.err}`));
        continue;
      }

      const txHash = succeeded[0].hash;
      console.log(`Broadcast OK in ${submitMs}ms: ${succeeded.length}/${BROADCAST_URLS.length} accepted`);
      console.log(`TX hash: ${txHash}`);
      succeeded.forEach(s => console.log(`  ✓ ${s.url}`));

      // Wait for receipt
      let receipt = null;
      const waitStart = Date.now();
      const waitTimeout = 45000;
      while (Date.now() - waitStart < waitTimeout) {
        try {
          receipt = await httpProvider.getTransactionReceipt(txHash);
          if (receipt) break;
        } catch (e) {}
        await new Promise(r => setTimeout(r, 500));
      }

      if (!receipt) {
        console.log("TX not mined within 45s, continuing");
        accountNonce++; // assume TX may still land, bump nonce
        continue;
      }

      if (receipt.status === 1) {
        successCount++;
        accountNonce++;
        const tipGwei = ethers.formatUnits(gasState.maxPriority, "gwei");
        console.log(`\n🏆 SUCCESS! Block ${receipt.blockNumber} | Gas: ${receipt.gasUsed.toString()} | Tip: ${tipGwei} gwei`);
        console.log(`   https://etherscan.io/tx/${txHash}`);
        console.log(`   Winrate: ${successCount}/${roundCount} (${(successCount * 100 / roundCount).toFixed(1)}%)`);
        notifySuccess(receipt.blockNumber, receipt.gasUsed.toString(), txHash, rewardStr, elapsed, tipGwei);
      } else {
        revertCount++;
        accountNonce++;
        console.log(`✗ Reverted in block ${receipt.blockNumber}`);
      }

    } catch (err) {
      if (err.message === "CHALLENGE_UPDATED") {
        console.log("Restarting with new challenge\n");
        continue;
      }
      console.error("Error:", err.shortMessage || err.message);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err.shortMessage || err.message || err);
  process.exit(1);
});
