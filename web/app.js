let me = null;
let ws;
let wsRetry = 0;
let activeConversation;
let nextCursor = null;
let conversations = [];

async function init() {
  const res = await fetch('/api/auth/me');
  if (res.ok) {
    me = await res.json();
    showApp();
  } else {
    document.getElementById('login').hidden = false;
  }
}

function showApp() {
  document.getElementById('login').hidden = true;
  document.getElementById('userName').textContent = me.username;
  loadConversations();
}

async function loadConversations() {
  const res = await fetch('/api/conversations');
  if (res.status === 401) return location.reload(); // session expired -> login screen
  if (!res.ok) throw new Error(`failed to load conversations: ${res.status}`);
  conversations = await res.json();
  renderSidebar();
  connectWs();
}

function renderSidebar() {
  const list = document.getElementById('conversations');
  list.innerHTML = '';
  for (const c of conversations) {
    const li = document.createElement('li');
    if (c.id === activeConversation) li.className = 'active';
    const label = document.createElement('span');
    label.textContent = `${c.title} (${c.messageCount})`;
    li.appendChild(label);
    if (c.id !== activeConversation && typers.get(c.id)?.size) {
      const hint = document.createElement('span');
      hint.className = 'typing-hint';
      hint.textContent = 'typing…';
      li.appendChild(hint);
    }
    if (c.unread) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.textContent = '●';
      li.appendChild(dot);
    }
    li.onclick = () => openConversation(c.id, c.title);
    list.appendChild(li);
  }
}

function connectWs() {
  if (ws) {
    ws.onclose = null; // deliberate replacement, not a drop — don't reconnect
    ws.close();
  }
  ws = new WebSocket(`ws://${location.host}/`);
  ws.onopen = () => {
    wsRetry = 0;
    ws.send(JSON.stringify({ type: 'subscribe', conversationIds: conversations.map((c) => c.id) }));
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'typing') {
      noteTyping(msg.conversationId, msg.username);
      return;
    }
    if (msg.type !== 'message') return;
    stopTyping(msg.conversationId, msg.senderUsername); // their message arrived
    const c = conversations.find((x) => x.id === msg.conversationId);
    if (c) c.messageCount += 1;
    if (msg.conversationId === activeConversation) {
      appendMessage(msg);
    } else if (c) {
      c.unread = true;
    }
    renderSidebar();
  };
  ws.onclose = (ev) => {
    if (ev.code === 4401) return location.reload(); // auth rejected -> login screen
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  const delay = Math.min(15_000, 1000 * 2 ** wsRetry++);
  setTimeout(async () => {
    try {
      await resync();
    } catch {
      scheduleReconnect(); // server still down — back off and retry
    }
  }, delay);
}

// After an outage: refresh sidebar counts, reconnect the socket, and re-fetch
// the open conversation so messages missed while offline appear.
async function resync() {
  await loadConversations();
  if (!activeConversation) return;
  const c = conversations.find((x) => x.id === activeConversation);
  if (c) await openConversation(c.id, c.title);
}

// aroundId (optional): open the conversation at that message — the page
// *ending* with it — highlighted, with a way back to the latest messages.
async function openConversation(id, title, aroundId) {
  activeConversation = id;
  const c = conversations.find((x) => x.id === id);
  if (c) c.unread = false;
  renderSidebar();

  document.getElementById('title').textContent = title;
  const cursor = aroundId ? `&before=${aroundId + 1}` : '';
  const res = await fetch(`/api/messages?conversationId=${id}${cursor}`);
  if (!res.ok) return;
  const page = await res.json();
  nextCursor = page.nextCursor;
  const pane = document.getElementById('messages');
  pane.innerHTML = '';
  renderOlderButton(pane);
  for (const m of page.messages) {
    const div = messageDiv(m);
    if (m.id === aroundId) div.classList.add('target');
    pane.appendChild(div);
  }
  pane.scrollTop = pane.scrollHeight;
  renderTyping();
  if (aroundId) {
    const latest = document.createElement('button');
    latest.id = 'jumpLatest';
    latest.textContent = '↓ Jump to latest';
    latest.onclick = () => openConversation(id, title);
    pane.appendChild(latest);
  }
}

function renderOlderButton(pane) {
  document.getElementById('loadOlder')?.remove();
  if (!nextCursor) return;
  const btn = document.createElement('button');
  btn.id = 'loadOlder';
  btn.textContent = 'Load older messages';
  btn.onclick = loadOlder;
  pane.prepend(btn);
}

async function loadOlder() {
  if (!nextCursor || !activeConversation) return;
  const res = await fetch(`/api/messages?conversationId=${activeConversation}&before=${nextCursor}`);
  if (!res.ok) return;
  const page = await res.json();
  nextCursor = page.nextCursor;
  const pane = document.getElementById('messages');
  const prevHeight = pane.scrollHeight;
  const anchor = document.getElementById('loadOlder')?.nextSibling ?? pane.firstChild;
  for (const m of page.messages) pane.insertBefore(messageDiv(m), anchor);
  renderOlderButton(pane);
  pane.scrollTop += pane.scrollHeight - prevHeight; // keep view anchored
}

// --- typing indicators: conversationId -> Map(username -> expiry). Entries
// self-expire after TYPING_TTL unless refreshed by another typing event.
const typers = new Map();
const TYPING_TTL = 3000;

function noteTyping(conversationId, username) {
  if (!username || username === me?.username) return;
  let conv = typers.get(conversationId);
  if (!conv) {
    conv = new Map();
    typers.set(conversationId, conv);
  }
  conv.set(username, Date.now() + TYPING_TTL);
  setTimeout(pruneTyping, TYPING_TTL + 50);
  renderTyping();
}

function stopTyping(conversationId, username) {
  typers.get(conversationId)?.delete(username);
  renderTyping();
}

function pruneTyping() {
  const now = Date.now();
  for (const [convId, conv] of typers) {
    for (const [username, expiry] of conv) if (expiry <= now) conv.delete(username);
    if (!conv.size) typers.delete(convId);
  }
  renderTyping();
}

function renderTyping() {
  const names = [...(typers.get(activeConversation)?.keys() ?? [])];
  document.getElementById('typing').textContent = names.length
    ? `${names.join(', ')} ${names.length > 1 ? 'are' : 'is'} typing…`
    : '';
  renderSidebar(); // sidebar shows a typing hint for the other conversations
}

let lastTypingSentAt = 0;
document.getElementById('text').oninput = () => {
  if (!activeConversation || !ws || ws.readyState !== WebSocket.OPEN) return;
  const now = Date.now();
  if (now - lastTypingSentAt < 2000) return; // server refreshes ~before the 3s TTL lapses
  lastTypingSentAt = now;
  ws.send(JSON.stringify({ type: 'typing', conversationId: activeConversation }));
};

function messageDiv(m) {
  const div = document.createElement('div');
  div.className = 'msg';
  div.textContent = `${m.senderUsername ?? '#' + m.senderId}: ${m.body}`;
  return div;
}

function appendMessage(m) {
  const pane = document.getElementById('messages');
  pane.appendChild(messageDiv(m));
  pane.scrollTop = pane.scrollHeight;
}

document.getElementById('composer').onsubmit = async (e) => {
  e.preventDefault();
  const input = document.getElementById('text');
  const body = input.value.trim();
  if (!body || !activeConversation) return;
  input.value = '';
  const res = await fetch('/api/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversationId: activeConversation,
      body,
      clientId: crypto.randomUUID(),
    }),
  });
  if (!res.ok) {
    input.value = body; // don't lose what they typed
    if (res.status === 429) {
      const wait = res.headers.get('Retry-After') || 'a few';
      flashComposer(`Sending too fast — retry in ${wait}s`);
    }
  }
};

function flashComposer(text) {
  const input = document.getElementById('text');
  input.classList.add('throttled');
  const prev = input.placeholder;
  input.placeholder = text;
  setTimeout(() => {
    input.classList.remove('throttled');
    input.placeholder = prev;
  }, 2500);
}

document.getElementById('newConv').onclick = async () => {
  const title = prompt('Conversation title?');
  if (!title) return;
  const invite = prompt('Invite usernames (comma-separated)?', '') || '';
  const participantUsernames = invite.split(',').map((s) => s.trim()).filter(Boolean);
  const res = await fetch('/api/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, participantUsernames }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error('failed to create conversation:', err.error || res.status);
    return;
  }
  await loadConversations();
};

// Telegram-style: one query searches chats and messages together,
// live as you type (debounced), results grouped by kind.
let searchTimer;
let searchSeq = 0;

document.getElementById('search').oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 300);
};
document.getElementById('searchForm').onsubmit = (e) => {
  e.preventDefault();
  clearTimeout(searchTimer);
  runSearch();
};

async function runSearch() {
  const q = document.getElementById('search').value.trim();
  if (q.length < 2) return;
  const seq = ++searchSeq;
  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
  if (!res.ok || seq !== searchSeq) return; // stale response — a newer query is in flight
  renderResults(q, await res.json());
}

function sectionLabel(text) {
  const el = document.createElement('div');
  el.className = 'section-label';
  el.textContent = text;
  return el;
}

function renderResults(q, { conversations: convHits, messages: msgHits }) {
  activeConversation = null;
  document.getElementById('title').textContent = `Search: "${q}"`;
  const pane = document.getElementById('messages');
  pane.innerHTML = '';
  if (!convHits.length && !msgHits.length) {
    const empty = document.createElement('div');
    empty.className = 'msg';
    empty.style.color = '#888';
    empty.textContent = 'No results.';
    pane.appendChild(empty);
    return;
  }
  if (convHits.length) {
    pane.appendChild(sectionLabel('Chats'));
    for (const c of convHits) {
      const div = document.createElement('div');
      div.className = 'msg result';
      const title = document.createElement('strong');
      title.textContent = c.title;
      div.appendChild(title);
      div.onclick = () => openConversation(c.id, c.title);
      pane.appendChild(div);
    }
  }
  if (msgHits.length) {
    pane.appendChild(sectionLabel('Messages'));
    for (const m of msgHits) {
      const div = document.createElement('div');
      div.className = 'msg result';
      const title = document.createElement('strong');
      title.textContent = m.conversationTitle;
      const meta = document.createElement('div');
      meta.className = 'result-meta';
      meta.textContent = `${m.senderUsername}: ${m.body}`;
      div.append(title, meta);
      div.onclick = () => openConversation(m.conversationId, m.conversationTitle, m.messageId);
      pane.appendChild(div);
    }
  }
  pane.scrollTop = 0;
}

document.getElementById('loginForm').onsubmit = async (e) => {
  e.preventDefault();
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: document.getElementById('loginUser').value.trim(),
      password: document.getElementById('loginPass').value,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    document.getElementById('loginError').textContent = err.error || 'login failed';
    return;
  }
  me = await res.json();
  showApp();
};

document.getElementById('logout').onclick = async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.reload();
};

init();
