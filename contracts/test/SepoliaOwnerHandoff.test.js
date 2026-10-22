const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { deployLocal } = require("../scripts/deploy-local");
const { validateDeploymentOwner, handoffOwnerAdministration, verifyOwnerAdministration } = require("../scripts/owner-handoff");

describe("Sepolia Owner handoff on real local contracts", function () {
  let snapshot;
  beforeEach(async function () { snapshot = await network.provider.send("evm_snapshot"); });
  afterEach(async function () { await network.provider.send("evm_revert", [snapshot]); });

  async function fixture() {
    expect((await ethers.provider.getNetwork()).chainId).to.equal(31337n);
    const [deployer, agent, recipient, owner] = await ethers.getSigners();
    const deployment = await deployLocal({ env: {}, persist: false, log: false });
    const contracts = {
      wallet: await ethers.getContractAt("AegisWallet", deployment.walletAddress),
      policy: await ethers.getContractAt("AegisPolicyEngine", deployment.policyEngineAddress),
      oracle: await ethers.getContractAt("AegisPriceOracle", deployment.oracleAddress),
      acl: await ethers.getContractAt("AegisAccessControl", deployment.aclAddress),
      attestations: await ethers.getContractAt("AegisAttestation", deployment.attestationAddress),
    };
    return { deployer, agent, recipient, owner, deployment, ...contracts, contracts };
  }

  async function queue({ wallet, agent, recipient }, amount = "0.002") {
    const block = await ethers.provider.getBlock("latest");
    const attestationId = await (await ethers.getContractAt("AegisAttestation", await wallet.attestations())).nextId();
    await expect(wallet.connect(agent).requestNativeTransfer(
      recipient.address, ethers.parseEther(amount), 10_000_000,
      await wallet.nextNonce(agent.address), block.timestamp + 600, await wallet.policyVersion(),
    )).to.emit(wallet, "NativeTransferQueued");
    return attestationId;
  }

  it("leaves deployer-as-Owner defaults unchanged without handoff transactions", async function () {
    const f = await fixture();
    const nonce = await ethers.provider.getTransactionCount(f.deployer.address);
    const result = await handoffOwnerAdministration(f.contracts, {
      deployerAddress: f.deployer.address, ownerAddress: f.deployer.address,
    });
    expect(result).to.deep.equal({ ownerAdministrationVerified: true, deployerAdministrationRevoked: false });
    expect(await ethers.provider.getTransactionCount(f.deployer.address)).to.equal(nonce);
    const id = await queue(f);
    await expect(f.wallet.connect(f.deployer).approveAndExecute(id)).to.emit(f.wallet, "NativeTransferExecuted");
  });

  it("grants final Owner administration and approval while removing every deployer admin role", async function () {
    const f = await fixture();
    const result = await handoffOwnerAdministration(f.contracts, {
      deployerAddress: f.deployer.address, ownerAddress: f.owner.address,
    });
    expect(result).to.deep.equal({ ownerAdministrationVerified: true, deployerAdministrationRevoked: true });
    await verifyOwnerAdministration({ ...f.contracts, deployerAddress: f.deployer.address, ownerAddress: f.owner.address });
    for (const contract of [f.wallet, f.policy, f.oracle]) expect(await contract.owner()).to.equal(f.owner.address);
    const aclRoles = [await f.acl.DEFAULT_ADMIN_ROLE(), await f.acl.OWNER_ROLE(), await f.acl.GUARDIAN_ROLE()];
    const attestationRoles = [await f.attestations.DEFAULT_ADMIN_ROLE(), await f.attestations.APPROVER_ROLE()];
    for (const [contract, roles] of [[f.acl, aclRoles], [f.attestations, attestationRoles]]) {
      for (const role of roles) {
        expect(await contract.hasRole(role, f.owner.address)).to.equal(true);
        expect(await contract.hasRole(role, f.deployer.address)).to.equal(false);
      }
    }
    expect(await f.acl.hasRole(await f.acl.AGENT_ROLE(), f.agent.address)).to.equal(true);
    expect(await f.acl.hasRole(await f.acl.AGENT_ROLE(), f.deployer.address)).to.equal(false);
    expect(await f.acl.tierOf(f.agent.address)).to.equal(2n);
    expect(await f.policy.authorizedConsumers(f.deployment.walletAddress)).to.equal(true);
    expect(await f.policy.policyManagers(f.deployment.walletAddress)).to.equal(true);
    expect(await f.policy.authorizedConsumers(f.deployer.address)).to.equal(false);
    expect(await f.policy.policyManagers(f.deployer.address)).to.equal(false);
    expect(await f.attestations.hasRole(await f.attestations.ATTESTER_ROLE(), f.deployment.walletAddress)).to.equal(true);
    expect(await f.attestations.hasRole(await f.attestations.APPROVER_ROLE(), f.deployment.walletAddress)).to.equal(true);
    expect(await f.attestations.hasRole(await f.attestations.ATTESTER_ROLE(), f.deployer.address)).to.equal(false);
    expect(await f.oracle.configurationLocked()).to.equal(true);

    await expect(f.wallet.connect(f.deployer).configurePolicy(f.deployment.oracleAddress, 5_000_000, 10_000_000, 15_000_000, 3600))
      .to.be.revertedWithCustomError(f.wallet, "OwnableUnauthorizedAccount");
    await expect(f.policy.connect(f.deployer).setConsumer(f.deployment.walletAddress, false))
      .to.be.revertedWithCustomError(f.policy, "OwnableUnauthorizedAccount");
    await expect(f.oracle.connect(f.deployer).transferOwnership(f.deployer.address))
      .to.be.revertedWithCustomError(f.oracle, "OwnableUnauthorizedAccount");
    await expect(f.acl.connect(f.deployer).setTier(f.agent.address, 0, 0))
      .to.be.revertedWithCustomError(f.acl, "AccessControlUnauthorizedAccount");
    await expect(f.acl.connect(f.deployer).grantRole(await f.acl.OWNER_ROLE(), f.deployer.address))
      .to.be.revertedWithCustomError(f.acl, "AccessControlUnauthorizedAccount");
    await expect(f.attestations.connect(f.deployer).grantRole(await f.attestations.APPROVER_ROLE(), f.deployer.address))
      .to.be.revertedWithCustomError(f.attestations, "AccessControlUnauthorizedAccount");
    await expect(f.wallet.connect(f.owner).configurePolicy(f.deployment.oracleAddress, 5_000_000, 10_000_000, 15_000_000, 3600))
      .to.emit(f.wallet, "PolicyConfigured");
    await f.acl.connect(f.owner).setTier(f.agent.address, 3, 0);
    await f.policy.connect(f.owner).setPolicyManager(f.deployment.walletAddress, true);
    await f.oracle.connect(f.owner).transferOwnership(f.owner.address);
    const id = await queue(f);
    await expect(f.attestations.connect(f.deployer).setApproval(id, true))
      .to.be.revertedWithCustomError(f.attestations, "AccessControlUnauthorizedAccount");
    await f.attestations.connect(f.owner).setApproval(id, true);
    await expect(f.wallet.connect(f.deployer).approveAndExecute(id))
      .to.be.revertedWithCustomError(f.wallet, "OwnableUnauthorizedAccount");
    expect((await f.wallet.spendingToday()).spentUsd6).to.equal(0n);
    const balanceBefore = await ethers.provider.getBalance(f.recipient.address);
    await expect(f.wallet.connect(f.owner).approveAndExecute(id)).to.emit(f.wallet, "NativeTransferExecuted");
    expect(await ethers.provider.getBalance(f.recipient.address)).to.equal(balanceBefore + ethers.parseEther("0.002"));
    expect((await f.wallet.spendingToday()).spentUsd6).to.equal(6_000_000n);
  });

  it("keeps hard transaction and shared daily limits binding on final Owner approvals", async function () {
    const f = await fixture();
    await handoffOwnerAdministration(f.contracts, { deployerAddress: f.deployer.address, ownerAddress: f.owner.address });
    const first = await queue(f, "0.003");
    const second = await queue(f, "0.003");
    await expect(f.wallet.connect(f.owner).approveAndExecute(first)).to.emit(f.wallet, "NativeTransferExecuted");
    await f.attestations.connect(f.owner).setApproval(second, true);
    await expect(f.wallet.connect(f.owner).approveAndExecute(second)).to.be.revertedWith("DAILY_LIMIT");
    expect((await f.wallet.spendingToday()).spentUsd6).to.equal(9_000_000n);
    expect((await f.wallet.pending(second)).exists).to.equal(true);
    const block = await ethers.provider.getBlock("latest");
    await expect(f.wallet.connect(f.agent).requestNativeTransfer(
      f.recipient.address, ethers.parseEther("0.004"), 12_000_000,
      await f.wallet.nextNonce(f.agent.address), block.timestamp + 600, await f.wallet.policyVersion(),
    )).to.be.revertedWith("PER_TX_LIMIT");
  });

  it("rejects invalid, conflicting, contract and future contract Owners before any deployment transaction", async function () {
    const [deployer, agent, recipient] = await ethers.getSigners();
    const existing = await ethers.deployContract("MockV3Aggregator", [8, 300_000_000_000n]);
    await existing.waitForDeployment();
    const nonce = await ethers.provider.getTransactionCount(deployer.address);
    const futureWallet = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 4 });
    for (const ownerAddress of ["", "not-an-address", ethers.ZeroAddress, agent.address, recipient.address, await existing.getAddress(), futureWallet]) {
      let failure;
      try {
        await validateDeploymentOwner({ provider: ethers.provider, deployerAddress: deployer.address, ownerAddress, agentAddress: agent.address, recipientAddress: recipient.address });
      } catch (error) { failure = error; }
      expect(failure, `should reject ${ownerAddress}`).to.be.instanceOf(Error);
      expect(failure.message).to.include("OWNER_ADDRESS");
      expect(await ethers.provider.getTransactionCount(deployer.address)).to.equal(nonce);
    }
  });
});
