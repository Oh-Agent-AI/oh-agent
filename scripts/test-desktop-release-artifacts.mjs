#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { artifactName, stageArtifacts } from './desktop-release-artifacts.mjs';

const dir = mkdtempSync(path.join(tmpdir(), 'oh agent artifacts '));
try {
  assert.equal(artifactName('1.0.0-beta.3', 'macos', 'x86_64', 'app.zip'), 'oh-agent-1.0.0-beta.3-x86_64.app.zip');
  assert.equal(artifactName('1.0.0', 'windows', 'x64', 'exe'), 'oh-agent-1.0.0-windows-x86_64-setup.exe');
  assert.equal(artifactName('1.0.0', 'macos', 'arm64', 'dmg'), 'oh-agent-1.0.0-arm64.dmg');
  assert.throws(() => artifactName('../bad', 'linux', 'x64', 'deb'));
  assert.throws(() => artifactName('1.0.0', 'windows', 'x64', 'dmg'));
  const source = path.join(dir, 'raw packages');
  const destination = path.join(dir, 'public packages');
  mkdirSync(source);
  mkdirSync(destination);
  writeFileSync(path.join(source, 'Oh Agent_1.0.0_amd64.deb'), 'deb contents');
  assert.throws(() => stageArtifacts('1.0.0', 'linux', 'x64', source, destination), /exactly one AppImage/);
  assert.deepEqual(readdirSync(destination), []);
  writeFileSync(path.join(source, 'Oh Agent_1.0.0_amd64.AppImage'), 'AppImage contents');
  stageArtifacts('1.0.0', 'linux', 'x64', source, destination);
  assert.equal(readFileSync(path.join(destination, 'oh-agent-1.0.0-linux-x86_64.deb'), 'utf8'), 'deb contents');
  assert.equal(readFileSync(path.join(destination, 'oh-agent-1.0.0-linux-x86_64.AppImage'), 'utf8'), 'AppImage contents');
  writeFileSync(path.join(source, 'stale.deb'), 'stale');
  assert.throws(() => stageArtifacts('1.0.0', 'linux', 'x64', source, destination), /exactly one deb/);
  console.log('Branded release artifacts: naming, spaced paths, missing/duplicate packages OK');
} finally { rmSync(dir, { recursive: true, force: true }); }
