const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const USD = 1_000_000n;
const AMOUNT = ethers.parseEther("0.001");

describe("Finite subscriptions (shared policy)", function () {
  let owner, agent, recipient, other, acl, att, feed, oracle, policy, wallet, start;
  beforeEach(async function () {
    [owner, agent, recipient, other] = await ethers.getSigners();
    acl = await ethers.deployContract("AegisAccessControl", [owner.address, agent.address]);
    att = await ethers.deployContract("AegisAttestation", [owner.address, agent.address]);
    feed = await ethers.deployContract("MockV3Aggregator", [8, ethers.parseUnits("3000", 8)]);
    oracle = await ethers.deployContract("AegisPriceOracle", [owner.address]);
    policy = await ethers.deployContract("AegisPolicyEngine", [owner.address, await acl.getAddress()]);
    wallet = await ethers.deployContract("AegisWallet", [owner.address, await acl.getAddress(), await att.getAddress(), await policy.getAddress()]);
    await oracle.setFeed(ethers.ZeroAddress, await feed.getAddress(), 18);
    await oracle.lockConfiguration();
    await policy.setConsumer(await wallet.getAddress(), true);
    await policy.setPolicyManager(await wallet.getAddress(), true);
    await att.grantRole(await att.ATTESTER_ROLE(), await wallet.getAddress());
    await att.grantRole(await att.APPROVER_ROLE(), await wallet.getAddress());
    await wallet.configurePolicy(await oracle.getAddress(), 5n * USD, 10n * USD, 15n * USD, 3600);
    await wallet.setRecipientAllowed(recipient.address, true);
    await owner.sendTransaction({ to: await wallet.getAddress(), value: ethers.parseEther("1") });
    start = (await ethers.provider.getBlock("latest")).timestamp;
  });
  const parentHash = ethers.id("parent");
  const childHash = ethers.id("current occurrence confirmation");
  async function configure() { await wallet.configureSubscriptionPolicy(10n * USD, 10000, 10); }
  async function create(changes = {}) {
    return wallet.createFiniteSubscription(agent.address, changes.to ?? recipient.address,
      changes.amount ?? AMOUNT, 100, start, changes.endAt ?? start + 1000,
      changes.maxPayments ?? 3, changes.cap ?? 5n * USD, parentHash);
  }
  async function args(occurrence = 0, changes = {}) {
    return [1, occurrence, changes.max ?? 10n * USD, changes.nonce ?? await wallet.nextNonce(agent.address),
      changes.deadline ?? start + 1800, changes.version ?? await wallet.policyVersion(), changes.hash ?? childHash];
  }
  async function pay(occurrence = 0, changes = {}) {
    return wallet.connect(agent).requestSubscriptionPayment(...await args(occurrence, changes));
  }
  async function at(timestamp) {
    await network.provider.send("evm_setNextBlockTimestamp", [timestamp]);
    await network.provider.send("evm_mine");
  }
  it("registers a finite plan and pays ETH through kind=1 shared policy evidence", async function () {
    await configure();
    await expect(create()).to.emit(wallet, "FiniteSubscriptionCreated").withArgs(1, agent.address, recipient.address, parentHash);
    const p = await args();
    const hash = await wallet.hashSubscriptionRequest(agent.address, ...p);
    const balance = await ethers.provider.getBalance(recipient.address);
    const tx = await pay();
    await expect(tx).to.emit(wallet, "SubscriptionPaymentExecuted");
    const receipt = await tx.wait();
    const budget = receipt.logs.map(l => { try { return policy.interface.parseLog(l); } catch { return null; } }).find(l => l?.name === "BudgetConsumed");
    expect(budget.args.requestHash).to.equal(hash);
    expect(budget.args.actionType).to.equal(1);
    expect(budget.args.costUsd6).to.equal(3n * USD);
    expect(await ethers.provider.getBalance(recipient.address)).to.equal(balance + AMOUNT);
    expect((await wallet.subscriptions(1)).paidCount).to.equal(1);
    expect((await wallet.spendingToday()).spentUsd6).to.equal(3n * USD);
    expect(await wallet.nextNonce(agent.address)).to.equal(1);
  });
  it("rejects a current occurrence whose principal exceeds period USD cap", async function () {
    await configure(); await create({ cap: 2n * USD });
    await expect(pay()).to.be.revertedWith("PERIOD_LIMIT");
    expect((await wallet.subscriptions(1)).paidCount).to.equal(0);
    expect(await wallet.nextNonce(agent.address)).to.equal(0);
    expect((await wallet.spendingToday()).spentUsd6).to.equal(0);
  });
  it("stops directly at exclusive expiry without a maintenance transaction", async function () {
    await configure(); await create(); await at(start + 1000);
    await expect(pay(10)).to.be.revertedWith("SUBSCRIPTION_EXPIRED");
    expect((await wallet.subscriptions(1)).paidCount).to.equal(0);
  });
  it("cancels permanently and prevents already queued approval from executing", async function () {
    await configure(); await create({ amount: ethers.parseEther("0.002"), cap: 10n * USD });
    await expect(pay()).to.emit(wallet, "SubscriptionPaymentQueued");
    expect((await wallet.subscriptionPending(1)).subscriptionId).to.equal(1);
    await wallet.cancelFiniteSubscription(1);
    await expect(wallet.approveAndExecute(1)).to.be.revertedWith("SUBSCRIPTION_CANCELLED");
    await expect(pay()).to.be.revertedWith("SUBSCRIPTION_CANCELLED");
    expect((await wallet.spendingToday()).spentUsd6).to.equal(0);
    expect((await wallet.pending(1)).exists).to.equal(true);
  });
  it("pauses and resumes without shifting expiry or reviving cancellation", async function () {
    await configure(); await create();
    await wallet.pauseFiniteSubscription(1, true);
    await expect(pay()).to.be.revertedWith("SUBSCRIPTION_PAUSED");
    await wallet.pauseFiniteSubscription(1, false);
    await pay();
    await wallet.cancelFiniteSubscription(1);
    await expect(wallet.pauseFiniteSubscription(1, false)).to.be.revertedWith("SUBSCRIPTION_CANCELLED");
    expect((await wallet.subscriptions(1)).endAt).to.equal(start + 1000);
  });
  it("accepts only the current window, never replays paid or skipped occurrences, and stops at maxPayments", async function () {
    await configure(); await create({ maxPayments: 2 });
    await pay();
    await expect(pay()).to.be.revertedWith("PERIOD_ALREADY_PAID");
    await expect(pay(1)).to.be.revertedWith("NOT_DUE");
    await at(start + 200);
    await expect(pay(1)).to.be.revertedWith("NOT_DUE");
    await pay(2);
    await at(start + 300);
    await expect(pay(3)).to.be.revertedWith("PAYMENT_COUNT_REACHED");
    expect((await wallet.subscriptions(1)).paidCount).to.equal(2);
  });
  it("fails closed when subscription policy was not explicitly configured", async function () {
    await expect(create()).to.be.revertedWith("SUBSCRIPTIONS_NOT_CONFIGURED");
  });
  it("requires both finite end and count, positive duration/cap, nonempty parent and authorized agent/recipient", async function () {
    await configure();
    await expect(create({ endAt: start })).to.be.revertedWith("BAD_SUBSCRIPTION_BOUNDS");
    await expect(create({ maxPayments: 0 })).to.be.revertedWith("BAD_SUBSCRIPTION_BOUNDS");
    await expect(create({ maxPayments: 11 })).to.be.revertedWith("BAD_SUBSCRIPTION_BOUNDS");
    await expect(create({ endAt: start + 10001 })).to.be.revertedWith("BAD_SUBSCRIPTION_BOUNDS");
    await expect(create({ cap: 0n })).to.be.revertedWith("BAD_SUBSCRIPTION_BOUNDS");
    await expect(create({ cap: 11n * USD })).to.be.revertedWith("BAD_SUBSCRIPTION_BOUNDS");
    await expect(create({ amount: 0n })).to.be.revertedWith("ZERO_AMOUNT");
    await expect(create({ to: other.address })).to.be.revertedWith("RECIPIENT_NOT_ALLOWED");
    await expect(wallet.createFiniteSubscription(agent.address, recipient.address, AMOUNT, 0, start, start + 1000, 3, USD, parentHash)).to.be.revertedWith("BAD_SUBSCRIPTION_BOUNDS");
    await expect(wallet.createFiniteSubscription(agent.address, recipient.address, AMOUNT, 100, start, start + 1000, 3, USD, ethers.ZeroHash)).to.be.revertedWith("EMPTY_PLAN_HASH");
    await expect(wallet.createFiniteSubscription(other.address, recipient.address, AMOUNT, 100, start, start + 1000, 3, USD, parentHash)).to.be.revertedWith("NOT_AGENT");
    await acl.setTier(agent.address, 0, 0);
    await expect(create()).to.be.revertedWith("TIER_BLOCKED");
  });
  it("requires a nonempty per-occurrence plan hash and cleans metadata on pending cancellation", async function () {
    await configure(); await create({ amount: ethers.parseEther("0.002"), cap: 10n * USD });
    await expect(pay(0, { hash: ethers.ZeroHash })).to.be.revertedWith("EMPTY_PLAN_HASH");
    await pay();
    await expect(wallet.cancelPending(1)).to.emit(wallet, "NativeTransferCancelled");
    expect((await wallet.subscriptionPending(1)).subscriptionId).to.equal(0);
    expect((await wallet.pending(1)).exists).to.equal(false);
    await expect(pay(0, { nonce: 0 })).to.be.revertedWith("NONCE_MISMATCH");
    expect((await wallet.subscriptions(1)).paidCount).to.equal(0);
  });
  it("applies newly tightened subscription limits to previously created plans", async function () {
    await configure(); await create();
    await wallet.configureSubscriptionPolicy(2n * USD, 10000, 10);
    await expect(pay()).to.be.revertedWith("SUBSCRIPTION_POLICY_LIMIT");
  });
  it("previews the same quote and executes owner-approved payments with exact correlated event fields", async function () {
    await configure(); await create({ amount: ethers.parseEther("0.002"), cap: 10n * USD });
    const p = await args();
    const preview = await wallet.previewSubscriptionPayment(agent.address, p[0], p[1], p[2], p[4], p[5]);
    expect(preview.costUsd6).to.equal(6n * USD); expect(preview.requiresApproval).to.equal(true);
    const hash = await wallet.hashSubscriptionRequest(agent.address, ...p);
    await expect(pay()).to.emit(wallet, "SubscriptionPaymentQueued").withArgs(hash, 1, agent.address, recipient.address, ethers.parseEther("0.002"), p[2], p[4], p[5], 1, 0, childHash);
    expect((await policy.spendingToday()).spentUsd6).to.equal(0);
    await expect(wallet.connect(agent).approveAndExecute(1)).to.be.revertedWithCustomError(wallet, "OwnableUnauthorizedAccount");
    const tx = await wallet.approveAndExecute(1);
    const receipt = await tx.wait();
    const e = receipt.logs.map(l => { try { return wallet.interface.parseLog(l); } catch { return null; } }).find(l => l?.name === "SubscriptionPaymentExecuted");
    expect(e.args.requestHash).to.equal(hash); expect(e.args.attestationId).to.equal(1);
    expect(e.args.agent).to.equal(agent.address); expect(e.args.to).to.equal(recipient.address);
    expect(e.args.amountWei).to.equal(ethers.parseEther("0.002")); expect(e.args.costUsd6).to.equal(6n * USD);
    expect(e.args.roundId).to.equal(1); expect(e.args.updatedAt).to.be.greaterThan(0);
    expect(e.args.policyVersion).to.equal(p[5]); expect(e.args.subscriptionId).to.equal(1);
    expect(e.args.occurrenceIndex).to.equal(0); expect(e.args.planHash).to.equal(childHash);
    expect((await wallet.pending(1)).exists).to.equal(false);
    expect((await wallet.subscriptionPending(1)).subscriptionId).to.equal(0);
    expect((await att.records(1)).approved).to.equal(true);
    await expect(wallet.approveAndExecute(1)).to.be.revertedWith("NO_PENDING");
  });
  it("shares daily accounting and nonces across native and subscription requests", async function () {
    await configure(); await create({ cap: 10n * USD });
    await wallet.configurePolicy(await oracle.getAddress(), 10n * USD, 10n * USD, 10n * USD, 3600);
    await wallet.connect(agent).requestNativeTransfer(recipient.address, ethers.parseEther("0.003"), 10n * USD, 0, start + 1800, await wallet.policyVersion());
    await expect(pay(0, { nonce: 0 })).to.be.revertedWith("NONCE_MISMATCH");
    await expect(pay()).to.be.revertedWith("DAILY_LIMIT");
    expect((await wallet.spendingToday()).spentUsd6).to.equal(9n * USD);
    expect(await wallet.nextNonce(agent.address)).to.equal(1);
    expect((await wallet.subscriptions(1)).paidCount).to.equal(0);
  });
  it("revalidates pause, window, version, tier, price and hard caps at approval", async function () {
    await configure(); await create({ amount: ethers.parseEther("0.002"), cap: 6n * USD }); await pay();
    await wallet.pauseFiniteSubscription(1, true);
    await expect(wallet.approveAndExecute(1)).to.be.revertedWith("SUBSCRIPTION_PAUSED");
    await wallet.pauseFiniteSubscription(1, false);
    await acl.setTier(agent.address, 0, 0);
    await expect(wallet.approveAndExecute(1)).to.be.revertedWith("TIER_BLOCKED");
    await acl.setTier(agent.address, 2, 0);
    await feed.updateAnswer(ethers.parseUnits("3500", 8));
    await expect(wallet.approveAndExecute(1)).to.be.revertedWith("PERIOD_LIMIT");
    await feed.updateAnswer(ethers.parseUnits("6000", 8));
    await expect(wallet.approveAndExecute(1)).to.be.revertedWith("QUOTE_EXCEEDS_MAX");
    await feed.updateAnswer(ethers.parseUnits("3000", 8));
    await at(start + 100);
    await expect(wallet.approveAndExecute(1)).to.be.revertedWith("NOT_DUE");
    await pay(1);
    await wallet.configureSubscriptionPolicy(10n * USD, 10000, 10);
    await expect(wallet.approveAndExecute(2)).to.be.revertedWith("POLICY_VERSION_MISMATCH");
    expect((await wallet.spendingToday()).spentUsd6).to.equal(0);
  });
  it("fails closed stale oracle and revocation but controls remain oracle-independent", async function () {
    await configure(); await create();
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    await feed.updateRoundData(5, ethers.parseUnits("3000", 8), now - 3601, now - 3601, 5);
    await expect(pay()).to.be.revertedWith("ORACLE_STALE");
    await wallet.pauseFiniteSubscription(1, true); await wallet.pauseFiniteSubscription(1, false);
    await feed.updateAnswer(ethers.parseUnits("3000", 8));
    await acl.revokeRole(await acl.AGENT_ROLE(), agent.address);
    await expect(pay()).to.be.revertedWith("NOT_AGENT");
    await wallet.cancelFiniteSubscription(1);
    expect((await wallet.subscriptions(1)).cancelled).to.equal(true);
  });
  it("prevents non-owner registration/controls and unauthorized direct engine consumption", async function () {
    await configure(); await create();
    await expect(wallet.connect(agent).createFiniteSubscription(agent.address, recipient.address, AMOUNT, 100, start, start + 1000, 3, USD, parentHash)).to.be.revertedWithCustomError(wallet, "OwnableUnauthorizedAccount");
    await expect(wallet.connect(agent).pauseFiniteSubscription(1, true)).to.be.revertedWithCustomError(wallet, "OwnableUnauthorizedAccount");
    await expect(wallet.connect(agent).cancelFiniteSubscription(1)).to.be.revertedWithCustomError(wallet, "OwnableUnauthorizedAccount");
    await expect(policy.connect(agent).configureSubscriptionPolicy(USD, 100, 1)).to.be.revertedWith("NOT_POLICY_MANAGER");
    await expect(policy.connect(agent).pauseSubscriptionRecord(1, true)).to.be.revertedWith("UNAUTHORIZED_CONSUMER");
    await expect(policy.connect(agent).cancelSubscriptionRecord(1)).to.be.revertedWith("UNAUTHORIZED_CONSUMER");
    const request = { actionType: 1, actor: agent.address, recipient: recipient.address, asset: ethers.ZeroAddress, amount: AMOUNT, maxUsdCost6: 10n * USD, deadline: start + 1800, policyVersion: await wallet.policyVersion(), requestHash: childHash, destinationChainSelector: 0 };
    expect(ethers.decodeBytes32String((await policy.evaluate(request)).reasonCode)).to.equal("UNSUPPORTED_ACTION");
    await expect(policy.validateAndConsumeSubscription(request, 1, 0, true)).to.be.revertedWith("UNAUTHORIZED_CONSUMER");
    await expect(wallet.connect(other).requestSubscriptionPayment(...await args())).to.be.revertedWith("SUBSCRIPTION_CONTEXT_MISMATCH");
  });
  it("rolls back nonce, occurrence, budget and attestation if ETH receiver rejects", async function () {
    const receiver = await ethers.deployContract("AdversarialReceiver");
    await wallet.setRecipientAllowed(await receiver.getAddress(), true);
    await configure(); await create({ to: await receiver.getAddress() });
    await receiver.configure(true, ethers.ZeroAddress, "0x");
    const p = await args(); const hash = await wallet.hashSubscriptionRequest(agent.address, ...p);
    await expect(pay()).to.be.revertedWith("NATIVE_TRANSFER_FAILED");
    expect(await wallet.nextNonce(agent.address)).to.equal(0);
    expect((await wallet.subscriptions(1)).paidCount).to.equal(0);
    expect((await policy.spendingToday()).spentUsd6).to.equal(0);
    expect(await policy.consumedRequests(hash)).to.equal(false);
    expect(await att.nextId()).to.equal(1);
    await receiver.configure(false, await wallet.getAddress(), wallet.interface.encodeFunctionData("requestSubscriptionPayment", p));
    await pay();
    expect(await receiver.attempted()).to.equal(true); expect(await receiver.reentrySucceeded()).to.equal(false);
    expect((await wallet.subscriptions(1)).paidCount).to.equal(1);
  });
  it("binds domain and every per-payment field without changing native hashing", async function () {
    await configure(); await create();
    const p = await args(); const hash = await wallet.hashSubscriptionRequest(agent.address, ...p);
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256", "address", "address", "uint64", "uint64", "uint256", "uint256", "uint64", "uint64", "bytes32"], [ethers.id("aegis.subscription-payment.v1"), chainId, await wallet.getAddress(), agent.address, ...p]);
    expect(hash).to.equal(ethers.keccak256(encoded));
    for (let i = 0; i < p.length; i++) {
      const q = [...p]; q[i] = i === 6 ? ethers.id("different confirmation") : BigInt(q[i]) + 1n;
      expect(await wallet.hashSubscriptionRequest(agent.address, ...q)).not.to.equal(hash);
    }
    expect(await wallet.hashSubscriptionRequest(other.address, ...p)).not.to.equal(hash);
  });
  it("emits auditable subscription policy changes while invalid values cannot change version", async function () {
    const version = await wallet.policyVersion();
    await expect(wallet.configureSubscriptionPolicy(0, 100, 1)).to.be.revertedWith("BAD_SUBSCRIPTION_LIMITS");
    await expect(wallet.configureSubscriptionPolicy(USD, 0, 1)).to.be.revertedWith("BAD_SUBSCRIPTION_LIMITS");
    await expect(wallet.configureSubscriptionPolicy(USD, 100, 0)).to.be.revertedWith("BAD_SUBSCRIPTION_LIMITS");
    expect(await wallet.policyVersion()).to.equal(version);
    await expect(wallet.configureSubscriptionPolicy(10n * USD, 10000, 10)).to.emit(policy, "SubscriptionPolicyConfigured").withArgs(version + 1n, 10n * USD, 10000, 10);
  });
  it("only consumes one competing queued payment per window and expiry blocks approval", async function () {
    await configure(); await create({ amount: ethers.parseEther("0.002"), cap: 10n * USD });
    await pay(); await pay();
    await wallet.approveAndExecute(1);
    await expect(wallet.approveAndExecute(2)).to.be.revertedWith("PERIOD_ALREADY_PAID");
    expect((await wallet.pending(2)).exists).to.equal(true);
    await at(start + 100); await pay(1);
    await at(start + 1000);
    await expect(wallet.approveAndExecute(3)).to.be.revertedWith("SUBSCRIPTION_EXPIRED");
    expect((await wallet.subscriptions(1)).paidCount).to.equal(1);
  });
  it("keeps occurrence replay protection across UTC midnight while daily budget rolls", async function () {
    await at(Math.floor(start / 86400 + 1) * 86400 - 30);
    start = (await ethers.provider.getBlock("latest")).timestamp;
    await feed.updateAnswer(ethers.parseUnits("3000", 8));
    await configure(); await create(); await pay();
    await at(Math.floor(start / 86400 + 1) * 86400);
    expect((await wallet.spendingToday()).spentUsd6).to.equal(0);
    await expect(pay()).to.be.revertedWith("PERIOD_ALREADY_PAID");
    await at(start + 100); await pay(1);
    expect((await wallet.spendingToday()).spentUsd6).to.equal(3n * USD);
  });
  it("blocks pre-start payments and requests whose deadline expired", async function () {
    await configure(); start += 100; await create();
    await expect(pay()).to.be.revertedWith("NOT_DUE");
    await at(start);
    await expect(pay(0, { deadline: start - 1 })).to.be.revertedWith("REQUEST_EXPIRED");
    await pay();
  });
  it("requires HighRisk approval even below soft threshold and rechecks stale price on approval", async function () {
    await configure(); await create(); await acl.setTier(agent.address, 3, 0);
    await expect(pay()).to.emit(wallet, "SubscriptionPaymentQueued");
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    await feed.updateRoundData(5, ethers.parseUnits("3000", 8), now - 3601, now - 3601, 5);
    await expect(wallet.approveAndExecute(1)).to.be.revertedWith("ORACLE_STALE");
    await feed.updateAnswer(ethers.parseUnits("3000", 8));
    await wallet.approveAndExecute(1);
    expect((await wallet.spendingToday()).spentUsd6).to.equal(3n * USD);
  });
});
