// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";

contract MockCCIPRouter is IRouterClient {
    using SafeERC20 for IERC20;
    uint256 public fee;
    bool public chainSupported = true;
    bool public failSend;
    uint256 private _sequence;

    function setFee(uint256 value) external { fee = value; }
    function setChainSupported(bool value) external { chainSupported = value; }
    function setFailSend(bool value) external { failSend = value; }
    function isChainSupported(uint64) external view returns (bool) { return chainSupported; }
    function getSupportedTokens(uint64) external pure returns (address[] memory) { return new address[](0); }
    function getFee(uint64, Client.EVM2AnyMessage memory) external view returns (uint256) { return fee; }

    function ccipSend(uint64 destinationChainSelector, Client.EVM2AnyMessage calldata message) external payable returns (bytes32 messageId) {
        require(!failSend, "MOCK_SEND_FAILED");
        require(msg.value == fee, "MOCK_BAD_FEE");
        address receiver = abi.decode(message.receiver, (address));
        for (uint256 i = 0; i < message.tokenAmounts.length; ++i) {
            Client.EVMTokenAmount calldata item = message.tokenAmounts[i];
            IERC20(item.token).safeTransferFrom(msg.sender, receiver, item.amount);
        }
        messageId = keccak256(abi.encode(destinationChainSelector, message, _sequence++));
    }
}
