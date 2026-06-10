import type { ApiKeyProfile, Config, LogFormat, LogLevel, McpTransport, XsuaaBinding } from './types.js';

function env(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function parseApiKeys(raw: string | undefined): ApiKeyProfile[] {
  if (!raw) return [];
  return raw.split(',').flatMap((entry) => {
    const [key, profile] = entry.trim().split(':');
    if (!key || !profile) return [];
    const p = profile as ApiKeyProfile['profile'];
    if (!['viewer', 'developer', 'admin'].includes(p)) return [];
    return [{ key, profile: p }];
  });
}

function parseXsuaaBinding(): XsuaaBinding | undefined {
  const vcap = env('VCAP_SERVICES');
  if (!vcap) return undefined;
  try {
    const services = JSON.parse(vcap) as Record<string, Array<{ credentials: XsuaaBinding }>>;
    const xsuaa = services['xsuaa']?.[0]?.credentials;
    if (!xsuaa?.url || !xsuaa?.clientid) return undefined;
    return xsuaa;
  } catch {
    return undefined;
  }
}

export function resolveConfig(): Config {
  const transport = (env('MCP_TRANSPORT') ?? 'http-streamable') as McpTransport;
  const btpDestination = env('SAP_BTP_DESTINATION');

  // When a BTP destination is configured, direct SAP creds are optional.
  // For local dev, SAP_URL + credentials are required.
  const sapUrl = env('SAP_URL');
  const sapUsername = env('SAP_USERNAME');
  const sapPassword = env('SAP_PASSWORD');

  if (!btpDestination && !sapUrl) {
    throw new Error(
      'Either SAP_BTP_DESTINATION (BTP deployment) or SAP_URL + SAP_USERNAME + SAP_PASSWORD (local dev) must be configured.',
    );
  }

  return {
    sapUrl,
    sapUsername,
    sapPassword,
    sapClient: env('SAP_CLIENT') ?? '000',
    btpDestination,
    btpPpDestination: env('SAP_BTP_PP_DESTINATION'),

    i18nServicePath: env('SAP_I18N_SERVICE_PATH') ?? '/sap/bc/http/sap/zi18n_service',

    transport,
    port: Number(env('PORT') ?? 8080),

    logLevel: (env('LOG_LEVEL') ?? 'info') as LogLevel,
    logFormat: (env('LOG_FORMAT') ?? (transport === 'http-streamable' ? 'json' : 'text')) as LogFormat,

    apiKeys: parseApiKeys(env('SAP_API_KEYS')),
    oidcIssuer: env('OIDC_ISSUER'),
    oidcAudience: env('OIDC_AUDIENCE'),
    xsuaaBinding: parseXsuaaBinding(),
    dcrSigningSecret: env('SAP_TRANSLATOR_DCR_SIGNING_SECRET'),
    oauthDcrTtlSeconds: env('SAP_OAUTH_DCR_TTL_SECONDS') ? Number(env('SAP_OAUTH_DCR_TTL_SECONDS')) : undefined,

    mcpRateLimitPerMinute: Number(env('MCP_RATE_LIMIT') ?? 600),
    oauthRateLimitPerMinute: Number(env('OAUTH_RATE_LIMIT') ?? 20),

    corsAllowedOrigins:
      env('CORS_ORIGINS')
        ?.split(',')
        .map((o) => o.trim()) ?? [],
  };
}
