const { expect } = require("chai");
const hre = require("hardhat");

describe("AegisWallet", function () {
  async function deployFixture() {
    const [owner, agent, recipient] = await hre.ethers.getSigners();

    const ACL = await hre.ethers.getContractFactory("AegisAccessControl");
    const acl = await ACL.deploy(owner.address, agent.address);
    await acl.waitForDeployment();

    const Att = await hre.ethers.getContractFactory("AegisAttestation");
    const att = await Att.deploy(owner.address, agent.address);
    await att.waitForDeployment();

    const Wallet = await hre.ethers.getContractFactory("AegisWallet");
    const wallet = await Wallet.deploy(owner.address, await acl.getAddress(), await att.getAddress());
    await wallet.waitForDeployment();

    // Wallet writes attestations and approvals on behalf of the agent.
    await att.grantRole(await att.ATTESTER_ROLE(), await wallet.getAddress());
    await att.grantRole(await att.APPROVER_ROLE(), await wallet.getAddress());

    // LowRisk tier with a 0.01 ETH per-tx ceiling
    await acl.setTier(agent.address, 2, hre.ethers.parseEther("0.01"));

    // Fund the wallet with 1 ETH
    await wallet.depositETH({ value: hre.ethers.parseEther("1") });

    return { owner, agent, recipient, acl, att, wallet };
  }

  it("auto-executes a transfer within the limit and records an attestation", async function () {
    const { agent, recipient, wallet, att } = await deployFixture();
    const before = await hre.ethers.provider.getBalance(recipient.address);

    const actionHash = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("pay 0.005 ETH"));
    await wallet
      .connect(agent)
      .requestTransfer(hre.ethers.ZeroAddress, recipient.address, hre.ethers.parseEther("0.005"), actionHash, "");

    const after = await hre.ethers.provider.getBalance(recipient.address);
    expect(after - before).to.equal(hre.ethers.parseEther("0.005"));

    const record = await att.records(1);
    expect(record.approved).to.equal(true);
    expect(record.riskFlag).to.equal(false);
  });

  it("queues an above-limit transfer and only executes after owner approval", async function () {
    const { owner, agent, recipient, wallet, att } = await deployFixture();
    const before = await hre.ethers.provider.getBalance(recipient.address);

    const actionHash = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("pay 0.5 ETH"));
    await wallet
      .connect(agent)
      .requestTransfer(hre.ethers.ZeroAddress, recipient.address, hre.ethers.parseEther("0.5"), actionHash, "");

    // Not paid yet
    expect(await hre.ethers.provider.getBalance(recipient.address)).to.equal(before);

    // Agent cannot self-approve
    await expect(wallet.connect(agent).approveAndExecute(1)).to.be.reverted;

    // Owner approves
    await wallet.connect(owner).approveAndExecute(1);
    expect(await hre.ethers.provider.getBalance(recipient.address) - before).to.equal(
      hre.ethers.parseEther("0.5")
    );

    const record = await att.records(1);
    expect(record.riskFlag).to.equal(true);
    expect(record.approved).to.equal(true);
  });

  it("rejects a non-agent from requesting transfers", async function () {
    const { recipient, wallet } = await deployFixture();
    await expect(
      wallet.requestTransfer(
        hre.ethers.ZeroAddress,
        recipient.address,
        hre.ethers.parseEther("0.001"),
        hre.ethers.ZeroHash,
        ""
      )
    ).to.be.revertedWith("not agent");
  });
});
