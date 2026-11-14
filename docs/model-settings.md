# Client-side functions and model preferences

[中文说明](model-settings.zh-CN.md) · [Client demo setup](client-demo.md)

**Functions & models** (`功能与模型`) now belongs to the independent client demo, at port **4318** by default. The gateway console at port **4317** publishes models and grants project access. Saving client preferences cannot publish a server model, change project scopes, or modify another application's choices.

## Views and drafts

- **By credential** (`按凭证`) shows the authorized catalog, capability metadata, app-local model switches, reasoning controls, standalone functions, and expandable groups.
- **By function** (`按功能`) shows expandable groups and standalone functions.
- Search covers sources, models, function IDs/names, and group names. Filtering never removes hidden rows from the saved draft.
- Drag a column separator, double-click to reset, or focus it and use arrow keys (`Shift` for larger steps; `Home` to reset). Widths are remembered per view in the browser tab.

Changes remain in a tab-local draft until **Save changes** (`保存更改`). Navigation between pages or views and reloading the same tab preserve the draft. **Revert changes** (`撤销更改`) loads current settings. A conflicting revision rejects the entire save and preserves the draft; it does not silently merge or overwrite another tab's work.

**Refresh models** (`刷新模型`) always reads `GET /v1/models` through the project key, including with an unsaved draft. Reopening the page also updates publication status, capabilities and reasoning levels. Newly authorized models remain disabled until explicitly enabled. Missing models and their saved selections remain visible as unavailable.

A metadata refresh preserves local edits and advances the draft revision only if saved application preferences have not changed in another page. Concurrent preference changes still produce a revision conflict, while updated capabilities and availability remain visible. The dedicated **Connection settings** page also provides a refresh button, available authorized model count and last successful sync time.

## Standalone and grouped functions

A function belongs to the app. Its ID, such as `summarize`, is **not** a gateway model alias. The demo resolves it to an authorized model ID before sending a request. Each function selects one of the demo's explicit prompt templates.

Leave the group name empty for a standalone function, or supply a group name to organize related functions. Group membership and selection mode are independent:

- **Single model**: selecting a model replaces the previous selection and sets that model as the default. Clearing it leaves the function unconfigured.
- **Multiple candidates**: check candidate models, then choose a default separately using the default control. Removing or disabling the default preserves that choice as invalid; it never selects another model automatically. A user may explicitly choose an available candidate for a particular run.

A group checkbox adds a model to every compatible child function or removes it from those children. Single-model children use it as their sole/default model; multiple-candidate children keep their independently selected default. A mixed checkbox means only some compatible children select the model.

App model switches only control whether this app may select a model. Gateway publication and key scopes remain authoritative on every request, including requests made before the client refreshes its cached catalog.

## Reasoning preferences

Controls only appear for reasoning levels declared by the authorized catalog. Unknown capabilities stay unknown; a visible catalog entry does not prove upstream inference permission.

1. Select app-wide allowed levels for a model in the model column; keep at least one.
2. In a group row, click a level label to toggle availability. Use its separate pin to select the default among allowed levels.
3. Expand a group to override a child function for that model. **Restore inheritance** (`恢复继承`) removes the override. Standalone functions inherit directly from the app's model preference.

The effective policy is **model → group → function/model override**. Narrowing a parent narrows explicit children; a removed reasoning default moves to a remaining lower level where possible, otherwise the lowest remaining level. These are visible draft edits, applied only on save. Model selection itself never falls back.

At runtime the demo validates the effective policy, sends its default when no effort was explicitly selected, and rejects disallowed levels before contacting the gateway. With no app preference, the demo uses a declared catalog default if available, otherwise leaves reasoning to the provider. If catalog changes invalidate saved levels, reset the obsolete reasoning settings or explicitly choose valid ones before running again.

## Existing server aliases

Older gateway aliases and their saved reasoning policies remain readable and callable under their existing project scopes. Administrators can inspect them through the state API. New aliases cannot be created through `/admin/routes`; it returns `410 client_owned_settings`. The demo does not import legacy aliases or administrator configuration automatically. Recreate application features using native authorized model IDs when moving an existing client.
