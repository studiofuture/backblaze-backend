const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

/**
 * Swagger Documentation Route
 * Serves OpenAPI/Swagger documentation
 */

// Serve Swagger YAML file
router.get('/swagger.yaml', (req, res) => {
  const swaggerPath = path.join(__dirname, '..', 'swagger.yaml');
  
  if (fs.existsSync(swaggerPath)) {
    res.setHeader('Content-Type', 'application/yaml');
    res.sendFile(swaggerPath);
  } else {
    res.status(404).json({ error: 'Swagger documentation not found' });
  }
});

// Serve Swagger JSON (converted from YAML)
router.get('/swagger.json', (req, res) => {
  const swaggerPath = path.join(__dirname, '..', 'swagger.yaml');
  
  if (!fs.existsSync(swaggerPath)) {
    console.error(`❌ Swagger file not found at: ${swaggerPath}`);
    return res.status(404).json({ 
      error: 'Swagger documentation not found',
      path: swaggerPath
    });
  }
  
  try {
    const yaml = require('js-yaml');
    const swaggerContent = fs.readFileSync(swaggerPath, 'utf8');
    
    if (!swaggerContent || swaggerContent.trim().length === 0) {
      throw new Error('Swagger file is empty');
    }
    
    const swaggerJson = yaml.load(swaggerContent);
    
    if (!swaggerJson) {
      throw new Error('Failed to parse YAML - result is null or undefined');
    }
    
    res.setHeader('Content-Type', 'application/json');
    res.json(swaggerJson);
  } catch (error) {
    console.error('❌ Swagger JSON parsing error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ 
      error: 'Failed to parse Swagger documentation',
      details: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Serve Swagger UI HTML page
router.get('/', (req, res) => {
  const swaggerUrl = `${req.protocol}://${req.get('host')}/swagger/swagger.json`;
  
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Backblaze Backend API Documentation</title>
  <link rel="stylesheet" type="text/css" href="https://unpkg.com/swagger-ui-dist@5.9.0/swagger-ui.css" />
  <style>
    html {
      box-sizing: border-box;
      overflow: -moz-scrollbars-vertical;
      overflow-y: scroll;
    }
    *, *:before, *:after {
      box-sizing: inherit;
    }
    body {
      margin:0;
      background: #fafafa;
    }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.9.0/swagger-ui-bundle.js"></script>
  <script src="https://unpkg.com/swagger-ui-dist@5.9.0/swagger-ui-standalone-preset.js"></script>
  <script>
    window.onload = function() {
      const ui = SwaggerUIBundle({
        url: "${swaggerUrl}",
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [
          SwaggerUIBundle.presets.apis,
          SwaggerUIStandalonePreset
        ],
        plugins: [
          SwaggerUIBundle.plugins.DownloadUrl
        ],
        layout: "StandaloneLayout",
        validatorUrl: null
      });
    };
  </script>
</body>
</html>
  `;
  
  res.send(html);
});

module.exports = router;

