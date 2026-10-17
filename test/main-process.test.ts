import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import createAutoAuthMain from "../src/main-process";
import { CHANNELS } from "../src/shared/protocol";
import type { MainProcessContext } from "../src/voiden";
import { fakeTrust, tempDir } from "./helpers";

test("registers the IPC handlers; scripts run in the active project after approval", async () => {
  const project = tempDir("auto-auth-main-");
  mkdirSync(path.join(project, "auth"));
  writeFileSync(path.join(project, "auth/key.js"), `return { headers: { "X-Api-Key": await auth.env("key") } };`);

  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const event = { sender: "renderer" };
  const context = {
    ipc: {
      handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
      removeHandler: (channel: string) => handlers.delete(channel),
    },
    env: { replaceVariables: async (t: string, e: unknown) => (e === event ? t.replace("{{key}}", "k-1") : t) },
    project: { getActive: async (e: unknown) => (e === event ? project : undefined) },
  } as unknown as MainProcessContext;
  const trust = fakeTrust(tempDir("auto-auth-main-trust-"));

  const plugin = createAutoAuthMain(context, { fetch: async () => new Response(""), trust: trust.deps });
  await plugin.onload();
  assert.deepEqual([...handlers.keys()].sort(), [CHANNELS.forgetTrust, CHANNELS.run].sort());

  const run = () =>
    handlers.get(CHANNELS.run)!(event, {
      service: "keyed",
      header: "Authorization",
      scriptPath: path.join(project, "auth/key.js"),
      request: { url: "https://x" },
    }) as Promise<{ headers: object }>;

  assert.deepEqual((await run()).headers, { "X-Api-Key": "k-1" });
  await run();
  assert.equal(trust.asked.length, 1);

  await handlers.get(CHANNELS.forgetTrust)!(event);
  await run();
  assert.equal(trust.asked.length, 2, "asked again after forgetting");

  await assert.rejects(Promise.resolve(handlers.get(CHANNELS.run)!({}, {})), /no project is open/);

  await plugin.onunload();
  assert.equal(handlers.size, 0);
});
