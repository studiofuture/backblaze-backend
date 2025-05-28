require('dotenv').config();
const express = require('express');
const http = require('http');

// MINIMAL EXPRESS APP FOR DEBUGGING
const app = express();
const server = http.createServer(app);

// SUPER SIMPLE CORS - no fancy stuff
app.use((req, res, next) => {
  console.log(`🔥 REQUEST: ${req.method} ${req.url} from ${req.headers.origin || 'no-origin'}`);
  
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', '*');
  res.header('Access-Control-Allow-Headers', '*');
  
  if (req.method === 'OPTIONS') {
    console.log(`🔥 OPTIONS PREFLIGHT: ${req.url}`);
    return res.status(200).end();
  }
  
  next();
});

app.use(express.json());

// TEST ROUTES - SUPER SIMPLE
app.get('/', (req, res) => {
  console.log('🔥 ROOT ROUTE HIT');
  res.json({ message: 'Root works!' });
});

app.get('/test', (req, res) => {
  console.log('🔥 TEST ROUTE HIT');
  res.json({ message: 'Test route works!' });
});

app.get('/upload/test', (req, res) => {
  console.log('🔥 UPLOAD/TEST ROUTE HIT');
  res.json({ message: 'Upload test route works!' });
});

app.get('/upload/status/test', (req, res) => {
  console.log('🔥 UPLOAD/STATUS/TEST ROUTE HIT');
  res.json({ message: 'Upload status test route works!' });
});

app.get('/upload/status/:uploadId', (req, res) => {
  console.log(`🔥 UPLOAD STATUS ROUTE HIT: ${req.params.uploadId}`);
  res.json({ 
    message: 'Status route works!',
    uploadId: req.params.uploadId,
    timestamp: new Date().toISOString()
  });
});

// CATCH ALL ROUTE
app.get('*', (req, res) => {
  console.log(`🔥 CATCH ALL HIT: ${req.url}`);
  res.status(404).json({ 
    error: 'Route not found',
    path: req.url,
    method: req.method
  });
});

// LIST ALL ROUTES
console.log('🔥 REGISTERED ROUTES:');
app._router.stack.forEach((middleware) => {
  if (middleware.route) {
    const methods = Object.keys(middleware.route.methods).join(', ').toUpperCase();
    console.log(`🔥 ${methods} ${middleware.route.path}`);
  }
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`🔥 NUCLEAR DEBUG SERVER RUNNING ON PORT ${port}`);
  console.log(`🔥 Test these URLs:`);
  console.log(`🔥 - /`);
  console.log(`🔥 - /test`);
  console.log(`🔥 - /upload/test`);
  console.log(`🔥 - /upload/status/test`);
  console.log(`🔥 - /upload/status/upload_123456789`);
});

module.exports = { app, server };