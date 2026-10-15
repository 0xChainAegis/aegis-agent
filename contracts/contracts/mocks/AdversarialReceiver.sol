// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Test helper: rejects ETH or tries to reenter the wallet on receipt.
contract AdversarialReceiver {
    bool public rejectPayment;
    bool public attempted;
    bool public reentrySucceeded;
    address private _target;
    bytes private _payload;

    function configure(bool reject_, address target_, bytes calldata payload_) external {
        rejectPayment = reject_;
        _target = target_;
        _payload = payload_;
    }
    function callWallet(address target, bytes calldata payload) external returns (bytes memory result) {
        (bool ok, bytes memory data) = target.call(payload);
        if (!ok) assembly { revert(add(data, 32), mload(data)) }
        return data;
    }
    receive() external payable {
        require(!rejectPayment, "REJECT_ETH");
        if (_target != address(0)) {
            attempted = true;
            (reentrySucceeded, ) = _target.call(_payload);
        }
    }
}
