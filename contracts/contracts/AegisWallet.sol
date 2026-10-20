// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {AegisAccessControl} from "./AegisAccessControl.sol";
import {AegisAttestation} from "./AegisAttestation.sol";
import {AegisPriceOracle} from "./AegisPriceOracle.sol";
import {AegisPolicyEngine} from "./AegisPolicyEngine.sol";

/// @notice Native ETH vault. Every payment, including owner-approved payments,
///         obeys the same allowlist, USD caps, expiry, tier and oracle checks.
contract AegisWallet is Ownable, ReentrancyGuard {
    AegisAccessControl public immutable acl;
    AegisAttestation public immutable attestations;
    AegisPolicyEngine public immutable policyEngine;
    mapping(address => uint256) public nextNonce;

    bytes32 public constant REQUEST_DOMAIN = keccak256("aegis.native-transfer.v1");
    struct PendingOp {
        address requester;
        address to;
        uint256 amountWei;
        uint256 maxUsdCost6;
        uint256 nonce;
        uint64 deadline;
        uint64 policyVersion;
        bytes32 requestHash;
        bool exists;
    }
    struct Quote {
        uint256 costUsd6;
        uint80 roundId;
        uint256 updatedAt;
        bool requiresApproval;
    }
    mapping(uint64 => PendingOp) public pending;

    event Deposited(address indexed user, address token, uint256 amount);
    event PolicyConfigured(uint64 indexed version, address indexed oracle, uint256 autoUsd6, uint256 perTxUsd6, uint256 dailyUsd6, uint256 maxAge);
    event RecipientAllowed(address indexed recipient, bool allowed, uint64 policyVersion);
    event NativeTransferExecuted(bytes32 indexed requestHash, uint64 indexed attestationId, address indexed agent, address to, uint256 amountWei, uint256 costUsd6, uint80 roundId, uint256 updatedAt, uint64 policyVersion);
    event NativeTransferQueued(bytes32 indexed requestHash, uint64 indexed attestationId, address indexed agent, address to, uint256 amountWei, uint256 maxUsdCost6, uint64 deadline, uint64 policyVersion);
    event NativeTransferCancelled(bytes32 indexed requestHash, uint64 indexed attestationId);

    constructor(address initialOwner, address _acl, address _att, address _policyEngine) Ownable(initialOwner) {
        require(_acl.code.length > 0 && _att.code.length > 0 && _policyEngine.code.length > 0, "BAD_DEPENDENCY");
        acl = AegisAccessControl(_acl);
        attestations = AegisAttestation(_att);
        policyEngine = AegisPolicyEngine(_policyEngine);
        require(address(policyEngine.acl()) == _acl, "POLICY_ACL_MISMATCH");
    }

    function configurePolicy(address _oracle, uint256 autoUsd6, uint256 perTxUsd6, uint256 dailyUsd6, uint256 maxAge) external onlyOwner {
        policyEngine.configurePolicy(_oracle, autoUsd6, perTxUsd6, dailyUsd6, maxAge);
        emit PolicyConfigured(policyEngine.policyVersion(), _oracle, autoUsd6, perTxUsd6, dailyUsd6, maxAge);
    }

    function setRecipientAllowed(address recipient, bool allowed) external onlyOwner {
        require(recipient != address(0) && recipient != address(this), "BAD_RECIPIENT");
        if (policyEngine.allowedRecipients(recipient) == allowed) return;
        policyEngine.setRecipientAllowed(recipient, allowed);
        emit RecipientAllowed(recipient, allowed, policyEngine.policyVersion());
    }

    function spendingToday() public view returns (uint256 spentUsd6, uint256 remainingUsd6, uint256 day) {
        return policyEngine.spendingToday();
    }

    // Compatibility getters keep the HTTP/backend ABI stable while policy state
    // lives in one engine shared by future execution contracts.
    function oracle() public view returns (AegisPriceOracle) { return policyEngine.oracle(); }
    function policyVersion() public view returns (uint64) { return policyEngine.policyVersion(); }
    function autoLimitUsd6() public view returns (uint256) { return policyEngine.autoLimitUsd6(); }
    function perTxLimitUsd6() public view returns (uint256) { return policyEngine.perTxLimitUsd6(); }
    function dailyLimitUsd6() public view returns (uint256) { return policyEngine.dailyLimitUsd6(); }
    function maxPriceAge() public view returns (uint256) { return policyEngine.maxPriceAge(); }
    function allowedRecipients(address recipient) public view returns (bool) { return policyEngine.allowedRecipients(recipient); }

    function hashRequest(address agent, address to, uint256 amountWei, uint256 maxUsdCost6, uint256 nonce, uint64 deadline, uint64 version) public view returns (bytes32) {
        return keccak256(abi.encode(REQUEST_DOMAIN, block.chainid, address(this), agent, to, amountWei, maxUsdCost6, nonce, deadline, version));
    }

    function previewNativeTransfer(address requester, address to, uint256 amountWei, uint256 maxUsdCost6, uint64 deadline, uint64 version) external view returns (uint256 costUsd6, bool requiresApproval) {
        Quote memory q = _checkHardRules(requester, to, amountWei, maxUsdCost6, deadline, version);
        return (q.costUsd6, q.requiresApproval);
    }

    function requestNativeTransfer(address to, uint256 amountWei, uint256 maxUsdCost6, uint256 nonce, uint64 deadline, uint64 version) external nonReentrant returns (uint64 attId) {
        require(nonce == nextNonce[msg.sender], "NONCE_MISMATCH");
        Quote memory q = _checkHardRules(msg.sender, to, amountWei, maxUsdCost6, deadline, version);
        PendingOp memory op = PendingOp(msg.sender, to, amountWei, maxUsdCost6, nonce, deadline, version,
            hashRequest(msg.sender, to, amountWei, maxUsdCost6, nonce, deadline, version), true);
        // The nonce is consumed when accepted, including when queued or cancelled.
        nextNonce[msg.sender] = nonce + 1;
        attId = attestations.record(msg.sender, op.requestHash, "", q.requiresApproval, !q.requiresApproval);
        if (q.requiresApproval) {
            pending[attId] = op;
            emit NativeTransferQueued(op.requestHash, attId, op.requester, op.to, op.amountWei, op.maxUsdCost6, op.deadline, op.policyVersion);
        } else {
            _execute(op, attId, false);
        }
    }

    function approveAndExecute(uint64 attId) external onlyOwner nonReentrant {
        PendingOp memory op = pending[attId];
        require(op.exists, "NO_PENDING");
        // Requote the fixed amount and revalidate all hard rules at execution.
        _checkHardRules(op.requester, op.to, op.amountWei, op.maxUsdCost6, op.deadline, op.policyVersion);
        delete pending[attId];
        attestations.setApproval(attId, true);
        _execute(op, attId, true);
    }

    function cancelPending(uint64 attId) external onlyOwner nonReentrant {
        PendingOp memory op = pending[attId];
        require(op.exists, "NO_PENDING");
        delete pending[attId];
        attestations.setApproval(attId, false);
        emit NativeTransferCancelled(op.requestHash, attId);
    }

    function _checkHardRules(address requester, address to, uint256 amountWei, uint256 maxUsdCost6, uint64 deadline, uint64 version) internal view returns (Quote memory q) {
        AegisPolicyEngine.RiskResult memory result = policyEngine.evaluate(
            _riskRequest(requester, to, amountWei, maxUsdCost6, deadline, version, bytes32(0))
        );
        _enforcePolicy(result);
        require(address(this).balance >= amountWei, "INSUFFICIENT_BALANCE");
        q.costUsd6 = result.costUsd6;
        q.roundId = result.roundId;
        q.updatedAt = result.updatedAt;
        q.requiresApproval = result.decision == AegisPolicyEngine.Decision.RequireApproval;
    }

    function _execute(PendingOp memory op, uint64 attId, bool ownerApproved) internal {
        require(address(this).balance >= op.amountWei, "INSUFFICIENT_BALANCE");
        AegisPolicyEngine.RiskResult memory result = policyEngine.validateAndConsume(
            _riskRequest(op.requester, op.to, op.amountWei, op.maxUsdCost6, op.deadline, op.policyVersion, op.requestHash),
            ownerApproved
        );
        (bool ok, ) = payable(op.to).call{value: op.amountWei}("");
        require(ok, "NATIVE_TRANSFER_FAILED");
        emit NativeTransferExecuted(op.requestHash, attId, op.requester, op.to, op.amountWei, result.costUsd6, result.roundId, result.updatedAt, op.policyVersion);
    }

    function _riskRequest(address requester, address to, uint256 amountWei, uint256 maxUsdCost6, uint64 deadline, uint64 version, bytes32 requestHash) internal pure returns (AegisPolicyEngine.RiskRequest memory) {
        return AegisPolicyEngine.RiskRequest({
            actionType: AegisPolicyEngine.ActionType.NativeTransfer,
            actor: requester,
            recipient: to,
            asset: address(0),
            amount: amountWei,
            maxUsdCost6: maxUsdCost6,
            deadline: deadline,
            policyVersion: version,
            requestHash: requestHash,
            destinationChainSelector: 0
        });
    }

    function _enforcePolicy(AegisPolicyEngine.RiskResult memory result) internal pure {
        if (result.decision != AegisPolicyEngine.Decision.Reject) return;
        bytes32 reason = result.reasonCode;
        if (reason == bytes32("UNSUPPORTED_ACTION")) revert("UNSUPPORTED_ACTION");
        if (reason == bytes32("NOT_AGENT")) revert("NOT_AGENT");
        if (reason == bytes32("TIER_BLOCKED")) revert("TIER_BLOCKED");
        if (reason == bytes32("POLICY_NOT_CONFIGURED")) revert("POLICY_NOT_CONFIGURED");
        if (reason == bytes32("RECIPIENT_NOT_ALLOWED")) revert("RECIPIENT_NOT_ALLOWED");
        if (reason == bytes32("ZERO_AMOUNT")) revert("ZERO_AMOUNT");
        if (reason == bytes32("REQUEST_EXPIRED")) revert("REQUEST_EXPIRED");
        if (reason == bytes32("POLICY_VERSION_MISMATCH")) revert("POLICY_VERSION_MISMATCH");
        if (reason == bytes32("ORACLE_STALE")) revert("ORACLE_STALE");
        if (reason == bytes32("QUOTE_EXCEEDS_MAX")) revert("QUOTE_EXCEEDS_MAX");
        if (reason == bytes32("PER_TX_LIMIT")) revert("PER_TX_LIMIT");
        if (reason == bytes32("DAILY_LIMIT")) revert("DAILY_LIMIT");
        revert("POLICY_REJECTED");
    }

    function depositETH() external payable {
        require(msg.value > 0, "ZERO_DEPOSIT");
        emit Deposited(msg.sender, address(0), msg.value);
    }
    receive() external payable { emit Deposited(msg.sender, address(0), msg.value); }

    // Explicit tombstones prevent old UI/calldata from finding an unguarded exit.
    function depositToken(address, uint256) external pure { revert("NATIVE_ETH_ONLY"); }
    function requestTransfer(address, address, uint256, bytes32, string calldata) external pure returns (uint64) { revert("LEGACY_TRANSFER_DISABLED"); }
    function createSubscription(address, address, uint256, uint64) external pure returns (uint64) { revert("SUBSCRIPTIONS_DISABLED"); }
    function paySubscription(uint64, bytes32, string calldata) external pure returns (uint64) { revert("SUBSCRIPTIONS_DISABLED"); }
    function cancelSubscription(uint64) external pure { revert("SUBSCRIPTIONS_DISABLED"); }
}
