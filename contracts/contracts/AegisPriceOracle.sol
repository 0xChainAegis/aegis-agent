// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

/// @notice Locked asset/USD feed adapter. USD6 quotes round upward so tiny
///         positive payments cannot evade a budget by truncating to zero.
contract AegisPriceOracle is Ownable {
    mapping(address => address) public feeds;
    mapping(address => uint8) public tokenDecimals;
    mapping(address => uint8) private _feedDecimals;
    bool public configurationLocked;
    event FeedSet(address indexed token, address indexed feed, uint8 tokenDecimals);
    event ConfigurationLocked(address indexed feed);

    constructor(address initialOwner) Ownable(initialOwner) {}

    function setFeed(address token, address feed, uint8 decimals_) external onlyOwner {
        require(!configurationLocked, "ORACLE_CONFIGURATION_LOCKED");
        require(decimals_ <= 18, "UNSUPPORTED_TOKEN_DECIMALS");
        require(feed.code.length > 0, "BAD_FEED");
        uint8 feedDecimals = AggregatorV3Interface(feed).decimals();
        require(feedDecimals <= 18, "UNSUPPORTED_DECIMALS");
        require(uint256(decimals_) + uint256(feedDecimals) >= 6, "INSUFFICIENT_QUOTE_PRECISION");
        feeds[token] = feed;
        tokenDecimals[token] = decimals_;
        _feedDecimals[token] = feedDecimals;
        emit FeedSet(token, feed, decimals_);
    }

    function lockConfiguration() external onlyOwner {
        require(!configurationLocked, "ORACLE_CONFIGURATION_LOCKED");
        require(feeds[address(0)] != address(0), "FEED_NOT_SET");
        configurationLocked = true;
        emit ConfigurationLocked(feeds[address(0)]);
    }

    function latestEthQuote(uint256 amountWei) external view returns (uint256 costUsd6, uint80 roundId, int256 answer, uint256 updatedAt, uint8 decimals) {
        return latestQuote(address(0), amountWei);
    }

    function latestQuote(address token, uint256 amount) public view returns (uint256 costUsd6, uint80 roundId, int256 answer, uint256 updatedAt, uint8 decimals) {
        (roundId, answer, updatedAt, decimals) = _quote(token);
        uint256 denominator = 10 ** (uint256(tokenDecimals[token]) + uint256(decimals) - 6);
        costUsd6 = Math.mulDiv(amount, uint256(answer), denominator, Math.Rounding.Ceil);
    }

    // Legacy read-only USD8 accessor; payment authorization uses latestEthQuote USD6.
    function getUsdValue(address token, uint256 amount) external view returns (uint256 valueUsd8) {
        (, int256 answer, , uint8 decimals_) = _quote(token);
        uint256 scale = uint256(tokenDecimals[token]) + uint256(decimals_);
        if (scale >= 8) return Math.mulDiv(amount, uint256(answer), 10 ** (scale - 8), Math.Rounding.Ceil);
        return Math.mulDiv(amount, uint256(answer) * (10 ** (8 - scale)), 1, Math.Rounding.Ceil);
    }

    function _quote(address token) internal view returns (uint80 roundId, int256 answer, uint256 updatedAt, uint8 decimals_) {
        require(configurationLocked, "ORACLE_NOT_LOCKED");
        address feedAddress = feeds[token];
        require(feedAddress != address(0), "FEED_NOT_SET");
        AggregatorV3Interface feed = AggregatorV3Interface(feedAddress);
        uint80 answeredInRound;
        (roundId, answer, , updatedAt, answeredInRound) = feed.latestRoundData();
        require(answer > 0, "ORACLE_BAD_ANSWER");
        require(roundId > 0 && answeredInRound >= roundId, "ORACLE_INCOMPLETE_ROUND");
        require(updatedAt > 0 && updatedAt <= block.timestamp, "ORACLE_BAD_TIMESTAMP");
        decimals_ = feed.decimals();
        require(decimals_ == _feedDecimals[token], "ORACLE_DECIMALS_CHANGED");
    }
}
