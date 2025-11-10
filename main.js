// main.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const axios = require('axios');
const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Gumroad Configuration
const GUMROAD_ACCESS_TOKEN = process.env.GUMROAD_ACCESS_TOKEN;
const GUMROAD_API_BASE = process.env.GUMROAD_API_BASE;
const VALIDATION_SALT = process.env.VALIDATION_SALT;
const PORT = process.env.PORT || 3001;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Database configuration - Simple universal approach
const dbPath = './licenses.db';

console.log(`📊 Database path: ${dbPath}`);
console.log(`🌐 Environment: ${NODE_ENV}`);

// Database initialization
const db = new Database(dbPath);
console.log('✅ Connected to SQLite database');

// Initialize database
function initializeDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS licenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('✅ Licenses table ready');
}

initializeDatabase();

// YOUR EXACT LICENSE KEY GENERATION ALGORITHM FROM DEVELOPER TOOL
function generateHardwareBoundKey(systemFingerprint, appBase = "warriors-artillery") {
  console.log('🔑 Generating license key with fingerprint:', systemFingerprint);
  
  const dynamicAppId = `${appBase}-${systemFingerprint.substring(0, 8)}`;
  const baseKey = systemFingerprint + VALIDATION_SALT + dynamicAppId;

  console.log('🔑 Base key components:', { systemFingerprint, VALIDATION_SALT, dynamicAppId });

  let hash = 0;
  for (let i = 0; i < baseKey.length; i++) {
    const char = baseKey.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }

  const numericHash = Math.abs(hash).toString().padStart(16, '0');
  const formattedKey = `${numericHash.substring(0,4)}-${numericHash.substring(4,8)}-${numericHash.substring(8,12)}-${numericHash.substring(12,16)}`;

  console.log('🔑 Generated license key:', formattedKey);
  return formattedKey;
}

// Gumroad API Service
class GumroadService {
  constructor(accessToken) {
    this.accessToken = accessToken;
  }

  async verifyPurchase(purchaseId, email) {
    try {
      console.log(`🔍 Verifying Gumroad purchase: ${purchaseId} for email: ${email}`);
      
      const response = await axios.get(`${GUMROAD_API_BASE}/sales/${purchaseId}`, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`
        },
        timeout: 10000
      });

      console.log('📊 Gumroad API response received');
      
      if (response.data.success) {
        const sale = response.data.sale;
        
        // Validate email matches
        if (sale.email.toLowerCase() !== email.toLowerCase()) {
          return { 
            valid: false, 
            error: 'Email does not match purchase records' 
          };
        }

        // Check if refunded
        if (sale.refunded) {
          return { 
            valid: false, 
            error: 'This purchase has been refunded' 
          };
        }

        return {
          valid: true,
          product_id: sale.product_id,
          product_name: sale.product_name,
          product_permalink: sale.product_permalink,
          email: sale.email,
          purchase_date: sale.created_at,
          price_cents: sale.price_cents,
          currency: sale.currency,
          quantity: sale.quantity || 1,
          full_sale_data: sale
        };
      } else {
        return { 
          valid: false, 
          error: 'Purchase not found or invalid' 
        };
      }
    } catch (error) {
      console.error('❌ Gumroad API error:', error.response?.data || error.message);
      
      if (error.response?.status === 404) {
        return { valid: false, error: 'Purchase ID not found' };
      } else if (error.response?.status === 401) {
        return { valid: false, error: 'Invalid Gumroad access token' };
      } else if (error.code === 'ECONNABORTED') {
        return { valid: false, error: 'Gumroad API timeout' };
      } else {
        return { valid: false, error: 'Failed to verify purchase with Gumroad' };
      }
    }
  }
}

const gumroadService = new GumroadService(GUMROAD_ACCESS_TOKEN);

// API Routes

// Test Gumroad connection
app.get('/api/test-gumroad', async (req, res) => {
  try {
    const response = await axios.get(`${GUMROAD_API_BASE}/products`, {
      headers: { 'Authorization': `Bearer ${GUMROAD_ACCESS_TOKEN}` }
    });
    
    res.json({ 
      success: true, 
      message: 'Gumroad connection successful',
      products: response.data.products?.length || 0
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: 'Gumroad connection failed: ' + error.message 
    });
  }
});

// Debug endpoint
app.get('/api/debug/data', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM licenses').all();
    res.json({ licenses: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Check if license exists in database
app.post('/api/check-license', (req, res) => {
  const { license_key } = req.body;
  
  if (!license_key) {
    return res.status(400).json({ error: 'License key is required' });
  }

  try {
    const row = db.prepare('SELECT * FROM licenses WHERE license_key = ? AND refunded = 0').get(license_key);
    res.json({ exists: !!row, license: row });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// MAIN ACTIVATION ENDPOINT
app.post('/api/activate', async (req, res) => {
  try {
    const { gumroadPurchaseId, gumroadEmail, systemFingerprint, purchaseQuantity = 1 } = req.body;

    console.log('📥 Activation request received:', { 
      gumroadPurchaseId, 
      gumroadEmail: gumroadEmail ? '***' : 'missing',
      systemFingerprint: systemFingerprint ? systemFingerprint : 'missing'
    });

    // Validate input
    if (!gumroadPurchaseId || !gumroadEmail || !systemFingerprint) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: Purchase ID, Email, and System Fingerprint' 
      });
    }

    // STEP 1: VERIFY WITH GUMROAD API FIRST
    console.log('🔐 Step 1: Verifying with Gumroad API...');
    const gumroadVerification = await gumroadService.verifyPurchase(gumroadPurchaseId, gumroadEmail);
    
    if (!gumroadVerification.valid) {
      console.log('❌ Gumroad verification failed:', gumroadVerification.error);
      return res.status(400).json({ 
        success: false, 
        error: gumroadVerification.error 
      });
    }

    console.log('✅ Gumroad verification passed for product:', gumroadVerification.product_name);
    console.log('📦 Purchase quantity from Gumroad:', gumroadVerification.quantity);

    // STEP 2: Generate license key
    console.log('🔑 Step 2: Generating license key with client fingerprint:', systemFingerprint);
    const licenseKey = generateHardwareBoundKey(systemFingerprint, "warriors-artillery");

    // STEP 3: Check if this purchase already exists
    try {
      const existingLicense = db.prepare('SELECT * FROM licenses WHERE gumroad_purchase_id = ?').get(gumroadPurchaseId);

      if (existingLicense) {
        handleExistingLicense(existingLicense, gumroadPurchaseId, systemFingerprint, gumroadVerification.quantity, res);
      } else {
        handleNewLicense(gumroadPurchaseId, gumroadVerification, systemFingerprint, licenseKey, res);
      }
    } catch (dbError) {
      console.error('Database error:', dbError);
      res.status(500).json({ success: false, error: 'Database error' });
    }

  } catch (error) {
    console.error('❌ Activation error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error: ' + error.message 
    });
  }
});

function handleExistingLicense(existingLicense, gumroadPurchaseId, systemFingerprint, gumroadQuantity, res) {
  console.log('🔄 Existing license found for purchase:', gumroadPurchaseId);
  
  // Check if this is the same device
  if (existingLicense.system_fingerprint === systemFingerprint) {
    console.log('✅ Same device - returning existing license');
    return res.json({
      success: true,
      license_key: existingLicense.license_key,
      message: 'License already active on this device',
      product_name: existingLicense.product_name,
      existing: true
    });
  }

  // Different device - check activation limits
  console.log('🔄 Different device detected, checking activation limits');
  console.log(`📊 Current: ${existingLicense.activation_count}/${existingLicense.max_activations}, Gumroad allows: ${gumroadQuantity}`);
  
  if (existingLicense.activation_count >= gumroadQuantity) {
    return res.status(400).json({
      success: false,
      error: `Maximum activations reached (${existingLicense.activation_count}/${gumroadQuantity}). Please contact support.`
    });
  }

  // Allow additional activation
  const newActivationCount = existingLicense.activation_count + 1;
  console.log(`✅ Allowing activation ${newActivationCount}/${gumroadQuantity}`);
  
  try {
    db.prepare(
      'UPDATE licenses SET system_fingerprint = ?, activation_count = ?, max_activations = ?, updated_at = CURRENT_TIMESTAMP WHERE gumroad_purchase_id = ?'
    ).run([systemFingerprint, newActivationCount, gumroadQuantity, gumroadPurchaseId]);

    res.json({
      success: true,
      license_key: existingLicense.license_key,
      message: `License activated on new device (${newActivationCount}/${gumroadQuantity})`,
      product_name: existingLicense.product_name,
      existing: true
    });
  } catch (updateErr) {
    console.error('Update error:', updateErr);
    res.status(500).json({ success: false, error: 'Update failed' });
  }
}

function handleNewLicense(gumroadPurchaseId, gumroadVerification, systemFingerprint, licenseKey, res) {
  console.log('🆕 New purchase - creating license with proper quantity limits');
  
  const maxActivations = gumroadVerification.quantity || 1;
  console.log(`📦 Setting max activations to: ${maxActivations} (from Gumroad purchase)`);
  
  try {
    db.prepare(
      `INSERT INTO licenses (
        gumroad_purchase_id, gumroad_email, license_key, system_fingerprint, 
        product_id, product_name, product_permalink, purchase_date, 
        price_cents, currency, activation_count, max_activations,
        gumroad_sale_data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    ).run([
      gumroadPurchaseId,
      gumroadVerification.email,
      licenseKey,
      systemFingerprint,
      gumroadVerification.product_id,
      gumroadVerification.product_name,
      gumroadVerification.product_permalink,
      gumroadVerification.purchase_date,
      gumroadVerification.price_cents,
      gumroadVerification.currency,
      maxActivations,
      JSON.stringify(gumroadVerification.full_sale_data)
    ]);

    console.log('✅ New license created with proper quantity enforcement:', {
      fingerprint: systemFingerprint,
      license_key: licenseKey,
      product: gumroadVerification.product_name,
      max_activations: maxActivations
    });
    
    res.json({
      success: true,
      license_key: licenseKey,
      message: `License activated successfully! (1/${maxActivations} devices)`,
      product_name: gumroadVerification.product_name,
      product_permalink: gumroadVerification.product_permalink,
      price: `${gumroadVerification.price_cents / 100} ${gumroadVerification.currency}`,
      purchase_date: gumroadVerification.purchase_date,
      max_activations: maxActivations,
      existing: false
    });
  } catch (insertErr) {
    console.error('Insert error:', insertErr);
    res.status(500).json({ success: false, error: 'License creation failed: ' + insertErr.message });
  }
}

// License validation endpoint
app.post('/api/validate', (req, res) => {
  const { licenseKey, systemFingerprint } = req.body;

  if (!licenseKey || !systemFingerprint) {
    return res.status(400).json({ 
      valid: false, 
      error: 'License key and system fingerprint are required' 
    });
  }

  try {
    const row = db.prepare('SELECT * FROM licenses WHERE license_key = ? AND refunded = 0').get(licenseKey);

    if (!row) {
      return res.json({ valid: false, error: 'License not found or refunded' });
    }

    if (row.system_fingerprint !== systemFingerprint) {
      return res.json({ 
        valid: false, 
        error: 'License is not activated on this device' 
      });
    }

    res.json({ 
      valid: true, 
      license: {
        key: row.license_key,
        email: row.gumroad_email,
        purchase_id: row.gumroad_purchase_id,
        product_name: row.product_name,
        activations: row.activation_count,
        max_activations: row.max_activations
      }
    });
  } catch (err) {
    res.status(500).json({ valid: false, error: err.message });
  }
});

// Get license info
app.get('/api/license/:key', (req, res) => {
  const { key } = req.params;

  try {
    const row = db.prepare('SELECT * FROM licenses WHERE license_key = ?').get(key);
    
    if (!row) {
      return res.status(404).json({ error: 'License not found' });
    }
    
    res.json({ license: row });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Deactivate license
app.post('/api/deactivate', (req, res) => {
  const { licenseKey } = req.body;

  try {
    const result = db.prepare('UPDATE licenses SET system_fingerprint = NULL, activation_count = 0 WHERE license_key = ?').run(licenseKey);
    
    if (result.changes === 0) {
      return res.status(404).json({ success: false, error: 'License not found' });
    }
    
    res.json({ success: true, message: 'License deactivated' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin endpoint to see all licenses
app.get('/admin/licenses', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM licenses ORDER BY created_at DESC').all();
    res.json({ licenses: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Simple home page
app.get('/', (req, res) => {
  res.json({ 
    message: 'Hardware License Server is running!',
    environment: NODE_ENV,
    port: PORT,
    database: 'SQLite (better-sqlite3) - Universal',
    endpoints: {
      activate: 'POST /api/activate',
      validate: 'POST /api/validate',
      check: 'POST /api/check-license',
      debug: 'GET /api/debug/data'
    }
  });
});

// Server configuration for Railway
const HOST = NODE_ENV === 'production' ? '0.0.0.0' : 'localhost';

app.listen(PORT, HOST, () => {
  console.log(`🚀 License server running in ${NODE_ENV} mode`);
  console.log(`🌐 Accessible at: http://${HOST}:${PORT}`);
  console.log(`🔑 Gumroad API: ${GUMROAD_ACCESS_TOKEN ? 'CONFIGURED' : 'NOT CONFIGURED - PLEASE SET TOKEN'}`);
  console.log(`🔐 Using EXACT developer tool algorithm`);
  console.log(`📦 ENFORCING GUMROAD PURCHASE QUANTITY LIMITS`);
  console.log(`📊 Database: SQLite (better-sqlite3)`);
});

process.on('SIGINT', () => {
  console.log('Shutting down gracefully...');
  db.close();
  process.exit(0);
});