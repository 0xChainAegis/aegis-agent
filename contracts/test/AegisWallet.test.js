const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const USD = 1_000_000n;
const ETH3 = ethers.parseEther("0.001");
const ETH6 = ethers.parseEther("0.002");
const ETH9 = ethers.parseEther("0.003");

describe("AegisWallet native USD authorization", function () {
  let owner, agent, recipient, other, acl, att, feed, oracle, wallet;

  beforeEach(async function () {
    [owner, agent, recipient, other] = await ethers.getSigners();
    acl = await ethers.deployContract("AegisAccessControl", [owner.address, agent.address]);
    att = await ethers.deployContract("AegisAttestation", [owner.address, agent.address]);
    feed = await ethers.deployContract("MockV3Aggregator", [8, ethers.parseUnits("3000", 8)]);
    oracle = await ethers.deployContract("AegisPriceOracle", [owner.address]);
    wallet = await ethers.deployContract("AegisWallet", [owner.address, await acl.getAddress(), await att.getAddress()]);
    await oracle.setFeed(ethers.ZeroAddress, await feed.getAddress(), 18);
    await oracle.lockConfiguration();
    await att.grantRole(await att.ATTESTER_ROLE(), await wallet.getAddress());
    await att.grantRole(await att.APPROVER_ROLE(), await wallet.getAddress());
    await wallet.configurePolicy(await oracle.getAddress(), 5n * USD, 10n * USD, 15n * USD, 3600);
    await wallet.setRecipientAllowed(recipient.address, true);
    await owner.sendTransaction({ to: await wallet.getAddress(), value: ethers.parseEther("1") });
  });

  async function deadline() { return (await ethers.provider.getBlock("latest")).timestamp + 1800; }
  async function args(amount = ETH3, options = {}) {
    const signer = options.signer || agent;
    return [options.to || recipient.address, amount, options.max ?? 10n * USD,
      options.nonce ?? await wallet.nextNonce(signer.address), options.deadline ?? await deadline(),
      options.version ?? await wallet.policyVersion()];
  }
  async function request(amount = ETH3, options = {}) {
    return wallet.connect(options.signer || agent).requestNativeTransfer(...await args(amount, options));
  }
  async function setRound({ answer = ethers.parseUnits("3000", 8), age = 0, future = 0, round = 5, answered = 5, zeroTime = false } = {}) {
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const timestamp = zeroTime ? 0 : now - age + future;
    await feed.updateRoundData(round, answer, timestamp, timestamp, answered);
  }

  it("moves real ETH, binds the full intent and emits priced execution evidence", async function () {
    const parameters = await args(ETH3);
    const hash = await wallet.hashRequest(agent.address, parameters[0], parameters[1], parameters[2], parameters[3], parameters[4], parameters[5]);
    const before = await ethers.provider.getBalance(recipient.address);
    const tx = await wallet.connect(agent).requestNativeTransfer(...parameters);
    await expect(tx).to.emit(wallet, "NativeTransferExecuted");
    const receipt = await tx.wait();
    const event = receipt.logs.map((log) => { try { return wallet.interface.parseLog(log); } catch { return null; } }).find((log) => log?.name === "NativeTransferExecuted");
    expect(event.args.requestHash).to.equal(hash);
    expect(event.args.attestationId).to.equal(1);
    expect(event.args.costUsd6).to.equal(3n * USD);
    expect(event.args.roundId).to.equal(1);
    expect(event.args.policyVersion).to.equal(parameters[5]);
    expect(await ethers.provider.getBalance(recipient.address)).to.equal(before + ETH3);
    expect((await att.records(1)).actionHash).to.equal(hash);
    expect((await att.records(1)).approved).to.equal(true);
    expect((await wallet.spendingToday()).spentUsd6).to.equal(3n * USD);
    expect(await wallet.nextNonce(agent.address)).to.equal(1);
  });

  it("queues above the soft threshold, consumes nonce, then owner executes exact stored amount", async function () {
    const before = await ethers.provider.getBalance(recipient.address);
    await expect(request(ETH6)).to.emit(wallet, "NativeTransferQueued");
    expect((await wallet.pending(1)).amountWei).to.equal(ETH6);
    expect((await wallet.spendingToday()).spentUsd6).to.equal(0);
    expect(await wallet.nextNonce(agent.address)).to.equal(1);
    await request(ETH3); // A later valid nonce does not invalidate the queued nonce.
    await expect(wallet.connect(agent).approveAndExecute(1)).to.be.revertedWithCustomError(wallet, "OwnableUnauthorizedAccount");
    await expect(wallet.approveAndExecute(1)).to.emit(wallet, "NativeTransferExecuted");
    expect(await ethers.provider.getBalance(recipient.address)).to.equal(before + ETH3 + ETH6);
    expect((await wallet.pending(1)).exists).to.equal(false);
    await expect(wallet.approveAndExecute(1)).to.be.revertedWith("NO_PENDING");
  });

  it("requires approval for HighRisk even below the soft threshold", async function () {
    await acl.setTier(agent.address, 3, ethers.MaxUint256);
    const quote = await wallet.previewNativeTransfer(agent.address, recipient.address, ETH3, 3n * USD, await deadline(), await wallet.policyVersion());
    expect(quote.requiresApproval).to.equal(true);
    await expect(request()).to.emit(wallet, "NativeTransferQueued");
  });

  it("blocks non-agents, Frozen and ReadOnly before either queuing or payment", async function () {
    await expect(request(ETH3, { signer: other })).to.be.revertedWith("NOT_AGENT");
    for (const tier of [0, 1]) {
      await acl.setTier(agent.address, tier, ethers.MaxUint256);
      await expect(request(ETH6)).to.be.revertedWith("TIER_BLOCKED");
    }
    expect(await wallet.nextNonce(agent.address)).to.equal(0);
    expect(await att.nextId()).to.equal(1);
  });

  it("rechecks role and frozen tier on pending approval", async function () {
    await request(ETH6);
    await acl.setTier(agent.address, 0, 0);
    await expect(wallet.approveAndExecute(1)).to.be.revertedWith("TIER_BLOCKED");
    await acl.setTier(agent.address, 2, 0);
    await acl.revokeRole(await acl.AGENT_ROLE(), agent.address);
    await expect(wallet.approveAndExecute(1)).to.be.revertedWith("NOT_AGENT");
    expect((await wallet.pending(1)).exists).to.equal(true);
  });

  it("hard per-transaction USD limits cannot be bypassed through human approval", async function () {
    await expect(request(ethers.parseEther("0.004"), { max: 20n * USD })).to.be.revertedWith("PER_TX_LIMIT");
    await request(ETH9, { max: 20n * USD });
    await feed.updateAnswer(ethers.parseUnits("4000", 8)); // Fixed ETH amount now costs $12.
    await expect(wallet.approveAndExecute(1)).to.be.revertedWith("PER_TX_LIMIT");
    expect((await wallet.pending(1)).exists).to.equal(true);
  });

  it("binds the user's max USD cost and rejects an increased pending quote", async function () {
    await request(ETH6, { max: 6n * USD });
    await feed.updateAnswer(ethers.parseUnits("3500", 8));
    await expect(wallet.approveAndExecute(1)).to.be.revertedWith("QUOTE_EXCEEDS_MAX");
    expect((await wallet.spendingToday()).spentUsd6).to.equal(0);
    expect((await att.records(1)).approved).to.equal(false);
  });

  it("aggregates repeated small payments and never resets spend on policy updates", async function () {
    await request();
    await request();
    await wallet.configurePolicy(await oracle.getAddress(), 5n * USD, 10n * USD, 15n * USD, 3600);
    expect((await wallet.spendingToday()).spentUsd6).to.equal(6n * USD);
    await request(); await request(); await request();
    expect((await wallet.spendingToday()).remainingUsd6).to.equal(0);
    await expect(request(1n, { max: 1n })).to.be.revertedWith("DAILY_LIMIT");
    expect(await wallet.nextNonce(agent.address)).to.equal(5);
  });

  it("enforces one shared budget across concurrent agents atomically", async function () {
    await acl.grantRole(await acl.AGENT_ROLE(), other.address);
    await acl.setTier(other.address, 2, 0);
    await wallet.configurePolicy(await oracle.getAddress(), 10n * USD, 10n * USD, 15n * USD, 3600);
    const firstArgs = await args(ETH9);
    const secondArgs = await args(ETH9, { signer: other });
    await network.provider.send("evm_setAutomine", [false]);
    let first, second;
    try {
      first = await wallet.connect(agent).requestNativeTransfer(...firstArgs, { gasLimit: 1_000_000 });
      second = await wallet.connect(other).requestNativeTransfer(...secondArgs, { gasLimit: 1_000_000 });
      await network.provider.send("evm_mine");
    } finally { await network.provider.send("evm_setAutomine", [true]); }
    expect((await ethers.provider.getTransactionReceipt(first.hash)).status).to.equal(1);
    expect((await ethers.provider.getTransactionReceipt(second.hash)).status).to.equal(0);
    expect((await wallet.spendingToday()).spentUsd6).to.equal(9n * USD);
  });

  it("revalidates the daily cap when multiple pending payments compete", async function () {
    await request(ETH9); await request(ETH9);
    await wallet.approveAndExecute(1);
    await expect(wallet.approveAndExecute(2)).to.be.revertedWith("DAILY_LIMIT");
    expect((await wallet.pending(2)).exists).to.equal(true);
  });

  it("expires requests and pending approval; a policy or allowlist edit invalidates old pending", async function () {
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    await expect(request(ETH3, { deadline: now - 1 })).to.be.revertedWith("REQUEST_EXPIRED");
    await request(ETH6, { deadline: now + 30 });
    await network.provider.send("evm_increaseTime", [31]);
    await expect(wallet.approveAndExecute(1)).to.be.revertedWith("REQUEST_EXPIRED");
    await request(ETH6);
    await wallet.setRecipientAllowed(other.address, true);
    await expect(wallet.approveAndExecute(2)).to.be.revertedWith("POLICY_VERSION_MISMATCH");
    await request(ETH6);
    await wallet.setRecipientAllowed(recipient.address, false);
    await expect(wallet.approveAndExecute(3)).to.be.revertedWith("RECIPIENT_NOT_ALLOWED");
  });

  it("cannot replay accepted or cancelled nonces, and cancellation does not send funds", async function () {
    await request(ETH6);
    await expect(request(ETH3, { nonce: 0 })).to.be.revertedWith("NONCE_MISMATCH");
    await expect(wallet.cancelPending(1)).to.emit(wallet, "NativeTransferCancelled");
    await expect(wallet.approveAndExecute(1)).to.be.revertedWith("NO_PENDING");
    expect(await wallet.nextNonce(agent.address)).to.equal(1);
    expect((await wallet.spendingToday()).spentUsd6).to.equal(0);
  });

  it("fails closed for stale, negative, zero, future, missing and incomplete oracle data", async function () {
    const cases = [
      [{ age: 3601 }, "ORACLE_STALE"],
      [{ answer: -1n }, "ORACLE_BAD_ANSWER"],
      [{ answer: 0n }, "ORACLE_BAD_ANSWER"],
      [{ future: 1000 }, "ORACLE_BAD_TIMESTAMP"],
      [{ zeroTime: true }, "ORACLE_BAD_TIMESTAMP"],
      [{ round: 5, answered: 4 }, "ORACLE_INCOMPLETE_ROUND"],
    ];
    for (const [data, reason] of cases) {
      await setRound(data);
      await expect(request()).to.be.revertedWith(reason);
    }
    await feed.updateAnswer(ethers.parseUnits("3000", 8));
    await feed.setDecimals(18);
    await expect(request()).to.be.revertedWith("ORACLE_DECIMALS_CHANGED");
    expect(await wallet.nextNonce(agent.address)).to.equal(0);
  });

  it("locks feed configuration and refuses an unlocked oracle", async function () {
    await expect(oracle.setFeed(ethers.ZeroAddress, await feed.getAddress(), 18)).to.be.revertedWith("ORACLE_CONFIGURATION_LOCKED");
    const unlocked = await ethers.deployContract("AegisPriceOracle", [owner.address]);
    await unlocked.setFeed(ethers.ZeroAddress, await feed.getAddress(), 18);
    await expect(wallet.configurePolicy(await unlocked.getAddress(), USD, 10n * USD, 15n * USD, 3600)).to.be.revertedWith("ORACLE_NOT_LOCKED");
  });

  it("rounds USD6 upward, and rolls the budget only at a UTC day boundary", async function () {
    expect((await oracle.latestEthQuote(1n)).costUsd6).to.equal(1);
    await request(1n, { max: 1n });
    const previous = await wallet.spendingToday();
    await network.provider.send("evm_setNextBlockTimestamp", [Number((previous.day + 1n) * 86400n)]);
    await network.provider.send("evm_mine");
    await feed.updateAnswer(ethers.parseUnits("3000", 8));
    expect((await wallet.spendingToday()).spentUsd6).to.equal(0);
    await request();
    expect((await wallet.spendingToday()).spentUsd6).to.equal(3n * USD);
  });

  it("rolls back the nonce, attestation and budget when recipient rejects ETH", async function () {
    const receiver = await ethers.deployContract("AdversarialReceiver");
    await receiver.configure(true, ethers.ZeroAddress, "0x");
    await wallet.setRecipientAllowed(await receiver.getAddress(), true);
    await expect(request(ETH3, { to: await receiver.getAddress() })).to.be.revertedWith("NATIVE_TRANSFER_FAILED");
    expect(await wallet.nextNonce(agent.address)).to.equal(0);
    expect(await att.nextId()).to.equal(1);
    expect((await wallet.spendingToday()).spentUsd6).to.equal(0);
    await receiver.configure(false, ethers.ZeroAddress, "0x");
    await request(ETH6, { to: await receiver.getAddress() });
    await receiver.configure(true, ethers.ZeroAddress, "0x");
    await expect(wallet.approveAndExecute(1)).to.be.revertedWith("NATIVE_TRANSFER_FAILED");
    expect((await wallet.pending(1)).exists).to.equal(true);
    expect((await att.records(1)).approved).to.equal(false);
  });

  it("rejects a recipient's reentrant payment even when that contract is an allowed agent", async function () {
    const receiver = await ethers.deployContract("AdversarialReceiver");
    const receiverAddress = await receiver.getAddress();
    await acl.grantRole(await acl.AGENT_ROLE(), receiverAddress);
    await acl.setTier(receiverAddress, 2, 0);
    await wallet.setRecipientAllowed(receiverAddress, true);
    const end = await deadline(); const version = await wallet.policyVersion();
    const first = wallet.interface.encodeFunctionData("requestNativeTransfer", [receiverAddress, ETH3, 3n * USD, 0, end, version]);
    const reentry = wallet.interface.encodeFunctionData("requestNativeTransfer", [receiverAddress, ETH3, 3n * USD, 1, end, version]);
    await receiver.configure(false, await wallet.getAddress(), reentry);
    await receiver.callWallet(await wallet.getAddress(), first);
    expect(await receiver.attempted()).to.equal(true);
    expect(await receiver.reentrySucceeded()).to.equal(false);
    expect(await wallet.nextNonce(receiverAddress)).to.equal(1);
    expect((await wallet.spendingToday()).spentUsd6).to.equal(3n * USD);
  });

  it("closes legacy ERC20/subscription exits and prevents the agent forging wallet attestations", async function () {
    await expect(wallet.connect(agent).requestTransfer(ethers.ZeroAddress, recipient.address, ETH3, ethers.ZeroHash, "")).to.be.revertedWith("LEGACY_TRANSFER_DISABLED");
    await expect(wallet.createSubscription(recipient.address, ethers.ZeroAddress, ETH3, 1)).to.be.revertedWith("SUBSCRIPTIONS_DISABLED");
    await expect(wallet.connect(agent).paySubscription(1, ethers.ZeroHash, "")).to.be.revertedWith("SUBSCRIPTIONS_DISABLED");
    await expect(wallet.depositToken(recipient.address, 1)).to.be.revertedWith("NATIVE_ETH_ONLY");
    await expect(att.connect(agent).record(agent.address, ethers.ZeroHash, "", false, true)).to.be.revertedWithCustomError(att, "AccessControlUnauthorizedAccount");
  });

  it("domain-separates hashes and changes the binding for every intent field", async function () {
    const end = await deadline(); const version = await wallet.policyVersion();
    const values = [agent.address, recipient.address, ETH3, 3n * USD, 0, end, version];
    const hash = await wallet.hashRequest(...values);
    const chain = await ethers.provider.getNetwork();
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "uint256", "address", "address", "address", "uint256", "uint256", "uint256", "uint64", "uint64"],
      [await wallet.REQUEST_DOMAIN(), chain.chainId, await wallet.getAddress(), ...values]);
    expect(hash).to.equal(ethers.keccak256(encoded));
    for (let index = 0; index < values.length; index++) {
      const changed = [...values];
      changed[index] = index < 2 ? other.address : BigInt(values[index]) + 1n;
      expect(await wallet.hashRequest(...changed)).not.to.equal(hash);
    }
    const secondWallet = await ethers.deployContract("AegisWallet", [owner.address, await acl.getAddress(), await att.getAddress()]);
    expect(await secondWallet.hashRequest(...values)).not.to.equal(hash);
  });
});
