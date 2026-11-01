-- sub-worker D1 schema (SQLite)
-- 用法：
--   pnpm exec wrangler d1 execute sub-worker-db --remote --file=scripts/schema.sql
--   pnpm exec wrangler d1 execute sub-worker-db --local  --file=scripts/schema.sql
-- 也可在部署后调用一次 POST /api/v1/admin/schema （Bearer TOKEN），效果相同且幂等。
--
-- machines.machine   机器 slug（主键）
-- machines.content   base64 订阅原文
-- machines.hash      content 的 SHA-256，用于去重
-- machines.nodes_json 节点数组 JSON：[{id,name,link,protocol,order}]
-- machines.manual    1 = WebUI 手动编辑过，自动上报不再覆盖
-- settings.machine_order 保存机器排序（JSON 数组）

CREATE TABLE IF NOT EXISTS machines (
  machine    TEXT PRIMARY KEY,
  content    TEXT NOT NULL,
  hash       TEXT NOT NULL,
  bytes      INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  nodes_json TEXT NOT NULL DEFAULT '[]',
  manual     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_machines_updated_at ON machines (updated_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
