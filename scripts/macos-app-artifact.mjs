#!/usr/bin/env node
// Wrap .app before Actions transport: upload-artifact does not preserve executable modes.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function transportApp(mode, source, destination) {
  if (process.platform !== 'darwin') throw new Error('macOS app archive transport requires ditto on macOS');
  if (!existsSync(source)) throw new Error('Missing app transport source');
  if (mode === 'pack') {
    if (path.basename(source) !== 'Oh Agent.app') throw new Error('Unexpected application bundle name');
    if (existsSync(destination)) throw new Error('Refusing to reuse an existing app archive');
    mkdirSync(path.dirname(destination), { recursive: true });
    execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', source, destination]);
  } else if (mode === 'unpack') {
    if (existsSync(path.join(destination, 'Oh Agent.app'))) throw new Error('Refusing to overlay an existing application');
    mkdirSync(destination, { recursive: true });
    execFileSync('ditto', ['-x', '-k', source, destination]);
    if (!existsSync(path.join(destination, 'Oh Agent.app'))) throw new Error('Archive does not contain Oh Agent.app');
  } else throw new Error('Invalid app archive transport mode');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, source, destination] = process.argv.slice(2);
  if (!source || !destination) throw new Error('Usage: macos-app-artifact.mjs pack|unpack SOURCE DESTINATION');
  transportApp(mode, source, destination);
}
