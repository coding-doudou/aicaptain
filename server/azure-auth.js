/**
 * Azure AD (Microsoft Entra ID) OIDC helpers — v2.0 endpoint.
 * Register an app: redirect URI must match {BASE_URL}/auth/callback (add each environment).
 */
const { Issuer, generators } = require("openid-client");

const tenantId = process.env.AZURE_TENANT_ID;
const clientId = process.env.AZURE_CLIENT_ID;
const clientSecret = process.env.AZURE_CLIENT_SECRET;

function isConfigured() {
  return !!(tenantId && clientId && clientSecret);
}

let issuerPromise = null;
const clientCache = new Map();

function getIssuer() {
  if (!issuerPromise) {
    issuerPromise = Issuer.discover(`https://login.microsoftonline.com/${tenantId}/v2.0`);
  }
  return issuerPromise;
}

/** One registered redirect URI per host you use (cached per exact redirect URI string). */
async function getClient(redirectUri) {
  if (clientCache.has(redirectUri)) return clientCache.get(redirectUri);
  const issuer = await getIssuer();
  const client = new issuer.Client({
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uris: [redirectUri],
    response_types: ["code"],
  });
  clientCache.set(redirectUri, client);
  return client;
}

module.exports = { generators, isConfigured, getClient };
