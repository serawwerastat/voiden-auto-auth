# Auto Auth

Automatic authentication for [Voiden](https://voiden.md) requests. You write a small auth script per API (log in, fetch a token, sign a request), and Auto Auth handles the rest:
- runs the script when a request needs it
- adds the headers it returns
- caches them per environment until they expire
- logs in again when the server rejects the token

```yaml
# .voiden-auth/auth.yaml
services:
  - name: my-api
    match: "{{api_url}}"
    script: .voiden-auth/my-api.js
```

```js
// .voiden-auth/my-api.js — runs in Node.js
const res = await auth.send({
  method: "POST",
  url: "{{api_url}}/auth/login",
  json: { username: "{{api_user}}", password: "{{api_password}}" },
});
return { bearer: res.json.token };
```

Every request to `{{api_url}}` now gets `Authorization: Bearer …`, in every environment, with no per-request setup.

## Why this exists

### The problem

Most APIs worth testing need a token. You get it by logging in, it expires, and each environment (dev, staging, prod) has its own. In Postman this is a few lines in a collection-level pre-request script, and every request inherits it.

Voiden doesn't have collection- or folder-level scripts. Before Auto Auth, the options were:

| Approach | What goes wrong |
|---|---|
| Paste the login script into every request's pre-request script | The same code is copied into every request. Changing the login flow means editing them all. |
| A "Login" request that saves the token to a runtime variable, used by the other requests | You have to run Login yourself every time the token expires, and again after switching environments. Requests also fail with "unresolved variable" until you've logged in once. |
| A pre-request script that loads a shared `auth.js` file | It works, but every request still needs the loader stub, and each request logs in again unless you also write caching. |

### Why not `.voiden-inherited`?

[`.voiden-inherited`](https://docs.voiden.md/docs/core-features-section/variables/hierarchical-inheritance) files let a folder share headers, auth and variables with every request inside it. That's the right tool for **static** values:
- an API key that never changes
- a `Bearer {{token}}` header where you manage the token yourself
- common headers like `Accept`

What it shares is configuration, not code. In our testing with Voiden 2.3.2, a pre-request script placed in a `.voiden-inherited` file was not run for the requests below it. So it can say *which* header to send, but it can't log in, notice that a token has expired, or fetch a new one.

Auto Auth fills that gap. The two work together:

| | `.voiden-inherited` | Auto Auth |
|---|---|---|
| Static headers, API keys | ✅ | possible, not needed |
| Logging in to get a token | — | ✅ runs your script |
| Knowing when a token expires | — | ✅ from the JWT or `expiresIn` |
| Logging in again after 401/403 | — | ✅ |
| One token per environment | — | ✅ cached per environment |
| Several APIs with different auth | per folder | ✅ per URL and/or folder |
| Full Node.js (crypto, packages, files) | — | ✅ |

If a request already has the header, whether set in the request itself or inherited, Auto Auth leaves it alone.

### What about Advanced Authentication?

Voiden's **Advanced Authentication** plugin covers standard schemes: Bearer, Basic, API key, OAuth 1.0/2.0, Digest, AWS Signature and more. If your API uses one of those as-is, use it. Auto Auth is for the cases they don't fit:
- custom login endpoints, for example email and password returning a JWT in a custom field
- multi-step or signed flows
- applying the result to every matching request automatically, with caching and re-login

## Getting started

1. Install Auto Auth (see [Install](#install)). If the key icon doesn't appear in the status bar, restart Voiden.
2. Open the command palette and run **Auto Auth: Create example config**. It creates `.voiden-auth/auth.yaml` and `.voiden-auth/my-api.js`, with comments explaining every option.
3. Change the example to match your API: the URL variable in `auth.yaml`, and the login call and the response field holding the token in the script.
4. Make sure the variables the script uses (`api_url`, `api_user`, `api_password` in the example) exist in your environments. Keep passwords in the **private** environment file.
5. Send a request. Voiden shows you the start of the script and asks you to allow it (see [Security](#security)), then a toast confirms the login, and the status bar shows `my-api` with how long the token lasts.

The `.voiden-auth/` folder belongs in Git, so your team shares the same setup, while each person keeps their own credentials in their private environment. It sits outside `.voiden/` on purpose: Voiden keeps `.voiden/` out of Git.

## The config file

`.voiden-auth/auth.yaml` lists which script authorizes which requests. Rules are checked from top to bottom, and the first match wins.

```yaml
services:
  - name: admin              # shown in the status bar
    folder: Admin            # requests whose .void file is in this folder…
    match: "{{api_url}}"     # …and whose URL starts with this
    script: .voiden-auth/admin.js

  - name: my-api
    match: "{{api_url}}"
    script: .voiden-auth/my-api.js

  - name: billing
    match: "https://billing.example.com"
    script: .voiden-auth/billing/login.js
    header: X-Billing-Auth   # header for bearer/token results (default: Authorization)

  - name: old-service
    folder: Legacy
    script: .voiden-auth/basic.js
    enabled: false           # switched off
```

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Label for the status bar and messages. Also identifies the cached token. |
| `match` | one of these two | The request URL must start with this. `{{variables}}` are filled in from the active environment. A rule whose variable isn't set in the current environment doesn't match. |
| `folder` | one of these two | The request's `.void` file must be in this folder (relative to the project root). |
| `script` | yes | Path of the auth script, relative to the project root. It must be in a folder (`.voiden-auth/` is a good one), not directly in the project root, because allowing a script covers its whole folder. |
| `header` | no | Header used for `bearer` and `token` results. Default `Authorization`. |
| `enabled` | no | `false` to switch the rule off. |

URLs match on boundaries: `https://api.example.com` matches `https://api.example.com/users`, but not `https://api.example.com.evil.io`.

Requests that match no rule are sent unchanged. The config file's location can be changed in the settings.

## Auth scripts

A script is the body of an async function running in **Node.js**, in a worker thread of its own inside Voiden. It can use `await` and `require(...)` freely: helper files, your project's `node_modules`, and Node's built-in modules. Each run starts fresh, so edits to a script or its helpers apply on the next login, without a restart.

### What a script returns

| Return | Result |
|---|---|
| `{ bearer: token }` | `Authorization: Bearer <token>` |
| `{ token: value }` | `Authorization: <value>`, e.g. for `Basic …` |
| `{ headers: { … } }` | any headers, alone or together with the above |
| `"token"` | same as `{ bearer: "token" }` |

You can also add:
- `expiresIn` (seconds) or `expiresAt` (epoch ms or ISO date): when to log in again. Not needed for JWTs, whose `exp` is read automatically. Otherwise the default is 10 minutes.
- `cache: false`: run the script before every request, for example for signatures that include a timestamp.

Cached results are refreshed a minute before they expire. Tokens that live less than two minutes are refreshed halfway through their life.

### What a script can use

| | |
|---|---|
| `await auth.send(options)` | HTTP request. Returns `{ status, ok, headers, text, json }`. Throws on a non-2xx response, with the status and the start of the body, unless `throwOnError: false`. |
| `await auth.env("name")` | An environment variable's value, or `undefined` if it isn't set. |
| `await auth.resolve("text {{var}}")` | Fills in `{{variables}}` in any text. |
| `auth.base64(text)` | Base64 encoding, for Basic auth. |
| `auth.jwtExpiry(token)` | A JWT's expiry in epoch ms, or `null`. |
| `auth.request` | `{ url, method, file }` of the request being authorized. |
| `auth.service` | The rule's `name`. |
| `auth.log(...)` | Writes a line to Voiden's developer console (Ctrl+Shift+I / Cmd+Option+I), prefixed with the service name. When a script fails, its last log lines are also included in the error. (Voiden's Script Logs panel only shows request scripts.) |
| `require`, `__filename`, `__dirname` | Standard Node.js, relative to the script file. Use `require` for your own files and packages. `await import("node:…")` also works for built-in modules. |

`auth.send` options:

| Option | |
|---|---|
| `url` | Required. `{{variables}}` allowed. |
| `method` | Default `GET`, or `POST` when there's a body. |
| `headers` | `{ name: value }` or `[{ key, value, enabled }]`. |
| `query` | `{ name: value }`, appended to the URL. |
| `json` | Body sent as JSON. |
| `form` | Body sent as `application/x-www-form-urlencoded`. |
| `body`, `contentType` | Raw body. |
| `timeoutMs` | Default 30000. |
| `throwOnError` | Default `true`. |

`{{variables}}` anywhere in these options are filled in from the active environment **before** the body is encoded. A password containing `"`, `\` or `&` is therefore escaped correctly in both JSON and form bodies.

`auth.send` follows Voiden's own network settings, like the requests it authorizes:
- **Disable TLS verification** (in Voiden's Settings; search for "TLS")
- **the active proxy**, including its excluded domains

It uses the same HTTP client as Voiden (undici), and it doesn't send an `Origin` header, so servers with CORS checks treat it like any API client. Settings changes apply on the next call; no restart needed.

A script that hasn't finished after 60 seconds is stopped, and the request fails with a message saying so. Because each script has its own thread, this also works for a script that is stuck in a loop, and a script calling `process.exit()` ends only itself, not Voiden. An error nothing catches, including a rejected promise nobody awaits, fails the run.

### Examples

**Email/password login returning a JWT**
```js
const res = await auth.send({
  method: "POST",
  url: "{{api_url}}/auth/signin",
  json: { email: "{{api_user}}", password: "{{api_password}}" },
});
return { bearer: res.json.jwt };
```

**OAuth 2.0 client credentials**
```js
const res = await auth.send({
  method: "POST",
  url: "{{auth_url}}/oauth/token",
  form: {
    grant_type: "client_credentials",
    client_id: "{{client_id}}",
    client_secret: "{{client_secret}}",
  },
});
return { bearer: res.json.access_token, expiresIn: res.json.expires_in };
```

**Basic auth**
```js
const user = await auth.env("api_user");
const password = await auth.env("api_password");
return { token: "Basic " + auth.base64(`${user}:${password}`), cache: false };
```

**API key header**
```js
return { headers: { "X-Api-Key": await auth.env("api_key") }, cache: false };
```

**HMAC request signing**
```js
const crypto = require("node:crypto");
const timestamp = Date.now().toString();
const signature = crypto
  .createHmac("sha256", await auth.env("api_secret"))
  .update(`${auth.request.method} ${auth.request.url} ${timestamp}`)
  .digest("hex");
return { headers: { "X-Timestamp": timestamp, "X-Signature": signature }, cache: false };
```

**Shared helpers or packages**
```js
const { login } = require("./lib/login");  // .voiden-auth/lib/login.js
const jwt = require("jsonwebtoken");       // from the project's node_modules
```

Edited helper files are picked up on the next run, with no restart needed.

## Troubleshooting

**Start with the same request in Voiden itself.** Put the login call in a normal `.void` request and send it. If Voiden can't reach the server, the auth script can't either, and the fix is in Voiden's settings or your network, not the script.

| Error | Meaning |
|---|---|
| `variable(s) not set in the active environment: x` | `{{x}}` isn't defined in the active environment. Check its name, and which environment is selected. |
| `unable to verify the first certificate`, `self-signed certificate`, `unable to get local issuer certificate` | Voiden doesn't trust the server's TLS certificate. This is common with company servers whose certificate chain is incomplete or signed by an internal CA. Either turn on **Disable TLS verification** in Voiden's settings, or keep verification on and give Voiden your company's CA: set the environment variable `NODE_EXTRA_CA_CERTS` to a `.pem` file containing it, then restart Voiden. |
| `ENOTFOUND`, `ECONNREFUSED`, connect timeout | The host can't be reached. Check the URL, your VPN, and Voiden's proxy setting. |
| `HTTP 401` / `400` with `invalid_grant`, `invalid_client` | The server was reached and rejected the login. Check the credentials, `client_id` and `grant_type`. |
| `auth.send: use headers, not header` / `body must be a string` | Options in Postman's `pm.sendRequest` format. Use `headers`, and `form: { key: value }` for form data. |

**Coming from a Postman pre-request script?** Here's what each part becomes:
- `pm.environment.get("x")` becomes `"{{x}}"` (or `await auth.env("x")`)
- `body: { mode: "urlencoded", urlencoded: [...] }` becomes `form: { key: value }`
- `header` becomes `headers`
- instead of saving the token to a variable, `return { bearer: token }`
- `console.log` becomes `auth.log`

## Status bar

A key icon in the bottom-right status bar shows the auth state for **the request open in the editor**:

| Shows | Meaning |
|---|---|
| `my-api · 42m` | This request uses `my-api`; its token is valid for 42 more minutes |
| `my-api · not logged in` | It will log in when you send |
| `my-api · logging in…` | The script is running |
| `my-api · per request` | The script uses `cache: false` |
| `my-api · rejected` | The server answered 401/403; the next send logs in again. Shown in the theme's warning colour |
| `my-api · failed` | The script failed; hover for the reason. Shown in the theme's error colour |
| `config error` | The config file can't be read; hover for the details |
| `—` | No rule applies to this request, or no request is open |

Hover to see every service and its state. Click to clear the token of the service shown. When it shows `—`, a click clears every service's token.

## Commands

| Command | |
|---|---|
| **Auto Auth: Create example config** | Creates `.voiden-auth/auth.yaml` and an example script |
| **Auto Auth: Clear cached tokens** | The next request to each service authorizes again |
| **Auto Auth: Forget allowed scripts** | Asks again before each script runs |

## Settings

Under **Settings → Auto Auth**:
- **Enabled**: switches the plugin off without uninstalling it.
- **Config file**: defaults to `.voiden-auth/auth.yaml`.

## Security

Auth scripts run with full Node.js access: files, network and processes. The project folder they come from may be someone else's repository. Auto Auth therefore treats them like code you're about to run.

### You approve scripts before they run

Before a script runs for the first time, Voiden shows a dialog with the script's path and its first lines:

- **Allow** runs it.
- **Open script** opens it in Voiden's editor and stops the request, so you can read all of it. Send the request again to get back to the dialog.
- **Cancel** stops the request.

An approval is tied to file contents (SHA-256 hashes), and covers:

| | |
|---|---|
| The script and **every file in its folder** | Including subfolders; `node_modules` and `.git` excepted. Compared before every run, whether or not the script uses the file. |
| **Every other file the script loads with `require()`** | Helpers elsewhere in the project (`require("../shared/sign")`), packages in `node_modules` together with their `package.json`, and whatever those load in turn. They join the approval on the script's first run after you allow it. |

After that first run, the script can only load what the approval holds:

- **Before each run**, the covered files are compared with what is on disk. If one has changed, appeared or disappeared, for example after a `git pull` or an `npm install`, you're asked again, and the dialog lists which. Allowing covers those changes and nothing else.
- **During the run, every file is checked at the moment `require()` loads it**, against the same hashes. A file that changed in the meantime, or a file the approval doesn't hold, stops the script before any of that file runs, and you're asked about it by name. This also catches a *different* file being loaded in place of an approved one, such as a package whose entry point was repointed, or a package placed closer to the script.

What an approval does **not** cover:

- **Files the script loads for the first time on a run where that is allowed.** That is the first run after you allow a script, and the run after you allow a file it "wants to load": the dialog names the file the script was stopped at, and whatever else it loads for the first time on that run is accepted with it. You see the start of the script in the dialog, not the helpers and packages it goes on to load. Use **Open script** and read what it requires if the project isn't yours.
- **Files a script uses without `require()`**: read with `fs`, run as a separate process, or loaded in a worker thread the script (or a package) starts itself. Files read with `fs` are still compared before each run if they are in the script's folder (outside `node_modules`, `.git` and linked folders), so keep them there.
- **ES modules on older Voiden versions.** Files an ES module imports, and `import()` of a file, are checked like `require()` where Voiden's Node.js is 22.15 or later, which includes current versions. On older ones only `require()` is checked.

Because an approval covers the script's whole folder, keep auth scripts in a folder of their own, such as `.voiden-auth/`. A script directly in the project root is refused, since its folder would be the whole project. So is a script whose folder holds more than 2,000 files. Other files in the same folder, the config file included, are part of the approval: changing them asks again. A symbolic link in the folder counts as where it points plus the content of the file there; a linked folder isn't walked, but what the script loads from it is checked like any other file.

The check happens in Node.js, in Voiden's main process and the script's own thread. Nothing on the UI side can skip it. Approvals are stored on your machine, outside the project, so everyone who opens a shared project approves its scripts themselves. **Auto Auth: Forget allowed scripts** resets them.

### Scripts are contained where they can be

- **Only scripts inside the project can run.** Symlinks pointing outside the project are refused.
- **Each run has its own worker thread**, which is stopped when the script finishes or after 60 seconds. A script that hangs, crashes or calls `process.exit()` can't freeze or close Voiden.
- This is not a sandbox. An approved script can do anything Node.js can, including undoing these checks for itself. The approval is what protects you; the checks make sure that what runs is what you approved.

### Credentials

- **Credentials stay in environment variables.** Scripts reference them as `{{variables}}`, so secrets can live in Voiden's private environment file, which is excluded from Git. Don't hard-code them in scripts.
- **Error messages show URLs as written** (`{{api_url}}/login`), not with their values filled in. A failed login's error includes up to 200 characters of the server's response.
- Cached headers are kept in Voiden's local storage on your machine, per project, environment and service.

## How it works

```
send request
   │
   ├─ pre-send hook (UI side) ── match a rule in auth.yaml ── no match → send unchanged
   │                                     │
   │                          cached & fresh? ── yes → add headers
   │                                     │ no
   │                          IPC → main process (Node.js)
   │                                ├─ approved? (ask if not, or if a covered file changed)
   │                                ├─ run script in a worker thread → { headers, expiresAt }
   │                                │     every require() is checked against the approval;
   │                                │     an unknown or changed file stops the run → ask → start over
   │                                └─ first run: add the files it loaded to the approval
   │                                     │
   │                          cache per environment → add headers
   ▼
response ── 401/403 → drop the cached token (if it's still the one that was sent)
```

If authorization fails, the request is stopped and the reason is shown, rather than sent without credentials.

## Limitations

- The status bar reads the request's URL from the **saved** file. Sending always uses the live URL.
- Voiden currently gives plugins the request's file only after they run, so `folder` rules go by the request open in the editor. Requests sent from a Stitch run therefore match `folder` rules by the open tab, not their own file. `match` rules are unaffected. Auto Auth already uses the request's own file when Voiden provides it, so this goes away with the Voiden release that does.
- Voiden's request timeout setting isn't used; `auth.send` has its own `timeoutMs` (default 30 s).
- Inside scripts, `{{variables}}` come from the active environment. Folder-level `.env` files, a newer Voiden feature, apply when rules are matched, but not inside scripts.
- Auth is added to requests sent through Voiden's HTTP pipeline. WebSocket and gRPC connections aren't covered yet.
- Scripts run in a worker thread. There, Electron's own APIs (`require("electron")`) and `process.chdir()` aren't available, changes to `process.env` stay inside the script, and native add-ons must support worker threads (most current ones do).
- Stopping a script after 60 seconds stops its thread. A script waiting inside a synchronous system call, such as `execSync`, stops when that call returns, and processes the script started keep running.
- `import()` inside a script doesn't resolve relative to the script, so it's only practical for Node's built-in modules. Use `require()` for files and packages; it also loads ES modules on current Voiden versions.
- A library that loads parts of itself only when needed (for example on an error path) can trigger the "wants to load a file you haven't allowed yet" question later on. Allow it once and that file is covered too.
- When a script is stopped at a file and you allow it, the script **starts over from the beginning**. Anything it did before the stop happens again, which matters for logins that use a one-time code or a refresh token that changes on use. The 60 seconds apply to each start.
- A script can't `require()` a file that is different on every run, such as a state file it writes itself: the file would never match the approval, and the request fails with a message saying so. Read and write such files with `fs`.
- Runs of the same script take turns, so services that share one script log in one after another.

## Permissions

| Permission | Used for |
|---|---|
| `filesystem` | Reading the config file; writing the example files |
| `settings` | The Enabled and Config file settings |
| `commandPalette` | The commands above |
| `events` | Updating the status bar on tab, file, environment and project changes |
| main process | Asking for approval and running auth scripts in Node.js |

Some things plugins can't do through the plugin context, so the UI side also uses Voiden's `window.electron` bridge for them:
- reading the open request file
- filling in `{{variables}}` to match rules
- reading the active environment's name
- calling Auto Auth's own main-process part

## Install

**From Voiden:** open **Extensions**, find **Auto Auth** among the community plugins, and install it.

**From a release:** download `auto-auth.zip`, or build it yourself (see below). Then in Voiden choose **Extensions → ⋯ → Install from file**.

## Development

```bash
npm install
npm run typecheck   # strict TypeScript
npm test            # unit + integration tests (Node's built-in test runner)
npm run package     # dist/auto-auth.js, dist/auto-auth-main.cjs, dist/auto-auth.zip
```

| Path | |
|---|---|
| `src/plugin.ts` | UI entry: pipeline hooks, commands, settings, status bar |
| `src/engine.ts` | Matching, caching, sharing one login between parallel requests |
| `src/config.ts` | Config parsing and URL/folder matching |
| `src/cache.ts` | Cached headers per project, environment and service |
| `src/status.ts`, `src/StatusWidget.tsx` | Status bar state and widget |
| `src/main-process.ts` | Node.js entry: IPC handlers, the approval dialog |
| `src/main/trust.ts` | Approvals: file hashes, what changed, the dialog's text |
| `src/main/runScript.ts` | Script runner: where the script is, approval, starting and stopping its worker |
| `src/main/worker.ts` | The worker thread a script runs in; checks each loaded file against the approval |
| `src/main/scriptApi.ts`, `src/main/http.ts`, `src/main/network.ts` | The `auth` object, `auth.send`, Voiden's TLS and proxy settings |
| `build/workerSource.mjs` | Bundles the worker into the main-process file |
| `src/shared/` | Types and helpers used by both parts |

Releases are built by GitHub Actions when a `v*` tag is pushed. The tag must match the version in `manifest.json`.

## License

[MIT](LICENSE)
