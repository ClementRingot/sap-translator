/**
 * Single source of truth for the server version.
 *
 * `npm_package_version` is set by npm when the app is started via an npm script
 * (`npm start`, which is how the CF Node.js buildpack launches it). When the
 * compiled entrypoint is run directly (`node dist/index.js`) it is absent, so we
 * fall back to the literal — keep it in sync with package.json on release.
 */
export const VERSION = process.env.npm_package_version ?? '0.2.0';
