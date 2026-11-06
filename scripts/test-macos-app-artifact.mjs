#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { transportApp } from './macos-app-artifact.mjs';

if (process.platform !== 'darwin') {
  console.log('SKIP macOS ditto transport test: requires macOS');
} else {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oh-agent app archive '));
  try {
    const app = path.join(root, 'source', 'Oh Agent.app');
    const bin = path.join(app, 'Contents', 'Resources', 'bin');
    mkdirSync(bin, { recursive: true });
    const cli = path.join(bin, 'agent-vitals');
    writeFileSync(cli, '#!/bin/sh\nprintf transport-ok'); chmodSync(cli, 0o755);
    writeFileSync(path.join(app, 'Contents', '.hidden-resource'), 'hidden');
    symlinkSync('agent-vitals', path.join(bin, 'cli-link'));
    const archive = path.join(root, 'artifact', 'Oh Agent.app.zip');
    transportApp('pack', app, archive);
    assert.throws(() => transportApp('pack', app, archive), /existing app archive/);
    chmodSync(archive, 0o644); // Equivalent outer file-mode loss during Actions transport.
    const dest = path.join(root, 'downloaded');
    transportApp('unpack', archive, dest);
    const restored = path.join(dest, 'Oh Agent.app', 'Contents');
    const executable = path.join(restored, 'Resources', 'bin', 'agent-vitals');
    assert.ok(statSync(executable).mode & 0o100);
    assert.equal(execFileSync(executable, [], { encoding: 'utf8' }), 'transport-ok');
    assert.equal(readlinkSync(path.join(restored, 'Resources', 'bin', 'cli-link')), 'agent-vitals');
    assert.equal(readFileSync(path.join(restored, '.hidden-resource'), 'utf8'), 'hidden');
    assert.ok(existsSync(archive));
    assert.throws(() => transportApp('unpack', archive, dest), /existing application/);
    console.log('macOS app transport: executable, symlink, hidden resource and non-overlay round trip passed');
  } finally { rmSync(root, { recursive: true, force: true }); }
}
