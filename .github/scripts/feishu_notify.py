#!/usr/bin/env python3
"""飞书通知发送脚本 - 通过飞书 Open API 发送 DM 消息"""

import os
import json
import re
import requests
from datetime import datetime, timezone

# 飞书凭证
FEISHU_APP_ID = os.environ.get("FEISHU_APP_ID", "")
FEISHU_APP_SECRET = os.environ.get("FEISHU_APP_SECRET", "")
FEISHU_ADMIN_OPEN_ID = os.environ.get("FEISHU_ADMIN_OPEN_ID", "")

# 事件参数
EVENT = os.environ.get("EVENT", "unknown")
ISSUE_NUMBER = os.environ.get("ISSUE_NUMBER", "")
ISSUE_TITLE = os.environ.get("ISSUE_TITLE", "")
ISSUE_URL = os.environ.get("ISSUE_URL", "")
SUBJECT = os.environ.get("SUBJECT", "Issue Notification")
BODY = os.environ.get("BODY", "")

FEISHU_API = "https://open.feishu.cn/open-apis"
RECEIVE_ID_TYPE = os.environ.get("FEISHU_ID_TYPE", "open_id")

COLORS = {
    "sla.breach": "red", "sla.escalation": "red", "sla.warning": "orange",
    "issue.created": "blue", "issue.closed": "green", "issue.stale": "yellow",
    "report.weekly": "turquoise", "report.monthly": "turquoise",
    "report.sla_daily": "carmine", "report.security": "red", "unknown": "grey",
}

LABELS = {
    "sla.breach": "  SLA 违约", "sla.escalation": "  SLA 升级",
    "sla.warning": "  SLA 预警", "issue.created": "  New Issue",
    "issue.closed": "  Issue Closed", "issue.stale": "  Issue Stale",
    "report.weekly": "  周报", "report.monthly": "  月报",
    "report.sla_daily": "  SLA 日报", "report.security": "  安全扫描", "unknown": "  Issue 通知",
}


def get_tenant_token():
    if not FEISHU_APP_ID or not FEISHU_APP_SECRET:
        print("WARNING: FEISHU_APP_ID/FEISHU_APP_SECRET not set")
        return None
    url = f"{FEISHU_API}/auth/v3/tenant_access_token/internal"
    data = {"app_id": FEISHU_APP_ID, "app_secret": FEISHU_APP_SECRET}
    try:
        resp = requests.post(url, json=data, timeout=15)
        result = resp.json()
        if result.get("code") == 0:
            return result.get("tenant_access_token")
        print(f"Feishu auth failed: code={result.get('code')}, msg={result.get('msg')}")
    except Exception as e:
        print(f"Feishu auth error: {e}")
    return None


def send_dm(open_id, card_content):
    token = get_tenant_token()
    if not token:
        print("Failed to get Feishu token, skipping notification")
        return False

    url = f"{FEISHU_API}/im/v1/messages?receive_id_type={RECEIVE_ID_TYPE}"
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    body = {
        "receive_id": open_id,
        "msg_type": "interactive",
        "content": json.dumps(card_content, ensure_ascii=False),
    }

    try:
        resp = requests.post(url, headers=headers, json=body, timeout=15)
        result = resp.json()
        if result.get("code") == 0:
            return True
        print(f"Feishu send failed: {result.get('msg', 'unknown error')}")
    except Exception as e:
        print(f"Feishu send error: {e}")
    return False


def _split_sections(body):
    """将 Markdown 报告拆分为 section 列表"""
    lines = body.strip().split('\n')
    sections = []
    current = {"heading": "", "lines": []}

    for line in lines:
        if line.startswith('### '):
            if current["lines"]:
                sections.append(current)
            current = {"heading": line[4:].strip(), "lines": []}
        elif line.startswith('## '):
            if current["lines"]:
                sections.append(current)
            current = {"heading": line[3:].strip(), "lines": []}
        elif line.startswith('- '):
            current["lines"].append(line)
        elif line.startswith('|'):
            current["lines"].append(line)
        elif line.strip() == '':
            if current["lines"]:
                sections.append(current)
                current = {"heading": current["heading"], "lines": []}
        else:
            current["lines"].append(line)

    if current["lines"]:
        sections.append(current)

    return sections


def _md_table_to_lark(table_lines):
    """将 Markdown 表格转为飞书 lark_md 格式"""
    result = []
    body_rows = []
    header_row = None

    for line in table_lines:
        line = line.strip().strip('|')
        if re.match(r'^[\-:\s|]+$', line):
            continue
        cells = [c.strip() for c in line.split('|')]
        if header_row is None:
            header_row = cells
        else:
            body_rows.append(cells)

    if not header_row:
        return ""

    result.append("**" + " | ".join(header_row) + "**")
    result.append("-" * (sum(len(c) for c in header_row) + 3 * (len(header_row) - 1)))

    for row in body_rows:
        row_text = " | ".join(row)
        if any(w in row_text for w in ['超时', '违约', '预警', 'SLA', '0']):
            row_text = "**" + row_text.replace("**", "") + "**"
        result.append(row_text)

    return "\n".join(result)


def _build_alert_card(event_type, body, issue_url, issue_number, issue_title):
    """构建告警类卡片（Issue 事件）"""
    color = COLORS.get(event_type, "grey")
    header_title = LABELS.get(event_type, "  Issue 通知")

    elements = [{"tag": "markdown", "content": body}]

    if issue_url:
        elements.append({
            "tag": "action",
            "actions": [{
                "tag": "button",
                "text": {"tag": "plain_text", "content": f"查看 Issue #{issue_number}"},
                "type": "primary",
                "url": issue_url,
            }]
        })

    elements.append({
        "tag": "note",
        "elements": [{"tag": "plain_text", "content": "huaweicloud Issue Bot"}]
    })

    return {
        "config": {"wide_screen_mode": True},
        "header": {"title": {"tag": "plain_text", "content": header_title}, "template": color},
        "elements": elements,
    }


def _build_report_card(event_type, subject, body):
    """构建报表类卡片（带长度保护，避免超出飞书消息限制）"""
    color = COLORS.get(event_type, "turquoise")
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")
    sections = _split_sections(body)

    # 飞书 interactive 卡片 content 大小限制（约 30KB），预留余量
    MAX_CONTENT_CHARS = 25000
    elements = []

    for i, section in enumerate(sections):
        heading = section["heading"]
        lines = section["lines"]

        if not heading or not lines:
            continue

        # section 标题
        heading_el = {"tag": "markdown", "content": f"**▎{heading}**"}
        content_lines = []

        # 检测是否是表格
        if len(lines) >= 2 and lines[0].startswith('|') and lines[1].startswith('|'):
            table_text = _md_table_to_lark(lines)
            if table_text:
                content_lines.append(table_text)
        else:
            content_lines.extend(lines)

        md_content = "\n".join(content_lines)
        content_el = {"tag": "markdown", "content": md_content} if md_content.strip() else None

        # 估算当前累计大小，超限则截断
        pending = [heading_el] + ([content_el] if content_el else [])
        pending_json = json.dumps(pending, ensure_ascii=False)
        if len(json.dumps(elements, ensure_ascii=False)) + len(pending_json) > MAX_CONTENT_CHARS:
            # 内容超限：截断当前 section 内容并加提示
            remain = MAX_CONTENT_CHARS - len(json.dumps(elements, ensure_ascii=False))
            if remain > 200:
                truncated = heading_el
                cut_content = md_content[:max(100, remain - 200)]
                truncated = {
                    "tag": "markdown",
                    "content": f"**▎{heading}**（内容过长，已截断）\n{cut_content}\n…"
                }
                elements.append(truncated)
            elements.append({"tag": "note", "elements": [{"tag": "plain_text", "content": "⚠️ 内容过多已截断，完整内容请查看邮件"}]})
            break

        elements.append(heading_el)
        if content_el:
            elements.append(content_el)

        if i < len(sections) - 1:
            elements.append({"tag": "hr"})

    elements.append({"tag": "hr"})
    elements.append({
        "tag": "note",
        "elements": [
            {"tag": "plain_text", "content": f"生成时间: {now}  ·  huaweicloud Issue Bot"}
        ]
    })

    return {
        "config": {"wide_screen_mode": True},
        "header": {
            "title": {"tag": "plain_text", "content": subject},
            "template": color,
        },
        "elements": elements,
    }


def is_report_event(event_type):
    return event_type and event_type.startswith("report.")


def build_card(event_type, subject, body, issue_url=None, issue_number=None, issue_title=None):
    if is_report_event(event_type):
        return _build_report_card(event_type, subject, body)
    return _build_alert_card(event_type, body, issue_url, issue_number, issue_title)


def send_notification(subject, body, open_ids=None, event_type=None):
    if not open_ids:
        open_ids = []
    if not FEISHU_APP_ID or not FEISHU_APP_SECRET:
        print("WARNING: Feishu credentials not configured, skipping")
        return False

    if not open_ids:
        open_ids = [FEISHU_ADMIN_OPEN_ID] if FEISHU_ADMIN_OPEN_ID else []

    open_ids = [oid.strip() for oid in open_ids if oid.strip()]
    if not open_ids:
        print("No recipients specified, skipping")
        return False

    card = build_card(
        event_type or EVENT, subject, body, ISSUE_URL, ISSUE_NUMBER, ISSUE_TITLE
    )

    success_count = 0
    for open_id in open_ids:
        if send_dm(open_id, card):
            print(f"Feishu notification sent to {open_id}")
            success_count += 1
    return success_count > 0


def main():
    open_ids = [FEISHU_ADMIN_OPEN_ID] if FEISHU_ADMIN_OPEN_ID else []
    send_notification(SUBJECT, BODY, open_ids, EVENT)


if __name__ == "__main__":
    main()
