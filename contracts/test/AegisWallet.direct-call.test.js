const { expect } = require("chai");
const { ethers } = require("hardhat");

const USD = 1_000_000n;
const PRICE = ethers.parseUnits("3000", 8);
const ETH3 = ethers.parseEther("0.001"); // $3
const ETH6 = ethers.parseEther("0.002"); // $6

describe("AegisWallet direct-call boundaries", function () {
  async function deployFixture(vaultEth = "1") {
    const [owner, agent, recipient, other] = await ethers.getSigners();
    const acl = await ethers.deployContract("AegisAccessControl", [owner.address, agent.address]);
    const att = await ethers.deployContract("AegisAttestation", [owner.address, agent.address]);
    const feed = await ethers.deployContract("MockV3Aggregator", [8, PRICE]);
    const oracle = await ethers.deployContract("AegisPriceOracle", [owner.address]);
    const policy = await ethers.deployContract("AegisPolicyEngine", [owner.address, await acl.getAddress()]);
    const wallet = await ethers.deployContract("AegisWallet", [
      owner.address,
      await acl.getAddress(),
      await att.getAddress(),
      await policy.getAddress(),
    ]);
    await oracle.setFeed(ethers.ZeroAddress, await feed.getAddress(), 18);
    await oracle.lockConfiguration();
    await policy.setConsumer(await wallet.getAddress(), true);
    await policy.setPolicyManager(await wallet.getAddress(), true);
    await att.grantRole(await att.ATTESTER_ROLE(), await wallet.getAddress());
    await att.grantRole(await att.APPROVER_ROLE(), await wallet.getAddress());
    await wallet.configurePolicy(await oracle.getAddress(), 5n * USD, 10n * USD, 15n * USD, 3600);
    await wallet.setRecipientAllowed(recipient.address, true);
    await owner.sendTransaction({ to: await wallet.getAddress(), value: ethers.parseEther(vaultEth) });
    return { owner, agent, recipient, other, acl, att, feed, oracle, policy, wallet };
  }

  async function deadline() {
    return (await ethers.provider.getBlock("latest")).timestamp + 1800;
  }

  async function request(wallet, signer, recipient, amountWei, options = {}) {
    return wallet
      .connect(signer)
      .requestNativeTransfer(
        options.to || recipient.address,
        amountWei,
        options.max ?? 10n * USD,
        options.nonce ?? (await wallet.nextNonce(signer.address)),
        options.deadline ?? (await deadline()),
        options.version ?? (await wallet.policyVersion())
      );
  }

  it("blocks a direct request to a recipient that was never allowlisted", async function () {
    const { agent, other, att, wallet } = await deployFixture();

    await expect(
      request(wallet, agent, other, ETH3, { to: other.address })
    ).to.be.revertedWith("RECIPIENT_NOT_ALLOWED");

    expect(await wallet.nextNonce(agent.address)).to.equal(0n);
    expect(await att.nextId()).to.equal(1n);
    expect((await wallet.spendingToday()).spentUsd6).to.equal(0n);
  });

  it("does not treat the wallet owner as an agent for direct requests", async function () {
    const { owner, recipient, wallet } = await deployFixture();

    await expect(request(wallet, owner, recipient, ETH3)).to.be.revertedWith("NOT_AGENT");
    expect(await wallet.nextNonce(owner.address)).to.equal(0n);
  });

  it("rejects every invalid feed state at approval time without changing pending evidence", async function () {
    const anomalies = [
      [{ answer: 0n }, "ORACLE_BAD_ANSWER"],
      [{ answer: -1n }, "ORACLE_BAD_ANSWER"],
      [{ round: 5, answered: 4 }, "ORACLE_INCOMPLETE_ROUND"],
      [{ future: 1000 }, "ORACLE_BAD_TIMESTAMP"],
      [{ decimals: 18 }, "ORACLE_DECIMALS_CHANGED"],
    ];

    for (const [mutation, reason] of anomalies) {
      const { agent, recipient, att, feed, wallet } = await deployFixture();
      await request(wallet, agent, recipient, ETH6); // $6 > $5 automatic threshold -> queued
      const recipientBefore = await ethers.provider.getBalance(recipient.address);

      if (mutation.decimals) {
        await feed.updateAnswer(PRICE);
        await feed.setDecimals(mutation.decimals);
      } else {
        const now = (await ethers.provider.getBlock("latest")).timestamp;
        const timestamp = now + (mutation.future || 0);
        await feed.updateRoundData(
          mutation.round ?? 5,
          mutation.answer ?? PRICE,
          timestamp,
          timestamp,
          mutation.answered ?? 5
        );
      }

      await expect(wallet.approveAndExecute(1)).to.be.revertedWith(reason);

      // A rejected approval must not consume the queued nonce, spend budget,
      // move funds, or leave a false "approved" execution signal.
      expect((await wallet.pending(1)).exists).to.equal(true);
      expect((await att.records(1)).approved).to.equal(false);
      expect(await ethers.provider.getBalance(recipient.address)).to.equal(recipientBefore);
      expect((await wallet.spendingToday()).spentUsd6).to.equal(0n);
      expect(await wallet.nextNonce(agent.address)).to.equal(1n);
    }
  });
});
