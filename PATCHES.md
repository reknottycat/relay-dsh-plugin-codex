# PATCHES.md — reknottycat DSH 0.1.7-rc.2 adaptation

Upstream: [`relay-dsh-plugin-codex@0.2.4`](https://www.npmjs.com/package/relay-dsh-plugin-codex)
(author: [yangbobo2021](https://github.com/yangbobo2021/relay-dsh-plugin-codex), MIT)

This tree is upstream `0.2.4` plus the patches below. Nothing else was touched.
The goal is to make the plugin **load and run** on DeepSeek Harness `0.1.7-rc.2`
(the engine shipped in `reknottycat/dsh-mobile-apk`), which is what the user's
vivo PA2573 tablet runs.

---

## P1 — `lib/host-plugin.js`: make the settings-section install optional

**Symptom (fatal, engine refused to boot):**

```
fatal uncaught exception: failed to apply loader entry relay-codex-host
(relay-dsh-plugin-codex):
ctx.get(...)?.installSection is not a function
```

**Root cause.** DSH deleted the `settings` service's `installSection()` method.
Verified directly against the shipped engine snapshot
(`files/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`):

* `grep -r installSection` across the whole engine tree returns **zero hits** —
  the method does not exist in `0.1.7-rc.2` at all.
* The current client service names are `slots`, `settingsSchema`,
  `configForms`, `conversationViews`, `inputTriggers`, `shortcuts`, … —
  the UI moved to a **declarative slot** model (see
  `@deepseek-ai/dsh-client-ui-settings-shell` for the official idiom:
  `ctx.configForms.whileServed([...])` + `ctx.slots.inject("plugins.item", …)`).
  `settingsSchema` only exposes `rehydrate / validate / nodeAtPath / getPath /
  hasPath / setPath` — it is a low-level schema helper, not a section registry.

`ctx.get("settings")` is the **only** use of any `settings` service in the whole
214 KB `host-plugin.js`, and it exists solely to render an optional settings card
for the `codexCommand` field. The author already wrote `?.` — they intended the
card to be skippable when the service is absent — but optional chaining guards
only a *null service*, not a *missing method on a present service*.

**Patch** (`lib/host-plugin.js`, `apply()`):

```diff
-  ctx.get("settings")?.installSection(ctx, CODEX_SETTINGS_NAMESPACE, CODEX_SETTINGS_SCHEMA, base, {
+  ctx.get("settings")?.installSection?.(ctx, CODEX_SETTINGS_NAMESPACE, CODEX_SETTINGS_SCHEMA, base, {
```

**Effect.** `installSection` was never load-bearing for the plugin's function: the
value it published through `setSource()` falls back to
`base = { codexCommand: config.codexCommand ?? "" }`, which is read from the
plugin's own config entry. So the plugin now boots, installs its managed preset
and activates the Codex execution plugin as before.

**Known limitation (accepted).** The in-app "Relay Codex" settings card is not
rendered on `0.1.7-rc.2`. Configure the backend from the profile config instead:

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- name: relay-dsh-plugin-codex
  config:
    codexCommand: /path/to/codex
```

---

## P2 — `package.json`: widen peer ranges to `0.1.7-rc.2`

Upstream capped the three DSH peer ranges at `0.1.6-alpha.1`, which makes
`dsh plugin add` refuse the package on a `0.1.7-rc.2` engine (it has to be
forced through with `dsh allow-version … --accept-risk`). Appending
`|| 0.1.7-rc.2` to `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-session` and
`@deepseek-ai/dsh-typert-protocol` lets it install normally, with no risk flag.

> The same `0.2.4` release already migrated its own `dsh.client.inject` list to
> `@deepseek-ai/dsh-client-store`, so the client half is 0.1.7-ready; only this
> peer cap and the one `installSection` call were left behind.

---

## P3 — version

`0.2.4` → `0.2.4-mavis.1`, so the adapted build is distinguishable from the
upstream artifact of the same code shape.

---

## Verified on device

* Engine: `@deepseek-ai/dsh@0.1.7-rc.2`, Node `v24.18.0`, profile `web`.
* Install: `dsh plugin add github:reknottycat/relay-dsh-plugin-codex`
  (no `allow-version` / `--accept-risk` needed).
* Cold boot: no `Failed to load plugins` banner.
