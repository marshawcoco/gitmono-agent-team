import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const demoPath = fileURLToPath(new URL("../src/demo.js", import.meta.url));
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "gitmono-agent-demo-"));

try {
  const { stdout, stderr } = await execFileAsync(process.execPath, [demoPath], {
    cwd: temporaryDirectory,
    encoding: "utf8",
    maxBuffer: 1024 * 1024
  });

  assert.equal(stderr, "", "The demo must not write diagnostics to stderr.");
  const gate = JSON.parse(stdout);
  assert.equal(gate.intentId, "demo-session-timeout");
  assert.equal(gate.handoffCount, 3);
  for (const field of [
    "implementerDelivered",
    "verificationPassed",
    "testEvidencePassed",
    "reviewApproved",
    "patchRefConsistent",
    "blockingEvidenceAbsent",
    "baseCommitConsistent",
    "humanApproval",
    "readyToMerge"
  ]) {
    assert.equal(gate[field], true, `Expected ${field} to be true.`);
  }

  console.log("Demo gate assertions passed in an isolated state directory.");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
