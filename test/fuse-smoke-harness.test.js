import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootUrl = new URL("../", import.meta.url);

async function readText(relativePath) {
  const contents = await readFile(fileURLToPath(new URL(relativePath, rootUrl)), "utf8");
  return contents.replaceAll("\r\n", "\n");
}

test("FUSE smoke isolates doctor while preserving the live mount probe and cleanup", async () => {
  const script = await readText("scripts/ci/fuse-smoke.sh");
  const siblingDoctor = '"${compose[@]}" run --rm --no-deps --no-TTY scorpiofs doctor';
  const executableScript = script.replace(/\\\n\s*/g, " ");
  const doctorCommands = executableScript
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes('"${compose[@]}"') && /\bdoctor\b/.test(line));

  assert.deepEqual(doctorCommands, [siblingDoctor]);
  assert.doesNotMatch(executableScript, /"\$\{compose\[@\]\}"\s+restart\b/);
  assert.doesNotMatch(executableScript, /"\$\{compose\[@\]\}"\s+up\b[^\n]*--force-recreate/);

  const serviceUp = script.indexOf('"${compose[@]}" up --detach --wait --wait-timeout 480 --no-build scorpiofs');
  const bucketLog = script.indexOf('bucket_log="$("${compose[@]}" logs --no-color init-rustfs-bucket)"', serviceUp);
  const megaStatus = script.indexOf("http://127.0.0.1:8000/api/v1/status", bucketLog);
  const scorpioHealth = script.indexOf("http://127.0.0.1:2725/health", megaStatus);
  const antaresHealth = script.indexOf("http://127.0.0.1:2725/antares/health", scorpioHealth);
  const doctor = script.indexOf(siblingDoctor);
  const mountCreate = script.indexOf("http://127.0.0.1:2725/antares/mounts", doctor);
  const readyEndpoint = script.indexOf('"http://127.0.0.1:2725/antares/mounts/${mount_id}/ready"', mountCreate);
  const readyGate = script.indexOf('if [[ "$ready" != "true" ]]; then', readyEndpoint);
  const liveMountProbe = script.indexOf('grep -F " ${MOUNTPOINT} " /proc/self/mountinfo', readyGate);
  const writeProbe = script.indexOf('printf "fuse-smoke\\n" > "${probe}"', liveMountProbe);
  const readProbe = script.indexOf('test "$(cat "${probe}")" = "fuse-smoke"', writeProbe);
  const removeProbe = script.indexOf('rm -f "${probe}"', readProbe);
  const absenceProbe = script.indexOf('test ! -e "${probe}"', removeProbe);
  const successDeleteCurl = script.indexOf("curl --fail --silent --show-error --request DELETE", absenceProbe);
  const mountDelete = script.indexOf('"http://127.0.0.1:2725/antares/mounts/${mount_id}"', successDeleteCurl);
  const clearMountId = script.indexOf('mount_id=""', mountDelete);
  const passText = script.indexOf("ScorpioFS FUSE mount readiness and read/write smoke checks passed.", clearMountId);

  assert.ok(serviceUp >= 0 && serviceUp < bucketLog);
  assert.ok(bucketLog < megaStatus);
  assert.ok(megaStatus < scorpioHealth);
  assert.ok(scorpioHealth < antaresHealth);
  assert.ok(antaresHealth < doctor);
  assert.ok(doctor < mountCreate);
  assert.ok(mountCreate < readyEndpoint);
  assert.ok(readyEndpoint < readyGate);
  assert.ok(readyGate < liveMountProbe);
  assert.ok(liveMountProbe < writeProbe);
  assert.ok(writeProbe < readProbe);
  assert.ok(readProbe < removeProbe);
  assert.ok(removeProbe < absenceProbe);
  assert.ok(absenceProbe < successDeleteCurl);
  assert.ok(successDeleteCurl < mountDelete);
  assert.ok(mountDelete < clearMountId);
  assert.ok(clearMountId < passText);
  assert.match(
    script.slice(successDeleteCurl, clearMountId),
    /^curl --fail --silent --show-error --request DELETE \\\n\s+"http:\/\/127\.0\.0\.1:2725\/antares\/mounts\/\$\{mount_id\}" >\/dev\/null\n$/
  );

  const cleanupStart = script.indexOf("cleanup() {");
  const trap = script.indexOf("trap cleanup EXIT");
  const cleanupBlock = script.slice(cleanupStart, trap);
  const verifySubmodules = script.indexOf("bash scripts/ci/verify-submodules.sh", trap);
  const composeConfig = script.indexOf('"${compose[@]}" config --quiet', verifySubmodules);
  const imageBuild = script.indexOf('if [[ "${SKIP_SCORPIO_BUILD:-false}" != "true" ]]; then', composeConfig);

  assert.ok(cleanupStart >= 0 && cleanupStart < trap);
  assert.ok(trap < verifySubmodules);
  assert.ok(verifySubmodules < composeConfig);
  assert.ok(composeConfig < imageBuild);
  assert.ok(imageBuild < serviceUp);
  assert.match(cleanupBlock, /^\s+status=\$\?$/m);
  assert.match(cleanupBlock, /if \[\[ -n "\$mount_id" \]\]; then[\s\S]*--request DELETE/);
  assert.match(cleanupBlock, /"\$\{compose\[@\]\}" logs --no-color --tail 400 mega scorpiofs/);
  assert.match(cleanupBlock, /"\$\{compose\[@\]\}" down --volumes --remove-orphans --timeout 45/);
  assert.match(cleanupBlock, /\[\[ -n "\$response_file" \]\] && rm -f "\$response_file"/);
  assert.match(cleanupBlock, /rm -f "\$compose_override" "\$pinned_dockerfile"/);
  assert.match(cleanupBlock, /exit "\$status"/);
  assert.match(script, /^trap cleanup EXIT$/m);
});

test("trusted FUSE workflow remains manual, protected, and default-branch only", async () => {
  const workflow = await readText(".github/workflows/fuse-smoke.yml");
  const onStart = workflow.indexOf("on:\n");
  const permissionsStart = workflow.indexOf("\npermissions:\n", onStart);
  const concurrencyStart = workflow.indexOf("\nconcurrency:\n", permissionsStart);
  const onBlock = workflow.slice(onStart, permissionsStart);
  const permissionsBlock = workflow.slice(permissionsStart + 1, concurrencyStart);
  const triggers = [...onBlock.matchAll(/^  ([a-z_]+):/gm)].map((match) => match[1]);
  const permissions = [...permissionsBlock.matchAll(/^  ([a-z-]+):\s*(\S+)$/gm)]
    .map((match) => [match[1], match[2]]);

  assert.deepEqual(triggers, ["workflow_dispatch"]);
  assert.deepEqual(permissions, [["contents", "read"]]);
  assert.doesNotMatch(workflow, /^[ \t]+permissions:/m);
  assert.match(workflow, /if: github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/);
  assert.match(workflow, /^\s{4}environment: trusted-fuse$/m);
  assert.match(workflow, /^\s{4}runs-on: \[self-hosted, linux, x64, fuse, ephemeral\]$/m);
  assert.match(workflow, /^\s{10}ref: \$\{\{ github\.event\.repository\.default_branch \}\}$/m);
  assert.match(workflow, /^\s{10}persist-credentials: false$/m);
  assert.match(workflow, /^\s{10}GITHUB_DEFAULT_BRANCH: \$\{\{ github\.event\.repository\.default_branch \}\}$/m);
  assert.equal(workflow.split("run: bash scripts/ci/fuse-smoke.sh").length - 1, 1);
});

test("deployment guide uses the same sibling doctor boundary", async () => {
  const readme = await readText("deploy/README.md");
  const executableReadme = readme
    .replace(/\\\n\s*/g, " ")
    .replace(/[ \t]+/g, " ");
  const documentedDoctor = "docker compose --env-file deploy/.env -f deploy/compose.yaml run --rm --no-deps --no-TTY scorpiofs doctor";

  assert.equal(executableReadme.split(documentedDoctor).length - 1, 1);
  assert.doesNotMatch(executableReadme, /docker compose[^\n]*\bexec\b[^\n]*\bdoctor\b/);
  assert.match(readme, /sibling container/);
  assert.match(readme, /mount namespace/);
  assert.match(readme, /真实 FUSE 数据通路/);
});
