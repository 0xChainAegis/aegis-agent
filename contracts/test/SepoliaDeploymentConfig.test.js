const { expect } = require("chai");
const { Wallet } = require("ethers");
const { readSepoliaDeploymentConfig } = require("../scripts/sepolia-config");

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
  it("accepts explicit safe values and derives the owner", function () {
    const config = readSepoliaDeploymentConfig(validEnv());
    expect(config.ownerAddress).to.equal(new Wallet(privateKey).address);
    expect(config.autoLimitUsd6).to.equal(10_000_000n);
    expect(config.confirmations).to.equal(2);
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
});
