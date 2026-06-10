/**
 * HTTP Streamable transport for the MCP server.
 * Authentication: XSUAA OAuth proxy | OIDC/JWT | API keys
 *
 * Route map:
 *   GET  /health          — unauthenticated liveness probe
 *   POST /mcp             — MCP Streamable HTTP (rate-limited, bearer-auth)
 *   *    /authorize etc.  — OAuth endpoints via mcpAuthRouter (XSUAA mode only)
 *   *    /.well-known/…   — OAuth metadata discovery
 */

import { randomUUID } from 'node:crypto';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import cors from 'cors';
import express, { type Request, type Response, type NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { registerTranslationTools } from '../handlers/intent.js';
import { getLogger, requestContext } from './logger.js';
import type { OAuthStateCodec } from './oauth-state.js';
import type { StatelessDcrClientStore } from './stateless-client-store.js';
import type { Config } from './types.js';
import {
  createChainedTokenVerifier,
  createOidcVerifier,
  createXsuaaOAuthProvider,
  createXsuaaTokenVerifier,
} from './xsuaa.js';

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/**
 * Native loopback callbacks (MCP Inspector, GitHub Copilot) tear down their
 * ephemeral listener on failure, so a 302 to a dead port shows a blank
 * ERR_CONNECTION_REFUSED. For those we render a self-hosted error page instead.
 */
function isLoopbackHttpRedirect(url: URL): boolean {
  if (url.protocol !== 'http:') return false;
  const host = url.hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

function renderOAuthErrorPage(error: string, errorDescription: string, clientReturnUrl: string): string {
  const hint = 'Retry the sign-in from your MCP client. If it keeps failing, share this error with your administrator.';
  const descBlock = errorDescription ? `<p><code>${escapeHtml(errorDescription)}</code></p>` : '';
  return (
    '<!doctype html><html><head><meta charset="utf-8"><title>SAP Translator sign-in failed</title></head>' +
    '<body style="font-family:sans-serif;max-width:42rem;margin:3rem auto;padding:0 1rem;line-height:1.5">' +
    '<h1>SAP Translator sign-in failed</h1>' +
    `<p><strong>Error:</strong> <code>${escapeHtml(error)}</code></p>` +
    descBlock +
    `<p>${escapeHtml(hint)}</p>` +
    `<p><a href="${escapeHtml(clientReturnUrl)}">Return to your application</a></p>` +
    '</body></html>'
  );
}

/**
 * Express handler for `/oauth/callback`, the second half of the XSUAA callback
 * proxy that fixes the `+`-in-state bug. XSUAA redirects here (not to the
 * client) with an opaque base64url `state` token that `authorize()` minted. We
 * verify + decode it to recover the client's ORIGINAL `redirect_uri` and
 * `state`, then 302 to the client re-emitting the state via `URL.searchParams`
 * (which encodes `+` as `%2B`).
 *
 * SECURITY (authorization-code interception): the signed state carries the
 * originating DCR `client_id`. Before forwarding the code (or error) to the
 * recovered `redirect_uri`, we verify that redirect_uri is actually registered
 * for that client (`clientStore.checkRedirectUri`). Fails CLOSED on any error.
 */
export function createOAuthCallbackHandler(stateCodec: OAuthStateCodec, clientStore?: StatelessDcrClientStore) {
  return async (req: Request, res: Response): Promise<void> => {
    const log = getLogger();
    const stateToken = typeof req.query.state === 'string' ? req.query.state : '';
    const decoded = stateCodec.decode(stateToken);
    if (decoded.kind !== 'ok') {
      log.warn('OAuth callback: invalid state token', { reason: decoded.reason });
      res
        .status(400)
        .type('html')
        .send(
          '<!doctype html><html><body style="font-family:sans-serif;padding:2rem">' +
            '<h1>Authentication failed</h1>' +
            '<p>The OAuth state token was invalid or expired. Please retry the sign-in from your MCP client.</p>' +
            '</body></html>',
        );
      return;
    }

    // ── Client-binding validation (authorization-code interception defense) ──
    if (clientStore && decoded.clientId) {
      let verdict: 'ok' | 'unknown_client' | 'unregistered';
      try {
        verdict = await clientStore.checkRedirectUri(decoded.clientId, decoded.clientRedirectUri);
      } catch (err) {
        log.warn('OAuth callback: redirect_uri check threw — failing closed', {
          clientId: decoded.clientId,
          error: err instanceof Error ? err.message : String(err),
        });
        verdict = 'unknown_client';
      }
      if (verdict !== 'ok') {
        log.warn('OAuth callback: redirect_uri rejected for client', {
          clientId: decoded.clientId,
          verdict,
        });
        res
          .status(400)
          .type('html')
          .send(
            '<!doctype html><html><body style="font-family:sans-serif;padding:2rem">' +
              '<h1>Authentication failed</h1>' +
              '<p>The redirect URI in the state token is not valid for this client. Please retry the sign-in.</p>' +
              '</body></html>',
          );
        return;
      }
    }

    let target: URL;
    try {
      target = new URL(decoded.clientRedirectUri);
    } catch {
      log.warn('OAuth callback: stored redirect_uri is not a valid URL');
      res.status(400).type('html').send('<!doctype html><html><body>Invalid redirect target.</body></html>');
      return;
    }

    // On error there is no code. Forward to the client per spec — except for
    // loopback HTTP callbacks (render a self-hosted page instead).
    const error = typeof req.query.error === 'string' ? req.query.error : undefined;
    if (error) {
      const errorDescription = typeof req.query.error_description === 'string' ? req.query.error_description : '';
      if (decoded.clientState !== undefined) target.searchParams.set('state', decoded.clientState);
      target.searchParams.set('error', error);
      if (errorDescription) target.searchParams.set('error_description', errorDescription);
      const loopback = isLoopbackHttpRedirect(target);
      log.warn('OAuth callback: identity provider returned an error', {
        error,
        errorDescriptionPreview: errorDescription.slice(0, 200),
        clientRedirectUriHost: target.host,
        loopback,
      });
      if (loopback) {
        res
          .status(400)
          .type('html')
          .send(renderOAuthErrorPage(error, errorDescription, target.toString()));
      } else {
        res.redirect(302, target.toString());
      }
      return;
    }

    // Success: forward the code, re-attaching the client's ORIGINAL state.
    // URLSearchParams serialization encodes `+` as `%2B`, fixing the round-trip.
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    target.searchParams.set('code', code);
    if (decoded.clientState !== undefined) target.searchParams.set('state', decoded.clientState);

    log.debug('OAuth callback: redirecting to client', {
      clientRedirectUriHost: target.host,
      hasState: decoded.clientState !== undefined,
    });
    res.redirect(302, target.toString());
  };
}

const VERSION = process.env.npm_package_version ?? '0.1.0';

// CF injects VCAP_APPLICATION with the app's public routes.
// Falls back to localhost for local dev.
function resolvePublicUrl(port: number): URL {
  try {
    const vcap = process.env.VCAP_APPLICATION;
    if (vcap) {
      const app = JSON.parse(vcap) as { application_uris?: string[] };
      const host = app.application_uris?.[0];
      if (host) return new URL(`https://${host}`);
    }
  } catch {
    // ignore parse errors
  }
  return new URL(`http://localhost:${port}`);
}

export function createHttpServer(config: Config): express.Application {
  const log = getLogger();
  const app = express();

  // ── Security middleware ────────────────────────────────────────────────────
  // Trust the first proxy hop (CF GoRouter) so rate-limit & IP detection work.
  app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: false }));
  app.disable('x-powered-by');

  if (config.corsAllowedOrigins.length > 0) {
    app.use(
      cors({
        origin: config.corsAllowedOrigins,
        methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id'],
      }),
    );
  }

  app.use(express.json({ limit: '4mb' }));
  app.use(express.urlencoded({ extended: false }));

  // ── Request tracing ────────────────────────────────────────────────────────
  app.use((_req: Request, _res: Response, next: NextFunction) => {
    requestContext.run({ requestId: randomUUID().slice(0, 8) }, next);
  });

  // ── Health check ───────────────────────────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: VERSION, ts: new Date().toISOString() });
  });

  // ── Rate limiters ──────────────────────────────────────────────────────────
  const mcpLimiter = rateLimit({
    windowMs: 60_000,
    max: config.mcpRateLimitPerMinute,
    standardHeaders: true,
    legacyHeaders: false,
  });

  const oauthLimiter = rateLimit({
    windowMs: 60_000,
    max: config.oauthRateLimitPerMinute,
    standardHeaders: true,
    legacyHeaders: false,
  });

  // ── Chained token verifier (XSUAA → OIDC → API key) ───────────────────────
  const xsuaaVerifier = config.xsuaaBinding ? createXsuaaTokenVerifier(config.xsuaaBinding) : undefined;
  const oidcVerifier = config.oidcIssuer ? createOidcVerifier(config.oidcIssuer, config.oidcAudience) : undefined;
  const verifyToken = createChainedTokenVerifier({ apiKeys: config.apiKeys }, xsuaaVerifier, oidcVerifier);

  // ── XSUAA OAuth proxy (stateless DCR + callback proxy) ────────────────────
  if (config.xsuaaBinding) {
    const serverUrl = resolvePublicUrl(config.port);
    const appUrl = serverUrl.toString().replace(/\/$/, '');
    const callbackUrl = `${appUrl}/oauth/callback`;

    const { provider, clientStore, stateCodec } = createXsuaaOAuthProvider(config.xsuaaBinding, appUrl, {
      dcrTtlSeconds: config.oauthDcrTtlSeconds,
      dcrSigningSecret: config.dcrSigningSecret,
      callbackUrl,
    });

    // Auto-register a candidate redirect_uri for the pre-registered XSUAA client
    // before the SDK's exact-match check on /authorize (gated by the allowlist
    // inside ensureRedirectUri). Mounted before mcpAuthRouter so it runs first.
    app.use('/authorize', oauthLimiter, (req: Request, _res: Response, next: NextFunction) => {
      const params = req.method === 'POST' ? req.body : req.query;
      const clientId = params?.client_id;
      const redirectUri = params?.redirect_uri;
      if (clientId && typeof redirectUri === 'string') {
        clientStore.ensureRedirectUri(clientId, redirectUri);
      }
      next();
    });

    // Callback proxy (issue #214): XSUAA redirects HERE with our opaque state
    // token; we decode it, validate the client binding, and forward to the real
    // client redirect_uri re-emitting the original state with correct encoding.
    app.get('/oauth/callback', oauthLimiter, createOAuthCallbackHandler(stateCodec, clientStore));

    app.use(
      oauthLimiter,
      mcpAuthRouter({
        provider,
        issuerUrl: serverUrl,
        resourceServerUrl: new URL('/mcp', serverUrl),
        scopesSupported: [],
        resourceName: 'SAP Translator MCP',
      }),
    );
  }

  const authRequired =
    config.apiKeys.length > 0 || config.xsuaaBinding !== undefined || config.oidcIssuer !== undefined;

  // ── MCP endpoint ───────────────────────────────────────────────────────────
  app.post('/mcp', mcpLimiter, async (req: Request, res: Response) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;

    let sub: string | undefined;

    if (token) {
      try {
        const verified = await verifyToken(token);
        sub = (verified.extra?.userName as string | undefined) ?? verified.clientId;
      } catch (e) {
        log.warn('Token verification failed', { err: (e as Error).message });
        res.status(401).json({ error: 'unauthorized', message: 'Invalid or expired token' });
        return;
      }
    } else if (authRequired) {
      res.status(401).json({ error: 'unauthorized', message: 'Bearer token required' });
      return;
    }

    requestContext.run({ requestId: randomUUID().slice(0, 8), user: sub }, async () => {
      // Per-request server + transport pattern avoids "already connected" errors.
      const server = new McpServer({ name: 'sap-translator', version: VERSION });
      // Pass the raw bearer token so the SAP client can use principal propagation
      registerTranslationTools(server, config, token);

      // Stateless mode (sessionIdGenerator: undefined): each request is
      // self-contained. Required for the per-request server pattern — a stateful
      // transport would assign a Mcp-Session-Id on `initialize` that the next
      // request's fresh transport wouldn't recognise, breaking tools/list (400).
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (e) {
        log.error('MCP request error', { err: (e as Error).message });
        if (!res.headersSent) {
          res.status(500).json({ error: 'internal_error' });
        }
      } finally {
        await transport.close();
        await server.close();
      }
    });
  });

  return app;
}

export async function startHttpServer(config: Config): Promise<void> {
  const log = getLogger();
  const app = createHttpServer(config);

  await new Promise<void>((resolve) => {
    app.listen(config.port, () => {
      log.info('SAP Translator MCP server listening', { port: config.port, transport: 'http-streamable' });
      resolve();
    });
  });
}
