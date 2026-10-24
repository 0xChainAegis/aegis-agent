const { expect } = require('chai');
const { ethers, network } = require('hardhat');
const { deployLocal } = require('../scripts/deploy-local');

describe('Explicit local CCIP fixture', function () {
  let snapshot;

  beforeEach(async function () {
    snapshot = await network.provider.send('evm_snapshot');
  });

  afterEach(async function () {
    await network.provider.send('evm_revert', [snapshot]);
  });

  it('does not expose CCIP deployment fields without the explicit flag', async function () {
    const deployment = await deployLocal({ env: {}, persist: false, log: false });
    expect(deployment.ccipSenderAddress).to.equal(undefined);
    expect(deployment.abiVersion).to.equal('aegis.native-policy.v2');
  });

  it('deploys and funds a policy-bound local CCIP lane when enabled', async function () {
    const deployment = await deployLocal({ env: { AEGIS_LOCAL_CCIP_FIXTURE: '1' }, persist: false, log: false });
    const sender = await ethers.getContractAt('AegisCCIPSender', deployment.ccipSenderAddress);
    const policy = await ethers.getContractAt('AegisPolicyEngine', deployment.policyEngineAddress);
    const oracle = await ethers.getContractAt('AegisPriceOracle', deployment.oracleAddress);
    const token = await ethers.getContractAt('MockERC20', deployment.ccipTokenAddress);

    expect(deployment.abiVersion).to.equal('aegis.unified-actions.local.v1');
    expect(await sender.router()).to.equal(deployment.ccipRouterAddress);
    expect(await sender.policyEngine()).to.equal(deployment.policyEngineAddress);
    expect(await policy.authorizedConsumers(deployment.ccipSenderAddress)).to.equal(true);
    expect(await policy.allowedDestinationChains(deployment.ccipDestinationChainSelector)).to.equal(true);
    expect(await oracle.feeds(deployment.ccipTokenAddress)).to.equal(deployment.ccipTokenFeedAddress);
    expect(await token.balanceOf(deployment.ccipSenderAddress)).to.equal(ethers.parseUnits('1000', 18));
    expect(await ethers.provider.getBalance(deployment.ccipSenderAddress)).to.equal(ethers.parseEther('1'));
  });

  it('supports an automatic local token transfer through the configured mock router', async function () {
    const deployment = await deployLocal({ env: { AEGIS_LOCAL_CCIP_FIXTURE: '1' }, persist: false, log: false });
    const [, agent] = await ethers.getSigners();
    const sender = await ethers.getContractAt('AegisCCIPSender', deployment.ccipSenderAddress, agent);
    const token = await ethers.getContractAt('MockERC20', deployment.ccipTokenAddress);
    const policy = await ethers.getContractAt('AegisPolicyEngine', deployment.policyEngineAddress);
    const version = await policy.policyVersion();
    const amount = ethers.parseUnits('1', 18);
    const fee = await sender.quoteCrossChainFee(deployment.ccipDestinationChainSelector, deployment.recipientAddress, deployment.ccipTokenAddress, amount);
    const deadline = BigInt((await ethers.provider.getBlock('latest')).timestamp + 600);

    await expect(sender.requestCrossChainTransfer(
      deployment.recipientAddress,
      deployment.ccipTokenAddress,
      amount,
      1_010_000,
      fee,
      0,
      deadline,
      version,
      deployment.ccipDestinationChainSelector,
    )).to.emit(sender, 'CCIPTransferExecuted');

    expect(await token.balanceOf(deployment.recipientAddress)).to.equal(amount);
    const spending = await policy.spendingToday();
    expect(spending[0]).to.equal(1_000_000);
  });

  it('rejects ambiguous flags and invalid selectors before deployment', async function () {
    const [owner] = await ethers.getSigners();
    const nonce = await ethers.provider.getTransactionCount(owner.address);
    await expect(deployLocal({ env: { AEGIS_LOCAL_CCIP_FIXTURE: 'yes' }, persist: false, log: false }))
      .to.be.rejectedWith('AEGIS_LOCAL_CCIP_FIXTURE');
    await expect(deployLocal({ env: { AEGIS_LOCAL_CCIP_FIXTURE: '1', AEGIS_LOCAL_CCIP_DESTINATION_SELECTOR: '0' }, persist: false, log: false }))
      .to.be.rejectedWith('AEGIS_LOCAL_CCIP_DESTINATION_SELECTOR');
    expect(await ethers.provider.getTransactionCount(owner.address)).to.equal(nonce);
  });
});
