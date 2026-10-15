// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Local-only feed for deterministic price and failure injection.
contract MockV3Aggregator {
    uint8 public decimals;
    string public constant description = "LOCAL MOCK ETH / USD";
    uint256 public constant version = 1;
    uint80 private _roundId;
    int256 private _answer;
    uint256 private _startedAt;
    uint256 private _updatedAt;
    uint80 private _answeredInRound;

    constructor(uint8 decimals_, int256 initialAnswer) {
        decimals = decimals_;
        updateAnswer(initialAnswer);
    }

    function updateAnswer(int256 answer) public {
        ++_roundId;
        _answer = answer;
        _startedAt = block.timestamp;
        _updatedAt = block.timestamp;
        _answeredInRound = _roundId;
    }

    function updateRoundData(uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) external {
        _roundId = roundId;
        _answer = answer;
        _startedAt = startedAt;
        _updatedAt = updatedAt;
        _answeredInRound = answeredInRound;
    }

    function setDecimals(uint8 decimals_) external { decimals = decimals_; }
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (_roundId, _answer, _startedAt, _updatedAt, _answeredInRound);
    }
    function getRoundData(uint80 roundId) external view returns (uint80, int256, uint256, uint256, uint80) {
        require(roundId == _roundId, "NO_DATA");
        return (_roundId, _answer, _startedAt, _updatedAt, _answeredInRound);
    }
}
