#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""huaweicloud-devkit 每日运营日报（飞书）

指标：npm 下载量（当日/近7日）、GitHub stars（当前/近7日新增）、
      Issue 处理（今日新增/今日闭环）。
"""
import json
import os
import re
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone, timedelta

REPO = os.environ.get("REPO", "huaweicloud/huaweicloud-devkit")
NPM_PKG = os.environ.get("NPM_PACKAGE", "huaweicloud-devkit")
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")
GITHUB_API = "https://api.github.com"
FEISHU_WEBHOOK = os.environ.get("FEISHU_WEBHOOK", "")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from feishu_notify import send_notification


def send_feishu_webhook(subject, body):
    """通过飞书群机器人 Webhook 发送卡片到群"""
    if not FEISHU_WEBHOOK:
        print("FEISHU_WEBHOOK not set, skip webhook", file=sys.stderr)
        return False
    card = {
        "config": {"wide_screen_mode": True},
        "header": {
            "title": {"tag": "plain_text", "content": subject},
            "template": "blue",
        },
        "elements": [
            {"tag": "markdown", "content": body},
        ],
    }
    payload = {"msg_type": "interactive", "card": card}
    try:
        req = urllib.request.Request(
            FEISHU_WEBHOOK,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            result = json.loads(resp.read())
            ok = result.get("code") == 0 or result.get("StatusCode") == 0
            if ok:
                print("Feishu webhook sent successfully")
                return True
            print(f"Feishu webhook failed: {result}", file=sys.stderr)
            return False
    except Exception as e:
        print(f"Feishu webhook error: {e}", file=sys.stderr)
        return False


def gh_get(path, accept=None):
    headers = {"Accept": accept or "application/vnd.github+json"}
    if GITHUB_TOKEN:
        headers["Authorization"] = f"Bearer {GITHUB_TOKEN}"
    req = urllib.request.Request(GITHUB_API + path, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print(f"GH API {path}: {e.code}", file=sys.stderr)
        return None


def get_npm_downloads():
    """npm 下载量：最新完整日 + 近7日

    npm 统计数据有 ~1 天延迟，当日查询永远返回 0。
    改用 range/last-week 获取逐日数据，取最后一天为最新完整日下载量。
    """
    url = f"https://api.npmjs.org/downloads/range/last-week/{NPM_PKG}"
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
            daily = data.get("downloads", [])
            if not daily:
                return 0, 0
            latest_day_dl = daily[-1].get("downloads", 0)
            week_dl = sum(d.get("downloads", 0) for d in daily)
            return latest_day_dl, week_dl
    except Exception as e:
        print(f"npm range error: {e}", file=sys.stderr)
        return 0, 0


def get_npm_total_downloads():
    """npm 累计下载量（自 2015-01-10 起全时段）"""
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    url = f"https://api.npmjs.org/downloads/point/2015-01-10:{today}/{NPM_PKG}"
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read()).get("downloads", 0)
    except Exception:
        return 0


def get_stars():
    """GitHub stars：当前总数 + 近7日新增（用 starred_at 时间戳）"""
    repo = gh_get(f"/repos/{REPO}")
    if not repo:
        return 0, 0
    total = repo.get("stargazers_count", 0)
    since = datetime.now(timezone.utc) - timedelta(days=7)
    stars7 = 0
    page = 1
    while page <= 10:
        data = gh_get(f"/repos/{REPO}/stargazers?per_page=100&page={page}",
                      accept="application/vnd.github.star+json")
        if not isinstance(data, list) or not data:
            break
        for item in data:
            starred = item.get("starred_at", "")
            if starred:
                try:
                    t = datetime.fromisoformat(starred.replace("Z", "+00:00"))
                    if t >= since:
                        stars7 += 1
                except ValueError:
                    pass
        if len(data) < 100:
            break
        page += 1
    return total, stars7


def get_forks():
    """Forks：当前总数 + 近7日新增（用 /forks 的 created_at）"""
    repo = gh_get(f"/repos/{REPO}")
    if not repo:
        return 0, 0
    total = repo.get("forks_count", 0)
    since = datetime.now(timezone.utc) - timedelta(days=7)
    forks7 = 0
    page = 1
    while page <= 10:
        data = gh_get(f"/repos/{REPO}/forks?per_page=100&page={page}&sort=newest")
        if not isinstance(data, list) or not data:
            break
        for item in data:
            created = item.get("created_at", "")
            if created:
                try:
                    t = datetime.fromisoformat(created.replace("Z", "+00:00"))
                    if t >= since:
                        forks7 += 1
                except ValueError:
                    pass
        if len(data) < 100:
            break
        page += 1
    return total, forks7


def get_watchers():
    """Watchers：关注/订阅数"""
    repo = gh_get(f"/repos/{REPO}")
    if not repo:
        return 0
    return repo.get("subscribers_count", 0)


def get_dependents():
    """依赖此仓库的外部仓库数（GitHub network/dependents 页面解析）。

    GitHub 无 dependents 公开 API，只能解析网页。
    返回值为外部依赖仓库数量（不含自身）。抓取失败返回 None。
    """
    owner, name = REPO.split("/", 1)
    url = f"https://github.com/{owner}/{name}/network/dependents"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            html = resp.read().decode("utf-8", errors="ignore")
        # 页面中所有仓库链接，排除自身及非仓库路径
        links = re.findall(r'href="/([^/"]+)/([^/"]+)"', html)
        self_repo = f"{owner}/{name}"
        external = set()
        for o, r in links:
            full = f"{o}/{r}"
            if full == self_repo:
                continue
            if o and r and o not in (
                "login", "account", "settings", "assets", "features", "enterprise",
                "pricing", "topics", "collections", "trending", "sponsors", "marketplace",
                "explore", "events", "notifications", "new", "orgs", "search", "apps",
                "site", "security", "readme", "copilot", "mobile", "team", "about",
                "resources", "campaigns", "industries", "sponsor", "app", "settings",
            ):
                external.add(full)
        # 排除页面导航里的无关仓库路径（network 相关）
        external = {x for x in external if "/" in x and x != self_repo}
        return len(external)
    except Exception as e:
        print(f"dependents fetch error: {e}", file=sys.stderr)
        return None


def get_open_prs():
    """打开 PR 数（分页拉全）"""
    total = 0
    page = 1
    while page <= 10:
        data = gh_get(f"/repos/{REPO}/pulls?state=open&per_page=100&page={page}")
        if not isinstance(data, list) or not data:
            break
        total += len(data)
        if len(data) < 100:
            break
        page += 1
    return total


def get_open_issues():
    """打开 Issue 数（排除 PR，分页拉全）"""
    total = 0
    page = 1
    while page <= 10:
        data = gh_get(f"/repos/{REPO}/issues?state=open&per_page=100&page={page}")
        if not isinstance(data, list) or not data:
            break
        total += len([i for i in data if "pull_request" not in i])
        if len(data) < 100:
            break
        page += 1
    return total


def get_total_issues_prs():
    """累计 Issue 数 / 累计 PR 数（全状态）"""
    total_issues = 0
    total_prs = 0
    data = gh_get("/search/issues?q=repo:%s+is:issue&per_page=1" % REPO)
    if data and isinstance(data, dict):
        total_issues = data.get("total_count", 0)
    data2 = gh_get("/search/issues?q=repo:%s+is:pr&per_page=1" % REPO)
    if data2 and isinstance(data2, dict):
        total_prs = data2.get("total_count", 0)
    return total_issues, total_prs


def get_commits_count():
    """累计 commits 数（per_page=1 的 Link last 分页号）"""
    headers = {"Accept": "application/vnd.github+json"}
    if GITHUB_TOKEN:
        headers["Authorization"] = f"Bearer {GITHUB_TOKEN}"
    req = urllib.request.Request(
        GITHUB_API + f"/repos/{REPO}/commits?per_page=1", headers=headers
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            link = resp.headers.get("Link", "")
            m = re.search(r'[?&]page=(\d+)>;\s*rel="last"', link)
            if m:
                return int(m.group(1))
    except urllib.error.HTTPError as e:
        print(f"GH API commits: {e.code}", file=sys.stderr)
    except Exception as e:
        print(f"commits fetch error: {e}", file=sys.stderr)
    return None


def get_releases_count():
    """累计 releases 数（per_page=1 的 Link last 分页号）"""
    headers = {"Accept": "application/vnd.github+json"}
    if GITHUB_TOKEN:
        headers["Authorization"] = f"Bearer {GITHUB_TOKEN}"
    req = urllib.request.Request(
        GITHUB_API + f"/repos/{REPO}/releases?per_page=1", headers=headers
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            link = resp.headers.get("Link", "")
            m = re.search(r'[?&]page=(\d+)>;\s*rel="last"', link)
            if m:
                return int(m.group(1))
    except urllib.error.HTTPError as e:
        print(f"GH API releases: {e.code}", file=sys.stderr)
    except Exception as e:
        print(f"releases fetch error: {e}", file=sys.stderr)
    return None


def get_issues_week():
    """Issue 近7日新增、近7日闭环"""
    since = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%d")
    opened = 0
    closed = 0
    data = gh_get(f"/search/issues?q=repo:{REPO}+is:issue+created:>{since}&per_page=1")
    if data and isinstance(data, dict):
        opened = data.get("total_count", 0)
    data2 = gh_get(f"/search/issues?q=repo:{REPO}+is:issue+closed:>{since}&per_page=1")
    if data2 and isinstance(data2, dict):
        closed = data2.get("total_count", 0)
    return opened, closed


def get_issues_today():
    """Issue：今日新增、今日闭环"""
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    since = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
    opened_today = 0
    closed_today = 0
    for state in ("open", "closed", "all"):
        pass
    # 新增：今日创建
    data = gh_get(f"/search/issues?q=repo:{REPO}+is:issue+created:{today}&per_page=100")
    if data and isinstance(data, dict):
        opened_today = data.get("total_count", 0)
    # 闭环：今日关闭
    data2 = gh_get(f"/search/issues?q=repo:{REPO}+is:issue+closed:{today}&per_page=100")
    if data2 and isinstance(data2, dict):
        closed_today = data2.get("total_count", 0)
    return opened_today, closed_today


def build_report():
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    today_dl, week_dl = get_npm_downloads()
    total_dl = get_npm_total_downloads()
    stars, stars7 = get_stars()
    forks, forks7 = get_forks()
    watchers = get_watchers()
    dependents = get_dependents()
    open_prs = get_open_prs()
    open_issues = get_open_issues()
    total_issues, total_prs = get_total_issues_prs()
    total_commits = get_commits_count()
    total_releases = get_releases_count()
    opened, closed = get_issues_today()
    opened_w, closed_w = get_issues_week()

    dep_text = f"- Dependents（被依赖仓库数）：**{dependents}**" if dependents is not None else "- Dependents：N/A"
    commits_text = f"- 累计 commits：**{total_commits}**" if total_commits is not None else "- 累计 commits：N/A"
    releases_text = f"- 累计 releases：**{total_releases}**" if total_releases is not None else "- 累计 releases：N/A"

    lines = [
        f"# huaweicloud-devkit 运营日报（{today}）",
        "",
        "### 下载量（npm）",
        f"- 最新完整日下载：**{today_dl}**（npm 口径，含 CI/镜像拉取，数据有 ~1 天延迟）",
        f"- 近 7 日下载：**{week_dl}**",
        f"- 累计下载：**{total_dl}**",
        "",
        "### 社区活跃（GitHub）",
        f"- 当前 stars：**{stars}**（近7日 +{stars7}）",
        f"- 当前 forks：**{forks}**（近7日 +{forks7}）",
        f"- Watchers：**{watchers}**",
        dep_text,
        commits_text,
        releases_text,
        "",
        "### 待处理事项",
        f"- 打开 PR：**{open_prs}**",
        f"- 打开 Issue：**{open_issues}**",
        "",
        "### Issue 处理",
        f"- 今日新增：**{opened}** / 今日闭环：**{closed}**",
        f"- 近 7 日新增：**{opened_w}** / 近 7 日闭环：**{closed_w}**",
        f"- 累计 Issue：**{total_issues}** / 累计 PR：**{total_prs}**",
        "",
    ]
    return "\n".join(lines), today_dl, week_dl, stars, stars7, forks, forks7, watchers, dependents, open_prs, open_issues, opened, closed


def main():
    report, *_ = build_report()
    subject = f"📊 huaweicloud-devkit 运营日报"
    ok = False
    if FEISHU_WEBHOOK:
        ok = send_feishu_webhook(subject, report)
    if not ok:
        ok = send_notification(subject, report, event_type="report.daily")
    print("Feishu report sent:", ok)
    print(report)


if __name__ == "__main__":
    main()
