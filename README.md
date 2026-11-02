# sub-merge

把很多条订阅合并成一个固定地址。跑在 Cloudflare Workers 或 Pages 上，数据存 D1，全程免费额度即可跑。

- **固定订阅链接**：机器换了、节点变了，客户端里的订阅地址不用改
- **WebUI 管理**：机器、手动节点、分流规则、订阅档案、短链
- **多来源上报**：同一台机器可以由多个上报源写（`?source=` 区分），互不覆盖

---

## 1. 部署（全程在 Cloudflare 后台点，不用命令行）

准备：一个 Cloudflare 账号；把本仓库 **Fork** 到自己名下（右上角 Fork）。免费额度就够用，不需要绑卡。

### ① 建数据库

Dashboard → **Storage & Databases → D1 SQL Database → Create database**，名字填 `sub-merge-db`，创建。

点进这个库 → 顶部 **Console** → 把仓库里 `scripts/schema.sql` 的全文粘进输入框 → **Execute**。
（`machines` / `reports` / `presets` / `links` / `settings` 五张表一次建好，重复执行也没问题。）

### ② 建 Pages 项目

Dashboard → **Workers & Pages → Create → Pages → Connect to Git** → 选中你 fork 的 `sub_merge` → Begin setup：

| 填哪项 | 填什么 |
| --- | --- |
| Framework preset | `None` |
| Build command | `npm run build:pages` |
| Build output directory | `dist-pages` |

点 **Save and Deploy**，等一分钟左右。

### ③ 绑数据库

进入刚建好的 Pages 项目 → **Settings → Bindings → Add → D1 database**：

- Variable name：**`DB`**（必须一字不差，代码里按这个名字取库）
- D1 database：选 `sub-merge-db`
- Production、Preview 两个环境都加一遍

### ④ 填三个口令

同一页往下 **Settings → Variables and Secrets → Add**，逐个添加（Type 选 `Text`；`SUB_TOKEN` 与 `REPORT_TOKEN` 建议点 Encrypt 存成密文）：

`SUB_TOKEN`、`ADMIN_PASSWORD`、`REPORT_TOKEN` —— 值自己生成一串够长的随机字符。

### ⑤ 重新部署一次

**Deployments** → 最新那条 → 右侧 `⋯` → **Retry deployment**。
（绑定和变量是部署时注入的，跳过这一步打开网站会报 `env.DB is undefined`。）

打开 `https://<项目名>.pages.dev/ui`，用 `ADMIN_PASSWORD` 登录就能用了。

> **不想用 GitHub**：本地 `npm install && npm run build:pages`，把生成的 `dist-pages` 目录用 **Create → Pages → Upload assets** 直接拖上去，再照 ③④⑤ 做。
>
> **想用 Workers 而不是 Pages**：**Create → Workers → Hello World**，把本地 `npm run build:single` 生成的 `worker.single.js` 粘进编辑器 → Deploy，然后在 **Settings → Bindings / Variables and Secrets** 里同样绑 `DB` 和三个口令。功能完全一样。

---

## 2. 环境变量

| 变量 | 必填 | 作用 |
| --- | --- | --- |
| `SUB_TOKEN` | ✅ | 订阅链接里的口令：`/sub/all/<SUB_TOKEN>`。够长够随机就行 |
| `ADMIN_PASSWORD` | ✅ | WebUI 登录口令 |
| `REPORT_TOKEN` | ✅ | 服务器上报用的口令（`/api/v1/report/...` 的 Bearer） |

三个口令互相独立、都填长随机串；`SUB_TOKEN` 会出现在订阅链接里，`REPORT_TOKEN` 只给上报脚本用，泄露了不会连带订阅链接。

绑定：D1 的变量名必须是 **`DB`**，不是这个名字代码取不到库。

---

## 3. 数据表

建表语句就是仓库里的 `scripts/schema.sql`，部署①那一步已经执行过。以后升级版本要补列时，到 D1 Console 里再执行一次这个文件即可（幂等，重复跑不会报错）。

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

### 4.3 从 SQL 文件灌

D1 控制台 → 你的库 → **Import** → 上传 `.sql` 文件；或者直接 **Console** 里粘 SQL 执行。

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
- **写**：只有上报内容变化才写（hash 相同直接跳过）；10 台机器每小时都变 = 240 行/天，离 10 万行差三个数量级

**结论**：几台到几十台机器、每天几十万次拉订阅，免费版完全够，不用升付费。只有节点总数逼近百万级（单库 500 MB）时才需要换 Workers Paid —— 免费版的 500 MB 是硬上限，不能申请提高。

本项目不存历史版本：每次上报覆盖旧内容，所以库不会随使用时长膨胀。
