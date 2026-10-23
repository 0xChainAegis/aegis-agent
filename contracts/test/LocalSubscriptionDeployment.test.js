const { expect } = require('chai');
const { ethers, network } = require('hardhat');
const { deployLocal } = require('../scripts/deploy-local');

describe('Explicit local subscription fixture', function () {
  let snapshot;
  beforeEach(async () => { snapshot = await network.provider.send('evm_snapshot'); });
  afterEach(async () => { await network.provider.send('evm_revert', [snapshot]); });

  it('leaves subscription policy disabled without an explicit local fixture flag', async function () {
    const deployment = await deployLocal({ env: {}, persist: false, log: false });
    const policy = await ethers.getContractAt('AegisPolicyEngine', deployment.policyEngineAddress);
    expect(await policy.maxSubscriptionPeriodCapUsd6()).to.equal(0);
  });

  it('configures bounded test-only limits when explicitly requested', async function () {
    const deployment = await deployLocal({ env: { AEGIS_LOCAL_SUBSCRIPTION_FIXTURE: '1' }, persist: false, log: false });
    const policy = await ethers.getContractAt('AegisPolicyEngine', deployment.policyEngineAddress);
    expect(await policy.maxSubscriptionPeriodCapUsd6()).to.equal(10_000_000);
    expect(await policy.maxSubscriptionDurationSeconds()).to.equal(86_400);
    expect(await policy.maxSubscriptionPayments()).to.equal(24);
  });

  it('rejects ambiguous fixture flags before deploying anything', async function () {
    const [owner] = await ethers.getSigners();
    const nonce = await ethers.provider.getTransactionCount(owner.address);
    let message = '';
    try { await deployLocal({ env: { AEGIS_LOCAL_SUBSCRIPTION_FIXTURE: 'true' }, persist: false, log: false }); }
    catch (error) { message = error.message; }
    expect(message).to.include('AEGIS_LOCAL_SUBSCRIPTION_FIXTURE');
    expect(await ethers.provider.getTransactionCount(owner.address)).to.equal(nonce);
  });
});
