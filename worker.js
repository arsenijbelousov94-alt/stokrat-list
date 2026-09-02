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

async function sendTelegramMessage(env, chatId, text, threadId, replyMarkup) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, description: 'TELEGRAM_BOT_TOKEN не задан' };
  const payload = { chat_id: chatId, text };
  if (threadId) payload.message_thread_id = threadId;
  if (replyMarkup) payload.reply_markup = replyMarkup;
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

async function answerCallbackQuery(env, callbackQueryId, text) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text })
  });
}

async function editMessageReplyMarkup(env, chatId, messageId, text) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text })
  });
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

async function acceptApplicationById(env, id, actorLogin) {
  const kv = env.PEOPLE_KV;
  const applications = JSON.parse((await kv.get('pending_applications')) || '[]');
  const appEntry = applications.find((a) => a.id === id);
  if (!appEntry) return { ok: false, error: 'Заявка не найдена' };

  const peopleList = JSON.parse((await kv.get('people')) || '[]');
  const person = {
    id: crypto.randomUUID(),
    nick: appEntry.roblox,
    uz: appEntry.telegram,
    ds: appEntry.discord,
    post: '',
    createdAt: new Date().toISOString(),
    addedBy: actorLogin || '',
    accepted: false,
    requestSent: false
  };
  peopleList.push(person);
  await kv.put('people', JSON.stringify(peopleList));

  const remaining = applications.filter((a) => a.id !== id);
  await kv.put('pending_applications', JSON.stringify(remaining));

  await appendLog(env, { action: 'add', actor: actorLogin, nick: person.nick, changes: [] });

  const templates = await getBotTemplates(env);
  await sendTelegramMessage(env, appEntry.chatId, fillTemplate(templates.acceptApplication, appEntry));
  await syncGroupStatus(env);

  return { ok: true, person, appEntry };
}

async function rejectApplicationById(env, id) {
  const kv = env.PEOPLE_KV;
  const applications = JSON.parse((await kv.get('pending_applications')) || '[]');
  const appEntry = applications.find((a) => a.id === id);
  if (!appEntry) return { ok: false, error: 'Заявка не найдена' };

  const remaining = applications.filter((a) => a.id !== id);
  await kv.put('pending_applications', JSON.stringify(remaining));

  const templates = await getBotTemplates(env);
  await sendTelegramMessage(env, appEntry.chatId, fillTemplate(templates.rejectApplication, appEntry));

  return { ok: true, appEntry };
}

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

const ROLE_LABELS = {
  consul: 'Консул',
  curator: 'Куратор',
  sr_mod: 'Старший модератор',
  jr_mod: 'Младший модератор',
  content: 'Контент-креатор'
};

const APPLICATION_TEMPLATE = `Добро пожаловать! Чтобы подать заявку, ответьте 3 строками:

Roblox: ваш_юз
Telegram: ваш_юз
Discord: ваш_юз`;

// ---------- Web Push (уведомления в браузер/PWA без сторонних сервисов) ----------

function base64UrlToUint8Array(base64url) {
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

function uint8ArrayToBase64Url(bytes) {
  let str = '';
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getVapidSigningKey(env) {
  const pubBytes = base64UrlToUint8Array(env.VAPID_PUBLIC_KEY);
  const privBytes = base64UrlToUint8Array(env.VAPID_PRIVATE_KEY);
  const jwk = {
    kty: 'EC', crv: 'P-256', ext: true,
    x: uint8ArrayToBase64Url(pubBytes.slice(1, 33)),
    y: uint8ArrayToBase64Url(pubBytes.slice(33, 65)),
    d: uint8ArrayToBase64Url(privBytes)
  };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

async function sendWebPush(env, subscription) {
  const token = env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY;
  if (!token) return { ok: false };
  try {
    const url = new URL(subscription.endpoint);
    const aud = `${url.protocol}//${url.host}`;
    const header = { typ: 'JWT', alg: 'ES256' };
    const payload = { aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:admin@stokrat.local' };
    const encHeader = uint8ArrayToBase64Url(new TextEncoder().encode(JSON.stringify(header)));
    const encPayload = uint8ArrayToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
    const signingInput = `${encHeader}.${encPayload}`;
    const key = await getVapidSigningKey(env);
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(signingInput));
    const jwt = `${signingInput}.${uint8ArrayToBase64Url(new Uint8Array(signature))}`;

    const res = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
        'TTL': '86400'
      }
    });
    return { ok: res.ok || res.status === 201 };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function notifyPushSubscribers(env, title, body, url) {
  const kv = env.PEOPLE_KV;
  if (!kv) return;
  await kv.put('last_push_notification', JSON.stringify({
    id: crypto.randomUUID(), title, body, url: url || '/', ts: new Date().toISOString()
  }));

  const allSubs = JSON.parse((await kv.get('push_subscriptions')) || '{}');
  const deadEndpoints = [];
  for (const [login, subs] of Object.entries(allSubs)) {
    for (const sub of subs) {
      const result = await sendWebPush(env, sub);
      if (!result.ok) deadEndpoints.push({ login, endpoint: sub.endpoint });
    }
  }
  // чистим отписавшихся/недействительных подписчиков
  if (deadEndpoints.length > 0) {
    for (const { login, endpoint } of deadEndpoints) {
      if (allSubs[login]) {
        allSubs[login] = allSubs[login].filter((s) => s.endpoint !== endpoint);
      }
    }
    await kv.put('push_subscriptions', JSON.stringify(allSubs));
  }
}

async function verifyRobloxUsername(username) {
  try {
    const res = await fetch('https://users.roblox.com/v1/usernames/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usernames: [username], excludeBannedUsers: false })
    });
    if (!res.ok) return { checked: false, valid: true }; // не блокируем при сбое API
    const data = await res.json();
    const found = Array.isArray(data.data) && data.data.length > 0;
    return { checked: true, valid: found };
  } catch (e) {
    return { checked: false, valid: true }; // не блокируем при сетевой ошибке
  }
}

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

  // Нажатие на inline-кнопку (Принять/Отклонить заявку, выбор роли, и т.п.)
  if (update.callback_query) {
    const cq = update.callback_query;
    const data = cq.data || '';
    const fromId = cq.from && cq.from.id;

    // Выбор роли — доступно любому гостю, не только сотрудникам
    if (data.startsWith('role_pick:')) {
      const roleCode = data.split(':')[1];
      const roleLabel = ROLE_LABELS[roleCode] || roleCode;
      const tgUser = cq.from;
      const cqChatId = cq.message && cq.message.chat && cq.message.chat.id;

      if (!tgUser || !tgUser.username) {
        await answerCallbackQuery(env, cq.id, 'У вас нет публичного юза в Telegram');
        if (cqChatId) {
          await sendTelegramMessage(env, cqChatId, '⚠️ У вас не задан публичный юз в Telegram (username). Задайте его в настройках Telegram и попробуйте снова.');
        }
        return json({ ok: true });
      }

      const username = tgUser.username.toLowerCase();
      const people = JSON.parse((await kv.get('people')) || '[]');
      const match = people.find((p) => (p.uz || '').replace(/^@/, '').toLowerCase() === username);

      if (match) {
        const oldPost = match.post;
        match.post = roleLabel;
        await kv.put('people', JSON.stringify(people));
        await appendLog(env, {
          actor: 'бот (заявка на роль)', action: 'update', personId: match.id, nick: match.nick,
          changes: [{ field: 'post', from: oldPost, to: roleLabel }]
        });
        await syncGroupStatus(env);

        await answerCallbackQuery(env, cq.id, 'Роль назначена!');
        await sendTelegramMessage(env, cqChatId, `✅ Вам назначена роль «${roleLabel}» — вы найдены в реестре.`);

        const bindings2 = JSON.parse((await kv.get('telegram_bindings')) || '{}');
        for (const adminChatId of Object.values(bindings2)) {
          await sendTelegramMessage(env, adminChatId, `🎭 «${match.nick || username}» автоматически получил(а) роль «${roleLabel}» (найден в реестре).`);
        }
        await notifyPushSubscribers(env, '🎭 Роль назначена', `${match.nick || username}: ${roleLabel}`, '/');
      } else {
        await answerCallbackQuery(env, cq.id, 'Юз не найден в реестре');
        await sendTelegramMessage(env, cqChatId, '⚠️ Мы не нашли ваш юз в реестре. Возможно, в таблице устаревший юзернейм, либо он введён некорректно. Обратитесь к модераторам.');
      }
      return json({ ok: true });
    }

    const bindings = JSON.parse((await kv.get('telegram_bindings')) || '{}');
    const actorEntry = Object.entries(bindings).find(([, v]) => String(v) === String(fromId));
    const actorLogin = actorEntry ? actorEntry[0] : null;

    if (!actorLogin) {
      await answerCallbackQuery(env, cq.id, '⛔ Только для привязанных сотрудников');
      return json({ ok: true });
    }

    if (data.startsWith('app_accept:') || data.startsWith('app_reject:')) {
      const id = data.split(':')[1];
      const isAccept = data.startsWith('app_accept:');
      const result = isAccept
        ? await acceptApplicationById(env, id, actorLogin)
        : await rejectApplicationById(env, id);

      if (!result.ok) {
        await answerCallbackQuery(env, cq.id, 'Заявка уже обработана');
      } else {
        await answerCallbackQuery(env, cq.id, isAccept ? 'Принято' : 'Отклонено');
        const chatIdForEdit = cq.message && cq.message.chat && cq.message.chat.id;
        const messageIdForEdit = cq.message && cq.message.message_id;
        if (chatIdForEdit && messageIdForEdit) {
          const statusLine = isAccept ? `\n\n✅ Принято (${actorLogin})` : `\n\n❌ Отклонено (${actorLogin})`;
          const originalText = (cq.message.text || '') + statusLine;
          await editMessageReplyMarkup(env, chatIdForEdit, messageIdForEdit, originalText);
        }
      }
    }

    if (data.startsWith('rename_apply:') || data.startsWith('rename_ignore:')) {
      const renameId = data.split(':')[1];
      const isApply = data.startsWith('rename_apply:');
      const pending = JSON.parse((await kv.get('pending_renames')) || '{}');
      const entry = pending[renameId];

      if (!entry) {
        await answerCallbackQuery(env, cq.id, 'Уже обработано');
        return json({ ok: true });
      }

      delete pending[renameId];
      await kv.put('pending_renames', JSON.stringify(pending));

      if (isApply) {
        const people = JSON.parse((await kv.get('people')) || '[]');
        const person = people.find((p) => p.id === entry.personId);
        if (person) {
          const oldUz = person.uz;
          person.uz = entry.newUsername;
          await kv.put('people', JSON.stringify(people));
          await appendLog(env, {
            actor: actorLogin, action: 'update', personId: person.id, nick: person.nick,
            changes: [{ field: 'uz', from: oldUz, to: entry.newUsername }]
          });
        }
        await answerCallbackQuery(env, cq.id, 'Обновлено');
      } else {
        await answerCallbackQuery(env, cq.id, 'Проигнорировано');
      }

      const chatIdForEdit = cq.message && cq.message.chat && cq.message.chat.id;
      const messageIdForEdit = cq.message && cq.message.message_id;
      if (chatIdForEdit && messageIdForEdit) {
        const statusLine = isApply ? `\n\n✅ Обновлено (${actorLogin})` : `\n\n✖️ Проигнорировано (${actorLogin})`;
        await editMessageReplyMarkup(env, chatIdForEdit, messageIdForEdit, (cq.message.text || '') + statusLine);
      }
    }

    return json({ ok: true });
  }

  // Событие: кто-то вступил/вышел из группы (нужен allowed_updates с chat_member)
  // Заявка на вступление в супергруппу (если в группе включено одобрение новых участников)
  if (update.chat_join_request) {
    const req = update.chat_join_request;
    const chat = req.chat;
    const subs = JSON.parse((await kv.get('group_subscriptions')) || '{}');
    const entry = subs[chat.id];

    if (entry && entry.autoApprove && req.from && req.from.username) {
      const username = req.from.username.toLowerCase();
      const people = JSON.parse((await kv.get('people')) || '[]');
      const match = people.find((p) => (p.uz || '').replace(/^@/, '').toLowerCase() === username);

      if (match) {
        const result = await approveChatJoinRequest(env, chat.id, req.from.id);
        if (result.ok && req.user_chat_id) {
          await sendTelegramMessage(env, req.user_chat_id, `✅ Ваша заявка на вступление в «${chat.title}» одобрена автоматически — вы найдены в реестре.`);
        }
      }
    }
    return json({ ok: true });
  }

  if (update.chat_member && update.chat_member.chat) {
    const chat = update.chat_member.chat;
    const newMember = update.chat_member.new_chat_member;
    const oldStatus = update.chat_member.old_chat_member && update.chat_member.old_chat_member.status;
    if (newMember && newMember.status === 'member' && oldStatus !== 'member') {
      await recordSeenUser(env, chat.id, newMember.user);
      await checkUsernameChange(env, newMember.user);
      await checkUnrecognizedUser(env, chat.id, chat.title || 'Без названия', newMember.user, 'join');
    }
    return json({ ok: true });
  }

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

    // Сверка автора сообщения со списком известных юзов
    if (message.from) {
      await recordSeenUser(env, chatId, message.from);
      await checkUsernameChange(env, message.from);
      await checkUnrecognizedUser(env, chatId, message.chat.title || 'Без названия', message.from, 'message');
    }
  }

  if (!message.text) return json({ ok: true });
  const text = message.text.trim();

  // Если ждём данные анкеты от этого чата и это не команда — пробуем распарсить
  if (chatType === 'private' && !text.startsWith('/')) {
    const flow = JSON.parse((await kv.get('app_flow_state')) || '{}');
    if (flow[chatId] && flow[chatId].step === 'awaiting_data') {
      const parsed = parseApplicationText(text);
      if (parsed) {
        const robloxCheck = await verifyRobloxUsername(parsed.roblox);
        if (robloxCheck.checked && !robloxCheck.valid) {
          await sendTelegramMessage(env, chatId, `⚠️ Roblox-юз «${parsed.roblox}» не найден. Проверьте написание и отправьте данные заново.`);
          return json({ ok: true });
        }

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

        // Уведомляем всех привязанных сотрудников о новой заявке, с кнопками для быстрого решения
        const bindings = JSON.parse((await kv.get('telegram_bindings')) || '{}');
        const notifyText = `📝 Новая заявка на вступление!\n\nRoblox: ${appEntry.roblox}\nTelegram: ${appEntry.telegram}\nDiscord: ${appEntry.discord}`;
        const keyboard = {
          inline_keyboard: [[
            { text: '✅ Принять', callback_data: `app_accept:${appEntry.id}` },
            { text: '❌ Отклонить', callback_data: `app_reject:${appEntry.id}` }
          ]]
        };
        for (const adminChatId of Object.values(bindings)) {
          await sendTelegramMessage(env, adminChatId, notifyText, null, keyboard);
        }
        await notifyPushSubscribers(env, '📝 Новая заявка', `Roblox: ${appEntry.roblox} · Telegram: ${appEntry.telegram}`, '/');

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

    if (code === 'role') {
      const keyboard = {
        inline_keyboard: [
          [{ text: 'Консул', callback_data: 'role_pick:consul' }, { text: 'Куратор', callback_data: 'role_pick:curator' }],
          [{ text: 'Старший модератор', callback_data: 'role_pick:sr_mod' }],
          [{ text: 'Младший модератор', callback_data: 'role_pick:jr_mod' }],
          [{ text: 'Контент-креатор', callback_data: 'role_pick:content' }]
        ]
      };
      await sendTelegramMessage(env, chatId, 'Кем вы хотите стать?', null, keyboard);
      return json({ ok: true });
    }

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

  if (text.startsWith('/status')) {
    const senderId = message.from && message.from.id;
    const bindings = JSON.parse((await kv.get('telegram_bindings')) || '{}');
    const isLinkedEmployee = senderId && Object.values(bindings).some((v) => String(v) === String(senderId));
    if (!isLinkedEmployee) {
      await sendTelegramMessage(env, chatId, '⛔ Команда доступна только привязанным сотрудникам.', message.message_thread_id);
      return json({ ok: true });
    }

    const query = text.split(' ').slice(1).join(' ').trim().replace(/^@/, '').toLowerCase();
    if (!query) {
      await sendTelegramMessage(env, chatId, 'Использование: /status юз_или_ник', message.message_thread_id);
      return json({ ok: true });
    }

    const reply = await findPersonStatusText(env, query);
    await sendTelegramMessage(env, chatId, reply, message.message_thread_id);
    return json({ ok: true });
  }

  if (text.startsWith('/whois')) {
    const senderId = message.from && message.from.id;
    const bindings = JSON.parse((await kv.get('telegram_bindings')) || '{}');
    const isLinkedEmployee = senderId && Object.values(bindings).some((v) => String(v) === String(senderId));
    if (!isLinkedEmployee) {
      await sendTelegramMessage(env, chatId, '⛔ Команда доступна только привязанным сотрудникам.', message.message_thread_id);
      return json({ ok: true });
    }

    const replied = message.reply_to_message;
    if (!replied || !replied.from) {
      await sendTelegramMessage(env, chatId, 'Ответьте командой /whois на сообщение того человека, о ком хотите узнать.', message.message_thread_id);
      return json({ ok: true });
    }
    if (!replied.from.username) {
      await sendTelegramMessage(env, chatId, 'У этого пользователя нет публичного юза в Telegram — сверить с таблицей нельзя.', message.message_thread_id);
      return json({ ok: true });
    }

    const query = replied.from.username.toLowerCase();
    const reply = await findPersonStatusText(env, query);
    await sendTelegramMessage(env, chatId, reply, message.message_thread_id);
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

async function banChatMember(env, chatId, userId) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, description: 'TELEGRAM_BOT_TOKEN не задан' };
  const res = await fetch(`https://api.telegram.org/bot${token}/banChatMember`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, user_id: userId })
  });
  let data = {};
  try { data = await res.json(); } catch (e) {}
  return { ok: res.ok && data.ok, description: data.description || (res.ok ? '' : `HTTP ${res.status}`) };
}

async function approveChatJoinRequest(env, chatId, userId) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, description: 'TELEGRAM_BOT_TOKEN не задан' };
  const res = await fetch(`https://api.telegram.org/bot${token}/approveChatJoinRequest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, user_id: userId })
  });
  let data = {};
  try { data = await res.json(); } catch (e) {}
  return { ok: res.ok && data.ok, description: data.description || (res.ok ? '' : `HTTP ${res.status}`) };
}

async function notifyUsernameChange(env, person, oldUsername, newUsername) {
  const kv = env.PEOPLE_KV;
  const changes = JSON.parse((await kv.get('username_changes')) || '[]');
  const alreadyFlagged = changes.some((c) => c.personId === person.id && c.newUsername === newUsername);
  if (alreadyFlagged) return;

  changes.push({
    id: crypto.randomUUID(),
    personId: person.id,
    nick: person.nick,
    oldUsername,
    newUsername,
    detectedAt: new Date().toISOString()
  });
  await kv.put('username_changes', JSON.stringify(changes));

  await notifyPushSubscribers(env, '🔄 Смена юза', `${person.nick || '—'}: @${oldUsername} → @${newUsername}`, '/');

  const bindings = JSON.parse((await kv.get('telegram_bindings')) || '{}');
  const text = `🔄 У «${person.nick || '—'}» изменился Telegram-юз:\n\nБыл: @${oldUsername}\nСтал: @${newUsername}\n\nОбновите запись на сайте (вкладка «Смена юза»).`;
  for (const chatId of Object.values(bindings)) {
    await sendTelegramMessage(env, chatId, text);
  }
}

async function recordSeenUser(env, chatId, tgUser) {
  const kv = env.PEOPLE_KV;
  if (!kv || !tgUser || tgUser.is_bot) return;

  const userId = tgUser.id;
  const newUsername = tgUser.username ? tgUser.username.toLowerCase() : null;
  const THROTTLE_MS = 24 * 60 * 60 * 1000; // не чаще раза в сутки на человека, чтобы беречь лимит записи KV

  const byId = JSON.parse((await kv.get('seen_users_by_id')) || '{}');
  const prevEntry = byId[userId];

  const usernameChanged = prevEntry && prevEntry.username && newUsername && prevEntry.username !== newUsername;
  if (usernameChanged) {
    const people = JSON.parse((await kv.get('people')) || '[]');
    const match = people.find((p) => (p.uz || '').replace(/^@/, '').toLowerCase() === prevEntry.username);
    if (match) {
      await notifyUsernameChange(env, match, prevEntry.username, newUsername);
    }
  }

  const recentlyWritten = prevEntry && prevEntry.lastWriteAt && (Date.now() - new Date(prevEntry.lastWriteAt).getTime() < THROTTLE_MS);
  const chatAlreadyKnown = prevEntry && prevEntry.chats && prevEntry.chats[chatId];

  // Пишем в KV только если что-то реально изменилось, или прошло достаточно времени — экономим суточный лимит записи
  if (!usernameChanged && recentlyWritten && chatAlreadyKnown) return;

  byId[userId] = {
    username: newUsername,
    chats: { ...(prevEntry && prevEntry.chats), [chatId]: true },
    lastSeen: new Date().toISOString(),
    lastWriteAt: new Date().toISOString()
  };
  await kv.put('seen_users_by_id', JSON.stringify(byId));

  if (!newUsername) return;
  const seen = JSON.parse((await kv.get('seen_users')) || '{}');
  const entry = seen[newUsername] || { userId, chats: {} };
  entry.userId = userId;
  entry.chats[chatId] = true;
  entry.lastSeen = new Date().toISOString();
  seen[newUsername] = entry;
  await kv.put('seen_users', JSON.stringify(seen));
}

async function checkUsernameChange(env, tgUser) {
  const kv = env.PEOPLE_KV;
  if (!kv || !tgUser || tgUser.is_bot || !tgUser.username) return;

  const newUsername = tgUser.username.toLowerCase();
  const idMap = JSON.parse((await kv.get('user_id_map')) || '{}');
  const prev = idMap[tgUser.id];

  idMap[tgUser.id] = { username: newUsername, lastSeen: new Date().toISOString() };
  await kv.put('user_id_map', JSON.stringify(idMap));

  if (!prev || prev.username === newUsername) return;

  // Юз сменился — проверяем, не числился ли старый юз в таблице
  const people = JSON.parse((await kv.get('people')) || '[]');
  const match = people.find((p) => (p.uz || '').replace(/^@/, '').toLowerCase() === prev.username);
  if (!match) return;

  const renameId = crypto.randomUUID().slice(0, 8);
  const pending = JSON.parse((await kv.get('pending_renames')) || '{}');
  pending[renameId] = { personId: match.id, oldUsername: prev.username, newUsername, detectedAt: new Date().toISOString() };
  await kv.put('pending_renames', JSON.stringify(pending));

  const bindings = JSON.parse((await kv.get('telegram_bindings')) || '{}');
  const text = `⚠️ Юз изменился\n\nБыло: @${prev.username}\nСтало: @${newUsername}\n\nСовпадает с анкетой «${match.nick || '—'}». Обновить запись в таблице?`;
  const keyboard = {
    inline_keyboard: [[
      { text: '✅ Обновить', callback_data: `rename_apply:${renameId}` },
      { text: '✖️ Игнорировать', callback_data: `rename_ignore:${renameId}` }
    ]]
  };
  for (const adminChatId of Object.values(bindings)) {
    await sendTelegramMessage(env, adminChatId, text, null, keyboard);
  }
  await notifyPushSubscribers(env, '⚠️ Юз изменился', `@${prev.username} → @${newUsername} (анкета «${match.nick || '—'}»)`, '/');
}

async function checkUnrecognizedUser(env, chatId, chatTitle, tgUser, detectedVia) {
  const kv = env.PEOPLE_KV;
  if (!kv || !tgUser || tgUser.is_bot) return;

  // Смотрим только группы, где включено наблюдение за участниками
  const subs = JSON.parse((await kv.get('group_subscriptions')) || '{}');
  const entry = subs[chatId];
  if (!entry || !entry.memberWatch) return;

  const username = tgUser.username ? tgUser.username.toLowerCase() : null;

  // Сверяем с колонкой "Юз" (Telegram-юз) в основной таблице
  if (username) {
    const people = JSON.parse((await kv.get('people')) || '[]');
    const known = people.some((p) => (p.uz || '').replace(/^@/, '').toLowerCase() === username);
    if (known) return;
  }

  const dismissed = JSON.parse((await kv.get('dismissed_users')) || '{}');
  const dismissKey = `${chatId}:${tgUser.id}`;
  if (dismissed[dismissKey]) return;

  const flagged = JSON.parse((await kv.get('unrecognized_users')) || '[]');
  const alreadyFlagged = flagged.some((f) => String(f.chatId) === String(chatId) && String(f.userId) === String(tgUser.id));
  if (alreadyFlagged) return;

  flagged.push({
    id: crypto.randomUUID(),
    chatId: String(chatId),
    chatTitle,
    userId: tgUser.id,
    username: tgUser.username || null,
    firstName: tgUser.first_name || '',
    lastName: tgUser.last_name || '',
    detectedAt: new Date().toISOString(),
    detectedVia
  });
  await kv.put('unrecognized_users', JSON.stringify(flagged));

  const who = tgUser.username ? '@' + tgUser.username : (tgUser.first_name || 'кто-то');
  await notifyPushSubscribers(env, '👤 Неизвестный в группе', `${who} в «${chatTitle}» не найден в таблице`, '/');
}

function formatStatusCard(p, idx) {
  const reqStatus = p.accepted ? '—' : (p.requestSent ? 'Запрос отправлен' : 'Ждёт отправки модератором');
  return `№${idx + 1}\nНик: ${p.nick || '—'}\nЮз: ${p.uz || '—'}\nДС: ${p.ds || '—'}\nДолжность: ${p.post || '—'}\nПринят в клан: ${p.accepted ? 'Да' : 'Нет'}\nСтатус инвайта: ${reqStatus}\nДобавил: ${p.addedBy || '—'}\nДобавлен: ${formatMoscowDateBackend(p.createdAt)}`;
}

async function findPersonStatusText(env, query) {
  const kv = env.PEOPLE_KV;
  const people = sortPeople(JSON.parse((await kv.get('people')) || '[]'));
  const idx = people.findIndex((p) =>
    (p.nick || '').toLowerCase() === query ||
    (p.uz || '').replace(/^@/, '').toLowerCase() === query ||
    (p.ds || '').toLowerCase() === query
  );
  if (idx === -1) return `Ничего не найдено по «${query}».`;

  const p = people[idx];
  const reqStatus = p.accepted ? '—' : (p.requestSent ? 'Запрос отправлен' : 'Ждёт отправки модератором');
  return `№${idx + 1}\nНик: ${p.nick || '—'}\nЮз: ${p.uz || '—'}\nДС: ${p.ds || '—'}\nДолжность: ${p.post || '—'}\nПринят в клан: ${p.accepted ? 'Да' : 'Нет'}\nСтатус инвайта: ${reqStatus}\nДобавил: ${p.addedBy || '—'}\nДобавлен: ${formatMoscowDateBackend(p.createdAt)}`;
}

function formatMoscowDateBackend(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('ru-RU', {
      timeZone: 'Europe/Moscow',
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  } catch (e) {
    return '—';
  }
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
  const targets = (onlyChatId ? [onlyChatId] : Object.keys(subs)).filter((chatId) => subs[chatId] && subs[chatId].subscribed);
  if (targets.length === 0) return; // нет подписанных групп — писать нечего, экономим лимит

  const list = sortPeople(JSON.parse((await kv.get('people')) || '[]'));
  const text = buildStatusText(list);

  let changed = false;

  for (const chatId of targets) {
    const entry = subs[chatId];

    if (entry.lastMessageId) {
      await deleteTelegramMessage(env, chatId, entry.lastMessageId);
      entry.lastMessageId = null;
      changed = true;
    }

    if (text) {
      const result = await sendTelegramMessage(env, chatId, text, entry.threadId);
      if (result.ok && result.messageId) {
        entry.lastMessageId = result.messageId;
        changed = true;
      }
    }
    // Отмечаем время проверки в любом случае — иначе группа без непринятых анкет
    // будет бесконечно пере-проверяться каждые 15 минут вместо раза в час
    entry.lastSent = new Date().toISOString();
    subs[chatId] = entry;
    changed = true;
  }

  if (changed) {
    await kv.put('group_subscriptions', JSON.stringify(subs));
  }
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

function canEditPeople(auth) {
  return auth.role === 'superadmin' || auth.canEditList !== false;
}

function canModerate(auth) {
  return auth.role === 'superadmin' || auth.canEditList !== false || auth.canModerateApplications !== false;
}

async function recordLastSeen(env, login) {
  const kv = env.PEOPLE_KV;
  if (!kv) return;
  const map = JSON.parse((await kv.get('last_seen')) || '{}');
  const prev = map[login];
  // Не пишем повторно, если уже отмечались в последние 30 минут — экономим лимит записи KV
  if (prev && Date.now() - new Date(prev).getTime() < 30 * 60 * 1000) return;
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

    if (login === SUPER_LOGIN) {
      const overrideHash = await kv.get('superadmin_password_hash');
      const valid = overrideHash
        ? overrideHash === (await hashPassword(secret, login, password))
        : password === SUPER_PASSWORD;
      if (valid) {
        const token = await signToken(secret, { login, role: 'superadmin' });
        await recordLastSeen(env, login);
        return json({ token, login, role: 'superadmin', permissions: { canEditList: true, canModerateApplications: true } });
      }
      return json({ error: 'Неверный логин или пароль' }, 401);
    }

    const accounts = JSON.parse((await kv.get('accounts')) || '[]');
    const account = accounts.find((a) => a.login === login);
    if (account && account.passwordHash === (await hashPassword(secret, login, password))) {
      const permissions = {
        canEditList: account.canEditList !== false,
        canModerateApplications: account.canModerateApplications !== false
      };
      const token = await signToken(secret, { login, role: 'employee', ...permissions });
      await recordLastSeen(env, login);
      return json({ token, login, role: 'employee', permissions });
    }

    return json({ error: 'Неверный логин или пароль' }, 401);
  }

  if (body.action === 'get_vapid_public_key') {
    return json({ key: env.VAPID_PUBLIC_KEY || null });
  }

  if (body.action === 'get_last_push_notification') {
    const last = JSON.parse((await kv.get('last_push_notification')) || 'null');
    return json(last || {});
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
    const level = body.permissionLevel || 'full'; // full | moderator | viewer
    const canEditList = level !== 'viewer' && level !== 'moderator';
    const canModerateApplications = level !== 'viewer';
    accounts.push({
      login,
      passwordHash: await hashPassword(secret, login, password),
      canEditList,
      canModerateApplications
    });
    await kv.put('accounts', JSON.stringify(accounts));
    return json({ ok: true, login });
  }

  if (body.action === 'list_accounts') {
    if (auth.role !== 'superadmin') return json({ error: 'Доступ запрещён' }, 403);
    const accounts = JSON.parse((await kv.get('accounts')) || '[]');
    const lastSeen = JSON.parse((await kv.get('last_seen')) || '{}');
    const result = accounts.map((a) => ({
      login: a.login,
      lastLogin: lastSeen[a.login] || null,
      role: 'employee',
      canEditList: a.canEditList !== false,
      canModerateApplications: a.canModerateApplications !== false
    }));
    result.unshift({ login: SUPER_LOGIN, lastLogin: lastSeen[SUPER_LOGIN] || null, role: 'superadmin', canEditList: true, canModerateApplications: true });
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

  if (body.action === 'change_own_password') {
    const oldPassword = body.oldPassword || '';
    const newPassword = body.newPassword || '';
    if (!oldPassword || !newPassword) return json({ error: 'Укажите текущий и новый пароль' }, 400);
    if (newPassword.length < 4) return json({ error: 'Новый пароль слишком короткий (минимум 4 символа)' }, 400);

    if (auth.role === 'superadmin') {
      const overrideHash = await kv.get('superadmin_password_hash');
      const valid = overrideHash
        ? overrideHash === (await hashPassword(secret, auth.login, oldPassword))
        : oldPassword === SUPER_PASSWORD;
      if (!valid) return json({ error: 'Неверный текущий пароль' }, 400);
      await kv.put('superadmin_password_hash', await hashPassword(secret, auth.login, newPassword));
      return json({ ok: true });
    }

    const accounts = JSON.parse((await kv.get('accounts')) || '[]');
    const account = accounts.find((a) => a.login === auth.login);
    if (!account) return json({ error: 'Аккаунт не найден' }, 404);
    const oldHash = await hashPassword(secret, auth.login, oldPassword);
    if (account.passwordHash !== oldHash) return json({ error: 'Неверный текущий пароль' }, 400);
    account.passwordHash = await hashPassword(secret, auth.login, newPassword);
    await kv.put('accounts', JSON.stringify(accounts));
    return json({ ok: true });
  }

  if (body.action === 'save_push_subscription') {
    if (!body.subscription || !body.subscription.endpoint) return json({ error: 'subscription обязателен' }, 400);
    const allSubs = JSON.parse((await kv.get('push_subscriptions')) || '{}');
    const list = allSubs[auth.login] || [];
    const filtered = list.filter((s) => s.endpoint !== body.subscription.endpoint);
    filtered.push(body.subscription);
    allSubs[auth.login] = filtered;
    await kv.put('push_subscriptions', JSON.stringify(allSubs));
    return json({ ok: true });
  }

  if (body.action === 'remove_push_subscription') {
    if (!body.endpoint) return json({ error: 'endpoint обязателен' }, 400);
    const allSubs = JSON.parse((await kv.get('push_subscriptions')) || '{}');
    if (allSubs[auth.login]) {
      allSubs[auth.login] = allSubs[auth.login].filter((s) => s.endpoint !== body.endpoint);
      await kv.put('push_subscriptions', JSON.stringify(allSubs));
    }
    return json({ ok: true });
  }

  if (body.action === 'push_status') {
    const allSubs = JSON.parse((await kv.get('push_subscriptions')) || '{}');
    const list = allSubs[auth.login] || [];
    return json({ count: list.length });
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
      lastSent: subs[chatId] ? subs[chatId].lastSent : null,
      memberWatch: !!(subs[chatId] && subs[chatId].memberWatch),
      autoApprove: !!(subs[chatId] && subs[chatId].autoApprove)
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

  if (body.action === 'bot_toggle_member_watch') {
    if (auth.role !== 'superadmin') return json({ error: 'Доступ запрещён' }, 403);
    if (!body.chatId) return json({ error: 'chatId обязателен' }, 400);
    const subs = JSON.parse((await kv.get('group_subscriptions')) || '{}');
    const existing = subs[body.chatId] || { subscribed: false, threadId: null };
    existing.memberWatch = !!body.watch;
    subs[body.chatId] = existing;
    await kv.put('group_subscriptions', JSON.stringify(subs));
    return json({ ok: true });
  }

  if (body.action === 'bot_toggle_auto_approve') {
    if (auth.role !== 'superadmin') return json({ error: 'Доступ запрещён' }, 403);
    if (!body.chatId) return json({ error: 'chatId обязателен' }, 400);
    const subs = JSON.parse((await kv.get('group_subscriptions')) || '{}');
    const existing = subs[body.chatId] || { subscribed: false, threadId: null };
    existing.autoApprove = !!body.enabled;
    subs[body.chatId] = existing;
    await kv.put('group_subscriptions', JSON.stringify(subs));
    return json({ ok: true });
  }

  if (body.action === 'list_unrecognized_users') {
    const flagged = JSON.parse((await kv.get('unrecognized_users')) || '[]');
    return json(flagged);
  }

  if (body.action === 'resolve_unrecognized_user') {
    if (!canModerate(auth)) return json({ error: 'Недостаточно прав' }, 403);
    if (!body.id || !body.decision) return json({ error: 'id и decision обязательны' }, 400);
    const flagged = JSON.parse((await kv.get('unrecognized_users')) || '[]');
    const entry = flagged.find((f) => f.id === body.id);
    if (!entry) return json({ error: 'Запись не найдена' }, 404);

    const remaining = flagged.filter((f) => f.id !== body.id);
    await kv.put('unrecognized_users', JSON.stringify(remaining));

    if (body.decision === 'keep') {
      const dismissed = JSON.parse((await kv.get('dismissed_users')) || '{}');
      dismissed[`${entry.chatId}:${entry.userId}`] = true;
      await kv.put('dismissed_users', JSON.stringify(dismissed));
      return json({ ok: true });
    }

    if (body.decision === 'block') {
      const result = await banChatMember(env, entry.chatId, entry.userId);
      if (!result.ok) return json({ error: 'Не удалось заблокировать: ' + result.description }, 502);
      return json({ ok: true });
    }

    return json({ error: 'Неизвестное решение' }, 400);
  }

  if (body.action === 'list_username_changes') {
    const changes = JSON.parse((await kv.get('username_changes')) || '[]');
    return json(changes);
  }

  if (body.action === 'resolve_username_change') {
    if (!canModerate(auth)) return json({ error: 'Недостаточно прав' }, 403);
    if (!body.id || !body.decision) return json({ error: 'id и decision обязательны' }, 400);
    const changes = JSON.parse((await kv.get('username_changes')) || '[]');
    const entry = changes.find((c) => c.id === body.id);
    if (!entry) return json({ error: 'Запись не найдена' }, 404);

    const remaining = changes.filter((c) => c.id !== body.id);
    await kv.put('username_changes', JSON.stringify(remaining));

    if (body.decision === 'apply') {
      const people = JSON.parse((await kv.get('people')) || '[]');
      const person = people.find((p) => p.id === entry.personId);
      if (person) {
        person.uz = entry.newUsername;
        await kv.put('people', JSON.stringify(people));
        await appendLog(env, {
          actor: auth.login, action: 'update', personId: person.id, nick: person.nick,
          changes: [{ field: 'uz', from: entry.oldUsername, to: entry.newUsername }]
        });
      }
    }

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
    if (!canModerate(auth)) return json({ error: 'Недостаточно прав' }, 403);
    if (!body.id) return json({ error: 'id обязателен' }, 400);
    const result = await acceptApplicationById(env, body.id, auth.login || '');
    if (!result.ok) return json({ error: result.error }, 404);
    return json({ ok: true, person: result.person });
  }

  if (body.action === 'reject_application') {
    if (!canModerate(auth)) return json({ error: 'Недостаточно прав' }, 403);
    if (!body.id) return json({ error: 'id обязателен' }, 400);
    const result = await rejectApplicationById(env, body.id);
    if (!result.ok) return json({ error: result.error }, 404);
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
    if (!canEditPeople(auth)) return json({ error: 'Недостаточно прав' }, 403);
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
    const wantsFieldEdit = ['nick', 'uz', 'ds', 'post'].some((f) => body[f] !== undefined);
    const wantsStatusEdit = ['accepted', 'requestSent'].some((f) => body[f] !== undefined);
    if (wantsFieldEdit && !canEditPeople(auth)) return json({ error: 'Недостаточно прав для редактирования полей' }, 403);
    if (wantsStatusEdit && !canModerate(auth)) return json({ error: 'Недостаточно прав' }, 403);

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
    // Синхронизируем группу только если изменение реально влияет на список непринятых —
    // экономим суточный лимит записи KV, не трогая уже принятых людей зря
    const finalPerson = list.find((p) => p.id === body.id);
    const affectsGroupView = changes.some((c) => c.field === 'accepted' || c.field === 'requestSent' || c.field === 'nick')
      || (finalPerson && !finalPerson.accepted);
    if (affectsGroupView) {
      await syncGroupStatus(env);
    }
    return json({ ok: true });
  }

  if (body.action === 'send_reminder') {
    if (!body.id) return json({ error: 'id обязателен' }, 400);
    const person = list.find((p) => p.id === body.id);
    if (!person) return json({ error: 'Не найдено' }, 404);
    if (!person.addedBy) return json({ error: 'У анкеты не указан добавивший' }, 400);

    const bindings = JSON.parse((await kv.get('telegram_bindings')) || '{}');
    const targetChatId = bindings[person.addedBy];
    if (!targetChatId) return json({ error: `У «${person.addedBy}» не привязан Telegram` }, 400);

    const reqStatus = person.requestSent ? 'Запрос отправлен' : 'Ждёт отправки модератором';
    const reminderText = `⏰ Напоминание по анкете\n\nНик: ${person.nick || '—'}\nЮз: ${person.uz || '—'}\nДС: ${person.ds || '—'}\nСтатус инвайта: ${reqStatus}\n\nВы добавили эту анкету — проверьте, пожалуйста, статус.`;
    const result = await sendTelegramMessage(env, targetChatId, reminderText);
    if (!result.ok) return json({ error: 'Не удалось отправить: ' + result.description }, 502);
    return json({ ok: true });
  }

  if (body.action === 'delete') {
    if (!canEditPeople(auth)) return json({ error: 'Недостаточно прав' }, 403);
    if (!body.id) return json({ error: 'id обязателен' }, 400);
    const target = list.find((p) => p.id === body.id);
    list = list.filter((p) => p.id !== body.id);
    await kv.put('people', JSON.stringify(list));
    await appendLog(env, { actor: auth.login, action: 'delete', personId: body.id, nick: target ? target.nick : '' });
    // Если удалённый уже был принят — в статус-сообщении группы его и так не было, синхронизировать незачем
    if (target && !target.accepted) {
      await syncGroupStatus(env);
    }

    // Автокик: если у удалённого есть телеграм-юз и он замечен в отслеживаемых группах — выгоняем
    if (target && target.uz) {
      const username = target.uz.replace(/^@/, '').toLowerCase();
      const seen = JSON.parse((await kv.get('seen_users')) || '{}');
      const seenEntry = seen[username];
      if (seenEntry) {
        const subs = JSON.parse((await kv.get('group_subscriptions')) || '{}');
        for (const chatId of Object.keys(seenEntry.chats || {})) {
          if (subs[chatId] && (subs[chatId].subscribed || subs[chatId].memberWatch)) {
            await banChatMember(env, chatId, seenEntry.userId);
          }
        }
      }
    }

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
