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
-- machines.auto_content 最近一次自动上报的 base64 原文；手动编辑时保留，供“恢复自动上报”回退（老库由 admin/schema 自动补列）
-- settings.machine_order 保存机器排序（JSON 数组）

CREATE TABLE IF NOT EXISTS machines (
  machine    TEXT PRIMARY KEY,
  content    TEXT NOT NULL,
  hash       TEXT NOT NULL,
  bytes      INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  nodes_json TEXT NOT NULL DEFAULT '[]',
  manual     INTEGER NOT NULL DEFAULT 0,
  auto_content TEXT
);

CREATE INDEX IF NOT EXISTS idx_machines_updated_at ON machines (updated_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 老库升级（已有 machines 表时执行；重复执行会报 duplicate column，忽略即可）：
-- ALTER TABLE machines ADD COLUMN auto_content TEXT;
