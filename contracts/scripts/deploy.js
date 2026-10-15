// The old script deployed a wallet without the required locked feed and policy.
// Keep legacy public commands explicit instead of silently deploying unsafe state.
throw new Error("Public deployment is disabled for this local integration MVP. Use npm run deploy:local on chain 31337.");
