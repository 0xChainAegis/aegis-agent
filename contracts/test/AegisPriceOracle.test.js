const { expect } = require("chai");
const { ethers } = require("hardhat");

const ONE_WEI = 1n;
const SMALL = ethers.parseEther("0.001");
const ODD = 1_234_567_890_123_456n; // 0.001234567890123456 ETH

// Independent BigInt expectation: ceil(amountWei * answer / 10^(12 + feedDecimals)).
// No Number math and no reuse of contract return values to derive expectations.
function expectedCostUsd6(amountWei, answer, decimals) {
  const denominator = 10n ** (12n + BigInt(decimals));
  return (amountWei * answer + denominator - 1n) / denominator;
}

async function deployLockedOracle(decimals) {
  const [owner] = await ethers.getSigners();
  const answer = 3000n * 10n ** BigInt(decimals); // $3,000 expressed in the feed's own decimals
  const feed = await ethers.deployContract("MockV3Aggregator", [decimals, answer]);
  const oracle = await ethers.deployContract("AegisPriceOracle", [owner.address]);
  await oracle.setFeed(ethers.ZeroAddress, await feed.getAddress(), 18);
  await oracle.lockConfiguration();
  return { feed, oracle, answer };
}

describe("AegisPriceOracle native quote boundaries", function () {
  it("quotes native ETH in USD6 across supported feed decimals with ceiling rounding", async function () {
    const decimalsList = [0, 6, 8, 18];
    const amounts = [ONE_WEI, SMALL, ODD];
    const costsByAmountIndex = amounts.map(() => []);

    for (const decimals of decimalsList) {
      const { feed, oracle, answer } = await deployLockedOracle(decimals);
      const feedRound = await feed.latestRoundData();

      for (let index = 0; index < amounts.length; index += 1) {
        const amountWei = amounts[index];
        const quote = await oracle.latestEthQuote(amountWei);
        const expected = expectedCostUsd6(amountWei, answer, decimals);

        expect(quote.costUsd6).to.equal(expected);
        expect(quote.costUsd6).to.be.greaterThan(0n); // tiny positive payments never truncate to zero
        expect(quote.answer).to.equal(answer);
        expect(quote.decimals).to.equal(decimals);
        expect(quote.roundId).to.equal(feedRound[0]);
        expect(quote.updatedAt).to.equal(feedRound[3]);
        costsByAmountIndex[index].push(quote.costUsd6);
      }
    }

    // The same economic price and ETH amount must agree across all supported feed scales.
    for (const costs of costsByAmountIndex) {
      const [first, ...rest] = costs;
      for (const cost of rest) expect(cost).to.equal(first);
    }
    // One wei still costs at least one USD6 unit.
    expect(costsByAmountIndex[0][0]).to.equal(1n);
  });

  it("rejects feed decimals above 18 before locking", async function () {
    const [owner] = await ethers.getSigners();
    const feed = await ethers.deployContract("MockV3Aggregator", [
      19,
      3000n * 10n ** 19n,
    ]);
    const oracle = await ethers.deployContract("AegisPriceOracle", [owner.address]);

    await expect(
      oracle.setFeed(ethers.ZeroAddress, await feed.getAddress(), 18)
    ).to.be.revertedWith("UNSUPPORTED_DECIMALS");
    expect(await oracle.configurationLocked()).to.equal(false);
  });
});
