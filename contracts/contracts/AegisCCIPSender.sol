// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {AegisAttestation} from "./AegisAttestation.sol";
import {AegisPolicyEngine} from "./AegisPolicyEngine.sol";

/// @notice Policy-gated CCIP token vault. Agents can request a bounded transfer,
///         but only the shared PolicyEngine can authorize budget consumption.
contract AegisCCIPSender is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant REQUEST_DOMAIN = keccak256("aegis.ccip-transfer.v1");

    struct PendingTransfer {
        address requester;
        address receiver;
        address token;
        uint256 amount;
        uint256 maxUsdCost6;
        uint256 maxFeeWei;
        uint256 nonce;
        uint64 deadline;
        uint64 policyVersion;
        uint64 destinationChainSelector;
        bytes32 requestHash;
        bool exists;
    }

    struct Preview {
        uint256 costUsd6;
        uint256 feeWei;
        uint80 roundId;
        uint256 updatedAt;
        bool requiresApproval;
    }

    struct ExecutionData {
        bytes32 messageId;
        address receiver;
        address token;
        uint256 amount;
        uint256 costUsd6;
        uint256 feeWei;
        uint80 roundId;
        uint256 updatedAt;
        uint64 destinationChainSelector;
        uint64 policyVersion;
    }

    IRouterClient public immutable router;
    AegisAttestation public immutable attestations;
    AegisPolicyEngine public immutable policyEngine;
    mapping(address => uint256) public nextNonce;
    mapping(uint64 => PendingTransfer) public pending;

    event DestinationChainAllowed(uint64 indexed destinationChainSelector, bool allowed, uint64 policyVersion);
    event RecipientAllowed(address indexed recipient, bool allowed, uint64 policyVersion);
    event TokenDeposited(address indexed funder, address indexed token, uint256 amount);
    event NativeFeeDeposited(address indexed funder, uint256 amount);
    event CCIPTransferQueued(bytes32 indexed requestHash, uint64 indexed attestationId, address indexed agent, address receiver, address token, uint256 amount, uint256 maxUsdCost6, uint256 maxFeeWei, uint64 destinationChainSelector, uint64 deadline, uint64 policyVersion);
    event CCIPTransferExecuted(bytes32 indexed requestHash, uint64 indexed attestationId, address indexed agent, bytes32 messageId, address receiver, address token, uint256 amount, uint256 costUsd6, uint256 feeWei, uint80 roundId, uint256 updatedAt, uint64 destinationChainSelector, uint64 policyVersion);
    event CCIPTransferCancelled(bytes32 indexed requestHash, uint64 indexed attestationId);

    constructor(address initialOwner, address routerAddress, address attestationAddress, address policyEngineAddress)
        Ownable(initialOwner)
    {
        require(routerAddress.code.length > 0 && attestationAddress.code.length > 0 && policyEngineAddress.code.length > 0, "BAD_DEPENDENCY");
        router = IRouterClient(routerAddress);
        attestations = AegisAttestation(attestationAddress);
        policyEngine = AegisPolicyEngine(policyEngineAddress);
    }

    function setDestinationChainAllowed(uint64 chainSelector, bool allowed) external onlyOwner {
        policyEngine.setDestinationChainAllowed(chainSelector, allowed);
        emit DestinationChainAllowed(chainSelector, allowed, policyEngine.policyVersion());
    }

    function setRecipientAllowed(address recipient, bool allowed) external onlyOwner {
        require(recipient != address(0) && recipient != address(this), "BAD_RECIPIENT");
        policyEngine.setRecipientAllowed(recipient, allowed);
        emit RecipientAllowed(recipient, allowed, policyEngine.policyVersion());
    }

    function depositToken(address token, uint256 amount) external nonReentrant {
        require(token != address(0) && amount > 0, "BAD_DEPOSIT");
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit TokenDeposited(msg.sender, token, amount);
    }

    function hashRequest(address agent, address receiver, address token, uint256 amount, uint256 maxUsdCost6, uint256 maxFeeWei, uint256 nonce, uint64 deadline, uint64 version, uint64 destinationChainSelector) public view returns (bytes32) {
        return keccak256(abi.encode(REQUEST_DOMAIN, block.chainid, address(this), agent, receiver, token, amount, maxUsdCost6, maxFeeWei, nonce, deadline, version, destinationChainSelector));
    }

    function previewCrossChainTransfer(address requester, address receiver, address token, uint256 amount, uint256 maxUsdCost6, uint256 maxFeeWei, uint64 deadline, uint64 version, uint64 destinationChainSelector) external view returns (Preview memory preview) {
        PendingTransfer memory op = _operation(requester, receiver, token, amount, maxUsdCost6, maxFeeWei, 0, deadline, version, destinationChainSelector);
        return _check(op);
    }

    function requestCrossChainTransfer(address receiver, address token, uint256 amount, uint256 maxUsdCost6, uint256 maxFeeWei, uint256 nonce, uint64 deadline, uint64 version, uint64 destinationChainSelector) external nonReentrant returns (uint64 attestationId) {
        require(nonce == nextNonce[msg.sender], "NONCE_MISMATCH");
        PendingTransfer memory op = _operation(msg.sender, receiver, token, amount, maxUsdCost6, maxFeeWei, nonce, deadline, version, destinationChainSelector);
        op.requestHash = hashRequest(msg.sender, receiver, token, amount, maxUsdCost6, maxFeeWei, nonce, deadline, version, destinationChainSelector);
        Preview memory preview = _check(op);
        nextNonce[msg.sender] = nonce + 1;
        attestationId = attestations.record(msg.sender, op.requestHash, "", preview.requiresApproval, !preview.requiresApproval);
        if (preview.requiresApproval) {
            op.exists = true;
            pending[attestationId] = op;
            emit CCIPTransferQueued(op.requestHash, attestationId, op.requester, op.receiver, op.token, op.amount, op.maxUsdCost6, op.maxFeeWei, op.destinationChainSelector, op.deadline, op.policyVersion);
        } else {
            _execute(op, attestationId, false);
        }
    }

    function approveAndExecute(uint64 attestationId) external onlyOwner nonReentrant {
        PendingTransfer memory op = pending[attestationId];
        require(op.exists, "NO_PENDING");
        _check(op);
        delete pending[attestationId];
        attestations.setApproval(attestationId, true);
        _execute(op, attestationId, true);
    }

    function cancelPending(uint64 attestationId) external onlyOwner nonReentrant {
        PendingTransfer memory op = pending[attestationId];
        require(op.exists, "NO_PENDING");
        delete pending[attestationId];
        attestations.setApproval(attestationId, false);
        emit CCIPTransferCancelled(op.requestHash, attestationId);
    }

    function quoteCrossChainFee(uint64 destinationChainSelector, address receiver, address token, uint256 amount) public view returns (uint256) {
        return router.getFee(destinationChainSelector, _message(receiver, token, amount));
    }

    function _operation(address requester, address receiver, address token, uint256 amount, uint256 maxUsdCost6, uint256 maxFeeWei, uint256 nonce, uint64 deadline, uint64 version, uint64 destinationChainSelector) internal pure returns (PendingTransfer memory op) {
        op.requester = requester;
        op.receiver = receiver;
        op.token = token;
        op.amount = amount;
        op.maxUsdCost6 = maxUsdCost6;
        op.maxFeeWei = maxFeeWei;
        op.nonce = nonce;
        op.deadline = deadline;
        op.policyVersion = version;
        op.destinationChainSelector = destinationChainSelector;
    }

    function _risk(PendingTransfer memory op) internal pure returns (AegisPolicyEngine.RiskRequest memory) {
        return AegisPolicyEngine.RiskRequest({actionType: AegisPolicyEngine.ActionType.CCIPTransfer, actor: op.requester, recipient: op.receiver, asset: op.token, amount: op.amount, maxUsdCost6: op.maxUsdCost6, deadline: op.deadline, policyVersion: op.policyVersion, requestHash: op.requestHash, destinationChainSelector: op.destinationChainSelector});
    }

    function _check(PendingTransfer memory op) internal view returns (Preview memory preview) {
        AegisPolicyEngine.RiskResult memory result = policyEngine.evaluate(_risk(op));
        _enforcePolicy(result);
        require(router.isChainSupported(op.destinationChainSelector), "ROUTER_CHAIN_UNSUPPORTED");
        preview.feeWei = quoteCrossChainFee(op.destinationChainSelector, op.receiver, op.token, op.amount);
        require(preview.feeWei <= op.maxFeeWei, "CCIP_FEE_EXCEEDS_MAX");
        require(IERC20(op.token).balanceOf(address(this)) >= op.amount, "INSUFFICIENT_TOKEN_BALANCE");
        require(address(this).balance >= preview.feeWei, "INSUFFICIENT_FEE_BALANCE");
        preview.costUsd6 = result.costUsd6;
        preview.roundId = result.roundId;
        preview.updatedAt = result.updatedAt;
        preview.requiresApproval = result.decision == AegisPolicyEngine.Decision.RequireApproval;
    }

    function _execute(PendingTransfer memory op, uint64 attestationId, bool ownerApproved) internal {
        AegisPolicyEngine.RiskResult memory result = policyEngine.validateAndConsume(_risk(op), ownerApproved);
        uint256 fee = quoteCrossChainFee(op.destinationChainSelector, op.receiver, op.token, op.amount);
        require(fee <= op.maxFeeWei, "CCIP_FEE_EXCEEDS_MAX");
        IERC20(op.token).forceApprove(address(router), op.amount);
        bytes32 messageId = router.ccipSend{value: fee}(op.destinationChainSelector, _message(op.receiver, op.token, op.amount));
        IERC20(op.token).forceApprove(address(router), 0);
        _emitExecuted(op, attestationId, messageId, fee, result);
    }

    function _emitExecuted(PendingTransfer memory op, uint64 attestationId, bytes32 messageId, uint256 fee, AegisPolicyEngine.RiskResult memory result) internal {
        ExecutionData memory d = ExecutionData(messageId, op.receiver, op.token, op.amount, result.costUsd6, fee, result.roundId, result.updatedAt, op.destinationChainSelector, op.policyVersion);
        bytes memory data = abi.encode(d);
        bytes32 signature = keccak256("CCIPTransferExecuted(bytes32,uint64,address,bytes32,address,address,uint256,uint256,uint256,uint80,uint256,uint64,uint64)");
        bytes32 requestHash = op.requestHash;
        address agent = op.requester;
        assembly { log4(add(data, 32), mload(data), signature, requestHash, attestationId, agent) }
    }

    function _message(address receiver, address token, uint256 amount) internal pure returns (Client.EVM2AnyMessage memory message) {
        Client.EVMTokenAmount[] memory amounts = new Client.EVMTokenAmount[](1);
        amounts[0] = Client.EVMTokenAmount({token: token, amount: amount});
        message = Client.EVM2AnyMessage({receiver: abi.encode(receiver), data: "", tokenAmounts: amounts, feeToken: address(0), extraArgs: Client._argsToBytes(Client.EVMExtraArgsV1({gasLimit: 0}))});
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
        if (reason == bytes32("DESTINATION_CHAIN_NOT_ALLOWED")) revert("DESTINATION_CHAIN_NOT_ALLOWED");
        if (reason == bytes32("ASSET_NOT_SUPPORTED")) revert("ASSET_NOT_SUPPORTED");
        revert("POLICY_REJECTED");
    }

    receive() external payable {
        require(msg.value > 0, "ZERO_DEPOSIT");
        emit NativeFeeDeposited(msg.sender, msg.value);
    }
}
