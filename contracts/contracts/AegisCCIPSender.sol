// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";

/// @title AegisCCIPSender
/// @notice Cross-chain token transfer bridge for AegisAgent, built on Chainlink
///         CCIP. Destination chains are allowlisted, fees are paid in native gas,
///         and every cross-chain send emits an event that the agent attests.
/// @dev This contract is the integration point for the Chainlink Bounty.
contract AegisCCIPSender is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IRouterClient private s_router;

    mapping(uint64 => bool) public allowlistedChains;

    event ChainAllowlistUpdated(uint64 indexed chainSelector, bool allowed);
    event CrossChainInitiated(
        bytes32 indexed messageId,
        uint64 indexed destinationChainSelector,
        address receiver,
        address token,
        uint256 amount,
        uint256 fee
    );

    constructor(address initialOwner, address router) Ownable(initialOwner) {
        s_router = IRouterClient(router);
    }

    function setChainAllowlist(uint64 chainSelector, bool allowed) external onlyOwner {
        allowlistedChains[chainSelector] = allowed;
        emit ChainAllowlistUpdated(chainSelector, allowed);
    }

    /// @notice Transfer `amount` of `token` to `receiver` on a CCIP destination chain.
    /// @dev Caller must send exactly the native fee returned by the router.
    function transferTokenCrossChain(
        uint64 destinationChainSelector,
        address receiver,
        address token,
        uint256 amount
    ) external payable onlyOwner nonReentrant returns (bytes32 messageId) {
        require(allowlistedChains[destinationChainSelector], "destination chain not allowed");
        require(receiver != address(0), "zero receiver");
        require(amount > 0, "zero amount");

        Client.EVMTokenAmount[] memory tokenAmounts = new Client.EVMTokenAmount[](1);
        tokenAmounts[0] = Client.EVMTokenAmount({token: token, amount: amount});

        Client.EVM2AnyMessage memory message = Client.EVM2AnyMessage({
            receiver: abi.encode(receiver),
            data: "",
            tokenAmounts: tokenAmounts,
            feeToken: address(0), // pay fees in native gas
            extraArgs: Client._argsToBytes(Client.EVMExtraArgsV1({gasLimit: 0}))
        });

        uint256 fee = s_router.getFee(destinationChainSelector, message);
        require(msg.value == fee, "incorrect CCIP fee");

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        IERC20(token).forceApprove(address(s_router), amount);

        messageId = s_router.ccipSend{value: fee}(destinationChainSelector, message);

        emit CrossChainInitiated(messageId, destinationChainSelector, receiver, token, amount, fee);
    }

    /// @notice Quote the native fee for a cross-chain transfer without sending it.
    function quoteCrossChainFee(
        uint64 destinationChainSelector,
        address receiver,
        address token,
        uint256 amount
    ) external view returns (uint256 fee) {
        Client.EVMTokenAmount[] memory tokenAmounts = new Client.EVMTokenAmount[](1);
        tokenAmounts[0] = Client.EVMTokenAmount({token: token, amount: amount});

        Client.EVM2AnyMessage memory message = Client.EVM2AnyMessage({
            receiver: abi.encode(receiver),
            data: "",
            tokenAmounts: tokenAmounts,
            feeToken: address(0),
            extraArgs: Client._argsToBytes(Client.EVMExtraArgsV1({gasLimit: 0}))
        });

        return s_router.getFee(destinationChainSelector, message);
    }
}
