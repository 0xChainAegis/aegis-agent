const { ethers, network } = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

const same = (first, second) => first.toLowerCase() === second.toLowerCase();

async function deployLocal({ env = process.env, persist = true, log = true } = {}) {
  const chain = await ethers.provider.getNetwork();
  if (chain.chainId !== 31337n) throw new Error("Local deployment only: expected chainId 31337");
  const fixtureFlag = env.AEGIS_LOCAL_SUBSCRIPTION_FIXTURE;
  if (fixtureFlag !== undefined && fixtureFlag !== '0' && fixtureFlag !== '1') {
    throw new Error('AEGIS_LOCAL_SUBSCRIPTION_FIXTURE must be 0 or 1');
  }
  const ccipFixtureFlag = env.AEGIS_LOCAL_CCIP_FIXTURE;
  if (ccipFixtureFlag !== undefined && ccipFixtureFlag !== '0' && ccipFixtureFlag !== '1') {
    throw new Error('AEGIS_LOCAL_CCIP_FIXTURE must be 0 or 1');
  }
  const ccipFixtureEnabled = ccipFixtureFlag === '1';
  const selectorText = env.AEGIS_LOCAL_CCIP_DESTINATION_SELECTOR ?? '10344971235874465080';
  if (!/^[1-9]\d*$/.test(selectorText) || BigInt(selectorText) >= 2n ** 64n) {
    throw new Error('AEGIS_LOCAL_CCIP_DESTINATION_SELECTOR must be a positive uint64');
  }
  const ccipDestinationChainSelector = BigInt(selectorText);
  const [owner, agent, recipient] = await ethers.getSigners();
  if (!owner || !agent || !recipient || new Set([owner.address, agent.address, recipient.address]).size !== 3) {
    throw new Error("Three distinct local owner/agent/recipient accounts required");
  }
  const configuredOwner = env.AEGIS_LOCAL_OWNER_ADDRESS;
  if (configuredOwner !== undefined && (typeof configuredOwner !== "string" || !ethers.isAddress(configuredOwner))) {
    throw new Error("AEGIS_LOCAL_OWNER_ADDRESS must be a valid Ethereum address");
  }
  const presenter = configuredOwner === undefined ? owner.address : ethers.getAddress(configuredOwner);
  if ([ethers.ZeroAddress, agent.address, recipient.address].some(address => same(address, presenter))) {
    throw new Error("Local Owner must be nonzero and distinct from the agent and recipient");
  }
  if (await ethers.provider.getCode(presenter) !== "0x") {
    throw new Error("Local Owner must be an externally owned wallet, not a pool or another contract");
  }
  // Reject an address of a contract this deployment is about to create before
  // sending any deployment transaction. CCIP adds four opt-in fixture contracts.
  const firstNonce = await ethers.provider.getTransactionCount(owner.address);
  const predictedContracts = Array.from({ length: ccipFixtureEnabled ? 10 : 6 }, (_, offset) => ethers.getCreateAddress({ from: owner.address, nonce: firstNonce + offset }));
  if (predictedContracts.some(address => same(address, presenter))) {
    throw new Error("Local Owner cannot be an address of this deployment's contracts");
  }
  const acl = await ethers.deployContract("AegisAccessControl", [owner.address, agent.address]);
  const att = await ethers.deployContract("AegisAttestation", [owner.address, agent.address]);
  const feed = await ethers.deployContract("MockV3Aggregator", [8, ethers.parseUnits("3000", 8)]);
  const oracle = await ethers.deployContract("AegisPriceOracle", [owner.address]);
  await Promise.all([acl.waitForDeployment(), att.waitForDeployment(), feed.waitForDeployment(), oracle.waitForDeployment()]);
  const policy = await ethers.deployContract("AegisPolicyEngine", [owner.address, await acl.getAddress()]);
  await policy.waitForDeployment();
  const wallet = await ethers.deployContract("AegisWallet", [owner.address, await acl.getAddress(), await att.getAddress(), await policy.getAddress()]);
  await wallet.waitForDeployment();
  let ccipTokenFeed;
  let ccipRouter;
  let ccipToken;
  let ccipSender;
  if (ccipFixtureEnabled) {
    ccipTokenFeed = await ethers.deployContract('MockV3Aggregator', [8, ethers.parseUnits('1', 8)]);
    ccipRouter = await ethers.deployContract('MockCCIPRouter');
    ccipToken = await ethers.deployContract('MockERC20', ['Chainlink CCIP-BnM (local)', 'CCIP-BnM', 18]);
    ccipSender = await ethers.deployContract('AegisCCIPSender', [owner.address, await ccipRouter.getAddress(), await att.getAddress(), await policy.getAddress()]);
    await Promise.all([ccipTokenFeed.waitForDeployment(), ccipRouter.waitForDeployment(), ccipToken.waitForDeployment(), ccipSender.waitForDeployment()]);
  }
  await (await oracle.setFeed(ethers.ZeroAddress, await feed.getAddress(), 18)).wait();
  if (ccipFixtureEnabled) {
    await (await oracle.setFeed(await ccipToken.getAddress(), await ccipTokenFeed.getAddress(), 18)).wait();
  }
  await (await oracle.lockConfiguration()).wait();
  await (await policy.setConsumer(await wallet.getAddress(), true)).wait();
  await (await policy.setPolicyManager(await wallet.getAddress(), true)).wait();
  await (await att.grantRole(await att.ATTESTER_ROLE(), await wallet.getAddress())).wait();
  await (await att.grantRole(await att.APPROVER_ROLE(), await wallet.getAddress())).wait();
  await (await acl.setTier(agent.address, 2, 0)).wait();
  await (await wallet.configurePolicy(await oracle.getAddress(), 5_000_000, 10_000_000, 15_000_000, 3600)).wait();
  await (await wallet.setRecipientAllowed(recipient.address, true)).wait();
  // Explicit fixture values only. Normal deployments keep subscriptions disabled.
  if (fixtureFlag === '1') {
    await (await wallet.configureSubscriptionPolicy(10_000_000, 86_400, 24)).wait();
  }
  if (ccipFixtureEnabled) {
    const senderAddress = await ccipSender.getAddress();
    await (await policy.setConsumer(senderAddress, true)).wait();
    await (await policy.setPolicyManager(senderAddress, true)).wait();
    await (await att.grantRole(await att.ATTESTER_ROLE(), senderAddress)).wait();
    await (await att.grantRole(await att.APPROVER_ROLE(), senderAddress)).wait();
    await (await ccipSender.setDestinationChainAllowed(ccipDestinationChainSelector, true)).wait();
    await (await ccipRouter.setFee(ethers.parseEther('0.001'))).wait();
    await (await ccipToken.mint(owner.address, ethers.parseUnits('1000', 18))).wait();
    await (await ccipToken.approve(senderAddress, ethers.parseUnits('1000', 18))).wait();
    await (await ccipSender.depositToken(await ccipToken.getAddress(), ethers.parseUnits('1000', 18))).wait();
    await (await owner.sendTransaction({ to: senderAddress, value: ethers.parseEther('1') })).wait();
  }
  await (await owner.sendTransaction({ to: await wallet.getAddress(), value: ethers.parseEther("1") })).wait();
  const aclRoles = [await acl.OWNER_ROLE(), await acl.GUARDIAN_ROLE(), await acl.DEFAULT_ADMIN_ROLE()];
  const attestationRoles = [await att.APPROVER_ROLE(), await att.DEFAULT_ADMIN_ROLE()];
  if (!same(presenter, owner.address)) {
    for (const role of aclRoles) await (await acl.grantRole(role, presenter)).wait();
    for (const role of attestationRoles) await (await att.grantRole(role, presenter)).wait();
    for (const role of aclRoles) {
      if (!(await acl.hasRole(role, presenter))) throw new Error("Local Owner ACL role handoff failed");
    }
    for (const role of attestationRoles) {
      if (!(await att.hasRole(role, presenter))) throw new Error("Local Owner attestation role handoff failed");
    }
    const ownedContracts = ccipFixtureEnabled ? [wallet, policy, oracle, ccipSender] : [wallet, policy, oracle];
    for (const contract of ownedContracts) {
      await (await contract.transferOwnership(presenter)).wait();
      if (!same(await contract.owner(), presenter)) throw new Error("Local contract ownership handoff failed");
    }
    // DEFAULT_ADMIN_ROLE is last so the deployer can finish revoking its roles.
    for (const role of aclRoles) await (await acl.revokeRole(role, owner.address)).wait();
    for (const role of attestationRoles) await (await att.revokeRole(role, owner.address)).wait();
    await (await owner.sendTransaction({ to: presenter, value: ethers.parseEther("0.1") })).wait();
  }
  const addresses = {
    walletAddress: await wallet.getAddress(), aclAddress: await acl.getAddress(),
    attestationAddress: await att.getAddress(), oracleAddress: await oracle.getAddress(),
    policyEngineAddress: await policy.getAddress(), feedAddress: await feed.getAddress(),
  };
  const ccipAddresses = ccipFixtureEnabled ? {
    ccipSenderAddress: await ccipSender.getAddress(),
    ccipRouterAddress: await ccipRouter.getAddress(),
    ccipTokenAddress: await ccipToken.getAddress(),
    ccipTokenFeedAddress: await ccipTokenFeed.getAddress(),
    ccipDestinationChainSelector: ccipDestinationChainSelector.toString(),
  } : {};
  const bindingsValid =
    [await wallet.owner(), await policy.owner(), await oracle.owner()].every(address => same(address, presenter)) &&
    same(await wallet.acl(), addresses.aclAddress) && same(await wallet.attestations(), addresses.attestationAddress) &&
    same(await wallet.policyEngine(), addresses.policyEngineAddress) && same(await wallet.oracle(), addresses.oracleAddress) &&
    same(await policy.acl(), addresses.aclAddress) && same(await oracle.feeds(ethers.ZeroAddress), addresses.feedAddress) &&
    await oracle.configurationLocked() && await policy.authorizedConsumers(addresses.walletAddress) &&
    await policy.policyManagers(addresses.walletAddress) && await acl.hasRole(await acl.AGENT_ROLE(), agent.address) &&
    (await acl.tierOf(agent.address)) === 2n && await att.hasRole(await att.ATTESTER_ROLE(), addresses.walletAddress) &&
    await att.hasRole(await att.APPROVER_ROLE(), addresses.walletAddress) && await wallet.allowedRecipients(recipient.address) &&
    (await wallet.autoLimitUsd6()) === 5_000_000n && (await wallet.perTxLimitUsd6()) === 10_000_000n &&
    (await wallet.dailyLimitUsd6()) === 15_000_000n && (await wallet.maxPriceAge()) === 3600n &&
    (await ethers.provider.getBalance(addresses.walletAddress)) === ethers.parseEther("1");
  if (!bindingsValid) throw new Error("Local deployment bindings or policy verification failed");
  if (ccipFixtureEnabled) {
    const senderAddress = ccipAddresses.ccipSenderAddress;
    const ccipBindingsValid =
      same(await ccipSender.owner(), presenter) && same(await ccipSender.router(), ccipAddresses.ccipRouterAddress) &&
      same(await ccipSender.attestations(), addresses.attestationAddress) && same(await ccipSender.policyEngine(), addresses.policyEngineAddress) &&
      same(await oracle.feeds(ccipAddresses.ccipTokenAddress), ccipAddresses.ccipTokenFeedAddress) &&
      await policy.authorizedConsumers(senderAddress) && await policy.policyManagers(senderAddress) &&
      await policy.allowedDestinationChains(ccipDestinationChainSelector) && await policy.allowedRecipients(recipient.address) &&
      await att.hasRole(await att.ATTESTER_ROLE(), senderAddress) && await att.hasRole(await att.APPROVER_ROLE(), senderAddress) &&
      (await ccipToken.balanceOf(senderAddress)) === ethers.parseUnits('1000', 18) &&
      (await ethers.provider.getBalance(senderAddress)) === ethers.parseEther('1');
    if (!ccipBindingsValid) throw new Error('Local CCIP fixture bindings or funding verification failed');
  }
  for (const [contract, roles] of [[acl, aclRoles], [att, attestationRoles]]) {
    for (const role of roles) {
      if (!(await contract.hasRole(role, presenter))) throw new Error("Local Owner roles were not preserved");
      if (!same(presenter, owner.address) && await contract.hasRole(role, owner.address)) {
        throw new Error("Local deployer retained an Owner administration role");
      }
    }
  }
  const deployment = {
    chainId: Number(chain.chainId),
    rpcUrl: "http://127.0.0.1:8545",
    ...addresses,
    ...ccipAddresses,
    ownerAddress: presenter,
    mockUpdaterAddress: owner.address,
    agentAddress: agent.address,
    recipientAddress: recipient.address,
    abiVersion: ccipFixtureEnabled ? "aegis.unified-actions.local.v1" : "aegis.native-policy.v2",
  };
  if (persist) {
    const directory = path.join(__dirname, "..", "deployments");
    fs.mkdirSync(directory, { recursive: true });
    // hardhat's ephemeral in-process network is not a persistent RPC deployment.
    const filename = network.name === "localhost" ? "localhost.json" : "hardhat.json";
    fs.writeFileSync(path.join(directory, filename), JSON.stringify(deployment, null, 2) + "\n");
  }
  if (log) console.log(JSON.stringify(deployment, null, 2));
  return deployment;
}

module.exports = { deployLocal };
if (require.main === module) {
  deployLocal().catch((error) => { console.error(error); process.exitCode = 1; });
}
