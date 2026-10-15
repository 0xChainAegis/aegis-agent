const { ethers, network } = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

async function main() {
  const chain = await ethers.provider.getNetwork();
  if (chain.chainId !== 31337n) throw new Error("Local deployment only: expected chainId 31337");
  const [owner, agent, recipient] = await ethers.getSigners();
  if (!recipient || new Set([owner.address, agent.address, recipient.address]).size !== 3) {
    throw new Error("Three distinct local owner/agent/recipient accounts required");
  }
  const acl = await ethers.deployContract("AegisAccessControl", [owner.address, agent.address]);
  const att = await ethers.deployContract("AegisAttestation", [owner.address, agent.address]);
  const feed = await ethers.deployContract("MockV3Aggregator", [8, ethers.parseUnits("3000", 8)]);
  const oracle = await ethers.deployContract("AegisPriceOracle", [owner.address]);
  await Promise.all([acl.waitForDeployment(), att.waitForDeployment(), feed.waitForDeployment(), oracle.waitForDeployment()]);
  const wallet = await ethers.deployContract("AegisWallet", [owner.address, await acl.getAddress(), await att.getAddress()]);
  await wallet.waitForDeployment();
  await (await oracle.setFeed(ethers.ZeroAddress, await feed.getAddress(), 18)).wait();
  await (await oracle.lockConfiguration()).wait();
  await (await att.grantRole(await att.ATTESTER_ROLE(), await wallet.getAddress())).wait();
  await (await att.grantRole(await att.APPROVER_ROLE(), await wallet.getAddress())).wait();
  await (await acl.setTier(agent.address, 2, 0)).wait();
  await (await wallet.configurePolicy(await oracle.getAddress(), 5_000_000, 10_000_000, 15_000_000, 3600)).wait();
  await (await wallet.setRecipientAllowed(recipient.address, true)).wait();
  await (await owner.sendTransaction({ to: await wallet.getAddress(), value: ethers.parseEther("1") })).wait();
  const deployment = {
    chainId: Number(chain.chainId),
    rpcUrl: "http://127.0.0.1:8545",
    walletAddress: await wallet.getAddress(),
    aclAddress: await acl.getAddress(),
    attestationAddress: await att.getAddress(),
    oracleAddress: await oracle.getAddress(),
    feedAddress: await feed.getAddress(),
    ownerAddress: owner.address,
    agentAddress: agent.address,
    recipientAddress: recipient.address,
    abiVersion: "aegis.native.v1",
  };
  const directory = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(directory, { recursive: true });
  // hardhat's ephemeral in-process network is not a persistent RPC deployment.
  const filename = network.name === "localhost" ? "localhost.json" : "hardhat.json";
  fs.writeFileSync(path.join(directory, filename), JSON.stringify(deployment, null, 2) + "\n");
  console.log(JSON.stringify(deployment, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
