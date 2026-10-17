import { test } from "node:test";
import assert from "node:assert/strict";

import { fileInFolder, parseConfig, pickService, urlStartsWith } from "../src/config";

const yaml = (text: string) => JSON.parse(text); // tests write JSON, which is valid YAML

test("parses services with defaults", () => {
  const rules = parseConfig(
    JSON.stringify({
      services: [
        { name: "billing", match: "{{billing_url}}", script: "./.voiden-auth/billing.js" },
        { name: "legacy", folder: "Legacy\\Old/", script: ".voiden-auth/basic.js", header: "X-Auth", enabled: false },
      ],
    }),
    yaml,
  );
  assert.deepEqual(rules, [
    { name: "billing", match: "{{billing_url}}", folder: "", script: ".voiden-auth/billing.js", header: "Authorization", enabled: true },
    { name: "legacy", match: "", folder: "Legacy/Old", script: ".voiden-auth/basic.js", header: "X-Auth", enabled: false },
  ]);
});

test("accepts a bare list and an empty file", () => {
  assert.equal(parseConfig(JSON.stringify([{ name: "a", match: "x", script: "a.js" }]), yaml).length, 1);
  assert.deepEqual(parseConfig("  \n", yaml), []);
});

test("rejects rules that can't work", () => {
  assert.throws(() => parseConfig(JSON.stringify({ services: {} }), yaml), /must be a list/);
  assert.throws(() => parseConfig(JSON.stringify([{ name: "a", match: "x" }]), yaml), /"a" has no script/);
  assert.throws(() => parseConfig(JSON.stringify([{ name: "a", script: "a.js" }]), yaml), /needs a match or a folder/);
});

test("urlStartsWith matches path, query and fragment boundaries only", () => {
  assert.ok(urlStartsWith("https://api.example.com/v1/users", "https://api.example.com"));
  assert.ok(urlStartsWith("https://API.example.com", "https://api.example.com/"));
  assert.ok(urlStartsWith("https://api.example.com?x=1", "https://api.example.com"));
  assert.ok(urlStartsWith("localhost:8080/health", "http://localhost:8080"), "missing scheme defaults to http");
  assert.ok(!urlStartsWith("https://api.example.com.evil.io/x", "https://api.example.com"));
  assert.ok(!urlStartsWith("https://api.example.community/x", "https://api.example.com"));
});

test("fileInFolder", () => {
  assert.ok(fileInFolder("Legacy/Old/a.void", "legacy/old"));
  assert.ok(!fileInFolder("Legacy/Older/a.void", "Legacy/Old"));
  assert.ok(!fileInFolder("a.void", "Legacy"));
});

test("pickService: first match wins; folder and URL must both match when both set", async () => {
  const rules = parseConfig(
    JSON.stringify([
      { name: "admin", folder: "admin", match: "{{api_url}}", script: "a.js" },
      { name: "api", match: "{{api_url}}", script: "b.js" },
      { name: "off", match: "{{api_url}}", script: "c.js", enabled: false },
      { name: "staging-only", match: "{{staging_url}}", script: "d.js" },
    ]),
    yaml,
  );
  const env: Record<string, string> = { api_url: "https://api.example.com" };
  const resolve = async (t: string) => t.replace(/\{\{(\w+)\}\}/g, (m, k) => env[k] ?? m);
  const pick = async (url: string, file: string) => (await pickService(rules, { url, file }, resolve))?.name ?? null;

  assert.equal(await pick("https://api.example.com/users", "admin/Delete.void"), "admin");
  assert.equal(await pick("https://api.example.com/users", "users/List.void"), "api");
  assert.equal(await pick("https://other.example.com/x", "admin/Delete.void"), null);
  assert.equal(await pick("https://staging.example.com/x", "x.void"), null, "unset variables never match");
});
