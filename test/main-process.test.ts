import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import createAutoAuthMain, { askWithDialog } from "../src/main-process";
import type { Answer } from "../src/main/trust";
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
  let answer: Answer = "allow";
  const trust = fakeTrust(tempDir("auto-auth-main-trust-"), () => answer);

  const plugin = createAutoAuthMain(context, { userDataDir: tempDir("auto-auth-main-userdata-"), trust: trust.deps });
  await plugin.onload();
  assert.deepEqual([...handlers.keys()].sort(), [CHANNELS.forgetTrust, CHANNELS.run].sort());

  const run = () =>
    handlers.get(CHANNELS.run)!(event, {
      service: "keyed",
      header: "Authorization",
      scriptPath: path.join(project, "auth/key.js"),
      request: { url: "https://x" },
    }) as Promise<{ headers?: object; review?: string }>;

  assert.deepEqual((await run()).headers, { "X-Api-Key": "k-1" });
  await run();
  assert.equal(trust.asked.length, 1);

  await handlers.get(CHANNELS.forgetTrust)!(event);
  await run();
  assert.equal(trust.asked.length, 2, "asked again after forgetting");

  // "Open script" in the dialog: nothing runs, the renderer is told what to open.
  await handlers.get(CHANNELS.forgetTrust)!(event);
  answer = "open";
  assert.deepEqual(await run(), { review: "auth/key.js" });
  answer = "deny";
  await assert.rejects(run(), /running auth\/key\.js was not allowed/);

  await assert.rejects(Promise.resolve(handlers.get(CHANNELS.run)!({}, {})), /no project is open/);

  await plugin.onunload();
  assert.equal(handlers.size, 0);
});

test("the dialog offers Allow, Open script and Cancel; anything else declines", async () => {
  const shown: { buttons: string[]; defaultId: number; cancelId: number; message: string; detail: string }[] = [];
  let response = 0;
  const ask = askWithDialog({
    dialog: {
      showMessageBox: async (_window, options) => {
        shown.push(options);
        return { response };
      },
    },
  });

  assert.equal(await ask("Run it?", "details"), "allow");
  assert.deepEqual(shown[0].buttons, ["Allow", "Open script", "Cancel"]);
  assert.equal(shown[0].buttons[shown[0].defaultId], "Cancel", "Enter doesn't allow");
  assert.equal(shown[0].buttons[shown[0].cancelId], "Cancel", "closing the dialog declines");
  assert.deepEqual([shown[0].message, shown[0].detail], ["Run it?", "details"]);

  response = 1;
  assert.equal(await ask("", ""), "open");
  for (response of [2, 3, -1]) assert.equal(await ask("", ""), "deny");
  assert.equal(await askWithDialog({})("", ""), "deny", "no dialog available");
});
