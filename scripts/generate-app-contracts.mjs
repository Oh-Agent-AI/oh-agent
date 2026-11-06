#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCompatible, createValidators, metadata, repo, requireSdk, schemas, sdk } from "./app-contract-support.mjs";

export async function renderArtifacts() {
  if (metadata.metadata_version !== 1 || metadata.protocol_version !== 1 || metadata.projections.length !== 1) {
    throw new Error("unsupported projection metadata");
  }
  createValidators();
  const baseline = JSON.parse(fs.readFileSync(path.join(repo, "fixtures/app-contracts/city-v1-compat-baseline.json"), "utf8"));
  assertCompatible(baseline, schemas);
  const { compile } = requireSdk("json-schema-to-typescript");
  const banner = "/* Generated from docs/schemas by generate-app-contracts.mjs. Do not edit. */";
  const types = [];
  const capabilities = [];
  for (const projection of metadata.projections) {
    const response = schemas[projection.response_schema];
    const request = schemas[projection.request_schema];
    const identities = [response, ...request.oneOf];
    if (identities.some((schema) => schema.properties.projection.const !== projection.id
      || schema.properties.version.const !== projection.version || schema.properties.face.const !== projection.face)
      || schemas[projection.error_schema].properties.protocol_version.const !== metadata.protocol_version
      || request.oneOf[0].properties.page_size.maximum !== projection.max_page_size) {
      throw new Error("projection metadata/schema mismatch");
    }
    for (const name of [projection.request_schema, projection.response_schema, projection.error_schema]) {
      types.push(await compile(schemas[name], schemas[name].title, { bannerComment: "", cwd: path.join(repo, "docs/schemas"),
        additionalProperties: false, unreachableDefinitions: false, enableConstEnums: false }));
    }
    capabilities.push({ id: projection.id, version: projection.version, face: projection.face, max_page_size: projection.max_page_size });
  }
  return { "contracts.ts": `${banner}\n\n${types.join("\n")}\nexport const PROJECTION_CAPABILITIES = ${JSON.stringify(capabilities, null, 2)} as const;\n` };
}

export function verifyArtifact(expected, actual) {
  if (actual !== expected) throw new Error("generated app contract drift; run npm run generate:contracts in the SDK");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--write") || args.length > 1) throw new Error("usage: generate-app-contracts.mjs [--write]");
  const artifacts = await renderArtifacts();
  for (const [name, expected] of Object.entries(artifacts)) {
    const target = path.join(sdk, "src/generated", name);
    if (args.includes("--write")) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, expected);
    } else verifyArtifact(expected, fs.readFileSync(target, "utf8"));
  }
  console.log("App contract schemas, compatibility baseline, metadata and generated types verified.");
}
