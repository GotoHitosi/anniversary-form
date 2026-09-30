/* 周年相談フォーム：最小限の挙動（依存なし）
   - 赤エラーは「入力内容を確認する」押下時にだけ出す。blur では妥当なら緑、不正なら通常のまま
   - エラーが出た項目だけ、修正中にリアルタイム再判定（正しくなった瞬間に赤→緑）
   - 制作物の「未定」は他の制作物と排他
   - 入力 → 確認 → 完了の3ステップ。「入力内容を確認する」ではAPI送信しない。
     実APIを呼ぶのは確認画面の「この内容で送信する」だけ。失敗時は確認画面のまま再送信できる
   - Enterでは進まない（IME確定の誤送信防止）。操作はボタンのクリック/Enter/Spaceのみ
   - 二重送信防止、送信中表示、完了表示（サーバーが発番したお問い合わせ番号を表示）
   - メール送信はサーバー側の仕事。ここには認証情報を一切置かない（backend/ 参照） */
(function () {
  'use strict';

  /* ---------- 送信先API（ここだけ書き換えれば送信先が切り替わる） ----------
     ブラウザ → Netlify Function(同一オリジン) → Google Apps Script → Gmail の順で中継する。
     ブラウザからGASを直接呼ぶとCORSで失敗するため、GASのURLはここには書かない
     （サーバー側の環境変数 GAS_WEBAPP_URL に置く。netlify/functions/contact.js を参照）。
     url         : 同一オリジンの中継API
     contentType : 中継APIは同一オリジンなのでプリフライト問題はなく、application/json でよい */
  var API = {
    url: '/.netlify/functions/contact',
    contentType: 'application/json',
    timeoutMs: 20000
  };

  var form = document.getElementById('ann-form');
  if (!form) return;

  // 3ステップ：入力(form) → 確認(confirmBox) → 完了(doneBox)
  var confirmBox = document.getElementById('ann-confirm');
  var confirmList = document.getElementById('ann-confirm-list');
  var backBtn = document.getElementById('ann-back');
  var sendBtn = document.getElementById('ann-send');
  var sendLabel = sendBtn.querySelector('.ann-button__label');
  var alertBox = document.getElementById('ann-alert');      // 送信失敗の赤帯（確認画面内）
  var statusBox = document.getElementById('ann-status');
  var doneBox = document.getElementById('ann-done');
  var pendingPayload = null;                                 // 確認画面に表示中の送信内容
  var submitting = false;

  var ITEM_LABELS = {
    logo: 'ロゴ', 'poster-flyer': 'ポスター・チラシ', brochure: '会社案内・パンフレット',
    website: 'Webサイト', 'recruit-site': '採用サイト', photo: '写真撮影', video: '動画',
    branding: 'ブランディング', other: 'その他', undecided: '未定'
  };

  /* ---------- 正規化・判定 ---------- */
  // Code.gs / dev_server.py と同じ判定にそろえること
  var EMAIL_RE = /^[^\s@,;<>()"]+@[^\s@,;<>()"]+\.[^\s@,;<>()"]+$/;

  // 電話番号：全角数字・全角ハイフン類・全角括弧/空白を半角へ（表示用に残す文字は数字 - 空白 括弧のみ許可）
  function normalizePhone(raw) {
    return (raw || '')
      .replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
      .replace(/[‐‑‒–—―−－ー]/g, '-')
      .replace(/（/g, '(').replace(/）/g, ')')
      .replace(/　/g, ' ')
      .trim();
  }

  // 記号を除去した数字列が、0始まりの10〜11桁なら有効（03-1234-5678 / 090-1234-5678 / 0312345678 / 09012345678）
  function isValidPhone(raw) {
    var s = normalizePhone(raw);
    if (!/^[0-9\-\s()]+$/.test(s)) return false;
    return /^0\d{9,10}$/.test(s.replace(/\D/g, ''));
  }

  var fields = {
    company: {
      el: document.getElementById('ann-company'),
      err: document.getElementById('ann-company-err'),
      check: function (v) { return v.trim() ? '' : '会社名をご入力ください'; }
    },
    name: {
      el: document.getElementById('ann-name'),
      err: document.getElementById('ann-name-err'),
      check: function (v) { return v.trim() ? '' : 'お名前をご入力ください'; }
    },
    email: {
      el: document.getElementById('ann-email'),
      err: document.getElementById('ann-email-err'),
      check: function (v) {
        v = v.trim();
        if (!v) return 'メールアドレスをご入力ください';
        return EMAIL_RE.test(v) ? '' : 'メールアドレスの形式をご確認ください（例：name@example.co.jp）';
      }
    },
    phone: {
      el: document.getElementById('ann-phone'),
      err: document.getElementById('ann-phone-err'),
      normalize: normalizePhone,   // blur時に半角へそろえる（IME変換中の書き換えを避けるため入力中はしない）
      check: function (v) {
        if (!v.trim()) return '電話番号をご入力ください';
        return isValidPhone(v) ? '' : '電話番号の形式をご確認ください（例：03-1234-5678 / 090-1234-5678）';
      }
    }
  };

  var itemsGroup = {
    el: document.getElementById('ann-items-group'),
    err: document.getElementById('ann-items-err'),
    inputs: function () { return form.querySelectorAll('input[name="items"]'); },
    message: 'ひとつ以上お選びください（決まっていなければ「未定」で大丈夫です）'
  };

  function groupValid(g) {
    return Array.prototype.some.call(g.inputs(), function (i) { return i.checked; });
  }

  /* ---------- エラー/有効の表示 ---------- */
  function setFieldError(f, msg) {
    if (msg) {
      f.err.textContent = msg;
      f.err.hidden = false;
      f.el.setAttribute('aria-invalid', 'true');
    } else {
      f.err.hidden = true;
      f.err.textContent = '';
      f.el.removeAttribute('aria-invalid');
    }
  }

  function setGroupError(g, show) {
    g.err.textContent = show ? g.message : '';
    g.err.hidden = !show;
    if (show) g.el.setAttribute('data-invalid', 'true');
    else g.el.removeAttribute('data-invalid');
    return !show;
  }

  // 有効(緑)表示：会社名・氏名は入力あり、メール・電話は形式OKの時のみ。
  // blur 時に点灯し、編集を始めたら消す（入力中の点滅防止）
  function setValid(el, on) {
    if (on) el.setAttribute('data-valid', 'true');
    else el.removeAttribute('data-valid');
  }

  // show=true の時だけ赤エラーを出す。送信ボタン押下、またはエラー表示済みの項目の修正中のみ true。
  // show=false（blur など）は、OKなら緑、NGなら通常表示のまま何も言わない。
  function validateField(key, show) {
    var f = fields[key];
    var msg = f.check(f.el.value);
    if (show) setFieldError(f, msg);
    setValid(f.el, !msg);
    return !msg;
  }

  // 制作物のエラーは送信時のみ。選択済みチップ自体が状態表示になるので緑は付けない
  function validateItems() {
    return setGroupError(itemsGroup, !groupValid(itemsGroup));
  }

  /* ---------- テキスト項目：blur は静かに判定、エラー表示中の項目だけ入力で即再判定 ---------- */
  Object.keys(fields).forEach(function (key) {
    var f = fields[key];
    f.el.addEventListener('blur', function () {
      if (f.normalize) f.el.value = f.normalize(f.el.value);
      validateField(key, !f.err.hidden);
    });
    f.el.addEventListener('input', function () {
      if (!f.err.hidden) validateField(key, true);   // 直った瞬間に赤を解除 → 緑
      else setValid(f.el, false);                    // 入力中は色を出さない（blurで再判定）
    });
  });

  /* ---------- 制作物：「未定」の排他 ---------- */
  itemsGroup.el.addEventListener('change', function (e) {
    var t = e.target;
    var boxes = itemsGroup.inputs();
    if (t.hasAttribute('data-exclusive') && t.checked) {
      Array.prototype.forEach.call(boxes, function (b) { if (b !== t) b.checked = false; });
    } else if (t.checked) {
      var ex = form.querySelector('input[data-exclusive]');
      if (ex) ex.checked = false;
    }
    if (groupValid(itemsGroup)) setGroupError(itemsGroup, false);
  });

  /* textarea：入力に合わせて緩やかに伸長（初期は2行、最大 ~9行） */
  var ta = document.getElementById('ann-message');
  ta.addEventListener('input', function () {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight + 2, 240) + 'px';
  });

  /* ---------- 送信 ---------- */
  function collect() {
    var items = Array.prototype.map.call(form.querySelectorAll('input[name="items"]:checked'), function (i) { return i.value; });
    return {
      company: fields.company.el.value.trim(),
      name: fields.name.el.value.trim(),
      email: fields.email.el.value.trim(),
      phone: normalizePhone(fields.phone.el.value),   // 画面上の入力値を保持（正規化はサーバー側でも行う）
      items: items,
      itemsUndecided: items.indexOf('undecided') !== -1,   // 市場検証用フラグ
      message: ta.value.trim(),
      // 広告改善用（LPが流入元パラメータを持つ場合に取得）
      source: location.search.replace(/^\?/, '').slice(0, 500)
    };
  }

  // サーバーへPOSTし、{ ok:true, inquiryId } を受け取る。
  // 受付日時・お問い合わせ番号の発番・メール送信はすべてサーバー側。クライアントの値は信用されない。
  function sendToServer(payload) {
    // 送信先が未設定のまま公開してしまった場合に、無関係なURLへ個人情報を送らないための保険
    if (!/^(https:\/\/|\/)/.test(API.url)) {
      console.error('[ann-form] API.url が不正です。同一オリジンのパス（/.netlify/functions/contact）を設定してください。');
      return Promise.reject(new Error('not configured'));
    }
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, API.timeoutMs);
    return fetch(API.url, {
      method: 'POST',
      headers: { 'Content-Type': API.contentType },
      body: JSON.stringify(payload),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (json) {
        return { res: res, json: json };
      });
    }).then(function (o) {
      clearTimeout(timer);
      // ステータスと本文の ok / inquiryId の両方で成否を判定する
      if (!o.res.ok || !o.json || o.json.ok !== true || !o.json.inquiryId) {
        var err = new Error('request failed');
        err.validation = !!(o.json && o.json.error === 'validation');
        throw err;
      }
      return o.json;
    }, function (e) {
      clearTimeout(timer);
      throw e;
    });
  }

  // 送信中：対象は確認画面の「この内容で送信する」だけ。二重送信を防ぎ、「修正する」も操作不可にする
  function setBusy(busy) {
    submitting = busy;
    sendBtn.setAttribute('aria-busy', busy ? 'true' : 'false');
    // disabled にするとフォーカスが失われるため aria-disabled + JSガードで二重送信を防ぐ
    sendBtn.setAttribute('aria-disabled', busy ? 'true' : 'false');
    backBtn.disabled = busy;
    sendLabel.textContent = busy ? '送信しています…' : 'この内容で送信する';
    statusBox.textContent = busy ? '送信しています' : '';
  }

  // Enterによる暗黙の送信を止める。ここでの「送信」は確認画面へ進む操作。
  // 入力欄でEnterしても進まず、ボタンの操作（クリック/ボタン上のEnter・Space）だけで進む。
  // - input(text/email/tel/checkbox)上のEnter → 何もしない
  // - textarea → 通常の改行 / button上のEnter → そのボタンの動作
  // IME変換確定のEnter（isComposing=true、Safariは確定後にkeyCode 229のkeydownが来る）も key==='Enter' で一律に止める。
  // ここで止めても変換の確定自体には影響しない
  // 確認画面のボタンは <form> の外の type="button" なので、Enterでの暗黙の送信は構造上起きない。
  form.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;   // 他のキー（変換中の文字入力など）には触れない
    if (e.target.tagName === 'INPUT') e.preventDefault();
  });

  function scrollToTop() {
    // セクションのidはLP側で変わり得るので、クラスで取得する
    var section = document.querySelector('.ann-contact');
    if (section) section.scrollIntoView({ block: 'start' });
  }

  /* ---------- STEP 1 → 2：入力内容を確認する（ここではAPI送信しない） ---------- */
  form.addEventListener('submit', function (e) {
    e.preventDefault();

    // 電話番号は半角にそろえてから判定
    fields.phone.el.value = normalizePhone(fields.phone.el.value);

    // 赤エラーが初めて出るのはこの時点
    var results = [
      [validateField('company', true), fields.company.el],
      [validateField('name', true), fields.name.el],
      [validateField('email', true), fields.email.el],
      [validateField('phone', true), fields.phone.el],
      [validateItems(), itemsGroup.inputs()[0]]
    ];
    var firstInvalid = results.filter(function (r) { return !r[0]; })[0];
    if (firstInvalid) {
      firstInvalid[1].focus();
      firstInvalid[1].scrollIntoView({ block: 'center', behavior: 'auto' });
      return;
    }

    showConfirm(collect());
  });

  function showConfirm(payload) {
    pendingPayload = payload;
    renderConfirm(payload);
    alertBox.hidden = true;
    alertBox.textContent = '';
    form.hidden = true;                      // 入力値は DOM に残るので「修正する」で復元される
    confirmBox.hidden = false;
    statusBox.textContent = '入力内容の確認画面です';
    document.getElementById('ann-confirm-title').focus({ preventScroll: true });
    scrollToTop();
  }

  // 確認内容は textContent のみで描画する（入力値をHTMLとして展開しない）
  function renderConfirm(p) {
    confirmList.textContent = '';
    addConfirmRow('会社名', p.company);
    addConfirmRow('お名前', p.name);
    addConfirmRow('メールアドレス', p.email);
    addConfirmRow('電話番号', p.phone);
    addConfirmRow('作りたいもの', p.items.map(function (v) { return ITEM_LABELS[v] || v; }).join('、'));
    addConfirmRow('その他ご相談内容', p.message, '（なし）');
  }

  function addConfirmRow(term, value, emptyText) {
    var wrap = document.createElement('div');
    var dt = document.createElement('dt');
    var dd = document.createElement('dd');
    wrap.className = 'ann-confirm__item';
    dt.textContent = term;
    dd.textContent = value || emptyText || '';
    if (!value) dd.className = 'is-empty';
    wrap.appendChild(dt);
    wrap.appendChild(dd);
    confirmList.appendChild(wrap);
  }

  /* ---------- STEP 2 → 1：修正する（入力内容はすべて保持） ---------- */
  backBtn.addEventListener('click', function () {
    if (submitting) return;
    pendingPayload = null;
    alertBox.hidden = true;
    confirmBox.hidden = true;
    form.hidden = false;
    statusBox.textContent = '';
    document.getElementById('ann-contact-title').focus({ preventScroll: true });
    scrollToTop();
  });

  /* ---------- STEP 2 → 3：この内容で送信する（実APIを呼ぶのはここだけ） ---------- */
  sendBtn.addEventListener('click', function () {
    if (submitting || !pendingPayload) return;
    var payload = pendingPayload;
    alertBox.hidden = true;
    setBusy(true);
    sendToServer(payload).then(function (data) {
      showDone(payload, data.inquiryId);
    }).catch(function (err) {
      // 失敗しても確認画面のまま。内容を保持し、そのまま再送信できる
      setBusy(false);
      alertBox.textContent = err && err.validation
        ? '入力内容に不備があるようです。「修正する」から内容をご確認ください。'
        : '送信できませんでした。通信環境をご確認のうえ、もう一度お試しください。';
      alertBox.hidden = false;
      alertBox.scrollIntoView({ block: 'center' });
    });
  });

  function showDone(payload, inquiryId) {
    document.getElementById('ann-done-id').textContent = inquiryId;   // textContent のみ使用（XSS対策）
    var summary = document.getElementById('ann-done-summary');
    summary.textContent = '';
    addRow(summary, '会社名', payload.company);
    addRow(summary, '作りたいもの', payload.items.map(function (v) { return ITEM_LABELS[v] || v; }).join('、'));

    confirmBox.hidden = true;
    form.hidden = true;
    doneBox.hidden = false;
    statusBox.textContent = 'ご相談を受け付けました。お問い合わせ番号は ' + inquiryId + ' です';
    document.getElementById('ann-done-title').focus({ preventScroll: true });
    scrollToTop();
  }

  function addRow(dl, term, desc) {
    var dt = document.createElement('dt');
    var dd = document.createElement('dd');
    dt.textContent = term;
    dd.textContent = desc;
    dl.appendChild(dt);
    dl.appendChild(dd);
  }
})();
