// worker.js
// Единый Cloudflare Worker: раздаёт статический сайт (index.html) и
// обрабатывает запросы к /api (вход, CRUD списка, управление аккаунтами).
// Хранилище: Cloudflare KV (привязка PEOPLE_KV, настраивается в дашборде,
// вкладка "Bindings").

const SUPER_LOGIN = 'St_admin1';
const SUPER_PASSWORD = 'st1FghXoL';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Auth-Token',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders() });
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function b64url(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return atob(str);
}

async function signToken(secret, payloadObj) {
  const payload = b64url(JSON.stringify(payloadObj));
  const sig = await hmacHex(secret, payload);
  return payload + '.' + sig;
}

async function verifyToken(secret, token) {
  if (!token || token.indexOf('.') === -1) return null;
  const [payload, sig] = token.split('.');
  const expected = await hmacHex(secret, payload);
  if (sig !== expected) return null;
  try {
    return JSON.parse(fromB64url(payload));
  } catch (e) {
    return null;
  }
}

async function hashPassword(secret, login, password) {
  return sha256Hex(secret + ':' + login + ':' + password);
}

function generateLinkCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sendTelegramMessage(env, chatId, text, threadId) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, description: 'TELEGRAM_BOT_TOKEN не задан' };
  const payload = { chat_id: chatId, text };
  if (threadId) payload.message_thread_id = threadId;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  let data = {};
  try { data = await res.json(); } catch (e) {}
  return {
    ok: res.ok && data.ok,
    description: data.description || (res.ok ? '' : `HTTP ${res.status}`),
    messageId: data.result && data.result.message_id
  };
}

function sortPeople(list) {
  return [...list].sort((a, b) => {
    const aHas = a.post ? 1 : 0;
    const bHas = b.post ? 1 : 0;
    return bHas - aHas;
  });
}

const DEFAULT_BOT_TEMPLATES = {
  acceptApplication: '✅ Ваша анкета принята! Скоро с вами свяжутся модераторы.',
  rejectApplication: '❌ Ваша анкета была рассмотрена модераторами и отклонена.'
};

async function getBotTemplates(env) {
  const kv = env.PEOPLE_KV;
  if (!kv) return DEFAULT_BOT_TEMPLATES;
  const stored = JSON.parse((await kv.get('bot_templates')) || '{}');
  return {
    acceptApplication: stored.acceptApplication || DEFAULT_BOT_TEMPLATES.acceptApplication,
    rejectApplication: stored.rejectApplication || DEFAULT_BOT_TEMPLATES.rejectApplication
  };
}

function fillTemplate(template, appEntry) {
  return template
    .replace(/\{roblox\}/g, appEntry.roblox || '')
    .replace(/\{telegram\}/g, appEntry.telegram || '')
    .replace(/\{discord\}/g, appEntry.discord || '');
}

const APPLICATION_TEMPLATE = `Добро пожаловать! Чтобы подать заявку на вступление, отправьте ОДНИМ сообщением данные строго в этом формате (каждая строка отдельно):

Юз Roblox: ваш_юз
Юз Telegram: ваш_юз
Юз Discord: ваш_юз

Пример:
Юз Roblox: CoolPlayer123
Юз Telegram: @myusername
Юз Discord: player_1234`;

function parseApplicationText(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  let roblox = null, telegram = null, discord = null;
  for (const line of lines) {
    const mR = line.match(/^(?:юз\s*)?roblox\s*[:\-–]\s*(.+)$/i);
    if (mR) roblox = mR[1].trim();
    const mT = line.match(/^(?:юз\s*)?telegram\s*[:\-–]\s*(.+)$/i);
    if (mT) telegram = mT[1].trim();
    const mD = line.match(/^(?:юз\s*)?discord\s*[:\-–]\s*(.+)$/i);
    if (mD) discord = mD[1].trim();
  }
  if (roblox && telegram && discord) return { roblox, telegram, discord };
  return null;
}

async function handleTelegramWebhook(request, env) {
  const kv = env.PEOPLE_KV;
  if (!kv) return json({ ok: true });

  const secretHeader = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (env.TELEGRAM_WEBHOOK_SECRET && secretHeader !== env.TELEGRAM_WEBHOOK_SECRET) {
    return json({ ok: false }, 401);
  }

  let update;
  try {
    update = await request.json();
  } catch (e) {
    return json({ ok: true });
  }

  const message = update.message;

  // Событие: бота добавили/удалили из группы — фиксируем сразу
  if (update.my_chat_member && update.my_chat_member.chat) {
    const chat = update.my_chat_member.chat;
    const newStatus = update.my_chat_member.new_chat_member && update.my_chat_member.new_chat_member.status;
    const known = JSON.parse((await kv.get('known_groups')) || '{}');
    if (newStatus === 'member' || newStatus === 'administrator') {
      known[chat.id] = { title: chat.title || 'Без названия', type: chat.type, updatedAt: new Date().toISOString() };
      await kv.put('known_groups', JSON.stringify(known));
    } else if (newStatus === 'left' || newStatus === 'kicked') {
      delete known[chat.id];
      await kv.put('known_groups', JSON.stringify(known));
      const subs = JSON.parse((await kv.get('group_subscriptions')) || '{}');
      delete subs[chat.id];
      await kv.put('group_subscriptions', JSON.stringify(subs));
    }
    return json({ ok: true });
  }

  if (!message || !message.chat) return json({ ok: true });

  const chatId = message.chat.id;
  const chatType = message.chat.type;

  // Пассивно запоминаем все группы, где бот получает сообщения
  if (chatType === 'group' || chatType === 'supergroup') {
    const known = JSON.parse((await kv.get('known_groups')) || '{}');
    known[chatId] = {
      title: message.chat.title || 'Без названия',
      type: chatType,
      updatedAt: new Date().toISOString()
    };
    await kv.put('known_groups', JSON.stringify(known));
  }

  if (!message.text) return json({ ok: true });
  const text = message.text.trim();

  // Если ждём данные анкеты от этого чата и это не команда — пробуем распарсить
  if (chatType === 'private' && !text.startsWith('/')) {
    const flow = JSON.parse((await kv.get('app_flow_state')) || '{}');
    if (flow[chatId] && flow[chatId].step === 'awaiting_data') {
      const parsed = parseApplicationText(text);
      if (parsed) {
        const applications = JSON.parse((await kv.get('pending_applications')) || '[]');
        const appEntry = {
          id: crypto.randomUUID(),
          roblox: parsed.roblox,
          telegram: parsed.telegram,
          discord: parsed.discord,
          chatId: String(chatId),
          fromUsername: message.from && message.from.username ? '@' + message.from.username : '',
          submittedAt: new Date().toISOString()
        };
        applications.push(appEntry);
        await kv.put('pending_applications', JSON.stringify(applications));

        delete flow[chatId];
        await kv.put('app_flow_state', JSON.stringify(flow));

        await sendTelegramMessage(env, chatId, '✅ Спасибо! Ваша анкета отправлена на рассмотрение модераторам. Мы свяжемся с вами после проверки.');
        return json({ ok: true });
      } else {
        await sendTelegramMessage(env, chatId, '⚠️ Не удалось распознать формат. Пожалуйста, отправьте данные строго по шаблону:\n\n' + APPLICATION_TEMPLATE);
        return json({ ok: true });
      }
    }
  }

  if (text.startsWith('/start')) {
    const parts = text.split(' ');
    const code = parts[1];

    if (code) {
      const pending = JSON.parse((await kv.get('telegram_pending')) || '{}');
      const record = pending[code];

      if (!record || record.expires < Date.now()) {
        await sendTelegramMessage(env, chatId, 'Код недействителен или устарел. Сгенерируйте новую ссылку на сайте и попробуйте снова.');
        return json({ ok: true });
      }

      const bindings = JSON.parse((await kv.get('telegram_bindings')) || '{}');
      bindings[record.login] = chatId;
      await kv.put('telegram_bindings', JSON.stringify(bindings));

      delete pending[code];
      await kv.put('telegram_pending', JSON.stringify(pending));

      await sendTelegramMessage(env, chatId, `✅ Telegram привязан к аккаунту «${record.login}». Уведомления о непринятых заявках будут приходить сюда 4 раза в день (10:00, 12:00, 16:00 и 20:00 МСК).`);
      return json({ ok: true });
    }

    // /start без кода
    const bindings = JSON.parse((await kv.get('telegram_bindings')) || '{}');
    const isLinkedAdmin = Object.values(bindings).some((v) => String(v) === String(chatId));

    if (isLinkedAdmin) {
      await sendTelegramMessage(env, chatId, 'Привет! Вы уже привязаны как сотрудник. Уведомления будут приходить сюда автоматически.');
      return json({ ok: true });
    }

    // Обычный пользователь — предлагаем заполнить анкету
    await sendTelegramMessage(env, chatId, APPLICATION_TEMPLATE);
    const flow = JSON.parse((await kv.get('app_flow_state')) || '{}');
    flow[chatId] = { step: 'awaiting_data', startedAt: new Date().toISOString() };
    await kv.put('app_flow_state', JSON.stringify(flow));
    return json({ ok: true });
  }

  if (text.startsWith('/setgroup')) {
    const chatType = message.chat.type;
    if (chatType !== 'group' && chatType !== 'supergroup') {
      await sendTelegramMessage(env, chatId, 'Эту команду нужно отправлять внутри группы, которую вы хотите использовать для уведомлений.');
      return json({ ok: true });
    }

    const senderId = message.from && message.from.id;
    const bindings = JSON.parse((await kv.get('telegram_bindings')) || '{}');
    const isLinkedEmployee = senderId && Object.values(bindings).some((v) => String(v) === String(senderId));

    if (!isLinkedEmployee) {
      await sendTelegramMessage(env, chatId, '⛔ Только сотрудник с привязанным на сайте Telegram может назначить эту группу для уведомлений.');
      return json({ ok: true });
    }

    await setGroupSubscribed(env, chatId, message.message_thread_id, true);
    await sendTelegramMessage(env, chatId, '✅ Эта группа (раздел) подписана на живые уведомления о непринятых анкетах. Убедитесь, что у бота есть право удалять сообщения (нужно для обновления списка).', message.message_thread_id);
    await syncGroupStatus(env, chatId);
    return json({ ok: true });
  }

  if (text.startsWith('/unsetgroup')) {
    const senderId = message.from && message.from.id;
    const bindings = JSON.parse((await kv.get('telegram_bindings')) || '{}');
    const isLinkedEmployee = senderId && Object.values(bindings).some((v) => String(v) === String(senderId));
    if (!isLinkedEmployee) {
      await sendTelegramMessage(env, chatId, '⛔ Только сотрудник с привязанным на сайте Telegram может это сделать.');
      return json({ ok: true });
    }
    await setGroupSubscribed(env, chatId, message.message_thread_id, false);
    await sendTelegramMessage(env, chatId, '🔕 Эта группа отписана от уведомлений.', message.message_thread_id);
    return json({ ok: true });
  }

  return json({ ok: true });
}

async function handleScheduled(env) {
  const kv = env.PEOPLE_KV;
  if (!kv) return;

  const list = sortPeople(JSON.parse((await kv.get('people')) || '[]'));
  const text = buildStatusText(list);
  if (!text) return;

  const bindings = JSON.parse((await kv.get('telegram_bindings')) || '{}');
  const chatIds = Object.values(bindings);
  for (const chatId of chatIds) {
    await sendTelegramMessage(env, chatId, text);
  }
}

async function deleteTelegramMessage(env, chatId, messageId) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token || !messageId) return;
  await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId })
  });
}

function buildStatusText(list) {
  const notAccepted = list
    .map((p, i) => ({ p, num: i + 1 }))
    .filter((entry) => !entry.p.accepted);
  if (notAccepted.length === 0) return null;
  const lines = notAccepted.map(({ p, num }) => {
    const reqStatus = p.requestSent ? 'Запрос отправлен' : 'Ждёт отправки модератором';
    const hoursPending = p.createdAt ? (Date.now() - new Date(p.createdAt).getTime()) / 3600000 : 0;
    const stuckMark = (!p.requestSent && hoursPending > 24) ? '🔴 ДОЛГО ВИСИТ (>24ч)\n' : '';
    return `${stuckMark}№${num}\nНик: ${p.nick || '—'}\nЮз: ${p.uz || '—'}\nДС: ${p.ds || '—'}\nПринял: ${p.addedBy || '—'}\nСтатус инвайта: ${reqStatus}`;
  });
  return `⚠️ Не приняты в клан (${notAccepted.length}):\n\n${lines.join('\n\n')}`;
}

async function setGroupSubscribed(env, chatId, threadId, subscribed) {
  const kv = env.PEOPLE_KV;
  if (!kv) return;
  const subs = JSON.parse((await kv.get('group_subscriptions')) || '{}');
  const existing = subs[chatId] || {};
  subs[chatId] = {
    ...existing,
    threadId: threadId || existing.threadId || null,
    subscribed
  };
  await kv.put('group_subscriptions', JSON.stringify(subs));
}

async function syncGroupStatus(env, onlyChatId) {
  const kv = env.PEOPLE_KV;
  if (!kv) return;

  const subs = JSON.parse((await kv.get('group_subscriptions')) || '{}');
  const targets = onlyChatId ? [onlyChatId] : Object.keys(subs);

  const list = sortPeople(JSON.parse((await kv.get('people')) || '[]'));
  const text = buildStatusText(list);

  for (const chatId of targets) {
    const entry = subs[chatId];
    if (!entry || !entry.subscribed) continue;

    if (entry.lastMessageId) {
      await deleteTelegramMessage(env, chatId, entry.lastMessageId);
      entry.lastMessageId = null;
    }

    if (text) {
      const result = await sendTelegramMessage(env, chatId, text, entry.threadId);
      if (result.ok && result.messageId) {
        entry.lastMessageId = result.messageId;
        entry.lastSent = new Date().toISOString();
      }
    }
    subs[chatId] = entry;
  }

  await kv.put('group_subscriptions', JSON.stringify(subs));
}

async function maybeRefreshGroupStatus(env) {
  const kv = env.PEOPLE_KV;
  if (!kv) return;

  const subs = JSON.parse((await kv.get('group_subscriptions')) || '{}');
  const ONE_HOUR = 60 * 60 * 1000;
  const staleChatIds = Object.entries(subs)
    .filter(([, entry]) => entry.subscribed && (!entry.lastSent || Date.now() - new Date(entry.lastSent).getTime() >= ONE_HOUR))
    .map(([chatId]) => chatId);

  for (const chatId of staleChatIds) {
    await syncGroupStatus(env, chatId);
  }
}

async function processScheduledMessages(env) {
  const kv = env.PEOPLE_KV;
  if (!kv) return;

  let scheduled = JSON.parse((await kv.get('scheduled_messages')) || '[]');
  if (scheduled.length === 0) return;

  const now = Date.now();
  let changed = false;

  for (const entry of scheduled) {
    if (entry.sent) continue;
    if (new Date(entry.sendAt).getTime() > now) continue;

    const targets = [];
    if (entry.target === 'all_groups') {
      const known = JSON.parse((await kv.get('known_groups')) || '{}');
      const subs = JSON.parse((await kv.get('group_subscriptions')) || '{}');
      for (const chatId of Object.keys(known)) {
        targets.push({ chatId, threadId: subs[chatId] ? subs[chatId].threadId : null });
      }
    } else if (entry.target === 'all_employees') {
      const bindings = JSON.parse((await kv.get('telegram_bindings')) || '{}');
      for (const chatId of Object.values(bindings)) targets.push({ chatId, threadId: null });
    } else if (entry.chatId) {
      targets.push({ chatId: entry.chatId, threadId: entry.threadId || null });
    }

    for (const t of targets) {
      await sendTelegramMessage(env, t.chatId, entry.text, t.threadId);
    }

    changed = true;
    if (entry.repeat === 'daily') {
      entry.sendAt = new Date(new Date(entry.sendAt).getTime() + 24 * 60 * 60 * 1000).toISOString();
    } else if (entry.repeat === 'weekly') {
      entry.sendAt = new Date(new Date(entry.sendAt).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    } else {
      entry.sent = true;
    }
  }

  // чистим старые одноразовые отправленные записи (старше 7 дней)
  scheduled = scheduled.filter((e) => {
    if (!e.sent) return true;
    const age = now - new Date(e.sendAt).getTime();
    return age < 7 * 24 * 60 * 60 * 1000;
  });

  if (changed) {
    await kv.put('scheduled_messages', JSON.stringify(scheduled));
  }
}

async function appendLog(env, entry) {
  const kv = env.PEOPLE_KV;
  if (!kv) return;
  const log = JSON.parse((await kv.get('audit_log')) || '[]');
  log.push({ ts: new Date().toISOString(), ...entry });
  // храним последние 300 записей, чтобы не раздувать хранилище
  const trimmed = log.slice(-300);
  await kv.put('audit_log', JSON.stringify(trimmed));
}

async function recordLastSeen(env, login) {
  const kv = env.PEOPLE_KV;
  if (!kv) return;
  const map = JSON.parse((await kv.get('last_seen')) || '{}');
  map[login] = new Date().toISOString();
  await kv.put('last_seen', JSON.stringify(map));
}

async function handleApi(request, env) {
  const secret = env.STADMIN_SECRET || 'default_secret_change_me';
  const kv = env.PEOPLE_KV;

  if (request.method === 'OPTIONS') {
    return new Response('', { status: 200, headers: corsHeaders() });
  }

  if (!kv) {
    return json({ error: 'KV не подключён. Настройте привязку PEOPLE_KV в дашборде Cloudflare (вкладка Bindings).' }, 500);
  }

  if (request.method === 'GET') {
    const list = sortPeople(JSON.parse((await kv.get('people')) || '[]'));
    return json(list);
  }

  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'Bad request' }, 400);
  }

  if (body.action === 'login') {
    const login = (body.login || '').trim();
    const password = body.password || '';

    if (login === SUPER_LOGIN && password === SUPER_PASSWORD) {
      const token = await signToken(secret, { login, role: 'superadmin' });
      await recordLastSeen(env, login);
      return json({ token, login, role: 'superadmin' });
    }

    const accounts = JSON.parse((await kv.get('accounts')) || '[]');
    const account = accounts.find((a) => a.login === login);
    if (account && account.passwordHash === (await hashPassword(secret, login, password))) {
      const token = await signToken(secret, { login, role: 'employee' });
      await recordLastSeen(env, login);
      return json({ token, login, role: 'employee' });
    }

    return json({ error: 'Неверный логин или пароль' }, 401);
  }

  const authHeader = request.headers.get('X-Auth-Token');
  const auth = await verifyToken(secret, authHeader);
  if (!auth) {
    return json({ error: 'Unauthorized' }, 401);
  }

  if (body.action === 'create_account') {
    if (auth.role !== 'superadmin') {
      return json({ error: 'Только St_admin1 может создавать логины' }, 403);
    }
    const login = (body.login || '').trim();
    const password = body.password || '';
    if (!login || !password) return json({ error: 'Укажите логин и пароль' }, 400);
    if (login === SUPER_LOGIN) return json({ error: 'Этот логин зарезервирован' }, 400);

    const accounts = JSON.parse((await kv.get('accounts')) || '[]');
    if (accounts.some((a) => a.login === login)) {
      return json({ error: 'Такой логин уже существует' }, 400);
    }
    accounts.push({ login, passwordHash: await hashPassword(secret, login, password) });
    await kv.put('accounts', JSON.stringify(accounts));
    return json({ ok: true, login });
  }

  if (body.action === 'list_accounts') {
    if (auth.role !== 'superadmin') return json({ error: 'Доступ запрещён' }, 403);
    const accounts = JSON.parse((await kv.get('accounts')) || '[]');
    const lastSeen = JSON.parse((await kv.get('last_seen')) || '{}');
    const result = accounts.map((a) => ({ login: a.login, lastLogin: lastSeen[a.login] || null, role: 'employee' }));
    result.unshift({ login: SUPER_LOGIN, lastLogin: lastSeen[SUPER_LOGIN] || null, role: 'superadmin' });
    return json(result);
  }

  if (body.action === 'delete_account') {
    if (auth.role !== 'superadmin') return json({ error: 'Доступ запрещён' }, 403);
    let accounts = JSON.parse((await kv.get('accounts')) || '[]');
    accounts = accounts.filter((a) => a.login !== body.login);
    await kv.put('accounts', JSON.stringify(accounts));
    return json({ ok: true });
  }

  if (body.action === 'request_telegram_link') {
    const pending = JSON.parse((await kv.get('telegram_pending')) || '{}');
    // убираем просроченные коды
    for (const c in pending) {
      if (pending[c].expires < Date.now()) delete pending[c];
    }
    const code = generateLinkCode();
    pending[code] = { login: auth.login, expires: Date.now() + 15 * 60 * 1000 };
    await kv.put('telegram_pending', JSON.stringify(pending));
    return json({ ok: true, code, botLink: `https://t.me/stokratAdmin_bot?start=${code}` });
  }

  if (body.action === 'telegram_status') {
    const bindings = JSON.parse((await kv.get('telegram_bindings')) || '{}');
    return json({ linked: !!bindings[auth.login] });
  }

  if (body.action === 'telegram_test') {
    const bindings = JSON.parse((await kv.get('telegram_bindings')) || '{}');
    const chatId = bindings[auth.login];
    if (!chatId) return json({ error: 'Telegram не привязан' }, 400);
    const result = await sendTelegramMessage(env, chatId, '🔔 Тестовое сообщение. Если вы его видите — уведомления настроены верно.');
    if (!result.ok) return json({ error: 'Telegram отклонил отправку: ' + result.description }, 502);
    return json({ ok: true });
  }

  if (body.action === 'telegram_unlink') {
    const bindings = JSON.parse((await kv.get('telegram_bindings')) || '{}');
    delete bindings[auth.login];
    await kv.put('telegram_bindings', JSON.stringify(bindings));
    return json({ ok: true });
  }

  // ---------- Управление ботом (только суперадмин) ----------

  if (body.action === 'bot_list_groups') {
    if (auth.role !== 'superadmin') return json({ error: 'Доступ запрещён' }, 403);
    const known = JSON.parse((await kv.get('known_groups')) || '{}');
    const subs = JSON.parse((await kv.get('group_subscriptions')) || '{}');
    const result = Object.entries(known).map(([chatId, info]) => ({
      chatId,
      title: info.title,
      type: info.type,
      subscribed: !!(subs[chatId] && subs[chatId].subscribed),
      threadId: subs[chatId] ? subs[chatId].threadId : null,
      lastSent: subs[chatId] ? subs[chatId].lastSent : null
    }));
    return json(result);
  }

  if (body.action === 'bot_toggle_group') {
    if (auth.role !== 'superadmin') return json({ error: 'Доступ запрещён' }, 403);
    if (!body.chatId) return json({ error: 'chatId обязателен' }, 400);
    await setGroupSubscribed(env, body.chatId, body.threadId || null, !!body.subscribed);
    if (body.subscribed) await syncGroupStatus(env, body.chatId);
    return json({ ok: true });
  }

  if (body.action === 'bot_send_message') {
    if (auth.role !== 'superadmin') return json({ error: 'Доступ запрещён' }, 403);
    if (!body.text) return json({ error: 'Текст обязателен' }, 400);

    const targets = [];
    if (body.target === 'all_groups') {
      const known = JSON.parse((await kv.get('known_groups')) || '{}');
      const subs = JSON.parse((await kv.get('group_subscriptions')) || '{}');
      for (const chatId of Object.keys(known)) {
        targets.push({ chatId, threadId: subs[chatId] ? subs[chatId].threadId : null });
      }
    } else if (body.target === 'all_employees') {
      const bindings = JSON.parse((await kv.get('telegram_bindings')) || '{}');
      for (const chatId of Object.values(bindings)) targets.push({ chatId, threadId: null });
    } else if (body.chatId) {
      targets.push({ chatId: body.chatId, threadId: body.threadId || null });
    } else {
      return json({ error: 'Не указана цель отправки' }, 400);
    }

    let sent = 0;
    let lastMessageId = null;
    for (const t of targets) {
      const result = await sendTelegramMessage(env, t.chatId, body.text, t.threadId);
      if (result.ok) {
        sent++;
        lastMessageId = result.messageId;
        if (body.target !== 'all_groups' && body.target !== 'all_employees' && body.chatId) {
          const subs = JSON.parse((await kv.get('group_subscriptions')) || '{}');
          if (subs[body.chatId]) {
            subs[body.chatId].lastCustomMessageId = result.messageId;
            await kv.put('group_subscriptions', JSON.stringify(subs));
          }
        }
      }
    }
    return json({ ok: true, sent, total: targets.length });
  }

  if (body.action === 'bot_delete_last_message') {
    if (auth.role !== 'superadmin') return json({ error: 'Доступ запрещён' }, 403);
    if (!body.chatId) return json({ error: 'chatId обязателен' }, 400);
    const subs = JSON.parse((await kv.get('group_subscriptions')) || '{}');
    const entry = subs[body.chatId];
    const messageId = (entry && entry.lastCustomMessageId) || (entry && entry.lastMessageId);
    if (!messageId) return json({ error: 'Нет сообщения для удаления' }, 400);
    await deleteTelegramMessage(env, body.chatId, messageId);
    if (entry) {
      if (entry.lastCustomMessageId === messageId) entry.lastCustomMessageId = null;
      if (entry.lastMessageId === messageId) entry.lastMessageId = null;
      subs[body.chatId] = entry;
      await kv.put('group_subscriptions', JSON.stringify(subs));
    }
    return json({ ok: true });
  }

  if (body.action === 'bot_schedule_message') {
    if (auth.role !== 'superadmin') return json({ error: 'Доступ запрещён' }, 403);
    if (!body.text || !body.sendAt) return json({ error: 'Текст и время обязательны' }, 400);
    const scheduled = JSON.parse((await kv.get('scheduled_messages')) || '[]');
    const entry = {
      id: crypto.randomUUID(),
      text: body.text,
      target: body.target || 'group',
      chatId: body.chatId || null,
      threadId: body.threadId || null,
      sendAt: body.sendAt,
      repeat: body.repeat || 'none', // none | daily | weekly
      sent: false,
      createdBy: auth.login,
      createdAt: new Date().toISOString()
    };
    scheduled.push(entry);
    await kv.put('scheduled_messages', JSON.stringify(scheduled));
    return json({ ok: true, id: entry.id });
  }

  if (body.action === 'bot_list_scheduled') {
    if (auth.role !== 'superadmin') return json({ error: 'Доступ запрещён' }, 403);
    const scheduled = JSON.parse((await kv.get('scheduled_messages')) || '[]');
    return json(scheduled.filter((s) => !s.sent || s.repeat !== 'none'));
  }

  if (body.action === 'bot_cancel_scheduled') {
    if (auth.role !== 'superadmin') return json({ error: 'Доступ запрещён' }, 403);
    if (!body.id) return json({ error: 'id обязателен' }, 400);
    let scheduled = JSON.parse((await kv.get('scheduled_messages')) || '[]');
    scheduled = scheduled.filter((s) => s.id !== body.id);
    await kv.put('scheduled_messages', JSON.stringify(scheduled));
    return json({ ok: true });
  }

  // ---------- Заявки от пользователей через бота (видят все залогиненные) ----------

  if (body.action === 'list_pending_applications') {
    const applications = JSON.parse((await kv.get('pending_applications')) || '[]');
    return json(applications);
  }

  if (body.action === 'accept_application') {
    if (!body.id) return json({ error: 'id обязателен' }, 400);
    const applications = JSON.parse((await kv.get('pending_applications')) || '[]');
    const appEntry = applications.find((a) => a.id === body.id);
    if (!appEntry) return json({ error: 'Заявка не найдена' }, 404);

    const peopleList = JSON.parse((await kv.get('people')) || '[]');
    const person = {
      id: crypto.randomUUID(),
      nick: appEntry.roblox,
      uz: appEntry.telegram,
      ds: appEntry.discord,
      post: '',
      createdAt: new Date().toISOString(),
      addedBy: auth.login || '',
      accepted: false,
      requestSent: false
    };
    peopleList.push(person);
    await kv.put('people', JSON.stringify(peopleList));

    const remaining = applications.filter((a) => a.id !== body.id);
    await kv.put('pending_applications', JSON.stringify(remaining));

    await appendLog(env, {
      action: 'add',
      actor: auth.login,
      nick: person.nick,
      changes: []
    });

    const templates = await getBotTemplates(env);
    await sendTelegramMessage(env, appEntry.chatId, fillTemplate(templates.acceptApplication, appEntry));
    await syncGroupStatus(env);

    return json({ ok: true, person });
  }

  if (body.action === 'reject_application') {
    if (!body.id) return json({ error: 'id обязателен' }, 400);
    const applications = JSON.parse((await kv.get('pending_applications')) || '[]');
    const appEntry = applications.find((a) => a.id === body.id);
    if (!appEntry) return json({ error: 'Заявка не найдена' }, 404);

    const remaining = applications.filter((a) => a.id !== body.id);
    await kv.put('pending_applications', JSON.stringify(remaining));

    const templates = await getBotTemplates(env);
    await sendTelegramMessage(env, appEntry.chatId, fillTemplate(templates.rejectApplication, appEntry));

    return json({ ok: true });
  }

  if (body.action === 'get_bot_templates') {
    if (auth.role !== 'superadmin') return json({ error: 'Доступ запрещён' }, 403);
    return json(await getBotTemplates(env));
  }

  if (body.action === 'update_bot_templates') {
    if (auth.role !== 'superadmin') return json({ error: 'Доступ запрещён' }, 403);
    const current = await getBotTemplates(env);
    const updated = {
      acceptApplication: body.acceptApplication !== undefined ? body.acceptApplication : current.acceptApplication,
      rejectApplication: body.rejectApplication !== undefined ? body.rejectApplication : current.rejectApplication
    };
    await kv.put('bot_templates', JSON.stringify(updated));
    return json({ ok: true });
  }

  let list = JSON.parse((await kv.get('people')) || '[]');

  if (body.action === 'add') {
    const person = {
      id: crypto.randomUUID(),
      nick: (body.nick || '').trim(),
      uz: (body.uz || '').trim(),
      ds: (body.ds || '').trim(),
      post: (body.post || '').trim(),
      createdAt: new Date().toISOString(),
      addedBy: auth.login || '',
      accepted: false,
      requestSent: false
    };
    list.push(person);
    await kv.put('people', JSON.stringify(list));
    await appendLog(env, { actor: auth.login, action: 'add', personId: person.id, nick: person.nick });
    await syncGroupStatus(env);
    return json(person);
  }

  if (body.action === 'update') {
    if (!body.id) return json({ error: 'id обязателен' }, 400);
    let found = false;
    let changes = [];
    let targetNick = '';
    list = list.map((p) => {
      if (p.id === body.id) {
        found = true;
        targetNick = p.nick;
        const updated = {
          ...p,
          nick: body.nick !== undefined ? body.nick.trim() : p.nick,
          uz: body.uz !== undefined ? body.uz.trim() : p.uz,
          ds: body.ds !== undefined ? body.ds.trim() : p.ds,
          post: body.post !== undefined ? body.post.trim() : p.post,
          accepted: body.accepted !== undefined ? !!body.accepted : p.accepted,
          requestSent: body.requestSent !== undefined ? !!body.requestSent : p.requestSent
        };
        for (const field of ['nick', 'uz', 'ds', 'post', 'accepted', 'requestSent']) {
          if (updated[field] !== p[field]) {
            changes.push({ field, from: p[field], to: updated[field] });
          }
        }
        return updated;
      }
      return p;
    });
    if (!found) return json({ error: 'Не найдено' }, 404);
    await kv.put('people', JSON.stringify(list));
    if (changes.length > 0) {
      await appendLog(env, { actor: auth.login, action: 'update', personId: body.id, nick: targetNick, changes });
    }
    await syncGroupStatus(env);
    return json({ ok: true });
  }

  if (body.action === 'delete') {
    if (!body.id) return json({ error: 'id обязателен' }, 400);
    const target = list.find((p) => p.id === body.id);
    list = list.filter((p) => p.id !== body.id);
    await kv.put('people', JSON.stringify(list));
    await appendLog(env, { actor: auth.login, action: 'delete', personId: body.id, nick: target ? target.nick : '' });
    await syncGroupStatus(env);
    return json({ ok: true });
  }

  if (body.action === 'list_logs') {
    const log = JSON.parse((await kv.get('audit_log')) || '[]');
    return json([...log].reverse());
  }

  return json({ error: 'Неизвестное действие' }, 400);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api') {
      return handleApi(request, env);
    }

    if (url.pathname === '/telegram-webhook') {
      return handleTelegramWebhook(request, env);
    }

    // Всё остальное — статические файлы (index.html и т.д.)
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    if (event.cron === '*/15 * * * *') {
      ctx.waitUntil(maybeRefreshGroupStatus(env));
      ctx.waitUntil(processScheduledMessages(env));
    } else {
      ctx.waitUntil(handleScheduled(env));
    }
  }
};
