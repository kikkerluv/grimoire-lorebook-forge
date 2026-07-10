// Grimoire — Lorebook Forge
// A SillyTavern extension: generate World Info (lorebook) entries with your own
// LLM connection, then push them straight into an open lorebook via STscript.

const EXT_ID = 'grimoireLorebookForge';
const EXT_NAME = 'Grimoire — Lorebook Forge';

const DEFAULT_SETTINGS = {
  format: 'openai',
  endpoint: '',
  apiKey: '',
  model: '',
  targetBook: ''
};

function getCtx() {
  return SillyTavern.getContext();
}

function getSettings() {
  const ctx = getCtx();
  if (!ctx.extensionSettings[EXT_ID]) {
    ctx.extensionSettings[EXT_ID] = { ...DEFAULT_SETTINGS };
  }
  // backfill any keys added in later versions
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (!(k in ctx.extensionSettings[EXT_ID])) ctx.extensionSettings[EXT_ID][k] = DEFAULT_SETTINGS[k];
  }
  return ctx.extensionSettings[EXT_ID];
}

function persist() {
  const ctx = getCtx();
  try {
    if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
  } catch (e) {
    console.warn('[Grimoire] saveSettingsDebounced not available, settings kept in memory only', e);
  }
}

// ---------- STscript bridge ----------
// This is the officially documented way to manipulate World Info from an
// extension: STscript commands /createentry and /setentryfield.
// https://docs.sillytavern.app/usage/st-script/
async function runSlash(cmd) {
  const ctx = getCtx();
  if (typeof ctx.executeSlashCommandsWithOptions === 'function') {
    const result = await ctx.executeSlashCommandsWithOptions(cmd, { showOutput: false });
    return result && typeof result === 'object' && 'pipe' in result ? result.pipe : result;
  }
  if (typeof ctx.executeSlashCommands === 'function') {
    return await ctx.executeSlashCommands(cmd);
  }
  throw new Error(
    'Не нашла метод выполнения слэш-команд в этой версии SillyTavern (executeSlashCommandsWithOptions/executeSlashCommands). ' +
    'Откройте консоль браузера, наберите SillyTavern.getContext() и проверьте актуальное имя метода.'
  );
}

function escapeForSlash(text) {
  // STscript uses | as a command separator and {{ }} for macros — neutralize both
  // so generated lore text can't break the script or get mis-parsed as a macro.
  return String(text || '')
    .replace(/\{\{/g, '{ {')
    .replace(/\}\}/g, '} }')
    .replace(/\|/g, '¦');
}

async function getCurrentChatBook() {
  try {
    const name = await runSlash('/getchatbook');
    return (name || '').trim();
  } catch (e) {
    return '';
  }
}

async function pushEntryToBook(bookName, { name, keys, content, constant }) {
  const book = bookName.trim();
  if (!book) throw new Error('Укажите имя лорбука в SillyTavern.');
  const keyArg = (keys || []).map(k => k.trim()).filter(Boolean).join(',');
  const createCmd = `/createentry file=${quoteArg(book)} key=${quoteArg(keyArg || 'ключ')} ${escapeForSlash(content)}`;
  const uid = await runSlash(createCmd);
  if (uid === undefined || uid === null || uid === '') {
    throw new Error('Не получила UID новой записи — проверьте, что лорбук с таким именем существует и открыт в SillyTavern.');
  }
  if (name) {
    await runSlash(`/setentryfield file=${quoteArg(book)} uid=${quoteArg(uid)} field=comment ${escapeForSlash(name)}`);
  }
  if (constant) {
    await runSlash(`/setentryfield file=${quoteArg(book)} uid=${quoteArg(uid)} field=constant true`);
  }
  return uid;
}

function quoteArg(v) {
  const s = String(v);
  return /\s/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

// ---------- LLM call (same logic as the standalone Grimoire web app) ----------
function buildSystemPrompt() {
  return 'Ты помощник для создания записей лорбука (World Info) для AI ролевого чата в стиле SillyTavern. ' +
    'По промту пользователя создай ОДНУ запись лорбука. Отвечай СТРОГО в формате JSON, без markdown и пояснений, ровно такой структуры: ' +
    '{"name": "короткое название записи", "keys": ["ключ1", "ключ2", "ключ3"], "content": "текст записи"}. ' +
    'name — краткое название записи (2-5 слов). ' +
    'keys — от 2 до 6 слов-триггеров, которые могут встретиться в переписке. ' +
    'content — сама лор-информация: 2-5 предложений, компактно, от третьего лица, без markdown.';
}

function extractJson(text) {
  let t = text.trim().replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
  try { return JSON.parse(t); } catch (e) {}
  const m = t.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
  throw new Error('Не удалось разобрать ответ модели как JSON');
}

async function callModel(userPrompt) {
  const s = getSettings();
  if (!s.endpoint || !s.apiKey || !s.model) {
    throw new Error('Заполните эндпоинт, ключ и модель в настройках Grimoire');
  }
  const systemPrompt = buildSystemPrompt();
  if (s.format === 'anthropic') {
    const res = await fetch(s.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': s.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({ model: s.model, max_tokens: 800, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }] })
    });
    if (!res.ok) throw new Error('API вернул ошибку ' + res.status);
    const data = await res.json();
    const block = (data.content || []).find(b => b.type === 'text');
    if (!block) throw new Error('В ответе нет текстового блока');
    return extractJson(block.text);
  }
  const res = await fetch(s.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Authorization': 'Bearer ' + s.apiKey },
    body: JSON.stringify({
      model: s.model,
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      temperature: 0.9
    })
  });
  if (!res.ok) throw new Error('API вернул ошибку ' + res.status);
  const data = await res.json();
  const msg = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!msg) throw new Error('В ответе нет choices[0].message.content');
  return extractJson(msg);
}

// ---------- UI ----------
function panelHtml() {
  return `
  <div class="grimoire-panel inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header grimoire-header">
      <b>🐸 Grimoire — Lorebook Forge</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content grimoire-content">

      <div class="grimoire-section">
        <div class="grimoire-label">Формат запроса</div>
        <select id="grimFormat" class="text_pole grimoire-input">
          <option value="openai">OpenAI-совместимый (chat/completions)</option>
          <option value="anthropic">Anthropic-совместимый (messages)</option>
        </select>
        <div class="grimoire-label">Эндпоинт</div>
        <input id="grimEndpoint" class="text_pole grimoire-input" placeholder="https://api.openai.com/v1/chat/completions" />
        <div class="grimoire-label">API-ключ</div>
        <input id="grimKey" type="password" class="text_pole grimoire-input" placeholder="sk-..." />
        <div class="grimoire-label">Модель</div>
        <input id="grimModel" class="text_pole grimoire-input" placeholder="gpt-4o-mini / claude-sonnet-4-5" />
        <div class="grimoire-row">
          <button id="grimSaveSettings" class="menu_button grimoire-btn">Сохранить подключение</button>
          <span id="grimSettingsStatus" class="grimoire-status"></span>
        </div>
      </div>

      <hr class="grimoire-hr" />

      <div class="grimoire-section">
        <div class="grimoire-label">Лорбук-получатель</div>
        <div class="grimoire-row">
          <input id="grimBook" class="text_pole grimoire-input" placeholder="Имя лорбука в SillyTavern" />
          <button id="grimUseChatBook" class="menu_button grimoire-btn" title="Подставить лорбук, привязанный к текущему чату/персонажу">Текущий чата</button>
        </div>

        <div class="grimoire-label">Промт для новой записи</div>
        <textarea id="grimPrompt" class="text_pole grimoire-input grimoire-textarea" placeholder="Например: Иван Кузнецов — старый кузнец города, делает мечи для стражи"></textarea>
        <div class="grimoire-row">
          <button id="grimGenerate" class="menu_button grimoire-btn">✦ Сгенерировать</button>
          <label class="grimoire-checkbox"><input type="checkbox" id="grimConstant" /> Всегда активна</label>
          <span id="grimGenStatus" class="grimoire-status"></span>
        </div>

        <div class="grimoire-label">Название</div>
        <input id="grimResultName" class="text_pole grimoire-input" placeholder="Появится после генерации" />
        <div class="grimoire-label">Ключи (через запятую)</div>
        <input id="grimResultKeys" class="text_pole grimoire-input" placeholder="ключ1, ключ2, ключ3" />
        <div class="grimoire-label">Текст записи</div>
        <textarea id="grimResultContent" class="text_pole grimoire-input grimoire-textarea" placeholder="Появится после генерации"></textarea>

        <div class="grimoire-row">
          <button id="grimSend" class="menu_button grimoire-btn grimoire-btn-primary">📥 Отправить в лорбук</button>
          <span id="grimSendStatus" class="grimoire-status"></span>
        </div>
      </div>
    </div>
  </div>`;
}

function setStatus(el, text, isErr) {
  el.text(text);
  el.css('color', isErr ? '#d97a9c' : '#8bcf7d');
}

jQuery(async () => {
  const settings = getSettings();
  const $panel = $(panelHtml());
  $('#extensions_settings2').append($panel);

  const $format = $panel.find('#grimFormat');
  const $endpoint = $panel.find('#grimEndpoint');
  const $key = $panel.find('#grimKey');
  const $model = $panel.find('#grimModel');
  const $book = $panel.find('#grimBook');
  const $prompt = $panel.find('#grimPrompt');
  const $constant = $panel.find('#grimConstant');
  const $resultName = $panel.find('#grimResultName');
  const $resultKeys = $panel.find('#grimResultKeys');
  const $resultContent = $panel.find('#grimResultContent');

  $format.val(settings.format);
  $endpoint.val(settings.endpoint);
  $key.val(settings.apiKey);
  $model.val(settings.model);
  $book.val(settings.targetBook);

  $panel.find('#grimSaveSettings').on('click', () => {
    settings.format = $format.val();
    settings.endpoint = $endpoint.val().trim();
    settings.apiKey = $key.val().trim();
    settings.model = $model.val().trim();
    persist();
    setStatus($panel.find('#grimSettingsStatus'), '✓ Сохранено', false);
  });

  $book.on('change', () => {
    settings.targetBook = $book.val().trim();
    persist();
  });

  $panel.find('#grimUseChatBook').on('click', async () => {
    const statusEl = $panel.find('#grimSettingsStatus');
    try {
      const name = await getCurrentChatBook();
      if (!name) { setStatus(statusEl, 'У текущего чата/персонажа нет привязанного лорбука', true); return; }
      $book.val(name);
      settings.targetBook = name;
      persist();
      setStatus(statusEl, '✓ Подставлен «' + name + '»', false);
    } catch (e) {
      setStatus(statusEl, 'Не удалось получить лорбук чата: ' + e.message, true);
    }
  });

  $panel.find('#grimGenerate').on('click', async () => {
    const statusEl = $panel.find('#grimGenStatus');
    const promptText = $prompt.val().trim();
    if (!promptText) { setStatus(statusEl, 'Сначала напишите промт', true); return; }
    setStatus(statusEl, 'Генерирую…', false);
    try {
      const result = await callModel(promptText);
      $resultName.val(typeof result.name === 'string' ? result.name : '');
      $resultKeys.val(Array.isArray(result.keys) ? result.keys.join(', ') : '');
      $resultContent.val(typeof result.content === 'string' ? result.content : '');
      setStatus(statusEl, '✓ Готово', false);
    } catch (e) {
      setStatus(statusEl, e.message || 'Ошибка генерации', true);
    }
  });

  $panel.find('#grimSend').on('click', async () => {
    const statusEl = $panel.find('#grimSendStatus');
    const book = $book.val().trim();
    if (!book) { setStatus(statusEl, 'Укажите лорбук-получатель выше', true); return; }
    if (!$resultContent.val().trim()) { setStatus(statusEl, 'Сначала сгенерируйте (или впишите) текст записи', true); return; }
    setStatus(statusEl, 'Отправляю…', false);
    try {
      const keys = $resultKeys.val().split(',').map(k => k.trim()).filter(Boolean);
      await pushEntryToBook(book, {
        name: $resultName.val().trim(),
        keys,
        content: $resultContent.val().trim(),
        constant: $constant.prop('checked')
      });
      setStatus(statusEl, '✓ Запись добавлена в «' + book + '»', false);
    } catch (e) {
      setStatus(statusEl, e.message || 'Не удалось отправить запись', true);
    }
  });

  console.log(`[${EXT_NAME}] loaded`);
});
