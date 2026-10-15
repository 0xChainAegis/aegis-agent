// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title AegisAttestation
/// @notice Action records written by the wallet, with mutable approval metadata.
/// @dev Execution is proven by the wallet's NativeTransferExecuted event, not by
///      the approved flag alone. The owner remains the trusted role administrator.
contract AegisAttestation is AccessControl {
    bytes32 public constant ATTESTER_ROLE = keccak256("ATTESTER_ROLE");
    bytes32 public constant APPROVER_ROLE = keccak256("APPROVER_ROLE");

    struct Record {
        uint64 id;
        address actor;
        bytes32 actionHash;
        string dataUri;
        bool riskFlag;
        bool approved;
        uint64 timestamp;
    }

    uint64 public nextId = 1;
    mapping(uint64 => Record) public records;
    mapping(address => uint64[]) private recordsByActor;

    event Attested(uint64 indexed id, address indexed actor, bytes32 actionHash, bool riskFlag, bool approved);
    event ApprovalUpdated(uint64 indexed id, bool approved);

    constructor(address admin, address /* agent */) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        // Deployment grants ATTESTER_ROLE to the wallet, never the raw agent key.
        _grantRole(APPROVER_ROLE, admin);
    }

    /// @notice Append a new action record.
    function record(
        address actor,
        bytes32 actionHash,
        string calldata dataUri,
        bool riskFlag,
        bool approved
    ) external onlyRole(ATTESTER_ROLE) returns (uint64 id) {
        id = nextId++;
        records[id] = Record(id, actor, actionHash, dataUri, riskFlag, approved, uint64(block.timestamp));
        recordsByActor[actor].push(id);
        emit Attested(id, actor, actionHash, riskFlag, approved);
    }

    /// @notice Mark a previously queued high-risk action as approved/rejected.
    function setApproval(uint64 id, bool approved) external onlyRole(APPROVER_ROLE) {
        Record storage r = records[id];
        require(r.id != 0, "record not found");
        r.approved = approved;
        emit ApprovalUpdated(id, approved);
    }

    /// @notice All attestation ids created by a given actor.
    function recordsOf(address actor) external view returns (uint64[] memory) {
        return recordsByActor[actor];
    }
}
