const { Wallet, ZeroAddress, getAddress } = require("ethers");

const UNSAFE_PRIVATE_KEYS = new Set([
  "0x0000000000000000000000000000000000000000000000000000000000000001",
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
]);

const SEPOLIA_CCIP = Object.freeze({
  routerAddress: "0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59",
  tokenAddress: "0xFd57b4ddBf88a4e07fF4e34C487b99af2Fe82a05",
  destinationTokenAddress: "0x88A2d74F47a237a62e7A51cdDa67270CE381555e",
  destinationChainId: 84532,
  destinationChainSelector: 10_344_971_235_874_465_080n,
  destinationNetwork: "base-sepolia",
});

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

function parseFlag(env, name) {
  const raw = env[name];
  if (raw === undefined || raw === "0") return false;
  if (raw === "1") return true;
  throw new Error(`${name} must be 0 or 1`);
}

function readSepoliaDeploymentConfig(env = process.env) {
  const privateKey = parsePrivateKey(env);
  const deployerAddress = new Wallet(privateKey).address;
  const ownerAddress = env.OWNER_ADDRESS === undefined ? deployerAddress : parseAddress(env, "OWNER_ADDRESS");
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
  if ([agentAddress, recipientAddress].some((value) => value.toLowerCase() === deployerAddress.toLowerCase())) {
    throw new Error("deployer, agent, and recipient must be three different addresses");
  }

  const confirmations = Number(env.DEPLOY_CONFIRMATIONS || "2");
  if (!Number.isSafeInteger(confirmations) || confirmations < 1 || confirmations > 64) {
    throw new Error("DEPLOY_CONFIRMATIONS must be an integer between 1 and 64");
  }

  const ccipEnabled = parseFlag(env, "CCIP_ENABLED");
  const ccip = ccipEnabled ? {
    ...SEPOLIA_CCIP,
    tokenFundingWei: parsePositiveBigInt(env, "CCIP_TOKEN_FUNDING_WEI"),
    feeFundingWei: parsePositiveBigInt(env, "CCIP_FEE_FUNDING_WEI"),
    testTokenPriceUsd8: parsePositiveBigInt(env, "CCIP_TEST_TOKEN_PRICE_USD8"),
  } : null;
  return {
    privateKey, rpcUrl, deployerAddress, ownerAddress, agentAddress, recipientAddress, feedAddress,
    autoLimitUsd6, perTxLimitUsd6, dailyLimitUsd6, maxPriceAge, vaultFundingWei, confirmations,
    ccip,
  };
}

module.exports = { readSepoliaDeploymentConfig, UNSAFE_PRIVATE_KEYS, SEPOLIA_CCIP };
