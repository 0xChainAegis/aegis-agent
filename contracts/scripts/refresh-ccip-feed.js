// Owner-run helper for the testnet-only CCIP token valuation feed.
//
// AegisTestnetPriceFeed has no automatic updates. Once its answer is older than
// the policy engine's maxPriceAge, CCIP previews and executions revert with
// ORACLE_STALE until the Owner refreshes it. Default is a read-only check.
//
//   npx hardhat run scripts/refresh-ccip-feed.js --network sepolia
//   CCIP_FEED_REFRESH=1 npx hardhat run scripts/refresh-ccip-feed.js --network sepolia
//
// Optional: CCIP_TOKEN_PRICE_USD8 (8-decimal integer) sets a new value; otherwise the
// current answer is re-submitted unchanged.
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");

async function main() {
  const manifestPath = process.env.AEGIS_DEPLOYMENT_FILE || path.join(__dirname, "..", "deployments", "sepolia.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!manifest.ccipTokenFeedAddress) throw new Error("Deployment manifest has no ccipTokenFeedAddress");
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== BigInt(manifest.chainId)) {
    throw new Error(`Connected chain ${network.chainId} does not match manifest chain ${manifest.chainId}`);
  }

  const abi = [
    "function owner() view returns (address)",
    "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
    "function updateAnswer(int256 answer)",
  ];
  const [signer] = await ethers.getSigners();
  const feed = new ethers.Contract(manifest.ccipTokenFeedAddress, abi, signer);
  const [, answer, , updatedAt] = await feed.latestRoundData();
  const owner = await feed.owner();
  const ageSeconds = Math.floor(Date.now() / 1000) - Number(updatedAt);
  console.log(JSON.stringify({
    feed: manifest.ccipTokenFeedAddress, owner, signer: signer.address,
    answerUsd8: answer.toString(), updatedAt: Number(updatedAt), ageSeconds,
  }, null, 2));

  if (process.env.CCIP_FEED_REFRESH !== "1") {
    console.log("Read-only check. Set CCIP_FEED_REFRESH=1 to send updateAnswer.");
    return;
  }
  if (signer.address.toLowerCase() !== owner.toLowerCase()) {
    throw new Error("Configured signer is not the feed Owner; refusing to send");
  }
  const next = process.env.CCIP_TOKEN_PRICE_USD8 === undefined ? answer : BigInt(process.env.CCIP_TOKEN_PRICE_USD8);
  if (next <= 0n) throw new Error("Price must be a positive 8-decimal integer");
  const receipt = await (await feed.updateAnswer(next)).wait();
  console.log(JSON.stringify({ refreshed: true, answerUsd8: next.toString(), transactionHash: receipt.hash }));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
