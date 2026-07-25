/**
 * Express сервер для extract-archives-aksioma
 *
 * Endpoints:
 * - GET  /            — health
 * - GET  /health      — health check
 * - POST /api/extract-archives  — основной (для ручного вызова)
 * - POST /api/pyrus-webhook     — webhook от Pyrus
 */

import express from 'express';
import extractHandler from './api/extract-archives.js';
import webhookHandler from './api/pyrus-webhook.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Health
app.get('/', (req, res) => res.json({ status: 'ok', service: 'extract-archives-aksioma' }));
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'extract-archives-aksioma' }));

// API
app.all('/api/extract-archives', (req, res) => extractHandler(req, res));
app.all('/api/pyrus-webhook', (req, res) => webhookHandler(req, res));

// Error handler
app.use((err, req, res, next) => {
  console.error('[SERVER ERROR]', err);
  res.status(500).json({ error: err.message || 'Internal error' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[SERVER] extract-archives-aksioma listening on port ${PORT}`);
});
