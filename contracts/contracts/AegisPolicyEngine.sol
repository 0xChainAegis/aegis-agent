// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {AegisAccessControl} from "./AegisAccessControl.sol";
import {AegisPriceOracle} from "./AegisPriceOracle.sol";

/// @notice Shared deterministic authorization and USD-budget policy for Aegis actions.
/// @dev Native ETH, finite subscription payments and CCIP token transfers share
///      one daily budget. Subscription calls require registered context.
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
    bytes32 public constant REASON_DESTINATION_CHAIN_NOT_ALLOWED = "DESTINATION_CHAIN_NOT_ALLOWED";
    bytes32 public constant REASON_ASSET_NOT_SUPPORTED = "ASSET_NOT_SUPPORTED";

    AegisAccessControl public immutable acl;
    AegisPriceOracle public oracle;
    uint64 public policyVersion;
    uint256 public autoLimitUsd6;
    uint256 public perTxLimitUsd6;
    uint256 public dailyLimitUsd6;
    uint256 public maxPriceAge;

    struct FiniteSubscription {
        address agent;
        address to;
        uint256 amountWei;
        uint64 periodSeconds;
        uint64 startAt;
        uint64 endAt;
        uint64 maxPayments;
        uint256 periodCapUsd6;
        bytes32 parentPlanHash;
        uint64 paidCount;
        uint64 lastPaidOccurrence;
        bool hasPaid;
        bool paused;
        bool cancelled;
        bool exists;
    }
    uint256 public maxSubscriptionPeriodCapUsd6;
    uint64 public maxSubscriptionDurationSeconds;
    uint64 public maxSubscriptionPayments;
    mapping(address => mapping(uint64 => FiniteSubscription)) private _subscriptions;

    mapping(address => bool) public allowedRecipients;
    mapping(uint64 => bool) public allowedDestinationChains;
    mapping(address => bool) public authorizedConsumers;
    mapping(address => bool) public policyManagers;
    mapping(bytes32 => bool) public consumedRequests;
    mapping(uint256 => uint256) private _spentByDay;

    event SubscriptionPolicyConfigured(uint64 indexed version, uint256 maxPeriodCapUsd6, uint64 maxDurationSeconds, uint64 maxPayments);
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

    function configureSubscriptionPolicy(uint256 periodCapUsd6, uint64 durationSeconds, uint64 payments) external onlyPolicyManager {
        require(periodCapUsd6 > 0 && durationSeconds > 0 && payments > 0, "BAD_SUBSCRIPTION_LIMITS");
        maxSubscriptionPeriodCapUsd6 = periodCapUsd6;
        maxSubscriptionDurationSeconds = durationSeconds;
        maxSubscriptionPayments = payments;
        ++policyVersion;
        emit SubscriptionPolicyConfigured(policyVersion, periodCapUsd6, durationSeconds, payments);
    }

    function subscriptions(address consumer, uint64 id) external view returns (FiniteSubscription memory) {
        return _subscriptions[consumer][id];
    }

    function registerSubscription(uint64 id, FiniteSubscription calldata config) external {
        require(authorizedConsumers[msg.sender], "UNAUTHORIZED_CONSUMER");
        require(id != 0 && !_subscriptions[msg.sender][id].exists, "SUBSCRIPTION_EXISTS");
        require(maxSubscriptionPeriodCapUsd6 > 0 && maxSubscriptionDurationSeconds > 0 && maxSubscriptionPayments > 0, "SUBSCRIPTIONS_NOT_CONFIGURED");
        require(address(oracle) != address(0), "POLICY_NOT_CONFIGURED");
        require(config.periodSeconds > 0 && config.endAt > config.startAt && config.endAt > block.timestamp && config.maxPayments > 0 && config.maxPayments <= maxSubscriptionPayments && config.endAt - config.startAt <= maxSubscriptionDurationSeconds && config.periodCapUsd6 > 0 && config.periodCapUsd6 <= maxSubscriptionPeriodCapUsd6, "BAD_SUBSCRIPTION_BOUNDS");
        require(config.parentPlanHash != bytes32(0), "EMPTY_PLAN_HASH");
        require(config.amountWei > 0, "ZERO_AMOUNT");
        require(config.to != address(0) && config.to != msg.sender && allowedRecipients[config.to], "RECIPIENT_NOT_ALLOWED");
        require(acl.hasRole(acl.AGENT_ROLE(), config.agent), "NOT_AGENT");
        AegisAccessControl.Tier tier = acl.tierOf(config.agent);
        require(tier != AegisAccessControl.Tier.Frozen && tier != AegisAccessControl.Tier.ReadOnly, "TIER_BLOCKED");
        _subscriptions[msg.sender][id] = config;
        FiniteSubscription storage s = _subscriptions[msg.sender][id];
        s.paidCount = 0;
        s.lastPaidOccurrence = 0;
        s.hasPaid = false;
        s.paused = false;
        s.cancelled = false;
        s.exists = true;
    }

    function pauseSubscriptionRecord(uint64 id, bool paused) external {
        require(authorizedConsumers[msg.sender], "UNAUTHORIZED_CONSUMER");
        FiniteSubscription storage s = _subscriptions[msg.sender][id];
        require(s.exists, "NO_SUBSCRIPTION");
        require(!s.cancelled, "SUBSCRIPTION_CANCELLED");
        s.paused = paused;
    }

    function cancelSubscriptionRecord(uint64 id) external {
        require(authorizedConsumers[msg.sender], "UNAUTHORIZED_CONSUMER");
        FiniteSubscription storage s = _subscriptions[msg.sender][id];
        require(s.exists, "NO_SUBSCRIPTION");
        s.cancelled = true;
    }

    function evaluateSubscription(RiskRequest calldata request, uint64 id, uint64 occurrenceIndex) external view returns (RiskResult memory) {
        return _evaluateSubscription(request, id, occurrenceIndex);
    }

    function validateAndConsumeSubscription(RiskRequest calldata request, uint64 id, uint64 occurrenceIndex, bool ownerApproved) external returns (RiskResult memory result) {
        require(authorizedConsumers[msg.sender], "UNAUTHORIZED_CONSUMER");
        result = _evaluateSubscription(request, id, occurrenceIndex);
        _consume(request, result, ownerApproved);
        FiniteSubscription storage s = _subscriptions[msg.sender][id];
        ++s.paidCount;
        s.lastPaidOccurrence = occurrenceIndex;
        s.hasPaid = true;
    }

    function _evaluateSubscription(RiskRequest calldata request, uint64 id, uint64 occurrenceIndex) internal view returns (RiskResult memory result) {
        FiniteSubscription storage s = _subscriptions[msg.sender][id];
        if (!s.exists || request.actionType != ActionType.Subscription || request.actor != s.agent || request.recipient != s.to || request.asset != address(0) || request.destinationChainSelector != 0 || request.amount != s.amountWei) return _reject(result, "SUBSCRIPTION_CONTEXT_MISMATCH");
        if (maxSubscriptionPeriodCapUsd6 == 0 || maxSubscriptionDurationSeconds == 0 || maxSubscriptionPayments == 0) return _reject(result, "SUBSCRIPTIONS_NOT_CONFIGURED");
        if (s.periodCapUsd6 > maxSubscriptionPeriodCapUsd6 || s.endAt - s.startAt > maxSubscriptionDurationSeconds || s.maxPayments > maxSubscriptionPayments) return _reject(result, "SUBSCRIPTION_POLICY_LIMIT");
        if (s.cancelled) return _reject(result, "SUBSCRIPTION_CANCELLED");
        if (s.paused) return _reject(result, "SUBSCRIPTION_PAUSED");
        if (block.timestamp >= s.endAt) return _reject(result, "SUBSCRIPTION_EXPIRED");
        if (s.paidCount >= s.maxPayments) return _reject(result, "PAYMENT_COUNT_REACHED");
        if (block.timestamp < s.startAt || (block.timestamp - s.startAt) / s.periodSeconds != occurrenceIndex) return _reject(result, "NOT_DUE");
        if (s.hasPaid && s.lastPaidOccurrence == occurrenceIndex) return _reject(result, "PERIOD_ALREADY_PAID");
        result = _evaluateCommon(request);
        if (result.decision != Decision.Reject && result.costUsd6 > s.periodCapUsd6) return _reject(result, "PERIOD_LIMIT");
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
        _consume(request, result, ownerApproved);
    }

    function _consume(RiskRequest calldata request, RiskResult memory result, bool ownerApproved) internal {
        require(request.requestHash != bytes32(0), "EMPTY_REQUEST_HASH");
        require(!consumedRequests[request.requestHash], "REQUEST_ALREADY_CONSUMED");
        _enforce(result);
        if (result.decision == Decision.RequireApproval) require(ownerApproved, "OWNER_APPROVAL_REQUIRED");
        consumedRequests[request.requestHash] = true;
        uint256 day = block.timestamp / 1 days;
        _spentByDay[day] += result.costUsd6;
        emit BudgetConsumed(request.requestHash, request.actionType, request.actor, result.decision, result.costUsd6, day, _spentByDay[day]);
    }

    function _evaluate(RiskRequest calldata request) internal view returns (RiskResult memory result) {
        (, result.remainingUsd6, ) = spendingToday();
        if (request.actionType == ActionType.NativeTransfer) {
            if (request.asset != address(0) || request.destinationChainSelector != 0) return _reject(result, REASON_UNSUPPORTED_ACTION);
        } else if (request.actionType == ActionType.CCIPTransfer) {
            if (request.asset == address(0) || request.destinationChainSelector == 0) return _reject(result, REASON_UNSUPPORTED_ACTION);
            if (!allowedDestinationChains[request.destinationChainSelector]) return _reject(result, REASON_DESTINATION_CHAIN_NOT_ALLOWED);
        } else {
            return _reject(result, REASON_UNSUPPORTED_ACTION);
        }
        return _evaluateCommon(request);
    }

    function _evaluateCommon(RiskRequest calldata request) internal view returns (RiskResult memory result) {
        (, result.remainingUsd6, ) = spendingToday();
        if (!acl.hasRole(acl.AGENT_ROLE(), request.actor)) return _reject(result, REASON_NOT_AGENT);
        AegisAccessControl.Tier tier = acl.tierOf(request.actor);
        if (tier == AegisAccessControl.Tier.Frozen || tier == AegisAccessControl.Tier.ReadOnly) return _reject(result, REASON_TIER_BLOCKED);
        if (address(oracle) == address(0)) return _reject(result, REASON_POLICY_NOT_CONFIGURED);
        if (!allowedRecipients[request.recipient]) return _reject(result, REASON_RECIPIENT_NOT_ALLOWED);
        if (request.amount == 0 || request.maxUsdCost6 == 0) return _reject(result, REASON_ZERO_AMOUNT);
        if (block.timestamp > request.deadline) return _reject(result, REASON_REQUEST_EXPIRED);
        if (request.policyVersion != policyVersion) return _reject(result, REASON_POLICY_VERSION_MISMATCH);
        if (oracle.feeds(request.asset) == address(0)) return _reject(result, REASON_ASSET_NOT_SUPPORTED);
        (result.costUsd6, result.roundId, , result.updatedAt, ) = oracle.latestQuote(request.asset, request.amount);
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
        if (result.reasonCode == REASON_DESTINATION_CHAIN_NOT_ALLOWED) revert("DESTINATION_CHAIN_NOT_ALLOWED");
        if (result.reasonCode == REASON_ASSET_NOT_SUPPORTED) revert("ASSET_NOT_SUPPORTED");
        if (result.reasonCode == bytes32("PERIOD_LIMIT")) revert("PERIOD_LIMIT");
        if (result.reasonCode == bytes32("SUBSCRIPTION_EXPIRED")) revert("SUBSCRIPTION_EXPIRED");
        if (result.reasonCode == bytes32("SUBSCRIPTION_CANCELLED")) revert("SUBSCRIPTION_CANCELLED");
        if (result.reasonCode == bytes32("SUBSCRIPTION_PAUSED")) revert("SUBSCRIPTION_PAUSED");
        if (result.reasonCode == bytes32("PAYMENT_COUNT_REACHED")) revert("PAYMENT_COUNT_REACHED");
        if (result.reasonCode == bytes32("NOT_DUE")) revert("NOT_DUE");
        if (result.reasonCode == bytes32("PERIOD_ALREADY_PAID")) revert("PERIOD_ALREADY_PAID");
        if (result.reasonCode == bytes32("SUBSCRIPTIONS_NOT_CONFIGURED")) revert("SUBSCRIPTIONS_NOT_CONFIGURED");
        if (result.reasonCode == bytes32("SUBSCRIPTION_POLICY_LIMIT")) revert("SUBSCRIPTION_POLICY_LIMIT");
        if (result.reasonCode == bytes32("SUBSCRIPTION_CONTEXT_MISMATCH")) revert("SUBSCRIPTION_CONTEXT_MISMATCH");
        revert("POLICY_REJECTED");
    }
}
