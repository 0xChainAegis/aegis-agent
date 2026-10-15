// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

/// @notice Locked native ETH/USD feed adapter. USD6 quotes round upward so tiny
///         positive payments cannot evade a budget by truncating to zero.
contract AegisPriceOracle is Ownable {
    mapping(address => address) public feeds;
    mapping(address => uint8) public tokenDecimals;
    bool public configurationLocked;
    uint8 private _feedDecimals;
    event FeedSet(address indexed token, address indexed feed, uint8 tokenDecimals);
    event ConfigurationLocked(address indexed feed);

    constructor(address initialOwner) Ownable(initialOwner) {}

    function setFeed(address token, address feed, uint8 decimals_) external onlyOwner {
        require(!configurationLocked, "ORACLE_CONFIGURATION_LOCKED");
        require(token == address(0) && decimals_ == 18, "NATIVE_ETH_ONLY");
        require(feed.code.length > 0, "BAD_FEED");
        uint8 feedDecimals = AggregatorV3Interface(feed).decimals();
        require(feedDecimals <= 18, "UNSUPPORTED_DECIMALS");
        feeds[token] = feed;
        tokenDecimals[token] = decimals_;
        _feedDecimals = feedDecimals;
        emit FeedSet(token, feed, decimals_);
    }

    function lockConfiguration() external onlyOwner {
        require(!configurationLocked, "ORACLE_CONFIGURATION_LOCKED");
        require(feeds[address(0)] != address(0), "FEED_NOT_SET");
        configurationLocked = true;
        emit ConfigurationLocked(feeds[address(0)]);
    }

    function latestEthQuote(uint256 amountWei) external view returns (uint256 costUsd6, uint80 roundId, int256 answer, uint256 updatedAt, uint8 decimals) {
        (roundId, answer, updatedAt, decimals) = _quote();
        costUsd6 = Math.mulDiv(amountWei, uint256(answer), 10 ** (12 + uint256(decimals)), Math.Rounding.Ceil);
    }

    // Legacy read-only USD8 accessor; payment authorization uses latestEthQuote USD6.
    function getUsdValue(address token, uint256 amount) external view returns (uint256 valueUsd8) {
        require(token == address(0), "NATIVE_ETH_ONLY");
        (, int256 answer, , uint8 decimals_) = _quote();
        return Math.mulDiv(amount, uint256(answer), 10 ** (10 + uint256(decimals_)), Math.Rounding.Ceil);
    }

    function _quote() internal view returns (uint80 roundId, int256 answer, uint256 updatedAt, uint8 decimals_) {
        require(configurationLocked, "ORACLE_NOT_LOCKED");
        AggregatorV3Interface feed = AggregatorV3Interface(feeds[address(0)]);
        uint80 answeredInRound;
        (roundId, answer, , updatedAt, answeredInRound) = feed.latestRoundData();
        require(answer > 0, "ORACLE_BAD_ANSWER");
        require(roundId > 0 && answeredInRound >= roundId, "ORACLE_INCOMPLETE_ROUND");
        require(updatedAt > 0 && updatedAt <= block.timestamp, "ORACLE_BAD_TIMESTAMP");
        decimals_ = feed.decimals();
        require(decimals_ == _feedDecimals, "ORACLE_DECIMALS_CHANGED");
    }
}
