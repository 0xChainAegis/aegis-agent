const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { deployLocal } = require("../scripts/deploy-local");

describe("Local deployment Owner initialization", function () {
  let snapshot;
  beforeEach(async function () { snapshot = await network.provider.send("evm_snapshot"); });
  afterEach(async function () { await network.provider.send("evm_revert", [snapshot]); });

  async function contracts(deployment) {
    return {
      wallet: await ethers.getContractAt("AegisWallet", deployment.walletAddress),
      policy: await ethers.getContractAt("AegisPolicyEngine", deployment.policyEngineAddress),
      oracle: await ethers.getContractAt("AegisPriceOracle", deployment.oracleAddress),
      acl: await ethers.getContractAt("AegisAccessControl", deployment.aclAddress),
      att: await ethers.getContractAt("AegisAttestation", deployment.attestationAddress),
    };
  }

  async function queue(wallet, agent, recipient) {
    const block = await ethers.provider.getBlock("latest");
    await expect(wallet.connect(agent).requestNativeTransfer(
      recipient.address, ethers.parseEther("0.002"), 6_000_000,
      await wallet.nextNonce(agent.address), block.timestamp + 600, await wallet.policyVersion(),
    )).to.emit(wallet, "NativeTransferQueued");
  }

  it("retains the default deployment addresses, Owner, budget and approval flow without an override", async function () {
    const [deployer, agent, recipient] = await ethers.getSigners();
    const nonce = await ethers.provider.getTransactionCount(deployer.address);
    const deployment = await deployLocal({ env: {}, persist: false, log: false });
    const { wallet, policy, oracle } = await contracts(deployment);
    expect(deployment.walletAddress).to.equal(ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 5 }));
    expect(deployment.ownerAddress).to.equal(deployer.address);
    expect(deployment.mockUpdaterAddress).to.equal(deployer.address);
    for (const contract of [wallet, policy, oracle]) expect(await contract.owner()).to.equal(deployer.address);
    expect(await wallet.autoLimitUsd6()).to.equal(5_000_000);
    expect(await wallet.perTxLimitUsd6()).to.equal(10_000_000);
    expect(await wallet.dailyLimitUsd6()).to.equal(15_000_000);
    await queue(wallet, agent, recipient);
    await expect(wallet.connect(deployer).approveAndExecute(1)).to.emit(wallet, "NativeTransferExecuted");
  });

  it("hands all Owner administration to the presenter while preserving executor and wallet roles", async function () {
    const [deployer, agent, recipient, presenter] = await ethers.getSigners();
    const balanceBefore = await ethers.provider.getBalance(presenter.address);
    const deployment = await deployLocal({ env: { AEGIS_LOCAL_OWNER_ADDRESS: presenter.address.toLowerCase() }, persist: false, log: false });
    const { wallet, policy, oracle, acl, att } = await contracts(deployment);
    expect(deployment.ownerAddress).to.equal(presenter.address);
    expect(deployment.mockUpdaterAddress).to.equal(deployer.address);
    expect(await ethers.provider.getBalance(presenter.address)).to.equal(balanceBefore + ethers.parseEther("0.1"));
    for (const contract of [wallet, policy, oracle]) expect(await contract.owner()).to.equal(presenter.address);
    for (const role of [await acl.DEFAULT_ADMIN_ROLE(), await acl.OWNER_ROLE(), await acl.GUARDIAN_ROLE()]) {
      expect(await acl.hasRole(role, presenter.address)).to.equal(true);
      expect(await acl.hasRole(role, deployer.address)).to.equal(false);
    }
    for (const role of [await att.DEFAULT_ADMIN_ROLE(), await att.APPROVER_ROLE()]) {
      expect(await att.hasRole(role, presenter.address)).to.equal(true);
      expect(await att.hasRole(role, deployer.address)).to.equal(false);
    }
    expect(await acl.hasRole(await acl.AGENT_ROLE(), agent.address)).to.equal(true);
    expect(await acl.tierOf(agent.address)).to.equal(2);
    expect(await policy.authorizedConsumers(deployment.walletAddress)).to.equal(true);
    expect(await policy.policyManagers(deployment.walletAddress)).to.equal(true);
    expect(await att.hasRole(await att.ATTESTER_ROLE(), deployment.walletAddress)).to.equal(true);
    expect(await att.hasRole(await att.APPROVER_ROLE(), deployment.walletAddress)).to.equal(true);
    expect(await att.hasRole(await att.ATTESTER_ROLE(), agent.address)).to.equal(false);
    expect(await wallet.allowedRecipients(recipient.address)).to.equal(true);
    expect(await oracle.feeds(ethers.ZeroAddress)).to.equal(deployment.feedAddress);
    expect(await oracle.configurationLocked()).to.equal(true);
    expect(await ethers.provider.getBalance(deployment.walletAddress)).to.equal(ethers.parseEther("1"));
    await queue(wallet, agent, recipient);
    await expect(wallet.connect(deployer).approveAndExecute(1)).to.be.revertedWithCustomError(wallet, "OwnableUnauthorizedAccount");
    await expect(policy.connect(deployer).setConsumer(deployment.walletAddress, false)).to.be.revertedWithCustomError(policy, "OwnableUnauthorizedAccount");
    await expect(acl.connect(deployer).setTier(agent.address, 0, 0)).to.be.revertedWithCustomError(acl, "AccessControlUnauthorizedAccount");
    await expect(att.connect(deployer).setApproval(1, true)).to.be.revertedWithCustomError(att, "AccessControlUnauthorizedAccount");
    const before = await ethers.provider.getBalance(recipient.address);
    await expect(wallet.connect(presenter).approveAndExecute(1)).to.emit(wallet, "NativeTransferExecuted");
    expect(await ethers.provider.getBalance(recipient.address)).to.equal(before + ethers.parseEther("0.002"));
    expect((await wallet.spendingToday()).spentUsd6).to.equal(6_000_000);
  });

  it("rejects empty, malformed, conflicting and contract Owner addresses before deploying anything", async function () {
    const [deployer, agent, recipient] = await ethers.getSigners();
    const existing = await ethers.deployContract("MockV3Aggregator", [8, 300_000_000_000n]);
    await existing.waitForDeployment();
    const nonce = await ethers.provider.getTransactionCount(deployer.address);
    const futurePool = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 5 });
    const cases = ["", " ", "not-an-address", ethers.ZeroAddress, agent.address, recipient.address, await existing.getAddress(), futurePool];
    for (const value of cases) {
      let rejected = false;
      try { await deployLocal({ env: { AEGIS_LOCAL_OWNER_ADDRESS: value }, persist: false, log: false }); }
      catch (error) { expect(error.message).to.match(/Owner|AEGIS_LOCAL_OWNER_ADDRESS/); rejected = true; }
      expect(rejected, `should reject ${value}`).to.equal(true);
      expect(await ethers.provider.getTransactionCount(deployer.address)).to.equal(nonce);
    }
  });
});
