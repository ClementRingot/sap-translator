/**
 * MCP tool definitions for SAP object translation.
 *
 * Five tools matching the XCO translation operations from vibing-steampunk
 * but adapted for a plain HTTP backend (zcl_i18n_service).
 */

import { z } from 'zod';

// ─── Shared argument schemas ──────────────────────────────────────────────────

export const ObjectTypeSchema = z
  .string()
  .min(1)
  .describe(
    'SAP object type, e.g. CLAS (class), DTEL (data element), MSAG (message class), PROG (program), ' +
      'DDLS (CDS view), TABL (table), TRAN (transaction)',
  );

export const LanguageSchema = z
  .string()
  .min(1)
  .max(2)
  .describe('Language — ISO 639-1 (EN, DE, FR…) or SAP SPRAS single-char code (E, D, F…)');

// ─── Tool input schemas ───────────────────────────────────────────────────────

export const ListLanguagesSchema = z.object({});

export const GetTranslationSchema = z.object({
  object_type: ObjectTypeSchema,
  object_name: z.string().min(1).describe('Technical name of the SAP object, e.g. ZCL_MY_CLASS'),
  language: LanguageSchema,
  field_name: z.string().optional().describe('Optional: restrict to a specific field/text key within the object'),
});

export const SetTranslationSchema = z.object({
  object_type: ObjectTypeSchema,
  object_name: z.string().min(1).describe('Technical name of the SAP object'),
  language: LanguageSchema,
  transport: z.string().min(1).describe('Transport request number, e.g. K900001'),
  texts: z
    .array(
      z.object({
        key: z.string().min(1).describe('Text key, field name, or message number'),
        value: z.string().describe('Translated text value'),
      }),
    )
    .min(1)
    .describe('Array of text entries to write'),
});

export const ListTextsSchema = z.object({
  object_type: ObjectTypeSchema,
  object_name: z.string().min(1).describe('Technical name of the SAP object'),
});

export const CompareTranslationsSchema = z.object({
  object_type: ObjectTypeSchema,
  object_name: z.string().min(1).describe('Technical name of the SAP object'),
  source_language: LanguageSchema.describe('Reference language (already translated), typically EN'),
  target_language: LanguageSchema.describe('Language to compare against (may be incomplete)'),
});

// ─── Tool metadata ────────────────────────────────────────────────────────────

export const TOOLS = {
  TranslateListLanguages: {
    description: 'List all languages installed on the SAP system.',
    inputSchema: ListLanguagesSchema,
  },
  TranslateGetTexts: {
    description:
      'Retrieve the translations of an SAP object in a given language. ' +
      'Returns all text elements with their original and translated values.',
    inputSchema: GetTranslationSchema,
  },
  TranslateSetTexts: {
    description:
      'Write or update translations for an SAP object. ' +
      'Provide the transport request and an array of text entries.',
    inputSchema: SetTranslationSchema,
  },
  TranslateListTexts: {
    description:
      'List all translatable text elements of an SAP object (keys, types, and source texts). ' +
      'Use this before TranslateGetTexts to discover which keys exist.',
    inputSchema: ListTextsSchema,
  },
  TranslateCompare: {
    description:
      'Compare translations between a source and a target language for an SAP object. ' +
      'Returns a summary (total / translated / missing) plus the individual text entries.',
    inputSchema: CompareTranslationsSchema,
  },
} as const;

export type ToolName = keyof typeof TOOLS;
