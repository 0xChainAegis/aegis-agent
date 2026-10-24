const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { assertSepoliaDeploymentAvailable, persistSepoliaDeployment } = require("../scripts/sepolia-manifest");

describe("Public Sepolia pool manifests", function () {
  let directory;
  beforeEach(function () { directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "aegis-owner-manifest-")); });
  afterEach(function () {
    const resolved = fs.realpathSync(directory);
    if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith("aegis-owner-manifest-")) {
      throw new Error("Refusing to clean up outside the test's temporary manifest directory");
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  });

  it("preserves independent Owners and multiple pools per Owner while updating canonical sepolia.json", function () {
    const first = { chainId: 11155111, ownerAddress: "0x1000000000000000000000000000000000000001", walletAddress: "0x2000000000000000000000000000000000000002" };
    const second = { ...first, ownerAddress: "0x3000000000000000000000000000000000000003", walletAddress: "0x4000000000000000000000000000000000000004" };
    const third = { ...first, walletAddress: "0x5000000000000000000000000000000000000005" };
    const records = [first, second, third].map(deployment => persistSepoliaDeployment(deployment, directory));
    for (const [index, output] of records.entries()) expect(JSON.parse(fs.readFileSync(output.archive, "utf8"))).to.deep.equal([first, second, third][index]);
    expect(JSON.parse(fs.readFileSync(records[0].canonical, "utf8"))).to.deep.equal(third);
    expect(() => persistSepoliaDeployment({ ...first, chainId: 1 }, directory)).to.throw();
    expect(JSON.parse(fs.readFileSync(records[0].archive, "utf8"))).to.deep.equal(first);
    expect(JSON.parse(fs.readFileSync(records[0].canonical, "utf8"))).to.deep.equal(third);
  });

  it("archives a previously unarchived canonical deployment before replacing the pointer", function () {
    const legacy = { chainId: 11155111, ownerAddress: "0x1000000000000000000000000000000000000001", walletAddress: "0x6000000000000000000000000000000000000006" };
    const next = { ...legacy, walletAddress: "0x7000000000000000000000000000000000000007" };
    const canonical = path.join(directory, "sepolia.json");
    fs.writeFileSync(canonical, `${JSON.stringify(legacy)}\n`);
    const output = persistSepoliaDeployment(next, directory);
    const legacyArchive = path.join(directory, "sepolia", legacy.ownerAddress.toLowerCase(), `${legacy.walletAddress.toLowerCase()}.json`);
    expect(JSON.parse(fs.readFileSync(legacyArchive, "utf8"))).to.deep.equal(legacy);
    expect(JSON.parse(fs.readFileSync(output.canonical, "utf8"))).to.deep.equal(next);
  });

  it("leaves the canonical pointer and archives untouched when the new archive already exists", function () {
    const first = { chainId: 11155111, ownerAddress: "0x1000000000000000000000000000000000000001", walletAddress: "0x2000000000000000000000000000000000000002" };
    const second = { ...first, walletAddress: "0x4000000000000000000000000000000000000004" };
    persistSepoliaDeployment(first, directory);
    persistSepoliaDeployment(second, directory);
    expect(() => persistSepoliaDeployment(first, directory)).to.throw();
    expect(JSON.parse(fs.readFileSync(path.join(directory, "sepolia.json"), "utf8"))).to.deep.equal(second);
  });

  it("detects an archive collision before deployment without changing any manifest", function () {
    const deployment = { ownerAddress: "0x1000000000000000000000000000000000000001", walletAddress: "0x2000000000000000000000000000000000000002" };
    const output = persistSepoliaDeployment({ chainId: 11155111, ...deployment }, directory);
    const canonicalBefore = fs.readFileSync(output.canonical, "utf8");
    const archiveBefore = fs.readFileSync(output.archive, "utf8");
    expect(() => assertSepoliaDeploymentAvailable(deployment, directory)).to.throw("already exists");
    expect(fs.readFileSync(output.canonical, "utf8")).to.equal(canonicalBefore);
    expect(fs.readFileSync(output.archive, "utf8")).to.equal(archiveBefore);
  });
});
