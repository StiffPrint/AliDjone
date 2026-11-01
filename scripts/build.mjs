import { cpSync, mkdirSync, rmSync } from "node:fs";
rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
for (const path of [
  "server",
  "lib",
  "public",
  "scripts",
  "tests",
  "deploy",
  "package.json",
  "package-lock.json",
  "README.md",
])
  cpSync(path, `dist/${path}`, {
    recursive: true,
    filter: (source) =>
      !source.split("/").includes("__pycache__") && !/\.py[co]$/.test(source),
  });
console.log(
  "Standalone application built in dist/; no runtime npm dependencies.",
);
