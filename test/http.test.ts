import { test } from "node:test";
import assert from "node:assert/strict";

import { buildRequest, send, type Fetch } from "../src/main/http";

const env: Record<string, string> = {
  api_url: "https://api.example.com",
  user: "jane@example.com",
  password: 'p"a\\ss&word=1',
  key: "k-123",
};
const resolve = async (t: string) => t.replace(/\{\{(\w+)\}\}/g, (m, k) => env[k] ?? m);

test("JSON bodies are encoded after variables are filled in, so special characters are escaped", async () => {
  const { url, init } = await buildRequest(
    { url: "{{api_url}}/login", json: { email: "{{user}}", password: "{{password}}", nested: ["{{key}}", 2] } },
    resolve,
  );
  assert.equal(url, "https://api.example.com/login");
  assert.equal(init.method, "POST");
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(init.body as string), { email: env.user, password: env.password, nested: ["k-123", 2] });
});

test("form bodies are URL-encoded after variables are filled in", async () => {
  const { init } = await buildRequest({ url: "{{api_url}}/token", form: { grant_type: "password", password: "{{password}}" } }, resolve);
  assert.equal(init.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(new URLSearchParams(init.body as string).get("password"), env.password);
});

test("query parameters and headers (object or list form)", async () => {
  const a = await buildRequest({ url: "{{api_url}}/x?a=1", query: { key: "{{key}}" }, headers: { "X-Key": "{{key}}" } }, resolve);
  assert.equal(a.url, "https://api.example.com/x?a=1&key=k-123");
  assert.equal(a.init.method, "GET");
  assert.equal(a.init.headers["X-Key"], "k-123");

  const b = await buildRequest(
    { url: "{{api_url}}", headers: [{ key: "A", value: "1" }, { key: "B", value: "2", enabled: false }] },
    resolve,
  );
  assert.deepEqual(b.init.headers, { A: "1" });
});

test("explicit Content-Type is kept", async () => {
  const { init } = await buildRequest({ url: "{{api_url}}", body: "<x/>", contentType: "application/xml", headers: { "content-type": "text/xml" } }, resolve);
  assert.deepEqual(init.headers, { "content-type": "text/xml" });
});

test("a missing url is reported", async () => {
  await assert.rejects(buildRequest({ url: "" }, resolve), /url` is required/);
});

const respond = (status: number, body: string): Fetch => async () =>
  new Response(body, { status, headers: { "Content-Type": "application/json", "X-Trace": "t1" } });

test("send parses JSON and lower-cases header names", async () => {
  const res = await send({ url: "{{api_url}}" }, resolve, respond(200, '{"token":"abc"}'));
  assert.equal(res.ok, true);
  assert.deepEqual(res.json, { token: "abc" });
  assert.equal(res.headers["x-trace"], "t1");
});

test("non-2xx throws with status and body, unless throwOnError is false", async () => {
  await assert.rejects(send({ url: "{{api_url}}/login", method: "post" }, resolve, respond(401, '{"error":"bad"}')), (e: Error) => {
    assert.match(e.message, /^POST \{\{api_url\}\}\/login → HTTP 401: \{"error":"bad"\}$/);
    assert.ok(!e.message.includes("api.example.com"), "messages show the URL as written");
    return true;
  });
  const res = await send({ url: "{{api_url}}", throwOnError: false }, resolve, respond(500, "oops"));
  assert.equal(res.status, 500);
  assert.equal(res.json, undefined);
});

test("timeouts are reported", async () => {
  // AbortSignal.timeout's timer doesn't keep Node alive, so hold the loop open meanwhile.
  const hang: Fetch = (_url, init) =>
    new Promise((_, reject) => {
      const keepAlive = setTimeout(() => {}, 5_000);
      init.signal!.addEventListener("abort", () => {
        clearTimeout(keepAlive);
        reject(init.signal!.reason);
      });
    });
  await assert.rejects(send({ url: "{{api_url}}", timeoutMs: 20 }, resolve, hang), /timed out after 20 ms/);
});
