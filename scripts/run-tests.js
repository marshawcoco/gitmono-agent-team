import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const TEST_FILE_PATTERN = /\.test\.(?:c|m)?js$/;
const testRoot = fileURLToPath(new URL("../test/", import.meta.url));

async function findTests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await findTests(entryPath));
    else if (entry.isFile() && TEST_FILE_PATTERN.test(entry.name)) files.push(entryPath);
  }

  return files;
}

const testFiles = await findTests(testRoot);
if (testFiles.length === 0) throw new Error(`No test files found under ${testRoot}.`);

const child = spawn(process.execPath, ["--test", ...testFiles], { stdio: "inherit" });
child.on("error", (error) => {
  throw error;
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
