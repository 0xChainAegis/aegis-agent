const fs = require("fs");
const path = require("path");
const { getAddress } = require("ethers");

function archivePath(directory, deployment) {
  const owner = getAddress(deployment.ownerAddress).toLowerCase();
  const wallet = getAddress(deployment.walletAddress).toLowerCase();
  return path.join(directory, "sepolia", owner, `${wallet}.json`);
}

function assertSepoliaDeploymentAvailable(deployment, directory = path.join(__dirname, "..", "deployments")) {
  const archive = archivePath(directory, deployment);
  if (fs.existsSync(archive)) {
    throw new Error(`Sepolia deployment archive already exists: ${archive}`);
  }
  return archive;
}

// The canonical pointer is gitignored, so an older deployment that was never
// archived would otherwise disappear when the pointer is replaced.
function preservePreviousCanonical(canonical, directory) {
  let previous;
  try { previous = JSON.parse(fs.readFileSync(canonical, "utf8")); } catch { return; }
  if (previous === null || typeof previous !== "object") return;
  let target;
  try { target = archivePath(directory, previous); } catch { return; }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.writeFileSync(target, `${JSON.stringify(previous, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}

function persistSepoliaDeployment(deployment, directory = path.join(__dirname, "..", "deployments")) {
  const archive = assertSepoliaDeploymentAvailable(deployment, directory);
  const canonical = path.join(directory, "sepolia.json");
  const payload = `${JSON.stringify(deployment, null, 2)}\n`;
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  // Preserve every independent pool before updating the compatibility pointer.
  fs.writeFileSync(archive, payload, { mode: 0o600, flag: "wx" });
  preservePreviousCanonical(canonical, directory);
  fs.writeFileSync(canonical, payload, { mode: 0o600 });
  return { canonical, archive };
}

module.exports = { assertSepoliaDeploymentAvailable, persistSepoliaDeployment };
