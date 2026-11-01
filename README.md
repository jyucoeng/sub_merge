# sub-worker

一个部署在 Cloudflare Workers 上的**固定订阅入口**：多台 singbox-manager 把各自的订阅上报到 Worker，客户端通过一个不会随服务器重启变化的 URL 获取订阅。

临时 `*.trycloudflare.com` 隧道在 cloudflared 重启后会换随机域名；本项目把订阅内容集中到固定 Worker 域名，解决这个问题。

## 特性

- 固定订阅 URL，重启/重新部署 Worker 不变；
- 一个 `TOKEN` 同时用于上报和读取；
- 每台机器一个 `machine` slug，支持单机和合并订阅；
- **Cloudflare D1（SQLite）单一存储**，两张表 `machines` / `settings`，不依赖 KV 或 R2；
- 按内容 SHA-256 去重，相同内容不重复写；
- 读取强一致：上报后立即能在合并订阅里读到；合并订阅是一次 `SELECT`，无 N+1；
- **WebUI 可以编辑节点链接、节点名称、机器顺序和节点顺序**；
- **自动适配 base64 / Clash / sing-box 订阅格式**；
- 手动编辑后，机器自动上报不会覆盖手动配置；
- 支持 `workers.dev` 默认域名和自定义域名；
- 自动从请求 `Origin` 推断对外域名，无需配置 `PUBLIC_BASE_URL`；
- 提供单文件 `worker.single.js`，可直接粘贴到 Cloudflare Dashboard；
- 提供一个多机上报脚本 `scripts/report.py`。

## 架构

```text
singbox-manager（每台 NAT 机）
  sbm sub / 订阅文件
        │  POST base64
        ▼
Cloudflare Worker（固定 workers.dev / 自定义域名）
        │  GET /sub/:machine/:token
        │  GET /sub/:token              # 全部机器合并
        ▼
客户端订阅
```

## 快速开始（Wrangler）

```bash
git clone https://github.com/famintt/sub-worker.git
cd sub-worker
pnpm install
```

### 1. 创建 D1 数据库

```bash
pnpm exec wrangler d1 create sub-worker-db   # 等同于 pnpm run db:create
```

把输出的 `database_id` 填进 `wrangler.toml`：

```toml
[[d1_databases]]
binding = "DB"                               # 变量名必须是 DB
database_name = "sub-worker-db"
database_id = "你的 D1 database_id"
```

### 2. 建表

```bash
pnpm run db:init        # wrangler d1 execute --remote --file=scripts/schema.sql
```

也可以部署之后调一次接口（效果相同，幂等）：

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" https://<worker>/api/v1/admin/schema
```

建表语句就是 `scripts/schema.sql` 里的三条 DDL，重复执行不会报错，也不会清数据。

### 3. 设置 TOKEN

```bash
pnpm exec wrangler secret put TOKEN
```

`TOKEN` 是唯一认证凭证，上报和读取共用。建议使用 UUID v4 或 32 字节随机 URL-safe 字符串。

### 4. 部署

```bash
pnpm exec wrangler deploy
```

默认会得到一个固定地址：

```text
https://<worker-name>.<你的子域>.workers.dev
```

### 5. 绑定自定义域名（可选）

在 Cloudflare Dashboard：

```text
Workers & Pages → 你的 Worker → Settings → Domains & Routes → Add Custom Domain
```

填例如 `sub.example.com` 即可。Worker 会根据请求 `Origin` 自动识别域名，不需要改代码或加变量。

## Dashboard 单文件部署

不想用 Wrangler 时：

1. Workers & Pages → Create Worker；
2. 复制根目录的 `worker.single.js` 全部粘贴；
3. 新建 D1 数据库：Storage & Databases → D1 → Create；
4. 在 Worker 的 Settings → Bindings 添加绑定：
   - 类型：D1 database
   - Variable name：`DB`（必须是这个名字）
   - D1 database：刚创建的那个；
5. 建表：在该 D1 的 Console 里贴入 `scripts/schema.sql` 执行，或部署后调用一次 `POST /api/v1/admin/schema`；
6. Settings → Variables and Secrets 添加一个 Secret：
   - `TOKEN`：你的 token；
7. Deploy；
8. 需要自定义域名时，在 Domains & Routes 绑定。

## WebUI

部署后访问：

```text
https://<worker>/ui/<TOKEN>
```

界面支持：

- 选择机器；没有机器上报时用“新建机器”直接建一台（名字可留空，自动命名 `manual-1`、`manual-2`…）；
- **重命名**：选中机器后点“重命名”，节点、手动标记和在合并订阅里的位置一起搬到新名字；目标名字已被占用会拒绝，不会覆盖；
- **机器列表上移/下移，保存合并订阅中的机器顺序**，末列的 `×` 删除整台机器（连同它的手动配置）；
- **批量粘贴导入**：把一整段订阅或多条链接贴进“批量粘贴”框，一行一条，点“解析并添加”，自动拆成多行节点并逐条去重；也可以直接把多条链接粘进某一行的链接框（粘到空行上时那行会被替换）；
- 链接框粘贴后若“显示名称”为空，会自动取 `#` 后面那段（URL 解码后）作为名称，例如 `...hy2-localhost` 那三条会变成 `小叮当-洛杉矶-cloudnium-hy2-localhost`；链接里没有 `#` 时按 `协议-服务器` 生成，比如 `VLESS-1.2.3.4`；vmess 则取 JSON 里的 `ps` 字段；
- 修改节点链接和显示名称；
- 上移、下移调整节点顺序；
- 添加、删除节点；
- 保存后订阅立即按新顺序生成；
- “恢复自动上报”会清除手动配置，重新采用最近一次上报内容。

手动保存后，机器继续自动上报也不会覆盖已编辑节点；需要恢复自动更新时点“恢复自动上报”。
名称留空也能保存：服务端会按同样的规则（`#` 片段 → `协议-服务器`）补齐，不会出现空名字的节点。

## 机器名是什么

机器名（slug，规则 `[a-z0-9][a-z0-9-]{0,63}`）**只是一个分组用的名字**，是 `machines` 表的主键，也是合并订阅里的排序单位。它跟节点实际属于哪台服务器、哪个机场、哪个地区都没有绑定关系：Worker 不会校验节点内容，也不会因为名字叫 `hk-1` 就要求里面必须是香港节点。

所以两种用法都可以：

| 用法 | 长什么样 | 适合 |
| --- | --- | --- |
| 一台一个桶 | `hk-1`、`jp-tokyo`、`us-la`，每台放自己的节点 | 多台服务器各自上报，或想按机器分组排序 |
| 一台装全部 | 只用 `manual-1`，把十来个来源的节点全塞进去 | 纯手动维护，不在乎分组，只想拼成一个订阅 |

节点在合并订阅里按“机器顺序 → 机器内节点顺序”排列，所以想让某些节点排前面，既可以调整机器顺序，也可以把常用节点放进排在前面的那台机器里。

名字随时能改（“重命名”按钮，或 `POST /api/v1/machines/:machine/rename`）。改名是整行搬家：节点、`manual` 标记、`updated_at` 和它在 `machine_order` 里的位置都跟着走，旧名字立刻消失，合并订阅不会断。

## 两种来源混用

同一个 `machines` 表同时装两种机器，界面上用徽章区分，合并订阅把它们平等拼在一起：

| 来源 | 谁写入 | `manual` | 节点从哪来 | 列表徽章 |
| --- | --- | --- | --- | --- |
| 机器自动上报 | 客户端 `POST /api/v1/report/<machine>` | 0 | 上报内容解析出的节点 | 蓝色「上报」 |
| 手动新建 | “新建机器” + 粘贴节点 | 1 | 界面里编辑的节点 | 黄色「手动」 |

- 一次加一个节点：点“+ 添加节点”；一次加多个：批量粘贴框整段贴入，或往链接框里粘多行；
- 新建机器时批量框里已经有链接，会连节点一起建好，不用建完再保存；
- 同名冲突：新建的名字正好是正在上报的机器时，不新建第二行，而是切过去并提示；保存节点后这台机器转成手动，之后上报只更新 `content`/`hash`，**不动你编辑过的节点**，点“恢复自动上报”才交还。

## 订阅格式

客户端 `User-Agent` 会自动识别：

| 客户端 / 参数 | 格式 |
|---|---|
| V2RayN、默认 | base64 URI |
| Clash、Mihomo、Meta | Clash YAML |
| sing-box / singbox | sing-box JSON |

也可以显式指定：

```text
/sub/all/<TOKEN>?format=base64
/sub/all/<TOKEN>?format=clash
/sub/all/<TOKEN>?format=singbox
/sub/all/<TOKEN>?clash
/sub/all/<TOKEN>?singbox
```

支持转换的节点链接包括：

```text
vless://
anytls://
hysteria2://
tuic://
trojan://
ss://
vmess://
```

## 数据表（D1）

只有两张表，`scripts/schema.sql` 就是完整定义：

```sql
CREATE TABLE IF NOT EXISTS machines (
  machine    TEXT PRIMARY KEY,           -- 机器 slug：[a-z0-9][a-z0-9-]{0,63}
  content    TEXT NOT NULL,              -- base64 订阅原文
  hash       TEXT NOT NULL,              -- content 的 SHA-256，用于去重
  bytes      INTEGER NOT NULL DEFAULT 0, -- base64 长度
  updated_at TEXT NOT NULL,              -- ISO 8601 时间
  nodes_json TEXT NOT NULL DEFAULT '[]', -- [{id,name,link,protocol,order}]
  manual     INTEGER NOT NULL DEFAULT 0  -- 1 = WebUI 手动编辑过，自动上报不覆盖
);

CREATE INDEX IF NOT EXISTS idx_machines_updated_at ON machines (updated_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,                -- 目前只有 machine_order
  value TEXT NOT NULL                    -- JSON 文本
);
```

写入路径只有两条：上报和 WebUI 保存节点，都是 `INSERT ... ON CONFLICT(machine) DO UPDATE`；读取路径也只有两条：单机 `WHERE machine = ?1`、合并订阅 `SELECT * FROM machines`（一次查询，机器数量不影响往返次数）。

查看数据：

```bash
pnpm run db:query                                   # machines 概览
pnpm exec wrangler d1 execute sub-worker-db --remote --command "SELECT * FROM settings"
```

### 写入是覆盖，不留历史

`machines` 的主键就是机器 slug，上报走 `INSERT ... ON CONFLICT(machine) DO UPDATE SET content = excluded.content, nodes_json = excluded.nodes_json, ...`，**整行覆盖**。所以：

- 同一台机器上报 1 次和上报 10 万次，占用的存储完全一样（1 行）；
- `nodes_json` 是整段 JSON 替换，不是往数组里追加，节点增删都只是换掉这一行；
- 没有 history / audit 表，也没有"版本"概念——**因此不需要历史剪除逻辑，历史根本不存在**。

实测（`node:sqlite` + 真实 handler）：

| 场景 | 结果 |
|---|---|
| 1,000 台机器全量重报 30 轮，每轮内容都变（共 3 万次上报） | 库大小 7.71 MB → 7.89 MB，行数始终 1,000，每台 8.08 KB |
| 同一台机器上报 200 次 | 仍是 1 行，库 32 KB |
| 500 台每机 100 节点，再缩到每机 10 节点 | 逻辑数据降到 1/10，文件仍 14.18 MB（**不缩**）；`VACUUM` 后 2.00 MB |

所以库大小 ≈ **机器数 × 节点数 × 0.40 KB**，与上报频次、累计上报次数完全无关。唯一会"虚高"的是 SQLite 的**高水位**：如果某台机器曾经有 500 个节点、后来只剩 20 个，被释放的页会被复用但文件不会自动缩小。D1 不支持通过 `d1 execute` 执行 `VACUUM`，真要压回去只有一条路——`wrangler d1 export` 导出、新建库、再 `d1 import` 重建。

要历史怎么办：真需要"节点变更审计"之类的历史，得自己加一张 `machine_history(machine, hash, nodes_json, created_at)` 表 + 定时清理（例如只留 7 天），否则它会按"上报次数 × 每台大小"线性暴涨——这才是唯一会爆的方向。当前实现刻意没有这么做。

## 免费额度（D1）

D1 只要挂在 Workers Free 计划下就是免费的，额度按**天**结算，存储按**总量**算，没有“月累计”这种概念（月包含量是 Workers Paid 才有的）。

### 官方额度

| 计费项 | Free 每日额度 | 折算月度（×30，不可跨天累积） | 超限后 | Workers Paid（月） |
|---|---|---|---|---|
| 读取行数 rows read | 500 万行 / 天 | 约 1.5 亿行 | 查询直接报错，直到次日 00:00 UTC 重置 | 前 250 亿行包含，超出 $0.001 / 百万行 |
| 写入行数 rows written | 10 万行 / 天 | 约 300 万行 | 同上 | 前 5000 万行包含，超出 $1.00 / 百万行 |
| 存储 | 5 GB（账号内所有库合计，不按天重置） | 5 GB | 无法 INSERT / 建表 / 建索引，需清理或删库 | 前 5 GB 包含，超出 $0.75 / GB·月 |
| 数据库数量 | 10 个 | 10 个 | 需删库才能新建 | 前 10 万个包含，超出 $0.10 / 个·月 |
| 出网流量 egress | 不计费 | 不计费 | — | 不计费 |

以上数据来自 Cloudflare 官方文档：[D1 Pricing](https://developers.cloudflare.com/d1/platform/pricing/)、[D1 Limits](https://developers.cloudflare.com/d1/platform/limits/)。

说明：

- 每日额度在 **UTC 00:00（北京时间 08:00）** 重置，不能像流量包那样跨天攒；
- 行数按**行**计，不按体积：1 KB 的行和 100 KB 的行都算 1 行；
- 建了索引的表，写入命中的索引列会**多算 1 行写**（表 1 行 + 索引 1 行），本项目 `machines` 表带一个 `updated_at` 索引，所以每次真实写入记 2 行；
- Workers Free 计划本身另有 **10 万次请求 / 天**的 Worker 调用额度，订阅拉取和上报都算请求，和 D1 额度分开计算。

### 本项目的实际消耗

| 操作 | 触发的 SQL | rows read | rows written |
|---|---|---|---|
| 上报（内容有变化） | 1× `SELECT` + 1× `INSERT ... ON CONFLICT DO UPDATE` | 1 | 2（数据行 + 索引） |
| 上报（内容没变，去重命中） | 1× `SELECT` | 1 | 0 |
| 拉单机订阅 `/sub/:machine/:token` | 1× `SELECT` | 1 | 0 |
| 拉合并订阅 `/sub/:token` | `SELECT * FROM machines` + 1× `SELECT settings` | 机器数 N + 1 | 0 |
| WebUI 查看列表 `/api/v1/machines` | 同上 | N + 1 | 0 |
| WebUI 保存节点 | 1× `SELECT` + 1× `UPSERT` | 1 | 2 |
| 建表 `/api/v1/admin/schema` | 3× DDL（幂等，只跑一次） | 少量 | 少量 |

以上是按 SQL 语义的估算；`INSERT ... ON CONFLICT` 内部的冲突检查可能额外记少量读，精确值以每次响应的 `meta.rows_read` / `meta.rows_written` 为准。

### 换算成能跑多少

以 10 台机器（N = 10）为例：

| 使用场景 | 免费额度下每天上限 | 算法 |
|---|---|---|
| 只上报，且内容每次都在变 | 约 5 万次 / 天 | 100,000 行写 ÷ 2 |
| 只上报，内容多数不变（去重命中） | 约 500 万次 / 天 | 只消耗 1 行读，写额度不花 |
| 客户端拉合并订阅 | 约 45 万次 / 天 | 5,000,000 ÷ 11 |
| 客户端拉单机订阅 | 约 500 万次 / 天 | 5,000,000 ÷ 1 |
| 混合（每天 1 万次上报 + 20 万次合并拉取） | 占用约 44% 读、20% 写 | 20 万×11 = 220 万行读；1 万×2 = 2 万行写 |

个人多机自用（每天上报几十次、订阅拉取几千次）占不到免费额度的零头；真正会打满的是“客户端高频轮询合并订阅”或“几千台机器”这种规模。

实际用量随时可以在 Dashboard 的 D1 → 你的数据库 → **Metrics → Row Metrics** 看，或者读每次查询返回的 `meta.rows_read` / `meta.rows_written` 自己记账。

## 能承载多少台机器

先量出每次操作的真实开销量（在本机用 `node:sqlite` + 真实 fetch handler 复现，样本为 5~40 节点/机的合成订阅）：

| 指标 | 实测值 | 折算 |
|---|---|---|
| 单机存储占用 | 40 节点/机 = 16.1 KB；20 节点/机 = 8.1 KB；10 节点/机 = 4.1 KB；5 节点/机 = 2.1 KB | 约 **0.40 KB / 节点**（content + nodes_json + 索引） |
| 合并订阅耗时 | 10 机 × 40 节点（400 节点）= 13.5 ms | 约 **34 µs / 节点** |
| 单机订阅耗时 | 40 节点 ≈ 1.4 ms | 只解析自己那台机器 |
| 上报耗时 | 1 行读 + 去重 sha256，可忽略 | 主要花在 D1 往返，不算 CPU 大头 |

换算基准：**500 MB = 512,000 KB**、**每机 20 节点 ≈ 8.1 KB**、**合并订阅每次调用解析 N×P 个节点**。

### 上限一：上报侧（机器数）

只算上报，不含任何客户端拉取。变化率 `c` = 上报里"内容真的变了"的比例——定时上报多数撞去重（1 行读、0 行写），按 10% 估；"仅变化时上报"则是 100% 都会写。

| 上报策略 | 每台每天上报 | 变化率 c | 请求额度允许 | 写入额度允许 | 读取额度允许 | 存储额度允许 | **实际上限** |
|---|---|---|---|---|---|---|---|
| 每小时 | 24 | 10% | 4,166 | 20,833 | 208,333 | 63,642 | **4,166 台**（请求卡） |
| 每 2 小时 | 12 | 10% | 8,333 | 41,666 | 416,666 | 63,642 | **8,333 台**（请求卡） |
| 每 6 小时 | 4 | 10% | 25,000 | 125,000 | 1,250,000 | 63,642 | **25,000 台**（请求卡） |
| 每天 | 1 | 10% | 100,000 | 500,000 | 5,000,000 | 63,642 | **63,642 台**（存储卡） |
| 仅变化时，5 次/天 | 5 | 100% | 20,000 | 10,000 | 1,000,000 | 63,642 | **10,000 台**（写入卡） |
| 仅变化时，20 次/天 | 20 | 100% | 5,000 | 2,500 | 250,000 | 63,642 | **2,500 台**（写入卡） |
| 仅变化时，50 次/天 | 50 | 100% | 2,000 | 1,000 | 100,000 | 63,642 | **1,000 台**（写入卡） |

规律很清楚：

- 定时上报**越频繁**，被 10 万次/天请求额度压得越狠（每小时一次只剩 4,166 台）；
- 改成**只在配置变化时上报**，请求压力骤降，但每次上报必定写 2 行，于是被 10 万行/天写入额度卡住（每天变 5 次 = 1 万台，变 50 次 = 1,000 台）；
- **每天一次**的上报几乎不占额度，此时瓶颈变成 500 MB 存储（每机 20 节点约 6.4 万台）；
- 读取额度（500 万行/天）在任何上报策略下都不是瓶颈。

### 上限二：汇聚侧（能挂多少客户端）

汇聚的成本分两块：**CPU**（合并订阅要把所有节点解析一遍，免费版每次调用只有 10 ms）和**请求数**（每次拉取算 1 次请求，和上报抢同一个 10 万/天池子）。

#### 合并订阅的 CPU 上限（与上报频次无关，只跟节点总量有关）

| 每机节点数 | 免费版（10 ms/次） | 付费版（30 s/次） |
|---|---|---|
| 5 | 59 台 | 176,471 台 |
| 10 | 29 台 | 88,235 台 |
| 20 | **14 台** | 44,118 台 |
| 40 | 7 台 | 22,059 台 |

这张表是"硬顶"：**免费版用合并订阅，机器数超过十几台就必然 1102（Worker exceeded resource limits）**，跟上报怎么配、客户端多少都没关系。

#### 客户端数上限（机器数固定为 14 台、每机 20 节点）

| 上报策略 | 请求额度剩给拉取 | 可挂客户端（按每人每天拉 12 次） | 读取额度允许 |
|---|---|---|---|
| 每小时 | 100,000 − 14×24 = 99,664 | **8,305 个** | 27,775 个 |
| 每 2 小时 | 100,000 − 168 = 99,832 | **8,319 个** | 27,776 个 |
| 每天 | 100,000 − 14 = 99,986 | **8,332 个** | 27,777 个 |
| 仅变化 5 次/天 | 100,000 − 70 = 99,930 | **8,327 个** | 27,777 个 |

结论：合并订阅下，**上报策略几乎不影响客户端上限**——请求池基本被拉取独占，8,300 个客户端 × 12 次/天就把 10 万次/天填满了。客户端每天只拉 1 次的话，这个数能放大到 10 万。

### 上限三：两者一起算（单机订阅模式，CPU 不再是瓶颈）

客户端各自拉 `/sub/:machine/:token`，每次只解析 1 台机器的节点，免费版 CPU 绰绰有余。此时上限 = 请求/写入/存储三者取小，下表按"每客户端每天拉 12 次"：

| 上报策略 | 0 客户端 | 100 客户端 | 1,000 客户端 | 5,000 客户端 | 8,000 客户端 |
|---|---|---|---|---|---|
| 每小时（c=10%） | 4,166 | 4,116 | 3,666 | 1,666 | 166 |
| 每 2 小时（c=10%） | 8,333 | 8,233 | 7,333 | 3,333 | 333 |
| 每天（c=10%） | 63,642 | 63,642 | 63,642 | 40,000 | 4,000 |
| 仅变化 5 次/天（c=100%） | 10,000 | 10,000 | 10,000 | 8,000 | 800 |

横向看：客户端越多，能带的机器越少（抢请求额度）；纵向看：上报越勤，能带的机器也越少。**"每小时上报 + 8,000 个客户端"这种组合只剩 166 台**，而"每天上报 + 1,000 客户端"还能带 6.3 万台。

### 上限四：付费版（Workers Paid，$5/月起）

| 限制 | 额度 | 折算（每机 20 节点） |
|---|---|---|
| CPU | 30 秒 / 请求（可调到 5 分钟） | 合并订阅 **44,118 台**；单机订阅无压力 |
| D1 读取 | 250 亿行 / 月（约 8.3 亿/天） | 10 万客户端每天拉 12 次 = 120 万次请求，单机订阅 120 万行、合并订阅 2,520 万行，都只是零头 |
| D1 写入 | 5,000 万行 / 月（约 166 万行/天） | 每小时上报（c=10%）可带 **347,083 台** |
| D1 存储 | 10 GB / 库、1 TB / 账号 | **130 万台**（单库上限） |
| Worker 请求数 | 不限 | 不再参与计算 |

付费版里 CPU 松了 3,000 倍、请求无限，瓶颈回到 **D1 单库 10 GB 与单库单线程吞吐**。真要做到几十万台，就得多建库 + 多 Worker 绑定（免费 10 个库 / 付费 10 万个库）。

### 一句话选型

| 场景 | 推荐配置 |
|---|---|
| 自己家用，3~10 台机器 | 免费版 + 每小时上报 + 合并订阅，够用（10 台 × 20 节点 ≈ 6.8 ms CPU，贴着 10 ms 线） |
| 十几台以上要合并订阅 | 免费版做不到，升 Paid 或改单机订阅 |
| 几十台 + 少量客户端 | 免费版 + 单机订阅 + 每天/每 2 小时上报 |
| 上千台汇聚 | 免费版 + 单机订阅 + 只在变化时上报（10 次/天内），或直接 Paid |
| 上万台 | Paid，且考虑分库 |

以上耗时是在 Node 里复现的，workerd 通常更快但同一量级；精确值看 Dashboard 的 Worker Metrics（`CPU time`）和 D1 的 Row Metrics（`rows read` / `rows written`）。

## 配置

| 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `DB` | D1 binding | 是 | 存储订阅内容（`machines` / `settings` 表） |
| `TOKEN` | Secret | 是 | 上报和读取共用的认证 token |

不需要 `PUBLIC_BASE_URL`；Worker 根路径返回的 `subscription_base` 来自当前请求的 `Origin`。

### TOKEN 格式（重要）

Worker 对 `TOKEN` 做**精确字符串比较**，区分大小写，不会自动 trim，也不会把不同写法当作同一个 token。

推荐格式（任选一种）：

```text
UUID v4：550e8400-e29b-41d4-a716-446655440000
base64url：A-Za-z0-9_- 组成，建议 32 字节随机值
hex：0-9a-f，32 或 64 位
```

不建议在 token 中使用：空格、换行、引号、`/`、`?`、`#`、`&`、`%`、`+`、`=`。这些字符不是不能用，而是放进订阅 URL 路径时必须正确编码，部分客户端/代理会二次解码，容易“看起来一样但匹配不上”。

在 Cloudflare 设置 `TOKEN` 时：

- 只填 token 本身，不要带 `TOKEN=`、引号、前后空格或换行；
- 用 Secret 类型；
- `wrangler secret put TOKEN` 后直接粘贴原始值。

请求头里使用**原始 token**，不要 URL 编码：

```http
Authorization: Bearer <原始 TOKEN>
```

订阅 URL 路径里使用 **URL 编码后的 token**：

| 原始字符 | URL 编码 |
|---|---|
| `+` | `%2B` |
| `=` | `%3D` |
| `/` | `%2F`（不建议使用 `/`） |
| `?` | `%3F` |
| `#` | `%23` |
| `&` | `%26` |
| `%` | `%25` |
| 空格 | `%20` |

示例：

```text
原始 token：abc+def=ghi
URL 路径：  /sub/abc%2Bdef%3Dghi
请求头：    Authorization: Bearer abc+def=ghi
```

如果不想处理这些编码，直接用 UUID v4 最省事；Worker 不需要改代码。

## API

### 上报

```http
POST /api/v1/report/:machine
Authorization: Bearer <TOKEN>
Content-Type: text/plain
Body: base64 编码的订阅内容
```

`machine` 只允许：

```text
[a-z0-9][a-z0-9-]{0,63}
```

示例：

```bash
BODY=$(printf 'vless://example\nanytls://example2' | base64 -w0)

curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  --data-binary "$BODY" \
  https://<worker>/api/v1/report/machine-a
```

### 读取

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/sub/:machine/:token` | 单机订阅 |
| `GET` | `/sub/:token` | 全部机器合并订阅（推荐） |
| `GET` | `/sub/all/:token` | 合并订阅的兼容旧路径 |
| `GET` | `/ui/:token` | WebUI 节点管理 |
| `GET` | `/api/v1/nodes/:machine` | 读取节点配置，Bearer `TOKEN` |
| `PUT` | `/api/v1/nodes/:machine` | 保存节点链接/名称/顺序，Bearer `TOKEN`；body 为 `{"nodes":[{"link":"...","name":"可省略"}]}`，空行/重复链接会被忽略，`name` 省略时按链接 `#` 片段生成 |
| `GET` | `/api/v1/machines/order` | 读取机器顺序（也可从 machines 响应获取） |
| `PUT` | `/api/v1/machines/order` | 保存机器顺序，Bearer `TOKEN` |
| `POST` | `/api/v1/machines/:machine/rename` | body `{"to":"新名字"}`，整行搬家（节点/`manual`/排序位置），重名 409，非法名字 400 |
| `POST` | `/api/v1/machines/:machine/reset` | 恢复自动上报，Bearer `TOKEN` |
| `GET` | `/api/v1/machines` | 查看已上报机器，Bearer `TOKEN` |
| `DELETE` | `/api/v1/machines/:machine` | 删除机器，Bearer `TOKEN` |
| `POST` | `/api/v1/admin/schema` | 建表（幂等），Bearer `TOKEN` |
| `GET` | `/health` | 健康检查，无需认证 |

路径中的 token 建议使用 URL-safe 格式。UUID 可直接使用；如果 token 含 `+`、`=` 等字符，请做 URL 编码。

### 保存节点示例

```bash
curl -X PUT \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"nodes":[{"link":"vless://...","name":"节点 A"},{"link":"tuic://...","name":"节点 B"}]}' \
  https://<worker>/api/v1/nodes/machine-a
```

节点数组的顺序就是订阅顺序。

默认排序：

```text
机器：HK → KR → JP → SG → 其他亚洲 → US → DE → 其他欧洲 → 其他美洲 → 其他
节点：Reality → AnyTLS → Argo → CDN → HY2 → TUIC → SOCKS5
```

内置完整的 ISO 3166-1 alpha-2 国家/地区代码、常用 alpha-3 代码和城市别名（如 FRA、PHX、DXB、AMS、HKG）；未知前缀自动归入“其他”。

手动保存机器顺序或节点顺序后会覆盖默认排序。

### 响应示例

```bash
curl https://<worker>/sub/machine-a/<TOKEN>
```

默认返回 `text/plain` 的 base64 订阅内容；带 `?format=clash` 或 `?format=singbox` 返回对应格式。

## 多机上报

`scripts/report.py` 读取机器名到订阅 URL 的映射，先拉取本地临时订阅，再上报到 Worker：

```bash
python3 scripts/report.py \
  --base https://<worker> \
  --token "$TOKEN" \
  --file machines.json
```

`machines.json`：

```json
{
  "machine-a": "https://sub-a.example.com/sub.txt",
  "machine-b": "https://sub-b.example.com/sub.txt"
}
```

也可以直接传：

```bash
python3 scripts/report.py \
  --base https://<worker> \
  --token "$TOKEN" \
  --machine "machine-a=https://sub-a.example.com/sub.txt"
```

脚本依赖 `curl`，避免部分 Python 默认 User-Agent 被 Cloudflare 安全策略拦截。

单机不想维护映射文件时，可以让名字取自主机名：

```bash
python3 scripts/report.py \
  --base https://<worker> --token "$TOKEN" \
  --url https://sub.example.com/sub.txt --from-hostname
# 本机主机名 HK-Node_1.local → 上报到 /api/v1/report/hk-node-1-local
```

加 `--dry-run` 只打印「机器名 ← URL」不发请求，先确认名字对不对。

### 上报时机器名从哪来

Worker 端**没有生成规则**：名字就是上报 URL 路径里那一段（`POST /api/v1/report/<machine>`），服务端只做格式校验 `[a-z0-9][a-z0-9-]{0,63}`，不合格返回 `400 invalid machine name`。所以名字由上报端决定：

| 上报端 | 名字来源 | 例子 |
| --- | --- | --- |
| `scripts/report.py --file machines.json` | JSON 的 key | `"sgw-oracle-nat": "https://..."` |
| `scripts/report.py --machine` | `=` 左边 | `--machine sjc-1=https://...` |
| `scripts/report.py --url --from-hostname` | 本机主机名 slug 化 | `HK-Node_1.local` → `hk-node-1-local` |
| `scripts/report.py --url --name` | 显式给的 `--name` | `--name hk-1` |
| singbox-manager | `sub_machine='...'` 配置值 | `sub_machine='sgw-1'` |
| 自己写的客户端 | 自己拼的路径 | `curl .../api/v1/report/us-la` |

`--from-hostname` 的转换规则：小写、非字母数字替换成 `-`、去掉首尾 `-`、截断到 63 字符；结果为空或首字符不是字母数字时补前缀 `machine-`。

同一个名字重复上报 = 覆盖同一行（内容 hash 不变则跳过写入），所以名字在多机部署里要唯一，建议 `地区-用途-序号` 这种可读又不会撞的写法。

## 与 singbox-manager 集成

管理器生成订阅后调用上报接口即可。建议的约定：

```bash
sub=1
sub_mode=worker
sub_report_url='https://<worker>'
sub_token='<TOKEN>'
sub_machine='machine-a'
```

- 启动或 watchdog 发现内容变化时上报；
- 内容 hash 不变时 Worker 不写 D1；
- Argo 临时隧道重启导致节点域名变化时，管理器重新生成并上报，客户端重新拉订阅即可。

## 安全

- `TOKEN` 是 bearer secret，建议使用 Secret 类型，不要提交到仓库；
- 订阅内容包含节点 UUID/密码，读取 URL 的 token 必须不可猜；
- 不要使用公开 GitHub Gist 存放订阅；
- token 泄露后：在 Worker 中轮换 `TOKEN`，所有旧订阅 URL 会立即失效，再通知客户端更新；
- Worker 日志/分析中可能记录请求路径，生产环境应限制日志访问权限；
- 如需更细的权限控制，可扩展为每台机器单独 token。

## 已知限制

- 建表不是自动的：新库要先跑一次 `pnpm run db:init` 或 `POST /api/v1/admin/schema`，否则接口返回 500 并在 `message` 里报 `no such table`；
- D1 免费额度有上限（每天 500 万行读 / 10 万行写 / 5 GB 存储，详见上面的「免费额度（D1）」）；本项目已做内容 hash 去重，内容不变时不产生写入；
- D1 只有主副本可写，写入延迟取决于 Worker 与主区域的网络距离；读取强一致，合并订阅是单次 `SELECT * FROM machines`，机器再多也不会有 N+1；
- WebUI 采用 `TOKEN` 路径认证，请勿把 `/ui/<TOKEN>` 发给他人；
- 手动编辑后不会自动合并新上报节点，需要点“恢复自动上报”才会恢复；
- `workers.dev` 域名在部分地区可能不可达，建议绑定自定义域名。

## 开发

```bash
pnpm install
pnpm run db:init:local    # 本地 D1 建表（wrangler dev --local 首次使用前需要）
pnpm dev --local --var TOKEN:test-token
pnpm test                 # Node 内置测试（内含纯 JS 的 D1 内存实现）
pnpm run test:sqlite      # 同一批测试跑真实 SQLite（node:sqlite），验证 DDL / SQL 语法
pnpm run build:single     # 生成 worker.single.js
pnpm run check            # wrangler deploy --dry-run --outdir dist
pnpm run db:query         # 线上库查 machines 概览
```

本地测试：

```bash
BODY=$(printf 'vless://test\nanytls://test2' | base64 -w0)

curl -X POST \
  -H 'Authorization: Bearer test-token' \
  --data-binary "$BODY" \
  http://127.0.0.1:8787/api/v1/report/machine-a

curl http://127.0.0.1:8787/sub/machine-a/test-token
curl http://127.0.0.1:8787/sub/test-token
```

## 目录

```text
src/index.js             Worker 源码
worker.single.js         单文件构建产物（Dashboard 可直接粘贴）
scripts/schema.sql       D1 建表 SQL
scripts/report.py        多机订阅上报工具
scripts/build-single.mjs 生成单文件版本
test/worker.test.js      单元测试（内置 D1 内存实现 / node:sqlite 双后端）
wrangler.toml            Wrangler 配置（D1 绑定 DB）
```

## License

MIT
