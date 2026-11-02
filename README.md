# sub-merge

把很多条订阅合并成一个固定地址。跑在 Cloudflare Workers 或 Pages 上，数据存 D1，全程免费额度即可跑。

- **固定订阅链接**：机器换了、节点变了，客户端里的订阅地址不用改
- **WebUI 管理**：机器、手动节点、分流规则、订阅档案、短链
- **多来源上报**：同一台机器可以由多个上报源写（`?source=` 区分），互不覆盖

---

## 1. 部署

准备：Node 20+、一个 Cloudflare 账号、`pnpm install` 装好依赖。

先建库，拿 `database_id`：

```bash
pnpm exec wrangler login
pnpm exec wrangler d1 create sub-merge-db     # 输出里有 database_id
```

把拿到的 `database_id` 填进 `wrangler.toml` 的 `[[d1_databases]]`，然后建表：

```bash
pnpm run db:init        # = wrangler d1 execute sub-merge-db --remote --file=scripts/schema.sql
```

### 方式 A：Cloudflare Pages（推荐）

```bash
pnpm run pages:create      # 建 Pages 项目，只跑一次
pnpm run deploy:pages      # 构建 dist-pages/ 并上传
```

部署完到 Dashboard 给这个 Pages 项目补两样东西（**Pages 不读 wrangler.toml 的绑定**）：

1. **Settings → Bindings → D1 database**：变量名必须填 `DB`，库选 `sub-merge-db`
2. **Settings → Variables and Secrets**：加 `SUB_TOKEN`、`ADMIN_PASSWORD`、（可选）`REPORT_TOKEN`

> 绑完 D1 后再 Re-deploy 一次，Worker 才拿得到 `env.DB`。

### 方式 B：Cloudflare Workers

```bash
pnpm exec wrangler deploy
pnpm exec wrangler secret put SUB_TOKEN
pnpm exec wrangler secret put ADMIN_PASSWORD
pnpm exec wrangler secret put REPORT_TOKEN   # 可选
```

`wrangler.toml` 里已经写了 `binding = "DB"`，不用再手动绑。

两种方式部署完，打开 `https://<你的域名>/ui`，用 `ADMIN_PASSWORD` 登录。

---

## 2. 环境变量

| 变量 | 必填 | 作用 |
| --- | --- | --- |
| `SUB_TOKEN` | ✅ | 订阅链接里的口令：`/sub/all/<SUB_TOKEN>`。够长够随机就行 |
| `ADMIN_PASSWORD` | ✅ | WebUI 登录口令 |
| `REPORT_TOKEN` | 可选 | 只给上报用的口令；不填就用 `SUB_TOKEN` |
| `TOKEN` | 兼容 | `SUB_TOKEN` 的旧名字，两者填一个即可 |

绑定：D1 变量名必须是 **`DB`**（Pages 在 Dashboard 配，Workers 在 `wrangler.toml` 里）。

---

## 3. 数据表

建表用 `pnpm run db:init`，或者部署后调一次 `POST /api/v1/admin/schema`（幂等，老库加列也走这条）。

| 表 | 一行代表什么 | 关键字段 |
| --- | --- | --- |
| `machines` | 一台机器 | `machine` 机器名、`nodes_json` 上报节点、`manual_nodes_json` 手写节点、`manual` 是否接管 |
| `reports` | 一台机器的一个上报来源 | 主键 `(machine, source)`、`content` base64 原文、`hash` 去重 |
| `presets` | 一个订阅档案（筛节点 + 格式） | `name` 标识、`members` 选中的节点、`format` 输出格式 |
| `links` | 一条短链 | `code`、`preset`、`hits` 访问次数 |
| `settings` | 杂项键值 | 机器排序、分流规则、登录失败计数 |

---

## 4. 导入数据

### 4.1 在 WebUI 里粘贴（最快上手）

`/ui` → 新建机器 → 把节点链接整段粘进去（一行一条，`vless://` `vmess://` `trojan://` `hysteria2://` `tuic://` `anytls://` `ss://` 都认）。手动加的节点和上报的节点分开存，互不覆盖。

### 4.2 脚本上报（推荐，长期用这个）

服务器上生成节点后推一次，内容没变不会写库：

```bash
curl -X POST "https://<你的域名>/api/v1/report/<机器名 URL 编码>" \
  -H "Authorization: Bearer $REPORT_TOKEN" \
  -H "Content-Type: text/plain" \
  --data-binary "$(base64 -w0 nodes.txt)"
```

- `nodes.txt`：一行一条节点链接（macOS 的 base64 没有 `-w0`，用 `base64 -i nodes.txt`）
- 同名机器可多来源：加 `?source=hk2`
- 返回 `{"ok":true,"changed":true,"nodes":4,...}`，`changed:false` 表示内容没变

支持「自动上报」的脚本：`singbox-tools`（`sb report`，见 [README-sb.md](https://github.com/jyucoeng/singbox-tools/blob/main/README-sb.md)）。

### 4.3 从文件灌

```bash
pnpm exec wrangler d1 execute sub-merge-db --remote --file=dump.sql
```

---

## 5. 用起来

登录 `/ui` 后，页面上的订阅地址形如：

```
https://<你的域名>/sub/all/<SUB_TOKEN>                      全部节点
https://<你的域名>/sub/<机器名>/<SUB_TOKEN>                  单台机器
https://<你的域名>/sub/p/<档案标识>/<SUB_TOKEN>              某个档案
https://<你的域名>/s/<短链码>                                短链（不带 token）
```

加 `?format=clash` / `?format=singbox` / `?format=base64` 换格式，默认 base64（v2rayN 那类客户端直接用）。

---

## 6. D1 额度够不够

免费版（Free）与付费版（Workers Paid，$5/月）的硬指标（[官方 Limits](https://developers.cloudflare.com/d1/platform/limits/)、[Pricing](https://developers.cloudflare.com/d1/platform/pricing/)）：

| 指标 | Free | Paid |
| --- | --- | --- |
| 单库最大 | **500 MB** | 10 GB |
| 账号总存储 | 5 GB | 1 TB（含 5 GB 后 $0.75/GB·月） |
| 读 | 500 万行/天 | 250 亿行/月 |
| 写 | 10 万行/天 | 5000 万行/月 |
| 单次调用查询数 | 50 | 1000 |
| 单行/单值上限 | 2 MB | 2 MB |
| 时间旅行（回滚） | 7 天 | 30 天 |

按本项目的实际占用估算：

- **存储**：一个节点约 **0.4 KB**（含 link、名字、JSON 结构），500 MB ≈ **120 万节点**；10 GB ≈ 2500 万节点
- **读**：一次订阅请求读「机器行 + 上报行 + 几条 settings」，10 台机器约 20 行 → 免费额度 ≈ **25 万次请求/天**
- **写**：只有上报内容变化才写（hash 相同直接跳过）；10 台机器每小时都变 = 2400 行/天，离 10 万行差两个数量级

**结论**：几台到几十台机器、每天几十万次拉订阅，免费版完全够，不用升付费。只有节点总数逼近百万级（单库 500 MB）时才需要换 Workers Paid —— 免费版的 500 MB 是硬上限，不能申请提高。

本项目不存历史版本：每次上报覆盖旧内容，所以库不会随使用时长膨胀。
