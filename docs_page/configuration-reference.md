# Configuration reference

All configuration is via environment variables (read in `src/server/config.ts`). For local dev they come from `.env`; on BTP they come from `mta.yaml` properties and the injected `VCAP_SERVICES`.

## Connection

| Variable | Default | Purpose |
|----------|---------|---------|
| `SAP_I18N_SERVICE_PATH` | `/sap/bc/http/sap/zi18n_service` | URL path of the `ZCL_I18N_SERVICE` HTTP service. Must match the service URL shown in ADT. |
| `SAP_URL` | — | SAP base URL for **local dev** (direct connection). |
| `SAP_USERNAME` | — | SAP user for local dev. |
| `SAP_PASSWORD` | — | SAP password for local dev. |
| `SAP_CLIENT` | `000` | `sap-client` query parameter. |

> Either `SAP_BTP_DESTINATION` **or** `SAP_URL` must be set, otherwise startup fails.

## BTP

| Variable | Purpose |
|----------|---------|
| `SAP_BTP_DESTINATION` | BasicAuth Destination — used for system-level calls and as a fallback when no user JWT is present (stdio / API key). |
| `SAP_BTP_PP_DESTINATION` | PrincipalPropagation Destination — used per-user when a JWT is available, so SAP authenticates as the actual backend user. |
| `VCAP_SERVICES` | Injected by Cloud Foundry; carries the XSUAA, Destination and Connectivity bindings. |

## Transport

| Variable | Default | Purpose |
|----------|---------|---------|
| `MCP_TRANSPORT` | `http-streamable` | `http-streamable` (HTTP endpoint at `/mcp`) or `stdio` (local process). |
| `PORT` | `8080` | HTTP port (http-streamable only). |
| `CORS_ORIGINS` | _(empty)_ | Comma-separated allowed CORS origins. |

## Logging

| Variable | Default | Values |
|----------|---------|--------|
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `LOG_FORMAT` | `json` on http-streamable, else `text` | `text`, `json` |

## Authentication

Authentication is **active only when at least one** of the following is configured. With none set, the HTTP transport is unauthenticated (fine for stdio/local testing only). See [Authentication](./authentication.md).

| Variable | Purpose |
|----------|---------|
| `SAP_API_KEYS` | `key:profile,key2:profile2` CSV. Profiles: `viewer`, `developer`, `admin`. |
| `OIDC_ISSUER` | OIDC issuer URL (e.g. Entra ID `…/v2.0`). |
| `OIDC_AUDIENCE` | Expected token audience (e.g. `api://<app-id>`). |
| `VCAP_SERVICES` (xsuaa) | Enables XSUAA validation on BTP. |

### OAuth / DCR (BTP)

| Variable | Default | Purpose |
|----------|---------|---------|
| `SAP_TRANSLATOR_DCR_SIGNING_SECRET` | falls back to XSUAA `clientsecret` | Stable secret for signing dynamic client registrations and OAuth state. **Set this via `cf set-env`** — otherwise every `cf deploy` rotates the secret and invalidates cached client registrations. Startup logs `dcrSigningSource: "env"` when active. |
| `SAP_OAUTH_DCR_TTL_SECONDS` | — | TTL for DCR registrations. `0` = never expire. |

## Rate limiting

| Variable | Default | Purpose |
|----------|---------|---------|
| `MCP_RATE_LIMIT` | `600` | Max MCP requests per minute. |
| `OAUTH_RATE_LIMIT` | `20` | Max OAuth requests per minute. |

## Minimal configurations

**Local dev (no auth):**

```bash
SAP_URL=https://your-system.example.com
SAP_USERNAME=ABAP_USER
SAP_PASSWORD=secret
SAP_CLIENT=100
SAP_I18N_SERVICE_PATH=/sap/bc/http/sap/zi18n_service
```

**BTP (set in `mta.yaml`, plus bound services for XSUAA/Destination/Connectivity):**

```yaml
MCP_TRANSPORT: http-streamable
LOG_FORMAT: json
SAP_I18N_SERVICE_PATH: /sap/bc/http/sap/zi18n_service
SAP_BTP_DESTINATION: SAP_SYSTEM_TECH_SBX
SAP_BTP_PP_DESTINATION: SAP_SYSTEM_SSO_SBX
```
