const { ZeroAddress, getAddress, getCreateAddress } = require("ethers");

const same = (first, second) => first.toLowerCase() === second.toLowerCase();
async function waitFor(txPromise, confirmations) {
  const tx = await txPromise;
  await tx.wait(confirmations);
}

async function validateDeploymentOwner({ provider, deployerAddress, ownerAddress, agentAddress, recipientAddress }) {
  let owner;
  try { owner = getAddress(ownerAddress); }
  catch { throw new Error("OWNER_ADDRESS must be a valid EVM address"); }
  if ([ZeroAddress, agentAddress, recipientAddress].some(address => same(address, owner))) {
    throw new Error("OWNER_ADDRESS must be nonzero and distinct from the agent and recipient");
  }
  const code = await provider.getCode(owner);
  // EIP-7702 delegated EOAs retain normal signatures and transaction origination.
  // A zero delegation target clears code in the protocol, rather than storing a marker.
  const delegation = /^0xef0100([0-9a-f]{40})$/i.exec(code);
  const delegatedEoa = delegation !== null && BigInt(`0x${delegation[1]}`) !== 0n;
  if (code !== "0x" && !delegatedEoa) {
    throw new Error("OWNER_ADDRESS must have empty code or an exact nonzero EIP-7702 delegation supported by Owner login");
  }
  // The five Sepolia CREATE transactions precede all configuration transactions.
  const firstNonce = await provider.getTransactionCount(deployerAddress, "pending");
  for (let offset = 0; offset < 5; offset++) {
    if (same(getCreateAddress({ from: deployerAddress, nonce: firstNonce + offset }), owner)) {
      throw new Error("OWNER_ADDRESS cannot be an address of this deployment's contracts");
    }
  }
}

async function administrationRoles(acl, attestations) {
  return [
    [acl, [await acl.OWNER_ROLE(), await acl.GUARDIAN_ROLE(), await acl.DEFAULT_ADMIN_ROLE()]],
    [attestations, [await attestations.APPROVER_ROLE(), await attestations.DEFAULT_ADMIN_ROLE()]],
  ];
}

async function verifyOwnerAdministration({ wallet, policy, oracle, acl, attestations, deployerAddress, ownerAddress }) {
  for (const contract of [wallet, policy, oracle]) {
    if (!same(await contract.owner(), ownerAddress)) throw new Error("Final contract Owner verification failed");
  }
  for (const [contract, roles] of await administrationRoles(acl, attestations)) {
    for (const role of roles) {
      if (!(await contract.hasRole(role, ownerAddress))) throw new Error("Final Owner administration role missing");
      if (!same(ownerAddress, deployerAddress) && await contract.hasRole(role, deployerAddress)) {
        throw new Error("Deployer retained an Owner administration role");
      }
    }
  }
}

async function handoffOwnerAdministration(contracts, { deployerAddress, ownerAddress, confirmations = 1 }) {
  const finalOwner = getAddress(ownerAddress);
  if (finalOwner === ZeroAddress) throw new Error("OWNER_ADDRESS must not be the zero address");
  const { wallet, policy, oracle, acl, attestations } = contracts;
  const changed = !same(finalOwner, deployerAddress);
  if (changed) {
    const roleGroups = await administrationRoles(acl, attestations);
    for (const [contract, roles] of roleGroups) {
      for (const role of roles) await waitFor(contract.grantRole(role, finalOwner), confirmations);
      for (const role of roles) {
        if (!(await contract.hasRole(role, finalOwner))) throw new Error("Owner role grant verification failed before handoff");
      }
    }
    for (const contract of [wallet, policy, oracle]) {
      await waitFor(contract.transferOwnership(finalOwner), confirmations);
      if (!same(await contract.owner(), finalOwner)) throw new Error("Contract ownership handoff failed");
    }
    // Each DEFAULT_ADMIN_ROLE is last so the deployer can finish removing itself.
    for (const [contract, roles] of roleGroups) {
      for (const role of roles) await waitFor(contract.revokeRole(role, deployerAddress), confirmations);
    }
  }
  await verifyOwnerAdministration({ ...contracts, deployerAddress, ownerAddress: finalOwner });
  return { ownerAdministrationVerified: true, deployerAdministrationRevoked: changed };
}

module.exports = { validateDeploymentOwner, handoffOwnerAdministration, verifyOwnerAdministration };
