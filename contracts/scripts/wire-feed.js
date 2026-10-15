/**
 * One-time wiring: lock native ETH to its Chainlink Data Feed.
 *
 *   ORACLE_ADDRESS=<AegisPriceOracle address> npx hardhat run scripts/wire-feed.js --network sepolia
 *
 * Verify every address on https://docs.chain.link/data-feeds/price-feeds/addresses
 * before using; feeds are network specific.
 */
const hre = require("hardhat");

const FEEDS = {
  11155111: {
    // Ethereum Sepolia
    ETH_USD: "0x694AA1769357215DE4FAC081bf1f309aDC325306",
  },
};

async function main() {
  const oracleAddress = process.env.ORACLE_ADDRESS;
  if (!oracleAddress) throw new Error("export ORACLE_ADDRESS in the process environment");

  const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
  const cfg = FEEDS[chainId];
  if (!cfg) throw new Error("no feed config for this chain");

  const oracle = await hre.ethers.getContractAt("AegisPriceOracle", oracleAddress);

  const tx = await oracle.setFeed(hre.ethers.ZeroAddress, cfg.ETH_USD, 18);
  await tx.wait();
  await (await oracle.lockConfiguration()).wait();
  console.log("Locked native ETH -> ETH/USD feed:", cfg.ETH_USD);

  const quote = await oracle.latestEthQuote(hre.ethers.parseEther("0.01"));
  console.log("0.01 ETH =", hre.ethers.formatUnits(quote.costUsd6, 6), "USD");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
