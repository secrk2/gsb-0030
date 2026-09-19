'use strict';
/* 本地冒烟启动器：用 pg-mem 承载数据库，在 8130 端口启动真实服务（含种子数据）。
 * 仅用于无 Docker 环境的本地验证；compose 部署走真实 Postgres。 */
const { newDb } = require('pg-mem');
const mem = newDb();
const adapter = mem.adapters.createPg();
const pgPath = require.resolve('pg');
require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { ...adapter, Pool: adapter.Pool } };

(async () => {
  const { initDb, waitForDb } = require('./src/db');
  await initDb();
  await waitForDb();
  const { seed } = require('./db/seed');
  await seed();
  const { app } = require('./src/server');
  app.listen(8130, '0.0.0.0', () => console.log('冒烟服务: http://localhost:8130'));
})();
