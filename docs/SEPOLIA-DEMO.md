# Sepolia demo

The stage demo uses Ethereum Sepolia (chain ID **11155111**) and the real Chainlink ETH/USD Feed. A Hardhat receipt, Mock Feed, successful build or LLM-only parsing report is not Sepolia payment evidence.

## Deployment and signing identities

Deploy the current contracts using `contracts/scripts/deploy.js` and the configuration documented in [the contract guide](../contracts/README.md). The script verifies the network, Feed, roles, bindings and funding before writing `contracts/deployments/sepolia.json`. A pre-PolicyEngine Wallet is not compatible with the current backend: its missing `policyEngine()` interface cannot be repaired by editing JSON.

The deployment JSON contains public addresses. It must include Wallet, ACL, Attestation, Oracle, PolicyEngine, Feed, Owner, executor and recipient. The Owner is the account configured by this deployment, not whichever browser wallet connects first. Use that Owner account in the presenting browser. The executor is a separate restricted signer held only by the backend. The Wallet contract holds the top-up funds; the recipient is the operating wallet receiving ETH.

Each user has a separate treasury and its own policy, allowlist, budget and restricted executor. Connecting another wallet does not make it an administrator of an existing treasury. This MVP serves one configured treasury per running backend; it does not provide automatic pool creation or a shared multi-user service.

For a personal test pool, set `OWNER_ADDRESS` to the intended browser wallet's public EOA address before deploying. The funded deployer performs setup and transfers the actual Ownable and AccessControl administration to that Owner. The script verifies the handoff and removes the previous deployer's administration before saving the deployment. The user never needs to give their Owner private key to the deployer. Omitting `OWNER_ADDRESS` keeps the deployer as Owner.

An EOA may have an [EIP-7702 delegation](https://eips.ethereum.org/EIPS/eip-7702) without losing ordinary ECDSA signing or transaction origination. Owner preflight accepts empty code or exactly `0xef0100` plus a nonzero 20-byte delegation target. It continues to reject ordinary contract bytecode, malformed or stored zero-target markers, and predicted deployment-contract addresses. Recognizing that format does not audit the delegated implementation. The current login requires a normal EOA message signature and Owner transactions from that address; ERC-1271-only and relayed account-abstraction flows are not supported. Verify the intended extension can complete the existing signing flow on the presenting computer.

The script preserves each deployment at `contracts/deployments/sepolia/<owner-address>/<wallet-address>.json` in addition to updating `contracts/deployments/sepolia.json`. Select the preserved file for the specific pool you intend to run, rather than overwriting another user's settings. These generated files are ignored by Git and contain public deployment information. Use a distinct executor per independent pool, fund its gas separately, and run only one backend writer for that executor to avoid nonce conflicts. Separate backend instances also need separate ports and databases; the standard web launcher serves one instance on 3001/5173.

Use dedicated testnet accounts and Sepolia ETH. Keep Owner keys out of the backend and out of the repository. Never reuse Hardhat's published development keys on Sepolia. Follow the current deployment script's signer requirements; do not change a public Owner field without matching on-chain ownership and administration.

## Start the web demo

Install the locked dependencies with Node 24 or newer. Set these variables in the same PowerShell window used to start the services. Replace the RPC URL with the team's endpoint; the deployment file must come from the actual current deployment.

```powershell
$env:AEGIS_MODE = 'testnet'
$env:AEGIS_CHAIN_ID = '11155111'
$env:AEGIS_DEPLOYMENT_FILE = (Resolve-Path 'contracts/deployments/sepolia.json').Path
$env:AEGIS_RPC_URL = 'https://YOUR_SEPOLIA_RPC'
$env:AEGIS_AGENT_PRIVATE_KEY = [System.Net.NetworkCredential]::new('', (Read-Host 'Executor key (not Owner key)' -AsSecureString)).Password
```

For a live model, set `AEGIS_LLM_PROVIDER`, `AEGIS_LLM_BASE_URL`, `AEGIS_LLM_MODEL` and `AEGIS_LLM_API_KEY` using the team's tested provider. Enter keys privately; never copy them into frontend code, screenshots or chat. The existing launcher supports an explicit Sepolia selection:

```powershell
py scripts/start-live-web.py --network sepolia --check
py scripts/start-live-web.py --network sepolia
```

To test the Sepolia wallet and UI before configuring a model, use deterministic rule parsing:

```bash
python3 scripts/start-live-web.py --network sepolia --llm off
```

The local `contracts/.env.llm` file is ignored by Git and is preconfigured for DeepSeek's OpenAI-compatible API. Paste only the private key after `AEGIS_LLM_API_KEY=`, then load both private environment files and start live parsing:

```bash
set -a
source contracts/.env
source contracts/.env.llm
set +a
export AEGIS_MODE=testnet
export AEGIS_CHAIN_ID=11155111
export AEGIS_DEPLOYMENT_FILE="$PWD/contracts/deployments/sepolia.json"
export AEGIS_RPC_URL="$RPC_URL"
python3 scripts/start-live-web.py --network sepolia --llm live
```

The checked-in `contracts/.env.llm.example` contains no secret and documents the expected `deepseek-flash` configuration. Never commit or screenshot the populated `.env.llm` file.

After those two private environment files are configured, the normal startup command is simply:

```bash
npm run start:sepolia
```

For chain and wallet testing without an AI key, use `npm run start:sepolia:no-ai`. Add `-- --check` to either npm command to validate configuration without starting services or contacting the RPC/model.

`AEGIS_LLM_MODE=off` in the environment has the same effect, so the shorter command also works after exporting it. `--check` validates local configuration only. It does not contact the RPC or model, prove deployed bytecode, or send payment. Sepolia startup does not start or require Hardhat on port 8545, and never falls back to Local. It reuses a deployment-specific SQLite path by default, preserving task recovery across restarts. An explicit `AEGIS_DB_PATH` overrides this; keep it private and stable for the same deployment. Stop an existing app on 3001/5173 before starting another.

On Linux/macOS, when the current deployment settings are in `contracts/.env`,
run the live read-only gate before starting the UI:

```bash
npm run check:sepolia
```

Unlike the launcher's configuration-only `--check`, this contacts Sepolia and
verifies chain ID, deployed bytecode, bindings, roles, Chainlink freshness and
funding. It never signs or broadcasts a transaction. A successful result proves
readiness at the reported block, not that a web payment has been accepted.

Run the read-only policy regression against the same deployment with:

```bash
npm run test:sepolia:policy
```

This command reads one observed Sepolia block and calls `PolicyEngine.evaluate`
with dynamically priced boundary requests. It verifies the configured Feed
binding and freshness, daily-budget accounting, the exact automatic/approval
boundary, unauthorized agents, non-allowlisted recipients, zero amounts,
expired requests, policy-version changes, quote caps, the hard per-transaction
limit, and the explicit rejection of subscription and CCIP actions that are not
implemented yet. The report contains only public addresses and chain evidence;
it never reads a signer key, signs, broadcasts or spends Sepolia ETH.

The public Chainlink Feed cannot safely be forced to publish a negative, zero,
future or stale round. Those fault-injection cases remain deterministic Hardhat
tests using `MockV3Aggregator`; the Sepolia command verifies the real Feed's
current round and age without misrepresenting a local fault as public-testnet
evidence. A daily-limit rejection can only be exercised on the shared Sepolia
deployment after its remaining daily budget falls below the per-transaction
cap, so the read-only command always verifies the on-chain spent/remaining
accounting and leaves destructive budget exhaustion out of the default run.

Public `/api/v1/config` and `/health` share a bounded readiness check on Sepolia. Initial or expired checks return a non-ready status, disabling wallet actions. A completed result remains a display proof for at most fifteen seconds; after five seconds, the next read starts one background refresh without delaying the still-valid result. Failure replaces readiness immediately; results are never served ready past the hard expiry. Responses include check completion time and cache age, which are not a claim of current block finality. These display checks never replace fresh preview, execution or Owner-approval checks.

## Acceptance on the actual presenting computer

1. Read `/api/v1/config`: require `mode=testnet`, chain ID 11155111, the intended Owner and current contract addresses. `/health` must become ready after real RPC, Feed, authorization and funding checks.
2. Select the intended wallet extension explicitly, switch it to Sepolia and connect the deployed Owner. Sign only the displayed login message. Login is not a payment authorization.
3. If demonstrating AI, submit one complete natural-language intent and verify `parser.kind=llm` and `parser.fallback=false` in the response. Rule fallback must be labelled as such.
4. Use a tiny allowlisted ETH amount within the configured budget. Review the recipient, chain and maximum USD cost, then explicitly confirm. Record the actual transaction hash.
5. Open `https://sepolia.etherscan.io/tx/ACTUAL_HASH`. Confirm the matching Wallet payment and PolicyEngine budget events, amount and recipient. Save code revision, network, public deployment addresses and transaction link; exclude secrets.
6. Reload the app. The same task remains and no second payment appears. Demonstrate rejection with an injected instruction or a blocked preview, without deliberately sending an unsafe transaction.

Record a short backup video of this same Sepolia flow before the event. An offline recording is a contingency, not proof that the current live connection is healthy. Follow the organizer's on-site demonstration requirements.
