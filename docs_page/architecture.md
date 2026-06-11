# Architecture

## The big picture

```
┌──────────────┐   MCP/HTTP    ┌──────────────────────────────┐   HTTPS JSON   ┌──────────────────────┐
│ AI assistant │ ────────────▶ │       sap-translator MCP      │ ─────────────▶ │  SAP ABAP system     │
│ (Claude/IDE) │   5 tools     │  ┌────────────────────────┐   │  POST          │  ┌────────────────┐  │
│              │ ◀──────────── │  │ transport (http/stdio) │   │  {path}/{action}│  │ ZCL_I18N_SERVICE│  │
└──────────────┘               │  │ auth (XSUAA/OIDC/key)  │   │ ◀───────────── │  │  (HTTP handler) │  │
                               │  │ I18nClient (wire)      │   │  {success,data} │  └───────┬────────┘  │
                               │  └────────────────────────┘   │                │          ▼            │
                               └──────────────────────────────┘                │   XCO i18n APIs       │
                                                                                 └──────────────────────┘
```

Two independently deployable halves:

- **ABAP side** — `ZCL_I18N_SERVICE` + `ZCL_VSP_UTILS` + `ZIF_VSP_SERVICE`, exposed as an ABAP HTTP service (`IF_HTTP_SERVICE_EXTENSION`, enabled in `UCON_HTTP_SERVICES`). Does the real translation work through the XCO i18n generation APIs.
- **Node side** — this repo. Authenticates the caller, propagates identity, and maps MCP tool calls to HTTP calls.

## Request lifecycle (BTP, http-streamable)

1. **MCP client → server.** The client calls `/mcp` with a tool invocation and a bearer token.
2. **Authentication.** The chained verifier validates the token (XSUAA → OIDC → API key). On failure → 401. (See [Authentication](./authentication.md).)
3. **Tool dispatch.** `intent.ts` routes the call to one of the 5 tools; Zod (`tools.ts`) validates the arguments.
4. **Connection resolution.** `i18n-client.ts` builds a connection:
   - user JWT + `SAP_BTP_PP_DESTINATION` → per-user **principal propagation** destination;
   - else → BasicAuth technical destination (`SAP_BTP_DESTINATION`);
   - on-premise targets go through the **Connectivity proxy** (standard HTTP forward-proxy, not CONNECT).
5. **HTTP call to SAP.** POST to `{SAP_I18N_SERVICE_PATH}/{action}` with the params as a JSON body.
6. **ABAP handling.** `ZCL_I18N_SERVICE` reads the action from the last path segment, parses the body via `ZCL_VSP_UTILS=>extract_param`, runs the XCO i18n call under the propagated user, and wraps the result in `{success,data}` / `{success,error}`.
7. **Unwrap & return.** The client unwraps the envelope and returns the `data` to the assistant.

## Why a thin ABAP HTTP service (vs. ADT/OData)?

The XCO i18n APIs are ABAP-side generation APIs with no general REST surface. A small purpose-built handler:

- keeps the wire contract tiny and explicit (5 actions, JSON in/out),
- lets the heavy lifting (XCO calls, transport handling) run **inside** SAP under the user's authorizations,
- works over plain HTTP, so the same Cloud Connector / Destination plumbing as ARC-1 applies unchanged.

## Key design decisions

| Decision | Rationale |
|----------|-----------|
| **Authentication only, no MCP authorization** | SAP already governs translation rights; duplicating them in the MCP would drift. See [Authentication](./authentication.md). |
| **Action in the URL path, params in the body** | Matches `IF_HTTP_SERVICE_EXTENSION` routing (`~path_info`); avoids query-string parsing in ABAP. |
| **Semantic `target_type` literals** | XCO's own object vocabulary (`data_element`, …) rather than DDIC codes — fewer translations between layers. |
| **Wrapped `{success,data}` envelope** | Uniform success/error handling; HTTP 400 on logical errors. |
| **Stateless DCR + signed state** | Lets standard MCP OAuth clients use XSUAA without server-side session storage. |
| **Modeled on ARC-1** | Reuses a production-proven auth/transport/connectivity stack. |

## File map

| Concern | File |
|---------|------|
| Tool schemas | `src/handlers/tools.ts` |
| Tool registration | `src/handlers/intent.ts` |
| SAP wire contract | `src/sap/i18n-client.ts` |
| BTP destinations / proxy | `src/sap/btp.ts` |
| Config | `src/server/config.ts` |
| Transport / OAuth router | `src/server/http.ts` |
| XSUAA proxy + verifier | `src/server/xsuaa.ts` |
| DCR store | `src/server/stateless-client-store.ts` |
| OAuth state codec | `src/server/oauth-state.ts` |
| ABAP handler | `abap/zcl_i18n_service.clas.abap` |
| ABAP JSON utils | `abap/zcl_vsp_utils.clas.abap` |
| ABAP shared types | `abap/zif_vsp_service.intf.abap` |
