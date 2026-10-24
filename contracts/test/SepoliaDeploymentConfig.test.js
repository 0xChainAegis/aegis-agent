const { expect } = require("chai");
const { Wallet, ZeroAddress } = require("ethers");
const { ethers } = require("hardhat");
const { readSepoliaDeploymentConfig, SEPOLIA_CCIP } = require("../scripts/sepolia-config");

const privateKey = `0x${"11".repeat(32)}`;

function validEnv() {
  return {
    PRIVATE_KEY: privateKey,
    RPC_URL: "https://example.invalid/sepolia",
    AGENT_ADDRESS: "0x1000000000000000000000000000000000000001",
    RECIPIENT_ADDRESS: "0x2000000000000000000000000000000000000002",
    ETH_USD_FEED_ADDRESS: "0x3000000000000000000000000000000000000003",
    AUTO_LIMIT_USD6: "10000000",
    PER_TX_LIMIT_USD6: "50000000",
    DAILY_LIMIT_USD6: "100000000",
    MAX_PRICE_AGE: "3600",
    VAULT_FUNDING_WEI: "10000000000000000",
    DEPLOY_CONFIRMATIONS: "2",
  };
}

describe("Sepolia deployment configuration", function () {
  it("accepts explicit safe values and defaults the Owner to the deployer", function () {
    const config = readSepoliaDeploymentConfig(validEnv());
    expect(config.ownerAddress).to.equal(new Wallet(privateKey).address);
    expect(config.deployerAddress).to.equal(config.ownerAddress);
    expect(config.autoLimitUsd6).to.equal(10_000_000n);
    expect(config.confirmations).to.equal(2);
    expect(config.ccip).to.equal(null);
  });

  it("accepts a distinct public final Owner without changing the deployment signer", function () {
    const finalOwner = new Wallet(`0x${"22".repeat(32)}`).address;
    const config = readSepoliaDeploymentConfig({ ...validEnv(), OWNER_ADDRESS: finalOwner.toLowerCase() });
    expect(config.ownerAddress).to.equal(finalOwner);
    expect(config.deployerAddress).to.equal(new Wallet(privateKey).address);
    expect(config.privateKey).to.equal(privateKey);
    const sameOwner = readSepoliaDeploymentConfig({ ...validEnv(), OWNER_ADDRESS: config.deployerAddress });
    expect(sameOwner.ownerAddress).to.equal(sameOwner.deployerAddress);
  });

  it("rejects invalid final Owner addresses before any deployment transaction", async function () {
    const [deployer] = await ethers.getSigners();
    const nonce = await ethers.provider.getTransactionCount(deployer.address);
    const env = validEnv();
    const invalid = [
      "", " ", "not-an-address", ZeroAddress,
      "0x52908400098527886E0F7030069857D2E4169Ee7",
      env.AGENT_ADDRESS, env.RECIPIENT_ADDRESS,
    ];
    for (const owner of invalid) {
      expect(() => readSepoliaDeploymentConfig({ ...env, OWNER_ADDRESS: owner })).to.throw(/OWNER_ADDRESS|owner, agent, and recipient/);
      expect(await ethers.provider.getTransactionCount(deployer.address)).to.equal(nonce);
    }
  });

  it("never lets the old deployer retain executor or recipient identity through an Owner override", function () {
    const deployer = new Wallet(privateKey).address;
    const OWNER_ADDRESS = new Wallet(`0x${"22".repeat(32)}`).address;
    for (const identity of ["AGENT_ADDRESS", "RECIPIENT_ADDRESS"]) {
      expect(() => readSepoliaDeploymentConfig({ ...validEnv(), OWNER_ADDRESS, [identity]: deployer })).to.throw("deployer, agent, and recipient must be three different addresses");
    }
  });

  it("rejects missing values and known development keys", function () {
    const missingFeed = validEnv();
    delete missingFeed.ETH_USD_FEED_ADDRESS;
    expect(() => readSepoliaDeploymentConfig(missingFeed)).to.throw("ETH_USD_FEED_ADDRESS is required");

    const unsafe = validEnv();
    unsafe.PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
    expect(() => readSepoliaDeploymentConfig(unsafe)).to.throw("known local development key");
  });

  it("rejects inverted limits, insecure RPC, and reused identities", function () {
    expect(() => readSepoliaDeploymentConfig({ ...validEnv(), AUTO_LIMIT_USD6: "50000001" })).to.throw("limits must satisfy");
    expect(() => readSepoliaDeploymentConfig({ ...validEnv(), RPC_URL: "http://example.invalid" })).to.throw("must use HTTPS");
    const owner = new Wallet(privateKey).address;
    expect(() => readSepoliaDeploymentConfig({ ...validEnv(), AGENT_ADDRESS: owner })).to.throw("three different addresses");
  });

  it("enables only the canonical Sepolia to Base Sepolia CCIP-BnM lane", function () {
    const config = readSepoliaDeploymentConfig({
      ...validEnv(),
      CCIP_ENABLED: "1",
      CCIP_TOKEN_FUNDING_WEI: "1000000000000000000",
      CCIP_FEE_FUNDING_WEI: "10000000000000000",
      CCIP_TEST_TOKEN_PRICE_USD8: "100000000",
    });
    expect(config.ccip).to.deep.equal({
      ...SEPOLIA_CCIP,
      tokenFundingWei: 1_000_000_000_000_000_000n,
      feeFundingWei: 10_000_000_000_000_000n,
      testTokenPriceUsd8: 100_000_000n,
    });
  });

  it("rejects ambiguous, empty, and nonpositive CCIP deployment funding", function () {
    expect(() => readSepoliaDeploymentConfig({ ...validEnv(), CCIP_ENABLED: "yes" })).to.throw("CCIP_ENABLED must be 0 or 1");
    for (const name of ["CCIP_TOKEN_FUNDING_WEI", "CCIP_FEE_FUNDING_WEI", "CCIP_TEST_TOKEN_PRICE_USD8"]) {
      const env = {
        ...validEnv(),
        CCIP_ENABLED: "1",
        CCIP_TOKEN_FUNDING_WEI: "1",
        CCIP_FEE_FUNDING_WEI: "1",
        CCIP_TEST_TOKEN_PRICE_USD8: "1",
        [name]: "0",
      };
      expect(() => readSepoliaDeploymentConfig(env)).to.throw(`${name} must be greater than zero`);
    }
  });
});
