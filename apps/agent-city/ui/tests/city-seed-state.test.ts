import { test } from "node:test";
import assert from "node:assert/strict";
import type { CitySeedStatePort } from "../src/data/seed.ts";

const fakeWindow = {
  parent: null as unknown,
  addEventListener() {},
  removeEventListener() {},
  setTimeout,
  clearTimeout,
};
fakeWindow.parent = fakeWindow;
Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });
Object.defineProperty(globalThis, "location", { configurable: true, value: { href: "http://localhost/", search: "" } });
const { readCitySeedState, writeCitySeedState } = await import("../src/data/seed.ts");

function portWithState() {
  let state: { value: unknown; revision: number } = { value: null, revision: 0 };
  const calls: string[] = [];
  const port: CitySeedStatePort = {
    async readState() { calls.push("state.read"); return structuredClone(state); },
    async writeState(revision, value) {
      calls.push(`state.write:${revision}:${value.seed}`);
      if (state.revision !== revision) throw new Error("revision_conflict");
      state = { value: structuredClone(value), revision: revision + 1 };
      return state.revision;
    },
  };
  return { port, calls, getState: () => structuredClone(state), setState: (next: typeof state) => { state = structuredClone(next); } };
}

test("generic seed state is the only read source", async () => {
  const fixture = portWithState();
  assert.equal(await readCitySeedState(fixture.port), null);
  fixture.setState({ value: { schemaVersion: 1, seed: 77 }, revision: 3 });
  assert.equal(await readCitySeedState(fixture.port), 77);
  assert.deepEqual(fixture.calls, ["state.read", "state.read"]);
});

test("unknown future seed schemas cannot be overwritten", async () => {
  const fixture = portWithState();
  const future = { schemaVersion: 2, seed: 88, extra: "new-format" };
  fixture.setState({ value: future, revision: 4 });
  await assert.rejects(writeCitySeedState(fixture.port, 999), /unsupported_schema_version/);
  assert.deepEqual(fixture.getState(), { value: future, revision: 4 });
  assert.deepEqual(fixture.calls, ["state.read"]);
});

test("a selected seed writes directly through generic state CAS", async () => {
  const fixture = portWithState();
  assert.equal(await writeCitySeedState(fixture.port, 999), 999);
  assert.deepEqual(fixture.getState(), { value: { schemaVersion: 1, seed: 999 }, revision: 1 });
  assert.deepEqual(fixture.calls, ["state.read", "state.write:0:999"]);
});

test("generic state CAS conflict retries using the latest revision", async () => {
  const fixture = portWithState();
  const writeState = fixture.port.writeState;
  let first = true;
  fixture.port.writeState = async (revision, value) => {
    if (first) {
      first = false;
      fixture.setState({ value: { schemaVersion: 1, seed: 456 }, revision: 1 });
      throw new Error("revision_conflict");
    }
    return writeState(revision, value);
  };
  assert.equal(await writeCitySeedState(fixture.port, 999), 999);
  assert.deepEqual(fixture.getState(), { value: { schemaVersion: 1, seed: 999 }, revision: 2 });
});
