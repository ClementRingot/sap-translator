# Quickstart

Get from zero to translating in three steps. This assumes **local development** (direct connection to SAP, no BTP).

## 1. Install the ABAP service

Import the three objects from [`abap/`](../abap) into your SAP system, create the ABAP **HTTP service** (handler class `ZCL_I18N_SERVICE`), and **enable** it in `UCON_HTTP_SERVICES` (S/4HANA 2022+). Full details: **[ABAP service setup](./abap-service-setup.md)**.

Smoke-test it:

```bash
curl -u USER:PASS -H 'Content-Type: application/json' \
  -X POST 'https://your-system/sap/bc/http/sap/zi18n_service/list_languages?sap-client=100' \
  -d '{}'
# → {"success":true,"data":{"languages":[...]}}
```

## 2. Run the MCP server

```bash
npm install
cp .env.example .env
```

Edit `.env`:

```bash
SAP_URL=https://your-abap-system.example.com
SAP_USERNAME=ABAP_USER
SAP_PASSWORD=secret
SAP_CLIENT=100
SAP_I18N_SERVICE_PATH=/sap/bc/http/sap/zi18n_service
MCP_TRANSPORT=http-streamable
PORT=8080
```

Start it:

```bash
npm run dev
# MCP endpoint: http://localhost:8080/mcp   |   health: http://localhost:8080/health
```

## 3. Connect your assistant

Add to your MCP client config (Claude Desktop, Cursor, VS Code):

```json
{
  "mcpServers": {
    "sap-translator": { "url": "http://localhost:8080/mcp" }
  }
}
```

## 4. Try it

Ask your assistant:

> "List the installed SAP languages."
> "Show the translatable texts of data element `ZMY_AMOUNT`."
> "Translate data element `ZMY_AMOUNT` to German on transport `K900123`."

Behind the scenes those map to `TranslateListLanguages`, `TranslateListTexts`, and `TranslateSetTexts`. See **[MCP tools usage](./mcp-usage.md)** for the full surface.

## Next

- Going to production? → **[BTP deployment](./btp-deployment.md)**.
- Need auth in front of the HTTP transport? → **[Authentication](./authentication.md)**.
