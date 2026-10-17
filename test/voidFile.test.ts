import { test } from "node:test";
import assert from "node:assert/strict";

import { parseRequestUrl } from "../src/voidFile";

const block = (yaml: string) => "```void\n---\n" + yaml + "\n---\n```\n";

test("reads REST, GraphQL and WebSocket URLs", () => {
  assert.equal(
    parseRequestUrl(block("type: request\ncontent:\n  - type: method\n    content: GET\n  - type: url\n    attrs:\n      uid: u1\n    content: {{api_url}}/users")),
    "{{api_url}}/users",
  );
  assert.equal(parseRequestUrl(block('type: gqlquery\ncontent:\n  - type: gqlurl\n    content: "{{graphql_url}}"')), "{{graphql_url}}");
  assert.equal(parseRequestUrl(block("type: socket-request\ncontent:\n  - type: surl\n    content: 'wss://echo/ws'")), "wss://echo/ws");
});

test("files without a URL", () => {
  assert.equal(parseRequestUrl("# Notes\nJust text."), null);
  assert.equal(parseRequestUrl(block("type: request\ncontent:\n  - type: url\n    content: ''")), null);
});
