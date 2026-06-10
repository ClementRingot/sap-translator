export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFormat = 'text' | 'json';
export type McpTransport = 'http-streamable' | 'stdio';

export interface ApiKeyProfile {
  key: string;
  profile: 'viewer' | 'developer' | 'admin';
}

export interface XsuaaBinding {
  url: string;
  clientid: string;
  clientsecret: string;
  xsappname: string;
  uaadomain: string;
}

export interface Config {
  // SAP connectivity
  sapUrl: string | undefined;
  sapUsername: string | undefined;
  sapPassword: string | undefined;
  sapClient: string;
  btpDestination: string | undefined;
  // Used at runtime for per-user calls — passes the user JWT to BTP so it can generate
  // a SAML assertion for the backend (OAuth2SAMLBearerAssertion or PrincipalPropagation).
  btpPpDestination: string | undefined;

  // HTTP service path for zcl_i18n_service
  i18nServicePath: string;

  // MCP
  transport: McpTransport;
  port: number;

  // Logging
  logLevel: LogLevel;
  logFormat: LogFormat;

  // Auth
  apiKeys: ApiKeyProfile[];
  oidcIssuer: string | undefined;
  oidcAudience: string | undefined;
  xsuaaBinding: XsuaaBinding | undefined;
  // Dedicated DCR signing secret — survives `cf deploy` (which rotates the XSUAA
  // clientsecret). When unset, the DCR store falls back to the clientsecret.
  dcrSigningSecret: string | undefined;
  // Lifetime of issued DCR client_ids in seconds. 0 disables expiration.
  oauthDcrTtlSeconds: number | undefined;

  // Rate limiting
  mcpRateLimitPerMinute: number;
  oauthRateLimitPerMinute: number;

  // CORS
  corsAllowedOrigins: string[];
}
