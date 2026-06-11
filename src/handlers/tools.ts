/**
 * MCP tool definitions for SAP object translation.
 *
 * These schemas mirror the wire contract of the ABAP handler class
 * `zcl_i18n_service` exactly:
 *   - the action is the last segment of the URL path (handled in i18n-client),
 *   - every parameter is sent in the JSON request body,
 *   - object kinds are the XCO *semantic* target types (data_element, domain, …),
 *     NOT DDIC short codes (DTEL, DOMA, …),
 *   - text entries use { attribute, value }.
 */

import { z } from 'zod';

// ─── Shared argument schemas ──────────────────────────────────────────────────

/**
 * XCO i18n target type. These are the exact literals the ABAP `CASE lv_target_type`
 * branches on — see ZCL_I18N_SERVICE. They are semantic object kinds, not DDIC codes.
 */
export const TargetTypeSchema = z
  .enum([
    'data_element',
    'domain',
    'data_definition',
    'message_class',
    'text_pool',
    'metadata_extension',
    'application_log_object',
    'business_configuration_object',
  ])
  .describe(
    'XCO translation target type: data_element (DTEL), domain (DOMA fixed-value texts), ' +
      'data_definition (CDS DDLS entity/field labels), message_class (MSAG), ' +
      'text_pool (class/function-group text symbols), metadata_extension (DDLX UI labels), ' +
      'application_log_object (APLO), business_configuration_object (SMBC).',
  );

export const LanguageSchema = z
  .string()
  .min(1)
  .max(2)
  .describe('Language — ISO 639-1 (EN, DE, FR…) or SAP SPRAS single-char code (E, D, F…)');

/**
 * Optional selectors read by the ABAP handler to disambiguate sub-objects within a target.
 * Only the ones relevant to a given target_type are used; the rest are ignored server-side.
 */
const SelectorShape = {
  field_name: z
    .string()
    .optional()
    .describe('CDS field name (data_definition / metadata_extension) to scope to a single field'),
  fixed_value: z.string().optional().describe('Domain fixed value (lower limit) — required for target_type=domain'),
  message_number: z.string().optional().describe('Message number — required for target_type=message_class'),
  text_symbol_id: z.string().optional().describe('Text symbol id (e.g. "001") — for target_type=text_pool'),
  text_pool_owner_type: z
    .enum(['class', 'function_group'])
    .optional()
    .describe('Owner of the text pool — class (default) or function_group'),
  subobject_name: z.string().optional().describe('Sub-object name (e.g. application-log sub-object)'),
  position: z
    .string()
    .optional()
    .describe('1-based position for repeatable UI annotations (metadata_extension). Sent as a string.'),
} as const;

// ─── Tool input schemas ───────────────────────────────────────────────────────

export const ListLanguagesSchema = z.object({});

export const GetTranslationSchema = z.object({
  target_type: TargetTypeSchema,
  object_name: z.string().min(1).describe('Technical name of the SAP object, e.g. ZCL_MY_CLASS'),
  language: LanguageSchema,
  ...SelectorShape,
});

export const SetTranslationSchema = z.object({
  target_type: TargetTypeSchema,
  object_name: z.string().min(1).describe('Technical name of the SAP object'),
  language: LanguageSchema,
  transport: z.string().min(1).describe('Transport request number, e.g. K900001'),
  texts: z
    .array(
      z.object({
        attribute: z
          .string()
          .min(1)
          .describe(
            'XCO text attribute, e.g. short_field_label / medium_field_label / long_field_label / ' +
              'heading_field_label (data_element), endusertext_label (data_definition/metadata_extension), ' +
              'message_short_text (message_class), fixed_value_description (domain)',
          ),
        value: z.string().describe('Translated text value'),
      }),
    )
    .min(1)
    .describe('Array of text entries to write'),
  ...SelectorShape,
});

export const ListTextsSchema = z.object({
  target_type: TargetTypeSchema,
  object_name: z.string().min(1).describe('Technical name of the SAP object'),
  language: LanguageSchema.optional().describe('Optional source language to read texts in (defaults to system language)'),
  text_pool_owner_type: SelectorShape.text_pool_owner_type,
});

export const CompareTranslationsSchema = z.object({
  target_type: TargetTypeSchema.describe(
    'Target type to compare. Supported by compare_translations: data_element, data_definition, ' +
      'metadata_extension, domain, message_class.',
  ),
  object_name: z.string().min(1).describe('Technical name of the SAP object'),
  source_language: LanguageSchema.describe('Reference language (already translated), typically EN'),
  target_language: LanguageSchema.describe('Language to compare against (may be incomplete)'),
  position: SelectorShape.position,
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
      'Returns all text attributes with their translated values.',
    inputSchema: GetTranslationSchema,
  },
  TranslateSetTexts: {
    description:
      'Write or update translations for an SAP object. ' +
      'Provide the transport request and an array of { attribute, value } entries.',
    inputSchema: SetTranslationSchema,
  },
  TranslateListTexts: {
    description:
      'List all translatable text attributes of an SAP object (level, field, attribute, source value). ' +
      'Use this before TranslateGetTexts to discover which attributes exist.',
    inputSchema: ListTextsSchema,
  },
  TranslateCompare: {
    description:
      'Compare translations between a source and a target language for an SAP object. ' +
      'Returns per-field items with source_texts, target_texts and a has_difference flag.',
    inputSchema: CompareTranslationsSchema,
  },
} as const;

export type ToolName = keyof typeof TOOLS;
