require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const CryptoJS = require('crypto-js');
const archiver = require('archiver');
const csv = require('csv-writer').createObjectCsvStringifier;
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const crypto = require('crypto');

const app = express();

// ====== CONFIGURATION ======
const GUMROAD_ACCESS_TOKEN = process.env.GUMROAD_ACCESS_TOKEN || 'GZGWE7-ZH93u7TAeQ5WZysdIfmnuiW1vKFqaqLTimNI';
const GUMROAD_API_BASE = process.env.GUMROAD_API_BASE || 'https://api.gumroad.com/v2';
const VALIDATION_SALT = process.env.VALIDATION_SALT || 'warriors-artillery-secure-salt-2025';
const ENCRYPTION_PASSWORD = process.env.ENCRYPTION_PASSWORD || 'MyClientPassword123!';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const PORT = process.env.PORT || 3002;
const EXPORT_TIMEOUT = parseInt(process.env.EXPORT_TIMEOUT) || 300000;
const EXPORT_MAX_ROWS = parseInt(process.env.EXPORT_MAX_ROWS) || 100000;
const APP_BASE = "warriors-artillery";
const DATABASE_URL = process.env.DATABASE_URL; // Set by Railway Postgres plugin

// Trial configuration
const TRIAL_ALLOWED_APPS = ['app2', 'app5', 'app6'];
const TRIAL_DURATION = 24 * 60 * 60 * 1000; // 24h

// Expected encrypted files
const expectedFiles = [
  { appId: 'app1', filename: 'emo.enc',   name: 'Emotion Tracker' },
  { appId: 'app2', filename: 'goals.enc', name: 'Goal Manager' },
  { appId: 'app3', filename: 'viz.enc',   name: 'Vision Board' },
  { appId: 'app4', filename: 'work.enc',  name: 'Work Monitor' },
  { appId: 'app5', filename: 'wall.enc',  name: 'Fire Quotes' },
  { appId: 'app6', filename: 'trial.enc', name: 'Trial App' }
];

// ====== MIDDLEWARE ======
app.use(compression());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());
app.use(express.static('public', {
  maxAge: '7d',        // browsers cache static assets for 7 days
  etag: true,
  lastModified: true
}));

// Rate limiting — protects license/trial endpoints from abuse
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests, please try again later.' }
});
const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, error: 'Too many attempts.' }
});
app.use('/api/', apiLimiter);
app.use('/api/activate', strictLimiter);
app.use('/api/admin/login', strictLimiter);

// ====== POSTGRESQL SETUP ======
// Uses connection pooling — handles thousands of concurrent requests
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL ? { rejectUnauthorized: false } : false, // Railway requires SSL
  max: 20,                // max pool size
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err.message);
});

// db helper — mirrors the old safeDbOperation API so all call sites stay the same
async function safeDbQuery(queryText, params = []) {
  const client = await pool.connect();
  try {
    const result = await client.query(queryText, params);
    return { success: true, data: result.rows, rowCount: result.rowCount };
  } catch (error) {
    console.error('DB query error:', error.message, '|', queryText.substring(0, 80));
    return { success: false, error: error.message, code: error.code };
  } finally {
    client.release();
  }
}

// Single-row convenience wrapper
async function safeDbGet(queryText, params = []) {
  const result = await safeDbQuery(queryText, params);
  if (!result.success) return result;
  return { success: true, data: result.data[0] || null };
}

// ====== TEMP & ENCRYPTED DIRS ======
const exportTempDir = './temp-exports';
if (!fs.existsSync(exportTempDir)) fs.mkdirSync(exportTempDir, { recursive: true });
const encryptedAppsDir = './encrypted-apps';
if (!fs.existsSync(encryptedAppsDir)) fs.mkdirSync(encryptedAppsDir, { recursive: true });

// ====== IN-MEMORY CACHES (small, bounded) ======
// Hardware data cache — evicted after 1 hour, max 10k entries
const hardwareDataCache = new Map();
const HARDWARE_CACHE_TTL = 60 * 60 * 1000;
const HARDWARE_CACHE_MAX = 10000;

function cacheHardwareData(fingerprint, hardwareData) {
  if (hardwareDataCache.size >= HARDWARE_CACHE_MAX) {
    // Evict oldest entry
    hardwareDataCache.delete(hardwareDataCache.keys().next().value);
  }
  hardwareDataCache.set(fingerprint, { data: { ...hardwareData }, ts: Date.now() });
}

function getCachedHardwareData(fingerprint) {
  const entry = hardwareDataCache.get(fingerprint);
  if (!entry) return null;
  if (Date.now() - entry.ts > HARDWARE_CACHE_TTL) {
    hardwareDataCache.delete(fingerprint);
    return null;
  }
  return entry.data;
}

// Decrypted file cache — avoids re-decrypting the same .enc file on every request
// Files only change when you re-deploy, so 1-hour TTL is safe
const decryptedFileCache = new Map();
const DECRYPTED_CACHE_TTL = 60 * 60 * 1000; // 1 hour

function getCachedDecryptedFile(cacheKey) {
  const entry = decryptedFileCache.get(cacheKey);
  if (!entry) return null;
  if (Date.now() - entry.ts > DECRYPTED_CACHE_TTL) {
    decryptedFileCache.delete(cacheKey);
    return null;
  }
  return entry.content;
}

function setCachedDecryptedFile(cacheKey, content) {
  decryptedFileCache.set(cacheKey, { content, ts: Date.now() });
}

// ====== BANDWIDTH TRACKING HELPER ======
function getResponseSize(data) {
  if (typeof data === 'string') return Buffer.byteLength(data, 'utf8');
  if (Buffer.isBuffer(data)) return data.length;
  if (typeof data === 'object') return Buffer.byteLength(JSON.stringify(data), 'utf8');
  return 0;
}

async function trackBandwidth(endpoint, requestType, bytesTransferred, options = {}) {
  const { licenseKey = null, systemFingerprint = null, isTrial = false, req = null } = options;
  const ip = req ? (req.ip || req.headers['x-forwarded-for'] || 'N/A') : 'N/A';
  
  // Fire-and-forget
  safeDbQuery(
    `INSERT INTO bandwidth_usage (endpoint, request_type, bytes_transferred, license_key, system_fingerprint, is_trial, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [endpoint, requestType, bytesTransferred, licenseKey, systemFingerprint, isTrial, ip]
  ).catch(() => {});
}

// ====== DATABASE INITIALIZATION ======
async function initializeDatabase() {
  try {
        console.log('🔍 Connecting to:', DATABASE_URL ? DATABASE_URL.substring(0, 50) + '...' : 'MISSING');
        
        // Test connection
        const client = await pool.connect();
        console.log('✅ Connected to PostgreSQL');
        client.release();
    await safeDbQuery(`
      CREATE TABLE IF NOT EXISTS licenses (
        id SERIAL PRIMARY KEY,
        gumroad_purchase_id TEXT UNIQUE,
        gumroad_email TEXT,
        license_key TEXT UNIQUE,
        system_fingerprint TEXT,
        product_id TEXT,
        product_name TEXT,
        product_permalink TEXT,
        purchase_date TEXT,
        price_cents INTEGER,
        currency TEXT,
        refunded INTEGER DEFAULT 0,
        activation_count INTEGER DEFAULT 0,
        max_activations INTEGER DEFAULT 1,
        gumroad_sale_data TEXT,
        notes TEXT,
        last_validation TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await safeDbQuery(`
      CREATE TABLE IF NOT EXISTS trials (
        fingerprint TEXT PRIMARY KEY,
        start_time BIGINT NOT NULL,
        end_time BIGINT NOT NULL,
        allowed_apps TEXT NOT NULL,
        is_valid BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await safeDbQuery(`
      CREATE TABLE IF NOT EXISTS server_logs (
        id SERIAL PRIMARY KEY,
        level TEXT,
        message TEXT,
        endpoint TEXT,
        ip_address TEXT,
        user_agent TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await safeDbQuery(`
      CREATE TABLE IF NOT EXISTS admin_logs (
        id SERIAL PRIMARY KEY,
        admin_action TEXT,
        target_id TEXT,
        target_type TEXT,
        details TEXT,
        ip_address TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await safeDbQuery(`
      CREATE TABLE IF NOT EXISTS admin_sessions (
        id SERIAL PRIMARY KEY,
        session_token TEXT UNIQUE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        expires_at TIMESTAMPTZ,
        last_activity TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Bandwidth tracking table
    await safeDbQuery(`
      CREATE TABLE IF NOT EXISTS bandwidth_usage (
        id SERIAL PRIMARY KEY,
        endpoint TEXT NOT NULL,
        request_type TEXT NOT NULL,
        bytes_transferred BIGINT NOT NULL,
        license_key TEXT,
        system_fingerprint TEXT,
        is_trial BOOLEAN DEFAULT FALSE,
        ip_address TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Indexes for fast lookups
    await safeDbQuery(`CREATE INDEX IF NOT EXISTS idx_licenses_key ON licenses(license_key)`);
    await safeDbQuery(`CREATE INDEX IF NOT EXISTS idx_licenses_fingerprint ON licenses(system_fingerprint)`);
    await safeDbQuery(`CREATE INDEX IF NOT EXISTS idx_logs_created ON server_logs(created_at DESC)`);
    await safeDbQuery(`CREATE INDEX IF NOT EXISTS idx_admin_sessions_token ON admin_sessions(session_token)`);
    await safeDbQuery(`CREATE INDEX IF NOT EXISTS idx_trials_end ON trials(end_time)`);
    await safeDbQuery(`CREATE INDEX IF NOT EXISTS idx_bandwidth_created ON bandwidth_usage(created_at DESC)`);
    await safeDbQuery(`CREATE INDEX IF NOT EXISTS idx_bandwidth_endpoint ON bandwidth_usage(endpoint)`);

    console.log('✅ PostgreSQL database initialized');
  } catch (error) {
    console.error('❌ Critical database initialization error:', error.message);
    process.exit(1);
  }
}

// ====== LOGGING ======
async function logServerActivity(level, message, endpoint = '', req = null) {
  const ip = req ? (req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress || 'N/A') : 'N/A';
  const userAgent = req ? (req.headers['user-agent'] || 'N/A') : 'N/A';
  // Fire-and-forget — never block a request for logging
  safeDbQuery(
    'INSERT INTO server_logs (level, message, endpoint, ip_address, user_agent) VALUES ($1,$2,$3,$4,$5)',
    [level, message, endpoint, ip, userAgent]
  ).catch(() => {});
  console.log(`[${new Date().toISOString()}] [${level}] ${message}`);
}

async function logAdminAction(action, targetId, targetType, details, req) {
  const ip = req ? (req.ip || req.headers['x-forwarded-for'] || 'N/A') : 'N/A';
  safeDbQuery(
    'INSERT INTO admin_logs (admin_action, target_id, target_type, details, ip_address) VALUES ($1,$2,$3,$4,$5)',
    [action, targetId, targetType, JSON.stringify(details), ip]
  ).catch(() => {});
  console.log(`🔧 ADMIN ACTION: ${action} on ${targetType} ${targetId}`);
}

// ====== BANDWIDTH TRACKING MIDDLEWARE ======
// Skip tracking for lightweight or non-user endpoints to reduce DB writes
const SKIP_BANDWIDTH_TRACKING = new Set(['/health', '/', '/api/generate-fingerprint', '/api/debug', '/api/admin/bandwidth-stats']);

app.use((req, res, next) => {
  if (SKIP_BANDWIDTH_TRACKING.has(req.path)) return next();
  const originalJson = res.json;
  const originalSend = res.send;
  
  res.json = function(data) {
    const responseSize = getResponseSize(data);
    trackBandwidth(req.path, 'api', responseSize, { req }).catch(() => {});
    return originalJson.call(this, data);
  };
  
  res.send = function(data) {
    const responseSize = getResponseSize(data);
    trackBandwidth(req.path, 'api', responseSize, { req }).catch(() => {});
    return originalSend.call(this, data);
  };
  
  next();
});

// ====== FINGERPRINT ======
function generateServerSideFingerprint(hardwareData) {
  const components = [
    hardwareData.motherboardId || '',
    hardwareData.processorId || '',
    hardwareData.ramId || '',
    hardwareData.macAddress || '',
    hardwareData.systemUUID || ''
  ].filter(c => c.trim().length > 0);

  const componentsString = components.join('|');
  let hash = 0;
  for (let i = 0; i < componentsString.length; i++) {
    const char = componentsString.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  const fingerprint = Math.abs(hash).toString(36);
  cacheHardwareData(fingerprint, hardwareData);
  return fingerprint;
}

function validateFingerprint(fingerprint, hardwareData) {
  return fingerprint === generateServerSideFingerprint(hardwareData);
}

// ====== LICENSE KEY ======
function generateHardwareBoundLicenseKey(systemFingerprint) {
  const dynamicAppId = `${APP_BASE}-${systemFingerprint.substring(0, 8)}`;
  const baseKey = systemFingerprint + VALIDATION_SALT + dynamicAppId;
  let hash = 0;
  for (let i = 0; i < baseKey.length; i++) {
    const char = baseKey.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  const numericHash = Math.abs(hash).toString().padStart(16, '0');
  return `${numericHash.substring(0,4)}-${numericHash.substring(4,8)}-${numericHash.substring(8,12)}-${numericHash.substring(12,16)}`;
}

function validateLicenseKey(licenseKey, systemFingerprint) {
  return licenseKey === generateHardwareBoundLicenseKey(systemFingerprint);
}

// ====== DECRYPTION ======
function safeReadEncryptedFile(filename) {
  try {
    const filePath = path.join(encryptedAppsDir, filename);
    if (!fs.existsSync(filePath)) return { success: false, error: 'File not found' };
    const content = fs.readFileSync(filePath, 'utf8');
    if (!content.trim()) return { success: false, error: 'File is empty' };
    return { success: true, content };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function decryptContentServerSide(encryptedContent) {
  const decrypted = CryptoJS.AES.decrypt(encryptedContent, ENCRYPTION_PASSWORD);
  const decryptedText = decrypted.toString(CryptoJS.enc.Utf8);
  if (!decryptedText) throw new Error('Decryption failed');
  return decryptedText;
}

function decryptAndPatchForServerMode(encryptedContent, appId) {
  const decrypted = decryptContentServerSide(encryptedContent);
  const exportHelperScript = `
    <script>
    if (typeof window.saveFileFromApp === 'undefined') {
      window.saveFileFromApp = function(filename, content, type = 'text/plain') {
        if (window.parent && window.parent.saveFileFromIframe) {
          return window.parent.saveFileFromIframe('${appId}', filename, content, type);
        }
        try {
          const blob = new Blob([content], { type });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = filename;
          document.body.appendChild(a); a.click();
          document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(url), 100);
          return true;
        } catch (e) { return false; }
      };
    }
    if (typeof window.exportCSV === 'undefined') {
      window.exportCSV = function(dataArray, filename) {
        const csvContent = dataArray.map(row => row.map(cell => '"' + cell + '"').join(',')).join('\\n');
        return window.saveFileFromApp(filename || 'export.csv', csvContent, 'text/csv');
      };
    }
    if (typeof window.exportJSON === 'undefined') {
      window.exportJSON = function(data, filename) {
        return window.saveFileFromApp(filename || 'export.json', JSON.stringify(data, null, 2), 'application/json');
      };
    }
    window.addEventListener('message', function(event) {
      if (event.data.type === 'save_file' && event.data.appId === '${appId}') {
        window.saveFileFromApp && window.saveFileFromApp(event.data.filename, event.data.content, event.data.fileType);
      }
      if (event.data.type === 'ping' && event.data.appId === '${appId}') {
        window.parent.postMessage({ type: 'pong', appId: '${appId}' }, '*');
      }
    });
    setTimeout(() => {
      if (window.parent) window.parent.postMessage({ type: 'app_ready', appId: '${appId}', timestamp: new Date().toISOString() }, '*');
    }, 500);
    </script>`;
  return decrypted.includes('</body>')
    ? decrypted.replace('</body>', exportHelperScript + '</body>')
    : decrypted + exportHelperScript;
}

// ====== GUMROAD SERVICE ======
class GumroadService {
  constructor(accessToken) { this.accessToken = accessToken; }
  async verifyPurchase(purchaseId, email) {
    if (!this.accessToken) return { valid: false, error: 'Gumroad not configured' };
    try {
      const resp = await axios.get(`${GUMROAD_API_BASE}/sales/${purchaseId}`, {
        headers: { Authorization: `Bearer ${this.accessToken}` }, timeout: 10000
      });
      if (!resp.data.success) return { valid: false, error: 'Purchase invalid' };
      const sale = resp.data.sale;
      if (sale.email.toLowerCase() !== email.toLowerCase()) return { valid: false, error: 'Email mismatch' };
      if (sale.refunded) return { valid: false, error: 'Purchase refunded' };
      return {
        valid: true, product_id: sale.product_id, product_name: sale.product_name,
        product_permalink: sale.product_permalink, email: sale.email,
        purchase_date: sale.created_at, price_cents: sale.price_cents,
        currency: sale.currency, quantity: sale.quantity || 1, full_sale_data: sale
      };
    } catch (err) {
      return { valid: false, error: 'Failed to verify purchase with Gumroad' };
    }
  }
}
const gumroadService = new GumroadService(GUMROAD_ACCESS_TOKEN);

// ====== TRIAL MANAGEMENT (PostgreSQL-backed) ======
async function getTrialData(fingerprint) {
  const result = await safeDbGet('SELECT * FROM trials WHERE fingerprint = $1', [fingerprint]);
  if (!result.success || !result.data) return null;
  const row = result.data;
  return {
    fingerprint: row.fingerprint,
    startTime: Number(row.start_time),
    endTime: Number(row.end_time),
    allowedApps: JSON.parse(row.allowed_apps),
    isValid: row.is_valid,
    trialActive: Date.now() < Number(row.end_time),
    created: row.created_at
  };
}

async function createOrUpdateTrial(fingerprint, req = null) {
  const now = Date.now();
  const existing = await getTrialData(fingerprint);
  if (existing && now < existing.endTime) return existing;

  const endTime = now + TRIAL_DURATION;
  const allowedApps = JSON.stringify(TRIAL_ALLOWED_APPS);

  await safeDbQuery(`
    INSERT INTO trials (fingerprint, start_time, end_time, allowed_apps, is_valid)
    VALUES ($1, $2, $3, $4, TRUE)
    ON CONFLICT (fingerprint) DO UPDATE
      SET start_time = $2, end_time = $3, allowed_apps = $4, is_valid = TRUE, updated_at = NOW()
  `, [fingerprint, now, endTime, allowedApps]);

  logServerActivity('INFO', `Trial ${existing ? 'renewed' : 'created'} for ${fingerprint.substring(0, 8)}...`, '/api/trial/start', req);
  return { fingerprint, startTime: now, endTime, allowedApps: TRIAL_ALLOWED_APPS, isValid: true, trialActive: true };
}

async function isTrialValid(fingerprint) {
  const trial = await getTrialData(fingerprint);
  return trial ? Date.now() < trial.endTime : false;
}

// ====== ADMIN SESSION MANAGEMENT (PostgreSQL-backed) ======
// Small in-memory session cache to avoid hitting DB on every authenticated request
const sessionCache = new Map();
const SESSION_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function createAdminSession() {
  const sessionToken = generateSessionToken();
  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
  await safeDbQuery(
    'INSERT INTO admin_sessions (session_token, expires_at) VALUES ($1, $2)',
    [sessionToken, expiresAt.toISOString()]
  );
  sessionCache.set(sessionToken, { expiresAt, cachedAt: Date.now() });
  return sessionToken;
}

async function validateAdminSession(token) {
  if (!token) return false;
  // Check memory cache first (avoids DB hit on every page load)
  const cached = sessionCache.get(token);
  if (cached) {
    if (Date.now() - cached.cachedAt < SESSION_CACHE_TTL && new Date() < cached.expiresAt) return true;
    sessionCache.delete(token);
  }
  // Check DB
  const result = await safeDbGet(
    "SELECT * FROM admin_sessions WHERE session_token = $1 AND expires_at > NOW()",
    [token]
  );
  if (result.success && result.data) {
    sessionCache.set(token, { expiresAt: new Date(result.data.expires_at), cachedAt: Date.now() });
    safeDbQuery('UPDATE admin_sessions SET last_activity = NOW() WHERE session_token = $1', [token]).catch(() => {});
    return true;
  }
  return false;
}

async function destroyAdminSession(token) {
  sessionCache.delete(token);
  await safeDbQuery('DELETE FROM admin_sessions WHERE session_token = $1', [token]);
}

// ====== ADMIN AUTH MIDDLEWARE ======
async function authenticateAdmin(req, res, next) {
  const sessionToken = req.cookies?.admin_session;
  if (!sessionToken || !(await validateAdminSession(sessionToken))) {
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.status(401).json({ success: false, error: 'Authentication required', redirect: '/admin/login' });
    }
    return res.redirect('/admin/login');
  }
  next();
}

// ====== EXPORT HELPERS ======
async function exportToCSV(data, filename) {
  return new Promise((resolve, reject) => {
    try {
      if (!data || data.length === 0) { resolve(''); return; }
      const headers = Object.keys(data[0]).map(key => ({ id: key, title: key.replace(/_/g, ' ').toUpperCase() }));
      const csvStringifier = csv({ headers });
      const csvContent = csvStringifier.getHeaderString() + csvStringifier.stringifyRecords(data);
      const filePath = path.join(exportTempDir, filename);
      fs.writeFileSync(filePath, csvContent, 'utf8');
      resolve(filePath);
    } catch (error) { reject(error); }
  });
}

async function exportToJSON(data, filename) {
  return new Promise((resolve, reject) => {
    try {
      const filePath = path.join(exportTempDir, filename);
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
      resolve(filePath);
    } catch (error) { reject(error); }
  });
}

async function createZipArchive(files, zipFilename) {
  return new Promise((resolve, reject) => {
    const zipPath = path.join(exportTempDir, zipFilename);
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', () => resolve(zipPath));
    archive.on('warning', (err) => { if (err.code !== 'ENOENT') reject(err); });
    archive.on('error', (err) => reject(err));
    archive.pipe(output);
    files.forEach(file => { if (fs.existsSync(file.path)) archive.file(file.path, { name: file.name }); });
    archive.finalize();
  });
}

function cleanupExportFile(filePath) {
  setTimeout(() => { try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) {} }, 60000);
}

function cleanupOldExports() {
  try {
    const files = fs.readdirSync(exportTempDir);
    const now = Date.now();
    files.forEach(file => {
      const filePath = path.join(exportTempDir, file);
      try {
        if (now - fs.statSync(filePath).mtimeMs > 24 * 60 * 60 * 1000) fs.unlinkSync(filePath);
      } catch (e) {}
    });
  } catch (e) {}
}
cleanupOldExports();

app.get('/api/admin/verify-session', authenticateAdmin, (req, res) => {
    res.json({ success: true });
  });
  
app.get('/health', async (req, res) => {
  const files = fs.existsSync(encryptedAppsDir) ? fs.readdirSync(encryptedAppsDir).filter(f => f.endsWith('.enc')) : [];
  let dbHealthy = false;
  try {
    await safeDbGet('SELECT 1 as ok');
    dbHealthy = true;
  } catch(e) {}
  const healthy = dbHealthy;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    server: 'Warriors Artillery License Server', version: '4.0.0',
    database: dbHealthy ? 'connected' : 'disconnected',
    uptime: process.uptime(),
    memory_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    trial_config: { allowed_apps: TRIAL_ALLOWED_APPS, duration_hours: 24 },
    files_count: files.length, gumroad_configured: !!GUMROAD_ACCESS_TOKEN,
    timestamp: new Date().toISOString()
  });
});

app.get('/', (req, res) => {
  const files = fs.existsSync(encryptedAppsDir) ? fs.readdirSync(encryptedAppsDir).filter(f => f.endsWith('.enc')) : [];
  res.json({
    message: 'Warriors Artillery License Server', version: '4.0.0',
    database: 'PostgreSQL', status: files.length ? 'Ready' : 'Waiting for .enc files',
    files_available: files, admin_panel: `/admin`
  });
});

// Generate fingerprint
app.post('/api/generate-fingerprint', async (req, res) => {
  const { hardwareData } = req.body || {};
  if (!hardwareData) return res.status(400).json({ success: false, error: 'Hardware data required' });
  try {
    const fingerprint = generateServerSideFingerprint(hardwareData);
    const licenseKey = generateHardwareBoundLicenseKey(fingerprint);
    logServerActivity('INFO', `Generated fingerprint: ${fingerprint}`, '/api/generate-fingerprint', req);
    res.json({ success: true, fingerprint, license_key: licenseKey,
      dynamic_app_id: `${APP_BASE}-${fingerprint.substring(0, 8)}`, timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to generate fingerprint' });
  }
});

// ====== TRIAL ENDPOINTS ======
app.post('/api/trial/status', async (req, res) => {
  const { systemFingerprint, hardwareData } = req.body || {};
  if (!systemFingerprint) return res.status(400).json({ success: false, error: 'System fingerprint required' });
  if (hardwareData) {
    try { validateFingerprint(systemFingerprint, hardwareData); } catch (e) {}
  }
  const trialData = await getTrialData(systemFingerprint);
  if (!trialData) {
    return res.json({ success: true, trialData: {
      isValid: false, trialActive: false, trialExists: false, firstLaunch: true,
      allowedApps: [], startTime: null, endTime: null, remainingTime: 0, message: 'No trial found'
    }});
  }
  const remainingTime = Math.max(0, trialData.endTime - Date.now());
  const isValid = remainingTime > 0;
  res.set('Cache-Control', 'private, max-age=60'); // client can cache for 60 seconds
  res.json({ success: true, trialData: {
    isValid, trialActive: isValid, trialExists: true, firstLaunch: false,
    allowedApps: trialData.allowedApps, startTime: trialData.startTime,
    endTime: trialData.endTime, remainingTime, message: isValid ? 'Trial active' : 'Trial expired'
  }});
});

app.post('/api/trial/start', async (req, res) => {
  const { systemFingerprint, hardwareData } = req.body || {};
  if (!systemFingerprint) return res.status(400).json({ success: false, error: 'System fingerprint required' });
  const trialData = await createOrUpdateTrial(systemFingerprint, req);
  res.json({ success: true, trialData: {
    isValid: true, trialActive: true, trialExists: true, firstLaunch: false,
    allowedApps: trialData.allowedApps, startTime: trialData.startTime,
    endTime: trialData.endTime, remainingTime: trialData.endTime - Date.now(), message: 'Trial started'
  }});
});

// ====== LICENSE ENDPOINTS ======
app.post('/api/validate', async (req, res) => {
  const { licenseKey, systemFingerprint, hardwareData } = req.body || {};
  if (!licenseKey || !systemFingerprint) {
    return res.status(400).json({ valid: false, error: 'License key and fingerprint required' });
  }
  try {
    if (hardwareData || getCachedHardwareData(systemFingerprint)) {
      const hw = hardwareData || getCachedHardwareData(systemFingerprint);
      if (!validateFingerprint(systemFingerprint, hw)) {
        return res.json({ valid: false, error: 'Invalid system fingerprint' });
      }
    }
    if (!validateLicenseKey(licenseKey, systemFingerprint)) {
      logServerActivity('WARN', `Invalid license attempt: ${licenseKey.substring(0, 8)}...`, '/api/validate', req);
      return res.json({ valid: false, error: 'Invalid license key for this device' });
    }
    const recordResult = await safeDbGet(
      'SELECT * FROM licenses WHERE license_key = $1 AND refunded = 0', [licenseKey]
    );
    if (recordResult.error) {
      return res.json({ valid: true, license: { key: licenseKey, email: 'unknown', product_name: 'Unknown', activations: 1, max_activations: 1, purchase_date: new Date().toISOString() }, message: 'License validated (db error)' });
    }
    const record = recordResult.data;
    if (!record) {
      return res.json({ valid: true, license: { key: licenseKey, email: 'test@example.com', product_name: 'Test Product', activations: 1, max_activations: 1, purchase_date: new Date().toISOString() }, message: 'License validated (test)' });
    }
    if (record.system_fingerprint !== systemFingerprint) {
      logServerActivity('WARN', `License used on wrong device: ${licenseKey.substring(0, 8)}...`, '/api/validate', req);
      return res.json({ valid: false, error: 'License not activated on this device' });
    }
    // Update last_validation fire-and-forget
    safeDbQuery('UPDATE licenses SET last_validation = NOW() WHERE id = $1', [record.id]).catch(() => {});
    logServerActivity('INFO', `License validated: ${record.product_name} for ${record.gumroad_email}`, '/api/validate', req);
    res.json({ valid: true, license: {
      key: record.license_key, email: record.gumroad_email, product_name: record.product_name,
      activations: record.activation_count, max_activations: record.max_activations, purchase_date: record.purchase_date
    }});
  } catch (error) {
    logServerActivity('ERROR', `Validation error: ${error.message}`, '/api/validate', req);
    res.status(500).json({ valid: false, error: 'Server error during validation' });
  }
});

app.post('/api/activate', async (req, res) => {
  const { gumroadPurchaseId, gumroadEmail, systemFingerprint, hardwareData } = req.body || {};
  if (!gumroadPurchaseId || !gumroadEmail || !systemFingerprint) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }
  if (!gumroadEmail.includes('@')) return res.status(400).json({ success: false, error: 'Invalid email format' });

  if (hardwareData) {
    try { validateFingerprint(systemFingerprint, hardwareData); } catch (e) {}
  }

  // Test license (no Gumroad configured)
  if (!GUMROAD_ACCESS_TOKEN) {
    const licenseKey = generateHardwareBoundLicenseKey(systemFingerprint);
    const existingResult = await safeDbGet('SELECT * FROM licenses WHERE system_fingerprint = $1', [systemFingerprint]);
    if (!existingResult.data) {
      await safeDbQuery(`
        INSERT INTO licenses (gumroad_purchase_id, gumroad_email, license_key, system_fingerprint,
          product_id, product_name, product_permalink, purchase_date, price_cents, currency, activation_count, max_activations)
        VALUES ($1,$2,$3,$4,'test_product','Test Product','test',NOW(),0,'USD',1,1)
        ON CONFLICT DO NOTHING
      `, [gumroadPurchaseId, gumroadEmail, licenseKey, systemFingerprint]);
    }
    logServerActivity('INFO', `Test license activated for ${gumroadEmail}`, '/api/activate', req);
    return res.json({ success: true, license_key: licenseKey, message: 'Test license activated', product_name: 'Test Product', existing: !!existingResult.data });
  }

  try {
    const verify = await gumroadService.verifyPurchase(gumroadPurchaseId, gumroadEmail);
    if (!verify.valid) {
      logServerActivity('WARN', `Gumroad verification failed for ${gumroadEmail}: ${verify.error}`, '/api/activate', req);
      return res.status(400).json({ success: false, error: verify.error || 'Purchase verification failed' });
    }
    const licenseKey = generateHardwareBoundLicenseKey(systemFingerprint);
    const maxActivations = verify.quantity || 1;
    const existingResult = await safeDbGet('SELECT * FROM licenses WHERE gumroad_purchase_id = $1', [gumroadPurchaseId]);
    const existing = existingResult.data;

    if (existing) {
      if (existing.system_fingerprint === systemFingerprint) {
        return res.json({ success: true, license_key: existing.license_key, message: 'License already active on this device', product_name: existing.product_name, existing: true });
      }
      if (existing.activation_count >= maxActivations) {
        return res.status(400).json({ success: false, error: `Maximum activations reached (${existing.activation_count}/${maxActivations})` });
      }
      await safeDbQuery(
        'UPDATE licenses SET system_fingerprint=$1, activation_count=$2, max_activations=$3, updated_at=NOW() WHERE gumroad_purchase_id=$4',
        [systemFingerprint, existing.activation_count + 1, maxActivations, gumroadPurchaseId]
      );
      logServerActivity('INFO', `License activated on new device: ${verify.email}`, '/api/activate', req);
      return res.json({ success: true, license_key: existing.license_key, message: `Activated on new device (${existing.activation_count + 1}/${maxActivations})`, product_name: existing.product_name, existing: true });
    }

    const insertResult = await safeDbQuery(`
      INSERT INTO licenses (gumroad_purchase_id, gumroad_email, license_key, system_fingerprint,
        product_id, product_name, product_permalink, purchase_date, price_cents, currency, activation_count, max_activations, gumroad_sale_data)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11,$12)
      ON CONFLICT (gumroad_purchase_id) DO NOTHING
    `, [gumroadPurchaseId, verify.email, licenseKey, systemFingerprint,
        verify.product_id, verify.product_name, verify.product_permalink, verify.purchase_date,
        verify.price_cents, verify.currency, maxActivations, JSON.stringify(verify.full_sale_data)]);

    logServerActivity('INFO', `New license created: ${verify.product_name} for ${verify.email}`, '/api/activate', req);
    res.json({ success: true, license_key: licenseKey, message: `License activated (1/${maxActivations})`, product_name: verify.product_name, max_activations: maxActivations, existing: false });
  } catch (error) {
    logServerActivity('ERROR', `Activation error: ${error.message}`, '/api/activate', req);
    res.status(500).json({ success: false, error: 'Server error during activation' });
  }
});

app.post('/api/check-license', async (req, res) => {
  const { license_key } = req.body || {};
  if (!license_key) return res.status(400).json({ success: false, error: 'License key required' });
  const result = await safeDbGet('SELECT 1 FROM licenses WHERE license_key = $1', [license_key]);
  res.json({ exists: !!(result.success && result.data), success: true });
});

// ====== FILE DOWNLOAD ENDPOINTS ======

// ====== LOCAL ENC FILE DECRYPT ENDPOINT ======
app.post('/api/files/decrypt-local', async (req, res) => {
  const { encryptedContent, appId, licenseKey, systemFingerprint, isTrial } = req.body || {};

  if (!encryptedContent || !appId) {
    return res.status(400).json({ success: false, error: 'encryptedContent and appId required' });
  }

  const hasLicense = licenseKey && systemFingerprint && validateLicenseKey(licenseKey, systemFingerprint);
  const hasTrial   = !hasLicense && systemFingerprint && (await isTrialValid(systemFingerprint));

  if (!hasLicense && !hasTrial) {
    return res.status(403).json({ success: false, error: 'Valid license or active trial required' });
  }

  if (hasTrial && !hasLicense) {
    if (!TRIAL_ALLOWED_APPS.includes(appId)) {
      return res.status(403).json({ success: false, error: `App ${appId} not available in trial`, allowed_apps: TRIAL_ALLOWED_APPS });
    }
  }

  try {
    const decrypted = decryptAndPatchForServerMode(encryptedContent, appId);
    const responseSize = getResponseSize(decrypted);
    
    await trackBandwidth('/api/files/decrypt-local', 'file_download', responseSize, {
      licenseKey: licenseKey || null,
      systemFingerprint,
      isTrial: hasTrial && !hasLicense,
      req
    });
    
    logServerActivity('INFO', `Local enc decrypted: ${appId} (${hasLicense ? 'licensed' : 'trial'})`, '/api/files/decrypt-local', req);
    res.json({ success: true, content: decrypted, appId, decrypted_on_server: true, source: 'local_enc' });
  } catch (err) {
    logServerActivity('ERROR', `Local decrypt failed for ${appId}: ${err.message}`, '/api/files/decrypt-local', req);
    res.status(500).json({ success: false, error: 'Decryption failed — enc file may be corrupted or wrong version' });
  }
});

app.post('/api/files/download-decrypted', async (req, res) => {
  const { filename, licenseKey, systemFingerprint, hardwareData } = req.body || {};
  if (!filename || !licenseKey || !systemFingerprint) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }
  if (hardwareData) {
    try { validateFingerprint(systemFingerprint, hardwareData); } catch (e) {}
  }
  if (!validateLicenseKey(licenseKey, systemFingerprint)) {
    return res.status(403).json({ success: false, error: 'Invalid license' });
  }
  const fileResult = safeReadEncryptedFile(filename);
  if (!fileResult.success) return res.status(404).json({ success: false, error: fileResult.error });
  try {
    const expected = expectedFiles.find(f => f.filename === filename);
    const appId = expected ? expected.appId : filename.replace('.enc', '');
    const cacheKey = `licensed:${filename}:${appId}`;
    let decrypted = getCachedDecryptedFile(cacheKey);
    if (!decrypted) {
      decrypted = decryptAndPatchForServerMode(fileResult.content, appId);
      setCachedDecryptedFile(cacheKey, decrypted);
    }
    const responseSize = getResponseSize(decrypted);
    
    await trackBandwidth('/api/files/download-decrypted', 'file_download', responseSize, {
      licenseKey,
      systemFingerprint,
      isTrial: false,
      req
    });
    
    logServerActivity('INFO', `File downloaded: ${filename} for ${licenseKey.substring(0, 8)}...`, '/api/files/download-decrypted', req);
    res.json({ success: true, filename, content: decrypted, decrypted_on_server: true, appId });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Decryption failed' });
  }
});

app.post('/api/files/download-decrypted-trial', async (req, res) => {
  const { filename, systemFingerprint, hardwareData } = req.body || {};
  if (!filename || !systemFingerprint) return res.status(400).json({ success: false, error: 'Missing required fields' });
  if (!(await isTrialValid(systemFingerprint))) {
    return res.status(403).json({ success: false, error: 'No valid trial or trial expired' });
  }
  const expected = expectedFiles.find(f => f.filename === filename);
  if (!expected) return res.status(404).json({ success: false, error: 'Unknown file requested' });
  const trialData = await getTrialData(systemFingerprint);
  if (!trialData || !trialData.allowedApps.includes(expected.appId)) {
    return res.status(403).json({ success: false, error: 'App not available in trial', allowed_apps: trialData?.allowedApps || [] });
  }
  const fileResult = safeReadEncryptedFile(filename);
  if (!fileResult.success) return res.status(404).json({ success: false, error: fileResult.error });
  try {
    const cacheKey = `trial:${filename}:${expected.appId}`;
    let decrypted = getCachedDecryptedFile(cacheKey);
    if (!decrypted) {
      decrypted = decryptAndPatchForServerMode(fileResult.content, expected.appId);
      setCachedDecryptedFile(cacheKey, decrypted);
    }
    const responseSize = getResponseSize(decrypted);
    
    await trackBandwidth('/api/files/download-decrypted-trial', 'file_download', responseSize, {
      systemFingerprint,
      isTrial: true,
      req
    });
    
    logServerActivity('INFO', `Trial file downloaded: ${filename} for ${systemFingerprint.substring(0, 8)}...`, '/api/files/download-decrypted-trial', req);
    res.json({ success: true, filename, content: decrypted, decrypted_on_server: true, trial: true,
      allowed_apps: trialData.allowedApps, remaining_time: trialData.endTime - Date.now(), appId: expected.appId });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Decryption failed' });
  }
});

// Debug endpoints
app.post('/api/debug/fingerprint', (req, res) => {
  const { hardwareData } = req.body || {};
  if (!hardwareData) return res.status(400).json({ success: false, error: 'Hardware data required' });
  const fingerprint = generateServerSideFingerprint(hardwareData);
  const licenseKey = generateHardwareBoundLicenseKey(fingerprint);
  res.json({ success: true, fingerprint, license_key: licenseKey,
    algorithm: { salt: VALIDATION_SALT, app_base: APP_BASE, dynamic_app_id: `${APP_BASE}-${fingerprint.substring(0, 8)}` }
  });
});

app.post('/api/debug', (req, res) => {
  res.json({ success: true, message: 'Debug received', body: req.body, timestamp: new Date().toISOString() });
});

// ====== ADMIN AUTH ENDPOINTS ======

// Admin login page
app.get('/admin/login', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Warriors Artillery Admin Login</title>
        <meta charset="UTF-8">
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            margin: 0;
            padding: 0;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          }
          .login-container {
            background: white;
            padding: 40px;
            border-radius: 10px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            width: 100%;
            max-width: 400px;
          }
          h1 {
            color: #333;
            margin-bottom: 10px;
            text-align: center;
          }
          .subtitle {
            color: #666;
            text-align: center;
            margin-bottom: 30px;
          }
          .form-group {
            margin-bottom: 20px;
          }
          label {
            display: block;
            margin-bottom: 5px;
            color: #555;
            font-weight: 500;
          }
          input {
            width: 100%;
            padding: 12px;
            border: 1px solid #ddd;
            border-radius: 6px;
            font-size: 16px;
            box-sizing: border-box;
          }
          input:focus {
            outline: none;
            border-color: #667eea;
            box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
          }
          button {
            width: 100%;
            padding: 14px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            border-radius: 6px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: transform 0.2s, box-shadow 0.2s;
          }
          button:hover {
            transform: translateY(-2px);
            box-shadow: 0 10px 20px rgba(102, 126, 234, 0.3);
          }
          button:active {
            transform: translateY(0);
          }
          .error {
            color: #dc3545;
            text-align: center;
            margin-top: 15px;
            padding: 10px;
            background: #f8d7da;
            border-radius: 4px;
            display: none;
          }
          .server-info {
            margin-top: 30px;
            padding-top: 20px;
            border-top: 1px solid #eee;
            color: #666;
            font-size: 14px;
            text-align: center;
          }
        </style>
      </head>
      <body>
        <div class="login-container">
          <h1>🔐 Admin Login</h1>
          <div class="subtitle">Warriors Artillery License Server</div>
          
          <form id="loginForm">
            <div class="form-group">
              <label for="password">Admin Password</label>
              <input type="password" id="password" placeholder="Enter admin password" required>
            </div>
            
            <button type="submit">Login</button>
          </form>
          
          <div class="error" id="errorMessage"></div>
          
          <div class="server-info">
            Server: localhost:${PORT}<br>
            Version: 4.0.0
          </div>
        </div>
        
        <script>
          document.getElementById('loginForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const password = document.getElementById('password').value;
            const errorDiv = document.getElementById('errorMessage');
            
            try {
              const response = await fetch('/api/admin/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password }),
                credentials: 'include'
              });
              
              const data = await response.json();
              
              if (data.success) {
                window.location.href = '/admin';
              } else {
                errorDiv.textContent = data.error || 'Login failed';
                errorDiv.style.display = 'block';
              }
            } catch (error) {
              errorDiv.textContent = 'Network error. Please try again.';
              errorDiv.style.display = 'block';
            }
          });
        </script>
      </body>
    </html>
  `);
});

// Admin login API
app.post('/api/admin/login', async (req, res) => {
  const { password } = req.body || {};
  
  if (!password) {
    return res.status(400).json({ success: false, error: 'Password required' });
  }
  
  if (password !== ADMIN_PASSWORD) {
    logServerActivity('WARN', 'Failed admin login attempt', '/api/admin/login', req);
    return res.status(401).json({ success: false, error: 'Invalid password' });
  }
  
  const sessionToken = await createAdminSession();
  
  logServerActivity('INFO', 'Admin logged in successfully', '/api/admin/login', req);
  
  res.cookie('admin_session', sessionToken, {
    httpOnly: true,
    secure: false,
    maxAge: 8 * 60 * 60 * 1000,
    sameSite: 'strict'
  }).json({
    success: true,
    message: 'Login successful',
    redirect: '/admin'
  });
});

// Admin logout
app.post('/api/admin/logout', async (req, res) => {
  const sessionToken = req.cookies?.admin_session;
  
  if (sessionToken) {
    destroyAdminSession(sessionToken);
  }
  
  res.clearCookie('admin_session').json({
    success: true,
    message: 'Logged out successfully'
  });
});

// ====== ADMIN API ENDPOINTS for dynamic data ======

// Helper format function
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Stats endpoint
app.get('/api/admin/stats', authenticateAdmin, async (req, res) => {
  try {
    const licensesCount = (await safeDbGet('SELECT COUNT(*) as count FROM licenses')).data?.count || 0;
    const trialsData = (await safeDbQuery('SELECT * FROM trials')).data || [];
    const now = Date.now();
    const activeTrials = trialsData.filter(t => now < Number(t.end_time)).length;
    const expiredTrials = trialsData.filter(t => now >= Number(t.end_time)).length;
    const totalLogs = (await safeDbGet('SELECT COUNT(*) as count FROM server_logs')).data?.count || 0;
    const bandwidth7d = (await safeDbGet(`SELECT COALESCE(SUM(bytes_transferred), 0) as total FROM bandwidth_usage WHERE created_at > NOW() - INTERVAL '7 days'`)).data?.total || 0;
    
    res.json({
      total_licenses: licensesCount,
      active_trials: activeTrials,
      expired_trials: expiredTrials,
      total_logs: totalLogs,
      bandwidth_7d: formatBytes(bandwidth7d),
      port: PORT,
      gumroad_configured: !!GUMROAD_ACCESS_TOKEN,
      trial_allowed_apps: TRIAL_ALLOWED_APPS,
      node_version: process.version,
      platform: `${process.platform} ${process.arch}`,
      uptime: process.uptime(),
      memory_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Licenses list endpoint
app.get('/api/admin/licenses', authenticateAdmin, async (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const offset = parseInt(req.query.offset) || 0;
  const licenses = (await safeDbQuery('SELECT * FROM licenses ORDER BY created_at DESC LIMIT $1 OFFSET $2', [limit, offset])).data || [];
  res.json(licenses);
});

// Trials list endpoint
app.get('/api/admin/trials', authenticateAdmin, async (req, res) => {
  const trials = (await safeDbQuery('SELECT * FROM trials ORDER BY created_at DESC')).data?.map(r => ({ 
    fingerprint: r.fingerprint, 
    startTime: Number(r.start_time), 
    endTime: Number(r.end_time), 
    allowedApps: JSON.parse(r.allowed_apps), 
    isValid: r.is_valid 
  })) || [];
  res.json(trials);
});

// Logs endpoint
app.get('/api/admin/logs', authenticateAdmin, async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const logs = (await safeDbQuery('SELECT * FROM server_logs ORDER BY created_at DESC LIMIT $1', [limit])).data || [];
  res.json(logs);
});

// Get license by ID
app.get('/api/admin/license/:id', authenticateAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const license = (await safeDbGet('SELECT * FROM licenses WHERE id = $1', [id])).data;
    if (!license) {
      return res.status(404).json({ success: false, error: 'License not found' });
    }
    res.json(license);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Create license
app.post('/api/admin/license', authenticateAdmin, async (req, res) => {
  const {
    license_key,
    gumroad_email,
    product_name = 'Manual Entry',
    gumroad_purchase_id = '',
    system_fingerprint = '',
    max_activations = 1,
    price_cents = 0,
    currency = 'USD',
    notes = '',
    refunded = 0
  } = req.body;
  
  if (!license_key || !gumroad_email) {
    return res.status(400).json({ success: false, error: 'License key and email are required' });
  }
  
  try {
    const result = await safeDbQuery(`
      INSERT INTO licenses (
        license_key, gumroad_email, product_name, gumroad_purchase_id,
        system_fingerprint, max_activations, price_cents, currency, notes, refunded
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `, [
      license_key, gumroad_email, product_name, gumroad_purchase_id,
      system_fingerprint, max_activations, price_cents, currency, notes, refunded
    ]);
    
    logAdminAction('CREATE_LICENSE', license_key, 'license', req.body, req);
    
    res.json({
      success: true,
      message: 'License created successfully',
      id: result.lastInsertRowid
    });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT') {
      return res.status(400).json({ success: false, error: 'License key already exists' });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update license
app.put('/api/admin/license/:id', authenticateAdmin, async (req, res) => {
  const { id } = req.params;
  const {
    license_key,
    gumroad_email,
    product_name,
    gumroad_purchase_id,
    system_fingerprint,
    max_activations,
    price_cents,
    currency,
    notes,
    refunded
  } = req.body;
  
  try {
    const existing = (await safeDbGet('SELECT * FROM licenses WHERE id = $1', [id])).data;
    if (!existing) {
      return res.status(404).json({ success: false, error: 'License not found' });
    }
    
    const result = await safeDbQuery(`
      UPDATE licenses SET
        license_key = $1,
        gumroad_email = $2,
        product_name = $3,
        gumroad_purchase_id = $4,
        system_fingerprint = $5,
        max_activations = $6,
        price_cents = $7,
        currency = $8,
        notes = $9,
        refunded = $10,
        updated_at = NOW()
      WHERE id = $11
    `, [
      license_key || existing.license_key,
      gumroad_email || existing.gumroad_email,
      product_name || existing.product_name,
      gumroad_purchase_id || existing.gumroad_purchase_id,
      system_fingerprint || existing.system_fingerprint,
      max_activations || existing.max_activations,
      price_cents || existing.price_cents,
      currency || existing.currency,
      notes || existing.notes,
      refunded !== undefined ? refunded : existing.refunded,
      id
    ]);
    
    logAdminAction('UPDATE_LICENSE', license_key || existing.license_key, 'license', req.body, req);
    
    res.json({
      success: true,
      message: 'License updated successfully',
      changes: result.changes
    });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT') {
      return res.status(400).json({ success: false, error: 'License key already exists' });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete license
app.delete('/api/admin/license/:key', authenticateAdmin, async (req, res) => {
  const { key } = req.params;
  try {
    const result = await safeDbQuery('DELETE FROM licenses WHERE license_key = $1', [key]);
    logAdminAction('DELETE_LICENSE', key, 'license', {}, req);
    res.json({ 
      success: true, 
      deleted: result.changes > 0,
      message: result.changes > 0 ? 'License deleted' : 'License not found'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete trial
app.delete('/api/admin/trial/:fingerprint', authenticateAdmin, async (req, res) => {
  const { fingerprint } = req.params;
  try {
    const result = await safeDbQuery('DELETE FROM trials WHERE fingerprint = $1', [fingerprint]);
    const existed = result.rowCount > 0;
    logAdminAction('DELETE_TRIAL', fingerprint, 'trial', {}, req);
    res.json({ success: true, deleted: existed, message: existed ? 'Trial deleted' : 'Trial not found' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Clear expired trials
app.post('/api/admin/trials/clear-expired', authenticateAdmin, async (req, res) => {
  try {
    const result = await safeDbQuery('DELETE FROM trials WHERE end_time < $1', [Date.now()]);
    const cleared = result.rowCount || 0;
    logAdminAction('CLEAR_EXPIRED_TRIALS', 'all', 'trials', { cleared }, req);
    res.json({ success: true, cleared, message: `Cleared ${cleared} expired trials` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Clear logs
app.post('/api/admin/logs/clear', authenticateAdmin, async (req, res) => {
  try {
    const result = await safeDbQuery('DELETE FROM server_logs');
    const cleared = result.rowCount || 0;
    logAdminAction('CLEAR_LOGS', 'all', 'logs', { cleared }, req);
    res.json({ success: true, cleared, message: `Cleared ${cleared} log entries` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Reset database
app.post('/api/admin/reset-database', authenticateAdmin, async (req, res) => {
  try {
    await safeDbQuery('TRUNCATE TABLE licenses, trials, server_logs, admin_logs, admin_sessions, bandwidth_usage RESTART IDENTITY CASCADE');
    sessionCache.clear();
    hardwareDataCache.clear();
    
    logAdminAction('RESET_DATABASE', 'all', 'database', {}, req);
    
    res.json({
      success: true,
      message: 'Database reset successfully.'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get database info
app.get('/api/admin/database-info', authenticateAdmin, async (req, res) => {
  try {
    const tables = ['licenses', 'trials', 'server_logs', 'admin_logs', 'admin_sessions', 'bandwidth_usage'];
    const tableStats = {};
    for (const table of tables) {
      const result = await safeDbGet(`SELECT COUNT(*) as count FROM "${table}"`);
      tableStats[table] = { rows: parseInt(result.data?.count) || 0 };
    }
    const sizeResult = await safeDbGet("SELECT pg_size_pretty(pg_database_size(current_database())) as size");
    res.json({
      success: true,
      database: 'PostgreSQL',
      db_size: sizeResult.data?.size || 'unknown',
      pool_total: pool.totalCount,
      pool_idle: pool.idleCount,
      pool_waiting: pool.waitingCount,
      table_stats: tableStats,
      uptime: process.uptime(),
      memory: process.memoryUsage()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Vacuum database
app.post('/api/admin/database/vacuum', authenticateAdmin, async (req, res) => {
  try {
    await safeDbQuery('VACUUM ANALYZE');
    logAdminAction('VACUUM_DATABASE', 'all', 'database', {}, req);
    res.json({ success: true, message: 'Database vacuumed successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Optimize database
app.post('/api/admin/database/optimize', authenticateAdmin, async (req, res) => {
  try {
    await safeDbQuery('ANALYZE');
    logAdminAction('OPTIMIZE_DATABASE', 'all', 'database', {}, req);
    res.json({ success: true, message: 'Database optimized successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete all licenses
app.delete('/api/admin/licenses/delete-all', authenticateAdmin, async (req, res) => {
  try {
    const result = await safeDbQuery('DELETE FROM licenses', []);
    logAdminAction('DELETE_ALL_LICENSES', 'all', 'licenses', { deleted: result.changes }, req);
    res.json({
      success: true,
      deleted: result.changes,
      message: `Deleted ${result.changes} licenses`
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete all trials
app.delete('/api/admin/trials/delete-all', authenticateAdmin, async (req, res) => {
  try {
    const countResult = await safeDbGet('SELECT COUNT(*) as count FROM trials');
    const count = countResult.data?.count || 0;
    await safeDbQuery('DELETE FROM trials');
    logAdminAction('DELETE_ALL_TRIALS', 'all', 'trials', { deleted: count }, req);
    res.json({
      success: true,
      deleted: count,
      message: `Deleted ${count} trials`
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====== BANDWIDTH STATS ENDPOINTS ======

// Get bandwidth statistics
app.get('/api/admin/bandwidth-stats', authenticateAdmin, async (req, res) => {
  const period = req.query.period || 'all';
  
  let timeFilter = '';
  let params = [];
  
  switch(period) {
    case 'day':
      timeFilter = "AND created_at > NOW() - INTERVAL '1 day'";
      break;
    case 'week':
      timeFilter = "AND created_at > NOW() - INTERVAL '7 days'";
      break;
    case 'month':
      timeFilter = "AND created_at > NOW() - INTERVAL '30 days'";
      break;
    default:
      timeFilter = '';
  }
  
  try {
    const totalResult = await safeDbGet(
      `SELECT COALESCE(SUM(bytes_transferred), 0) as total_bytes FROM bandwidth_usage WHERE 1=1 ${timeFilter}`,
      params
    );
    
    const byTypeResult = await safeDbQuery(
      `SELECT request_type, COALESCE(SUM(bytes_transferred), 0) as bytes 
       FROM bandwidth_usage WHERE 1=1 ${timeFilter} GROUP BY request_type`,
      params
    );
    
    const byEndpointResult = await safeDbQuery(
      `SELECT endpoint, COUNT(*) as request_count, COALESCE(SUM(bytes_transferred), 0) as total_bytes 
       FROM bandwidth_usage WHERE 1=1 ${timeFilter} GROUP BY endpoint ORDER BY total_bytes DESC LIMIT 10`,
      params
    );
    
    const dailyResult = await safeDbQuery(
      `SELECT DATE(created_at) as date, COALESCE(SUM(bytes_transferred), 0) as bytes 
       FROM bandwidth_usage 
       WHERE created_at > NOW() - INTERVAL '7 days'
       GROUP BY DATE(created_at) 
       ORDER BY date DESC`,
      []
    );
    
    const licenseTypeResult = await safeDbQuery(
      `SELECT 
         CASE WHEN is_trial = true THEN 'Trial' ELSE 'Licensed' END as type,
         COALESCE(SUM(bytes_transferred), 0) as bytes
       FROM bandwidth_usage WHERE 1=1 ${timeFilter}
       GROUP BY is_trial`,
      params
    );
    
    const requestsResult = await safeDbGet(
      `SELECT COUNT(*) as total_requests FROM bandwidth_usage WHERE 1=1 ${timeFilter}`,
      params
    );
    
    res.set('Cache-Control', 'private, max-age=30'); // safe to cache stats for 30s
    res.json({
      total_bandwidth_formatted: formatBytes(totalResult.data?.total_bytes || 0),
      total_requests: requestsResult.data?.total_requests || 0,
      by_type: (byTypeResult.data || []).map(t => ({
        type: t.request_type,
        bytes: t.bytes,
        formatted: formatBytes(t.bytes)
      })),
      by_endpoint: (byEndpointResult.data || []).map(ep => ({
        endpoint: ep.endpoint,
        request_count: parseInt(ep.request_count),
        total_bytes: parseInt(ep.total_bytes),
        total_formatted: formatBytes(parseInt(ep.total_bytes)),
        avg_per_request: ep.request_count > 0 ? formatBytes(ep.total_bytes / ep.request_count) : '0 B'
      })),
      daily: (dailyResult.data || []).map(d => ({
        date: d.date,
        bytes: parseInt(d.bytes),
        formatted: formatBytes(parseInt(d.bytes))
      })),
      by_license_type: (licenseTypeResult.data || []).map(t => ({
        type: t.type,
        bytes: parseInt(t.bytes),
        formatted: formatBytes(parseInt(t.bytes))
      })),
      formatBytes: formatBytes
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Clear bandwidth logs
app.post('/api/admin/bandwidth/clear', authenticateAdmin, async (req, res) => {
  try {
    const result = await safeDbQuery('DELETE FROM bandwidth_usage');
    const cleared = result.rowCount || 0;
    logAdminAction('CLEAR_BANDWIDTH_LOGS', 'all', 'bandwidth', { cleared }, req);
    res.json({ success: true, cleared, message: `Cleared ${cleared} bandwidth records` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Export data
app.get('/api/admin/export', authenticateAdmin, async (req, res) => {
  const licenses = (await safeDbQuery('SELECT * FROM licenses ORDER BY created_at DESC', [])).data || [];
  const trials = (await safeDbQuery('SELECT * FROM trials ORDER BY created_at DESC')).data?.map(r => ({ fingerprint: r.fingerprint, startTime: Number(r.start_time), endTime: Number(r.end_time), allowedApps: JSON.parse(r.allowed_apps), isValid: r.is_valid })) || [];
  
  res.json({
    exported_at: new Date().toISOString(),
    server: {
      port: PORT,
      gumroad_configured: !!GUMROAD_ACCESS_TOKEN,
      trial_duration_hours: 24,
      trial_allowed_apps: TRIAL_ALLOWED_APPS,
      decryption_mode: 'server-side'
    },
    statistics: {
      total_licenses: licenses.length,
      active_trials: trials.filter(t => Date.now() < t.endTime).length,
      expired_trials: trials.filter(t => Date.now() >= t.endTime).length
    },
    licenses: licenses,
    trials: trials
  });
});

// Export CSV
app.get('/api/admin/export/csv', authenticateAdmin, async (req, res) => {
  try {
    const licenses = (await safeDbQuery('SELECT * FROM licenses ORDER BY created_at DESC', [])).data || [];
    
    if (licenses.length === 0) {
      return res.status(404).json({ success: false, error: 'No licenses to export' });
    }
    
    const csvData = licenses.map(license => ({
      id: license.id,
      license_key: license.license_key,
      gumroad_purchase_id: license.gumroad_purchase_id,
      gumroad_email: license.gumroad_email,
      product_name: license.product_name,
      purchase_date: license.purchase_date,
      price_cents: license.price_cents,
      currency: license.currency,
      refunded: license.refunded ? 'Yes' : 'No',
      activation_count: license.activation_count,
      max_activations: license.max_activations,
      created_at: license.created_at
    }));
    
    const headers = Object.keys(csvData[0]).map(key => ({
      id: key,
      title: key.replace(/_/g, ' ').toUpperCase()
    }));
    
    const csvStringifier = csv({ headers });
    const headerString = csvStringifier.getHeaderString();
    const recordsString = csvStringifier.stringifyRecords(csvData);
    const csvContent = headerString + recordsString;
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="warriors_licenses_${Date.now()}.csv"`);
    res.send(csvContent);
    
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Export ZIP
app.get('/api/admin/export/zip', authenticateAdmin, async (req, res) => {
  try {
    const licenses = (await safeDbQuery('SELECT * FROM licenses ORDER BY created_at DESC', [])).data || [];
    const trials = (await safeDbQuery('SELECT * FROM trials ORDER BY created_at DESC')).data?.map(r => ({ fingerprint: r.fingerprint, startTime: Number(r.start_time), endTime: Number(r.end_time), allowedApps: JSON.parse(r.allowed_apps), isValid: r.is_valid })) || [];
    
    const jsonData = {
      exported_at: new Date().toISOString(),
      licenses: licenses,
      trials: trials
    };
    
    const jsonPath = path.join(exportTempDir, `warriors_export_${Date.now()}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(jsonData, null, 2));
    
    const csvPath = path.join(exportTempDir, `warriors_licenses_${Date.now()}.csv`);
    if (licenses.length > 0) {
      const csvData = licenses.map(license => ({
        id: license.id,
        license_key: license.license_key,
        gumroad_email: license.gumroad_email,
        product_name: license.product_name,
        created_at: license.created_at
      }));
      
      const headers = Object.keys(csvData[0]).map(key => ({
        id: key,
        title: key.replace(/_/g, ' ').toUpperCase()
      }));
      
      const csvStringifier = csv({ headers });
      const headerString = csvStringifier.getHeaderString();
      const recordsString = csvStringifier.stringifyRecords(csvData);
      const csvContent = headerString + recordsString;
      fs.writeFileSync(csvPath, csvContent);
    }
    
    const zipPath = path.join(exportTempDir, `warriors_export_${Date.now()}.zip`);
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    
    output.on('close', () => {
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="warriors_export_${Date.now()}.zip"`);
      res.sendFile(zipPath, () => {
        [jsonPath, csvPath, zipPath].forEach(file => {
          if (fs.existsSync(file)) fs.unlinkSync(file);
        });
      });
    });
    
    archive.pipe(output);
    archive.file(jsonPath, { name: 'data.json' });
    if (licenses.length > 0) {
      archive.file(csvPath, { name: 'licenses.csv' });
    }
    archive.finalize();
    
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====== ADMIN PANEL - Static HTML with cache ======
app.get('/admin', authenticateAdmin, (req, res) => {
  // Cache the HTML for 24 hours (browsers will store it)
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(__dirname, 'public', 'admin-full.html'));
});

// ====== START SERVER ======
let server;

initializeDatabase().then(() => {
  server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`========================================`);
    console.log(`⚡ Warriors Artillery License Server v4.0`);
    console.log(`========================================`);
    console.log(`🌐 Server running at http://localhost:${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/health`);
    console.log(`🔧 Admin panel: http://localhost:${PORT}/admin`);
    console.log(`🔐 Admin login: http://localhost:${PORT}/admin/login`);
    console.log(`🔑 Admin password: ${ADMIN_PASSWORD}`);
    console.log(`🛒 Gumroad configured: ${GUMROAD_ACCESS_TOKEN ? '✅ Yes' : '❌ No (Test Mode)'}`);
    console.log(`\n🎯 TRIAL CONFIGURATION:`);
    console.log(`   Allowed apps: ${TRIAL_ALLOWED_APPS.join(', ')}`);
    console.log(`   Duration: 24 hours`);
    console.log(`\n🔑 LICENSE ALGORITHM:`);
    console.log(`   ✅ Salt: "${VALIDATION_SALT}"`);
    console.log(`   ✅ App Base: "${APP_BASE}"`);
    console.log(`   ✅ Format: XXXX-XXXX-XXXX-XXXX`);
    console.log(`\n📊 BANDWIDTH TRACKING: Enabled`);
    console.log(`========================================`);
  });
  
  server.keepAliveTimeout = 120000;
  server.headersTimeout = 125000;
  
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});

process.on('SIGINT', async () => {
  console.log('\nShutting down gracefully...');
  
  try {
    cleanupOldExports();
    
    if (server) {
      server.close(() => {
        console.log('HTTP server closed');
      });
    }
    
    await pool.end();
    console.log('PostgreSQL pool closed');
    
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
});