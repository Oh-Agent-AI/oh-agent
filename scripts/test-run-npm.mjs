#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runNpm } from './run-npm.mjs';

const dir = mkdtempSync(path.join(tmpdir(), 'agent vitals npm '));
const platform = Object.getOwnPropertyDescriptor(process, 'platform');
const previous = process.env.npm_execpath;
try {
  const cli = path.join(dir, 'npm-cli.js');
  writeFileSync(cli, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
  process.env.npm_execpath = cli;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  const args = ['--prefix', 'directory with spaces', 'run', 'build', '--', 'a&b', '$literal'];
  assert.deepEqual(JSON.parse(runNpm(args, { encoding: 'utf8' })), args);
  console.log('Windows npm invocation: arguments and paths with spaces preserved');
} finally {
  Object.defineProperty(process, 'platform', platform);
  if (previous === undefined) delete process.env.npm_execpath;
  else process.env.npm_execpath = previous;
  rmSync(dir, { recursive: true, force: true });
}
