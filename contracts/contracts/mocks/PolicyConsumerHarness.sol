// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AegisPolicyEngine} from "../AegisPolicyEngine.sol";

contract PolicyConsumerHarness {
    function consume(AegisPolicyEngine engine, AegisPolicyEngine.RiskRequest calldata request, bool ownerApproved)
        external
        returns (AegisPolicyEngine.RiskResult memory)
    {
        return engine.validateAndConsume(request, ownerApproved);
    }

    function consumeThenRevert(AegisPolicyEngine engine, AegisPolicyEngine.RiskRequest calldata request)
        external
    {
        engine.validateAndConsume(request, false);
        revert("AFTER_CONSUME");
    }
}
