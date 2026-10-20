require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
const { subtask } = require("hardhat/config");
const {
  TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD,
  TASK_COMPILE_SOLIDITY_RUN_SOLCJS,
} = require("hardhat/builtin-tasks/task-names");

// Use the pinned npm compiler. Local tests/deployments never need a download or .env.
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD).setAction(async ({ solcVersion }, hre, runSuper) => {
  if (solcVersion === "0.8.24") return {
    compilerPath: require.resolve("solc/soljson.js"),
    isSolcJs: true,
    version: solcVersion,
    longVersion: require("solc").version(),
  };
  return runSuper();
});

// Hardhat 2's child-process solc runner can return truncated JSON on Node 24.
// Compile with the same pinned solc-js module in-process to keep builds stable.
subtask(TASK_COMPILE_SOLIDITY_RUN_SOLCJS).setAction(async ({ input, solcJsPath }) => {
  const solc = require("solc/wrapper")(require(solcJsPath));
  return JSON.parse(solc.compile(JSON.stringify(input)));
});

function configuredAccounts() {
  if (!process.env.PRIVATE_KEY) return [];
  const privateKey = process.env.PRIVATE_KEY.startsWith("0x")
    ? process.env.PRIVATE_KEY
    : `0x${process.env.PRIVATE_KEY}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("PRIVATE_KEY must be a 32-byte hex value");
  }
  return [privateKey];
}

const RPC_URL = process.env.RPC_URL || "https://ethereum-sepolia.publicnode.com";

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    hardhat: {},
    localhost: { url: "http://127.0.0.1:8545", chainId: 31337 },
    sepolia: {
      url: RPC_URL,
      accounts: configuredAccounts(),
      chainId: 11155111,
    },
    scrollSepolia: {
      url: process.env.SCROLL_RPC_URL || "https://sepolia-rpc.scroll.io",
      accounts: configuredAccounts(),
      chainId: 534351,
    },
  },
};
