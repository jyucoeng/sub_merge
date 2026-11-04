# sub-merge

把很多条订阅合并成一个固定地址。跑在 Cloudflare Workers 或 Pages 上，数据存 D1，全程免费额度即可跑。

- **固定订阅链接**：机器换了、节点变了，客户端里的订阅地址不用改
- **WebUI 管理**：机器、手动节点、分流规则、订阅档案、短链
- **多来源上报**：同一台机器可以由多个上报源写（`?source=` 区分），互不覆盖

---

## 1. 部署

两种方式二选一，都要先做第 0 步。

### 第 0 步：建数据库（两种方式都要）

1. Dashboard → **Storage & Databases → D1 SQL Database → Create database**，名字填 `sub-merge-db`
2. 点进这个库 → 顶部 **Console** → 把仓库里 [`scripts/schema.sql`](scripts/schema.sql) 的全文粘进输入框 → **Execute**（`machines` / `reports` / `presets` / `links` / `settings` 五张表一次建好，重复执行也没事）

### 方式 A：Workers —— 把代码粘进网页编辑器

1. 打开仓库根目录的 [worker.single.js](worker.single.js)（点右上角 **Raw** 看纯文本），**全选复制**。这就是全部代码，一个文件约 260 KB，不用在本地装任何东西。
   （想自己生成：仓库里跑 `npm run build:single`，产物是根目录的 `worker.single.js`，内容和上面那个一样。）
2. Dashboard → **Workers & Pages → Create → Workers → Hello World**，起个名字（例如 `sub-merge`）→ **Deploy**
3. 点 **Edit code**（部分界面叫 **Edit**）→ 编辑器里那段 Hello World 默认代码 **Ctrl/Cmd+A 全选删掉** → 粘贴刚才复制的内容 → 右上角 **Deploy**
4. 回到 Worker → **Settings → Bindings → Add → D1 database**：Variable name 填 **`DB`**（一字不差），Database 选 `sub-merge-db`
5. **Settings → Variables and Secrets → Add**：加 `SUB_TOKEN`、`ADMIN_PASSWORD`、`REPORT_TOKEN`（Type 选 Text）
6. 打开 `https://<你的-worker-名>.workers.dev/ui`，用 `ADMIN_PASSWORD` 登录（改过 `UI_PATH` 就换成你的路径）

> 一次粘 260 KB 编辑器会卡几秒，等代码高亮完再点 Deploy；中途别刷新页面。
> 变量和绑定改完，要再点一次 **Deploy** 才生效。

### 方式 B：Pages —— 连 GitHub 仓库，以后 push 自动部署

1. 先 **Fork** 本仓库到自己名下（页面右上角 Fork）
2. Dashboard → **Workers & Pages → Create → Pages → Connect to Git** → 授权 GitHub → 选中你 fork 的 `sub_merge` → **Begin setup**
3. 构建配置照这张表填：

   | 填哪项 | 填什么 |
   | --- | --- |
   | Framework preset | `None` |
   | Build command | `npm run build:pages` |
   | Build output directory | `dist-pages` |

4. **Save and Deploy**，等一分钟左右
5. 进入项目 → **Settings → Bindings → Add → D1 database**：Variable name 填 **`DB`**，Database 选 `sub-merge-db`，Production 和 Preview 两个环境都加
6. **Settings → Variables and Secrets → Add**：加 `SUB_TOKEN`、`ADMIN_PASSWORD`、`REPORT_TOKEN`
7. **Deployments** → 最新那条 → 右侧 `⋯` → **Retry deployment**（绑定和变量在部署时注入，不重试会报 `env.DB is undefined`）
8. 打开 `https://<项目名>.pages.dev/ui`，用 `ADMIN_PASSWORD` 登录（改过 `UI_PATH` 就换成你的路径）

以后 push 到这个仓库的 main 分支，Pages 会自动重新部署；只改变量或绑定时要手动 Retry 一次。

---

## 2. 环境变量

| 变量 | 必填 | 作用 |
| --- | --- | --- |
| `SUB_TOKEN` | ✅ | 订阅链接里的口令：`/sub/all/<SUB_TOKEN>`。够长够随机就行 |
| `ADMIN_PASSWORD` | ✅ | WebUI 登录口令 |
| `REPORT_TOKEN` | ✅ | 服务器上报用的口令（`/api/v1/report/...` 的 Bearer） |
| `UI_PATH` | ❌ | 管理界面的入口路径，默认 `/ui`。填了之后只有这个路径能打开，`/ui` 直接 404（见下） |

三个口令互相独立、都填长随机串；`SUB_TOKEN` 会出现在订阅链接里，`REPORT_TOKEN` 只给上报脚本用，泄露了不会连带订阅链接。

### 自定义界面入口

不想让 `/ui` 这么显眼就换一个，在环境变量里加 `UI_PATH`：

| 填的值 | 实际入口 |
| --- | --- |
| 不填 / 空串 / `/` | `/ui`（默认） |
| `my-panel` | `/my-panel`（自动补前导斜杠） |
| `/my-panel/` | `/my-panel`（尾部斜杠归一） |

配了之后**只认这个路径**，`/ui` 和别的路径一样返回 404、响应里什么内容都没有。子路径（`/my-panel/任意/深度`）也放行给同一个单页，前端刷新不会 404。

两点容易踩：

- 改完要**重新部署**一次。环境变量只对新的部署生效，光在后台加变量、刷新页面是没变化的。
- 它是**换门牌，不是加锁**。路径扫不到只让人不知道这站有界面，知道路径的人照样要对着口令框输密码；真正的门槛是 `ADMIN_PASSWORD` 加上登录限速（同一 IP 10 分钟内错 10 次锁 24 小时）。

`/api` 返回的 `ui` 字段会跟着变，脚本里要拼入口地址就从那儿取，别写死 `/ui`。

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
- **机器名怎么写**：建议 `<地区>-<序号>`，比如 `hk-1`、`圣何塞-1`、`jp-osaka`。默认排序会从机器名里认国家码（两字母码，或 `香港/圣何塞/洛杉矶` 这类中文地区词，能独立成段最好），认不出来的机器排到最后，机器列表里标「无地区」。机器名只是上报标识，跟节点名无关——改它不影响客户端里显示的节点名。
- 同名机器可多来源：加 `?source=hk2`
- 返回 `{"ok":true,"changed":true,"nodes":4,...}`，`changed:false` 表示内容没变

支持「自动上报」的脚本：`singbox-tools`（`sb report`，见 [README-sb.md](https://github.com/jyucoeng/singbox-tools/blob/main/README-sb.md)）。

### 4.3 从 SQL 文件灌

D1 控制台 → 你的库 → **Import** → 上传 `.sql` 文件；或者直接 **Console** 里粘 SQL 执行。

### 4.4 导出与备份

页面右上角有两个按钮，导出的东西不一样：

| 按钮 | 内容 | 拿来干什么 |
| --- | --- | --- |
| **导出 SQL** | 建表语句 + 每行一条 `INSERT OR REPLACE` | **恢复现场用这个**。不装任何工具，D1 Console 粘进去就跑 |
| **JSON** | 六张表的原始行数据 | 给程序读、版本间比对；想导回去得自己写映射 |

SQL 那份是照着「能重放」写的：

- 先 `CREATE TABLE IF NOT EXISTS`（含索引），再插数据 → 灌进空库也能建起整套表结构
- 插的是 `INSERT OR REPLACE`，同一个文件重复执行只是覆盖，不会主键冲突
- 值里的单引号写成两个（`it's` → `'it''s'`），换行、中文、base64 原样保留
- 末尾的注释行会标出每张表导了多少行，空表也留一句说明

**行数多的库别用 Console 粘**：单次提交有长度限制，走命令行：

```bash
wrangler d1 execute <你的库名> --remote --file=sub_merge_20261104-093000.sql
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
- **写**：只有上报内容变化才写（hash 相同直接跳过）；10 台机器每小时都变 = 240 行/天，离 10 万行差三个数量级

**结论**：几台到几十台机器、每天几十万次拉订阅，免费版完全够，不用升付费。只有节点总数逼近百万级（单库 500 MB）时才需要换 Workers Paid —— 免费版的 500 MB 是硬上限，不能申请提高。

本项目不存历史版本：每次上报覆盖旧内容，所以库不会随使用时长膨胀。
