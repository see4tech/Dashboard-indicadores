// tests/helpers/setup.js
require("fake-indexeddb/auto");

let nextNow = Date.now();
function setNow(ts) { nextNow = ts; }
function now() { return nextNow; }
function advanceMs(ms) { nextNow += ms; }

let fetchMock = null;
let fetchCalls = [];
function setFetchMock(fn) { fetchMock = fn; fetchCalls = []; }
function getFetchCalls() { return fetchCalls; }

globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url: String(url), init });
  if (!fetchMock) throw new Error("fetch mock not configured");
  return fetchMock(String(url), init);
};

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => k.toLowerCase() === "content-type" ? "application/json" : null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function emptyResponse(status = 204) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => null,
    text: async () => "",
  };
}

async function resetIDB() {
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase("sb-dashboard-cache");
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

module.exports = {
  setNow, now, advanceMs,
  setFetchMock, getFetchCalls,
  jsonResponse, emptyResponse,
  resetIDB,
};
