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
5. Send a request. Voiden asks you to allow the script (see [Security](#security)), then a toast confirms the login, and the status bar shows `my-api` with how long the token lasts.

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
| `script` | yes | Path of the auth script, relative to the project root. |
| `header` | no | Header used for `bearer` and `token` results. Default `Authorization`. |
| `enabled` | no | `false` to switch the rule off. |

URLs match on boundaries: `https://api.example.com` matches `https://api.example.com/users`, but not `https://api.example.com.evil.io`.

Requests that match no rule are sent unchanged. The config file's location can be changed in the settings.

## Auth scripts

A script is the body of an async function running in **Node.js** (Voiden's main process). It can use `await` and `require(...)` freely: helper files next to it, your project's `node_modules`, and Node's built-in modules.

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
| `auth.log(...)` | Writes a line to Voiden's developer console (Ctrl+Shift+I / Cmd+Option+I), prefixed with the service name. |
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

`auth.send` uses Node.js's `fetch`, the same kind of HTTP client Voiden uses for its own requests. It doesn't send an `Origin` header, so servers with CORS checks treat it like any API client. Proxy settings (Voiden's or the system's) don't apply to auth calls.

A script that hasn't finished after 60 seconds is abandoned, and the request fails with a message saying so.

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

- **Scripts need your approval.** Before a script runs, Voiden shows a dialog asking you to allow it. The approval covers the script **and every other file in its folder**, such as helpers it requires, as they are at that moment. If anything there changes, for example after a `git pull`, you're asked again. Packages in `node_modules` aren't part of the approval; treat them like any dependency you install.
- **The check happens in Node.js**, in Voiden's main process, right before the script runs. Nothing on the UI side can skip it. Approvals are stored on your machine, and **Auto Auth: Forget allowed scripts** resets them.
- **Only scripts inside the project can run.** Symlinks pointing outside the project are refused.
- **Credentials stay in environment variables.** Scripts reference them as `{{variables}}`, so secrets can live in Voiden's private environment file, which is excluded from Git. Don't hard-code them in scripts.
- **Error messages show URLs as written** (`{{api_url}}/login`), not with their values filled in. A failed login's error includes up to 200 characters of the server's response.

Cached headers are kept in Voiden's local storage on your machine, per project, environment and service.

## How it works

```
send request
   │
   ├─ pre-send hook (UI side) ── match a rule in auth.yaml ── no match → send unchanged
   │                                     │
   │                          cached & fresh? ── yes → add headers
   │                                     │ no
   │                          IPC → main process (Node.js)
   │                                ├─ approved? (ask if not, or if the folder changed)
   │                                └─ run script → { headers, expiresAt }
   │                                     │
   │                          cache per environment → add headers
   ▼
response ── 401/403 → drop the cached token (if it's still the one that was sent)
```

If authorization fails, the request is stopped and the reason is shown, rather than sent without credentials.

## Limitations

- The status bar reads the request's URL from the **saved** file. Sending always uses the live URL.
- Voiden gives plugins the request's file only after they run, so `folder` rules go by the request open in the editor. Requests sent from a Stitch run therefore match `folder` rules by the open tab, not their own file. `match` rules are unaffected.
- Inside scripts, `{{variables}}` come from the active environment. Folder-level `.env` files, a newer Voiden feature, apply when rules are matched, but not inside scripts.
- Auth is added to requests sent through Voiden's HTTP pipeline. WebSocket and gRPC connections aren't covered yet.
- The 60-second limit can't stop code that blocks Node.js completely (for example an endless `while` loop). That would freeze Voiden until it's closed.

## Permissions

| Permission | Used for |
|---|---|
| `filesystem` | Reading the config file; writing the example files |
| `settings` | The Enabled and Config file settings |
| `commandPalette` | The commands above |
| `events` | Updating the status bar on tab, file, environment and project changes |
| main process | Running auth scripts in Node.js |

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
| `src/main-process.ts`, `src/main/` | Node.js part: approval, script runner, `auth.send` |
| `src/shared/` | Types and helpers used by both parts |

Releases are built by GitHub Actions when a `v*` tag is pushed. The tag must match the version in `manifest.json`.

## License

[MIT](LICENSE)
