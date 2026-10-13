require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const PRIVATE_KEY = process.env.PRIVATE_KEY || "0x0000000000000000000000000000000000000000000000000000000000000001";
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
    sepolia: {
      url: RPC_URL,
      accounts: [PRIVATE_KEY],
      chainId: 11155111,
    },
    scrollSepolia: {
      url: process.env.SCROLL_RPC_URL || "https://sepolia-rpc.scroll.io",
      accounts: [PRIVATE_KEY],
      chainId: 534351,
    },
  },
};
