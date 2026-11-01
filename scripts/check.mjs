import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
const paths = ["server", "lib", "public", "tests", "scripts"];
let count = 0;
for (const directory of paths)
  for (const file of readdirSync(directory)) {
    if (!/\.(mjs|js)$/.test(file)) continue;
    const result = spawnSync(
      process.execPath,
      ["--check", `${directory}/${file}`],
      { stdio: "inherit" },
    );
    if (result.status !== 0) process.exit(result.status || 1);
    count++;
  }
console.log(`Syntax checks passed: ${count} JavaScript modules`);
