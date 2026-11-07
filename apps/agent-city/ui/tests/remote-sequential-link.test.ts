import test from "node:test";
import assert from "node:assert/strict";
import { parseSequentialLink } from "../src/remote/sequentialLink.ts";

const base = "https://relay.example/v1/rooms/r1?capability=mecha%3Av4&match=m1&ws=wss%3A%2F%2Frelay.example%2Fws&access=https%3A%2F%2Frelay.example%2Faccess&device=d1#token-1";

test("v1.5 links expose only the v4 handoff fields", () => {
  assert.deepEqual(parseSequentialLink(base), { ws: "wss://relay.example/ws", matchId: "m1", access: "https://relay.example/access", device: "d1", token: "token-1" });
});

test("legacy, ambiguous and incomplete links fail closed", () => {
  for (const link of [
    base.replace("mecha%3Av4", "mecha%3Av3"),
    base.replace("capability=mecha%3Av4&", ""),
    base.replace("#token-1", ""),
    base.replace("ws=wss%3A%2F%2Frelay.example%2Fws&", ""),
    "not a url",
  ]) assert.equal(parseSequentialLink(link), null, link);
});
