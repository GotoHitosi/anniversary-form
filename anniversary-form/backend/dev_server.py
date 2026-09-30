#!/usr/bin/env python3
"""
周年相談フォーム 開発用サーバー（標準ライブラリのみ）

Code.gs と同じ処理をローカルで再現して、フォームを端末内で通し確認するためのもの。
  - GET  /            : anniversary-form/ の静的ファイルを配信
  - POST /api/contact : 再検証 → お問い合わせ番号の発番 → 受付日時(JST) → メール本文を生成

【重要】メールは実際には送信しない。backend/outbox/ANN-YYYYMMDD-NNN.txt に「送るはずだった内容」を保存する。
本番のメール送信は Code.gs（Gmail/MailApp）か、SMTP等を使う自前サーバーで行うこと。
認証情報はこのファイルにも書かない（環境変数などサーバー側の秘匿領域で管理する）。

使い方:
  python backend/dev_server.py [ポート番号(既定 8780)]
  → http://localhost:8780/index.html
"""
import json
import re
import sys
import threading
from datetime import datetime, timedelta, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent                      # anniversary-form/
OUTBOX = HERE / "outbox"
SEQ_FILE = OUTBOX / ".seq.json"

TO_ADDR = "kitabatake@cosmic4.com"
JST = timezone(timedelta(hours=9))      # Asia/Tokyo（日本は夏時間なし。tzdata不要にするため固定オフセット）
MAX_BODY_BYTES = 20000

ITEM_LABELS = {
    "logo": "ロゴ",
    "poster-flyer": "ポスター・チラシ",
    "brochure": "会社案内・パンフレット",
    "website": "Webサイト",
    "recruit-site": "採用サイト",
    "photo": "写真撮影",
    "video": "動画",
    "branding": "ブランディング",
    "other": "その他",
    "undecided": "未定",
}
EMAIL_RE = re.compile(r'^[^\s@,;<>()"]+@[^\s@,;<>()"]+\.[^\s@,;<>()"]+$')
_seq_lock = threading.Lock()            # 単一プロセス内の同時送信で番号が重複しないように


# ---------------- 検証 ----------------
def clean_text(v, max_len, allow_newline=False):
    if not isinstance(v, str):
        return ""
    pattern = r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]" if allow_newline else r"[\x00-\x1f\x7f]"
    return re.sub(pattern, "", v).strip()[:max_len]


def normalize_phone(v):
    v = str(v or "")
    v = "".join(chr(ord(c) - 0xFEE0) if "０" <= c <= "９" else c for c in v)
    v = re.sub(r"[‐‑‒–—―−－ー]", "-", v).replace("（", "(").replace("）", ")").replace("　", " ")
    return v.strip()


def validate(d):
    """(clean, errors) を返す。クライアントの検証は信用せず、ここで必ずやり直す。"""
    errors = {}
    if not isinstance(d, dict):
        return None, {"body": "invalid"}

    company = clean_text(d.get("company"), 100)
    name = clean_text(d.get("name"), 100)
    email = clean_text(d.get("email"), 254)
    phone = normalize_phone(clean_text(d.get("phone"), 40))
    message = clean_text(d.get("message"), 2000, allow_newline=True)
    source = clean_text(d.get("source"), 500)

    if not company:
        errors["company"] = "required"
    if not name:
        errors["name"] = "required"
    if not email or not EMAIL_RE.match(email):
        errors["email"] = "invalid"
    if not re.fullmatch(r"[0-9\-\s()]+", phone) or not re.fullmatch(r"0\d{9,10}", re.sub(r"\D", "", phone)):
        errors["phone"] = "invalid"

    items = []
    raw_items = d.get("items")
    if isinstance(raw_items, list):
        for v in raw_items:
            if isinstance(v, str) and v in ITEM_LABELS and v not in items:
                items.append(v)
    if not items:
        errors["items"] = "required"
    if "undecided" in items and len(items) > 1:
        items = ["undecided"]           # 未定は排他

    if errors:
        return None, errors
    return {"company": company, "name": name, "email": email, "phone": phone,
            "items": items, "message": message, "source": source}, {}


# ---------------- 発番 ----------------
def issue_inquiry_id(now):
    """ANN-YYYYMMDD-NNN。日付が変われば連番を1に戻す。"""
    OUTBOX.mkdir(exist_ok=True)
    today = now.strftime("%Y%m%d")
    with _seq_lock:
        state = {"date": "", "n": 0}
        if SEQ_FILE.exists():
            try:
                state = json.loads(SEQ_FILE.read_text(encoding="utf-8"))
            except (ValueError, OSError):
                pass
        n = state["n"] + 1 if state.get("date") == today else 1
        SEQ_FILE.write_text(json.dumps({"date": today, "n": n}), encoding="utf-8")
    return "ANN-%s-%03d" % (today, n)


# ---------------- メール ----------------
def build_subject(inquiry_id, company):
    return re.sub(r"[\r\n]+", " ", "【周年相談】%s｜%s" % (inquiry_id, company))


def build_body(c, inquiry_id, received_at):
    item_lines = "\n".join("・" + ITEM_LABELS[v] for v in c["items"])
    return "\n".join([
        "お問い合わせ番号：" + inquiry_id,
        "受付日時：" + received_at,
        "",
        "会社名：" + c["company"],
        "お名前：" + c["name"],
        "電話番号：" + c["phone"],
        "メールアドレス：" + c["email"],
        "",
        "作りたいもの：",
        item_lines,
        "",
        "その他ご相談内容：",
        c["message"] or "（なし）",
        "",
        "流入情報：",
        c["source"] or "（なし）",
    ])


def is_rate_limited(client_ip, clean):
    """連続送信対策の差し込み口（未実装）。True を返すと受け付けない。"""
    return False


# ---------------- HTTP ----------------
class Handler(SimpleHTTPRequestHandler):
    def _json(self, status, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_head(self):
        # backend/（outbox の受信内容・ソース）は静的配信しない
        if self.path.split("?")[0].startswith("/backend"):
            self.send_error(404)
            return None
        return super().send_head()

    def do_POST(self):
        # /.netlify/functions/contact は本番(Netlify Function)と同じパス。ローカルでは form.js を変えずに通せる
        if self.path.split("?")[0] not in ("/api/contact", "/.netlify/functions/contact"):
            return self._json(404, {"ok": False, "error": "not_found"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY_BYTES:
            return self._json(413 if length > MAX_BODY_BYTES else 400, {"ok": False, "error": "validation"})
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return self._json(400, {"ok": False, "error": "validation"})

        clean, errors = validate(data)
        if errors:
            return self._json(400, {"ok": False, "error": "validation", "fields": errors})
        if is_rate_limited(self.client_address[0], clean):
            return self._json(429, {"ok": False, "error": "rate_limited"})

        now = datetime.now(JST)                              # サーバー時刻。ブラウザの時刻は使わない
        inquiry_id = issue_inquiry_id(now)
        received_at = now.strftime("%Y/%m/%d %H:%M")
        subject = build_subject(inquiry_id, clean["company"])
        body = build_body(clean, inquiry_id, received_at)

        OUTBOX.mkdir(exist_ok=True)
        (OUTBOX / (inquiry_id + ".txt")).write_text(
            "To: %s\nReply-To: %s\nSubject: %s\n\n%s\n" % (TO_ADDR, clean["email"], subject, body),
            encoding="utf-8")
        return self._json(200, {"ok": True, "inquiryId": inquiry_id})

    def log_message(self, fmt, *args):     # 個人情報が入り得る本文はログに出さない（パスのみ）
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8780
    server = ThreadingHTTPServer(("127.0.0.1", port), partial(Handler, directory=str(ROOT)))
    print("http://localhost:%d/index.html  (メールは送信せず %s に保存)" % (port, OUTBOX))
    server.serve_forever()
