import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const TEST_SOURCE_PATTERN = /(?:^|\.)(?:test|spec)\.(?:c|m)?js$/;
const testRoot = fileURLToPath(new URL("../test/", import.meta.url));

async function findTests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await findTests(entryPath));
    else if (entry.isFile() && TEST_SOURCE_PATTERN.test(entry.name)) files.push(entryPath);
  }

  return files;
}

const testFiles = await findTests(testRoot);
if (testFiles.length === 0) throw new Error(`No test files found under ${testRoot}.`);

// Extra arguments are Node test-runner flags. They must precede `--test`, which
// lets CI enable native coverage without wrapping or rediscovering test files.
const child = spawn(process.execPath, [...process.argv.slice(2), "--test", ...testFiles], { stdio: "inherit" });
child.on("error", (error) => {
  throw error;
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
