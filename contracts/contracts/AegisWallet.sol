// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {AegisAccessControl} from "./AegisAccessControl.sol";
import {AegisAttestation} from "./AegisAttestation.sol";

/// @title AegisWallet
/// @notice Custodial-style vault where an AI agent can execute transfers and
///         recurring subscriptions, but every action is bounded by on-chain
///         permission tiers and written to the attestation registry before any
///         value moves. Above-limit transfers are queued and only executable
///         after explicit human approval.
contract AegisWallet is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    AegisAccessControl public acl;
    AegisAttestation public attestations;

    /// @dev A high-risk operation parked until the owner approves or cancels.
    struct PendingOp {
        address requester;
        address token; // address(0) means native ETH
        address to;
        uint256 amount;
        bytes32 actionHash;
        bool exists;
    }

    /// @dev Recurring payment agreement with a merchant.
    struct Subscription {
        address merchant;
        address token;
        uint256 amountPerCycle;
        uint64 nextPayment;
        uint64 cycleSeconds;
        bool active;
    }

    mapping(uint64 => PendingOp) public pending;

    uint64 public nextSubId = 1;
    mapping(uint64 => Subscription) public subscriptions;

    event Deposited(address indexed user, address token, uint256 amount);
    event TransferExecuted(address indexed agent, address token, address to, uint256 amount, uint64 attestationId);
    event PendingApproval(uint64 indexed attestationId, address indexed agent, address to, uint256 amount);
    event PendingCancelled(uint64 indexed attestationId);
    event SubscriptionCreated(uint64 indexed id, address merchant, uint256 amount, uint64 nextPayment);
    event SubscriptionCancelled(uint64 indexed id);
    event SubscriptionPaid(uint64 indexed id, uint64 attestationId);

    modifier onlyOwnerOrAgent() {
        require(owner() == msg.sender || acl.hasRole(acl.AGENT_ROLE(), msg.sender), "not owner or agent");
        _;
    }

    constructor(address initialOwner, address _acl, address _att) Ownable(initialOwner) {
        acl = AegisAccessControl(_acl);
        attestations = AegisAttestation(_att);
    }

    // ------------------------------------------------------------------ deposits

    function depositETH() external payable {
        require(msg.value > 0, "zero deposit");
        emit Deposited(msg.sender, address(0), msg.value);
    }

    function depositToken(address token, uint256 amount) external {
        require(amount > 0, "zero deposit");
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, token, amount);
    }

    // ------------------------------------------------------------- agent actions

    /// @notice Agent requests a transfer. Auto-executes within the LowRisk limit,
    ///         otherwise queues an on-chain pending approval.
    /// @return attId The attestation id that tracks this action.
    function requestTransfer(
        address token,
        address to,
        uint256 amount,
        bytes32 actionHash,
        string calldata dataUri
    ) external returns (uint64 attId) {
        require(acl.hasRole(acl.AGENT_ROLE(), msg.sender), "not agent");
        require(to != address(0), "zero recipient");
        require(amount > 0, "zero amount");

        if (acl.canAutoExecute(msg.sender, amount)) {
            attId = attestations.record(msg.sender, actionHash, dataUri, false, true);
            _pay(token, to, amount);
            emit TransferExecuted(msg.sender, token, to, amount, attId);
        } else {
            attId = attestations.record(msg.sender, actionHash, dataUri, true, false);
            pending[attId] = PendingOp(msg.sender, token, to, amount, actionHash, true);
            emit PendingApproval(attId, msg.sender, to, amount);
        }
    }

    /// @notice Owner approves and executes a queued high-risk transfer.
    function approveAndExecute(uint64 attId) external onlyOwner nonReentrant {
        PendingOp memory op = pending[attId];
        require(op.exists, "no pending op");
        delete pending[attId];
        attestations.setApproval(attId, true);
        _pay(op.token, op.to, op.amount);
        emit TransferExecuted(op.requester, op.token, op.to, op.amount, attId);
    }

    /// @notice Owner rejects a queued transfer.
    function cancelPending(uint64 attId) external onlyOwner {
        require(pending[attId].exists, "no pending op");
        delete pending[attId];
        attestations.setApproval(attId, false);
        emit PendingCancelled(attId);
    }

    // ------------------------------------------------------------- subscriptions

    function createSubscription(
        address merchant,
        address token,
        uint256 amount,
        uint64 cycleSeconds
    ) external onlyOwnerOrAgent returns (uint64 id) {
        require(merchant != address(0), "zero merchant");
        require(amount > 0 && cycleSeconds > 0, "bad params");
        id = nextSubId++;
        subscriptions[id] = Subscription({
            merchant: merchant,
            token: token,
            amountPerCycle: amount,
            nextPayment: uint64(block.timestamp) + cycleSeconds,
            cycleSeconds: cycleSeconds,
            active: true
        });
        emit SubscriptionCreated(id, merchant, amount, subscriptions[id].nextPayment);
    }

    function cancelSubscription(uint64 id) external onlyOwnerOrAgent {
        require(subscriptions[id].active, "not active");
        subscriptions[id].active = false;
        emit SubscriptionCancelled(id);
    }

    /// @notice Agent settles a due subscription payment. Attested as low-risk.
    function paySubscription(
        uint64 id,
        bytes32 actionHash,
        string calldata dataUri
    ) external returns (uint64 attId) {
        require(acl.hasRole(acl.AGENT_ROLE(), msg.sender), "not agent");
        Subscription storage s = subscriptions[id];
        require(s.active, "not active");
        require(uint64(block.timestamp) >= s.nextPayment, "not due");

        attId = attestations.record(msg.sender, actionHash, dataUri, false, true);
        _pay(s.token, s.merchant, s.amountPerCycle);
        s.nextPayment += s.cycleSeconds;
        emit SubscriptionPaid(id, attId);
    }

    // -------------------------------------------------------------------- internals

    function _pay(address token, address to, uint256 amount) internal {
        if (token == address(0)) {
            (bool ok, ) = payable(to).call{value: amount}("");
            require(ok, "ETH transfer failed");
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    receive() external payable {}
}
