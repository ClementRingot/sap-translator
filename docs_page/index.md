# sap-translator documentation

`sap-translator` is an MCP server that lets AI assistants read, write and compare **SAP object translations**. It has two halves:

- an **ABAP HTTP service** (`ZCL_I18N_SERVICE`) you install in your SAP system, and
- this **Node.js MCP server**, which authenticates callers and forwards their requests to that service.

## Start here

1. **[Quickstart](./quickstart.md)** — the fastest path to a working setup.
2. **[ABAP service setup](./abap-service-setup.md)** — import the class and publish/enable the HTTP service.
3. **[MCP tools usage](./mcp-usage.md)** — the 5 tools, with examples.

## Reference

- **[Configuration reference](./configuration-reference.md)** — every environment variable.
- **[Authentication](./authentication.md)** — the auth model and the supported methods.
- **[Architecture](./architecture.md)** — how the components fit together.

## Operations

- **[Local development](./local-development.md)** — dev loop, lint, build.
- **[BTP deployment](./btp-deployment.md)** — Cloud Foundry / MTA.

## At a glance

| | |
|--|--|
| **Tools** | `TranslateListLanguages`, `TranslateListTexts`, `TranslateGetTexts`, `TranslateSetTexts`, `TranslateCompare` |
| **Object types** | data elements, domains, CDS views, CDS metadata extensions, message classes, class/FG text pools, application log objects, business configuration objects |
| **Transports** | `http-streamable` (default) and `stdio` |
| **Auth** | none (stdio/local), API key, OIDC/JWT, XSUAA (BTP) |
| **Built like** | [ARC-1](https://github.com/marianfoo/arc-1) |
