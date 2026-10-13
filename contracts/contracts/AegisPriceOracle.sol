// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

/// @title AegisPriceOracle
/// @notice Chainlink Data Feeds wrapper used to value token amounts in USD so
///         permission tiers and risk limits can be expressed in stable value
///         instead of per-token units.
contract AegisPriceOracle is Ownable {
    /// @dev token => Chainlink aggregator (feed quotes the token in USD, e.g. 8 decimals).
    mapping(address => address) public feeds;
    /// @dev token => token decimals (18 assumed by default).
    mapping(address => uint8) public tokenDecimals;

    event FeedSet(address indexed token, address feed, uint8 decimals);

    constructor(address initialOwner) Ownable(initialOwner) {}

    function setFeed(address token, address feed, uint8 decimals) external onlyOwner {
        feeds[token] = feed;
        tokenDecimals[token] = decimals;
        emit FeedSet(token, feed, decimals);
    }

    /// @notice Returns the USD value of `amount` of `token`, scaled to 8 decimals.
    function getUsdValue(address token, uint256 amount) external view returns (uint256) {
        address feed = feeds[token];
        require(feed != address(0), "no feed");

        AggregatorV3Interface aggregator = AggregatorV3Interface(feed);
        (, int256 price, , , ) = aggregator.latestRoundData();
        require(price > 0, "bad price");

        uint8 feedDecimals = aggregator.decimals();
        uint8 td = tokenDecimals[token];

        // value(8-dec USD) = amount * price * 1e8 / (10^tokenDecimals * 10^feedDecimals)
        return (amount * uint256(price) * 1e8) / (10 ** uint256(td) * 10 ** uint256(feedDecimals));
    }
}
