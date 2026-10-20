const { Wallet, ZeroAddress, getAddress } = require("ethers");

const UNSAFE_PRIVATE_KEYS = new Set([
  "0x0000000000000000000000000000000000000000000000000000000000000001",
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
]);

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for a Sepolia deployment`);
  return value;
}

function parsePrivateKey(env) {
  const raw = required(env, "PRIVATE_KEY");
  const value = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error("PRIVATE_KEY must be a 32-byte hex value");
  if (UNSAFE_PRIVATE_KEYS.has(value.toLowerCase())) {
    throw new Error("PRIVATE_KEY is a known local development key and must not be used on Sepolia");
  }
  return value;
}

function parseAddress(env, name) {
  const raw = required(env, name);
  let value;
  try {
    value = getAddress(raw);
  } catch {
    throw new Error(`${name} must be a valid EVM address`);
  }
  if (value === ZeroAddress) throw new Error(`${name} must not be the zero address`);
  return value;
}

function parsePositiveBigInt(env, name) {
  const raw = required(env, name);
  let value;
  try {
    value = BigInt(raw);
  } catch {
    throw new Error(`${name} must be an integer`);
  }
  if (value <= 0n) throw new Error(`${name} must be greater than zero`);
  return value;
}

function readSepoliaDeploymentConfig(env = process.env) {
  const privateKey = parsePrivateKey(env);
  const ownerAddress = new Wallet(privateKey).address;
  const agentAddress = parseAddress(env, "AGENT_ADDRESS");
  const recipientAddress = parseAddress(env, "RECIPIENT_ADDRESS");
  const feedAddress = parseAddress(env, "ETH_USD_FEED_ADDRESS");
  const autoLimitUsd6 = parsePositiveBigInt(env, "AUTO_LIMIT_USD6");
  const perTxLimitUsd6 = parsePositiveBigInt(env, "PER_TX_LIMIT_USD6");
  const dailyLimitUsd6 = parsePositiveBigInt(env, "DAILY_LIMIT_USD6");
  const maxPriceAge = parsePositiveBigInt(env, "MAX_PRICE_AGE");
  const vaultFundingWei = parsePositiveBigInt(env, "VAULT_FUNDING_WEI");
  const rpcUrl = required(env, "RPC_URL");

  let parsedRpcUrl;
  try {
    parsedRpcUrl = new URL(rpcUrl);
  } catch {
    throw new Error("RPC_URL must be a valid URL");
  }
  if (parsedRpcUrl.protocol !== "https:") throw new Error("RPC_URL must use HTTPS for a public Sepolia deployment");
  if (autoLimitUsd6 > perTxLimitUsd6 || perTxLimitUsd6 > dailyLimitUsd6) {
    throw new Error("limits must satisfy AUTO_LIMIT_USD6 <= PER_TX_LIMIT_USD6 <= DAILY_LIMIT_USD6");
  }
  if (new Set([ownerAddress, agentAddress, recipientAddress].map((value) => value.toLowerCase())).size !== 3) {
    throw new Error("owner, agent, and recipient must be three different addresses");
  }

  const confirmations = Number(env.DEPLOY_CONFIRMATIONS || "2");
  if (!Number.isSafeInteger(confirmations) || confirmations < 1 || confirmations > 64) {
    throw new Error("DEPLOY_CONFIRMATIONS must be an integer between 1 and 64");
  }

  return {
    privateKey, rpcUrl, ownerAddress, agentAddress, recipientAddress, feedAddress,
    autoLimitUsd6, perTxLimitUsd6, dailyLimitUsd6, maxPriceAge, vaultFundingWei, confirmations,
  };
}

module.exports = { readSepoliaDeploymentConfig, UNSAFE_PRIVATE_KEYS };
