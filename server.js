require('dotenv').config();
const express = require('express');
const http = require('http');

// DEBUG THE PORT ISSUE
console.log('🔥🔥🔥 PORT DEBUGGING 🔥🔥🔥');
console.log('process.env.PORT:', process.env.PORT);
console.log('process.env.NODE_ENV:', process.env.NODE_ENV);
console.log('All PORT-related env vars:');
Object.keys(process.env)
  .filter(key => key.toLowerCase().includes('port'))
  .forEach(key => console.log(`${key}: ${process.env[key]}`));

const app = express();
const server = http.createServer(app);

// SUPER SIMPLE CORS
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

// SIMPLE TEST ROUTES
app.get('/', (req, res) => {
  console.log('🔥 ROOT ROUTE HIT - SUCCESS!');
  res.json({ 
    message: 'Root works!',
    port: process.env.PORT,
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV
  });
});

app.get('/health', (req, res) => {
  console.log('🔥 HEALTH ROUTE HIT');
  res.json({ 
    status: 'ok',
    port: process.env.PORT,
    timestamp: new Date().toISOString()
  });
});

app.get('/test', (req, res) => {
  console.log('🔥 TEST ROUTE HIT');
  res.json({ 
    message: 'Test route works!',
    port: process.env.PORT
  });
});

app.get('/upload/status/:uploadId', (req, res) => {
  console.log(`🔥 UPLOAD STATUS ROUTE HIT: ${req.params.uploadId}`);
  res.json({ 
    message: 'Status route works!',
    uploadId: req.params.uploadId,
    port: process.env.PORT,
    timestamp: new Date().toISOString()
  });
});

// CATCH ALL - SHOULD BE LAST
app.use('*', (req, res) => {
  console.log(`🔥 CATCH ALL HIT: ${req.method} ${req.originalUrl}`);
  res.status(404).json({ 
    error: 'Route not found',
    path: req.originalUrl,
    method: req.method,
    port: process.env.PORT
  });
});

// FORCE THE CORRECT PORT
const port = process.env.PORT || 3000;

// MAKE SURE WE'RE LISTENING ON ALL INTERFACES
server.listen(port, '0.0.0.0', () => {
  console.log(`🔥🔥🔥 SERVER SUCCESSFULLY STARTED 🔥🔥🔥`);
  console.log(`🔥 Port: ${port}`);
  console.log(`🔥 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔥 Listening on: 0.0.0.0:${port}`);
  console.log(`🔥🔥🔥 TEST THESE URLS 🔥🔥🔥`);
  console.log(`🔥 Root: https://backblaze-backend-22ih.onrender.com/`);
  console.log(`🔥 Health: https://backblaze-backend-22ih.onrender.com/health`);
  console.log(`🔥 Test: https://backblaze-backend-22ih.onrender.com/test`);
  console.log(`🔥 Status: https://backblaze-backend-22ih.onrender.com/upload/status/test123`);
});

// ERROR HANDLING
server.on('error', (error) => {
  console.error('🔥 SERVER ERROR:', error);
  if (error.code === 'EADDRINUSE') {
    console.error(`🔥 Port ${port} is already in use`);
  }
});

module.exports = { app, server };