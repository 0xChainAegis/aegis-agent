const { expect } = require("chai");
const { ethers } = require("hardhat");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

const USD = 1_000_000n;
const ETH3 = ethers.parseEther("0.001");
const ETH6 = ethers.parseEther("0.002");
const ETH9 = ethers.parseEther("0.003");

describe("AegisPolicyEngine unified policy", function () {
  async function fixture() {
    const [owner, agent, recipient, other] = await ethers.getSigners();
    const acl = await ethers.deployContract("AegisAccessControl", [owner.address, agent.address]);
    const feed = await ethers.deployContract("MockV3Aggregator", [8, ethers.parseUnits("3000", 8)]);
    const oracle = await ethers.deployContract("AegisPriceOracle", [owner.address]);
    await oracle.setFeed(ethers.ZeroAddress, await feed.getAddress(), 18);
    await oracle.lockConfiguration();
    const policy = await ethers.deployContract("AegisPolicyEngine", [owner.address, await acl.getAddress()]);
    const consumerA = await ethers.deployContract("PolicyConsumerHarness");
    const consumerB = await ethers.deployContract("PolicyConsumerHarness");
    await policy.setConsumer(await consumerA.getAddress(), true);
    await policy.setConsumer(await consumerB.getAddress(), true);
    await policy.configurePolicy(await oracle.getAddress(), 5n * USD, 10n * USD, 15n * USD, 3600);
    await policy.setRecipientAllowed(recipient.address, true);
    return { owner, agent, recipient, other, acl, oracle, policy, consumerA, consumerB };
  }

  async function request(policy, agent, recipient, amount = ETH3, changes = {}) {
    const block = await ethers.provider.getBlock("latest");
    return {
      actionType: 0,
      actor: agent.address,
      recipient: recipient.address,
      asset: ethers.ZeroAddress,
      amount,
      maxUsdCost6: 10n * USD,
      deadline: block.timestamp + 1800,
      policyVersion: await policy.policyVersion(),
      requestHash: ethers.keccak256(ethers.randomBytes(32)),
      destinationChainSelector: 0,
      ...changes,
    };
  }

  it("returns ALLOW, REQUIRE_APPROVAL, and deterministic REJECT reasons", async function () {
    const { agent, recipient, other, policy } = await fixture();
    expect((await policy.evaluate(await request(policy, agent, recipient, ETH3))).decision).to.equal(1);
    expect((await policy.evaluate(await request(policy, agent, recipient, ETH6))).decision).to.equal(2);

    const blocked = await policy.evaluate(await request(policy, agent, recipient, ETH3, { recipient: other.address }));
    expect(blocked.decision).to.equal(0);
    expect(ethers.decodeBytes32String(blocked.reasonCode)).to.equal("RECIPIENT_NOT_ALLOWED");

    const unsupported = await policy.evaluate(await request(policy, agent, recipient, ETH3, { actionType: 1 }));
    expect(unsupported.decision).to.equal(0);
    expect(ethers.decodeBytes32String(unsupported.reasonCode)).to.equal("UNSUPPORTED_ACTION");
  });

  it("allows only registered contracts to consume and requires owner approval when indicated", async function () {
    const { agent, recipient, policy, consumerA } = await fixture();
    const approval = await request(policy, agent, recipient, ETH6);
    await expect(policy.validateAndConsume(approval, true)).to.be.revertedWith("UNAUTHORIZED_CONSUMER");
    await expect(consumerA.consume(policy, approval, false)).to.be.revertedWith("OWNER_APPROVAL_REQUIRED");
    await expect(consumerA.consume(policy, approval, true))
      .to.emit(policy, "BudgetConsumed")
      .withArgs(approval.requestHash, 0, agent.address, 2, 6n * USD, anyValue, 6n * USD);
    expect((await policy.spendingToday()).spentUsd6).to.equal(6n * USD);
  });

  it("shares one atomic daily budget across consumers and rejects replay", async function () {
    const { agent, recipient, policy, consumerA, consumerB } = await fixture();
    const first = await request(policy, agent, recipient, ETH9);
    await consumerA.consume(policy, first, true);
    expect(await policy.consumedRequests(first.requestHash)).to.equal(true);
    await expect(consumerA.consume(policy, first, true)).to.be.revertedWith("REQUEST_ALREADY_CONSUMED");

    const second = await request(policy, agent, recipient, ETH9);
    await expect(consumerB.consume(policy, second, true)).to.be.revertedWith("DAILY_LIMIT");
    expect((await policy.spendingToday()).spentUsd6).to.equal(9n * USD);
  });

  it("rolls back consumed hashes and budget when the execution transaction reverts", async function () {
    const { agent, recipient, policy, consumerA } = await fixture();
    const current = await request(policy, agent, recipient, ETH3);
    await expect(consumerA.consumeThenRevert(policy, current)).to.be.revertedWith("AFTER_CONSUME");
    expect(await policy.consumedRequests(current.requestHash)).to.equal(false);
    expect((await policy.spendingToday()).spentUsd6).to.equal(0);
  });
});
