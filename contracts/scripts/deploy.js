const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const { readSepoliaDeploymentConfig } = require("./sepolia-config");

const FEED_ABI = [
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
];

async function waitFor(txPromise, confirmations) {
  const tx = await txPromise;
  return tx.wait(confirmations);
}

async function deploy(name, args, confirmations) {
  const contract = await (await ethers.getContractFactory(name)).deploy(...args);
  await contract.waitForDeployment();
  if (confirmations > 1) await contract.deploymentTransaction().wait(confirmations);
  return contract;
}

async function main() {
  const config = readSepoliaDeploymentConfig();
  const chain = await ethers.provider.getNetwork();
  if (network.name !== "sepolia" || chain.chainId !== 11155111n) {
    throw new Error(`Refusing public deployment: expected Sepolia (11155111), got ${network.name} (${chain.chainId})`);
  }

  const [deployer] = await ethers.getSigners();
  if (!deployer || deployer.address.toLowerCase() !== config.ownerAddress.toLowerCase()) {
    throw new Error("Configured signer does not match the owner derived from PRIVATE_KEY");
  }

  const feedCode = await ethers.provider.getCode(config.feedAddress);
  if (feedCode === "0x") throw new Error("ETH_USD_FEED_ADDRESS has no contract bytecode on Sepolia");

  const feed = new ethers.Contract(config.feedAddress, FEED_ABI, ethers.provider);
  const [feedDecimals, feedDescription, roundData, latestBlock] = await Promise.all([
    feed.decimals(), feed.description(), feed.latestRoundData(), ethers.provider.getBlock("latest"),
  ]);
  if (!/^ETH\s*\/\s*USD$/i.test(feedDescription.trim())) {
    throw new Error(`Expected an ETH/USD Chainlink feed, got ${feedDescription}`);
  }
  if (feedDecimals > 18n) throw new Error("Chainlink feed decimals exceed the oracle's supported precision");
  if (roundData.answer <= 0n || roundData.updatedAt === 0n || roundData.answeredInRound < roundData.roundId) {
    throw new Error("Chainlink feed returned an invalid or incomplete round");
  }
  const feedAge = BigInt(latestBlock.timestamp) - roundData.updatedAt;
  if (feedAge < 0n || feedAge > config.maxPriceAge) {
    throw new Error(`Chainlink feed is stale for the configured MAX_PRICE_AGE (${feedAge}s)`);
  }

  const acl = await deploy("AegisAccessControl", [config.ownerAddress, config.agentAddress], config.confirmations);
  const attestations = await deploy("AegisAttestation", [config.ownerAddress, config.agentAddress], config.confirmations);
  const oracle = await deploy("AegisPriceOracle", [config.ownerAddress], config.confirmations);
  const policy = await deploy("AegisPolicyEngine", [config.ownerAddress, await acl.getAddress()], config.confirmations);
  const wallet = await deploy(
    "AegisWallet",
    [config.ownerAddress, await acl.getAddress(), await attestations.getAddress(), await policy.getAddress()],
    config.confirmations,
  );

  await waitFor(oracle.setFeed(ethers.ZeroAddress, config.feedAddress, 18), config.confirmations);
  await waitFor(oracle.lockConfiguration(), config.confirmations);
  await waitFor(policy.setConsumer(await wallet.getAddress(), true), config.confirmations);
  await waitFor(policy.setPolicyManager(await wallet.getAddress(), true), config.confirmations);

  const attesterRole = await attestations.ATTESTER_ROLE();
  const approverRole = await attestations.APPROVER_ROLE();
  const agentRole = await acl.AGENT_ROLE();
  await waitFor(attestations.grantRole(attesterRole, await wallet.getAddress()), config.confirmations);
  await waitFor(attestations.grantRole(approverRole, await wallet.getAddress()), config.confirmations);
  await waitFor(acl.setTier(config.agentAddress, 2, 0), config.confirmations);

  await waitFor(
    wallet.configurePolicy(await oracle.getAddress(), config.autoLimitUsd6, config.perTxLimitUsd6, config.dailyLimitUsd6, config.maxPriceAge),
    config.confirmations,
  );
  await waitFor(wallet.setRecipientAllowed(config.recipientAddress, true), config.confirmations);
  await waitFor(deployer.sendTransaction({ to: await wallet.getAddress(), value: config.vaultFundingWei }), config.confirmations);

  const addresses = {
    walletAddress: await wallet.getAddress(),
    aclAddress: await acl.getAddress(),
    attestationAddress: await attestations.getAddress(),
    oracleAddress: await oracle.getAddress(),
    policyEngineAddress: await policy.getAddress(),
    feedAddress: config.feedAddress,
    ownerAddress: config.ownerAddress,
    agentAddress: config.agentAddress,
    recipientAddress: config.recipientAddress,
  };

  const codeChecks = await Promise.all(
    [addresses.walletAddress, addresses.aclAddress, addresses.attestationAddress, addresses.oracleAddress, addresses.policyEngineAddress]
      .map((address) => ethers.provider.getCode(address)),
  );
  if (codeChecks.some((code) => code === "0x")) throw new Error("A deployed contract has no bytecode");

  const bindingsValid =
    (await wallet.owner()) === addresses.ownerAddress &&
    (await wallet.acl()) === addresses.aclAddress &&
    (await wallet.attestations()) === addresses.attestationAddress &&
    (await wallet.policyEngine()) === addresses.policyEngineAddress &&
    (await wallet.oracle()) === addresses.oracleAddress &&
    (await policy.owner()) === addresses.ownerAddress &&
    (await policy.acl()) === addresses.aclAddress &&
    (await policy.oracle()) === addresses.oracleAddress &&
    (await policy.authorizedConsumers(addresses.walletAddress)) &&
    (await policy.policyManagers(addresses.walletAddress)) &&
    (await oracle.feeds(ethers.ZeroAddress)) === addresses.feedAddress &&
    (await oracle.configurationLocked()) &&
    (await acl.hasRole(agentRole, addresses.agentAddress)) &&
    (await acl.tierOf(addresses.agentAddress)) === 2n &&
    (await attestations.hasRole(attesterRole, addresses.walletAddress)) &&
    (await attestations.hasRole(approverRole, addresses.walletAddress)) &&
    (await wallet.allowedRecipients(addresses.recipientAddress)) &&
    (await ethers.provider.getBalance(addresses.walletAddress)) >= config.vaultFundingWei;
  if (!bindingsValid) throw new Error("Post-deployment verification failed");

  const deployment = {
    chainId: Number(chain.chainId), network: network.name, ...addresses, abiVersion: "aegis.native-policy.v2",
    deployedAt: new Date().toISOString(),
    verification: {
      contractCodePresent: true, bindingsVerified: true, feedConfigurationLocked: true,
      feedDescription, feedDecimals: Number(feedDecimals),
      feedRoundId: roundData.roundId.toString(), feedUpdatedAt: roundData.updatedAt.toString(),
    },
  };

  const output = path.join(__dirname, "..", "deployments", "sepolia.json");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(deployment, null, 2)}\n`, { mode: 0o600 });
  console.log(`Sepolia deployment verified and written to ${output}`);
  console.log(JSON.stringify(deployment, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
