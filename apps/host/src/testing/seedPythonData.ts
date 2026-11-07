// Source-only seed for the desktop e2e (104-recovery-screen): writes the migration tests' synthetic
// schema-0025 Python data (one profile `synthetic`, no real values) into the recovery e2e's temp data
// dir (`<tmp>/t44-test-*/data`), so "Import my data" runs a real import there. Refuses any other one.
//   node --import tools/node-ts/resolveTs.ts apps/host/src/testing/seedPythonData.ts <data dir>
import { readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { writeSyntheticPythonData } from "../migration/testing/inPlaceFixture.js";

const dataDir = process.argv[2];
const temp = realpathSync(tmpdir());
if (
  process.env.CASHU_TESTING !== "1" ||
  process.argv.length !== 3 ||
  dataDir === undefined ||
  realpathSync(dataDir) !== dataDir ||
  !dataDir.startsWith(`${temp}/`) ||
  !/^t44-test-[^/]+\/data$/.test(dataDir.slice(temp.length + 1)) ||
  readdirSync(dataDir).length !== 0
) {
  console.error("seed python data: invalid test invocation");
  process.exit(64);
}
writeSyntheticPythonData(dataDir);
