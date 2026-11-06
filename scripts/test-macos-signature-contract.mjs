#!/usr/bin/env node
import assert from 'node:assert/strict';
import { signatureContract, matchingDeveloperIdSignatures } from './macos-signature-contract.mjs';
const signed = (team, authority = 'Developer ID Application: Example', flags = '0x10000(runtime)') =>
  signatureContract(`CodeDirectory v=20500 size=100 flags=${flags} hashes=10+7\nAuthority=${authority}\nTeamIdentifier=${team}\n`);
const app = signed('TESTTEAM');
assert.ok(matchingDeveloperIdSignatures(app, signed('TESTTEAM')));
assert.equal(matchingDeveloperIdSignatures(app, signatureContract('Signature=adhoc\nTeamIdentifier=not set\n')), false);
assert.equal(matchingDeveloperIdSignatures(app, signed('OTHERTEAM')), false);
assert.equal(matchingDeveloperIdSignatures(app, signed('TESTTEAM', 'Apple Development: Example')), false);
assert.equal(matchingDeveloperIdSignatures(app, signed('TESTTEAM', 'Developer ID Application: Example', '0x0(none)')), false);
assert.equal(signatureContract('').developerId, false);
console.log('macOS signature contract: Developer ID, hardened runtime and matching app/CLI teams verified');
