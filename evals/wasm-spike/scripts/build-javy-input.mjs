#!/usr/bin/env node
// Generate build/javy-entry.js for the Javy leg of the W1 spike (spec section 11.3).
//
// The Javy module is one JS file: the *already patched* validator-only IIFE bundle
// (build/validate-vehicle.iife.js, produced by build-spike.mjs) concatenated with a
// stdin/stdout entry. Javy embeds QuickJS (same engine lineage as the quickjs-emscripten
// leg), so it consumes the same single `\-` class-escape compat patch.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const spikeRoot = fileURLToPath(new URL("../", import.meta.url));
const patchedBundle = readFileSync(path.join(spikeRoot, "build/validate-vehicle.iife.js"), "utf8");

const ENTRY = `
// Javy entry: profile JSON on stdin -> JSON.stringify(validateVehicleProfileV1(...)) on stdout.
function readInputRaw() {
  const chunkSize = 4096;
  const chunks = [];
  let totalBytes = 0;
  for (;;) {
    const buffer = new Uint8Array(chunkSize);
    const bytesRead = Javy.IO.readSync(0, buffer);
    if (bytesRead === 0) break;
    totalBytes += bytesRead;
    chunks.push(buffer.subarray(0, bytesRead));
  }
  const all = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
  return all;
}

function decodeUtf8(bytes) {
  // QuickJS has no TextDecoder in some builds; decode UTF-8 manually (bounded, ASCII fast path).
  if (typeof TextDecoder !== "undefined") return new TextDecoder().decode(bytes);
  let out = "";
  let index = 0;
  while (index < bytes.length) {
    const b0 = bytes[index];
    if (b0 < 0x80) { out += String.fromCharCode(b0); index += 1; continue; }
    let codePoint = 0;
    let extra = 0;
    if (b0 >= 0xf0) { codePoint = b0 & 0x07; extra = 3; }
    else if (b0 >= 0xe0) { codePoint = b0 & 0x0f; extra = 2; }
    else { codePoint = b0 & 0x1f; extra = 1; }
    for (let k = 1; k <= extra; k += 1) { codePoint = (codePoint << 6) | (bytes[index + k] & 0x3f); }
    out += String.fromCharCode(codePoint);
    index += extra + 1;
  }
  return out;
}

function writeOutput(bytes) {
  const buffer = new Uint8Array(bytes);
  Javy.IO.writeSync(1, buffer);
}

const profileJson = decodeUtf8(readInputRaw());
const verdict = JSON.stringify(citySdk.validateVehicleProfileV1(JSON.parse(profileJson)));
writeOutput(typeof TextEncoder !== "undefined" ? new TextEncoder().encode(verdict) : utf8Encode(verdict));

function utf8Encode(text) {
  const out = [];
  for (const codeUnit of text) {
    let codePoint = codeUnit.codePointAt(0);
    if (codePoint < 0x80) out.push(codePoint);
    else if (codePoint < 0x800) out.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    else if (codePoint < 0x10000) out.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
    else out.push(0xf0 | (codePoint >> 18), 0x80 | ((codePoint >> 12) & 0x3f), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
  }
  return Uint8Array.from(out);
}
`;

writeFileSync(path.join(spikeRoot, "build/javy-entry.js"), patchedBundle + "\n" + ENTRY);
console.log("wrote build/javy-entry.js");
