# sub_merge

把多台机器上的订阅，合并成一个**永远不变的订阅链接**。

跑在 Cloudflare 上（Worker 或 Pages 二选一），数据存在 **Cloudflare D1**（SQLite）。
不用服务器、不用自己的域名、不用 KV/R2，免费额度就够十几个人的规模。

```text
singbox-tools（每台机器）
        │  POST base64 订阅
        ▼
Cloudflare（Worker 或 Pages）+ D1
        │  GET /sub/<token>             ← 全部机器合并
        │  GET /sub/<machine>/<token>   ← 单台机器
        ▼
客户端（sing-box / Clash / Mihomo / v2rayN …）
```

解决的问题：`cloudflared` 临时隧道重启就换随机域名（`*.trycloudflare.com`），订阅链接一失效客户端全废。
这里给每台机器一个稳定的名字，链接只跟这个名字走，机器换端口换 IP 都不用改客户端。

---

## 目录

- [能做什么](#能做什么)
- [两种部署方式](#两种部署方式)
- [部署 A：Cloudflare Workers](#部署-acloudflare-workers)
- [部署 B：Cloudflare Pages](#部署-bcloudflare-pages重点)
- [变量一览](#变量一览)
- [第一次使用](#第一次使用)
- [订阅链接](#订阅链接)
- [上报脚本](#上报脚本)
- [API](#api)
- [分流规则（Clash）](#分流规则clash)
- [数据表](#数据表)
- [容量与额度](#容量与额度)
- [本地开发与测试](#本地开发与测试)
- [安全](#安全)

---

## 能做什么

- **固定订阅链接**：重新部署、机器重启、换公网 IP 都不影响客户端里的那条链接。
- **多机合并**：每台机器一个名字（支持中文，例如 `小叮当-荷兰`），一条链接拿到全部节点。
- **一台机器多个上报源**：同一个名字可以同时被笔记本、VPS、脚本写，互不覆盖（`?source=` 区分）。
- **WebUI 管理**：改节点链接、改名字、拖机器顺序、批量粘贴订阅、勾选哪些节点进订阅、编辑 Clash 分流规则，全部点点点。
- **两种节点层**：① 手动（你写的，会保存）② 自动上报（只读快照），两层分开存、合并订阅时手动在前。
- **三种订阅格式**：base64（通用）、Clash/Mihomo（完整配置 + ACL4SSR 分组 + rule-providers）、sing-box。
- **结果缓存**：同一份订阅被反复拉取不再重算（`x-sub-cache: hit`），免费版 10ms CPU 也能扛 290 节点。
- **口令保护**：WebUI 必须输管理员口令；订阅用 `SUB_TOKEN`；上报可以用单独的 `REPORT_TOKEN`。
- **深色模式**、机器排序、节点顺序、按协议/机器筛选、搜索、批量勾选。

---

## 两种部署方式

同一份代码，两种跑法，**功能完全一样**（同一个运行时：Workers 和 Pages Functions 都是 workerd）：

| | Cloudflare Workers | Cloudflare Pages |
|---|---|---|
| 入口 | `src/index.js`（`export default { fetch }`） | `dist-pages/_worker.js`（Pages 高级模式） |
| 配置在哪 | `wrangler.toml` | Dashboard（Pages 项目的 Settings） |
| 部署命令 | `pnpm run deploy` | `pnpm run deploy:pages` |
| 免费额度 | 10 万请求/天，10ms CPU/请求 | 10 万请求/天，10ms CPU/请求 |
| 适合 | 只想跑一个接口 | 想用 Pages 的 Git 自动部署 / 已有 Pages 工作流 |

> 两个都免费、都能绑自定义域名。**已经有 Worker 在跑就不用动**；想换成 Pages 见下面的教程，D1 可以共用同一个库。

---

## 部署 A：Cloudflare Workers

### 0. 准备

- 一个 Cloudflare 账号（免费版即可）
- Node.js 18+、pnpm（`npm i -g pnpm`）
- 登录 wrangler：`pnpm exec wrangler login`

### 1. 拿代码

```bash
git clone https://github.com/jyucoeng/sub_merge.git
cd sub_merge
pnpm install
```

### 2. 建 D1 数据库

```bash
pnpm exec wrangler d1 create sub-worker-db
```

输出里有一行 `database_id = "xxxx-..."`，把它填进 `wrangler.toml`：

```toml
[[d1_databases]]
binding = "DB"                        # 变量名必须是 DB，代码里就是 env.DB
database_name = "sub-worker-db"
database_id = "你的 database_id"
```

同时把 `name = "sub-worker"` 改成你想要的名字（这就是 Worker 名，决定 `xxx.workers.dev` 的前缀）。

### 3. 建表

```bash
pnpm run db:init
```

> 也可以在部署完之后调一次 `POST /api/v1/admin/schema`（Bearer 用下面的 `SUB_TOKEN`），效果一样且幂等。

### 4. 配口令

口令**不要写进仓库**（这个仓库是公开的），用 wrangler 写进 Cloudflare：

```bash
pnpm exec wrangler secret put SUB_TOKEN         # 订阅用；建议 openssl rand -hex 24
pnpm exec wrangler secret put ADMIN_PASSWORD    # WebUI 管理员口令
pnpm exec wrangler secret put REPORT_TOKEN      # 可选：上报专用口令，泄露了不影响订阅
```

> 想以后能在面板里直接看到值（不容易忘），就用**明文变量**而不是 secret：
> Dashboard → Settings → Variables and Secrets → 选 **Text** 而不是 **Secret**；
> wrangler 对应 `wrangler deploy --keep-vars --var SUB_TOKEN:xxx --var ADMIN_PASSWORD:xxx`。
> 代价是谁能进你的 Cloudflare 账号就能看到口令——自己权衡。

> `wrangler.toml` 里有 `keep_vars = true`，作用是 `wrangler deploy` 时**不会**清掉你在 Dashboard 手填的变量。

### 5. 部署

```bash
pnpm run deploy
```

第一次会打印你的地址，形如 `https://sub-worker.<你的子域>.workers.dev`。

### 6. 验证

```bash
curl https://sub-worker.<子域>.workers.dev/health
# {"ok":true,"version":"1.23.4","time":"..."}

curl -X POST https://sub-worker.<子域>.workers.dev/api/v1/admin/schema \
  -H "Authorization: Bearer $SUB_TOKEN"
# {"ok":true,"migrations":0}
```

### 可选：不装工具，直接粘贴

`pnpm run build:single` 会生成单文件 `worker.single.js`，内容就是整个 Worker。
Dashboard → Workers & Pages → 你的 Worker → **Edit code** → 全选粘贴 → Deploy，
然后在 Settings → Variables and Secrets 里配 `SUB_TOKEN` / `ADMIN_PASSWORD`（还有 D1 绑定 `DB`）。

---

## 部署 B：Cloudflare Pages（重点）

### 原理（先看这段，不然会踩坑）

Pages 的「**高级模式**」允许放一个 `_worker.js` 到产物目录根下，它是一个普通的 ESM Worker：

```js
export default {
  async fetch(request, env) { ... }
};
```

Pages 会用它拦下**所有**请求（我们正好需要：`/ui`、`/sub/...`、`/api/...` 全部自己处理，不需要静态资源）。
所以「Pages 能不能跑 Worker 代码」——能，且是完全相同的运行时和限制。

两个和 Workers 不一样的地方，只有这两点：

1. **`wrangler.toml` 里的 `main` 只服务 Workers**。Pages 的入口是产物目录里的 `_worker.js`，绑定和变量在 **Pages 项目设置**里配（或 Git 集成的构建命令里生成）。
2. **D1 绑定也要在 Pages 项目里配**，变量名同样必须是 `DB`，但 `database_id` 可以填**同一个库**（这样 Worker 和 Pages 共享数据，迁移零成本）。

### 方式 B1：命令行部署（最快，推荐先跑通）

#### 1. 建 Pages 项目

```bash
pnpm run pages:create
# 等价于：wrangler pages project create sub-merge --production-branch main
```

#### 2. 生成 `_worker.js` 并部署

```bash
pnpm run deploy:pages
# = node scripts/build-pages.mjs && wrangler pages deploy dist-pages --project-name sub-merge --branch main
```

`scripts/build-pages.mjs` 干的事很简单：把 `src/index.js` 复制成 `dist-pages/_worker.js`（加个抬头注释）。
因为源码是单文件、没有 import，不需要打包器。

部署成功会给你两个地址：

```text
https://sub-merge-asm.pages.dev          ← 生产（Production，跟 branch=main 对应）
https://<hash>.sub-merge-asm.pages.dev   ← 这次部署的预览地址
```

#### 3. 绑 D1（**不做这步会 500**）

Dashboard → **Workers & Pages** → `sub-merge` → **Settings** → **Bindings** → **Add** → **D1 database**：

| 字段 | 填什么 |
|---|---|
| Variable name | `DB`（必须一模一样） |
| D1 database | 选你在第 2 步建的那个库（和 Worker 共用一个也行） |

> 提示 `D1 binding "DB" not found` / 页面报 `env.DB is undefined`，就是漏了这一步。

#### 4. 配变量

同一个页面往下 **Variables and Secrets** → **Add**：

| 名称 | 类型 | 说明 |
|---|---|---|
| `ADMIN_PASSWORD` | Text | WebUI 管理员口令，必填。选 **Text** 而不是 Secret，以后面板里能直接看到 |
| `SUB_TOKEN` | Text | 订阅 token，必填。同样建议用 Text，方便日后查看 |
| `REPORT_TOKEN` | Text | 上报专用 token，可选。同样建议用 Text |

改完**要重新部署一次**（`pnpm run deploy:pages`）才会生效到现有部署上。

#### 5. 建表

```bash
# 用同一个 D1，所以和 Worker 共用表；新库才需要初始化
curl -X POST https://sub-merge-asm.pages.dev/api/v1/admin/schema \
  -H "Authorization: Bearer $SUB_TOKEN"
```

或者直接跑 wrangler（推荐，第一次更方便）：

```bash
pnpm run db:init
```

#### 6. 验证

```bash
curl https://sub-merge-asm.pages.dev/health
curl -o /dev/null -w "%{http_code}\n" https://sub-merge-asm.pages.dev/ui          # 200，登录页
curl "https://sub-merge-asm.pages.dev/sub/$SUB_TOKEN" | head -c 80               # base64 订阅
curl "https://sub-merge-asm.pages.dev/sub/$SUB_TOKEN?format=clash" > c.yaml
mihomo -t -f c.yaml -d .                                                          # configuration test is successful
```

（实测：`/health` → `{"ok":true,"version":"1.23.4"}`，`/ui` → 200，Clash 配置过 `mihomo -t` 无 error。）

### 方式 B2：Git 集成（push 即部署）

适合「改完代码就想上线」：

1. 把仓库推到 GitHub（本仓库就是）。
2. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git** → 选仓库。
3. 构建配置填：

| 字段 | 值 |
|---|---|
| Framework preset | None |
| Build command | `node scripts/build-pages.mjs` |
| Build output directory | `dist-pages` |
| Root directory | `/`（默认） |

不需要 `npm install` 之外的依赖（`wrangler` 是 devDependency，构建脚本只用 `node:fs`）。

4. 部署完成后同样去 **Settings → Bindings** 加 D1（变量名 `DB`）、**Variables and Secrets** 加三个口令。
5. 之后每次 `git push` 自动构建，预览分支（PR）也会各有一个独立地址。

> Git 集成下 `_worker.js` 由构建命令生成，所以**不要**把 `dist-pages/` 提交进仓库（已在 `.gitignore` 里）。

### Pages 上的注意事项

- **自定义域名**：Pages 项目 → Custom domains → 添加，和 Worker 一样要域名在同一个 Cloudflare 账号下。
- **`*.pages.dev` 与 `*.workers.dev` 都可直接用**，客户端不关心。
- **同一个 D1 可以同时被 Worker 和 Pages 用**，读写都是强一致（同一个库，同一套 SQL）。想彻底切走：客户端链接换成 Pages 域名即可，数据不用迁。
- **Pages 的 `_routes.json` 不需要**：`_worker.js` 是高级模式，全量接管；如果你额外塞了静态文件，它们会被 Worker 优先拦掉。
- **免费额度与 Worker 相同**（10 万请求/天、10ms CPU/请求）；Pages 的静态资源不计入函数请求，但我们不用静态资源。

---

## 变量一览

| 名称 | 必需 | 说明 |
|---|---|---|
| `DB` | ✅ | D1 数据库**绑定**（不是变量）。Worker 在 `wrangler.toml`，Pages 在 Settings → Bindings |
| `SUB_TOKEN` | ✅ | 订阅 + 管理 API 的 Bearer。建议 `openssl rand -hex 24` |
| `ADMIN_PASSWORD` | ✅ | WebUI 登录口令；同时是会话签名密钥的一部分，**改了所有人要重新登录** |
| `REPORT_TOKEN` | ⭕ | 上报专用。配了就只认它，`SUB_TOKEN` 不能上报；不配则退回 `SUB_TOKEN` |
| `TOKEN` | ⭕ | 老部署兼容名，等价于 `SUB_TOKEN`（新部署别用） |
| `ADMIN_USERNAME` | ⭕ | 配了就要同时输用户名，**只有随机串才有意义**（等价于加长口令） |
| `UI_PATH` | ⭕ | 配了就只在这个前缀下开 UI（例如 `/x7k2`），`/ui` 变 404，用来躲扫描 |

自检：`GET /api/v1/admin/env` 会告诉你哪些变量已设置、哪些是废的。

---

## 第一次使用

1. 打开 `https://<你的域名>/ui`，输 `ADMIN_PASSWORD` 登录。
   - 首页卡片「订阅链接」里就是给客户端的地址，点「复制」。
2. 机器从哪来？两种：
   - **脚本上报**（见下一节），机器会被自动创建；
   - **WebUI 新建**：「节点配置」→ 新建机器 → 填名字 → 手工粘贴节点链接。
3. 每台机器有两层：

```text
① 手动节点   你写的，点「保存配置」才写库，会显示「保存于：…」
② 自动上报   脚本写进来的只读快照，显示「内容更新于：…」和每个来源的时间
```

合并订阅时：**手动在前，自动在后，按 link 去重**。自动上报永远不会覆盖你自己写的那层；
想长期保留上报来的某条节点，点它右边的「转 ① 手动」，会复制一份到 ①。

4. 「订阅中的节点」卡片决定谁进订阅：默认全勾，点行取消；支持按协议/按机器筛选、搜索、批量勾选。
5. 机器顺序在「机器排序」卡片里，左边的序号可以直接改成想要的位置。

---

## 订阅链接

| 链接 | 拿到什么 |
|---|---|
| `GET /sub/<SUB_TOKEN>` | 全部机器合并（base64） |
| `GET /sub/all/<SUB_TOKEN>` | 同上，显式写法 |
| `GET /sub/<machine>/<SUB_TOKEN>` | 只某一台机器 |
| `?format=base64` | 默认，`base64(link\nlink\n…)` |
| `?format=clash` | Clash/Mihomo **完整配置**（proxies + proxy-groups + rule-providers + rules） |
| `?format=singbox` | sing-box `outbounds` 数组 |
| `&source=` | 合并订阅里只要某个上报来源（默认全部来源） |

```bash
# 合并订阅（base64）
curl -o sub.txt "https://<域名>/sub/$SUB_TOKEN"

# Clash
curl -o config.yaml "https://<域名>/sub/$SUB_TOKEN?format=clash"

# 单机 + 指定来源
curl "https://<域名>/sub/荷兰-1/$SUB_TOKEN?source=nlefni&format=singbox"
```

响应头里 `x-sub-cache: hit|miss` 告诉你这次有没有走缓存。缓存键包含规则版本和排除清单，所以**改完规则/勾选立即生效**。

---

## 上报脚本

`scripts/report.py`（只依赖标准库，Python 3.8+）：

```bash
# 单机：把 singbox-tools 的订阅地址上报，机器名显式给
python3 scripts/report.py --base https://<域名> --token $REPORT_TOKEN \
  --url http://127.0.0.1:8080/sub/xxx --name 荷兰-1

# 机器名取本机 hostname
python3 scripts/report.py --base https://<域名> --token $REPORT_TOKEN \
  --url http://127.0.0.1:8080/sub/xxx --from-hostname

# 多机：JSON 文件 {machine: url}
python3 scripts/report.py --base https://<域名> --token $REPORT_TOKEN --file machines.json

# 直接从节点链接上报（机器名取节点名的公共前缀）
python3 scripts/report.py --base https://<域名> --token $REPORT_TOKEN --links nodes.txt

# 只看看会发什么，不真的上报
python3 scripts/report.py ... --dry-run
```

也可以完全不用脚本，一条 curl 就够：

```bash
base64 -w0 sub.txt > sub.b64
curl -X POST "https://<域名>/api/v1/report/荷兰-1?source=nlefni" \
  -H "Authorization: Bearer $REPORT_TOKEN" --data-binary @sub.b64
# {"ok":true,"changed":true,"nodes":4,"auto_nodes":4,"manual_nodes":1}
```

`changed:false` 表示内容和上次一样（按 SHA-256 判重），**不会**刷新「内容更新于」的时间——这是设计如此，脚本可以放心频繁跑。

放进 cron：

```cron
*/30 * * * * /usr/bin/python3 /opt/sub_merge/scripts/report.py --base https://<域名> --token $REPORT_TOKEN --url http://127.0.0.1:8080/sub/xxx --name 荷兰-1 >> /var/log/sub-report.log 2>&1
```

---

## API

所有 `/api/v1/*` 都要 `Authorization: Bearer <SUB_TOKEN>`（除了登录和上报）。

### 公开 / 上报

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | `{ok,version,time}` |
| GET | `/api` | JSON 索引（`/` 是界面） |
| POST | `/api/v1/auth/login` | `{password}` → `{ok,role,token}`；失败 401，限速 429 |
| GET | `/api/v1/auth/mode` | 是否需要用户名、锁定策略 |
| GET | `/api/v1/auth/session` | 会话是否有效 + `sub_token` |
| POST | `/api/v1/report/:machine` | 上报 base64 订阅（Bearer 用 `REPORT_TOKEN`），`?source=` |

### 机器与节点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/machines` | 机器列表（含手动/上报条数、进订阅数） |
| GET | `/api/v1/machines/:machine` | 单机详情 |
| PUT | `/api/v1/machines/:machine` | 写入手动节点 `{nodes:[link…]}`（机器不存在则创建） |
| DELETE | `/api/v1/machines/:machine` | 删机器（连同上报记录） |
| POST | `/api/v1/machines/:machine/rename` | `{to:"新名字"}`，连同 reports 与排序一起搬 |
| POST | `/api/v1/machines/:machine/reset` | 丢掉 ① 手动层，恢复最近一次上报 |
| DELETE | `/api/v1/machines/:machine/sources/:source` | 删某个上报来源 |
| PUT | `/api/v1/machines/order` | `{order:["机器1","机器2"]}` |
| GET | `/api/v1/nodes/:machine` | 节点（手动 + 自动 + 协议统计） |
| PUT | `/api/v1/nodes/:machine` | 同上写入手动节点 |
| PUT | `/api/v1/nodes/:machine/protocols` | `{protocols:["vless"]}` 协议白名单 |
| PUT | `/api/v1/nodes/:machine/disabled` | 单机排除清单 |

### 订阅清单 / 规则 / 运维

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/sub/nodes` | 全站节点清单（按机器顺序，`in_sub` 标记是否进订阅） |
| PUT | `/api/v1/sub/disabled` | `{disabled:[身份…]}` 全局排除清单，空数组=全恢复 |
| GET/PUT | `/api/v1/clash/rules` | 读/写分流规则（分组 + rule-providers） |
| GET | `/api/v1/clash/rules/default` | 默认内置规则 |
| POST | `/api/v1/clash/rules/reset` | 恢复默认 |
| POST | `/api/v1/admin/schema` | 建表（幂等，可重复调用） |
| GET | `/api/v1/admin/env` | 变量自检 |
| GET | `/api/v1/admin/logins` | 猜口令的 IP 与锁定状态 |

---

## 分流规则（Clash）

`?format=clash` 输出的不是「只有 proxies 的片段」，而是能直接喂给 Clash/Mihomo 的**完整配置**：

- 52 个分组：`🚀 节点选择`、`🎯 全球直连`、`🛑 全球拦截`、`🐟 漏网之鱼`、`☑️ 手动切换`、`♻️ 自动选择`、`📲 电报消息`、`🎥 奈飞视频`…，以及 36 个国家/地区组；
- 28 条 **rule-providers**（ACL4SSR / cmliu / juewuy / ryty1 的远程规则集，`behavior: classical`、`interval: 86400`）；
- 规则里 `GEOIP,CN` 只在「🎯 全球直连」存在时才输出，`MATCH` 优先走「🐟 漏网之鱼」。

为什么用 rule-providers 而不是内联规则：把上万条规则内联进去，免费版 Worker 的 10ms CPU / 50 subrequest 根本跑不动；
交给 Clash 自己按 `interval` 拉取，Worker 只负责生成结构。

WebUI「分流规则」卡片里可以**增删改**分组和规则来源，改完立即生效（缓存键带规则版本）：

```bash
curl -H "Authorization: Bearer $SUB_TOKEN" https://<域名>/api/v1/clash/rules
curl -X POST -H "Authorization: Bearer $SUB_TOKEN" https://<域名>/api/v1/clash/rules/reset
```

分组有两种成员来源，二选一：`filter`（按节点名匹配的正则）或 `members`（显式列组名 / `DIRECT` / `REJECT`）。
没有节点命中的 `filter` 组会被整组省略（否则 Mihomo 报 `proxy group not found`）。

---

## 数据表

三张表，全在 D1（`scripts/schema.sql` 是权威定义）：

| 表 | 键 | 存什么 |
|---|---|---|
| `machines` | `machine` | 单机聚合快照：`content/hash/bytes`、`nodes_json`（自动）、`manual_nodes_json`（手动）、`manual`、`updated_at`、`manual_updated_at` |
| `reports` | `(machine, source)` | 每个上报来源的原始 base64、hash、节点 JSON、`updated_at`（一台机器多源互不覆盖） |
| `settings` | `key` | `machine_order`、`clash_rules`、`disabled`、`protocols:<machine>`、`login-fail:<ip>` |

- 不做历史：每次上报是**覆盖**，只保留最新一份（要留档请在你自己的机器上留）。
- 按内容 SHA-256 判重，相同内容不重复写。

---

## 容量与额度

实测（520 节点 / 单机聚合）：**0.40 KB 存储/节点**、合并耗时 **~17µs/节点**。

| 项目 | 免费版 | 说明 |
|---|---|---|
| Worker 请求 | 10 万/天 | Pages Functions 同额度 |
| CPU | 10ms/请求 | 约 **290 节点**/次（再优化有 SUB_CACHE，命中后 ~3.5ms） |
| subrequest | 50/请求 | 所以规则走 rule-providers 而不是内联拉取 |
| D1 行读 | 500 万/天 | 一次合并订阅 = 一次 `SELECT` |
| D1 行写 | 10 万/天 | 一次上报写 2 张表 |
| D1 存储 | 5 GB | 500MB/库（付费 10GB） |

结论：几十台机器、上千节点完全在免费额度内；节点越多越要依赖 `SUB_CACHE`（同一份订阅反复拉取只算一次）。

---

## 本地开发与测试

```bash
pnpm run dev              # wrangler dev（本地 Worker + 本地 D1）
pnpm run db:init:local    # 本地建表
pnpm test                 # 单元 + 集成测试（Mock D1）
pnpm run test:sqlite      # 同一套测试跑在 node:sqlite 上（贴近真实 SQLite）
pnpm run test:ui          # 真跑 WebUI 脚本（vm + DOM 壳 + 真实 fetch）
pnpm run build:single     # 生成 worker.single.js（Dashboard 粘贴用）
pnpm run build:pages      # 生成 dist-pages/_worker.js（Pages 用）
pnpm run bench:sub        # 订阅生成的性能基准
pnpm run unlock           # 解开被封的 IP（删 login-fail:* 记录）
pnpm run vars:clean       # 列出 Cloudflare 上多余/废用的变量（默认 dry-run）
```

测试基线：`node --test` 49/49、sqlite 49/49、ui-flow 217/217。

目录：

```text
src/index.js            全部服务端逻辑（单文件，无依赖）
scripts/schema.sql      D1 表结构（权威）
scripts/build-single.mjs  worker.single.js
scripts/build-pages.mjs   dist-pages/_worker.js
scripts/report.py       多机上报
scripts/ui-flow.mjs     WebUI 端到端（vm 里跑页面脚本）
scripts/bench-sub.mjs   性能基准
test/worker.test.js     接口与存储测试
```

---

## 安全

- 仓库是**公开**的，任何口令都不要提交（`CREDENTIALS.local.md` 已在 `.gitignore` 里）。
- `SUB_TOKEN` 泄露 = 别人能拉你的订阅；`REPORT_TOKEN` 泄露 = 别人能改你的节点（但看不到订阅）。分开放，泄露只丢一半。
- WebUI 登录：会话是 `sk1.<过期时间>.<HMAC>`（7 天，密钥由 `ADMIN_PASSWORD` 派生），**改口令即全部会话失效**。
- 猜口令有锁定：同一 IP 10 分钟内错 10 次 → 封 24 小时；`pnpm run unlock` 或 Dashboard 里删 `login-fail:*` 解封。
- 只有 `/ui` 是界面入口，`/` 和未知路径都是极简 404（不回显路径、不引导跳转），用来躲扫描器。
- `UI_PATH` 可以把界面挪到自定义前缀。
- 上报节点也能反查：`GET /api/v1/admin/logins` 看谁在猜口令。

---

## License

MIT
