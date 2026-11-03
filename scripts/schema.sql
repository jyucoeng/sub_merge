-- sub-merge D1 schema (SQLite)
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
-- machines.nodes_json 最近一次自动上报解析出的节点
-- machines.manual_nodes_json WebUI 手写的节点；上报只改 nodes_json，两者互不覆盖
-- machines.auto_content 1.6.0 的遗留列，1.7.0 起由 manual_nodes_json 取代（老库由 admin/schema 自动补列并迁移）
-- reports.machine/source 上报来源：一台机器可以被多个上报源写入（?source= 或 X-Source 头），互不覆盖
CREATE TABLE IF NOT EXISTS reports (
  machine    TEXT NOT NULL,
  source     TEXT NOT NULL,
  content    TEXT NOT NULL,
  hash       TEXT NOT NULL,
  bytes      INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  nodes_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (machine, source)
);

CREATE INDEX IF NOT EXISTS idx_reports_machine ON reports (machine);

-- settings.machine_order 保存机器排序（JSON 数组）

CREATE TABLE IF NOT EXISTS machines (
  machine    TEXT PRIMARY KEY,
  content    TEXT NOT NULL,
  hash       TEXT NOT NULL,
  bytes      INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  nodes_json TEXT NOT NULL DEFAULT '[]',
  manual_nodes_json TEXT NOT NULL DEFAULT '[]',
  manual     INTEGER NOT NULL DEFAULT 0,
  auto_content TEXT,
  manual_updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_machines_updated_at ON machines (updated_at DESC);

-- presets.*  订阅档案：把「哪些协议细分 / 隧道 / 哪几台机器 / 什么格式」存下来，
--           对外给一条短链接 /sub/p/<name>/<token>，内容是实时筛的，跟着节点变。
CREATE TABLE IF NOT EXISTS links (
  code       TEXT PRIMARY KEY,
  preset     TEXT NOT NULL,
  format     TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  hits       INTEGER NOT NULL DEFAULT 0,
  last_at    TEXT
);

CREATE TABLE IF NOT EXISTS presets (
  name       TEXT PRIMARY KEY,
  label      TEXT NOT NULL DEFAULT '',
  protos     TEXT NOT NULL DEFAULT '',
  tunnel     TEXT NOT NULL DEFAULT '',
  machines   TEXT NOT NULL DEFAULT '',
  format     TEXT NOT NULL DEFAULT '',
  token      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  skips      TEXT NOT NULL DEFAULT '',
  members    TEXT NOT NULL DEFAULT '',
  mode       TEXT NOT NULL DEFAULT '',
  clash_mode TEXT NOT NULL DEFAULT 'inherit'
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- machine_former 改名记录：alias（旧机器名）→ target（现在真正在用的机器名）。
-- 上报脚本里的机器名写在脚本里，改了名它还在按旧名报，靠这张表转过去。
-- 早先整张表是一个 settings row，改名要「读出来→改→整张写回」，
-- 两台同时改名会互相覆盖；现在一条一名，写的是单行 upsert。
-- 老数据在第一次读的时候自动搬过来，搬完就删掉那个 settings row。
CREATE TABLE IF NOT EXISTS machine_former (
  alias  TEXT PRIMARY KEY,
  target TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_machine_former_target ON machine_former (target);


-- 老库升级（已有 machines 表时执行；重复执行会报 duplicate column，忽略即可）：
-- ALTER TABLE machines ADD COLUMN auto_content TEXT;
-- ALTER TABLE machines ADD COLUMN manual_nodes_json TEXT NOT NULL DEFAULT '[]';
-- ALTER TABLE machines ADD COLUMN manual_updated_at TEXT;
-- 升级后调用一次 POST /api/v1/admin/schema，会把老的手动机器拆成手动节点 + 上报节点。
