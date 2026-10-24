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
    ccip: config.ccip === null ? null : {
      routerAddress: config.ccip.routerAddress,
      tokenAddress: config.ccip.tokenAddress,
      destinationTokenAddress: config.ccip.destinationTokenAddress,
      destinationChainId: config.ccip.destinationChainId,
      destinationChainSelector: config.ccip.destinationChainSelector.toString(),
      destinationNetwork: config.ccip.destinationNetwork,
      tokenFundingWei: config.ccip.tokenFundingWei.toString(),
      feeFundingWei: config.ccip.feeFundingWei.toString(),
      testTokenPriceUsd8: config.ccip.testTokenPriceUsd8.toString(),
      priceSource: "OWNER_MAINTAINED_TESTNET_VALUE",
    },
  };
  console.log("Sepolia environment validation passed (private key and RPC URL redacted).");
  console.log(JSON.stringify(safeSummary, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
