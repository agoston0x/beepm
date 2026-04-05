require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

module.exports = {
  solidity: "0.8.20",
  networks: {
    baseSepolia: {
      url: "https://sepolia.base.org",
      chainId: 84532,
      accounts: process.env.SPONSOR_PRIVATE_KEY ? [process.env.SPONSOR_PRIVATE_KEY] : []
    }
  }
};
