require("dotenv").config();

const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = "0xAC7b5d06fa1e77D08aea40d46cB7C5923A87A0cc";

const ABI = [
  "function getChallenge(address miner) view returns (bytes32)",
  "function miningState() view returns (uint256 era,uint256 reward,uint256 difficulty,uint256 minted,uint256 remaining,uint256 epoch,uint256 epochBlocksLeft_)",
  "function totalSupply() view returns (uint256)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)"
];

async function main() {
  if (!RPC_URL || !PRIVATE_KEY) {
    console.error("Isi RPC_URL dan PRIVATE_KEY di file .env dulu.");
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);

  console.log("=== HASH256 Contract State ===\n");
  console.log("Wallet:", wallet.address);

  const name = await contract.name();
  const symbol = await contract.symbol();
  const totalSupply = await contract.totalSupply();
  const balance = await contract.balanceOf(wallet.address);
  const state = await contract.miningState();
  const challenge = await contract.getChallenge(wallet.address);

  console.log(`Token: ${name} (${symbol})`);
  console.log(`Total Supply: ${ethers.formatUnits(totalSupply, 18)}`);
  console.log(`Your Balance: ${ethers.formatUnits(balance, 18)} ${symbol}`);
  console.log("");
  console.log("Mining State:");
  console.log(`  Era: ${state.era.toString()}`);
  console.log(`  Reward: ${ethers.formatUnits(state.reward, 18)} ${symbol}`);
  console.log(`  Difficulty: ${state.difficulty.toString()}`);
  console.log(`  Minted: ${state.minted.toString()}`);
  console.log(`  Remaining: ${state.remaining.toString()}`);
  console.log(`  Epoch: ${state.epoch.toString()}`);
  console.log(`  Epoch Blocks Left: ${state.epochBlocksLeft_.toString()}`);
  console.log("");
  console.log("Your Challenge:", challenge);

  // ETH balance
  const ethBal = await provider.getBalance(wallet.address);
  console.log(`\nETH Balance: ${ethers.formatEther(ethBal)} ETH`);
}

main().catch((err) => {
  console.error(err.shortMessage || err.message || err);
  process.exit(1);
});
