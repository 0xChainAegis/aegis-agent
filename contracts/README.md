# Aegis Contracts

Smart contracts for AegisAgent.

## Contracts

| Contract | Responsibility |
|---|---|
| `AegisAccessControl` | Roles (owner / guardian / agent) and permission tiers with per-agent auto limits |
| `AegisAttestation` | Append-only on-chain audit log of every agent action |
| `AegisWallet` | ETH/ERC20 deposits, bounded agent transfers with human approval, subscriptions |
| `AegisPriceOracle` | Chainlink Data Feeds wrapper for USD-valued risk limits |
| `AegisCCIPSender` | Chainlink CCIP cross-chain token transfers (Bounty integration) |

## Quickstart

```bash
npm install
cp .env.example .env   # fill in PRIVATE_KEY and AGENT_ADDRESS
npm run compile
npm test
npm run deploy          # local hardhat network
npm run deploy:sepolia  # Ethereum Sepolia
```

## Chainlink Bounty mapping

- **CCIP** — `AegisCCIPSender.transferTokenCrossChain`
- **Data Feeds** — `AegisPriceOracle.getUsdValue`
- Router addresses and chain selectors in `scripts/deploy.js` must be verified
  against the official Chainlink docs before deploying.
