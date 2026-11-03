import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import net from "node:net";
import path from "node:path";

import { describeNetworkError, send } from "../src/main/http";
import { isExcluded, proxyUrl, readNetworkSettings, voidenFetch } from "../src/main/network";
import { tempDir } from "./helpers";

const fixtures = path.join(process.cwd(), "test/fixtures");
const listen = (server: Server) =>
  new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port)));
const close = (server: Server) => new Promise((resolve) => server.close(resolve));
const userDataWith = (settings: object) => {
  const dir = tempDir("auto-auth-settings-");
  writeFileSync(path.join(dir, "settings.json"), JSON.stringify(settings));
  return dir;
};
const noVars = async (t: string) => t;

test("reads TLS and proxy settings the way Voiden stores them", () => {
  assert.deepEqual(readNetworkSettings(tempDir("auto-auth-empty-")), { disableTls: false, proxy: undefined });
  const dir = userDataWith({
    requests: { disable_tls_verification: true },
    proxy: { enabled: true, activeProxyId: "b", proxies: [{ id: "a", host: "x", port: 1 }, { id: "b", host: "proxy.corp", port: 3128 }] },
  });
  const s = readNetworkSettings(dir);
  assert.equal(s.disableTls, true);
  assert.equal(s.proxy?.host, "proxy.corp");
  assert.equal(readNetworkSettings(userDataWith({ proxy: { enabled: false, activeProxyId: "b", proxies: [{ id: "b", host: "p", port: 1 }] } })).proxy, undefined);
});

test("proxy URL and excluded domains match Voiden's rules", () => {
  assert.equal(proxyUrl({ host: "p", port: 8080 }), "http://p:8080");
  assert.equal(proxyUrl({ host: "p", port: 8080, auth: true, username: "me@x", password: "p:w" }), "http://me%40x:p%3Aw@p:8080");
  assert.ok(isExcluded("api.internal", ["*.internal"]));
  assert.ok(isExcluded("internal", ["*.internal"]));
  assert.ok(isExcluded("host.example.com", ["host.example.com"]));
  assert.ok(!isExcluded("other.example.com", ["host.example.com"]));
});

test("an untrusted certificate fails with an explanation, and works once TLS verification is disabled", async () => {
  const server = createHttpsServer(
    { key: readFileSync(path.join(fixtures, "self-signed.key")), cert: readFileSync(path.join(fixtures, "self-signed.crt")) },
    (_req, res) => res.end(JSON.stringify({ access_token: "t" })),
  );
  const port = await listen(server);
  try {
    await assert.rejects(
      send({ url: `https://localhost:${port}/token` }, noVars, voidenFetch(userDataWith({}))),
      /SELF_SIGNED_CERT|DEPTH_ZERO_SELF_SIGNED_CERT.*Disable TLS verification/s,
    );
    const res = await send(
      { url: `https://localhost:${port}/token` },
      noVars,
      voidenFetch(userDataWith({ requests: { disable_tls_verification: true } })),
    );
    assert.deepEqual(res.json, { access_token: "t" });
  } finally {
    await close(server);
  }
});

test("requests go through Voiden's proxy, except for excluded domains", async () => {
  const target = createHttpServer((_req, res) => res.end('{"ok":true}'));
  const targetPort = await listen(target);
  const tunnels: string[] = [];
  const proxy = createHttpServer();
  proxy.on("connect", (req, socket) => {
    tunnels.push(req.url ?? "");
    const [host, port] = (req.url ?? "").split(":");
    const upstream = net.connect(Number(port), host, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.pipe(socket).pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
  });
  const proxyPort = await listen(proxy);
  const settings = (excludedDomains: string[] = []) =>
    userDataWith({ proxy: { enabled: true, activeProxyId: "p", proxies: [{ id: "p", host: "127.0.0.1", port: proxyPort, excludedDomains }] } });
  try {
    await send({ url: `http://127.0.0.1:${targetPort}/` }, noVars, voidenFetch(settings()));
    assert.deepEqual(tunnels, [`127.0.0.1:${targetPort}`]);
    await send({ url: `http://127.0.0.1:${targetPort}/` }, noVars, voidenFetch(settings(["127.0.0.1"])));
    assert.equal(tunnels.length, 1, "excluded host goes direct");
  } finally {
    await close(target);
    await close(proxy);
  }
});

test("network errors show the underlying cause instead of 'fetch failed'", () => {
  const nested = (code: string, message: string) =>
    Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(message), { code }) });
  assert.match(describeNetworkError(nested("ENOTFOUND", "getaddrinfo ENOTFOUND sso.example.com"), 1), /^getaddrinfo ENOTFOUND sso\.example\.com — check the host name/);
  assert.match(
    describeNetworkError(nested("UNABLE_TO_VERIFY_LEAF_SIGNATURE", "unable to verify the first certificate"), 1),
    /^UNABLE_TO_VERIFY_LEAF_SIGNATURE: unable to verify the first certificate — .*intermediate certificate/,
  );
  assert.match(describeNetworkError(nested("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:1"), 1), /can't be reached/);
  assert.equal(describeNetworkError(Object.assign(new Error("x"), { name: "TimeoutError" }), 50), "timed out after 50 ms");
});
