import { zhCN as T } from './locale/zh-CN';

export interface Env {
  LLM_BASE_URL: string;
  LLM_API_KEY: string;
  LLM_MODEL: string;
  EMBED_BASE_URL: string;
  EMBED_MODEL: string;
  EMBED_API_KEY: string; // SiliconFlow key (secret)
  VECTORIZE: VectorizeIndex; // legal article vector index
  DB: D1Database; // invite codes / online sessions
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Invite-Code, X-Device-Id, X-Session-Token',
  'Access-Control-Expose-Headers': 'X-Legal-Hits',
};

// ===== Invite codes: usage limits / revocation / single active session (last login wins) =====
type AuthResult =
  | { ok: true; sessionToken?: string }
  | { ok: false; status: 401 | 409; error: string };

// Checks invite code state (unknown / revoked / over limit); does not look at devices or sessions.
async function checkInviteCode(env: Env, code: string): Promise<AuthResult> {
  const row = await env.DB.prepare('SELECT status, max_uses, used_count FROM invite_codes WHERE code = ?')
    .bind(code)
    .first<{ status: string; max_uses: number | null; used_count: number }>();

  if (!row) return { ok: false, status: 401, error: T.errors.codeInvalid };
  if (row.status === 'revoked') return { ok: false, status: 401, error: T.errors.codeRevoked };
  if (row.max_uses !== null && row.used_count >= row.max_uses) {
    return { ok: false, status: 401, error: T.errors.codeLimitReached };
  }
  return { ok: true };
}

// Used by /verify: a valid code unconditionally takes over the session, kicking out whoever
// logged in before. No device binding: anyone can log in with a code, but only one at a time.
async function claimSession(env: Env, code: string, deviceId: string): Promise<AuthResult> {
  const codeCheck = await checkInviteCode(env, code);
  if (!codeCheck.ok) return codeCheck;

  const sessionToken = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO sessions (code, device_id, session_token, last_seen) VALUES (?, ?, ?, unixepoch())
     ON CONFLICT(code) DO UPDATE SET device_id = excluded.device_id, session_token = excluded.session_token, last_seen = excluded.last_seen`
  )
    .bind(code, deviceId, sessionToken)
    .run();

  return { ok: true, sessionToken };
}

// Used by /legal: on top of checkInviteCode, verifies the session (one user online at a time)
// and atomically consumes one use.
async function checkSessionAndConsume(env: Env, code: string, sessionToken: string): Promise<AuthResult> {
  const session = await env.DB.prepare('SELECT session_token FROM sessions WHERE code = ?')
    .bind(code)
    .first<{ session_token: string }>();
  if (!session || session.session_token !== sessionToken) {
    return { ok: false, status: 409, error: T.errors.sessionTaken };
  }

  const consumed = await env.DB.prepare(
    `UPDATE invite_codes SET used_count = used_count + 1, updated_at = unixepoch()
     WHERE code = ? AND status = 'active' AND (max_uses IS NULL OR used_count < max_uses)
     RETURNING used_count`
  )
    .bind(code)
    .first();
  if (!consumed) return { ok: false, status: 401, error: T.errors.codeRevokedOrLimit };

  await env.DB.prepare('UPDATE sessions SET last_seen = unixepoch() WHERE code = ? AND session_token = ?')
    .bind(code, sessionToken)
    .run();

  return { ok: true };
}

// ===== Legal knowledge base (RAG) =====
interface LegalHit {
  law: string;
  article_cn: string;
  zhang: string;
  bian: string;
  xiaoli: string;
  text: string;
  source: string;
}

async function embedQuery(text: string, env: Env): Promise<number[]> {
  const res = await fetch(`${env.EMBED_BASE_URL}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.EMBED_API_KEY}` },
    body: JSON.stringify({ model: env.EMBED_MODEL, input: [text] }),
  });
  if (!res.ok) throw new Error(`embed ${res.status}: ${await res.text()}`);
  const d = (await res.json()) as { data: Array<{ embedding: number[] }> };
  return d.data[0].embedding;
}

async function searchKB(env: Env, qv: number[], topK: number): Promise<LegalHit[]> {
  const result = await env.VECTORIZE.query(qv, { topK, returnMetadata: 'all' });
  return result.matches.map((m) => m.metadata as unknown as LegalHit);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (url.pathname === '/' && request.method === 'GET') {
      return new Response(HTML_PAGE, {
        headers: { 'Content-Type': 'text/html;charset=utf-8' },
      });
    }

    if (url.pathname === '/verify' && request.method === 'POST') {
      return handleVerify(request, env);
    }

    if (url.pathname === '/legal' && request.method === 'POST') {
      return handleLegal(request, env);
    }

    return new Response('Not Found', { status: 404 });
  },
};

async function handleVerify(request: Request, env: Env): Promise<Response> {
  let body: { code?: string; device_id?: string };
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }
  const code = body.code?.trim();
  const deviceId = body.device_id?.trim();
  if (!code) return jsonError(T.errors.codeInvalid, 401);
  if (!deviceId) return jsonError(T.errors.deviceIdMissing, 400);

  const result = await claimSession(env, code, deviceId);
  if (!result.ok) return jsonError(result.error, result.status);

  return new Response(JSON.stringify({ ok: true, session_token: result.sessionToken }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

async function handleLegal(request: Request, env: Env): Promise<Response> {
  let body: { question?: string; messages?: Array<{ role: string; content: string }>; code?: string; topK?: number };
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const code = (request.headers.get('X-Invite-Code') || body.code)?.trim();
  const sessionToken = request.headers.get('X-Session-Token')?.trim();
  if (!code || !sessionToken) return jsonError(T.errors.codeMissing, 401);

  const codeCheck = await checkInviteCode(env, code);
  if (!codeCheck.ok) return jsonError(codeCheck.error, codeCheck.status);
  const sessionCheck = await checkSessionAndConsume(env, code, sessionToken);
  if (!sessionCheck.ok) return jsonError(sessionCheck.error, sessionCheck.status);

  const userMessages: Array<{ role: string; content: string }> = body.messages?.length
    ? body.messages
    : body.question
    ? [{ role: 'user', content: body.question }]
    : [];
  if (userMessages.length === 0) return jsonError('question or messages is required', 400);

  // Retrieve using the latest user message
  const queryText = [...userMessages].reverse().find((m) => m.role === 'user')?.content || '';

  let context: string;
  let hits: LegalHit[];
  try {
    const qv = await embedQuery(queryText, env);
    hits = await searchKB(env, qv, body.topK && body.topK > 0 ? Math.min(body.topK, 12) : 6);
    context = hits.map(T.formatHit).join('\n\n');
  } catch (err) {
    return jsonError(T.errors.retrievalFailed((err as Error).message), 502);
  }

  const systemContent = `${T.systemPrompt}\n\n${T.contextHeading}\n${context}`;

  const llmResponse = await fetch(`${env.LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.LLM_API_KEY}` },
    body: JSON.stringify({
      model: env.LLM_MODEL || 'deepseek-v4-flash',
      messages: [{ role: 'system', content: systemContent }, ...userMessages],
      thinking: { type: 'disabled' },
      stream: true,
      max_tokens: 4096,
    }),
  }).catch((err: Error) => {
    throw new Error(`Failed to reach LLM: ${err.message}`);
  });

  if (!llmResponse.ok) {
    const detail = await llmResponse.text();
    return jsonError(`LLM returned ${llmResponse.status}: ${detail}`, 502);
  }

  return new Response(llmResponse.body, {
    headers: {
      'Content-Type': 'text/event-stream;charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
      // Retrieved articles go in a header so the UI can list the references
      'X-Legal-Hits': encodeURIComponent(hits.map(T.citation).join(' | ')),
      ...CORS_HEADERS,
    },
  });
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

const HTML_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${T.page.title}</title>
  <style>
    :root {
      --bg:#0e1116; --panel:#161b22; --panel2:#1c222b; --border:#262d38;
      --text:#e6e8eb; --muted:#8b949e; --accent:#4a86ff; --accent-weak:rgba(74,134,255,.12);
      --danger:#e5534b;
    }
    * { box-sizing:border-box; margin:0; padding:0; }
    body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif; background:var(--bg); color:var(--text); height:100vh; display:flex; flex-direction:column; }
    header { padding:14px 22px; border-bottom:1px solid var(--border); display:flex; align-items:center; gap:12px; background:var(--panel); }
    .logo { width:34px; height:34px; border-radius:9px; background:linear-gradient(135deg,#4a86ff,#2b5fd0); display:flex; align-items:center; justify-content:center; font-size:19px; }
    .brand { display:flex; flex-direction:column; }
    .brand h1 { font-size:16px; font-weight:600; color:#fff; letter-spacing:.3px; }
    .brand span { font-size:12px; color:var(--muted); }
    .badge { margin-left:auto; font-size:11px; color:var(--muted); border:1px solid var(--border); padding:4px 10px; border-radius:20px; }
    #messages { flex:1; overflow-y:auto; padding:26px 22px; display:flex; flex-direction:column; gap:18px; }
    .wrap { width:100%; max-width:820px; margin:0 auto; display:flex; flex-direction:column; gap:18px; }
    .msg { line-height:1.75; font-size:15px; }
    .msg.user { align-self:flex-end; background:var(--accent); color:#fff; padding:10px 15px; border-radius:16px 16px 4px 16px; max-width:80%; white-space:pre-wrap; word-break:break-word; }
    .msg.assistant { align-self:flex-start; background:var(--panel); border:1px solid var(--border); padding:14px 16px; border-radius:4px 14px 14px 14px; max-width:100%; }
    .hits { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:11px; padding-bottom:11px; border-bottom:1px dashed var(--border); }
    .hits-label { font-size:12px; color:var(--muted); margin-right:2px; align-self:center; }
    .chip { font-size:12px; color:var(--accent); background:var(--accent-weak); border:1px solid rgba(74,134,255,.28); padding:3px 9px; border-radius:20px; white-space:nowrap; }
    .body { white-space:pre-wrap; word-break:break-word; }
    .body strong { color:#fff; font-weight:600; }
    .body code { background:var(--panel2); padding:1px 5px; border-radius:4px; font-size:13px; }
    /* welcome card */
    .welcome { background:var(--panel); border:1px solid var(--border); border-radius:14px; padding:22px; }
    .welcome h2 { font-size:17px; color:#fff; margin-bottom:8px; }
    .welcome p { font-size:14px; color:var(--muted); line-height:1.7; }
    .examples { display:flex; flex-wrap:wrap; gap:9px; margin-top:16px; }
    .ex { font-size:13.5px; color:var(--text); background:var(--panel2); border:1px solid var(--border); padding:8px 13px; border-radius:10px; cursor:pointer; transition:.15s; }
    .ex:hover { border-color:var(--accent); color:#fff; }
    .coverage { margin-top:16px; font-size:12px; color:var(--muted); }
    .coverage b { color:#b9c1cc; font-weight:500; }
    .cursor { display:inline-block; width:2px; height:1em; background:var(--text); animation:blink 1s step-end infinite; vertical-align:text-bottom; margin-left:1px; }
    @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }
    /* input area */
    #foot { border-top:1px solid var(--border); background:var(--panel); }
    .disclaimer { max-width:820px; margin:0 auto; padding:8px 22px 0; font-size:11.5px; color:var(--muted); text-align:center; }
    #input-area { max-width:820px; margin:0 auto; padding:12px 22px 16px; display:flex; gap:10px; }
    #input { flex:1; background:var(--panel2); border:1px solid var(--border); color:var(--text); border-radius:12px; padding:12px 15px; font-size:15px; resize:none; outline:none; max-height:140px; line-height:1.5; font-family:inherit; }
    #input:focus { border-color:var(--accent); }
    #send { background:var(--accent); color:#fff; border:none; border-radius:12px; padding:0 22px; font-size:15px; cursor:pointer; align-self:stretch; white-space:nowrap; }
    #send:disabled { background:#2a3340; color:#5c6673; cursor:not-allowed; }
    /* invite gate */
    #gate { position:fixed; inset:0; background:var(--bg); z-index:100; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:16px; padding:20px; }
    #gate .logo { width:52px; height:52px; font-size:28px; border-radius:14px; }
    #gate h2 { font-size:21px; color:#fff; font-weight:600; }
    #gate p { font-size:13px; color:var(--muted); }
    #gate .box { display:flex; gap:10px; margin-top:6px; }
    #gate input { background:var(--panel2); border:1px solid var(--border); color:var(--text); border-radius:11px; padding:12px 16px; font-size:15px; outline:none; width:240px; }
    #gate input:focus { border-color:var(--accent); }
    #gate button { background:var(--accent); color:#fff; border:none; border-radius:11px; padding:0 22px; font-size:15px; cursor:pointer; }
    #gate button:disabled { background:#2a3340; cursor:not-allowed; }
    #gate .err { font-size:13px; color:var(--danger); min-height:18px; }
  </style>
</head>
<body>
  <div id="gate">
    <div class="logo">⚖️</div>
    <h2>${T.page.brand}</h2>
    <p>${T.page.gatePrompt}</p>
    <div class="box">
      <input id="gate-input" type="password" placeholder="${T.page.gatePlaceholder}" autocomplete="off">
      <button id="gate-btn">${T.page.gateButton}</button>
    </div>
    <div class="err" id="gate-err"></div>
  </div>

  <header>
    <div class="logo">⚖️</div>
    <div class="brand">
      <h1>${T.page.brand}</h1>
      <span>${T.page.tagline}</span>
    </div>
    <div class="badge">${T.page.badge}</div>
  </header>

  <div id="messages">
    <div class="wrap" id="wrap">
      <div class="welcome">
        <h2>${T.page.welcomeTitle}</h2>
        <p>${T.page.welcomeBody}</p>
        <div class="examples" id="examples"></div>
        <div class="coverage">${T.page.coverage}</div>
      </div>
    </div>
  </div>

  <div id="foot">
    <div class="disclaimer">${T.page.disclaimer}</div>
    <div id="input-area">
      <textarea id="input" placeholder="${T.page.inputPlaceholder}" rows="1"></textarea>
      <button id="send">${T.page.sendButton}</button>
    </div>
  </div>

  <script>
    const messagesEl = document.getElementById('messages');
    const wrapEl = document.getElementById('wrap');
    const inputEl = document.getElementById('input');
    const sendBtn = document.getElementById('send');
    const history = [];

    const T = ${JSON.stringify(T.client)};
    const EXAMPLES = T.examples;
    const exEl = document.getElementById('examples');
    EXAMPLES.forEach(q => {
      const b = document.createElement('div');
      b.className = 'ex';
      b.textContent = q;
      b.addEventListener('click', () => { if (!sendBtn.disabled) { inputEl.value = q; send(); } });
      exEl.appendChild(b);
    });

    // ===== Invite gate + anonymous device id + single active session =====
    const GATE_KEY = 'legal_invite';
    const DEVICE_KEY = 'legal_device';
    const SESSION_KEY = 'legal_session';
    const gateEl = document.getElementById('gate');
    const gateInput = document.getElementById('gate-input');
    const gateBtn = document.getElementById('gate-btn');
    const gateErr = document.getElementById('gate-err');

    function getDeviceId() {
      let id = localStorage.getItem(DEVICE_KEY);
      if (!id) { id = crypto.randomUUID(); localStorage.setItem(DEVICE_KEY, id); }
      return id;
    }
    function getCode() { return localStorage.getItem(GATE_KEY) || ''; }
    function getSessionToken() { return localStorage.getItem(SESSION_KEY) || ''; }

    function lockGate(message) {
      localStorage.removeItem(GATE_KEY);
      localStorage.removeItem(SESSION_KEY);
      gateErr.textContent = message || '';
      gateEl.style.display = 'flex';
    }

    gateBtn.addEventListener('click', () => verifyGate(gateInput.value.trim()));
    gateInput.addEventListener('keydown', e => { if (e.key === 'Enter') verifyGate(gateInput.value.trim()); });

    // Only called on an explicit user action (submitting the gate form). Never call it
    // automatically: each call kicks out whoever is online, so a silent reconnect would let
    // a kicked-out user instantly kick the other person back, defeating "one user at a time".
    async function verifyGate(code) {
      if (!code) return false;
      gateBtn.disabled = true;
      gateErr.textContent = '';
      try {
        const resp = await fetch('/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, device_id: getDeviceId() }),
        });
        const data = await resp.json().catch(() => ({}));
        if (resp.ok && data.ok) {
          localStorage.setItem(GATE_KEY, code);
          localStorage.setItem(SESSION_KEY, data.session_token);
          gateEl.style.display = 'none';
          return true;
        }
        lockGate(data.error || T.codeInvalid);
        return false;
      } catch (err) {
        lockGate(T.verifyError + err.message);
        return false;
      } finally {
        gateBtn.disabled = false;
      }
    }

    // A stored code + session lets the user in optimistically (no request, so nobody gets kicked).
    // The server decides via session_token on the next message; if kicked, send() reopens the gate.
    if (getCode() && getSessionToken()) gateEl.style.display = 'none';

    // Auto-grow the input box
    inputEl.addEventListener('input', () => {
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + 'px';
    });
    inputEl.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    sendBtn.addEventListener('click', send);

    // Minimal Markdown: escaping + **bold** + \`code\`
    function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    function fmt(raw) {
      let s = esc(raw);
      const parts = s.split('**');
      let out = '';
      for (let i = 0; i < parts.length; i++) out += (i % 2 === 1 ? '<strong>' + parts[i] + '</strong>' : parts[i]);
      const cp = out.split('\`');
      let out2 = '';
      for (let i = 0; i < cp.length; i++) out2 += (i % 2 === 1 ? '<code>' + cp[i] + '</code>' : cp[i]);
      return out2;
    }

    function appendUser(text) {
      const el = document.createElement('div');
      el.className = 'msg user';
      el.textContent = text;
      wrapEl.appendChild(el);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    function appendAssistant() {
      const el = document.createElement('div');
      el.className = 'msg assistant';
      const hits = document.createElement('div');
      hits.className = 'hits';
      hits.style.display = 'none';
      const body = document.createElement('div');
      body.className = 'body';
      el.appendChild(hits);
      el.appendChild(body);
      wrapEl.appendChild(el);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return { hits, body };
    }
    function renderHits(hitsEl, raw) {
      const arr = raw.split(' | ').filter(Boolean);
      if (!arr.length) return;
      const label = document.createElement('span');
      label.className = 'hits-label';
      label.textContent = T.hitsLabel;
      hitsEl.appendChild(label);
      arr.forEach(t => {
        const c = document.createElement('span');
        c.className = 'chip';
        c.textContent = t;
        hitsEl.appendChild(c);
      });
      hitsEl.style.display = 'flex';
    }

    async function send() {
      const text = inputEl.value.trim();
      if (!text || sendBtn.disabled) return;
      inputEl.value = '';
      inputEl.style.height = 'auto';
      sendBtn.disabled = true;

      appendUser(text);
      history.push({ role: 'user', content: text });

      const { hits, body } = appendAssistant();
      const cursor = document.createElement('span');
      cursor.className = 'cursor';
      body.appendChild(cursor);

      let full = '';
      let buffer = '';

      function legalHeaders() {
        return {
          'Content-Type': 'application/json',
          'X-Invite-Code': getCode(),
          'X-Device-Id': getDeviceId(),
          'X-Session-Token': getSessionToken(),
        };
      }

      try {
        const resp = await fetch('/legal', {
          method: 'POST',
          headers: legalHeaders(),
          body: JSON.stringify({ messages: history }),
        });

        if (resp.status === 401 || resp.status === 409) {
          // 401 = code invalid / revoked / over limit; 409 = session taken by another device.
          // Never reclaim automatically: reclaiming kicks the other user, so it must be an
          // explicit re-entry of the code by the user.
          const data = await resp.json().catch(() => ({}));
          body.textContent = data.error || T.codeReenter;
          cursor.remove();
          history.pop();
          lockGate(data.error);
          sendBtn.disabled = false;
          return;
        }
        if (!resp.ok) {
          body.textContent = T.httpErrorPrefix + resp.status + T.httpErrorSuffix;
          cursor.remove();
          history.pop();
          sendBtn.disabled = false;
          return;
        }

        const hitsRaw = resp.headers.get('X-Legal-Hits');
        if (hitsRaw) { try { renderHits(hits, decodeURIComponent(hitsRaw)); } catch (e) {} }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let rawBuffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          rawBuffer += decoder.decode(value, { stream: true });
          const parts = rawBuffer.split('\\n\\n');
          rawBuffer = parts.pop() || '';
          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') continue;
            try {
              const json = JSON.parse(data);
              const delta = json.choices?.[0]?.delta?.content || '';
              buffer += delta;
              body.innerHTML = fmt(buffer);
              body.appendChild(cursor);
              full = buffer;
              messagesEl.scrollTop = messagesEl.scrollHeight;
            } catch {}
          }
        }
      } catch (err) {
        body.textContent = T.requestError + err.message;
      }

      cursor.remove();
      history.push({ role: 'assistant', content: full });
      sendBtn.disabled = false;
    }
  </script>
</body>
</html>`;
