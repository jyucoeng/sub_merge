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


def is_valid_machine(name):
    """与 Worker 的 MACHINE_RE 对齐：字母（含中文）/数字/空格/_ . -，首字符字母或数字，≤64 字符。"""
    if not 1 <= len(name) <= 64:
        return False
    if not name[0].isalnum():
        return False
    return all(ch.isalnum() or ch in " _.-" for ch in name)


def curl(args):
    return subprocess.check_output(["curl", "-fsSL", *args])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=os.environ.get("SUB_WORKER_BASE", ""))
    ap.add_argument("--token", default=os.environ.get("SUB_TOKEN", ""))
    ap.add_argument("--file", help="JSON: {machine: subscription_url}")
    ap.add_argument("--machine", action="append", default=[], help="machine=url（可重复）")
    ap.add_argument("--url", help="单机上报：订阅 URL，名字由 --name 或主机名决定")
    ap.add_argument("--name", help="配合 --url 指定机器名（留空则需 --from-hostname）")
    ap.add_argument("--from-hostname", action="store_true", help="机器名取本机主机名并 slug 化")
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

    if args.url:
        name = args.name or (slugify(socket.gethostname()) if args.from_hostname else "")
        if not name:
            sys.exit("用 --url 时需要 --name，或加 --from-hostname 让名字取自主机名")
        if not is_valid_machine(name):
            sys.exit(f"机器名不合法（字母/中文/数字/空格/_ . -，首字符需字母或数字，≤64）：{name}")
        machines[name] = args.url

    if not machines:
        sys.exit("没有要上报的机器")

    if args.dry_run:
        for name, url in machines.items():
            print(f"{name} <- {url}")
        print(f"dry-run: {len(machines)} 台，未发请求")
        return

    ok = 0
    for name, url in machines.items():
        if not is_valid_machine(name):
            sys.exit(f"机器名不合法（字母/中文/数字/空格/_ . -，首字符需字母或数字，≤64）：{name}")
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
                    f"{args.base.rstrip('/')}/api/v1/report/{urllib.parse.quote(name, safe='')}",
                ]
            )
        )
        print(f"{name}: changed={result.get('changed')} bytes={result.get('bytes')} updated_at={result.get('updated_at')}")
        ok += 1
    print(f"done: {ok}/{len(machines)}")


if __name__ == "__main__":
    main()
