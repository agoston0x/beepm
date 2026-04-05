const { ethers } = require('ethers');
const provider = new ethers.JsonRpcProvider('https://sepolia.base.org');
const REGISTRY_ABI = ['function getSubdomainByWallet(address wallet) external view returns (string)'];
const registry = new ethers.Contract('0xc95BCe68a26F31F2E3679Abe7c55eC776Ec6aaee', REGISTRY_ABI, provider);
(async () => {
  const wallet = '0xDb96ED70'; // partial, let me get full
  console.log('Checking...');
})();
