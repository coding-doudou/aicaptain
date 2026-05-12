/**
 * Captains Quiz API — logs every attempt; one completion per @maersk.com email + Maersk ID.
 * Optional Azure AD (Entra ID) SSO: set AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET,
 * SESSION_SECRET. Register redirect URI {BASE_URL}/auth/callback for each deployment host.
 * Behind Maersk MDP API Proxy with base path /aicaptains: set PUBLIC_BASE_PATH=/aicaptains if the
 * proxy forwards that prefix to this app (omit if the proxy strips it). Set BASE_URL to the full
 * public origin including path when using Azure SSO (e.g. https://api-cdt.maersk.com/aicaptains).
 * Admin dashboard: GET/DELETE with X-Admin-Key.
 */
const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const session = require("express-session");
const { generators, isConfigured: azureAuthConfigured, getClient: getOidcClient } = require("./azure-auth");

const PORT = Number(process.env.PORT) || 8080;
const ADMIN_KEY = process.env.ADMIN_KEY || "maersk2025";
const ROOT = path.join(__dirname, "..");
const DATA = path.join(__dirname, "data");
const ATTEMPTS_FILE = path.join(DATA, "attempts.jsonl");
const PARTICIPANTS_FILE = path.join(DATA, "participants.json");

/** MDP / reverse-proxy path prefix (no trailing slash), e.g. /aicaptains — only if upstream sends it. */
const PUBLIC_BASE = String(process.env.PUBLIC_BASE_PATH || "").trim().replace(/\/$/, "");
const QUIZ_PAGE = `${PUBLIC_BASE}/aicaptain.html`;

const app = express();
app.set("trust proxy", 1);
app.use(cors({ origin: true }));
app.use(express.json({ limit: "2mb" }));

if (PUBLIC_BASE) {
  app.use((req, _res, next) => {
    const u = req.url;
    const qi = u.indexOf("?");
    const pathOnly = qi === -1 ? u : u.slice(0, qi);
    const query = qi === -1 ? "" : u.slice(qi);
    if (pathOnly === PUBLIC_BASE || pathOnly.startsWith(`${PUBLIC_BASE}/`)) {
      const rest = pathOnly.slice(PUBLIC_BASE.length) || "/";
      req.url = rest + query;
    }
    next();
  });
}

function useAzureSso() {
  return azureAuthConfigured();
}

function oauthBaseUrl(req) {
  if (process.env.BASE_URL) return String(process.env.BASE_URL).replace(/\/$/, "");
  const proto = req.get("x-forwarded-proto") || req.protocol;
  return `${proto}://${req.get("host")}`;
}

function safeReturnPath(raw) {
  const fallback = QUIZ_PAGE;
  if (!raw || typeof raw !== "string") return fallback;
  const s = raw.trim();
  if (!s.startsWith("/") || s.startsWith("//")) return fallback;
  return s;
}

function sessionEmail(req) {
  const u = req.session && req.session.user;
  return u && u.email ? normalizeEmail(u.email) : "";
}

if (useAzureSso()) {
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    console.warn("Azure SSO enabled but SESSION_SECRET is unset — using a dev default (set SESSION_SECRET in production).");
  }
  app.use(
    session({
      name: "captains.sid",
      secret: sessionSecret || "captains-dev-session-secret-change-me",
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.COOKIE_SECURE === "1",
        maxAge: 24 * 60 * 60 * 1000,
      },
    })
  );

  app.get("/auth/login", async (req, res, next) => {
    try {
      const base = oauthBaseUrl(req);
      const redirectUri = `${base}/auth/callback`;
      req.session.oidcRedirectUri = redirectUri;
      req.session.oidcReturnTo = safeReturnPath(req.query.return_to);
      const client = await getOidcClient(redirectUri);
      const nonce = generators.nonce();
      const state = generators.state();
      req.session.oidc = { nonce, state };
      const url = client.authorizationUrl({
        scope: "openid profile email",
        state,
        nonce,
      });
      res.redirect(url);
    } catch (e) {
      next(e);
    }
  });

  app.get("/auth/callback", async (req, res, next) => {
    try {
      const redirectUri = req.session.oidcRedirectUri;
      if (!redirectUri || !req.session.oidc) {
        return res.status(400).send("OAuth session missing — try signing in again.");
      }
      const client = await getOidcClient(redirectUri);
      const params = client.callbackParams(req);
      const checks = { nonce: req.session.oidc.nonce, state: req.session.oidc.state };
      const tokenSet = await client.callback(redirectUri, params, checks);
      delete req.session.oidc;
      delete req.session.oidcRedirectUri;

      let claims = typeof tokenSet.claims === "function" ? tokenSet.claims() : {};
      let email = claims.email;
      if (!email && claims.preferred_username && String(claims.preferred_username).includes("@")) {
        email = claims.preferred_username;
      }
      if (!email && tokenSet.access_token) {
        try {
          const ui = await client.userinfo(tokenSet.access_token);
          email = ui.email || ui.preferred_username;
        } catch {
          /* ignore */
        }
      }
      email = normalizeEmail(email || "");
      if (!email || !isAllowedMaerskEmail(email)) {
        req.session.destroy(() => {});
        return res
          .status(403)
          .send(
            `<p>Only @maersk.com work accounts can take this quiz.</p><p><a href="${QUIZ_PAGE}">Back</a></p>`
          );
      }

      req.session.user = {
        sub: claims.sub || "",
        email,
        name: claims.name || email,
      };
      const dest = req.session.oidcReturnTo || QUIZ_PAGE;
      delete req.session.oidcReturnTo;
      res.redirect(302, dest);
    } catch (e) {
      next(e);
    }
  });

  app.get("/auth/logout", (req, res) => {
    const dest = safeReturnPath(req.query.return_to);
    req.session.destroy(() => {
      res.redirect(302, dest);
    });
  });
}

function ensureDataDir() {
  if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
}

function normalizeEmail(s) {
  return String(s || "").trim().toLowerCase();
}

function normalizeMaerskId(s) {
  return String(s || "").trim().toLowerCase();
}

/** One completion per email + Maersk ID pair */
function fingerprint(email, maerskId) {
  return `${normalizeEmail(email)}::${normalizeMaerskId(maerskId)}`;
}

function isAllowedMaerskEmail(email) {
  const e = normalizeEmail(email);
  if (!e.endsWith("@maersk.com")) return false;
  const local = e.slice(0, e.indexOf("@"));
  return local.length >= 1 && /^[a-z0-9._%+-]+$/.test(local);
}

/** e.g. dba254 — letters then digits */
function isMaerskIdShape(id) {
  return /^[a-z]{2,8}\d{2,10}$/.test(normalizeMaerskId(id));
}

function loadParticipantsSet() {
  ensureDataDir();
  try {
    const raw = fs.readFileSync(PARTICIPANTS_FILE, "utf8");
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function saveParticipantsSet(set) {
  ensureDataDir();
  fs.writeFileSync(PARTICIPANTS_FILE, JSON.stringify([...set], null, 0), "utf8");
}

function appendAttempt(record) {
  ensureDataDir();
  const line = JSON.stringify(record) + "\n";
  fs.appendFileSync(ATTEMPTS_FILE, line, "utf8");
}

function readAllAttempts() {
  ensureDataDir();
  if (!fs.existsSync(ATTEMPTS_FILE)) return [];
  const text = fs.readFileSync(ATTEMPTS_FILE, "utf8");
  const out = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* skip corrupt line */
    }
  }
  return out;
}

function adminAuth(req, res, next) {
  const key = req.get("X-Admin-Key");
  if (!key || key !== ADMIN_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

const rateLast = new Map();
const RATE_MS = 1500;

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "captains-quiz-api", authMode: useAzureSso() ? "azure" : "legacy" });
});

/** MDP / K8s probes often expect `/health` (see service Health Check path). */
app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, service: "captains-quiz-api" });
});

app.get("/api/me", (req, res) => {
  if (!useAzureSso()) {
    return res.json({ authMode: "legacy", user: null });
  }
  if (!req.session || !req.session.user) {
    return res.json({ authMode: "azure", user: null, loginPath: "/auth/login" });
  }
  res.json({
    authMode: "azure",
    user: {
      email: req.session.user.email,
      name: req.session.user.name || req.session.user.email,
      sub: req.session.user.sub || "",
    },
  });
});

/** One-shot check (same fingerprint as client localStorage). With Azure SSO, email comes from the session. */
app.get("/api/participation", (req, res) => {
  let email;
  const maerskId = req.query.mid ?? req.query.m ?? "";
  if (useAzureSso()) {
    email = sessionEmail(req);
    if (!email) {
      return res.status(401).json({ error: "sign_in_required", loginPath: "/auth/login" });
    }
  } else {
    email = req.query.email ?? req.query.e ?? "";
  }
  if (!normalizeEmail(email) || !normalizeMaerskId(maerskId)) {
    return res.status(400).json({ error: useAzureSso() ? "mid required" : "email and mid required" });
  }
  if (!isAllowedMaerskEmail(email) || !isMaerskIdShape(maerskId)) {
    return res.status(400).json({ error: "invalid email or Maersk ID format" });
  }
  const fp = fingerprint(email, maerskId);
  const done = loadParticipantsSet().has(fp);
  res.json({ completed: done, fingerprint: fp });
});

app.post("/api/attempts", (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const last = rateLast.get(ip) || 0;
  if (now - last < RATE_MS) {
    return res.status(429).json({ error: "Too many requests" });
  }
  rateLast.set(ip, now);

  const body = req.body;
  if (!body || typeof body !== "object") {
    return res.status(400).json({ error: "Invalid body" });
  }
  const { maerskId, id, ts, totalCorrect, totalQuestions } = body;
  let email = typeof body.email === "string" ? body.email : "";
  if (useAzureSso()) {
    const se = sessionEmail(req);
    if (!se) {
      return res.status(401).json({ error: "sign_in_required", loginPath: "/auth/login" });
    }
    email = se;
  } else {
    if (typeof email !== "string" || !email) {
      return res.status(400).json({ error: "Missing id, ts, email, or maerskId" });
    }
  }
  if (!id || !ts || typeof maerskId !== "string") {
    return res.status(400).json({ error: "Missing id, ts, or maerskId" });
  }
  if (typeof totalCorrect !== "number" || typeof totalQuestions !== "number") {
    return res.status(400).json({ error: "Invalid score fields" });
  }
  if (!isAllowedMaerskEmail(email) || !isMaerskIdShape(maerskId)) {
    return res.status(400).json({ error: "Invalid Maersk email or ID format" });
  }

  const fp = fingerprint(email, maerskId);
  const participants = loadParticipantsSet();
  if (participants.has(fp)) {
    return res.status(409).json({ error: "Already completed", code: "ALREADY_COMPLETED" });
  }

  participants.add(fp);
  saveParticipantsSet(participants);
  try {
    if (useAzureSso()) {
      body.email = email;
      body.name = email;
    }
    appendAttempt(body);
  } catch (e) {
    participants.delete(fp);
    saveParticipantsSet(participants);
    console.error(e);
    return res.status(500).json({ error: "Failed to persist attempt" });
  }

  res.status(201).json({ ok: true, id: body.id });
});

app.get("/api/attempts", adminAuth, (_req, res) => {
  const attempts = readAllAttempts();
  attempts.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  res.json({ attempts });
});

app.delete("/api/attempts", adminAuth, (_req, res) => {
  try {
    if (fs.existsSync(ATTEMPTS_FILE)) fs.unlinkSync(ATTEMPTS_FILE);
    if (fs.existsSync(PARTICIPANTS_FILE)) fs.unlinkSync(PARTICIPANTS_FILE);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Clear failed" });
  }
  res.json({ ok: true });
});

app.get("/", (_req, res) => {
  res.redirect(302, QUIZ_PAGE);
});

app.use(express.static(ROOT, { index: ["aicaptain.html"] }));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Server error" });
});

app.listen(PORT, "0.0.0.0", () => {
  ensureDataDir();
  console.log(`Captains Quiz API http://localhost:${PORT}`);
  console.log(`Quiz: http://localhost:${PORT}${QUIZ_PAGE}`);
  if (PUBLIC_BASE) {
    console.log(`PUBLIC_BASE_PATH active: requests should include prefix "${PUBLIC_BASE}" from the proxy.`);
  }
  if (useAzureSso()) {
    console.log("Azure AD SSO: enabled (set BASE_URL to match your app registration redirect URI host).");
  } else {
    console.log("Auth: legacy (email + Maersk ID in the form). Set AZURE_* + SESSION_SECRET for Microsoft sign-in.");
  }
  console.log(`Admin key: set ADMIN_KEY in env (default dev key matches quiz gate).`);
});
