const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("AegisTestnetPriceFeed", function () {
  it("exposes an AggregatorV3-compatible positive test valuation", async function () {
    const [owner] = await ethers.getSigners();
    const feed = await ethers.deployContract("AegisTestnetPriceFeed", [owner.address, 100_000_000]);
    await feed.waitForDeployment();
    const round = await feed.latestRoundData();
    expect(await feed.decimals()).to.equal(8);
    expect(await feed.description()).to.equal("AEGIS TESTNET CCIP-BnM / USD");
    expect(round[0]).to.equal(1);
    expect(round[1]).to.equal(100_000_000);
    expect(round[3]).to.be.greaterThan(0);
    expect(round[4]).to.equal(round[0]);
  });

  it("allows only the Owner to refresh a positive answer", async function () {
    const [owner, outsider] = await ethers.getSigners();
    const feed = await ethers.deployContract("AegisTestnetPriceFeed", [owner.address, 100_000_000]);
    await expect(feed.connect(outsider).updateAnswer(200_000_000))
      .to.be.revertedWithCustomError(feed, "OwnableUnauthorizedAccount");
    await expect(feed.updateAnswer(0)).to.be.revertedWith("BAD_ANSWER");
    await expect(feed.updateAnswer(200_000_000)).to.emit(feed, "TestnetAnswerUpdated");
    expect((await feed.latestRoundData())[1]).to.equal(200_000_000);
  });

  it("rejects an empty or negative initial valuation", async function () {
    await expect(ethers.deployContract("AegisTestnetPriceFeed", [(await ethers.getSigners())[0].address, 0]))
      .to.be.revertedWith("BAD_ANSWER");
    await expect(ethers.deployContract("AegisTestnetPriceFeed", [(await ethers.getSigners())[0].address, -1]))
      .to.be.revertedWith("BAD_ANSWER");
  });
});
