const { ethers, network } = require("hardhat");
const { readSepoliaDeploymentConfig } = require("./sepolia-config");
const { validateDeploymentOwner, handoffOwnerAdministration } = require("./owner-handoff");
const { assertSepoliaDeploymentAvailable, persistSepoliaDeployment } = require("./sepolia-manifest");

const FEED_ABI = [
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
];
const ROUTER_ABI = ["function isChainSupported(uint64 destinationChainSelector) view returns (bool)"];
const TOKEN_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
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
  if (!deployer || deployer.address.toLowerCase() !== config.deployerAddress.toLowerCase()) {
    throw new Error("Configured signer does not match the deployer derived from PRIVATE_KEY");
  }
  await validateDeploymentOwner({
    provider: ethers.provider,
    ...config,
    deploymentContractCount: config.ccip === null ? 5 : 7,
  });
  // The wallet is the fifth CREATE transaction. Refuse an archive collision
  // before deploying anything, so a manifest error cannot waste Sepolia gas.
  const firstDeploymentNonce = await ethers.provider.getTransactionCount(deployer.address, "pending");
  const predictedWalletAddress = ethers.getCreateAddress({ from: deployer.address, nonce: firstDeploymentNonce + 4 });
  assertSepoliaDeploymentAvailable({ ownerAddress: config.ownerAddress, walletAddress: predictedWalletAddress });

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

  let ccipRouter;
  let ccipToken;
  let ccipTokenSymbol;
  let ccipTokenDecimals;
  if (config.ccip !== null) {
    const [routerCode, tokenCode] = await Promise.all([
      ethers.provider.getCode(config.ccip.routerAddress),
      ethers.provider.getCode(config.ccip.tokenAddress),
    ]);
    if (routerCode === "0x") throw new Error("Canonical Sepolia CCIP Router has no contract bytecode");
    if (tokenCode === "0x") throw new Error("Canonical Sepolia CCIP-BnM has no contract bytecode");
    ccipRouter = new ethers.Contract(config.ccip.routerAddress, ROUTER_ABI, ethers.provider);
    ccipToken = new ethers.Contract(config.ccip.tokenAddress, TOKEN_ABI, deployer);
    [ccipTokenSymbol, ccipTokenDecimals] = await Promise.all([ccipToken.symbol(), ccipToken.decimals()]);
    if (ccipTokenSymbol !== "CCIP-BnM" || ccipTokenDecimals !== 18n) {
      throw new Error(`Expected 18-decimal CCIP-BnM, got ${ccipTokenSymbol}/${ccipTokenDecimals}`);
    }
    if (!(await ccipRouter.isChainSupported(config.ccip.destinationChainSelector))) {
      throw new Error("Sepolia CCIP Router does not support the configured Base Sepolia selector");
    }
    if (await ccipToken.balanceOf(deployer.address) < config.ccip.tokenFundingWei) {
      throw new Error("Deployer does not have enough Sepolia CCIP-BnM for CCIP_TOKEN_FUNDING_WEI");
    }
  }

  const acl = await deploy("AegisAccessControl", [config.deployerAddress, config.agentAddress], config.confirmations);
  const attestations = await deploy("AegisAttestation", [config.deployerAddress, config.agentAddress], config.confirmations);
  const oracle = await deploy("AegisPriceOracle", [config.deployerAddress], config.confirmations);
  const policy = await deploy("AegisPolicyEngine", [config.deployerAddress, await acl.getAddress()], config.confirmations);
  const wallet = await deploy(
    "AegisWallet",
    [config.deployerAddress, await acl.getAddress(), await attestations.getAddress(), await policy.getAddress()],
    config.confirmations,
  );
  const ccipTokenFeed = config.ccip === null ? null : await deploy(
    "AegisTestnetPriceFeed", [config.deployerAddress, config.ccip.testTokenPriceUsd8], config.confirmations,
  );
  const ccipSender = config.ccip === null ? null : await deploy(
    "AegisCCIPSender",
    [config.deployerAddress, config.ccip.routerAddress, await attestations.getAddress(), await policy.getAddress()],
    config.confirmations,
  );

  await waitFor(oracle.setFeed(ethers.ZeroAddress, config.feedAddress, 18), config.confirmations);
  if (config.ccip !== null && ccipTokenFeed !== null) {
    await waitFor(oracle.setFeed(config.ccip.tokenAddress, await ccipTokenFeed.getAddress(), 18), config.confirmations);
  }
  await waitFor(oracle.lockConfiguration(), config.confirmations);
  await waitFor(policy.setConsumer(await wallet.getAddress(), true), config.confirmations);
  await waitFor(policy.setPolicyManager(await wallet.getAddress(), true), config.confirmations);

  const attesterRole = await attestations.ATTESTER_ROLE();
  const approverRole = await attestations.APPROVER_ROLE();
  const agentRole = await acl.AGENT_ROLE();
  await waitFor(attestations.grantRole(attesterRole, await wallet.getAddress()), config.confirmations);
  await waitFor(attestations.grantRole(approverRole, await wallet.getAddress()), config.confirmations);
  await waitFor(acl.setTier(config.agentAddress, 2, 0), config.confirmations);
  if (config.ccip !== null && ccipSender !== null) {
    const senderAddress = await ccipSender.getAddress();
    await waitFor(policy.setConsumer(senderAddress, true), config.confirmations);
    await waitFor(policy.setPolicyManager(senderAddress, true), config.confirmations);
    await waitFor(attestations.grantRole(attesterRole, senderAddress), config.confirmations);
    await waitFor(attestations.grantRole(approverRole, senderAddress), config.confirmations);
  }

  await waitFor(
    wallet.configurePolicy(await oracle.getAddress(), config.autoLimitUsd6, config.perTxLimitUsd6, config.dailyLimitUsd6, config.maxPriceAge),
    config.confirmations,
  );
  await waitFor(wallet.setRecipientAllowed(config.recipientAddress, true), config.confirmations);
  if (config.ccip !== null && ccipSender !== null && ccipToken !== undefined) {
    const senderAddress = await ccipSender.getAddress();
    await waitFor(ccipSender.setDestinationChainAllowed(config.ccip.destinationChainSelector, true), config.confirmations);
    await waitFor(ccipToken.approve(senderAddress, config.ccip.tokenFundingWei), config.confirmations);
    await waitFor(ccipSender.depositToken(config.ccip.tokenAddress, config.ccip.tokenFundingWei), config.confirmations);
    await waitFor(deployer.sendTransaction({ to: senderAddress, value: config.ccip.feeFundingWei }), config.confirmations);
  }
  await waitFor(deployer.sendTransaction({ to: await wallet.getAddress(), value: config.vaultFundingWei }), config.confirmations);
  const ownerVerification = await handoffOwnerAdministration(
    {
      wallet, policy, oracle, acl, attestations,
      additionalOwnedContracts: [ccipSender, ccipTokenFeed].filter((contract) => contract !== null),
    },
    config,
  );

  const addresses = {
    walletAddress: await wallet.getAddress(),
    aclAddress: await acl.getAddress(),
    attestationAddress: await attestations.getAddress(),
    oracleAddress: await oracle.getAddress(),
    policyEngineAddress: await policy.getAddress(),
    feedAddress: config.feedAddress,
    ownerAddress: config.ownerAddress,
    deployerAddress: config.deployerAddress,
    agentAddress: config.agentAddress,
    recipientAddress: config.recipientAddress,
  };
  const ccipAddresses = config.ccip === null || ccipSender === null || ccipTokenFeed === null ? {} : {
    ccipSenderAddress: await ccipSender.getAddress(),
    ccipRouterAddress: config.ccip.routerAddress,
    ccipTokenAddress: config.ccip.tokenAddress,
    ccipTokenFeedAddress: await ccipTokenFeed.getAddress(),
    ccipDestinationChainSelector: config.ccip.destinationChainSelector.toString(),
    ccipDestinationChainId: config.ccip.destinationChainId,
    ccipDestinationNetwork: config.ccip.destinationNetwork,
    ccipDestinationTokenAddress: config.ccip.destinationTokenAddress,
    ccipTokenPriceSource: "OWNER_MAINTAINED_TESTNET_VALUE",
  };

  const codeChecks = await Promise.all(
    [
      addresses.walletAddress, addresses.aclAddress, addresses.attestationAddress,
      addresses.oracleAddress, addresses.policyEngineAddress,
      ...(config.ccip === null || ccipSender === null || ccipTokenFeed === null ? [] : [
        await ccipSender.getAddress(), await ccipTokenFeed.getAddress(),
        config.ccip.routerAddress, config.ccip.tokenAddress,
      ]),
    ]
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
    (await oracle.owner()) === addresses.ownerAddress &&
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
    (await wallet.autoLimitUsd6()) === config.autoLimitUsd6 &&
    (await wallet.perTxLimitUsd6()) === config.perTxLimitUsd6 &&
    (await wallet.dailyLimitUsd6()) === config.dailyLimitUsd6 &&
    (await wallet.maxPriceAge()) === config.maxPriceAge &&
    (await ethers.provider.getBalance(addresses.walletAddress)) >= config.vaultFundingWei;
  if (!bindingsValid) throw new Error("Post-deployment verification failed");
  if (config.ccip !== null && ccipSender !== null && ccipTokenFeed !== null && ccipToken !== undefined) {
    const senderAddress = await ccipSender.getAddress();
    const ccipBindingsValid =
      (await ccipSender.owner()) === addresses.ownerAddress &&
      (await ccipTokenFeed.owner()) === addresses.ownerAddress &&
      (await ccipSender.router()) === config.ccip.routerAddress &&
      (await ccipSender.attestations()) === addresses.attestationAddress &&
      (await ccipSender.policyEngine()) === addresses.policyEngineAddress &&
      (await oracle.feeds(config.ccip.tokenAddress)) === await ccipTokenFeed.getAddress() &&
      (await policy.authorizedConsumers(senderAddress)) &&
      (await policy.policyManagers(senderAddress)) &&
      (await policy.allowedDestinationChains(config.ccip.destinationChainSelector)) &&
      (await attestations.hasRole(attesterRole, senderAddress)) &&
      (await attestations.hasRole(approverRole, senderAddress)) &&
      (await ccipToken.balanceOf(senderAddress)) === config.ccip.tokenFundingWei &&
      (await ethers.provider.getBalance(senderAddress)) >= config.ccip.feeFundingWei;
    if (!ccipBindingsValid) throw new Error("CCIP post-deployment verification failed");
  }

  const deployment = {
    chainId: Number(chain.chainId), network: network.name, ...addresses, ...ccipAddresses,
    abiVersion: config.ccip === null ? "aegis.native-policy.v2" : "aegis.unified-actions.sepolia.v1",
    deployedAt: new Date().toISOString(),
    verification: {
      contractCodePresent: true, bindingsVerified: true, feedConfigurationLocked: true,
      ...ownerVerification,
      feedDescription, feedDecimals: Number(feedDecimals),
      feedRoundId: roundData.roundId.toString(), feedUpdatedAt: roundData.updatedAt.toString(),
      ...(config.ccip === null ? {} : {
        ccipRouteVerified: true,
        ccipTokenSymbol,
        ccipTokenDecimals: Number(ccipTokenDecimals),
        ccipTokenFundingWei: config.ccip.tokenFundingWei.toString(),
        ccipFeeFundingWei: config.ccip.feeFundingWei.toString(),
        ccipTestTokenPriceUsd8: config.ccip.testTokenPriceUsd8.toString(),
      }),
    },
  };

  const outputs = persistSepoliaDeployment(deployment);
  console.log(`Sepolia deployment verified and written to ${outputs.canonical}`);
  console.log(`Owner pool deployment preserved at ${outputs.archive}`);
  console.log(JSON.stringify(deployment, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
