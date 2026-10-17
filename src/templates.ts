/**
 * Starter files written by "Auto Auth: Create example config".
 */

/**
 * Outside `.voiden/`: Voiden keeps that folder out of Git, and the auth setup
 * is meant to be shared with the team.
 */
export const EXAMPLE_SCRIPT_PATH = ".voiden-auth/my-api.js";

export const EXAMPLE_CONFIG = `# Auto Auth — which script authorizes which requests.
#
# Rules are checked top to bottom; the first match wins.
#   name:    a label, shown in the status bar
#   match:   requests whose URL starts with this ({{variables}} allowed)
#   folder:  requests whose .void file is inside this folder (relative to the project)
#            (set both to require both)
#   script:  the auth script, relative to the project root
#            (keep scripts in this folder: approval covers each script's folder)
#   header:  optional — header used for bearer/token results (default: Authorization)
#   enabled: optional — set to false to switch a rule off

services:
  - name: my-api
    match: "{{api_url}}"
    script: ${EXAMPLE_SCRIPT_PATH}
`;

export const EXAMPLE_SCRIPT = `// Auth script for "my-api".
//
// Runs in Node.js when a matching request has no valid cached token, and
// returns what to add to the request. Return ONE of:
//   { bearer: "<token>" }               → Authorization: Bearer <token>
//   { token: "<value>" }                → Authorization: <value>
//   { headers: { "X-Api-Key": "…" } }   → any headers you like
// Optionally add:
//   expiresIn: <seconds>  or  expiresAt: <epoch ms | ISO date>
//     (not needed for JWTs — their expiry is read automatically)
//   cache: false          → run this script before every request
//
// Available here:
//   await auth.send({ method, url, headers, query, json | form | body })
//       → { status, ok, headers, text, json }   (throws on non-2xx unless throwOnError: false)
//       {{variables}} anywhere in the options are filled in from the active environment.
//   await auth.env("name")     value of an environment variable
//   auth.base64("user:pass")   for Basic auth
//   auth.request               { url, method, file } of the request being authorized
//   auth.log(...)              write to Voiden's developer console
//   require("./helper")        files next to this script, your project's packages,
//                              and Node.js modules ("node:crypto", …)
//
// The first time this script runs — and whenever it or a file next to it
// changes — Voiden asks you to allow it.

const res = await auth.send({
  method: "POST",
  url: "{{api_url}}/auth/login",
  json: { username: "{{api_user}}", password: "{{api_password}}" },
});

return { bearer: res.json.token };

// ── Other common flows ───────────────────────────────────────────────────────
//
// OAuth 2.0 client credentials:
//   const res = await auth.send({
//     method: "POST",
//     url: "{{auth_url}}/oauth/token",
//     form: {
//       grant_type: "client_credentials",
//       client_id: "{{client_id}}",
//       client_secret: "{{client_secret}}",
//     },
//   });
//   return { bearer: res.json.access_token, expiresIn: res.json.expires_in };
//
// Basic auth (no login call):
//   const user = await auth.env("api_user");
//   const password = await auth.env("api_password");
//   return { token: "Basic " + auth.base64(user + ":" + password), cache: false };
//
// API key header:
//   return { headers: { "X-Api-Key": await auth.env("api_key") }, cache: false };
//
// HMAC-signed requests, with Node's crypto:
//   const crypto = require("node:crypto");
//   const timestamp = Date.now().toString();
//   const signature = crypto
//     .createHmac("sha256", await auth.env("api_secret"))
//     .update(timestamp)
//     .digest("hex");
//   return { headers: { "X-Timestamp": timestamp, "X-Signature": signature }, cache: false };
`;
