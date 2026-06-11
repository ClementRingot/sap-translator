# ABAP service setup

The MCP server cannot translate anything on its own — it forwards requests to an ABAP HTTP handler that uses the **XCO i18n** APIs. This page covers importing that handler and exposing it as an ABAP **HTTP service**.

> **Not SICF.** This handler uses the ABAP **HTTP Service framework** (`IF_HTTP_SERVICE_EXTENSION`). As of SAP S/4HANA 2022 such services are created/edited in **ADT** and enabled in transaction **`UCON_HTTP_SERVICES`** — no ICF/SICF node is created. The old "create a node in SICF" procedure does **not** apply on 2022+.

> The ABAP sources live in [`abap/`](../abap). See [`abap/README.md`](../abap/README.md) for a condensed version of these steps.

## Prerequisites

- **XCO i18n APIs** available — S/4HANA 2022+ / ABAP Platform 2022+ / ABAP Cloud. Older releases do not have the `XCO_CP_I18N` generation APIs this handler relies on.
- The **`IF_HTTP_SERVICE_EXTENSION`** programming model (ABAP Platform 1809 / 7.53+).
- Developer authorization (create class/interface and an HTTP service) plus rights for transaction **`UCON_HTTP_SERVICES`** to enable the service.
- A target package (any Z/local package works).

## Objects to import

Import in dependency order:

| # | Object | File | Why |
|---|--------|------|-----|
| 1 | `ZIF_VSP_SERVICE` (interface) | `abap/zif_vsp_service.intf.abap` | Defines `ty_response` used by the utils class. |
| 2 | `ZCL_VSP_UTILS` (class) | `abap/zcl_vsp_utils.clas.abap` | JSON helpers + `extract_param`. |
| 3 | `ZCL_I18N_SERVICE` (class) | `abap/zcl_i18n_service.clas.abap` | The HTTP handler. |

### abapGit (recommended)

The files use abapGit source-format names (`*.intf.abap`, `*.clas.abap`). Link a package to a repo containing the `abap/` folder and pull, or use "import file" object-by-object.

### Manual (ADT)

1. Create interface `ZIF_VSP_SERVICE` → paste source → activate.
2. Create class `ZCL_VSP_UTILS` → paste source → activate.
3. Create the handler class `ZCL_I18N_SERVICE` **via the HTTP service wizard** (next section), then paste the source from `abap/zcl_i18n_service.clas.abap` into it → activate.

Assign all three to a transportable package if you intend to move them to QA/Prod.

> **Why create the handler class through the HTTP service wizard?** For HTTP services the handler class is owned by the service object: the wizard generates it if missing, and renaming/creating it outside the wizard is not supported (it produces an invalid handler). So create `ZIF_VSP_SERVICE` and `ZCL_VSP_UTILS` normally, but let the HTTP service wizard create `ZCL_I18N_SERVICE` and only then paste in the implementation.

## Create and enable the HTTP service

All HTTP services live under `/sap/bc/http`. The MCP server defaults to `/sap/bc/http/sap/zi18n_service` — note the actual URL your service gets and set `SAP_I18N_SERVICE_PATH` to match.

### a) Create the HTTP service object (ADT)

1. In ADT, right-click your user (or the **Connectivity** node) → **New ▸ Other ABAP Repository Object**.
2. Type `http` in the filter, select **HTTP service**, **Next**.
3. Choose a **Package**, **Name** and **Description** → **Finish**. A new node appears under **`<User> ▸ Connectivity ▸ HTTP services`**.
4. In the HTTP service editor, click the **Handler class** link and set/confirm it as **`ZCL_I18N_SERVICE`** (the wizard generates the class if it doesn't exist — then paste in the implementation from `abap/zcl_i18n_service.clas.abap`).
5. Optionally use **Maintain Authorization Default Values** to create authorization defaults.
6. Note the **service URL** shown in the editor and set the MCP's `SAP_I18N_SERVICE_PATH` (env / `.env`, or the `mta.yaml` property on BTP) to exactly that path.

> If you imported the HTTP service and its artifacts from GitHub (abapGit), click **Publish Locally** in the editor so it becomes callable without an HTTP 403.

### b) Enable it (security gate — disabled by default)

HTTP services are **disabled by default**; calling one returns **HTTP 403** until enabled.

- **On-premise, S/4HANA 2022+:** transaction **`UCON_HTTP_SERVICES`** → search for your service → mark it → **Enable** (multi-select supported). No ICF/SICF node is involved. See SAP note **3211278**.
- **On-premise, before S/4HANA 2022:** the framework creates a matching SICF node — open **SICF**, find it by the service's URL path, right-click ▸ **Activate**.
- **ABAP Cloud (ABAP environment):** the underlying SICF node is activated automatically once the service is assigned to a **communication scenario** (inbound).

The handler then determines the **action** from the last path segment (e.g. `…/zi18n_service/list_languages`), so it must sit at the fixed path you configured.

## How routing works

```
POST  …/zi18n_service/list_languages        ← action = "list_languages"
POST  …/zi18n_service/get_translation        ← action = "get_translation"
POST  …/zi18n_service/set_translation        ← action = "set_translation"
POST  …/zi18n_service/list_texts             ← action = "list_texts"
POST  …/zi18n_service/compare_translations   ← action = "compare_translations"
```

- The action is the **last URL path segment**, lowercase. `?action=…` query parameters are **ignored**.
- All parameters travel in the **JSON request body**.
- `sap-client` stays a query parameter (consumed by the framework, not the handler).
- Unknown actions return `{ "success": false, "error": { "code": "UNKNOWN_ACTION", … } }` with HTTP 400.

## Verify

```bash
curl -u USER:PASS -H 'Content-Type: application/json' \
  -X POST 'https://<host>/sap/bc/http/sap/zi18n_service/list_languages?sap-client=100' \
  -d '{}'
```

Expect:

```json
{ "success": true, "data": { "languages": [ { "sap_code": "E", "iso_code": "EN", "name": "English" }, … ] } }
```

A **403** means the HTTP service exists but is not enabled — enable it in `UCON_HTTP_SERVICES` (or **Publish Locally** after an abapGit import). A **404** / HTML page means the path is wrong or the service isn't published. A **401** means the credentials were rejected.

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| HTTP 403 | HTTP service not enabled in `UCON_HTTP_SERVICES` (2022+), or not yet **Published Locally** after a GitHub import. |
| HTML login page / 404 | Wrong path, or (pre-2022) the SICF node isn't activated. |
| 401 Unauthorized | Supplied credentials rejected / logon procedure mismatch. |
| `UNKNOWN_ACTION` | Path segment misspelled, or a trailing slash dropped the action. |
| `I18N_GET_ERROR` / `I18N_SET_ERROR` | XCO i18n call failed — object doesn't exist, language not installed, or no translation authorization for the user. |
| Activation error on `ZCL_VSP_UTILS` | `ZIF_VSP_SERVICE` not imported/activated first. |
| Invalid handler class | `ZCL_I18N_SERVICE` was created/renamed outside the HTTP service wizard — recreate it through the wizard. |
