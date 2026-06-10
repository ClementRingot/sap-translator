import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTranslationTools } from '../handlers/intent.js';
import { startHttpServer } from './http.js';
import { getLogger } from './logger.js';
import type { Config } from './types.js';

const VERSION = process.env.npm_package_version ?? '0.1.0';

export async function createAndStartServer(config: Config): Promise<void> {
  const log = getLogger();

  if (config.transport === 'stdio') {
    const server = new McpServer({ name: 'sap-translator', version: VERSION });
    registerTranslationTools(server, config);

    const transport = new StdioServerTransport();
    await server.connect(transport);
    log.info('SAP Translator MCP server running on stdio');
    return;
  }

  await startHttpServer(config);
}
