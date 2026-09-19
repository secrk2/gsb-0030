'use strict';

const express = require('express');
const path = require('path');
const { initDb, waitForDb } = require('./db');
const routes = require('./routes');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(routes);
app.use(express.static(path.join(__dirname, '..', 'public')));

// 兜底错误处理
app.use((err, req, res, next) => {
  console.error('[api]', err.message);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({
    error: err.message || '服务器内部错误',
    ...(err.cycle ? { cycle: err.cycle } : {}),
  });
});

const PORT = Number(process.env.PORT || 8130);

async function main() {
  await initDb();
  await waitForDb();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`序流 Xuliu 已启动: http://localhost:${PORT}`);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('启动失败:', err);
    process.exit(1);
  });
}

module.exports = { app };
