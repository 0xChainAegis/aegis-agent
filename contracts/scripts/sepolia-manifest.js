const fs = require("fs");
const path = require("path");
const { getAddress } = require("ethers");

function persistSepoliaDeployment(deployment, directory = path.join(__dirname, "..", "deployments")) {
  const owner = getAddress(deployment.ownerAddress).toLowerCase();
  const wallet = getAddress(deployment.walletAddress).toLowerCase();
  const archive = path.join(directory, "sepolia", owner, `${wallet}.json`);
  const canonical = path.join(directory, "sepolia.json");
  const payload = `${JSON.stringify(deployment, null, 2)}\n`;
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  // Preserve every independent pool before updating the compatibility pointer.
  fs.writeFileSync(archive, payload, { mode: 0o600, flag: "wx" });
  fs.writeFileSync(canonical, payload, { mode: 0o600 });
  return { canonical, archive };
}

module.exports = { persistSepoliaDeployment };
