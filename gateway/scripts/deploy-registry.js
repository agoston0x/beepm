const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying BeePMRegistry with:", deployer.address);
  console.log("Balance:", hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address)));

  const Registry = await hre.ethers.getContractFactory("BeePMRegistry");
  const registry = await Registry.deploy();
  await registry.waitForDeployment();

  const address = await registry.getAddress();
  console.log("BeePMRegistry deployed to:", address);
  console.log("Verify with:");
  console.log(`npx hardhat verify --network baseSepolia ${address}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
