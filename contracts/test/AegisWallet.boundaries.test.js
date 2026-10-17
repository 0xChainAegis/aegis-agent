const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const USD = 1_000_000n;
const PRICE = ethers.parseUnits("3000", 8);
const ETH45 = ethers.parseEther("0.0015"); // $4.50
const ETH6 = ethers.parseEther("0.002"); // $6.00
const MAX_PRICE_AGE = 60;

describe("AegisWallet approval boundaries", function () {
  async function deployFixture(vaultEth = "1") {
    const [owner, agent, recipient] = await ethers.getSigners();
    const acl = await ethers.deployContract("AegisAccessControl", [owner.address, agent.address]);
    const att = await ethers.deployContract("AegisAttestation", [owner.address, agent.address]);
    const feed = await ethers.deployContract("MockV3Aggregator", [8, PRICE]);
    const oracle = await ethers.deployContract("AegisPriceOracle", [owner.address]);
    const wallet = await ethers.deployContract("AegisWallet", [
      owner.address,
      await acl.getAddress(),
      await att.getAddress(),
    ]);
    await oracle.setFeed(ethers.ZeroAddress, await feed.getAddress(), 18);
    await oracle.lockConfiguration();
    await att.grantRole(await att.ATTESTER_ROLE(), await wallet.getAddress());
    await att.grantRole(await att.APPROVER_ROLE(), await wallet.getAddress());
    await wallet.configurePolicy(await oracle.getAddress(), 5n * USD, 10n * USD, 15n * USD, MAX_PRICE_AGE);
    await wallet.setRecipientAllowed(recipient.address, true);
    await owner.sendTransaction({ to: await wallet.getAddress(), value: ethers.parseEther(vaultEth) });
    return { owner, agent, recipient, acl, att, feed, oracle, wallet };
  }

  async function deadline() {
    return (await ethers.provider.getBlock("latest")).timestamp + 1800;
  }

  async function request(wallet, agent, recipient, amountWei, options = {}) {
    const signer = options.signer || agent;
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

  function findEvent(wallet, receipt, name) {
    return receipt.logs
      .map((log) => {
        try {
          return wallet.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((log) => log?.name === name);
  }

  it("rechecks stale feed on pending approval and recovers with a fresh round", async function () {
    const { agent, recipient, att, feed, wallet } = await deployFixture();

    await request(wallet, agent, recipient, ETH6); // $6 > $5 automatic threshold -> queued
    const pendingBefore = await wallet.pending(1);
    const recipientBefore = await ethers.provider.getBalance(recipient.address);
    const roundBefore = await feed.latestRoundData();

    // Precise next-block timestamp: feed age becomes 61s > maxPriceAge (60s). No real sleep.
    await network.provider.send("evm_setNextBlockTimestamp", [Number(roundBefore[3]) + 61]);
    await expect(wallet.approveAndExecute(1)).to.be.revertedWith("ORACLE_STALE");

    // The refusal must leave the queued request, nonce, budget and evidence untouched.
    const pendingAfter = await wallet.pending(1);
    expect(pendingAfter.exists).to.equal(true);
    expect(pendingAfter.amountWei).to.equal(pendingBefore.amountWei);
    expect(pendingAfter.requestHash).to.equal(pendingBefore.requestHash);
    expect((await att.records(1)).approved).to.equal(false);
    expect(await att.nextId()).to.equal(2n);
    expect(await ethers.provider.getBalance(recipient.address)).to.equal(recipientBefore);
    expect((await wallet.spendingToday()).spentUsd6).to.equal(0n);
    expect(await wallet.nextNonce(agent.address)).to.equal(1n);

    // Only the feed gains a fresh, same-price round; request and policy stay identical.
    await feed.updateAnswer(PRICE);
    const freshRound = await feed.latestRoundData();
    const tx = await wallet.approveAndExecute(1);
    await expect(tx).to.emit(wallet, "NativeTransferExecuted");
    const receipt = await tx.wait();
    const event = findEvent(wallet, receipt, "NativeTransferExecuted");

    expect(event.args.attestationId).to.equal(1n);
    expect(event.args.requestHash).to.equal(pendingBefore.requestHash);
    expect(event.args.roundId).to.equal(freshRound[0]);
    expect(event.args.updatedAt).to.equal(freshRound[3]);
    expect(event.args.costUsd6).to.equal(6n * USD);
    expect(await ethers.provider.getBalance(recipient.address)).to.equal(recipientBefore + ETH6);
    expect((await wallet.pending(1)).exists).to.equal(false);
    expect((await att.records(1)).approved).to.equal(true);
    expect((await wallet.spendingToday()).spentUsd6).to.equal(6n * USD);
    expect(await wallet.nextNonce(agent.address)).to.equal(1n); // no extra nonce from the failed approval

    await expect(wallet.approveAndExecute(1)).to.be.revertedWith("NO_PENDING");
  });

  it("treats age equal to maxPriceAge as fresh and one second older as stale", async function () {
    // Both branches mine real blocks at exactly the boundary timestamps; no eth_call clock guesswork.
    const fresh = await deployFixture();
    const freshRound = await fresh.feed.latestRoundData();
    await network.provider.send("evm_setNextBlockTimestamp", [
      Number(freshRound[3]) + MAX_PRICE_AGE,
    ]);
    await expect(request(fresh.wallet, fresh.agent, fresh.recipient, ETH6)).to.emit(
      fresh.wallet,
      "NativeTransferQueued"
    );
    expect((await fresh.wallet.pending(1)).exists).to.equal(true);

    const stale = await deployFixture();
    const staleRound = await stale.feed.latestRoundData();
    await network.provider.send("evm_setNextBlockTimestamp", [
      Number(staleRound[3]) + MAX_PRICE_AGE + 1,
    ]);
    await expect(
      request(stale.wallet, stale.agent, stale.recipient, ETH6)
    ).to.be.revertedWith("ORACLE_STALE");
    expect(await stale.wallet.nextNonce(stale.agent.address)).to.equal(0n);
  });

  it("keeps a queued payment pending when another payment consumes its ETH balance", async function () {
    const { owner, agent, recipient, att, wallet } = await deployFixture("0.003");
    const recipientBefore = await ethers.provider.getBalance(recipient.address);

    await request(wallet, agent, recipient, ETH6); // queued; pending does not reserve balance
    const pendingBefore = await wallet.pending(1);
    expect(await ethers.provider.getBalance(await wallet.getAddress())).to.equal(
      ethers.parseEther("0.003")
    );

    await request(wallet, agent, recipient, ETH45); // auto $4.50 consumes the vault first
    expect((await wallet.spendingToday()).spentUsd6).to.equal(4_500_000n);
    expect(await ethers.provider.getBalance(await wallet.getAddress())).to.equal(
      ethers.parseEther("0.0015")
    );

    // Daily budget is still sufficient; the blocking condition is the vault balance.
    await expect(wallet.approveAndExecute(1)).to.be.revertedWith("INSUFFICIENT_BALANCE");

    const pendingAfter = await wallet.pending(1);
    expect(pendingAfter.exists).to.equal(true);
    expect(pendingAfter.requestHash).to.equal(pendingBefore.requestHash);
    expect((await att.records(1)).approved).to.equal(false);
    expect(await ethers.provider.getBalance(recipient.address)).to.equal(recipientBefore + ETH45);
    expect((await wallet.spendingToday()).spentUsd6).to.equal(4_500_000n);
    expect(await wallet.nextNonce(agent.address)).to.equal(2n);

    // A real deposit restores the vault; the owner re-confirms the same queued request.
    await wallet.connect(owner).depositETH({ value: ethers.parseEther("0.001") });
    const tx = await wallet.approveAndExecute(1);
    await expect(tx).to.emit(wallet, "NativeTransferExecuted");
    expect(await ethers.provider.getBalance(recipient.address)).to.equal(
      recipientBefore + ETH45 + ETH6
    );
    expect((await wallet.pending(1)).exists).to.equal(false);
    expect((await att.records(1)).approved).to.equal(true);
    expect((await wallet.spendingToday()).spentUsd6).to.equal(10_500_000n);

    await expect(wallet.approveAndExecute(1)).to.be.revertedWith("NO_PENDING");
  });
});
