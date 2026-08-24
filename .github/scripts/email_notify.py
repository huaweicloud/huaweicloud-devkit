#!/usr/bin/env python3
"""邮件发送脚本 - 通过 SMTP 发送报告邮件"""

import os
import sys
import re
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.header import Header
from datetime import datetime, timezone

CSS = """
body { margin:0; padding:0; background:#f6f8fa; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif,'Microsoft YaHei'; }
.container { width:100%; max-width:none; margin:0; background:#fff; }
.header { background:linear-gradient(135deg, #0366d6, #0969da); color:#fff; padding:28px 32px; }
.header h1 { margin:0; font-size:20px; font-weight:600; }
.header .sub { font-size:13px; opacity:.75; margin-top:6px; }
.content { padding:24px 32px; }
.content h2 { font-size:16px; color:#1f2328; border-bottom:2px solid #0366d6; padding-bottom:6px; margin:24px 0 12px; }
.content h2:first-child { margin-top:0; }
.content h3 { font-size:14px; color:#1f2328; margin:16px 0 8px; }
table { width:100%; border-collapse:collapse; margin:8px 0 16px; font-size:13px; table-layout:fixed; }
th { background:#f0f3f6; color:#1f2328; font-weight:600; text-align:left; padding:8px 12px; border:1px solid #d0d7de; }
td { padding:8px 12px; border:1px solid #d0d7de; color:#1f2328; word-wrap:break-word; overflow-wrap:break-word; vertical-align:top; }

/* SLA report tables: fixed column widths to keep header/body aligned */
.sla-table th, .sla-table td { white-space: normal; }
.sla-table th:first-child, .sla-table td:first-child { width: 20%; }
.sla-table th:nth-child(2), .sla-table td:nth-child(2) { width: 8%; }
.sla-table th:nth-child(3), .sla-table td:nth-child(3) { width: 26%; }
.sla-table th:last-child, .sla-table td:last-child { width: 20%; }

tr:nth-child(even) td { background:#f8fafc; }
p { margin:6px 0; line-height:1.6; color:#1f2328; font-size:13px; }
.footer { background:#f0f3f6; color:#656d76; text-align:center; padding:16px; font-size:11px; border-top:1px solid #d0d7de; }
.warn { color:#cf222e; font-weight:600; }
"""


def md_to_html(markdown):
    """将 Markdown 风格的报告转换为 HTML"""
    markdown = re.sub(r'\*\*(.*?)\*\*', r'<strong>\1</strong>', markdown)

    lines = markdown.split('\n')
    html_lines = []
    in_table = False
    in_thead = False
    table_rows = []

    i = 0
    while i < len(lines):
        line = lines[i]

        if line.startswith('## '):
            if in_table:
                html_lines.append(build_table(table_rows))
                table_rows = []
                in_table = False
            html_lines.append(f'<h2>{line[3:].strip()}</h2>')
            i += 1

        elif line.startswith('### '):
            if in_table:
                html_lines.append(build_table(table_rows))
                table_rows = []
                in_table = False
            html_lines.append(f'<h3>{line[4:].strip()}</h3>')
            i += 1

        elif line.startswith('|') and line.rstrip().endswith('|'):
            if not in_table:
                in_table = True
                in_thead = True
                table_rows = []
            table_rows.append(line.strip())
            # 跳过分隔行
            if in_thead and i + 1 < len(lines) and re.match(r'^\|[\s\-:|]+\|$', lines[i + 1].strip()):
                i += 1
            i += 1

        elif line.strip() == '':
            if in_table:
                html_lines.append(build_table(table_rows))
                table_rows = []
                in_table = False
            i += 1

        elif line.startswith('- '):
            if in_table:
                html_lines.append(build_table(table_rows))
                table_rows = []
                in_table = False
            text = line[2:].strip()
            css = ' class="warn"' if any(w in text for w in [': 0', '超时', '违约', '预警']) else ''
            html_lines.append(f'<p{css}>{text}</p>')
            i += 1

        else:
            if in_table:
                html_lines.append(build_table(table_rows))
                table_rows = []
                in_table = False
            if line.strip():
                html_lines.append(f'<p>{line.strip()}</p>')
            i += 1

    if in_table and table_rows:
        html_lines.append(build_table(table_rows))

    return '\n'.join(html_lines)


def build_table(rows):
    if not rows:
        return ''
    html = ['<table class="sla-table">']
    header_done = False
    for row in rows:
        row = row.strip().strip('|')
        cells = [c.strip() for c in row.split('|')]
        if not header_done:
            html.append('<thead><tr>')
            for cell in cells:
                html.append(f'<th>{cell}</th>')
            html.append('</tr></thead><tbody>')
            header_done = True
        else:
            html.append('<tr>')
            for cell in cells:
                css = ' class="warn"' if any(w in cell for w in ['超时', '违约', '0', '预警']) else ''
                html.append(f'<td{css}>{cell}</td>')
            html.append('</tr>')
    html.append('</tbody></table>')
    return '\n'.join(html)


def send_email(subject, body, to_emails=None, is_html=False):
    smtp_host = os.environ.get("SMTP_HOST", "smtp.qq.com")
    smtp_port = int(os.environ.get("SMTP_PORT", "587"))
    smtp_user = os.environ.get("SMTP_USER", "")
    smtp_pass = os.environ.get("SMTP_PASS", "")

    if not smtp_user or not smtp_pass:
        print("WARNING: SMTP credentials not configured, skipping email")
        return False

    if not to_emails:
        to_emails = [s.strip() for s in os.environ.get("EMAIL_REPORT_TO", "").split(",") if s.strip()]

    if not to_emails:
        print("No recipients, skipping email")
        return False

    msg = MIMEMultipart("alternative")
    msg["From"] = smtp_user
    msg["To"] = ", ".join(to_emails)
    msg["Subject"] = Header(subject, "utf-8")
    msg["Date"] = datetime.now(timezone.utc).strftime("%a, %d %b %Y %H:%M:%S +0000")

    if is_html:
        html_content = body
    else:
        html_content = build_email_html(subject, body)

    msg.attach(MIMEText(html_content, "html", "utf-8"))

    try:
        server = smtplib.SMTP(smtp_host, smtp_port, timeout=30)
        server.starttls()
        server.login(smtp_user, smtp_pass)
        server.sendmail(smtp_user, to_emails, msg.as_string())
        server.quit()
        for addr in to_emails:
            print(f"Email sent to {addr}")
        return True
    except Exception as e:
        print(f"Failed to send email: {e}")
        return False


def build_email_html(subject, body):
    content_html = md_to_html(body)
    now = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')

    return f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>{CSS}</style></head>
<body>
<div class="container">
    <div class="header">
        <h1>{subject}</h1>
        <div class="sub">生成时间: {now}</div>
    </div>
    <div class="content">
        {content_html}
    </div>
    <div class="footer">
        huaweicloud Issue Bot · 此报告由自动化系统生成<br>
        请联系管理员：刘菲（liufei268@huawei.com）；张爽（zhangshuang77@h-partners.com）
    </div>
</div>
</body>
</html>"""


def main():
    subject = os.environ.get("SUBJECT", "Issue Report")
    body = os.environ.get("BODY", "")

    if not body:
        print("No body content, skipping")
        return

    to = os.environ.get("EMAIL_TO", "")
    to_list = [t.strip() for t in to.split(",") if t.strip()] if to else None
    is_html = os.environ.get("EMAIL_HTML", "0") == "1"

    send_email(subject, body, to_list, is_html)


if __name__ == "__main__":
    main()
