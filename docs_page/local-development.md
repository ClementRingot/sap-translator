# Local development

## Setup

```bash
npm install
cp .env.example .env     # fill in SAP_URL / SAP_USERNAME / SAP_PASSWORD / SAP_CLIENT
```

For local dev you connect **directly** to SAP (BasicAuth) — no BTP services involved. Make sure the [ABAP service](./abap-service-setup.md) is installed and reachable from your machine.

## Scripts

| Command | What it does |
|---------|--------------|
| `npm run dev` | Run with `tsx` (no build step, fast iteration). |
| `npm run build` | Compile TypeScript to `dist/` via `tsc`. |
| `npm start` | Run the compiled server (`node dist/index.js`). |
| `npm run lint` | Biome check over `src/`. |
| `npm run format` | Biome format-write over `src/`. |
| `npm run clean` | Remove `dist/`. |

## Transports

- **`http-streamable`** (default) — serves the MCP endpoint at `http://localhost:8080/mcp` with a `/health` probe. Use this to test with HTTP MCP clients and to mirror production.
- **`stdio`** — set `MCP_TRANSPORT=stdio` to run as a child process launched by the MCP client. No HTTP server, no auth layer; the client passes env vars directly.

## Testing the ABAP service directly

Bypass the MCP server entirely to isolate problems:

```bash
curl -u "$SAP_USERNAME:$SAP_PASSWORD" -H 'Content-Type: application/json' \
  -X POST "$SAP_URL/sap/bc/http/sap/zi18n_service/list_languages?sap-client=$SAP_CLIENT" \
  -d '{}'
```

If this works but the MCP tool doesn't, the problem is in the server config (path, auth). If this fails, the problem is in SAP (HTTP service not enabled in `UCON_HTTP_SERVICES`, authorization, or XCO availability).

## Project layout

```
src/
├── index.ts                 # entry point: resolveConfig → initLogger → start server
├── handlers/
│   ├── tools.ts             # Zod schemas + tool metadata (the 5 tools)
│   └── intent.ts            # registers tools on the MCP server
├── sap/
│   ├── i18n-client.ts       # HTTP client for ZCL_I18N_SERVICE (the wire contract)
│   └── btp.ts               # destination lookup + connectivity proxy
└── server/
    ├── config.ts            # env → Config
    ├── server.ts            # builds & starts the MCP server
    ├── http.ts              # Express transport, mcpAuthRouter, OAuth callback
    ├── xsuaa.ts             # XSUAA OAuth proxy + chained token verifier
    ├── stateless-client-store.ts  # DCR client store
    ├── oauth-state.ts       # signed OAuth state codec
    ├── logger.ts            # logging + audit events
    └── types.ts             # shared types
```

## Conventions

- Code style is enforced by **Biome** (`biome.json`). Run `npm run lint` before committing.
- The wire contract in `src/sap/i18n-client.ts` mirrors `ZCL_I18N_SERVICE` exactly — if you change one, change the other.

## When in doubt

This project intentionally mirrors **[ARC-1](https://github.com/marianfoo/arc-1)** for auth, HTTP transport, BTP connectivity and rate limiting. If a pattern is unclear, the corresponding file in ARC-1 is the reference implementation.
