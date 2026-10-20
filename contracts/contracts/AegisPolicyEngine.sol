// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {AegisAccessControl} from "./AegisAccessControl.sol";
import {AegisPriceOracle} from "./AegisPriceOracle.sol";

/// @notice Shared deterministic authorization and USD-budget policy for Aegis actions.
/// @dev Phase one executes native ETH only. Subscription and CCIP kinds are
///      reserved so later executors share this policy and its daily budget.
contract AegisPolicyEngine is Ownable {
    enum ActionType { NativeTransfer, Subscription, CCIPTransfer }
    enum Decision { Reject, Allow, RequireApproval }

    struct RiskRequest {
        ActionType actionType;
        address actor;
        address recipient;
        address asset;
        uint256 amount;
        uint256 maxUsdCost6;
        uint64 deadline;
        uint64 policyVersion;
        bytes32 requestHash;
        uint64 destinationChainSelector;
    }

    struct RiskResult {
        Decision decision;
        bytes32 reasonCode;
        uint256 costUsd6;
        uint256 remainingUsd6;
        uint80 roundId;
        uint256 updatedAt;
    }

    bytes32 public constant REASON_UNSUPPORTED_ACTION = "UNSUPPORTED_ACTION";
    bytes32 public constant REASON_NOT_AGENT = "NOT_AGENT";
    bytes32 public constant REASON_TIER_BLOCKED = "TIER_BLOCKED";
    bytes32 public constant REASON_POLICY_NOT_CONFIGURED = "POLICY_NOT_CONFIGURED";
    bytes32 public constant REASON_RECIPIENT_NOT_ALLOWED = "RECIPIENT_NOT_ALLOWED";
    bytes32 public constant REASON_ZERO_AMOUNT = "ZERO_AMOUNT";
    bytes32 public constant REASON_REQUEST_EXPIRED = "REQUEST_EXPIRED";
    bytes32 public constant REASON_POLICY_VERSION_MISMATCH = "POLICY_VERSION_MISMATCH";
    bytes32 public constant REASON_ORACLE_STALE = "ORACLE_STALE";
    bytes32 public constant REASON_QUOTE_EXCEEDS_MAX = "QUOTE_EXCEEDS_MAX";
    bytes32 public constant REASON_PER_TX_LIMIT = "PER_TX_LIMIT";
    bytes32 public constant REASON_DAILY_LIMIT = "DAILY_LIMIT";

    AegisAccessControl public immutable acl;
    AegisPriceOracle public oracle;
    uint64 public policyVersion;
    uint256 public autoLimitUsd6;
    uint256 public perTxLimitUsd6;
    uint256 public dailyLimitUsd6;
    uint256 public maxPriceAge;

    mapping(address => bool) public allowedRecipients;
    mapping(uint64 => bool) public allowedDestinationChains;
    mapping(address => bool) public authorizedConsumers;
    mapping(address => bool) public policyManagers;
    mapping(bytes32 => bool) public consumedRequests;
    mapping(uint256 => uint256) private _spentByDay;

    event PolicyConfigured(uint64 indexed version, address indexed oracle, uint256 autoUsd6, uint256 perTxUsd6, uint256 dailyUsd6, uint256 maxAge);
    event RecipientAllowed(address indexed recipient, bool allowed, uint64 policyVersion);
    event DestinationChainAllowed(uint64 indexed chainSelector, bool allowed, uint64 policyVersion);
    event ConsumerAuthorizationUpdated(address indexed consumer, bool allowed);
    event PolicyManagerUpdated(address indexed manager, bool allowed);
    event BudgetConsumed(bytes32 indexed requestHash, ActionType indexed actionType, address indexed actor, Decision decision, uint256 costUsd6, uint256 day, uint256 spentUsd6);

    modifier onlyPolicyManager() {
        require(msg.sender == owner() || policyManagers[msg.sender], "NOT_POLICY_MANAGER");
        _;
    }

    constructor(address initialOwner, address aclAddress) Ownable(initialOwner) {
        require(aclAddress.code.length > 0, "BAD_ACL");
        acl = AegisAccessControl(aclAddress);
    }

    function setConsumer(address consumer, bool allowed) external onlyOwner {
        require(!allowed || consumer.code.length > 0, "BAD_CONSUMER");
        authorizedConsumers[consumer] = allowed;
        emit ConsumerAuthorizationUpdated(consumer, allowed);
    }

    function setPolicyManager(address manager, bool allowed) external onlyOwner {
        require(!allowed || manager.code.length > 0, "BAD_MANAGER");
        policyManagers[manager] = allowed;
        emit PolicyManagerUpdated(manager, allowed);
    }

    function configurePolicy(address oracleAddress, uint256 autoUsd6, uint256 perTxUsd6, uint256 dailyUsd6, uint256 maxAge) external onlyPolicyManager {
        require(oracleAddress.code.length > 0, "BAD_ORACLE");
        require(AegisPriceOracle(oracleAddress).configurationLocked(), "ORACLE_NOT_LOCKED");
        require(perTxUsd6 > 0 && autoUsd6 <= perTxUsd6 && perTxUsd6 <= dailyUsd6, "BAD_LIMITS");
        require(maxAge > 0, "BAD_MAX_AGE");
        oracle = AegisPriceOracle(oracleAddress);
        autoLimitUsd6 = autoUsd6;
        perTxLimitUsd6 = perTxUsd6;
        dailyLimitUsd6 = dailyUsd6;
        maxPriceAge = maxAge;
        ++policyVersion;
        emit PolicyConfigured(policyVersion, oracleAddress, autoUsd6, perTxUsd6, dailyUsd6, maxAge);
    }

    function setRecipientAllowed(address recipient, bool allowed) external onlyPolicyManager {
        require(recipient != address(0), "BAD_RECIPIENT");
        if (allowedRecipients[recipient] == allowed) return;
        allowedRecipients[recipient] = allowed;
        ++policyVersion;
        emit RecipientAllowed(recipient, allowed, policyVersion);
    }

    function setDestinationChainAllowed(uint64 chainSelector, bool allowed) external onlyPolicyManager {
        require(chainSelector != 0, "BAD_CHAIN_SELECTOR");
        if (allowedDestinationChains[chainSelector] == allowed) return;
        allowedDestinationChains[chainSelector] = allowed;
        ++policyVersion;
        emit DestinationChainAllowed(chainSelector, allowed, policyVersion);
    }

    function spendingToday() public view returns (uint256 spentUsd6, uint256 remainingUsd6, uint256 day) {
        day = block.timestamp / 1 days;
        spentUsd6 = _spentByDay[day];
        remainingUsd6 = spentUsd6 < dailyLimitUsd6 ? dailyLimitUsd6 - spentUsd6 : 0;
    }

    function evaluate(RiskRequest calldata request) external view returns (RiskResult memory) {
        return _evaluate(request);
    }

    function validateAndConsume(RiskRequest calldata request, bool ownerApproved) external returns (RiskResult memory result) {
        require(authorizedConsumers[msg.sender], "UNAUTHORIZED_CONSUMER");
        require(request.requestHash != bytes32(0), "EMPTY_REQUEST_HASH");
        require(!consumedRequests[request.requestHash], "REQUEST_ALREADY_CONSUMED");
        result = _evaluate(request);
        _enforce(result);
        if (result.decision == Decision.RequireApproval) require(ownerApproved, "OWNER_APPROVAL_REQUIRED");
        consumedRequests[request.requestHash] = true;
        uint256 day = block.timestamp / 1 days;
        _spentByDay[day] += result.costUsd6;
        emit BudgetConsumed(request.requestHash, request.actionType, request.actor, result.decision, result.costUsd6, day, _spentByDay[day]);
    }

    function _evaluate(RiskRequest calldata request) internal view returns (RiskResult memory result) {
        (, result.remainingUsd6, ) = spendingToday();
        if (request.actionType != ActionType.NativeTransfer || request.asset != address(0) || request.destinationChainSelector != 0) return _reject(result, REASON_UNSUPPORTED_ACTION);
        if (!acl.hasRole(acl.AGENT_ROLE(), request.actor)) return _reject(result, REASON_NOT_AGENT);
        AegisAccessControl.Tier tier = acl.tierOf(request.actor);
        if (tier == AegisAccessControl.Tier.Frozen || tier == AegisAccessControl.Tier.ReadOnly) return _reject(result, REASON_TIER_BLOCKED);
        if (address(oracle) == address(0)) return _reject(result, REASON_POLICY_NOT_CONFIGURED);
        if (!allowedRecipients[request.recipient]) return _reject(result, REASON_RECIPIENT_NOT_ALLOWED);
        if (request.amount == 0 || request.maxUsdCost6 == 0) return _reject(result, REASON_ZERO_AMOUNT);
        if (block.timestamp > request.deadline) return _reject(result, REASON_REQUEST_EXPIRED);
        if (request.policyVersion != policyVersion) return _reject(result, REASON_POLICY_VERSION_MISMATCH);
        (result.costUsd6, result.roundId, , result.updatedAt, ) = oracle.latestEthQuote(request.amount);
        if (block.timestamp - result.updatedAt > maxPriceAge) return _reject(result, REASON_ORACLE_STALE);
        if (result.costUsd6 > request.maxUsdCost6) return _reject(result, REASON_QUOTE_EXCEEDS_MAX);
        if (result.costUsd6 > perTxLimitUsd6) return _reject(result, REASON_PER_TX_LIMIT);
        (uint256 spentUsd6, , ) = spendingToday();
        if (spentUsd6 + result.costUsd6 > dailyLimitUsd6) return _reject(result, REASON_DAILY_LIMIT);
        result.remainingUsd6 = dailyLimitUsd6 - spentUsd6 - result.costUsd6;
        result.decision = tier == AegisAccessControl.Tier.HighRisk || result.costUsd6 > autoLimitUsd6 ? Decision.RequireApproval : Decision.Allow;
    }

    function _reject(RiskResult memory result, bytes32 reason) private pure returns (RiskResult memory) {
        result.decision = Decision.Reject;
        result.reasonCode = reason;
        return result;
    }

    function _enforce(RiskResult memory result) private pure {
        if (result.decision != Decision.Reject) return;
        if (result.reasonCode == REASON_UNSUPPORTED_ACTION) revert("UNSUPPORTED_ACTION");
        if (result.reasonCode == REASON_NOT_AGENT) revert("NOT_AGENT");
        if (result.reasonCode == REASON_TIER_BLOCKED) revert("TIER_BLOCKED");
        if (result.reasonCode == REASON_POLICY_NOT_CONFIGURED) revert("POLICY_NOT_CONFIGURED");
        if (result.reasonCode == REASON_RECIPIENT_NOT_ALLOWED) revert("RECIPIENT_NOT_ALLOWED");
        if (result.reasonCode == REASON_ZERO_AMOUNT) revert("ZERO_AMOUNT");
        if (result.reasonCode == REASON_REQUEST_EXPIRED) revert("REQUEST_EXPIRED");
        if (result.reasonCode == REASON_POLICY_VERSION_MISMATCH) revert("POLICY_VERSION_MISMATCH");
        if (result.reasonCode == REASON_ORACLE_STALE) revert("ORACLE_STALE");
        if (result.reasonCode == REASON_QUOTE_EXCEEDS_MAX) revert("QUOTE_EXCEEDS_MAX");
        if (result.reasonCode == REASON_PER_TX_LIMIT) revert("PER_TX_LIMIT");
        if (result.reasonCode == REASON_DAILY_LIMIT) revert("DAILY_LIMIT");
        revert("POLICY_REJECTED");
    }
}
