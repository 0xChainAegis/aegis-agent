const hre = require("hardhat");

/// @dev Known CCIP router addresses.
/// NOTE: Scroll Sepolia CCIP is INACTIVE on the official directory, so the
/// demo target is Ethereum Sepolia (active lanes to Base Sepolia etc.).
const CCIP_ROUTERS = {
  11155111: "0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59", // Ethereum Sepolia
  31337: "0x0000000000000000000000000000000000000000", // local hardhat
};

/// @dev CCIP chain selectors (verified in the CCIP directory).
const CCIP_CHAIN_SELECTORS = {
  sepolia: 16015286601757825753, // Ethereum Sepolia
  baseSepolia: 10344971235874465080, // Base Sepolia
  arbitrumSepolia: 3478487238524512106, // Arbitrum Sepolia
};

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const agentAddress = process.env.AGENT_ADDRESS || deployer.address;
  const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);

  console.log("Deployer:", deployer.address);
  console.log("Agent:", agentAddress);
  console.log("Chain id:", chainId);

  // 1. Access control
  const ACL = await hre.ethers.getContractFactory("AegisAccessControl");
  const acl = await ACL.deploy(deployer.address, agentAddress);
  await acl.waitForDeployment();
  console.log("AegisAccessControl:", await acl.getAddress());

  // 2. Attestation registry
  const Att = await hre.ethers.getContractFactory("AegisAttestation");
  const att = await Att.deploy(deployer.address, agentAddress);
  await att.waitForDeployment();
  console.log("AegisAttestation:", await att.getAddress());

  // 3. Wallet
  const Wallet = await hre.ethers.getContractFactory("AegisWallet");
  const wallet = await Wallet.deploy(deployer.address, await acl.getAddress(), await att.getAddress());
  await wallet.waitForDeployment();
  console.log("AegisWallet:", await wallet.getAddress());

  // The wallet writes attestations and updates approvals on behalf of the agent.
  const walletAddress = await wallet.getAddress();
  await att.grantRole(await att.ATTESTER_ROLE(), walletAddress);
  await att.grantRole(await att.APPROVER_ROLE(), walletAddress);
  console.log("Wallet granted ATTESTER_ROLE and APPROVER_ROLE");

  // 4. Set a permissive demo auto-limit (0.01 ETH) on local, 0.001 on public testnets
  const autoLimit = chainId === 31337
    ? hre.ethers.parseEther("0.01")
    : hre.ethers.parseEther("0.001");
  await acl.setTier(agentAddress, 2, autoLimit); // 2 = LowRisk
  console.log("Auto limit set:", hre.ethers.formatEther(autoLimit), "ETH");

  // 5. Price oracle (feeds must be wired after deploy)
  const Oracle = await hre.ethers.getContractFactory("AegisPriceOracle");
  const oracle = await Oracle.deploy(deployer.address);
  await oracle.waitForDeployment();
  const oracleAddress = await oracle.getAddress();
  console.log("AegisPriceOracle:", oracleAddress);
  console.log(
    "Wire the feed next:\n" +
      `  ORACLE_ADDRESS=${oracleAddress} npx hardhat run scripts/wire-feed.js --network sepolia`
  );

  // 6. CCIP sender (skipped on a fresh local chain without a router)
  const router = CCIP_ROUTERS[chainId];
  if (router && router !== "0x0000000000000000000000000000000000000000") {
    const CCIP = await hre.ethers.getContractFactory("AegisCCIPSender");
    const ccip = await CCIP.deploy(deployer.address, router);
    await ccip.waitForDeployment();
    console.log("AegisCCIPSender:", await ccip.getAddress());
    console.log("CCIP chain selectors:", JSON.stringify(CCIP_CHAIN_SELECTORS));
  } else {
    console.log("CCIP deploy skipped (no router for this chain)");
  }

  console.log("\nDeployment complete. Save the addresses above and fill them in the agent .env");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
