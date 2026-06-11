/**
 * HTTP client for zi18n_service (ABAP handler class ZCL_I18N_SERVICE).
 *
 * The service must be registered in SICF (transaction) on the SAP system.
 * By default the path is /sap/bc/http/sap/zi18n_service but it is overridable
 * via the SAP_I18N_SERVICE_PATH env var.
 *
 * Wire contract — mirrors ZCL_I18N_SERVICE exactly:
 *   - The ACTION is the last segment of the URL path (handler reads `~path_info`),
 *     lowercase: list_languages | get_translation | set_translation | list_texts |
 *     compare_translations.
 *   - ALL parameters are sent in the JSON request BODY (handler reads `request->get_text()`
 *     and string-matches "name":"value"). We therefore POST every action with a JSON body.
 *   - Object kinds are the XCO semantic `target_type` literals (data_element, domain, …).
 *   - Every response is wrapped: { "success": true, "data": {…} } on success, or
 *     { "success": false, "error": { "code", "message" } } with HTTP 400 on failure.
 *
 *   POST {path}/list_languages       body: {}
 *   POST {path}/get_translation      body: { target_type, object_name, language, … }
 *   POST {path}/set_translation      body: { target_type, object_name, language, transport,
 *                                            texts: [{ attribute, value }, …], … }
 *   POST {path}/list_texts           body: { target_type, object_name, language? }
 *   POST {path}/compare_translations body: { target_type, object_name, source_language,
 *                                            target_language }
 */

import { Client, type Dispatcher, fetch as undiciFetch } from 'undici';
import type { Config } from '../server/types.js';
import {
  type BTPConfig,
  type BTPProxyConfig,
  createConnectivityProxy,
  lookupDestination,
  lookupDestinationWithUserToken,
  parseVCAPServices,
} from './btp.js';

// ─── Response types (match ZCL_I18N_SERVICE JSON exactly) ──────────────────────

/** Envelope every handler wraps its payload in (build_success / build_error). */
interface SapEnvelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

export interface SapLanguage {
  sap_code: string; // SAP language key (SPRAS, 1 char)
  iso_code: string; // ISO 639-1 code
  name: string; // language name
}

/** A single XCO text attribute/value pair (append_text_entry). */
export interface TextEntry {
  attribute: string;
  value: string;
}

/** list_texts entries carry extra level/field context (build_text_json_entry). */
export interface ListTextEntry extends TextEntry {
  level: string; // 'entity' | 'field' | …
  field_name: string; // empty for entity-level texts
}

export interface TranslationResult {
  target_type: string;
  object_name: string;
  language: string;
  texts: TextEntry[];
}

export interface ListTextsResult {
  target_type: string;
  object_name: string;
  language: string;
  texts: ListTextEntry[];
}

export interface SetTranslationResult {
  target_type: string;
  object_name: string;
  language: string;
  transport: string;
  success: boolean;
}

/** One comparison row: a field/key with its source and target texts. */
export interface ComparisonItem {
  field_or_key: string;
  source_texts: TextEntry[];
  target_texts: TextEntry[];
  has_difference: boolean;
}

export interface ComparisonResult {
  target_type: string;
  object_name: string;
  source_language: string;
  target_language: string;
  items: ComparisonItem[];
}

/** Optional selectors the handler reads to disambiguate sub-objects within a target. */
export interface I18nSelectors {
  field_name?: string;
  fixed_value?: string;
  message_number?: string;
  text_symbol_id?: string;
  text_pool_owner_type?: string;
  subobject_name?: string;
  position?: string;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

interface ResolvedConnection {
  baseUrl: string;
  headers: Record<string, string>;
  // Cloud Connector proxy — set only for OnPremise BTP destinations. When present, requests are
  // sent through it using standard HTTP forward-proxy (NOT CONNECT tunneling), the only protocol
  // the BTP connectivity proxy supports. Mirrors ARC-1's AdtHttpClient.doProxyRequest().
  proxy: BTPProxyConfig | null;
  // sap-client query param. From the destination on BTP, or SAP_CLIENT for local dev.
  sapClient?: string;
}

// ─── Cached BTP service bindings ──────────────────────────────────────────────
// Parsed once: VCAP_SERVICES is immutable for the app lifetime, and the connectivity proxy
// caches/refreshes its own token internally, so a single proxy instance must be reused.

let btpConfigCache: BTPConfig | null | undefined;
let proxyCache: BTPProxyConfig | null | undefined;

function getBtpConfig(): BTPConfig | null {
  if (btpConfigCache === undefined) btpConfigCache = parseVCAPServices();
  return btpConfigCache;
}

function getProxy(btpConfig: BTPConfig, proxyType: string, locationId?: string): BTPProxyConfig | null {
  if (proxyType !== 'OnPremise') return null;
  if (proxyCache === undefined) proxyCache = createConnectivityProxy(btpConfig, locationId);
  return proxyCache;
}

function basicAuth(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

async function resolveConnection(config: Config, userJwt?: string): Promise<ResolvedConnection> {
  if (config.btpDestination) {
    const btpConfig = getBtpConfig();
    if (!btpConfig) {
      throw new Error('SAP_BTP_DESTINATION is set but VCAP_SERVICES is unavailable. Running on BTP CF?');
    }

    const headers: Record<string, string> = { Accept: 'application/json' };

    // Principal propagation: when the user JWT is available AND a PP destination is configured,
    // resolve the destination per-user so BTP/Cloud Connector authenticate as the backend user.
    // Falls back to the BasicAuth (technical) destination otherwise — e.g. system-level calls.
    if (userJwt && config.btpPpDestination) {
      const { destination, authTokens } = await lookupDestinationWithUserToken(
        btpConfig,
        config.btpPpDestination,
        userJwt,
      );
      if (authTokens.sapConnectivityAuth) {
        headers['SAP-Connectivity-Authentication'] = authTokens.sapConnectivityAuth;
      } else if (authTokens.bearerToken) {
        headers.Authorization = `Bearer ${authTokens.bearerToken}`;
      } else if (destination.User && destination.Password) {
        headers.Authorization = basicAuth(destination.User, destination.Password);
      }
      return {
        baseUrl: destination.URL.replace(/\/$/, ''),
        headers,
        proxy: getProxy(btpConfig, destination.ProxyType, destination.CloudConnectorLocationId),
        sapClient: destination['sap-client'],
      };
    }

    const dest = await lookupDestination(btpConfig, config.btpDestination);
    if (dest.User && dest.Password) {
      headers.Authorization = basicAuth(dest.User, dest.Password);
    }
    return {
      baseUrl: dest.URL.replace(/\/$/, ''),
      headers,
      proxy: getProxy(btpConfig, dest.ProxyType, dest.CloudConnectorLocationId),
      sapClient: dest['sap-client'],
    };
  }

  // Local dev: direct connection (no principal propagation, no Cloud Connector proxy)
  if (!config.sapUrl) throw new Error('SAP_URL is required for local development');
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (config.sapUsername && config.sapPassword) {
    headers.Authorization = basicAuth(config.sapUsername, config.sapPassword);
  }
  return { baseUrl: config.sapUrl.replace(/\/$/, ''), headers, proxy: null, sapClient: config.sapClient };
}

function buildUrl(baseUrl: string, path: string, params: Record<string, string>): string {
  const url = new URL(baseUrl + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') url.searchParams.set(k, v);
  }
  return url.toString();
}

interface RawResponse {
  status: number;
  body: string;
}

/**
 * Send a request through the BTP connectivity proxy using standard HTTP forward-proxy
 * (RFC 7230): the full target URL is sent as the request path, with Proxy-Authorization
 * (connectivity token) and, for principal propagation, SAP-Connectivity-Authentication.
 *
 * The BTP connectivity proxy only supports standard proxying for HTTP targets — it returns
 * 405 on CONNECT tunneling, so undici's ProxyAgent cannot be used. Ported from ARC-1's
 * AdtHttpClient.doProxyRequest().
 */
async function doProxyRequest(
  proxy: BTPProxyConfig,
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<RawResponse> {
  const proxyOrigin = `${proxy.protocol}://${proxy.host}:${proxy.port}`;
  const proxyToken = await proxy.getProxyToken();

  const targetUrl = new URL(url);
  const hostHeader = targetUrl.port ? `${targetUrl.hostname}:${targetUrl.port}` : targetUrl.hostname;

  const proxyHeaders: Record<string, string> = {
    ...headers,
    Host: hostHeader,
    'Proxy-Authorization': `Bearer ${proxyToken}`,
  };
  // Required when several Cloud Connectors share the subaccount with different Location IDs.
  if (proxy.locationId) {
    proxyHeaders['SAP-Connectivity-SCC-Location_ID'] = proxy.locationId;
  }

  const client = new Client(proxyOrigin);
  try {
    const resp = await client.request({
      method: method as Dispatcher.HttpMethod,
      path: url, // full URL as path — standard HTTP forward-proxy protocol
      headers: proxyHeaders,
      body: body ?? undefined,
      signal: AbortSignal.timeout(120_000),
    });
    return { status: resp.statusCode, body: await resp.body.text() };
  } finally {
    await client.close();
  }
}

async function sapRequest(conn: ResolvedConnection, method: string, url: string, body?: string): Promise<RawResponse> {
  const headers = { ...conn.headers };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  if (conn.proxy) {
    return doProxyRequest(conn.proxy, url, method, headers, body);
  }

  const resp = await undiciFetch(url, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(120_000),
  });
  return { status: resp.status, body: await resp.text() };
}

/** Drop undefined/empty fields so we only send what the handler should parse. */
function compact(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0)) out[k] = v;
  }
  return out;
}

/**
 * POST an action to {servicePath}/{action} with a JSON body and unwrap the
 * { success, data, error } envelope. The ABAP action is the last path segment,
 * so it must be lowercase (list_languages, get_translation, …).
 */
async function callAction<T>(
  conn: ResolvedConnection,
  servicePath: string,
  action: string,
  body: Record<string, unknown>,
): Promise<T> {
  // sap-client stays a query param — it is consumed by the ICF framework, not the handler.
  const url = buildUrl(conn.baseUrl, `${servicePath}/${action}`, {
    ...(conn.sapClient ? { 'sap-client': conn.sapClient } : {}),
  });
  const { status, body: respBody } = await sapRequest(conn, 'POST', url, JSON.stringify(compact(body)));

  let envelope: SapEnvelope<T>;
  try {
    envelope = JSON.parse(respBody) as SapEnvelope<T>;
  } catch {
    throw new Error(`SAP HTTP ${status}: non-JSON response: ${respBody.slice(0, 300)}`);
  }

  if (!envelope.success || status < 200 || status >= 300) {
    const code = envelope.error?.code ?? `HTTP_${status}`;
    const message = envelope.error?.message ?? respBody.slice(0, 300);
    throw new Error(`SAP i18n error [${code}]: ${message}`);
  }
  if (envelope.data === undefined) {
    throw new Error('SAP i18n response had success=true but no data');
  }
  return envelope.data;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export class I18nClient {
  constructor(
    private readonly config: Config,
    private readonly userJwt?: string,
  ) {}

  private get path(): string {
    return this.config.i18nServicePath;
  }

  async listLanguages(): Promise<SapLanguage[]> {
    const conn = await resolveConnection(this.config, this.userJwt);
    const data = await callAction<{ languages: SapLanguage[] }>(conn, this.path, 'list_languages', {});
    return data.languages;
  }

  async getTranslation(
    params: {
      target_type: string;
      object_name: string;
      language: string;
    } & I18nSelectors,
  ): Promise<TranslationResult> {
    const conn = await resolveConnection(this.config, this.userJwt);
    return callAction<TranslationResult>(conn, this.path, 'get_translation', { ...params });
  }

  async setTranslation(
    params: {
      target_type: string;
      object_name: string;
      language: string;
      transport: string;
      texts: TextEntry[];
    } & I18nSelectors,
  ): Promise<SetTranslationResult> {
    const conn = await resolveConnection(this.config, this.userJwt);
    return callAction<SetTranslationResult>(conn, this.path, 'set_translation', { ...params });
  }

  async listTexts(
    params: {
      target_type: string;
      object_name: string;
      language?: string;
      text_pool_owner_type?: string;
    },
  ): Promise<ListTextsResult> {
    const conn = await resolveConnection(this.config, this.userJwt);
    return callAction<ListTextsResult>(conn, this.path, 'list_texts', { ...params });
  }

  async compareTranslations(params: {
    target_type: string;
    object_name: string;
    source_language: string;
    target_language: string;
    position?: string;
  }): Promise<ComparisonResult> {
    const conn = await resolveConnection(this.config, this.userJwt);
    return callAction<ComparisonResult>(conn, this.path, 'compare_translations', { ...params });
  }
}
