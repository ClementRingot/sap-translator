/**
 * XSUAA OAuth proxy for MCP-native clients.
 *
 * Ported from arc-1 (ClementRingot/arc-1, src/server/xsuaa.ts), adapted for
 * sap-translator's authentication-only model (no XSUAA scopes / role collections).
 *
 * Enables Claude Desktop, Cursor, VS Code, and MCP Inspector to authenticate
 * via BTP XSUAA using the MCP specification's OAuth discovery (RFC 8414).
 *
 * Uses the MCP SDK's ProxyOAuthServerProvider to delegate the OAuth flow to
 * XSUAA, and @sap/xssec for SAP-specific JWT validation.
 *
 * AUTHENTICATION ONLY — no MCP-level authorization. We do NOT define or enforce
 * XSUAA scopes / role collections. XSUAA proves WHO the user is; the resulting
 * JWT is propagated to SAP (principal propagation), and SAP's own authorization
 * objects decide what the user may read / write / translate. Any authenticated
 * principal can invoke every tool; SAP is the single source of truth for rights.
 *
 * Design:
 *   1. @sap/xssec for token validation (x5t, audience, offline JWKS).
 *   2. Stateless DCR client store (StatelessDcrClientStore): client_ids are
 *      HMAC-signed, so they survive restarts / pushes without a backing store.
 *   3. Callback proxy (OAuthStateCodec): authorize() sends XSUAA our OWN
 *      /oauth/callback + an opaque base64url state token, sidestepping XSUAA's
 *      literal-`+`-in-state bug.
 *   4. Chained token verifier: XSUAA → OIDC → API key, all on /mcp.
 */

import crypto from 'node:crypto';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { ProxyOAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/providers/proxyProvider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { XsuaaService } from '@sap/xssec';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { getLogger } from './logger.js';
import { OAuthStateCodec } from './oauth-state.js';
import { StatelessDcrClientStore } from './stateless-client-store.js';
import type { ApiKeyProfile, XsuaaBinding } from './types.js';

// ─── Types ───────────────────────────────────────────────────────────

/** OAuth token endpoint response shape */
interface TokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

/** XSUAA credentials from VCAP_SERVICES. Alias of {@link XsuaaBinding}. */
export type XsuaaCredentials = XsuaaBinding;

// ─── XSUAA Token Verifier ────────────────────────────────────────────

/**
 * Verify a JWT using @sap/xssec. Creates a security context and maps it to the
 * MCP SDK's AuthInfo. Authentication only — no scopes are extracted or enforced
 * (SAP decides rights downstream). `scopes` is left empty.
 */
export function createXsuaaTokenVerifier(credentials: XsuaaCredentials): (token: string) => Promise<AuthInfo> {
  const xsuaaService = new XsuaaService({
    clientid: credentials.clientid,
    clientsecret: credentials.clientsecret,
    url: credentials.url,
    xsappname: credentials.xsappname,
    uaadomain: credentials.uaadomain,
  });

  return async (token: string): Promise<AuthInfo> => {
    getLogger().debug('XSUAA token verification: creating security context');
    const securityContext = await xsuaaService.createSecurityContext(token, { jwt: token });

    const expiresAt = securityContext.token?.payload?.exp;

    const authInfo: AuthInfo = {
      token,
      clientId: securityContext.getClientId(),
      scopes: [],
      expiresAt: typeof expiresAt === 'number' ? expiresAt : undefined,
      extra: {
        userName: securityContext.getLogonName?.() ?? undefined,
        email: securityContext.getEmail?.() ?? undefined,
      },
    };
    getLogger().debug('XSUAA token verified', { clientId: authInfo.clientId, userName: authInfo.extra?.userName });
    return authInfo;
  };
}

// ─── OIDC Token Verifier (Entra ID / generic) ────────────────────────

/**
 * Build a verifier for a generic OIDC issuer (e.g. Entra ID). Validates the JWT
 * against the issuer's JWKS. Authentication only — no scopes extracted.
 */
export function createOidcVerifier(issuer: string, audience?: string): (token: string) => Promise<AuthInfo> {
  const issuerNorm = issuer.replace(/\/$/, '');
  if (!audience) {
    // Without an audience, jwtVerify only checks the issuer/signature — ANY token
    // that issuer minted (for any resource) is accepted. Set OIDC_AUDIENCE to bind
    // tokens to this server.
    getLogger().warn(
      'OIDC_AUDIENCE is not set — JWT audience is NOT validated. Any token from the configured issuer will be accepted regardless of its intended audience. Set OIDC_AUDIENCE to restrict tokens to this server.',
    );
  }
  let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

  return async (token: string): Promise<AuthInfo> => {
    if (!jwks) {
      const disc = (await fetch(`${issuerNorm}/.well-known/openid-configuration`).then((r) => r.json())) as {
        jwks_uri: string;
      };
      jwks = createRemoteJWKSet(new URL(disc.jwks_uri));
    }
    const { payload } = await jwtVerify(token, jwks, { issuer: issuerNorm, audience });
    return {
      token,
      clientId: String(payload.azp ?? payload.client_id ?? payload.sub ?? 'oidc'),
      scopes: [],
      expiresAt: typeof payload.exp === 'number' ? payload.exp : undefined,
      extra: { sub: payload.sub, iss: payload.iss },
    };
  };
}

// ─── API Key Matching Helper ─────────────────────────────────────────

/**
 * Constant-time string comparison. Hashes both sides to fixed-length digests so
 * `timingSafeEqual` (which throws on length mismatch) is safe, and so neither the
 * length nor the position of the first differing byte of an API key leaks via
 * timing. Mirrors the `timingSafeEqual` discipline used for HMAC signatures.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const ah = crypto.createHash('sha256').update(a).digest();
  const bh = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ah, bh);
}

function matchApiKeyFromConfig(config: { apiKeys?: ApiKeyProfile[] }, token: string): { clientId: string } | undefined {
  let match: { clientId: string } | undefined;
  if (config.apiKeys) {
    // Scan every entry (no early return) so loop timing doesn't reveal which key matched.
    for (const entry of config.apiKeys) {
      if (constantTimeEquals(token, entry.key)) {
        match = { clientId: `api-key:${entry.profile}` };
      }
    }
  }
  return match;
}

// ─── Chained Token Verifier ──────────────────────────────────────────

/**
 * Create a token verifier that chains XSUAA → OIDC → API key, in order.
 */
export function createChainedTokenVerifier(
  config: { apiKeys?: ApiKeyProfile[] },
  xsuaaVerifier?: (token: string) => Promise<AuthInfo>,
  oidcVerifier?: (token: string) => Promise<AuthInfo>,
): (token: string) => Promise<AuthInfo> {
  return async (token: string): Promise<AuthInfo> => {
    const tokenPreview = `${token.slice(0, 20)}...${token.slice(-10)}`;
    getLogger().debug('Chained token verifier: starting', { tokenPreview });

    if (xsuaaVerifier) {
      try {
        const result = await xsuaaVerifier(token);
        getLogger().debug('Chained token verifier: XSUAA succeeded', {
          clientId: result.clientId,
          scopes: result.scopes,
        });
        return result;
      } catch (err) {
        getLogger().debug('Chained token verifier: XSUAA failed, trying next', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (oidcVerifier) {
      try {
        const result = await oidcVerifier(token);
        getLogger().debug('Chained token verifier: OIDC succeeded', {
          clientId: result.clientId,
          scopes: result.scopes,
        });
        return result;
      } catch (err) {
        getLogger().debug('Chained token verifier: OIDC failed, trying next', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const apiKeyMatch = matchApiKeyFromConfig(config, token);
    if (apiKeyMatch) {
      getLogger().debug('Chained token verifier: API key matched', { clientId: apiKeyMatch.clientId });
      return {
        token,
        clientId: apiKeyMatch.clientId,
        scopes: [],
        // requireBearerAuth requires expiresAt — set to 1 year.
        expiresAt: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60,
        extra: {},
      };
    }

    getLogger().debug('Chained token verifier: all methods failed', { tokenPreview });
    throw new InvalidTokenError('Token validation failed: not a valid XSUAA, OIDC, or API key token');
  };
}

// ─── OAuth Provider ──────────────────────────────────────────────────

/**
 * XSUAA-proxying OAuth provider.
 *
 * Extends ProxyOAuthServerProvider to (a) replace the MCP client's local
 * client_id with the XSUAA service binding client_id when forwarding to XSUAA,
 * and (b) sit in the return path via the callback proxy so the client's `state`
 * survives XSUAA's literal-`+` bug.
 */
export class XsuaaProxyOAuthProvider extends ProxyOAuthServerProvider {
  private xsuaaClientId: string;
  private xsuaaClientSecret: string;
  private xsuaaTokenUrl: string;
  private xsuaaAuthUrl: string;
  private _localClientStore: StatelessDcrClientStore;
  /** Our own callback URL, sent to XSUAA as the redirect_uri so we sit in the
   *  return path and can re-encode the client's `state` correctly. */
  private callbackUrl: string;
  /** Signs/verifies the opaque, URL-safe state token sent to XSUAA. */
  private stateCodec: OAuthStateCodec;

  constructor(
    credentials: XsuaaCredentials,
    verifier: (token: string) => Promise<AuthInfo>,
    localClientStore: StatelessDcrClientStore,
    callbackUrl: string,
    stateCodec: OAuthStateCodec,
  ) {
    const authUrl = `${credentials.url}/oauth/authorize`;
    const tokenUrl = `${credentials.url}/oauth/token`;

    super({
      endpoints: {
        authorizationUrl: authUrl,
        tokenUrl: tokenUrl,
        revocationUrl: `${credentials.url}/oauth/revoke`,
      },
      verifyAccessToken: verifier,
      getClient: (clientId: string) => localClientStore.getClient(clientId),
    });

    this.xsuaaClientId = credentials.clientid;
    this.xsuaaClientSecret = credentials.clientsecret;
    this.xsuaaTokenUrl = tokenUrl;
    this.xsuaaAuthUrl = authUrl;
    this._localClientStore = localClientStore;
    this.callbackUrl = callbackUrl;
    this.stateCodec = stateCodec;
    this.skipLocalPkceValidation = true;
  }

  /**
   * Expose registerClient for DCR. The MCP SDK checks this to decide whether to
   * advertise registration_endpoint in OAuth metadata and handle POST /register.
   */
  override get clientsStore() {
    return this._localClientStore;
  }

  /**
   * Replace the MCP client's local client_id with the XSUAA service binding
   * client_id and route through our own callback (callback proxy).
   */
  override async authorize(
    _client: OAuthClientInformationFull,
    params: {
      state?: string;
      scopes?: string[];
      codeChallenge: string;
      redirectUri: string;
      resource?: URL;
    },
    res: { redirect(url: string): void },
  ): Promise<void> {
    const proxyState = this.stateCodec.encode({
      clientState: params.state,
      clientRedirectUri: params.redirectUri,
      clientId: _client.client_id,
    });

    const targetUrl = new URL(this.xsuaaAuthUrl);
    const searchParams = new URLSearchParams({
      client_id: this.xsuaaClientId, // XSUAA client, not the local DCR client
      response_type: 'code',
      redirect_uri: this.callbackUrl, // our callback, not the client's
      code_challenge: params.codeChallenge,
      code_challenge_method: 'S256',
      state: proxyState,
    });

    // No `scope` param: we don't define or request XSUAA scopes (authentication
    // only — SAP enforces rights). XSUAA issues an identity token regardless.
    if (params.resource) searchParams.set('resource', params.resource.toString());

    targetUrl.search = searchParams.toString();

    getLogger().debug('XSUAA authorize redirect (callback proxy)', {
      xsuaaClient: this.xsuaaClientId,
      clientRedirectUri: params.redirectUri,
      callbackUrl: this.callbackUrl,
    });

    res.redirect(targetUrl.toString());
  }

  /**
   * Exchange the authorization code using XSUAA credentials. The redirect_uri
   * MUST equal what was sent at authorize time — our callback, not the client's.
   */
  override async exchangeAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
    codeVerifier?: string,
    _redirectUri?: string,
  ) {
    getLogger().debug('XSUAA token exchange: authorization_code', { hasCodeVerifier: !!codeVerifier });
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code: authorizationCode,
      client_id: this.xsuaaClientId,
      client_secret: this.xsuaaClientSecret,
    });
    if (codeVerifier) params.set('code_verifier', codeVerifier);
    params.set('redirect_uri', this.callbackUrl);

    const response = await fetch(this.xsuaaTokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      getLogger().error('XSUAA token exchange failed', { status: response.status, body: text.slice(0, 200) });
      throw new Error(`XSUAA token exchange failed: ${response.status}`);
    }

    const data = (await response.json()) as TokenResponse;
    getLogger().debug('XSUAA token exchange: success', {
      tokenType: data.token_type,
      expiresIn: data.expires_in,
      hasRefreshToken: !!data.refresh_token,
      scope: data.scope,
    });
    return {
      access_token: data.access_token,
      token_type: data.token_type ?? 'bearer',
      expires_in: data.expires_in,
      refresh_token: data.refresh_token,
      scope: data.scope,
    };
  }

  /** Refresh using XSUAA credentials. */
  override async exchangeRefreshToken(_client: OAuthClientInformationFull, refreshToken: string, _scopes?: string[]) {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.xsuaaClientId,
      client_secret: this.xsuaaClientSecret,
    });

    const response = await fetch(this.xsuaaTokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!response.ok) {
      throw new Error(`XSUAA refresh token exchange failed: ${response.status}`);
    }

    const data = (await response.json()) as TokenResponse;
    return {
      access_token: data.access_token,
      token_type: data.token_type ?? 'bearer',
      expires_in: data.expires_in,
      refresh_token: data.refresh_token,
      scope: data.scope,
    };
  }

  /**
   * Revoke using XSUAA service credentials (Basic auth), consistent with the
   * other overrides. Declared as a property to match the base class.
   */
  override revokeToken = async (
    _client: OAuthClientInformationFull,
    request: { token: string; token_type_hint?: string },
  ): Promise<void> => {
    const revokeUrl = this.xsuaaTokenUrl.replace('/oauth/token', '/oauth/revoke');
    const params = new URLSearchParams({ token: request.token });
    if (request.token_type_hint) params.set('token_type_hint', request.token_type_hint);

    try {
      const response = await fetch(revokeUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from(`${this.xsuaaClientId}:${this.xsuaaClientSecret}`).toString('base64')}`,
        },
        body: params.toString(),
      });
      if (!response.ok) {
        getLogger().warn('XSUAA token revocation failed', { status: response.status, url: revokeUrl });
      } else {
        getLogger().debug('XSUAA token revoked successfully');
      }
    } catch (err) {
      getLogger().warn('XSUAA token revocation error', { error: err instanceof Error ? err.message : String(err) });
    }
  };
}

// ─── Provider Factory ────────────────────────────────────────────────

export interface CreateXsuaaOAuthProviderOptions {
  /** Lifetime of issued DCR client_ids in seconds. Falls back to the store's
   *  default (30 days). `0` disables expiration. */
  dcrTtlSeconds?: number;
  /**
   * Optional dedicated secret for HMAC-signing DCR client_ids. When set, the DCR
   * signing key derives from this secret instead of the XSUAA `clientsecret`.
   * Use this so cached client_ids survive `cf deploy` (which recreates the XSUAA
   * binding and rotates its clientsecret). Omit to fall back to the clientsecret.
   */
  dcrSigningSecret?: string;
  /** Our own OAuth callback URL. When omitted, falls back to `${appUrl}/oauth/callback`. */
  callbackUrl?: string;
}

export function createXsuaaOAuthProvider(
  credentials: XsuaaCredentials,
  appUrl: string,
  options: CreateXsuaaOAuthProviderOptions = {},
): { provider: XsuaaProxyOAuthProvider; clientStore: StatelessDcrClientStore; stateCodec: OAuthStateCodec } {
  // The signing secret defaults to the XSUAA `clientsecret`. The downside: MTA
  // `cf deploy` rotates the clientsecret — every redeploy invalidates every
  // cached client_id. To opt out, pass a dedicated secret via `dcrSigningSecret`
  // (e.g. SAP_TRANSLATOR_DCR_SIGNING_SECRET set with `cf set-env`, which survives
  // `cf deploy`). Empty / whitespace-only input falls back with a warning.
  const trimmedDcrSecret = options.dcrSigningSecret?.trim();
  let dcrSigningSecret: string;
  let dcrSigningSource: 'env' | 'xsuaa';
  if (trimmedDcrSecret) {
    dcrSigningSecret = trimmedDcrSecret;
    dcrSigningSource = 'env';
  } else {
    if (options.dcrSigningSecret !== undefined) {
      getLogger().warn(
        'SAP_TRANSLATOR_DCR_SIGNING_SECRET was set but is empty or whitespace-only — falling back to XSUAA clientsecret. Set a real secret with `openssl rand -base64 48` or unset the env var.',
      );
    }
    dcrSigningSecret = credentials.clientsecret;
    dcrSigningSource = 'xsuaa';
  }

  const clientStore = new StatelessDcrClientStore(credentials.clientid, credentials.clientsecret, dcrSigningSecret, {
    ttlSeconds: options.dcrTtlSeconds,
  });
  const verifier = createXsuaaTokenVerifier(credentials);

  // The state codec reuses the resolved signing secret (distinct KDF label keeps
  // the key spaces separate), so it inherits the same "survives cf deploy" property.
  const stateCodec = new OAuthStateCodec(dcrSigningSecret);

  const callbackUrl = options.callbackUrl ?? `${appUrl.replace(/\/$/, '')}/oauth/callback`;

  const provider = new XsuaaProxyOAuthProvider(credentials, verifier, clientStore, callbackUrl, stateCodec);

  getLogger().info('XSUAA OAuth provider created (stateless DCR + callback proxy)', {
    xsappname: credentials.xsappname,
    authorizationUrl: `${credentials.url}/oauth/authorize`,
    appUrl,
    callbackUrl,
    dcrTtlSeconds: options.dcrTtlSeconds,
    dcrSigningSource,
  });
  if (dcrSigningSource === 'env') {
    getLogger().info(
      'DCR signing key uses dedicated SAP_TRANSLATOR_DCR_SIGNING_SECRET — cached client_ids survive cf deploys that rotate the XSUAA clientsecret.',
    );
  }

  return { provider, clientStore, stateCodec };
}
