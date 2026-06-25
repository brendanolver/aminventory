const express = require('express');
const https = require('https');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const AM_TOKEN = process.env.AM_TOKEN || 'fb4a2550eae39c0887c3928d8ca7c6e8';
const AM_SUBDOMAIN = process.env.AM_SUBDOMAIN || 'kohindustries';
const WAREHOUSE_ID = '1002'; // Shopify Online Store
const VENDOR_ID = '1000';   // Adjustment Vendor

function amRequest(method, endpoint, params = {}, body = null) {
  const t = Math.floor(Date.now() / 1000);
  const qs = new URLSearchParams({ time: t, token: AM_TOKEN, ...params }).toString();
  const url = `https://${AM_SUBDOMAIN}.app.apparelmagic.com/api/json/${endpoint}/?${qs}`;

  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify({ time: t, token: AM_TOKEN, ...body }) : null;
    const req = https.request(url, {
      method,
      headers: {
        'User-Agent': 'KOH-StockScanner/1.0',
        ...(payload ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode, data: raw });
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Lookup SKU by barcode (upc_display) or sku_alt
app.get('/api/lookup/:barcode', async (req, res) => {
  try {
    const barcode = req.params.barcode.trim();

    // Try upc_display first, then sku_alt
    let result = await amRequest('GET', 'inventory', {
      'pagination[page_size]': 10,
      upc_display: barcode,
    });

    let rows = result.data.response || [];
    if (!rows.length) {
      result = await amRequest('GET', 'inventory', {
        'pagination[page_size]': 10,
        sku_alt: barcode,
      });
      rows = result.data.response || [];
    }

    if (result.status !== 200) {
      return res.status(502).json({ error: 'Apparel Magic API error', details: result.data });
    }

    const match = rows[0] || null;

    if (!match) {
      return res.json({ found: false, barcode });
    }

    // Get current warehouse qty for 1002
    const whResult = await amRequest('GET', 'sku_warehouse', {
      'pagination[page_size]': 10,
      warehouse_id: WAREHOUSE_ID,
      sku_id: match.sku_id,
    });
    const whRow = (whResult.data.response || []).find(r => r.sku_id === match.sku_id);

    res.json({
      found: true,
      sku_id: match.sku_id,
      product_id: match.product_id,
      sku_alt: match.sku_alt,
      upc_display: match.upc_display,
      style_number: match.style_number,
      description: match.description,
      size: match.size,
      attr_2: match.attr_2,
      cost: match.cost,
      current_qty: whRow ? parseFloat(whRow.qty_inventory) : 0,
    });
  } catch (err) {
    console.error('Lookup error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Create a receiver to add stock
app.post('/api/receive', async (req, res) => {
  try {
    const { sku_id, qty, cost } = req.body;
    if (!sku_id || !qty || qty <= 0) {
      return res.status(400).json({ error: 'sku_id and qty (>0) required' });
    }

    const today = new Date().toLocaleDateString('en-US', {
      month: '2-digit', day: '2-digit', year: 'numeric'
    });

    const result = await amRequest('POST', 'receivers', {}, {
      warehouse_id: WAREHOUSE_ID,
      vendor_id: VENDOR_ID,
      date: today,
      adjustment_type: 'both',
      receiver_items: [{
        sku_id,
        qty: String(qty),
        warehouse_id: WAREHOUSE_ID,
        unit_cost: cost || '0',
        is_inventory: '1',
      }],
    });

    if (result.status === 200 || result.status === 201) {
      res.json({ success: true, receiver: result.data });
    } else {
      res.status(502).json({ success: false, error: 'AM API returned ' + result.status, details: result.data });
    }
  } catch (err) {
    console.error('Receive error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Batch receive - multiple SKUs in one receiver
app.post('/api/receive-batch', async (req, res) => {
  try {
    const { items } = req.body; // [{ sku_id, qty, cost }]
    if (!items?.length) {
      return res.status(400).json({ error: 'items array required' });
    }

    const today = new Date().toLocaleDateString('en-US', {
      month: '2-digit', day: '2-digit', year: 'numeric'
    });

    const result = await amRequest('POST', 'receivers', {}, {
      warehouse_id: WAREHOUSE_ID,
      vendor_id: VENDOR_ID,
      date: today,
      adjustment_type: 'both',
      receiver_items: items.map(item => ({
        sku_id: item.sku_id,
        qty: String(item.qty),
        warehouse_id: WAREHOUSE_ID,
        unit_cost: item.cost || '0',
        is_inventory: '1',
      })),
    });

    const errors = result.data?.meta?.errors || [];
    if (result.status === 200 && errors.length === 0) {
      res.json({ success: true });
    } else {
      res.status(502).json({ success: false, error: errors.join('; ') || 'AM API returned ' + result.status, details: result.data });
    }
  } catch (err) {
    console.error('Batch receive error:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3333;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Stock Scanner running on http://localhost:${PORT}`);
});
