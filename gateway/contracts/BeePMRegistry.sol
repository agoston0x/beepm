// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract BeePMRegistry {
    struct Profile {
        address wallet;
        string encryptedData;
        uint256 timestamp;
    }
    
    mapping(string => Profile) public profiles; // subdomain => profile
    mapping(address => string) public walletToSubdomain;
    
    event ProfileRegistered(string subdomain, address wallet, uint256 timestamp);
    
    function register(string calldata subdomain, string calldata encryptedData) external {
        require(bytes(subdomain).length >= 6 && bytes(subdomain).length <= 12, "subdomain 6-12 chars");
        require(profiles[subdomain].wallet == address(0), "subdomain taken");
        require(bytes(walletToSubdomain[msg.sender]).length == 0, "wallet already registered");
        
        profiles[subdomain] = Profile({
            wallet: msg.sender,
            encryptedData: encryptedData,
            timestamp: block.timestamp
        });
        walletToSubdomain[msg.sender] = subdomain;
        
        emit ProfileRegistered(subdomain, msg.sender, block.timestamp);
    }
    
    function getProfile(string calldata subdomain) external view returns (address, string memory, uint256) {
        Profile memory p = profiles[subdomain];
        return (p.wallet, p.encryptedData, p.timestamp);
    }
    
    function getSubdomainByWallet(address wallet) external view returns (string memory) {
        return walletToSubdomain[wallet];
    }
}
