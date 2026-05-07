const { test } = require("node:test");
const assert = require("node:assert/strict");
const { jsonResponse, setFetchMock, getFetchCalls } = require("./helpers/setup");

test("test runner works", () => {
  assert.equal(1 + 1, 2);
});

test("fetch mock works", async () => {
  setFetchMock(async () => jsonResponse({ ok: true }));
  const r = await fetch("/x");
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(getFetchCalls().length, 1);
});

test("indexedDB available", () => {
  assert.ok(typeof indexedDB !== "undefined");
});
