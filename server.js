require('dotenv').config();
const express = require('express');
const paypal = require('paypal-rest-sdk');
const path = require('path');

const app = express();
app.use(express.json());

// Resolve base URL for redirects (useful if port changes)
const HOST = process.env.HOST || 'localhost';
const PORT = parseInt(process.env.PORT, 10) || 3000;
const BASE_URL = `http://${HOST}:${PORT}`;

// Enable CORS for development (allows requests from Live Server / other origins)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  next();
});

// Respond to preflight requests so browsers can call our API
app.options('*', (req, res) => {
  res.sendStatus(204);
});

// Log requests for debugging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl}`);
  next();
});

app.use(express.static(path.join(__dirname, '.'))); // Serve static files from current directory

// Serve the main storefront page at the root path
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'Test 3.html'));
});

// Configure PayPal (use env vars so credentials are not stored in source)
const normalizeEnv = (value) => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.replace(/^['"]|['"]$/g, '');
};

const PAYPAL_CLIENT_ID = normalizeEnv(process.env.PAYPAL_CLIENT_ID) || 'YOUR_LIVE_CLIENT_ID_HERE';
const PAYPAL_CLIENT_SECRET = normalizeEnv(process.env.PAYPAL_CLIENT_SECRET) || 'YOUR_LIVE_CLIENT_SECRET_HERE';

const mask = (str) => {
  if (!str) return '(none)';
  const visible = `${str.slice(0, 6)}...${str.slice(-6)}`;
  return `${visible} (len=${str.length})`;
};

if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) {
  console.warn('⚠️ PayPal credentials not set. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET environment variables.');
} else if (
  process.env.PAYPAL_CLIENT_ID !== PAYPAL_CLIENT_ID ||
  process.env.PAYPAL_CLIENT_SECRET !== PAYPAL_CLIENT_SECRET
) {
  console.warn('⚠️ PayPal credentials were normalized (e.g., wrapped quotes removed).');
}

const PAYPAL_MODE = (normalizeEnv(process.env.PAYPAL_MODE) || 'sandbox').toLowerCase();

console.log('PayPal mode:', PAYPAL_MODE);
console.log('PayPal Client ID (masked):', mask(PAYPAL_CLIENT_ID));
console.log('PayPal Client Secret (masked):', mask(PAYPAL_CLIENT_SECRET));

paypal.configure({
  mode: PAYPAL_MODE, // 'sandbox' or 'live'
  client_id: PAYPAL_CLIENT_ID,
  client_secret: PAYPAL_CLIENT_SECRET
});

// In-memory sales history (in production, use a database)
let salesHistory = [];

// Add sale to history
function recordSale(paymentId, itemName, amount) {
  const sale = {
    id: 'SALE_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
    date: new Date().toISOString(),
    paymentId: paymentId,
    itemName: itemName,
    amount: parseFloat(amount),
    status: 'completed'
  };
  salesHistory.unshift(sale);
  // Keep only last 100 sales in memory
  if (salesHistory.length > 100) {
    salesHistory = salesHistory.slice(0, 100);
  }
  console.log('Sale recorded:', sale);
  return sale;
}

// Create payment
app.post('/create-payment', (req, res) => {
  const { amount, itemName } = req.body;
  console.log('Create payment request:', { amount, itemName });

  // Validate input
  if (!amount || !itemName) {
    return res.status(400).json({ error: 'Amount and itemName are required' });
  }

  const create_payment_json = {
    intent: 'sale',
    payer: { payment_method: 'paypal' },
    redirect_urls: {
      return_url: `${BASE_URL}/return`,
      cancel_url: `${BASE_URL}/cancel`
    },
    transactions: [{
      item_list: {
        items: [{
          name: itemName,
          sku: '001',
          price: amount.toString(),
          currency: 'USD',
          quantity: 1
        }]
      },
      amount: {
        currency: 'USD',
        total: amount.toString()
      },
      description: `Purchase: ${itemName}`
    }]
  };

  paypal.payment.create(create_payment_json, (error, payment) => {
    if (error) {
      console.error('PayPal create payment error:', error);
      const errorMessage = error.response && error.response.message ? error.response.message : 'Failed to create payment';
      res.status(500).json({
        error: 'Failed to create PayPal payment',
        message: errorMessage,
        details: error && (error.response || error.toString())
      });
    } else {
      console.log('Payment created successfully:', payment.id);
      res.json({ id: payment.id, links: payment.links });
    }
  });
});

// Execute payment
app.post('/execute-payment', (req, res) => {
  const { paymentId, payerId } = req.body;
  
  if (!paymentId || !payerId) {
    return res.status(400).json({ error: 'paymentId and payerId are required' });
  }

  console.log('Executing payment:', { paymentId, payerId });
  
  paypal.payment.execute(paymentId, { payer_id: payerId }, (error, payment) => {
    if (error) {
      console.error('Payment execution error:', error);
      res.status(500).json({ 
        error: 'Payment execution failed',
        message: error.message,
        details: error.response || error.toString()
      });
    } else {
      console.log('Payment executed successfully:', paymentId);
      res.json({ status: 'success', payment });
    }
  });
});

// Return page (after PayPal approval)
app.get('/return', (req, res) => {
  const { paymentId, PayerID } = req.query;
  
  if (!paymentId || !PayerID) {
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head><title>Payment Error</title></head>
      <body style="font-family: Arial; padding: 20px;">
        <h1>❌ Payment Error</h1>
        <p>Missing payment information. Please try again.</p>
        <a href="/" style="color: #ff6b35;">← Return to Store</a>
      </body>
      </html>
    `);
  }
  
  // Execute the payment
  paypal.payment.execute(paymentId, { payer_id: PayerID }, (error, payment) => {
    if (error) {
      console.error('Payment execution error:', error);
      res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>Payment Failed</title></head>
        <body style="font-family: Arial; padding: 20px;">
          <h1>❌ Payment Failed</h1>
          <p>There was an error processing your payment.</p>
          <p style="color: red; font-size: 0.9rem;">${error.message || 'Unknown error'}</p>
          <a href="/" style="color: #ff6b35;">← Return to Store</a>
        </body>
        </html>
      `);
    } else {
      console.log('Payment successful:', paymentId);
      // Record the sale
      if (payment.transactions && payment.transactions[0]) {
        const transaction = payment.transactions[0];
        const itemName = transaction.description || 'Item';
        const amount = transaction.amount.total;
        recordSale(paymentId, itemName, amount);
      }
      // Redirect to success page with payment info
      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Payment Successful</title>
          <script>
            // Store success info and redirect
            localStorage.setItem('paymentSuccess', 'true');
            localStorage.setItem('paymentId', '${paymentId}');
            window.location.href = '/?paymentComplete=true';
          </script>
        </head>
        <body style="font-family: Arial; padding: 20px; text-align: center;">
          <h1>✅ Payment Successful!</h1>
          <p>Your payment has been processed successfully.</p>
          <p>Payment ID: ${paymentId}</p>
          <p>Redirecting to store...</p>
        </body>
        </html>
      `);
    }
  });
});

// Cancel page
app.get('/cancel', (req, res) => {
  res.send('<h1>Payment Cancelled</h1><p>Your payment was cancelled.</p><a href="/">Return to Store</a>');
});

// Get sales history
app.get('/sales-history', (req, res) => {
  res.json(salesHistory);
});

// Get sales statistics
app.get('/sales-stats', (req, res) => {
  const totalSales = salesHistory.length;
  const totalRevenue = salesHistory.reduce((sum, sale) => sum + (sale.amount || 0), 0);
  const uniqueCustomers = new Set(salesHistory.map(s => s.customer)).size;
  
  res.json({
    totalSales,
    totalRevenue: totalRevenue.toFixed(2),
    uniqueCustomers,
    averageOrderValue: totalSales > 0 ? (totalRevenue / totalSales).toFixed(2) : 0
  });
});

app.listen(PORT, () => console.log(`Server running on ${BASE_URL}`));