import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { validateHandoff, validateIntentSpec } from "../src/protocol.js";

const rootUrl = new URL("../", import.meta.url);

async function readJson(relativePath) {
  return JSON.parse(await readFile(fileURLToPath(new URL(relativePath, rootUrl)), "utf8"));
}

function createAjv() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv;
}

function assertSchemaResult(validate, value, expected, label) {
  const actual = validate(value);
  assert.equal(actual, expected, `${label}: ${JSON.stringify(validate.errors)}`);
}

test("contract schemas compile and examples satisfy schema and runtime validation", async () => {
  const [intentSchema, handoffSchema, intent, handoff] = await Promise.all([
    readJson("contracts/intent-spec.schema.json"),
    readJson("contracts/handoff.schema.json"),
    readJson("examples/intent-spec.example.json"),
    readJson("examples/handoff.example.json")
  ]);
  const ajv = createAjv();
  const validateIntentSchema = ajv.compile(intentSchema);
  const validateHandoffSchema = ajv.compile(handoffSchema);

  assertSchemaResult(validateIntentSchema, intent, true, "example IntentSpec");
  assertSchemaResult(validateHandoffSchema, handoff, true, "example Handoff");
  assert.deepEqual(validateIntentSpec(intent), { valid: true, errors: [] });
  assert.deepEqual(validateHandoff(handoff), { valid: true, errors: [] });
});

test("schema and runtime validators reject unsafe IntentSpec paths", async () => {
  const [schema, example] = await Promise.all([
    readJson("contracts/intent-spec.schema.json"),
    readJson("examples/intent-spec.example.json")
  ]);
  const validate = createAjv().compile(schema);
  const unsafe = structuredClone(example);
  unsafe.target.allowedPaths = ["../outside"];

  assertSchemaResult(validate, unsafe, false, "unsafe IntentSpec");
  assert.equal(validateIntentSpec(unsafe).valid, false);
});

test("schema and runtime validators reject positive handoffs without patch identity", async () => {
  const [schema, example] = await Promise.all([
    readJson("contracts/handoff.schema.json"),
    readJson("examples/handoff.example.json")
  ]);
  const validate = createAjv().compile(schema);
  const missingPatchRef = structuredClone(example);
  delete missingPatchRef.patchRef;

  assertSchemaResult(validate, missingPatchRef, false, "missing patchRef");
  assert.equal(validateHandoff(missingPatchRef).valid, false);
});

test("schema and runtime validators reject contradictory positive evidence", async () => {
  const [schema, example] = await Promise.all([
    readJson("contracts/handoff.schema.json"),
    readJson("examples/handoff.example.json")
  ]);
  const validate = createAjv().compile(schema);
  const contradictory = structuredClone(example);
  contradictory.evidence.push({
    kind: "security",
    result: "failed",
    summary: "Security regression"
  });

  assertSchemaResult(validate, contradictory, false, "contradictory Handoff");
  assert.equal(validateHandoff(contradictory).valid, false);
});
