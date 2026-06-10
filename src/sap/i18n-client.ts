/**
 * HTTP client for zi18n_service.
 *
 * The service must be registered in SICF (transaction) on the SAP system.
 * By default the path is /sap/bc/http/sap/zi18n_service but it is overridable
 * via the SAP_I18N_SERVICE_PATH env var.
 *
 * Expected HTTP contract (adjust to match your ABAP implementation):
 *
 *   GET  {path}?action=LIST_LANGUAGES
 *   GET  {path}?action=GET_TRANSLATION&object_type=CLAS&object_name=ZCL_MY&language=DE
 *   POST {path}?action=SET_TRANSLATION
 *        body: { object_type, object_name, language, transport, texts: [{key,value},...] }
 *   GET  {path}?action=LIST_TEXTS&object_type=CLAS&object_name=ZCL_MY
 *   GET  {path}?action=COMPARE&object_type=CLAS&object_name=ZCL_MY&source_language=EN&target_language=DE
 *
 * All responses are expected to be JSON.
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

// ─── Response types ───────────────────────────────────────────────────────────

export interface SapLanguage {
  spras: string; // SAP language key (1 char)
  iso: string; // ISO 639-1 code
  description: string;
}

export interface TranslationText {
  key: string; // text key / field name / message number
  source: string; // original text (source language)
  translation: string; // translated text (target language), empty if missing
  type?: string; // SHORT | MEDIUM | LONG | HEADING for data elements
}

export interface TranslationResult {
  object_type: string;
  object_name: string;
  language: string;
  texts: TranslationText[];
}

export interface ComparisonResult {
  object_type: string;
  object_name: string;
  source_language: string;
  target_language: string;
  total: number;
  translated: number;
  missing: number;
  texts: TranslationText[];
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

async function httpGet<T>(conn: ResolvedConnection, path: string, params: Record<string, string>): Promise<T> {
  const url = buildUrl(conn.baseUrl, path, params);
  const { status, body } = await sapRequest(conn, 'GET', url);
  if (status < 200 || status >= 300) {
    throw new Error(`SAP HTTP ${status}: ${body.slice(0, 300)}`);
  }
  return JSON.parse(body) as T;
}

async function httpPost<T>(
  conn: ResolvedConnection,
  path: string,
  params: Record<string, string>,
  body: unknown,
): Promise<T> {
  const url = buildUrl(conn.baseUrl, path, params);
  const { status, body: respBody } = await sapRequest(conn, 'POST', url, JSON.stringify(body));
  if (status < 200 || status >= 300) {
    throw new Error(`SAP HTTP ${status}: ${respBody.slice(0, 300)}`);
  }
  return JSON.parse(respBody) as T;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export class I18nClient {
  constructor(
    private readonly config: Config,
    private readonly userJwt?: string,
  ) {}

  async listLanguages(): Promise<SapLanguage[]> {
    const conn = await resolveConnection(this.config, this.userJwt);
    return httpGet<SapLanguage[]>(conn, this.config.i18nServicePath, {
      action: 'LIST_LANGUAGES',
      ...(conn.sapClient ? { 'sap-client': conn.sapClient } : {}),
    });
  }

  async getTranslation(params: {
    object_type: string;
    object_name: string;
    language: string;
    field_name?: string;
  }): Promise<TranslationResult> {
    const conn = await resolveConnection(this.config, this.userJwt);
    return httpGet<TranslationResult>(conn, this.config.i18nServicePath, {
      action: 'GET_TRANSLATION',
      ...(conn.sapClient ? { 'sap-client': conn.sapClient } : {}),
      object_type: params.object_type,
      object_name: params.object_name,
      language: params.language,
      ...(params.field_name ? { field_name: params.field_name } : {}),
    });
  }

  async setTranslation(params: {
    object_type: string;
    object_name: string;
    language: string;
    transport: string;
    texts: Array<{ key: string; value: string }>;
  }): Promise<{ success: boolean; message: string }> {
    const conn = await resolveConnection(this.config, this.userJwt);
    return httpPost<{ success: boolean; message: string }>(
      conn,
      this.config.i18nServicePath,
      { action: 'SET_TRANSLATION', 'sap-client': this.config.sapClient },
      {
        object_type: params.object_type,
        object_name: params.object_name,
        language: params.language,
        transport: params.transport,
        texts: params.texts,
      },
    );
  }

  async listTexts(params: {
    object_type: string;
    object_name: string;
  }): Promise<TranslationText[]> {
    const conn = await resolveConnection(this.config, this.userJwt);
    return httpGet<TranslationText[]>(conn, this.config.i18nServicePath, {
      action: 'LIST_TEXTS',
      ...(conn.sapClient ? { 'sap-client': conn.sapClient } : {}),
      object_type: params.object_type,
      object_name: params.object_name,
    });
  }

  async compareTranslations(params: {
    object_type: string;
    object_name: string;
    source_language: string;
    target_language: string;
  }): Promise<ComparisonResult> {
    const conn = await resolveConnection(this.config, this.userJwt);
    return httpGet<ComparisonResult>(conn, this.config.i18nServicePath, {
      action: 'COMPARE',
      ...(conn.sapClient ? { 'sap-client': conn.sapClient } : {}),
      object_type: params.object_type,
      object_name: params.object_name,
      source_language: params.source_language,
      target_language: params.target_language,
    });
  }
}
