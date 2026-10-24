const { expect } = require("chai");
const { ethers } = require("hardhat");

const USD = 1_000_000n;
const TOKEN = 1_000_000n;
const DESTINATION = 3_478_487_238_524_512_106n;
const FEE = ethers.parseEther("0.001");

describe("AegisCCIPSender unified policy", function () {
  async function fixture() {
    const [owner, agent, recipient, other] = await ethers.getSigners();
    const acl = await ethers.deployContract("AegisAccessControl", [owner.address, agent.address]);
    const attestations = await ethers.deployContract("AegisAttestation", [owner.address, agent.address]);
    const ethFeed = await ethers.deployContract("MockV3Aggregator", [8, ethers.parseUnits("3000", 8)]);
    const tokenFeed = await ethers.deployContract("MockV3Aggregator", [8, ethers.parseUnits("1", 8)]);
    const token = await ethers.deployContract("MockERC20", ["Mock USD", "mUSD", 6]);
    const unsupportedToken = await ethers.deployContract("MockERC20", ["Unknown", "NOPE", 6]);
    const oracle = await ethers.deployContract("AegisPriceOracle", [owner.address]);
    await oracle.setFeed(ethers.ZeroAddress, await ethFeed.getAddress(), 18);
    await oracle.setFeed(await token.getAddress(), await tokenFeed.getAddress(), 6);
    await oracle.lockConfiguration();
    const policy = await ethers.deployContract("AegisPolicyEngine", [owner.address, await acl.getAddress()]);
    await policy.configurePolicy(await oracle.getAddress(), 5n * USD, 10n * USD, 15n * USD, 3600);
    const wallet = await ethers.deployContract("AegisWallet", [owner.address, await acl.getAddress(), await attestations.getAddress(), await policy.getAddress()]);
    const router = await ethers.deployContract("MockCCIPRouter");
    await router.setFee(FEE);
    const sender = await ethers.deployContract("AegisCCIPSender", [owner.address, await router.getAddress(), await attestations.getAddress(), await policy.getAddress()]);
    const senderAddress = await sender.getAddress();
    await policy.setConsumer(senderAddress, true);
    await policy.setPolicyManager(senderAddress, true);
    await policy.setConsumer(await wallet.getAddress(), true);
    await policy.setPolicyManager(await wallet.getAddress(), true);
    await attestations.grantRole(await attestations.ATTESTER_ROLE(), senderAddress);
    await attestations.grantRole(await attestations.APPROVER_ROLE(), senderAddress);
    await attestations.grantRole(await attestations.ATTESTER_ROLE(), await wallet.getAddress());
    await attestations.grantRole(await attestations.APPROVER_ROLE(), await wallet.getAddress());
    await sender.setRecipientAllowed(recipient.address, true);
    await sender.setDestinationChainAllowed(DESTINATION, true);
    await token.mint(owner.address, 100n * TOKEN);
    await token.approve(senderAddress, 100n * TOKEN);
    await sender.depositToken(await token.getAddress(), 100n * TOKEN);
    await owner.sendTransaction({ to: senderAddress, value: ethers.parseEther("0.1") });
    await owner.sendTransaction({ to: await wallet.getAddress(), value: ethers.parseEther("1") });
    return { owner, agent, recipient, other, acl, attestations, ethFeed, tokenFeed, token, unsupportedToken, oracle, policy, wallet, router, sender };
  }

  async function deadline() {
    return (await ethers.provider.getBlock("latest")).timestamp + 1800;
  }

  async function args(state, amount = 3n * TOKEN, changes = {}) {
    const signer = changes.signer ?? state.agent;
    return [
      changes.receiver ?? state.recipient.address,
      changes.token ?? await state.token.getAddress(),
      amount,
      changes.maxUsdCost6 ?? 10n * USD,
      changes.maxFeeWei ?? FEE,
      changes.nonce ?? await state.sender.nextNonce(signer.address),
      changes.deadline ?? await deadline(),
      changes.version ?? await state.policy.policyVersion(),
      changes.destination ?? DESTINATION,
    ];
  }

  async function request(state, amount = 3n * TOKEN, changes = {}) {
    return state.sender.connect(changes.signer ?? state.agent).requestCrossChainTransfer(...await args(state, amount, changes));
  }

  it("previews and sends an allowlisted token with correlated policy evidence", async function () {
    const state = await fixture();
    const parameters = await args(state);
    const preview = await state.sender.previewCrossChainTransfer(state.agent.address, ...parameters.slice(0, 5), parameters[6], parameters[7], parameters[8]);
    expect(preview.costUsd6).to.equal(3n * USD);
    expect(preview.feeWei).to.equal(FEE);
    expect(preview.requiresApproval).to.equal(false);
    const expectedHash = await state.sender.hashRequest(state.agent.address, ...parameters);
    await expect(state.sender.connect(state.agent).requestCrossChainTransfer(...parameters)).to.emit(state.sender, "CCIPTransferExecuted");
    expect(await state.token.balanceOf(state.recipient.address)).to.equal(3n * TOKEN);
    expect((await state.policy.spendingToday()).spentUsd6).to.equal(3n * USD);
    expect(await state.policy.consumedRequests(expectedHash)).to.equal(true);
    expect((await state.attestations.records(1)).actionHash).to.equal(expectedHash);
    expect(await state.sender.nextNonce(state.agent.address)).to.equal(1);
  });

  it("queues above the automatic threshold and revalidates before Owner execution", async function () {
    const state = await fixture();
    await expect(request(state, 6n * TOKEN)).to.emit(state.sender, "CCIPTransferQueued");
    expect((await state.sender.pending(1)).amount).to.equal(6n * TOKEN);
    expect((await state.policy.spendingToday()).spentUsd6).to.equal(0);
    await expect(state.sender.connect(state.agent).approveAndExecute(1)).to.be.revertedWithCustomError(state.sender, "OwnableUnauthorizedAccount");
    await expect(state.sender.approveAndExecute(1)).to.emit(state.sender, "CCIPTransferExecuted");
    expect(await state.token.balanceOf(state.recipient.address)).to.equal(6n * TOKEN);
    expect((await state.sender.pending(1)).exists).to.equal(false);
    expect((await state.attestations.records(1)).approved).to.equal(true);
  });

  it("rejects non-agents, disabled chains, unknown recipients and unsupported assets", async function () {
    const state = await fixture();
    await expect(request(state, 3n * TOKEN, { signer: state.other })).to.be.revertedWith("NOT_AGENT");
    await state.sender.setDestinationChainAllowed(DESTINATION, false);
    await expect(request(state)).to.be.revertedWith("DESTINATION_CHAIN_NOT_ALLOWED");
    await state.sender.setDestinationChainAllowed(DESTINATION, true);
    await expect(request(state, 3n * TOKEN, { receiver: state.other.address })).to.be.revertedWith("RECIPIENT_NOT_ALLOWED");
    await expect(request(state, 3n * TOKEN, { token: await state.unsupportedToken.getAddress() })).to.be.revertedWith("ASSET_NOT_SUPPORTED");
    expect(await state.sender.nextNonce(state.agent.address)).to.equal(0);
  });

  it("bounds the native CCIP fee and fails closed when the router disables the route", async function () {
    const state = await fixture();
    await expect(request(state, 3n * TOKEN, { maxFeeWei: FEE - 1n })).to.be.revertedWith("CCIP_FEE_EXCEEDS_MAX");
    await state.router.setChainSupported(false);
    await expect(request(state)).to.be.revertedWith("ROUTER_CHAIN_UNSUPPORTED");
    await state.router.setChainSupported(true);
    await state.router.setFee(ethers.parseEther("1"));
    await expect(request(state, 3n * TOKEN, { maxFeeWei: ethers.parseEther("1") })).to.be.revertedWith("INSUFFICIENT_FEE_BALANCE");
  });

  it("keeps a queued transfer pending when price, policy or fee changes invalidate it", async function () {
    const state = await fixture();
    await request(state, 6n * TOKEN, { maxUsdCost6: 6n * USD });
    await state.tokenFeed.updateAnswer(ethers.parseUnits("2", 8));
    await expect(state.sender.approveAndExecute(1)).to.be.revertedWith("QUOTE_EXCEEDS_MAX");
    expect((await state.sender.pending(1)).exists).to.equal(true);
    await state.tokenFeed.updateAnswer(ethers.parseUnits("1", 8));
    await state.router.setFee(FEE + 1n);
    await expect(state.sender.approveAndExecute(1)).to.be.revertedWith("CCIP_FEE_EXCEEDS_MAX");
    expect((await state.sender.pending(1)).exists).to.equal(true);
  });

  it("cancels without spending and prevents replaying accepted nonces", async function () {
    const state = await fixture();
    const parameters = await args(state, 6n * TOKEN);
    await state.sender.connect(state.agent).requestCrossChainTransfer(...parameters);
    await expect(state.sender.cancelPending(1)).to.emit(state.sender, "CCIPTransferCancelled");
    expect((await state.policy.spendingToday()).spentUsd6).to.equal(0);
    expect((await state.attestations.records(1)).approved).to.equal(false);
    await expect(state.sender.connect(state.agent).requestCrossChainTransfer(...parameters)).to.be.revertedWith("NONCE_MISMATCH");
  });

  it("emits CCIPTransferExecuted with the ABI topic and decodable fields", async function () {
    const state = await fixture();
    const tx = await request(state);
    const receipt = await tx.wait();
    const fragment = state.sender.interface.getEvent("CCIPTransferExecuted");
    const log = receipt.logs.find((entry) => entry.topics[0] === fragment.topicHash);
    expect(log, "event topic must match the declared ABI").to.not.equal(undefined);
    const parsed = state.sender.interface.parseLog(log);
    expect(parsed.args.agent).to.equal(state.agent.address);
    expect(parsed.args.receiver).to.equal(state.recipient.address);
    expect(parsed.args.token).to.equal(await state.token.getAddress());
    expect(parsed.args.amount).to.equal(3n * TOKEN);
    expect(parsed.args.costUsd6).to.equal(3n * USD);
    expect(parsed.args.feeWei).to.equal(FEE);
    expect(parsed.args.destinationChainSelector).to.equal(DESTINATION);
    expect(parsed.args.messageId).to.not.equal(ethers.ZeroHash);
  });

  it("lets Owner cancel but not execute a queued transfer after its deadline", async function () {
    const state = await fixture();
    await request(state, 6n * TOKEN);
    const queued = await state.sender.pending(1);
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(queued.deadline) + 1]);
    await ethers.provider.send("evm_mine", []);
    await expect(state.sender.approveAndExecute(1)).to.be.revertedWith("REQUEST_EXPIRED");
    expect((await state.sender.pending(1)).exists).to.equal(true);
    await expect(state.sender.cancelPending(1)).to.emit(state.sender, "CCIPTransferCancelled");
    expect(await state.token.balanceOf(state.recipient.address)).to.equal(0);
  });

  it("rolls back nonce, attestation and shared budget when CCIP routing fails", async function () {
    const state = await fixture();
    await state.router.setFailSend(true);
    await expect(request(state)).to.be.revertedWith("MOCK_SEND_FAILED");
    expect(await state.sender.nextNonce(state.agent.address)).to.equal(0);
    expect(await state.attestations.nextId()).to.equal(1);
    expect((await state.policy.spendingToday()).spentUsd6).to.equal(0);
    expect(await state.token.balanceOf(await state.sender.getAddress())).to.equal(100n * TOKEN);
  });

  it("shares one daily USD budget with native wallet payments", async function () {
    const state = await fixture();
    const expires = await deadline();
    const version = await state.policy.policyVersion();
    await request(state, 7n * TOKEN);
    await state.wallet.connect(state.agent).requestNativeTransfer(state.recipient.address, ethers.parseEther("0.003"), 10n * USD, 0, expires, version);
    await state.wallet.approveAndExecute(2);
    expect((await state.policy.spendingToday()).spentUsd6).to.equal(9n * USD);
    await expect(state.sender.approveAndExecute(1)).to.be.revertedWith("DAILY_LIMIT");
    expect((await state.sender.pending(1)).exists).to.equal(true);
    expect((await state.policy.spendingToday()).spentUsd6).to.equal(9n * USD);
  });
});
