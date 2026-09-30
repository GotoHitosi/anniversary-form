/**
 * 周年相談フォーム 中継API（Netlify Function）
 *
 *   ブラウザ → /.netlify/functions/contact → (この関数) → Google Apps Script /exec → Gmail送信
 *                                          ← JSON ←                          ←
 *
 * なぜ中継するのか
 *   ブラウザから GAS の /exec を直接 fetch すると、GAS のリダイレクト(script.googleusercontent.com)を含めて
 *   CORS で失敗することがある。この関数はブラウザと同一オリジンで動き、GAS へはサーバー間通信で送るので
 *   CORS の問題が起きない。no-cors は使わない（使うと応答＝お問い合わせ番号を読めなくなる）。
 *
 * 環境変数（Netlify の Site configuration → Environment variables で設定。コードには書かない）
 *   GAS_WEBAPP_URL : GAS ウェブアプリの /exec URL  例) https://script.google.com/macros/s/AKfycb.../exec
 *
 * この関数は「薄い中継」。入力の本当の検証・お問い合わせ番号の発番・メール送信は GAS（Code.gs）が行う。
 * ここでは①メソッド・サイズ・JSON形式の確認 ②想定外のキーの除去 ③GAS応答の形の確認だけを行う。
 * 個人情報を含む本文はログに出さない。
 */
'use strict';

const ALLOWED_KEYS = ['company', 'name', 'email', 'phone', 'items', 'itemsUndecided', 'message', 'source'];
const MAX_BODY_CHARS = 20000;
// Netlify の同期Functionは既定で約10秒で打ち切られる。それより先に自分で打ち切り、JSONでエラーを返す。
// （GASが遅れてメールを送った場合でも、同じ内容の再送は GAS 側が2分間は同じ番号を返すので二重メールにならない）
const UPSTREAM_TIMEOUT_MS = 8500;
const INQUIRY_ID_RE = /^ANN-\d{8}-\d{3,}$/;

// GASが返す error → ブラウザへ返すHTTPステータス
const STATUS_BY_ERROR = { validation: 400, too_large: 413, rate_limited: 429, busy: 503 };

function reply(statusCode, obj, extraHeaders) {
  return {
    statusCode: statusCode,
    headers: Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }, extraHeaders || {}),
    body: JSON.stringify(obj)
  };
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return reply(405, { ok: false, error: 'method_not_allowed' }, { Allow: 'POST' });
  }

  const gasUrl = process.env.GAS_WEBAPP_URL;
  if (!gasUrl || !/^https:\/\/script\.google\.com\//.test(gasUrl)) {
    console.error('[contact] 環境変数 GAS_WEBAPP_URL が未設定、または https://script.google.com/ で始まっていません');
    return reply(500, { ok: false, error: 'server' });
  }

  // ---- 受信 ----
  let raw = event.body || '';
  if (event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf8');
  if (raw.length > MAX_BODY_CHARS) return reply(413, { ok: false, error: 'too_large' });

  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { return reply(400, { ok: false, error: 'validation' }); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return reply(400, { ok: false, error: 'validation' });
  }
  // 想定外のキーは GAS へ渡さない
  const payload = {};
  ALLOWED_KEYS.forEach(function (k) { if (k in parsed) payload[k] = parsed[k]; });

  // ---- GAS へ転送（text/plain＝プリフライト不要。GAS は e.postData.contents をそのまま JSON.parse する）----
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, UPSTREAM_TIMEOUT_MS);
  let res, text;
  try {
    // GAS の /exec は 302 でレスポンス用URLへ飛ぶ。redirect:'follow' で最終的なJSONを受け取る。
    res = await fetch(gasUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow',
      signal: ctrl.signal
    });
    text = await res.text();
  } catch (e) {
    const timedOut = e && e.name === 'AbortError';
    console.error('[contact] GAS への転送に失敗:', timedOut ? 'timeout' : (e && e.name));
    return reply(timedOut ? 504 : 502, { ok: false, error: timedOut ? 'timeout' : 'upstream' });
  } finally {
    clearTimeout(timer);
  }

  // ---- GAS の応答を確認してブラウザへ返す ----
  let data;
  try { data = JSON.parse(text); } catch (e) {
    // ログイン画面やエラーHTMLが返ってきた場合（アクセス権が「全員」でない、デプロイ忘れ 等）
    console.error('[contact] GAS の応答がJSONではありません status=' + res.status + ' type=' + res.headers.get('content-type'));
    return reply(502, { ok: false, error: 'upstream' });
  }

  if (data && data.ok === true && typeof data.inquiryId === 'string' && INQUIRY_ID_RE.test(data.inquiryId)) {
    return reply(200, { ok: true, inquiryId: data.inquiryId });
  }

  const error = data && typeof data.error === 'string' ? data.error : 'server';
  const out = { ok: false, error: error };
  if (error === 'validation' && data.fields && typeof data.fields === 'object') out.fields = data.fields;
  return reply(STATUS_BY_ERROR[error] || 502, out);
};
