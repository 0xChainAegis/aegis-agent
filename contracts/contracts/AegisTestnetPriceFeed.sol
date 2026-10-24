// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Owner-maintained testnet-only valuation for assets such as CCIP-BnM
///         that intentionally have no market USD Data Feed.
/// @dev This is AggregatorV3-compatible but is NOT a Chainlink Data Feed and
///      must never be presented or deployed as a production price source.
contract AegisTestnetPriceFeed is Ownable {
    uint8 public constant decimals = 8;
    string public constant description = "AEGIS TESTNET CCIP-BnM / USD";
    uint256 public constant version = 1;

    uint80 private _roundId;
    int256 private _answer;
    uint256 private _updatedAt;

    event TestnetAnswerUpdated(uint80 indexed roundId, int256 answer, uint256 updatedAt);

    constructor(address initialOwner, int256 initialAnswer) Ownable(initialOwner) {
        _update(initialAnswer);
    }

    function updateAnswer(int256 answer) external onlyOwner {
        _update(answer);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (_roundId, _answer, _updatedAt, _updatedAt, _roundId);
    }

    function getRoundData(uint80 roundId) external view returns (uint80, int256, uint256, uint256, uint80) {
        require(roundId == _roundId, "NO_DATA");
        return (_roundId, _answer, _updatedAt, _updatedAt, _roundId);
    }

    function _update(int256 answer) private {
        require(answer > 0, "BAD_ANSWER");
        ++_roundId;
        _answer = answer;
        _updatedAt = block.timestamp;
        emit TestnetAnswerUpdated(_roundId, answer, _updatedAt);
    }
}
