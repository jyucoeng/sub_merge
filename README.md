# sub-worker

一个部署在 Cloudflare Workers 上的**固定订阅入口**：多台 singbox-manager 把各自的订阅上报到 Worker，客户端通过一个不会随服务器重启变化的 URL 获取订阅。

临时 `*.trycloudflare.com` 隧道在 cloudflared 重启后会换随机域名；本项目把订阅内容集中到固定 Worker 域名，解决这个问题。

## 特性

- 固定订阅 URL，重启/重新部署 Worker 不变；
- `SUB_TOKEN` 拉订阅、`REPORT_TOKEN` 上报（两者可分开，老部署只有 `TOKEN` 也能跑）；
- 每台机器一个 `machine` 名称（可用中文），支持单机和合并订阅；
- **Cloudflare D1（SQLite）单一存储**，两张表 `machines` / `settings`，不依赖 KV 或 R2；
- 按内容 SHA-256 去重，相同内容不重复写；
- **订阅生成结果按内容缓存**（`x-sub-cache: hit`），同一份订阅被反复拉取不再重算，节点解析结果也带缓存；
- 读取强一致：上报后立即能在合并订阅里读到；合并订阅是一次 `SELECT`，无 N+1；
- **WebUI 可以编辑节点链接、节点名称、机器顺序和节点顺序**；
- **自动适配 base64 / Clash / sing-box 订阅格式**；Clash 输出的是完整配置（ACL4SSR 分组 + rule-providers），不是只有 `proxies:` 的片段；
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

## 节点清单（逐节点排除）

WebUI 的「节点清单」列出这台机器**全部节点**（手动 + 上报，按协议标色、标来源），点一行就能切换它进不进订阅：

- 勾选 = 进订阅，取消 = 不进（那一行变灰加删除线，立刻生效）；
- 清单永远显示全部节点，随时可以点回来；
- 排除的是「节点身份」= link 去掉 `#名字` 的部分，所以上游只改显示名不会让排除失效；换端口/换服务器就是另一条节点；
- 和协议筛选叠加：先按协议筛，再逐条排除，两者都满足才进订阅。

```bash
# 看清单（all_nodes 里 enabled=false 就是被排除的）
curl -H "Authorization: Bearer <SUB_TOKEN>" https://sub.dingdang.de5.net/api/v1/nodes/<机器名>

# 设置排除清单（传节点身份数组，空数组 = 全部恢复）
curl -X PUT https://sub.dingdang.de5.net/api/v1/nodes/<机器名>/disabled \
  -H "Authorization: Bearer <SUB_TOKEN>" -H "content-type: application/json" \
  -d '{"disabled":["hysteria2://pw@jp.example.io:443?sni=x"]}'
```

存储同样在 `settings` 表（`disabled:<机器名>`），不占 machines 表、老库不迁移；缓存键带上排除数量，改完立刻生效。

## 协议筛选（每台机器单独选）

一台机器上报的节点常常混着好几种协议（vless / hysteria2 / tuic / trojan …），可以只让其中一部分进订阅：

```bash
# 只保留 vless 和 hysteria2（其它协议在这台机器的订阅里不出现）
curl -X PUT https://sub.dingdang.de5.net/api/v1/nodes/<机器名>/protocols \
  -H "Authorization: Bearer <SUB_TOKEN>" -H "content-type: application/json" \
  -d '{"protocols":["vless","hy2"]}'

# 恢复全部（空数组 = 不筛选，会删掉这条设置）
curl -X PUT … -d '{"protocols":[]}' …
```

- WebUI：节点配置卡片里「协议筛选」一排胶囊，点一下切换，状态栏会报「已只保留 N 种协议，订阅里现在 X 个节点（共 Y 个）」。
- 存储：`settings` 表 `protocols:<机器名>`，值是协议 kind 的 JSON 数组；不占 machines 表，老库不用迁移。
- 生效范围：单机订阅和合并订阅都按它筛；手动节点和上报节点一视同仁（按协议过滤，不看来源）。
- `GET /api/v1/nodes/<机器名>` 会返回 `protocols`（当前勾选）和 `protocol_stats`（这台机器实际有的协议与数量，永远统计全部节点，方便你把筛掉的再勾回来）。
- 缓存键带上筛选结果，切换后立刻生效，不会吃到旧缓存。

## WebUI

部署后访问：

```text
https://<worker>/ui/<TOKEN>
```

界面支持：

- 选择机器；没有机器上报时用“新建机器”直接建一台（名字可留空，自动命名 `manual-1`、`manual-2`…）；
- **重命名**：选中机器后点“重命名”，节点、手动标记和在合并订阅里的位置一起搬到新名字；目标名字已被占用会拒绝，不会覆盖；
- **机器顺序：左边的序号是输入框，直接改成想放的位置**（例如把第 3 台改成 `1` 就提到最前，超出范围会自动收到首/尾），也可以继续用 ↑/↓ 微调，改完点“保存顺序”生效；末列的 `×` 删除整台机器（连同它的手动配置）；
- **批量粘贴导入**：把一整段订阅或多条链接贴进“批量粘贴”框，一行一条，点“解析并添加”，自动拆成多行节点并逐条去重；也可以直接把多条链接粘进某一行的链接框（粘到空行上时那行会被替换）；
- 链接框粘贴后若“显示名称”为空，会自动取 `#` 后面那段（URL 解码后）作为名称，例如 `...hy2-localhost` 那三条会变成 `小叮当-洛杉矶-cloudnium-hy2-localhost`；链接里没有 `#` 时按 `协议-服务器` 生成，比如 `VLESS-1.2.3.4`；vmess 则取 JSON 里的 `ps` 字段；
- 修改节点链接和显示名称；
- 调整节点顺序：序号输入框直接填目标位置（回车生效），或用 ↑/↓ 一行一行挪；
- 添加、删除节点；
- 保存后订阅立即按新顺序生成；
- **手动节点 / 自动节点分开**：上面是可编辑的手动节点，下面是只读的自动上报节点，点「转为手动」把上报的那条固定下来；「清空手动节点」只清手动那份，上报的原样保留；

手动保存后，机器继续自动上报也不会覆盖已编辑节点；需要恢复自动更新时点“恢复自动上报”。
名称留空也能保存：服务端会按同样的规则（`#` 片段 → `协议-服务器`）补齐，不会出现空名字的节点。

## 机器名是什么

机器名（规则 `[\p{L}\p{N}][\p{L}\p{N} _.-]{0,63}`，**可以写中文**，比如 `香港-小叮当`、`洛杉矶 备用`）只是一个分组用的名字，是 `machines` 表的主键，也是合并订阅里的排序单位。它跟节点实际属于哪台服务器、哪个机场、哪个地区都没有绑定关系：Worker 不会校验节点内容，也不会因为名字叫 `hk-1` 就要求里面必须是香港节点。

允许的字符：各语种字母（含中文）、数字、空格、`_`、`.`、`-`；首字符必须是字母或数字，最长 64 个字符。名字区分大小写，`HK-1` 和 `hk-1` 是两台机器。URL 里出现中文要 `encodeURIComponent`（界面会自动处理）。

默认排序认地区：名字里带 `香港`/`东京`/`洛杉矶`/`新加坡`/`法兰克福` 这类词时按对应国家排（香港 → 韩国 → 日本 → 新加坡 → 其余亚洲 → 美国 → 德国 → 欧洲 → 美洲 → 其他），也可以直接写 `hk-`、`us-` 前缀，再用界面上的 `↑ ↓` 手动定序。

所以两种用法都可以：

| 用法 | 长什么样 | 适合 |
| --- | --- | --- |
| 一台一个桶 | `hk-1`、`jp-tokyo`、`us-la`，每台放自己的节点 | 多台服务器各自上报，或想按机器分组排序 |
| 一台装全部 | 只用 `manual-1`，把十来个来源的节点全塞进去 | 纯手动维护，不在乎分组，只想拼成一个订阅 |

节点在合并订阅里按“机器顺序 → 机器内节点顺序”排列，所以想让某些节点排前面，既可以调整机器顺序，也可以把常用节点放进排在前面的那台机器里。

名字随时能改（“重命名”按钮，或 `POST /api/v1/machines/:machine/rename`）。改名是整行搬家：节点、`manual` 标记、`updated_at` 和它在 `machine_order` 里的位置都跟着走，旧名字立刻消失，合并订阅不会断。

## 同名机器：一台机器可以有多个上报来源

机器名是**分组**，不是身份。两块机器都叫 `vps` 时，用 `source` 区分它们，谁也不会覆盖谁：

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" --data-binary "$BODY" \
  "https://<worker>/api/v1/report/vps?source=box-a"
curl -X POST -H "Authorization: Bearer $TOKEN" --data-binary "$BODY2" \
  "https://<worker>/api/v1/report/vps?source=box-b"
```

- `source` 也可以放在请求头 `X-Source` 里；不写就是 `default`；
- 格式同机器名：`[\p{L}\p{N}][\p{L}\p{N} ._:-]{0,63}`，非法返回 `400 invalid source name`；
- 每个来源单独一行存在 `reports` 表，`machine + source` 是主键：同一台机器（同一个 source）重报只换自己那份，别的来源原样保留；
- 合并订阅里这台机器的自动节点 = **所有来源的并集**（链接相同的只留一条），顺序按协议优先级排；
- 来源删掉一个不影响其它：`DELETE /api/v1/machines/:machine/sources/:source`，界面上就是来源 chip 后面的 ×；
- 只上报、什么都不改的话，来源名建议用主机名：`scripts/report.py --url ...` 默认 `--source` 就取本机主机名（`SUB_SOURCE` 环境变量或 `--source` 可覆盖）。

这样两种常见撞车都解决：两块机器都按 hostname 自动命名（可能同名）→ source 不同；一台机器改过名字 → 新名字新来源，旧来源在界面上一键删掉。

## 手动节点与上报节点

节点分两份存，**上报只改上报那份，手动那份谁都动不了**。所以一台机器可以既自动上报、又挂几条你自己加的节点。

| 来源 | 谁写入 | 存在哪 | 界面 |
| --- | --- | --- | --- |
| 机器自动上报 | 客户端 `POST /api/v1/report/<machine>` | `content` + `nodes_json` | 「自动上报的节点」只读区，蓝色「上报」徽章（机器没有手动节点时） |
| 手动输入 | “+ 添加节点”（一次一个）/ 批量粘贴（一次多个）/ 「转为手动」 | `manual_nodes_json` | 「手动节点」可编辑区，黄色「手动」徽章 |

- **顺序**：合并订阅里这台机器先排手动节点（按你在界面上排的次序），再接上报节点（按协议优先级：Reality → anytls → Argo → ws → hy2 → tuic …）；
- **去重**：同一条链接既手动又上报时只出一条（用你手动给的名称）；
- **「转为手动」**：在只读区点一下，就把那条上报节点复制进手动列表，之后上报再怎么变都不影响它（常见用法：把某条节点改个自己喜欢的名字固定住）；
- **「清空手动节点」**：只清手动列表，上报节点原样保留；
- 机器列表里每台机器会显示「N 节点（手动 M）」，鼠标悬停能看「手动 M 个 · 自动 N 个」；
- 一台机器**只有手动节点、从没上报过**时，它的 `content` 是空的——这不影响使用，手动节点照样进订阅。

## 登录

UI 打开就是登录页，只有管理员一种身份。口令全部来自 Cloudflare 后台变量，界面里既不显示也改不了。

**用明文变量**（Dashboard → Workers & Pages → sub-worker → Settings → Variables and Secrets，类型 Text），后台直接看得见：

| 变量 | 作用 |
| --- | --- |
| `ADMIN_PASSWORD` | 管理员口令，进 UI 后可读可写 |
| `ADMIN_USERNAME` | 可选，配了就必须「用户名 + 口令」都对才能登录（用户名本身当秘密用，别写 admin） |
| `REPORT_TOKEN` | 可选，机器上报专用凭证；配了就只认它，`SUB_TOKEN` 不再能写数据 |
| `SUB_TOKEN` | 订阅 token（老的 `TOKEN` 仍兼容，同名部署里优先用 `SUB_TOKEN`） |

```bash
pnpm exec wrangler deploy --keep-vars \
  --var ADMIN_PASSWORD:你的管理员口令 \
  --var TOKEN:你的订阅token
```

- `/ui` 永远是登录页；`/ui/<任何东西>` 也只是这张登录页，URL 里不携带凭据。
- 登录态存 `localStorage`，刷新不用重输；右上角「退出登录」清掉。

| 接口 | 作用 |
| --- | --- |
| `POST /api/v1/auth/login` | `{password}` → `{role, token}` |
| `GET /api/v1/auth/session` | 当前角色，附带 `sub_token`（页面用它拼订阅链接） |
| `GET /api/v1/admin/logins` | 谁在猜口令：失败次数、是否被锁、解锁时间 |
| `GET /api/v1/admin/env` | 变量自检：已用 / 多余 |

配了 `ADMIN_USERNAME` 后登录页会自动多出一个用户名输入框（页面靠 `GET /api/v1/auth/mode` 判断，不泄露任何秘密）。用户名或口令任一不对都算一次失败，同样计入锁定。

**机器上报用什么凭证**：默认沿用 `SUB_TOKEN`（订阅和上报同一串）。想要「订阅链接外泄也写不了数据」，配一个独立的 `REPORT_TOKEN`：

```bash
OPENSSL=$(openssl rand -hex 24)
pnpm exec wrangler deploy --keep-vars --var REPORT_TOKEN:$OPENSSL
# 机器上的 cron：SUB_REPORT_TOKEN=$OPENSSL python scripts/report.py --links /tmp/links.txt
```

它是普通变量，**不会过期**；要换就改后台的 `REPORT_TOKEN` 再部署，然后在机器上把新值写进 `SUB_REPORT_TOKEN`。改完旧值立刻失效（401），订阅链接不受影响。

登录成功发的是**签名会话 token**（`sk1.<过期时间>.<HMAC>`，7 天有效），不是口令本身：改 `ADMIN_PASSWORD` 会让所有旧会话立刻失效。脚本仍可直接用 `TOKEN` 或 `ADMIN_PASSWORD` 当 bearer，但 **`TOKEN` 不能用来登录界面**（订阅链接外泄不等于后台外泄）。明文 HTTP 请求会 308 跳 HTTPS。

登录限速：同一 IP 10 分钟内失败 10 次锁 **24 小时**（`429` + `retry-after`），成功登录清零，计数存在 D1 的 `settings` 表里（`login-fail:<ip>`）。

自己把自己锁了的话（比如连错 10 次），清一下计数即可解锁：

```bash
pnpm run unlock   # DELETE FROM settings WHERE key LIKE 'login-fail:%'
```

### 「转为手动」之后上报还会不会覆盖

不会覆盖，也**不会变成两条**——上报照常收下，只是订阅里这一条用手动的版本：

| 场景 | `reports` 里 | 订阅里 |
| --- | --- | --- |
| 上报一条 → 点「转为手动」（只改名字） | 那份继续按最新内容更新 | **只有 1 条**，名字、顺序都按手动的 |
| 之后上游继续上报同一条（可能又改了名字） | `content`/`hash`/`updated_at` 照常刷新，`changed` 正常返回 | 仍是那 1 条手动版本 |
| 上游换了端口/密码/协议参数 | 保存成新的一条节点 | 手动那条在前、新的自动节点跟在后面（**2 条**，旧的失效了自己在界面删掉） |
| 点「清空手动节点」 | 不受影响 | 自动那份立刻回来（就是最近一次上报） |

判断「是不是同一条节点」看的是**去掉 `#名字` 之后的链接**（协议 + 凭据 + 地址 + 端口 + 参数），所以上游只改节点名时不会冒出重复条目。

## 订阅格式

客户端 `User-Agent` 会自动识别：

| 客户端 / 参数 | 格式 |
|---|---|
| V2RayN、默认 | base64 URI |
| Clash、Mihomo、Meta | Clash 完整配置（`proxies` + `proxy-groups` + `rule-providers` + `rules`） |
| sing-box / singbox | sing-box JSON |

也可以显式指定：

```text
/sub/all/<TOKEN>?format=base64
/sub/all/<TOKEN>?format=clash      # 完整配置：分组 + 规则
/sub/all/<TOKEN>?format=proxies    # 片段：只有 proxies:，给 proxy-provider 用
/sub/all/<TOKEN>?format=singbox
/sub/all/<TOKEN>?clash
/sub/all/<TOKEN>?singbox
```

### Clash 完整配置里的分组和规则

`?format=clash` 输出的是一份能直接导入 mihomo / Clash.Meta 的完整配置：

- **代理分组**：沿用 ACL4SSR 的命名与顺序 —— `🚀 节点选择`、`☑️ 手动切换`、`♻️ 自动选择`（url-test，300s / tolerance 50）、`📹 油管视频`、`🎥 奈飞视频`、`🌍 国外媒体`、`📲 电报信息`、`🤖 OpenAi`、`🛸 Antigravity`、`Ⓜ️ 微软服务`、`🍎 苹果服务`、`📢 谷歌FCM`、`🎯 全球直连`、`🛑 全球拦截`、`🍃 应用净化`、`🐟 漏网之鱼`，以及 ~35 个国家分组；
- **国家分组按节点名匹配**：香港 / 香港节点 / HK / HKG、美国 / 洛杉矶 / 圣何塞 / US / LAX…，中文机器名和中文节点名都能命中。短英文代号（`DE`、`US`、`HK`…）要求整词匹配，所以 `Node-1` 不会被误判成德国；
- **空分组自动省略**：没匹配到节点的国家分组不会输出，引用它的分组里也不留空引用，指向它的 `RULE-SET` 也一起跳过（Clash 空 `proxies:` 会直接报错）；WebUI 里这种组会显示成灰的，保存后状态栏会列出「当前没有匹配的节点、订阅里会省略」的组名；
- **`🚀 节点选择` 和 `🐟 漏网之鱼` 列出全部 36 个国家分组**：不用手动往里加，新国家组只要匹配到节点就自动出现在选择列表里；
- **节点名去重**：不同机器里出现同名节点（或同一条链接）时自动加 ` 2`、` 3` 后缀，避免 Clash 因重名拒绝加载；
- **规则以 `rule-providers` 下发**：默认 28 个 ACL4SSR 规则集（`BanAD`、`BanProgramAD`、`GoogleCN`、`Microsoft`、`Apple`、`Telegram`、`OpenAi`、`YouTube`、`Netflix`、`ChinaDomain`、`ChinaCompanyIp`、`zdy` 等）只写 URL 和 `RULE-SET,<name>,<group>`，`behavior: classical` + `format: text`，客户端自己拉取并缓存 24 小时。Worker 里**不抓取、不内联**规则 —— 30 个 .list 内联下来是几 MB、几十次 subrequest，免费版（CPU 10 ms / subrequest 50）根本跑不动；
- **收尾规则**固定是 `GEOIP,CN,🎯 全球直连` 和 `MATCH,🐟 漏网之鱼`；`geodata-mode: true` + `geo-auto-update: true`，`geox-url` 指向 MetaCubeX 的 geoip/geosite/mmdb/asn。

分组与规则定义来自 [ACL4SSR](https://github.com/ACL4SSR/ACL4SSR) 生态（跟 [clash-sub-converter](https://github.com/jyucoeng/clash-sub-converter) 的默认规则一致），DNS 段用 fake-ip + 国内 DoH，需要 **mihomo / Clash.Meta**（老版 Clash Premium 不认识 `rule-providers`、`fake-ip`、`geodata-mode` 这些字段）。

### 分组与规则来源可以自己改（可增可删）

上面这套分组和 `rule-providers` 只是**内置默认模板**，不是写死的。WebUI 底部的「分流规则」卡片里能直接改：

- **改**：分组名、类型（`select` / `url-test` / `fallback` / `load-balance` / `relay`）、过滤正则、成员、规则来源的 URL 与归属分组；
- **增**：`+ 新增分组`、`+ 新增规则来源`；
- **删**：每行末尾的 `×`；
- **恢复默认**：`恢复默认` 一键回到内置模板（自定义那份会丢，会先弹确认）。

分组的成员来源二选一：

- `过滤`（正则）：按节点名匹配，跟内置国家分组一样，例如 `(?i)香港|HK|HKG`；一个节点都没匹配到时整组不输出（Clash 里空的 `proxies:` 会直接报错）、行会标红并写「没有节点匹配 · 订阅里会省略」；
- 过滤里有正则元字符（`. * + ? [ ] { } ^ $ \`）时按**真正的正则**编译，所以 `.*` / `^(HK|US)` / `hk\d+` 都按正则语义生效；纯「关键词 + `|`」的写法仍然带词边界，`(德国|DE)` 不会误命中 `node` 里的 `de`；
- `只看有节点的分组`：勾上之后列表只留有节点命中的组，37 个空国家组不会再占屏；
- `成员`（逗号分隔）：显式写分组名或 `DIRECT` / `REJECT` / `PASS`，例如 `🚀 节点选择, DIRECT`。

规则来源只填 URL 就行，provider 名会按文件名自动生成（`BanAD.list` → `BanAD`）；自己填名字时必须匹配 `[A-Za-z0-9_-]{1,64}`。

改完点「保存规则」立即生效：订阅缓存是按规则版本分键的，规则一变旧缓存就不再命中，不用等过期。也可以直接走 API：

```bash
curl -H "Authorization: Bearer $TOKEN" https://<worker>/api/v1/clash/rules                 # 读当前规则
curl -H "Authorization: Bearer $TOKEN" https://<worker>/api/v1/clash/rules/default         # 看内置默认
curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     https://<worker>/api/v1/clash/rules -d @rules.json                                   # 覆盖保存
curl -X POST -H "Authorization: Bearer $TOKEN" https://<worker>/api/v1/clash/rules/reset   # 恢复默认
```

`rules.json` 形如：

```json
{
  "groups": [
    { "name": "🚀 节点选择", "type": "select", "members": ["♻️ 自动选择", "🇭🇰 香港节点", "DIRECT"] },
    { "name": "🇭🇰 香港节点", "type": "url-test", "filter": "(?i)香港|HK|HKG",
      "url": "http://www.gstatic.com/generate_204", "interval": 300, "tolerance": 50 }
  ],
  "rulesets": [
    { "name": "BanAD", "group": "🛑 全球拦截", "url": "https://raw.githubusercontent.com/.../BanAD.list" }
  ]
}
```

**空分组不会被留空输出**：过滤组一个节点都没匹配到、或者成员全指向不存在的分组时，整组直接省略（Clash 里空的 `proxies:` 会直接报错），并且引用它的分组会跟着收敛，指向它的 `RULE-SET` 规则也一起跳过，`MATCH` 自动落到还活着的第一个分组上。WebUI 保存前也会先自查一遍：某组既没过滤也没成员、成员不是已定义分组名、规则来源没选分组或 URL 不是 `http(s)`，都会当场提示，不会先发请求再吃 400。

过滤正则可以直接写 `(?i)` 前缀（会忽略，匹配本来就区分大小写不敏感），`(?i:xxx)` 也会被拆掉。

校验挺严，写错了会直接 400 并说清第几条哪里不对：分组重名、`filter` 不是合法正则、`filter` 和 `members` 同时给、`rulesets` 引用了不存在的分组、URL 不是 `http(s)`、条目超过 200 条，都会被拦下。规则存在 `settings` 表里（key `clash_rules`），跟着 D1 走，升级不用额外建表。

只想要节点列表、自己配分组的话用 `?format=proxies`，它输出的是纯 `proxies:` 片段。

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

三张表，`scripts/schema.sql` 就是完整定义：

```sql
CREATE TABLE IF NOT EXISTS machines (
  machine    TEXT PRIMARY KEY,           -- 机器名：字母/数字/中文 + 空格 _ . -，≤64 字符
  content    TEXT NOT NULL,              -- base64 订阅原文
  hash       TEXT NOT NULL,              -- content 的 SHA-256，用于去重
  bytes      INTEGER NOT NULL DEFAULT 0, -- base64 长度
  updated_at TEXT NOT NULL,              -- ISO 8601 时间
  nodes_json TEXT NOT NULL DEFAULT '[]',        -- 最近一次自动上报解析出的节点
  manual_nodes_json TEXT NOT NULL DEFAULT '[]', -- WebUI 手写的节点（上报永不覆盖）
  manual     INTEGER NOT NULL DEFAULT 0,        -- 1 = 有手动节点
  auto_content TEXT                             -- 1.6.0 遗留列，1.7.0 起不再写入
);

CREATE INDEX IF NOT EXISTS idx_machines_updated_at ON machines (updated_at DESC);

CREATE TABLE IF NOT EXISTS reports (
  machine    TEXT NOT NULL,              -- 机器名
  source     TEXT NOT NULL,              -- 上报来源，默认 default，?source= 或 X-Source 指定
  content    TEXT NOT NULL,              -- 这个来源最近一次上报的 base64 原文
  hash       TEXT NOT NULL,              -- 内容 SHA-256（同一来源重复上报时去重）
  bytes      INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  nodes_json TEXT NOT NULL DEFAULT '[]', -- 这个来源解析出的节点
  PRIMARY KEY (machine, source)
);

CREATE INDEX IF NOT EXISTS idx_reports_machine ON reports (machine);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,                -- 目前只有 machine_order
  value TEXT NOT NULL                    -- JSON 文本
);
```

一台机器里有两份节点，互相不覆盖：

| 列 | 谁写 | 作用 |
| --- | --- | --- |
| `content` / `hash` / `nodes_json` | 只有 `POST /api/v1/report/<machine>` | 最近一次上报的原文 + **所有来源合并后**的节点（冗余一份，让读取永远只有一次查询） |
| `manual_nodes_json` | 只有 WebUI 保存节点 | 你手写的节点 |

合并订阅里这台机器的节点 = **手动节点（按你排的顺序在前）+ 上报节点（按协议排在后）**，链接相同的只留一条（留手动那条）。

`reports` 是真正的上报数据：一个来源一行，`machines.nodes_json` 只是它们的合并结果。所以两块同名机器（`?source=` 不同）各写各的行，合并订阅里两条都在；删掉一个来源只删那一行，再重算一次合并。

老库升级不用改 SQL：`POST /api/v1/admin/schema` 会建 `reports` 表、把老的 `machines.content` 补成 `source=default` 的一行（返回值 `report_sources_migrated`），并补列（`ALTER TABLE ... ADD COLUMN manual_nodes_json TEXT NOT NULL DEFAULT '[]'`，重复执行报 `duplicate column` 会被忽略），并把老的手动机器拆开——原来 `nodes_json` 里的手写节点搬到 `manual_nodes_json`，`auto_content` 里的最近上报搬回 `content`/`nodes_json`；返回值里的 `node_sources_migrated` 告诉你这次搬了几台。

写入路径：上报 = `reports` 表一次 UPSERT + `machines` 一次 UPSERT；WebUI 保存节点 = `machines` 一次 UPSERT。读取路径只有两条：单机 `WHERE machine = ?1`、合并订阅 `SELECT * FROM machines`（一次查询，机器数量不影响往返次数，合并结果已经摊在 `nodes_json` 里）。

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
| 合并订阅耗时 | 13 机 × 40 节点（520 节点）：内容变化后生成一次 9 ms，同一内容重拉 2.4 ms | 约 **17 µs / 节点**（生成），命中缓存后 ≈ 0 |
| 单机订阅耗时 | 40 节点 ≈ 1.4 ms | 只解析自己那台机器 |
| 上报耗时 | 1 行读 + 去重 sha256，可忽略 | 主要花在 D1 往返，不算 CPU 大头 |

换算基准：**500 MB = 512,000 KB**、**每机 20 节点 ≈ 8.1 KB**、**合并订阅每次调用解析 N×P 个节点**。

### 生成结果缓存（v1.5.0）

合并订阅要把所有机器、所有节点拼成一份订阅，节点越多越费 CPU。现在生成结果会在 Worker 实例内存里缓存，**同一份内容重复拉取直接返回上次的字符串**：

| 场景 | 每次请求的 CPU | 说明 |
|---|---|---|
| 内容变化后的第一次拉取 | 全量生成（520 节点约 9 ms） | 上报 / 保存节点 / 改顺序都会走到这里 |
| 之后同一份内容再拉 | 只剩读库与返回，≈ 0 | 响应头 `x-sub-cache: hit` |

缓存 key 由「格式 + 机器顺序 + 每行的 `machine/updated_at/hash/manual`」拼成，任何一次上报或手动保存都会换 key，**不会返回旧内容**；最多留 8 条、单条超过 512 KB 不缓存，按 LRU 淘汰。

这意味着「100 个客户端同时拉同一份订阅」只贵第一次，后面都是命中——免费版 CPU 10 ms 的硬顶只约束「内容变化后的第一次生成」。缓存是每个 Worker 实例各自一份（不是全局共享），实例冷启动后的第一发请求算未命中。

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
| 5 | 117 台 | 352,941 台 |
| 10 | 58 台 | 176,470 台 |
| 20 | **29 台** | 88,235 台 |
| 40 | 14 台 | 44,117 台 |

这张表算的是**内容变化后第一次生成**的代价（按 17 µs/节点）。命中缓存后 CPU ≈ 0，所以反复拉同一份订阅不吃这张表的限制；一旦谁上报或改了节点，下一发请求就按全量生成算。**免费版用合并订阅，二十来台机器是安全区，四十台开始贴着 10 ms 线**（1102 `Worker exceeded resource limits`）。

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
| 自己家用，3~10 台机器 | 免费版 + 每小时上报 + 合并订阅，够用（10 台 × 20 节点 ≈ 3.4 ms 生成，之后都是缓存命中） |
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

不需要 `PUBLIC_BASE_URL`；Worker 的 `/api` 索引返回的 `subscription_base` 来自当前请求的 `Origin`（根路径 `/` 现在是 WebUI）。

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
POST /api/v1/report/:machine?source=box-a
Authorization: Bearer <TOKEN>
Content-Type: text/plain
Body: base64 编码的订阅内容
```

`source` 也可以放在 `X-Source` 请求头里，省略即 `default`；一块机器一个来源，同名机器互不覆盖（见上文「同名机器」）。

`machine` 只允许：

```text
[\p{L}\p{N}][\p{L}\p{N} _.-]{0,63}
```

也就是字母（含中文）、数字、空格、`_`、`.`、`-`，首字符为字母或数字。中文名在 URL 里要编码，例如 `POST /api/v1/report/%E9%A6%99%E6%B8%AF-%E5%B0%8F%E5%8F%AE%E5%BD%93`。

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
| `POST` | `/api/v1/machines/:machine/reset` | 清空这台机器的手动节点（自动上报的节点保留），Bearer `TOKEN` |
| `DELETE` | `/api/v1/machines/:machine/sources/:source` | 删掉一个上报来源的节点，别的来源和手动节点不动，Bearer `TOKEN` |
| `GET` | `/api/v1/machines` | 查看已上报机器，Bearer `TOKEN` |
| `DELETE` | `/api/v1/machines/:machine` | 删除机器，Bearer `TOKEN` |
| `GET` | `/api/v1/clash/rules` | 读取当前分组与规则来源，Bearer `TOKEN` |
| `PUT` | `/api/v1/clash/rules` | 覆盖保存分组与规则来源，Bearer `TOKEN` |
| `GET` | `/api/v1/clash/rules/default` | 读取内置默认规则（不受自定义影响），Bearer `TOKEN` |
| `POST` | `/api/v1/clash/rules/reset` | 恢复内置默认规则，Bearer `TOKEN` |
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

默认返回 `text/plain` 的 base64 订阅内容；`?format=clash` 返回带分组与规则的完整 Clash 配置，`?format=proxies` 只返回 `proxies:` 片段，`?format=singbox` 返回 sing-box JSON。

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

Worker 端**没有生成规则**：名字就是上报 URL 路径里那一段（`POST /api/v1/report/<machine>`，中文要 URL 编码），服务端只做格式校验 `[\p{L}\p{N}][\p{L}\p{N} _.-]{0,63}`，不合格返回 `400 invalid machine name`。所以名字由上报端决定：

| 上报端 | 名字来源 | 例子 |
| --- | --- | --- |
| `scripts/report.py --file machines.json` | JSON 的 key | `"sgw-oracle-nat": "https://..."` |
| `scripts/report.py --machine` | `=` 左边 | `--machine sjc-1=https://...` |
| `scripts/report.py --url --from-hostname` | 本机主机名 slug 化 | `HK-Node_1.local` → `hk-node-1-local` |
| `scripts/report.py --url --name 中文名` | 显式中文名，原样发送（路径自动编码） | `--name 香港-小叮当` |
| `scripts/report.py --url --name` | 显式给的 `--name` | `--name hk-1` |
| `scripts/report.py --source` | 上报来源（默认本机主机名） | `--source box-a` |
| `scripts/report.py --links nodes.txt` | 机器名 = 这些节点名的**公共前缀** | 4 条 `…-荷兰阿姆斯特丹-*` → `小叮当-淡-荷兰阿姆斯特丹` |
| singbox-manager | `sub_machine='...'` 配置值 | `sub_machine='sgw-1'` |
| 自己写的客户端 | 自己拼的路径 | `curl .../api/v1/report/us-la` |

`--from-hostname` 的转换规则：小写、非字母数字替换成 `-`、去掉首尾 `-`、截断到 63 字符；结果为空或首字符不是字母数字时补前缀 `machine-`。

同一个名字 + 同一个 `source` 重复上报 = 覆盖那一份（内容 hash 不变则跳过写入）。名字在多机部署里建议写成 `地区-用途-序号`；万一两块机器同名，用 `?source=` 区分即可，不会互相覆盖。

### 直接拿节点链接上报

手上只有一串节点链接（没有订阅 URL）时，把链接写进文件用 `--links` 直接上报，机器名自动取这些节点名的公共前缀：

```bash
cat > nodes.txt <<'EOF'
hysteria2://...@1.2.3.4:31004?...#小叮当-淡-荷兰阿姆斯特丹-hy2-NLEFNI
tuic://...@1.2.3.4:31005?...#小叮当-淡-荷兰阿姆斯特丹-tuic-NLEFNI
vless://...@1.2.3.4:31003?...#小叮当-淡-荷兰阿姆斯特丹-vless-reality-NLEFNI
trojan://...@saas.example:8443?...#小叮当-淡-荷兰阿姆斯特丹-trojan-ws-tls-argo-NLEFNI-8443
EOF

pnpm exec python3 scripts/report.py --base https://<worker> --token $TOKEN \
  --links nodes.txt --source nlefni
# 节点 4 条 -> 机器「小叮当-淡-荷兰阿姆斯特丹」
# 小叮当-淡-荷兰阿姆斯特丹: source=nlefni changed=True nodes=4
```

- 每行一条，空行和 `#` 开头的行跳过，重复链接自动去掉；
- 机器名 = 所有 `#` 片段（URL 解码后）的公共前缀，去掉结尾的 `-` `_` `.` 空格；推不出来（没有片段或毫无共同前缀）就用 `--name` 指定；
- 想先看会生成什么名字，加 `--dry-run`。

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
- `?format=clash` 是给 mihomo / Clash.Meta 的完整配置；老的 Clash Premium 或只认 `proxies:` 的客户端请用 `?format=proxies` 片段自己套分组；规则集是客户端联网拉的（首次启动会下载 28 个 .list 和 geo 数据），离线环境需要提前放好缓存；
- 订阅生成结果缓存在 Worker 实例内存里（每个实例一份，最多 8 条），实例回收后第一次拉取要全量重算；响应头 `x-sub-cache: hit/miss` 可以直接看出命中情况；
- `workers.dev` 域名在部分地区可能不可达，建议绑定自定义域名。

## 开发

```bash
pnpm install
pnpm run db:init:local    # 本地 D1 建表（wrangler dev --local 首次使用前需要）
pnpm dev --local --var TOKEN:test-token
pnpm test                 # Node 内置测试（内含纯 JS 的 D1 内存实现）
pnpm run test:sqlite      # 同一批测试跑真实 SQLite（node:sqlite），验证 DDL / SQL 语法
pnpm run test:ui          # 用真实页面脚本 + 最小 DOM 壳点一遍 WebUI 全流程（新建/批量粘贴/排序/改名/删除/reset）
pnpm run bench:sub        # 订阅生成基准：冷启动 / 内容变化后 / 命中缓存三种情况的耗时
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
