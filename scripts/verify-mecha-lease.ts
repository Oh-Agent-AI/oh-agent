import assert from "node:assert/strict";
import { test } from "node:test";
import { ModeLeaseBook } from "../apps/agent-city/ui/src/engine/modeLease.ts";

test("only one lease can be active at a time", () => {
  const book = new ModeLeaseBook();
  const first = book.acquire();
  assert.ok(first);
  assert.equal(book.busy, true);
  assert.equal(book.acquire(), null);
  assert.equal(book.isCurrent(first!), true);
  assert.equal(book.release(first!), true);
  assert.equal(book.busy, false);
});

test("release is idempotent", () => {
  const book = new ModeLeaseBook();
  const lease = book.acquire()!;
  assert.equal(book.release(lease), true);
  assert.equal(book.release(lease), false, "a second release must not report success");
  assert.equal(book.busy, false);
});

test("a stale token cannot release the lease that replaced it", () => {
  const book = new ModeLeaseBook();
  const first = book.acquire()!;
  assert.equal(book.release(first), true);
  const second = book.acquire()!;
  assert.notEqual(second.id, first.id, "ids must not be reused");
  assert.equal(book.isCurrent(first), false);
  assert.equal(book.release(first), false, "the old lease must not clear the new one");
  assert.equal(book.isCurrent(second), true);
  assert.equal(book.busy, true);
  assert.equal(book.release(second), true);
});

test("ids increase across repeated handovers", () => {
  const book = new ModeLeaseBook();
  const ids: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const lease = book.acquire()!;
    ids.push(lease.id);
    assert.equal(book.release(lease), true);
  }
  for (let i = 1; i < ids.length; i += 1) assert.ok(ids[i]! > ids[i - 1]!);
});
