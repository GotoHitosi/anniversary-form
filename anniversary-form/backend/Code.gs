/**
 * 周年相談フォーム 受付API（Google Apps Script ウェブアプリ）
 *
 * このファイルを Apps Script の Code.gs に丸ごと貼り付けて、ウェブアプリとしてデプロイする。
 * 手順の詳細は backend/DEPLOY.md を参照。
 *
 * やること（すべてサーバー側）
 *   1. リクエスト本文(JSON)の再バリデーション  ← クライアントの検証は信用しない
 *   2. お問い合わせ番号の発番  ANN-YYYYMMDD-NNN（日付ごとに連番リセット。LockService で排他）
 *   3. 受付日時の生成（Asia/Tokyo。ブラウザの時刻は使わない）
 *   4. kitabatake@cosmic4.com 宛てにプレーンテキストメールを送信（Reply-To は入力者のメール）
 *   5. { ok: true, inquiryId } をJSONで返す。失敗時も { ok: false, error } をJSONで返す
 *
 * 認証情報
 *   このスクリプトは「デプロイした人（Googleアカウント）」の権限で MailApp を実行する。
 *   Gmailのパスワード・OAuthトークン・APIキーは、コードにもフロントにも一切書かない。
 *
 * リクエスト形式
 *   フロントは Content-Type: text/plain;charset=utf-8 でJSON文字列をPOSTする
 *   （application/json にするとCORSのプリフライトが必要になり、GASは応答できないため）。
 *   本文は e.postData.contents をそのまま JSON.parse すればよい。
 *
 * 注意：GASはHTTPステータスコードを設定できない。エラーも本文の { ok:false } で返す。
 */

var CONFIG = {
  TO: 'kitabatake@cosmic4.com',
  TIMEZONE: 'Asia/Tokyo',
  SENDER_NAME: '周年相談フォーム',
  ID_PREFIX: 'ANN',
  MAX_BODY_CHARS: 20000,
  LOCK_WAIT_MS: 30000,
  DUPLICATE_WINDOW_SEC: 120   // 同一内容の再送はこの秒数のあいだ、メールを再送せず同じ番号を返す
};

var ITEM_LABELS = {
  'logo': 'ロゴ',
  'poster-flyer': 'ポスター・チラシ',
  'brochure': '会社案内・パンフレット',
  'website': 'Webサイト',
  'recruit-site': '採用サイト',
  'photo': '写真撮影',
  'video': '動画',
  'branding': 'ブランディング',
  'other': 'その他',
  'undecided': '未定'
};

// フロント(form.js)・dev_server.py と同じ判定にそろえること。
// 空白・@・カンマ・セミコロン・<>()" を含むものは受け付けない（Reply-To に複数宛先や表示名が混ざるのを防ぐ）
var EMAIL_RE = /^[^\s@,;<>()"]+@[^\s@,;<>()"]+\.[^\s@,;<>()"]+$/;

/* ================= エントリポイント ================= */

function doPost(e) {
  try {
    var raw = (e && e.postData && e.postData.contents) || '';
    if (raw.length > CONFIG.MAX_BODY_CHARS) return json_({ ok: false, error: 'too_large' });

    var data;
    try { data = JSON.parse(raw); } catch (err) { return json_({ ok: false, error: 'validation' }); }

    return json_(handle_(data, {}));
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: 'server' });
  }
}

/** ブラウザでURLを開いた時の疎通確認用。個人情報は一切返さない */
function doGet() {
  return json_({ ok: true, service: 'anniversary-contact' });
}

/* ================= 本処理 ================= */

/**
 * @param {*} data  JSON.parse 済みのリクエスト本文
 * @param {{to?: string}} opts  to を指定すると宛先を上書き（試験送信用。本番のdoPostでは常に空）
 * @return {Object} { ok:true, inquiryId } または { ok:false, error, fields? }
 */
function handle_(data, opts) {
  var result = validate_(data);
  if (!result.ok) return { ok: false, error: 'validation', fields: result.errors };
  var clean = result.clean;

  // 連続送信対策の差し込み口（未実装）。true を返した場合は受け付けない
  if (isRateLimited_(clean)) return { ok: false, error: 'rate_limited' };

  // 発番・送信・連番の確定までを1つのロックで囲む。
  //   - 同時送信でも番号が重複しない
  //   - メール送信に失敗したら連番を進めない（欠番が出ない）
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(CONFIG.LOCK_WAIT_MS);
  } catch (err) {
    return { ok: false, error: 'busy' };
  }
  try {
    var cache = CacheService.getScriptCache();
    var dupKey = duplicateKey_(clean);
    var already = cache.get(dupKey);
    if (already) return { ok: true, inquiryId: already };   // 二重送信・再送：メールは送らず同じ番号を返す

    var now = new Date();
    var seq = nextSequence_(now);                            // まだ確定しない
    var receivedAt = Utilities.formatDate(now, CONFIG.TIMEZONE, 'yyyy/MM/dd HH:mm');

    MailApp.sendEmail({
      to: (opts && opts.to) || CONFIG.TO,
      subject: buildSubject_(seq.id, clean.company),
      body: buildBody_(clean, seq.id, receivedAt),           // プレーンテキストのみ（HTMLメールにしない）
      replyTo: clean.email,
      name: CONFIG.SENDER_NAME
    });

    // 送信に成功したので連番を確定する
    PropertiesService.getScriptProperties().setProperties({ SEQ_DATE: seq.date, SEQ_N: String(seq.n) });
    cache.put(dupKey, seq.id, CONFIG.DUPLICATE_WINDOW_SEC);
    return { ok: true, inquiryId: seq.id };
  } catch (err) {
    console.error(err);
    return { ok: false, error: 'server' };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 次の番号を計算する（保存はしない）。
 * PropertiesService に「最後に発番した日付 SEQ_DATE」と「その日の連番 SEQ_N」を持つ。
 * 日付(Asia/Tokyo)が変わっていたら連番を1に戻す。1000件を超えたら桁が増える（ANN-20260930-1000）。
 */
function nextSequence_(now) {
  var props = PropertiesService.getScriptProperties();
  var today = Utilities.formatDate(now, CONFIG.TIMEZONE, 'yyyyMMdd');
  var lastDate = props.getProperty('SEQ_DATE');
  var n = (lastDate === today) ? parseInt(props.getProperty('SEQ_N') || '0', 10) : 0;
  n += 1;
  var seq = n < 1000 ? ('00' + n).slice(-3) : String(n);
  return { date: today, n: n, id: CONFIG.ID_PREFIX + '-' + today + '-' + seq };
}

function duplicateKey_(c) {
  var text = JSON.stringify([c.company, c.name, c.email, c.phone, c.items, c.message]);
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return 'dup:' + Utilities.base64EncodeWebSafe(digest);
}

/* ================= 検証 ================= */

function cleanText_(v, max, allowNewline) {
  if (typeof v !== 'string') return '';
  var re = allowNewline ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g;
  return v.replace(re, '').trim().slice(0, max);
}

function normalizePhone_(v) {
  return String(v || '')
    .replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
    .replace(/[‐‑‒–—―−－ー]/g, '-')
    .replace(/（/g, '(').replace(/）/g, ')')
    .replace(/　/g, ' ')
    .trim();
}

function validate_(d) {
  var errors = {};
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, errors: { body: 'invalid' } };

  var company = cleanText_(d.company, 100, false);
  var name = cleanText_(d.name, 100, false);
  var email = cleanText_(d.email, 254, false);
  var phone = normalizePhone_(cleanText_(d.phone, 40, false));
  var message = cleanText_(d.message, 2000, true);
  var source = cleanText_(d.source, 500, false);

  if (!company) errors.company = 'required';
  if (!name) errors.name = 'required';
  if (!email || !EMAIL_RE.test(email)) errors.email = 'invalid';
  // 記号を除いた数字が「0始まりの10〜11桁」。使える記号は - 空白 ( ) のみ
  if (!/^[0-9\-\s()]+$/.test(phone) || !/^0\d{9,10}$/.test(phone.replace(/\D/g, ''))) errors.phone = 'invalid';

  var items = [];
  if (Array.isArray(d.items)) {
    d.items.forEach(function (v) {
      if (typeof v === 'string' && ITEM_LABELS.hasOwnProperty(v) && items.indexOf(v) === -1) items.push(v);
    });
  }
  if (items.length === 0) errors.items = 'required';
  if (items.indexOf('undecided') !== -1 && items.length > 1) items = ['undecided'];   // 未定は排他

  if (Object.keys(errors).length) return { ok: false, errors: errors };
  return {
    ok: true,
    clean: {
      company: company, name: name, email: email, phone: phone,
      items: items, message: message, source: source
    }
  };
}

/** 連続送信対策の差し込み口。将来ここでレート制限やトークン検証を行う */
function isRateLimited_(clean) {
  return false;
}

/* ================= メール ================= */

function buildSubject_(inquiryId, company) {
  // 件名は1行に限定（ヘッダインジェクション対策）
  return ('【周年相談】' + inquiryId + '｜' + company).replace(/[\r\n]+/g, ' ');
}

function buildBody_(c, inquiryId, receivedAt) {
  var itemLines = c.items.map(function (v) { return '・' + ITEM_LABELS[v]; }).join('\n');
  return [
    'お問い合わせ番号：' + inquiryId,
    '受付日時：' + receivedAt,
    '',
    '会社名：' + c.company,
    'お名前：' + c.name,
    '電話番号：' + c.phone,
    'メールアドレス：' + c.email,
    '',
    '作りたいもの：',
    itemLines,
    '',
    'その他ご相談内容：',
    c.message || '（なし）',
    '',
    '流入情報：',
    c.source || '（なし）'
  ].join('\n');
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ================= エディタから実行する補助関数 =================
 * Apps Script のエディタ上部の関数選択で選び、「実行」を押す。
 * ウェブアプリのデプロイ前後どちらでも使える。*/

/**
 * 【試験送信】自分（デプロイした人）のGmail宛てにテストメールを送る。kitabatake@cosmic4.com には送らない。
 * 初回実行時にメール送信の権限承認ダイアログが出る。ここで承認しておくとデプロイが滑らかに進む。
 * 実行後は「表示 → 実行数 / ログ」で結果（{ok:true,inquiryId:...}）を確認する。
 * ※ 連番を1つ消費する。本番運用の前に resetInquiryCounter() で戻すこと。
 */
function testSelf() {
  var me = Session.getEffectiveUser().getEmail();
  var res = handle_({
    company: 'テスト株式会社',
    name: '試験 太郎',
    email: me,
    phone: '090-1234-5678',
    items: ['logo', 'website'],
    message: '【試験送信】Apps Script のエディタから実行しました。\n' + new Date(),
    source: 'test=editor'
  }, { to: me });
  console.log(JSON.stringify(res));
  return res;
}

/** 【連番リセット】テスト後、本番運用の前に一度だけ実行する。以降は次の受付が 001 から始まる */
function resetInquiryCounter() {
  PropertiesService.getScriptProperties().deleteProperty('SEQ_DATE');
  PropertiesService.getScriptProperties().deleteProperty('SEQ_N');
  console.log('連番をリセットしました（重複判定キャッシュは2分で自然に消えます）');
}
