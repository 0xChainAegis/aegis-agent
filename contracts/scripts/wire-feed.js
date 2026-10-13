/**
 * One-time wiring: point a token at its Chainlink Data Feed.
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
    WETH: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
    ETH_USD: "0x694AA1769357215DE4FAC081bf1f309aDC325306",
  },
};

async function main() {
  const oracleAddress = process.env.ORACLE_ADDRESS;
  if (!oracleAddress) throw new Error("set ORACLE_ADDRESS in .env");

  const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
  const cfg = FEEDS[chainId];
  if (!cfg) throw new Error("no feed config for this chain");

  const oracle = await hre.ethers.getContractAt("AegisPriceOracle", oracleAddress);

  const tx = await oracle.setFeed(cfg.WETH, cfg.ETH_USD, 18);
  await tx.wait();
  console.log("Wired WETH -> ETH/USD feed:", cfg.ETH_USD);

  // Sanity check: USD value of 0.01 WETH (answer is 8-decimal USD).
  const usd = await oracle.getUsdValue(cfg.WETH, hre.ethers.parseEther("0.01"));
  console.log("0.01 WETH =", (Number(usd) / 1e8).toFixed(2), "USD");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
