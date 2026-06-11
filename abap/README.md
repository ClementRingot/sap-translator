# ABAP service — `zi18n_service`

These are the ABAP objects you import into the **target SAP system** so that `sap-translator` (the MCP server) has something to call. The MCP server never talks to ADT directly for translations — it POSTs JSON to this handler, which does the work via the **XCO i18n** APIs.

## Objects (import in this order)

| # | File | Object | Type | Purpose |
|---|------|--------|------|---------|
| 1 | `zif_vsp_service.intf.abap` | `ZIF_VSP_SERVICE` | Interface | Shared `ty_response` / `ty_message` types used by the utils class. |
| 2 | `zcl_vsp_utils.clas.abap` | `ZCL_VSP_UTILS` | Class | JSON build helpers (`json_obj`, `json_str`, `escape_json`, …) and `extract_param` for parsing request bodies. |
| 3 | `zcl_i18n_service.clas.abap` | `ZCL_I18N_SERVICE` | Class | The HTTP handler implementing `IF_HTTP_SERVICE_EXTENSION`. Routes actions and calls the XCO i18n APIs. |

> `ZCL_I18N_SERVICE` depends on `ZCL_VSP_UTILS`, which depends on `ZIF_VSP_SERVICE`. Importing in the order above keeps the activation clean.

## Requirements

- **XCO i18n APIs** present — S/4HANA 2022+ / ABAP Platform 2022+ / ABAP Cloud.
- New HTTP handler model (`IF_HTTP_SERVICE_EXTENSION`).
- A package to hold the objects (the originals live in `ZBC_TOOLS` / `$ZADT_VSP`; any Z/local package works).

## Install

### Option A — abapGit (recommended)

These files use the **source-format** naming abapGit understands (`*.clas.abap`, `*.intf.abap`). Drop them into an abapGit-linked package and pull.

### Option B — manual (ADT / SE24 / SE80)

1. Create interface `ZIF_VSP_SERVICE`, paste the source, activate.
2. Create class `ZCL_VSP_UTILS`, paste the source, activate.
3. Create class `ZCL_I18N_SERVICE`, paste the source, activate.

## Expose it as an HTTP service

This is an ABAP **HTTP service** (`IF_HTTP_SERVICE_EXTENSION`), **not** a hand-made SICF node. On S/4HANA 2022+ you create it in ADT and enable it in `UCON_HTTP_SERVICES` — no ICF node is created. The handler reads the **action from the last segment of the URL path** (e.g. `…/zi18n_service/list_languages`) and all parameters from the **JSON request body**.

1. In ADT: **New ▸ Other ABAP Repository Object ▸ HTTP service**. Give it a package/name/description.
2. Set its **Handler class** to **`ZCL_I18N_SERVICE`** (let the wizard generate the class, then paste in the implementation — see step 3 of "Manual" above).
3. **Enable** it:
   - On-premise **S/4HANA 2022+** → transaction **`UCON_HTTP_SERVICES`** → find the service → **Enable** (disabled by default → HTTP 403 until enabled).
   - On-premise **pre-2022** → activate the generated node in **SICF**.
   - **ABAP Cloud** → assign the service to a communication scenario (activates automatically).
   - After an abapGit import → click **Publish Locally** in the HTTP service editor.
4. Note the service URL and set the MCP server's `SAP_I18N_SERVICE_PATH` (or the `mta.yaml` property) to match — default `/sap/bc/http/sap/zi18n_service`.

👉 Full walkthrough: [`docs_page/abap-service-setup.md`](../docs_page/abap-service-setup.md).

## Wire contract (for reference / testing)

Every action is a **POST** to `{path}/{action}` with a JSON body. Responses are always wrapped:

```jsonc
// success
{ "success": true,  "data": { /* … */ } }
// error (HTTP 400)
{ "success": false, "error": { "code": "…", "message": "…" } }
```

| Action | Body | `data` shape |
|--------|------|--------------|
| `list_languages` | `{}` | `{ languages: [{ sap_code, iso_code, name }] }` |
| `list_texts` | `{ target_type, object_name, language? }` | `{ …, texts: [{ level, field_name, attribute, value }] }` |
| `get_translation` | `{ target_type, object_name, language, …selectors }` | `{ …, texts: [{ attribute, value }] }` |
| `set_translation` | `{ …, transport, texts: [{ attribute, value }], …selectors }` | `{ …, transport, success }` |
| `compare_translations` | `{ target_type, object_name, source_language, target_language }` | `{ …, items: [{ field_or_key, source_texts, target_texts, has_difference }] }` |

Optional selectors (only the ones relevant to a `target_type` are read): `field_name`, `fixed_value` (domain), `message_number` (message_class), `text_symbol_id` + `text_pool_owner_type` (text_pool), `subobject_name`, `position` (metadata_extension).

### Quick smoke test

```bash
curl -u USER:PASS \
  -H 'Content-Type: application/json' \
  -X POST 'https://your-system/sap/bc/http/sap/zi18n_service/list_languages?sap-client=100' \
  -d '{}'
```

A `{ "success": true, "data": { "languages": [...] } }` response means the service is live.
