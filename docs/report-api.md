# 上报节点接口（POST /api/v1/report/:machine）

线上地址：`https://sub.example.com`

## 一句话

把**节点链接（每行一条）先 base64**，`POST` 到 `/api/v1/report/<机器名>`，带 `Authorization: Bearer <REPORT_TOKEN>`。服务端解析成节点放进这台机器的「② 自动上报」层，立刻进合并订阅。

## 请求

```
POST https://sub.example.com/api/v1/report/<机器名>
Authorization: Bearer <REPORT_TOKEN>
Content-Type: text/plain

<base64 后的节点链接文本>
```

| 项 | 说明 |
| --- | --- |
| 路径参数 `machine` | 机器名，**必须 URL 编码**（中文要 `%E5%B0%8F...`）。规则：首字符是字母/数字（含中文），之后可含字母、数字、空格、`_`、`.`、`-`，总长 ≤64。例：`my-machine`、`hk-1` |
| `Authorization` | `Bearer <上报凭证>`。**只认 `REPORT_TOKEN`**；主订阅 token `SUB_TOKEN` 上报会 401（防止订阅链接泄露就能写数据） |
| Query `source` | 可选，来源名，默认 `default`。同一台机器可以多来源（如 `?source=hk2`），各自独立保存、合并展示 |
| Header `X-Source` | 可选，和 `?source=` 等价（query 优先） |
| Body | **base64 文本**（换行会被自动去掉）。上限 512 KB（base64 后）。明文链接直接传会 400 |

支持的链接协议（解码后逐行解析）：`hysteria2://`、`tuic://`、`vless://`（含 reality / ws / argo）、`vmess://`、`trojan://`、`ss://`。空行和 `#` 开头的注释行会被忽略。

## 怎么把 hy2 / tuic / trojan 串包成 body

```bash
# 1) 把链接放进一个文件，一行一条
cat > /tmp/nodes.txt <<'EOF'
hysteria2://uuid@1.2.3.4:31004?security=tls&alpn=h3&sni=www.microsoft.com#香港-hy2
tuic://uuid:uuid@1.2.3.4:31005?sni=www.microsoft.com&congestion_control=bbr&security=tls#香港-tuic
vless://uuid@1.2.3.4:31003?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.microsoft.com&pbk=PUBKEY&sid=11111111&type=tcp#香港-vless-reality
trojan://uuid@saas.sin.fan:8443?security=tls&type=ws&host=xxx.nyc.mn&path=%2Fuuid-tr&sni=xxx.nyc.mn#香港-trojan-argo
EOF

# 2) macOS / Linux 通用：openssl 输出单行 base64（-A）
BODY=$(openssl base64 -A -in /tmp/nodes.txt)

# 3) 上报
curl -sS -X POST "https://sub.example.com/api/v1/report/my-machine" \
  -H "Authorization: Bearer $REPORT_TOKEN" \
  -H "Content-Type: text/plain" \
  --data-binary "$BODY"
```

如果手上就是一个订阅链接（机场给的 txt），可以直接转：

```bash
curl -sS "$UPSTREAM_SUB_URL" -o /tmp/up.txt          # 上游多半已经是 base64
BODY=$(tr -d '\r\n' < /tmp/up.txt)
curl -sS -X POST "https://sub.example.com/api/v1/report/my-machine?source=airportA" \
  -H "Authorization: Bearer $REPORT_TOKEN" --data-binary "$BODY"
```

仓库自带的脚本可以一次报多台、也能直接从本机订阅文件读：

```bash
# 单台：把本机的订阅文件上报成 hk-node-1
python3 scripts/report.py --base https://sub.example.com --token "$REPORT_TOKEN" \
  --links /tmp/nodes.txt --name hk-node-1

# 多台：机器名 → 上游订阅 URL 的映射
python3 scripts/report.py --base https://sub.example.com --token "$REPORT_TOKEN" \
  --file machines.json
```

## 正常返回

首次上报（内容有变化）：

```json
{
  "ok": true,
  "changed": true,
  "machine": "文档示例-上报",
  "source": "default",
  "bytes": 1108,
  "hash": "2d937f6538ad6301cd2723000819fde5846beeade0490f8f158e83a563efaf35",
  "nodes": 4,
  "auto_nodes": 4,
  "manual_nodes": 0,
  "sources": [{ "source": "default", "nodes": 4, "updated_at": "2026-11-02T10:20:03.970Z" }],
  "manual": false,
  "updated_at": "2026-11-02T10:20:03.970Z"
}
```

| 字段 | 含义 |
| --- | --- |
| `changed` | 内容 hash 和上次一样时为 `false`（不写库、不动时间戳），其余为 `true` |
| `nodes` | 这台机器当前合并后的节点总数（手动层 + 自动层，按链接去重） |
| `auto_nodes` | ② 自动层节点数（把所有 source 合起来） |
| `manual_nodes` | ① 手动层节点数（上报永远不会覆盖它） |
| `sources` | 每个来源的节点数和更新时间 |
| `manual` | 这台机器是否已有手动层（点了「保存配置」就是 true） |
| `hash` / `bytes` | 这次提交内容的 sha256 与 base64 长度 |
| `updated_at` | 这个来源最近一次**内容变化**的时间 |

重复上报同样内容（幂等）：

```json
{ "ok": true, "changed": false, "nodes": 4, "...": "其余字段同上，updated_at 保持不变" }
```

## 错误返回

| HTTP | body | 触发条件 |
| --- | --- | --- |
| 401 | `{"ok":false,"error":"unauthorized"}` | 凭证错 / 用主 token 上报 |
| 400 | `{"ok":false,"error":"invalid machine name"}` | 机器名不合规（如以 `-` 开头） |
| 400 | `{"ok":false,"error":"body must be base64 text"}` | 传了明文链接或空 body |
| 400 | `{"ok":false,"error":"invalid base64"}` | base64 解不出来 |
| 400 | `{"ok":false,"error":"invalid source name"}` | `source` 含非法字符或过长 |
| 413 | `{"ok":false,"error":"subscription too large"}` | base64 后超过 512 KB |
| 500 | `{"ok":false,"error":"SUB_TOKEN is not configured"}` / `DB is not configured` | 变量没配 |

## 上报之后会发生什么

1. 节点进这台机器的 **② 自动上报**（只读快照），立刻出现在「订阅中的节点」里，并按机器的排序位进入 `/sub/all/<token>`。
2. ① 手动层不受影响：如果这台机器已经有手动节点，合并时**手动在前、自动在后**，按链接去重。
3. 同一个 `source` 再次上报会**覆盖**上一次内容（没有历史版本）；`hash` 相同则直接跳过写入。
4. 想撤掉某个来源的自动层：`DELETE /api/v1/machines/<机器名>/sources/<来源名>`（需要登录 token）。
