// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title AegisAccessControl
/// @notice Permission tiers for AegisAgent. The wallet enforces USD6 limits.
/// @dev autoLimit/canAutoExecute are retained for ABI compatibility only; native
///      payments never use the legacy raw-token limit for authorization.
contract AegisAccessControl is AccessControl {
    bytes32 public constant OWNER_ROLE = keccak256("OWNER_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 public constant AGENT_ROLE = keccak256("AGENT_ROLE");

    /// @dev Frozen = no execution, ReadOnly = analytics only,
    ///      LowRisk = auto execution within limit,
    ///      HighRisk = every action queued for human approval.
    enum Tier {
        Frozen,
        ReadOnly,
        LowRisk,
        HighRisk
    }

    mapping(address => Tier) public tierOf;
    mapping(address => uint256) public autoLimit;

    event TierUpdated(address indexed account, uint8 tier, uint256 autoLimit);

    constructor(address admin, address agent) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(OWNER_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, admin);
        _grantRole(AGENT_ROLE, agent);
        tierOf[agent] = Tier.LowRisk;
        autoLimit[agent] = 0;
    }

    /// @notice Update an account's permission tier and auto-execution ceiling.
    function setTier(address account, Tier tier, uint256 limit) external onlyRole(OWNER_ROLE) {
        tierOf[account] = tier;
        autoLimit[account] = limit;
        emit TierUpdated(account, uint8(tier), limit);
    }

    /// @notice Returns true only when the agent is at LowRisk and within its limit.
    function canAutoExecute(address agent, uint256 amount) external view returns (bool) {
        return tierOf[agent] == Tier.LowRisk && amount > 0 && amount <= autoLimit[agent];
    }
}
