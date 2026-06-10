import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { I18nClient } from '../sap/i18n-client.js';
import { getLogger } from '../server/logger.js';
import type { Config } from '../server/types.js';
import {
  CompareTranslationsSchema,
  GetTranslationSchema,
  ListLanguagesSchema,
  ListTextsSchema,
  SetTranslationSchema,
} from './tools.js';

function formatError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return `Error: ${msg}`;
}

function json(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

export function registerTranslationTools(server: McpServer, config: Config, userJwt?: string): void {
  const log = getLogger();
  const client = new I18nClient(config, userJwt);

  // No MCP-level authorization: every authenticated principal gets all tools.
  // The user's JWT is propagated to SAP, whose own authorization objects decide
  // what may actually be read / written / translated.

  // ── TranslateListLanguages ────────────────────────────────────────────────
  server.tool(
    'TranslateListLanguages',
    'List all languages installed on the SAP system.',
    ListLanguagesSchema.shape,
    async () => {
      try {
        const languages = await client.listLanguages();
        return { content: [{ type: 'text', text: json(languages) }] };
      } catch (e) {
        log.error('TranslateListLanguages failed', { err: (e as Error).message });
        return { content: [{ type: 'text', text: formatError(e) }], isError: true };
      }
    },
  );

  // ── TranslateListTexts ────────────────────────────────────────────────────
  server.tool(
    'TranslateListTexts',
    'List all translatable text elements of an SAP object (keys, types, source texts).',
    ListTextsSchema.shape,
    async (args) => {
      try {
        const texts = await client.listTexts({
          object_type: args.object_type,
          object_name: args.object_name,
        });
        return { content: [{ type: 'text', text: json(texts) }] };
      } catch (e) {
        log.error('TranslateListTexts failed', { err: (e as Error).message });
        return { content: [{ type: 'text', text: formatError(e) }], isError: true };
      }
    },
  );

  // ── TranslateGetTexts ─────────────────────────────────────────────────────
  server.tool(
    'TranslateGetTexts',
    'Retrieve the translations of an SAP object in a given language.',
    GetTranslationSchema.shape,
    async (args) => {
      try {
        const result = await client.getTranslation({
          object_type: args.object_type,
          object_name: args.object_name,
          language: args.language,
          field_name: args.field_name,
        });
        return { content: [{ type: 'text', text: json(result) }] };
      } catch (e) {
        log.error('TranslateGetTexts failed', { err: (e as Error).message });
        return { content: [{ type: 'text', text: formatError(e) }], isError: true };
      }
    },
  );

  // ── TranslateCompare ──────────────────────────────────────────────────────
  server.tool(
    'TranslateCompare',
    'Compare translations between two languages for an SAP object.',
    CompareTranslationsSchema.shape,
    async (args) => {
      try {
        const result = await client.compareTranslations({
          object_type: args.object_type,
          object_name: args.object_name,
          source_language: args.source_language,
          target_language: args.target_language,
        });
        return { content: [{ type: 'text', text: json(result) }] };
      } catch (e) {
        log.error('TranslateCompare failed', { err: (e as Error).message });
        return { content: [{ type: 'text', text: formatError(e) }], isError: true };
      }
    },
  );

  // ── TranslateSetTexts ─────────────────────────────────────────────────────
  server.tool(
    'TranslateSetTexts',
    'Write or update translations for an SAP object.',
    SetTranslationSchema.shape,
    async (args) => {
      try {
        const result = await client.setTranslation({
          object_type: args.object_type,
          object_name: args.object_name,
          language: args.language,
          transport: args.transport,
          texts: args.texts,
        });
        return { content: [{ type: 'text', text: json(result) }] };
      } catch (e) {
        log.error('TranslateSetTexts failed', { err: (e as Error).message });
        return { content: [{ type: 'text', text: formatError(e) }], isError: true };
      }
    },
  );
}
