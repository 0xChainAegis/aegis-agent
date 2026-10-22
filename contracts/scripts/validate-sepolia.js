const { readSepoliaDeploymentConfig } = require("./sepolia-config");

try {
  const config = readSepoliaDeploymentConfig();
  const safeSummary = {
    deployerAddress: config.deployerAddress,
    ownerAddress: config.ownerAddress,
    agentAddress: config.agentAddress,
    recipientAddress: config.recipientAddress,
    feedAddress: config.feedAddress,
    autoLimitUsd6: config.autoLimitUsd6.toString(),
    perTxLimitUsd6: config.perTxLimitUsd6.toString(),
    dailyLimitUsd6: config.dailyLimitUsd6.toString(),
    maxPriceAge: config.maxPriceAge.toString(),
    vaultFundingWei: config.vaultFundingWei.toString(),
    confirmations: config.confirmations,
  };
  console.log("Sepolia environment validation passed (private key and RPC URL redacted).");
  console.log(JSON.stringify(safeSummary, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
