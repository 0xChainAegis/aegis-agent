// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {AegisAccessControl} from "./AegisAccessControl.sol";
import {AegisAttestation} from "./AegisAttestation.sol";
import {AegisPriceOracle} from "./AegisPriceOracle.sol";

/// @notice Native ETH vault. Every payment, including owner-approved payments,
///         obeys the same allowlist, USD caps, expiry, tier and oracle checks.
contract AegisWallet is Ownable, ReentrancyGuard {
    AegisAccessControl public immutable acl;
    AegisAttestation public immutable attestations;
    AegisPriceOracle public oracle;

    uint64 public policyVersion;
    uint256 public autoLimitUsd6;
    uint256 public perTxLimitUsd6;
    uint256 public dailyLimitUsd6;
    uint256 public maxPriceAge;
    mapping(address => bool) public allowedRecipients;
    mapping(address => uint256) public nextNonce;
    // One shared vault budget; creating another agent cannot multiply it.
    mapping(uint256 => uint256) private _spentByDay;

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

    constructor(address initialOwner, address _acl, address _att) Ownable(initialOwner) {
        require(_acl.code.length > 0 && _att.code.length > 0, "BAD_DEPENDENCY");
        acl = AegisAccessControl(_acl);
        attestations = AegisAttestation(_att);
    }

    function configurePolicy(address _oracle, uint256 autoUsd6, uint256 perTxUsd6, uint256 dailyUsd6, uint256 maxAge) external onlyOwner {
        require(_oracle.code.length > 0, "BAD_ORACLE");
        require(AegisPriceOracle(_oracle).configurationLocked(), "ORACLE_NOT_LOCKED");
        require(perTxUsd6 > 0 && autoUsd6 <= perTxUsd6 && perTxUsd6 <= dailyUsd6, "BAD_LIMITS");
        require(maxAge > 0, "BAD_MAX_AGE");
        oracle = AegisPriceOracle(_oracle);
        autoLimitUsd6 = autoUsd6;
        perTxLimitUsd6 = perTxUsd6;
        dailyLimitUsd6 = dailyUsd6;
        maxPriceAge = maxAge;
        // Historical spending is never reset by configuration changes.
        ++policyVersion;
        emit PolicyConfigured(policyVersion, _oracle, autoUsd6, perTxUsd6, dailyUsd6, maxAge);
    }

    function setRecipientAllowed(address recipient, bool allowed) external onlyOwner {
        require(recipient != address(0) && recipient != address(this), "BAD_RECIPIENT");
        if (allowedRecipients[recipient] == allowed) return;
        allowedRecipients[recipient] = allowed;
        ++policyVersion;
        emit RecipientAllowed(recipient, allowed, policyVersion);
    }

    function spendingToday() public view returns (uint256 spentUsd6, uint256 remainingUsd6, uint256 day) {
        day = block.timestamp / 1 days;
        spentUsd6 = _spentByDay[day];
        remainingUsd6 = spentUsd6 < dailyLimitUsd6 ? dailyLimitUsd6 - spentUsd6 : 0;
    }

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
            _execute(op, attId, q);
        }
    }

    function approveAndExecute(uint64 attId) external onlyOwner nonReentrant {
        PendingOp memory op = pending[attId];
        require(op.exists, "NO_PENDING");
        // Requote the fixed amount and revalidate all hard rules at execution.
        Quote memory q = _checkHardRules(op.requester, op.to, op.amountWei, op.maxUsdCost6, op.deadline, op.policyVersion);
        delete pending[attId];
        attestations.setApproval(attId, true);
        _execute(op, attId, q);
    }

    function cancelPending(uint64 attId) external onlyOwner nonReentrant {
        PendingOp memory op = pending[attId];
        require(op.exists, "NO_PENDING");
        delete pending[attId];
        attestations.setApproval(attId, false);
        emit NativeTransferCancelled(op.requestHash, attId);
    }

    function _checkHardRules(address requester, address to, uint256 amountWei, uint256 maxUsdCost6, uint64 deadline, uint64 version) internal view returns (Quote memory q) {
        require(acl.hasRole(acl.AGENT_ROLE(), requester), "NOT_AGENT");
        AegisAccessControl.Tier tier = acl.tierOf(requester);
        require(tier != AegisAccessControl.Tier.Frozen && tier != AegisAccessControl.Tier.ReadOnly, "TIER_BLOCKED");
        require(address(oracle) != address(0), "POLICY_NOT_CONFIGURED");
        require(allowedRecipients[to], "RECIPIENT_NOT_ALLOWED");
        require(amountWei > 0 && maxUsdCost6 > 0, "ZERO_AMOUNT");
        require(block.timestamp <= deadline, "REQUEST_EXPIRED");
        require(version == policyVersion, "POLICY_VERSION_MISMATCH");
        (q.costUsd6, q.roundId, , q.updatedAt, ) = oracle.latestEthQuote(amountWei);
        require(block.timestamp - q.updatedAt <= maxPriceAge, "ORACLE_STALE");
        require(q.costUsd6 <= maxUsdCost6, "QUOTE_EXCEEDS_MAX");
        require(q.costUsd6 <= perTxLimitUsd6, "PER_TX_LIMIT");
        require(_spentByDay[block.timestamp / 1 days] + q.costUsd6 <= dailyLimitUsd6, "DAILY_LIMIT");
        require(address(this).balance >= amountWei, "INSUFFICIENT_BALANCE");
        q.requiresApproval = tier == AegisAccessControl.Tier.HighRisk || q.costUsd6 > autoLimitUsd6;
    }

    function _execute(PendingOp memory op, uint64 attId, Quote memory q) internal {
        // Effects before interaction; a failed call rolls back budget, nonce and evidence.
        _spentByDay[block.timestamp / 1 days] += q.costUsd6;
        (bool ok, ) = payable(op.to).call{value: op.amountWei}("");
        require(ok, "NATIVE_TRANSFER_FAILED");
        emit NativeTransferExecuted(op.requestHash, attId, op.requester, op.to, op.amountWei, q.costUsd6, q.roundId, q.updatedAt, op.policyVersion);
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
