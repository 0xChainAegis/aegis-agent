const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { persistSepoliaDeployment } = require("../scripts/sepolia-manifest");

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
});
