#!/usr/bin/env python3
"""把多台机器的订阅 URL 上报到 sub-worker。

用法：
  python scripts/report.py --base https://xxx.workers.dev --token "$TOKEN" \
      --file machines.json

machines.json:
  {
    "sgw-oracle-nat": "https://entitled-....trycloudflare.com/xxx.txt",
    "sjc-oracle-nat": "https://psp-....trycloudflare.com/xxx.txt"
  }

单机场景可以不带映射，直接让脚本用主机名当机器名：

  python scripts/report.py --base https://xxx.workers.dev --token "$TOKEN" \
      --url https://sub.example.com/sub.txt --from-hostname
  # 上报到 /api/v1/report/<slugify(hostname)>，例如 hk-node-1

只依赖 curl，避免 Python urllib 被 Cloudflare 的 bot 规则拦截。
"""

import argparse
import base64
import json
import os
import re
import socket
import subprocess
import sys
import urllib.parse


def slugify(text, fallback="machine"):
    """把任意字符串压成 MACHINE_RE 允许的 slug：[a-z0-9][a-z0-9-]{0,63}。"""
    out = re.sub(r"[^a-z0-9]+", "-", str(text or "").strip().lower()).strip("-")
    out = out[:63].strip("-")
    if not out or not out[0].isalnum():
        out = (fallback + "-" + out).strip("-")[:63]
    return out or fallback


SOURCE_RE = re.compile(r"^[\w\u4e00-\u9fff][\w\u4e00-\u9fff ._:-]{0,63}$")


def is_valid_machine(name):
    """与 Worker 的 MACHINE_RE 对齐：字母（含中文）/数字/空格/_ . -，首字符字母或数字，≤64 字符。"""
    if not 1 <= len(name) <= 64:
        return False
    if not name[0].isalnum():
        return False
    return all(ch.isalnum() or ch in " _.-" for ch in name)


def read_links(paths):
    """读节点链接：每行一条，忽略空行和 # 开头的注释行，保留顺序去重。"""
    links, seen = [], set()
    for path in paths:
        if path == "-":
            text = sys.stdin.read()
        else:
            text = open(path, encoding="utf-8").read()
        for raw in text.replace("\r", "").split("\n"):
            line = raw.strip()
            if not line or line.startswith("#") or "://" not in line:
                continue
            if line in seen:
                continue
            seen.add(line)
            links.append(line)
    if not links:
        sys.exit("没有读到节点链接（每行一条，形如 hysteria2://...）")
    return links


def node_name(link):
    """取链接 # 片段并 URL 解码，没有就空串。"""
    if "#" not in link:
        return ""
    frag = link.split("#", 1)[1]
    return urllib.parse.unquote(frag).strip()


def name_from_links(links):
    """机器名 = 所有节点名的公共前缀（去掉结尾的分隔符）。"""
    names = [node_name(link) for link in links]
    names = [name for name in names if name]
    if not names:
        return ""
    prefix = names[0]
    for name in names[1:]:
        i = 0
        while i < min(len(prefix), len(name)) and prefix[i] == name[i]:
            i += 1
        prefix = prefix[:i]
        if not prefix:
            break
    return prefix.rstrip(" -_.|/")


def curl(args):
    return subprocess.check_output(["curl", "-fsSL", *args])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=os.environ.get("SUB_WORKER_BASE", ""))
    ap.add_argument("--token", default=os.environ.get("SUB_TOKEN", ""))
    ap.add_argument("--file", help="JSON: {machine: subscription_url}")
    ap.add_argument(
        "--links",
        action="append",
        default=[],
        metavar="FILE",
        help="节点链接文件（每行一条，可用 - 读 stdin）；机器名默认取这些节点名的公共前缀",
    )
    ap.add_argument("--machine", action="append", default=[], help="machine=url（可重复）")
    ap.add_argument("--url", help="单机上报：订阅 URL，名字由 --name 或主机名决定")
    ap.add_argument("--name", help="配合 --url 指定机器名（留空则需 --from-hostname）")
    ap.add_argument("--from-hostname", action="store_true", help="机器名取本机主机名并 slug 化")
    ap.add_argument(
        "--source",
        default=os.environ.get("SUB_SOURCE", ""),
        help="上报来源名（同名机器多台写入时用它区分，默认取本机主机名；省略则用 default）",
    )
    ap.add_argument("--dry-run", action="store_true", help="只打印要上报的机器名和 URL，不发请求")
    args = ap.parse_args()

    if not args.base or not args.token:
        sys.exit("需要 --base 和 --token（或 SUB_WORKER_BASE / SUB_TOKEN）")

    machines = {}
    if args.file:
        machines.update(json.load(open(args.file, encoding="utf-8")))
    for item in args.machine:
        if "=" not in item:
            sys.exit(f"--machine 格式应为 machine=url: {item}")
        name, url = item.split("=", 1)
        machines[name] = url

    if args.links:
        links = read_links(args.links)
        name = args.name or name_from_links(links)
        if not name:
            sys.exit("这些节点名没有公共前缀，请用 --name 指定机器名")
        if not is_valid_machine(name):
            sys.exit(f"从节点名推出的机器名不合法，请用 --name 指定：{name}")
        machines[name] = links
        print(f"节点 {len(links)} 条 -> 机器「{name}」")

    if args.url:
        name = args.name or (slugify(socket.gethostname()) if args.from_hostname else "")
        if not name:
            sys.exit("用 --url 时需要 --name，或加 --from-hostname 让名字取自主机名")
        if not is_valid_machine(name):
            sys.exit(f"机器名不合法（字母/中文/数字/空格/_ . -，首字符需字母或数字，≤64）：{name}")
        machines[name] = args.url

    if not machines:
        sys.exit("没有要上报的机器")

    source = (args.source or slugify(socket.gethostname()) or "default").strip()
    if source and not SOURCE_RE.match(source):
        sys.exit(f"来源名不合法（字母/中文/数字/空格/_ . : -，首字符需字母或数字，≤64）：{source}")

    if args.dry_run:
        for name, url in machines.items():
            if isinstance(url, list):
                print(f"{name} (source={source}) <- {len(url)} 条节点链接")
            else:
                print(f"{name} (source={source}) <- {url}")
        print(f"dry-run: {len(machines)} 台，未发请求")
        return

    ok = 0
    for name, url in machines.items():
        if not is_valid_machine(name):
            sys.exit(f"机器名不合法（字母/中文/数字/空格/_ . -，首字符需字母或数字，≤64）：{name}")
        if isinstance(url, list):
            body = base64.b64encode("\n".join(url).encode("utf-8"))
        else:
            body = curl([url]).strip()
        result = json.loads(
            curl(
                [
                    "-X",
                    "POST",
                    "-H",
                    f"Authorization: Bearer {args.token}",
                    "--data-binary",
                    body.decode("ascii"),
                    f"{args.base.rstrip('/')}/api/v1/report/{urllib.parse.quote(name, safe='')}"
                    f"?source={urllib.parse.quote(source, safe='')}",
                ]
            )
        )
        print(
            f"{name}: source={result.get('source')} changed={result.get('changed')} "
            f"nodes={result.get('nodes')} bytes={result.get('bytes')} updated_at={result.get('updated_at')}"
        )
        ok += 1
    print(f"done: {ok}/{len(machines)}")


if __name__ == "__main__":
    main()
