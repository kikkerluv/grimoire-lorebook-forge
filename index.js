// Grimoire — Lorebook Forge
// A SillyTavern extension: generate World Info (lorebook) entries with your own
// LLM connection, then push them straight into an open lorebook via STscript.

const EXT_ID = 'grimoireLorebookForge';
const EXT_NAME = 'Grimoire — Lorebook Forge';
const POPUP_ROOT_ID = 'grimoirePopupRoot';

const DEFAULT_SETTINGS = {
  format: 'openai',
  endpoint: '',
  apiKey: '',
  model: '',
  targetBook: '',
  drafts: [] // [{id, prompt, name, keys:[], content, constant}]
};

function getCtx() {
  return SillyTavern.getContext();
}

function getSettings() {
  const ctx = getCtx();
  if (!ctx.extensionSettings[EXT_ID]) {
    ctx.extensionSettings[EXT_ID] = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (!(k in ctx.extensionSettings[EXT_ID])) {
      ctx.extensionSettings[EXT_ID][k] = JSON.parse(JSON.stringify(DEFAULT_SETTINGS[k]));
    }
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

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

// ---------- STscript bridge ----------
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
    'Не нашла метод выполнения слэш-команд в этой версии SillyTavern. ' +
    'Откройте консоль браузера, наберите SillyTavern.getContext() и проверьте актуальное имя метода.'
  );
}

function escapeForSlash(text) {
  return String(text || '')
    .replace(/\{\{/g, '{ {')
    .replace(/\}\}/g, '} }')
    .replace(/\|/g, '¦');
}

function quoteArg(v) {
  const s = String(v);
  return /\s/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

async function getCurrentChatBook() {
  try {
    const name = await runSlash('/getchatbook');
    return (name || '').trim();
  } catch (e) {
    return '';
  }
}

// Officially added in ST for extensions: getContext().getWorldInfoNames().
// Falls back to an empty list on older ST versions that don't have it yet.
async function getWorldNames() {
  try {
    const ctx = getCtx();
    if (typeof ctx.getWorldInfoNames === 'function') {
      const result = await Promise.resolve(ctx.getWorldInfoNames());
      if (Array.isArray(result)) return result;
    }
  } catch (e) {
    console.warn('[Grimoire] getWorldInfoNames unavailable', e);
  }
  return [];
}

async function pushEntryToBook(bookName, { name, keys, content, constant }) {
  const book = bookName.trim();
  if (!book) throw new Error('Укажите имя лорбука в SillyTavern.');
  const keyArg = (keys || []).map(k => k.trim()).filter(Boolean).join(',');
  const createCmd = `/createentry file=${quoteArg(book)} key=${quoteArg(keyArg || 'ключ')} ${escapeForSlash(content)}`;
  const uidVal = await runSlash(createCmd);
  if (uidVal === undefined || uidVal === null || uidVal === '') {
    throw new Error('Не получила UID новой записи — проверьте, что лорбук с таким именем существует и открыт в SillyTavern.');
  }
  if (name) {
    await runSlash(`/setentryfield file=${quoteArg(book)} uid=${quoteArg(uidVal)} field=comment ${escapeForSlash(name)}`);
  }
  if (constant) {
    await runSlash(`/setentryfield file=${quoteArg(book)} uid=${quoteArg(uidVal)} field=constant true`);
  }
  return uidVal;
}

// Creates a brand-new, empty-ish lorebook file by pushing one placeholder
// entry into it (SillyTavern's /createentry creates the file if it doesn't
// exist yet). The placeholder entry is left in place — delete it manually
// in ST's World Info editor if you don't want it, or overwrite it later.
async function createNewBook(name) {
  const book = name.trim();
  if (!book) throw new Error('Введите имя нового лорбука.');
  const uidVal = await runSlash(
    `/createentry file=${quoteArg(book)} key=${quoteArg('черновик')} Заготовка. Можно удалить или отредактировать эту запись в редакторе World Info.`
  );
  if (uidVal === undefined || uidVal === null || uidVal === '') {
    throw new Error('Не удалось создать лорбук — проверьте консоль браузера.');
  }
  return book;
}

// ---------- LLM call ----------
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

// ---------- helpers ----------
function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;');
}
function setStatus($el, text, isErr) {
  $el.text(text);
  $el.css('color', isErr ? '#d97a9c' : '#8bcf7d');
}

// ---------- book picker (dropdown of existing lorebooks + clear + create) ----------
// idPrefix must be unique per instance (drawer vs popup) so ids don't clash.
function bookPickerHtml(idPrefix, currentValue) {
  return `
    <div class="grimoire-label">Лорбук-получатель</div>
    <div class="grimoire-row">
      <select id="${idPrefix}BookSelect" class="text_pole grimoire-input"><option value="">— выбрать из списка —</option></select>
    </div>
    <div class="grimoire-row">
      <input id="${idPrefix}Book" class="text_pole grimoire-input" placeholder="или впишите имя лорбука" value="${escapeAttr(currentValue || '')}" />
      <button id="${idPrefix}BookClear" class="menu_button grimoire-btn" title="Очистить">✕</button>
    </div>
    <div class="grimoire-row">
      <button id="${idPrefix}UseChatBook" class="menu_button grimoire-btn">Текущий чата</button>
      <button id="${idPrefix}BookCreate" class="menu_button grimoire-btn">+ Создать новый</button>
    </div>
    <span id="${idPrefix}BookStatus" class="grimoire-status"></span>
  `;
}

// Wires up a book-picker block rendered by bookPickerHtml(). `find` is a
// function(selector) => jQuery element, scoped to wherever this instance lives
// (the settings drawer, or — via document-level delegation — the popup).
function wireBookPicker({ idPrefix, find, on, getBook, setBook }) {
  async function refreshList() {
    const names = await getWorldNames();
    const $select = find(`#${idPrefix}BookSelect`);
    const current = getBook();
    $select.empty().append('<option value="">— выбрать из списка —</option>');
    names.forEach(n => $select.append(`<option value="${escapeAttr(n)}">${escapeHtml(n)}</option>`));
    if (names.includes(current)) $select.val(current);
  }
  refreshList();

  on(`#${idPrefix}BookSelect`, 'change', function () {
    const val = $(this).val();
    if (val) { setBook(val); find(`#${idPrefix}Book`).val(val); }
  });

  on(`#${idPrefix}Book`, 'change', function () {
    setBook($(this).val().trim());
  });

  on(`#${idPrefix}BookClear`, 'click', function () {
    setBook('');
    find(`#${idPrefix}Book`).val('');
    find(`#${idPrefix}BookSelect`).val('');
  });

  on(`#${idPrefix}UseChatBook`, 'click', async function () {
    const statusEl = find(`#${idPrefix}BookStatus`);
    try {
      const name = await getCurrentChatBook();
      if (!name) { setStatus(statusEl, 'У текущего чата/персонажа нет привязанного лорбука', true); return; }
      setBook(name);
      find(`#${idPrefix}Book`).val(name);
      await refreshList();
      setStatus(statusEl, '✓ Подставлен «' + name + '»', false);
    } catch (e) {
      setStatus(statusEl, 'Не удалось получить лорбук чата: ' + e.message, true);
    }
  });

  on(`#${idPrefix}BookCreate`, 'click', async function () {
    const statusEl = find(`#${idPrefix}BookStatus`);
    const { Popup } = getCtx();
    let name;
    try {
      name = await Popup.show.input('Новый лорбук', 'Введите имя нового лорбука:', '');
    } catch (e) { name = null; }
    if (!name) return;
    setStatus(statusEl, 'Создаю…', false);
    try {
      const created = await createNewBook(name);
      setBook(created);
      find(`#${idPrefix}Book`).val(created);
      await refreshList();
      find(`#${idPrefix}BookSelect`).val(created);
      setStatus(statusEl, '✓ Лорбук «' + created + '» создан и выбран', false);
    } catch (e) {
      setStatus(statusEl, e.message || 'Не удалось создать лорбук', true);
    }
  });

  return { refreshList };
}

// ---------- settings drawer ----------
function drawerHtml() {
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
          <button id="grimSaveSettings" class="menu_button grimoire-btn" disabled>Сохранить подключение</button>
          <span id="grimSettingsStatus" class="grimoire-status"></span>
        </div>
      </div>

      <hr class="grimoire-hr" />

      <div class="grimoire-section">
        ${bookPickerHtml('grim', '')}
      </div>

      <hr class="grimoire-hr" />

      <button id="grimOpenPopup" class="menu_button grimoire-btn grimoire-btn-primary grimoire-open-btn">
        🐸 Открыть Grimoire — записи лорбука (<span id="grimDrawerCount">0</span>)
      </button>
    </div>
  </div>`;
}

// ---------- popup content ----------
function entryCardHtml(d) {
  const keysStr = (d.keys || []).join(', ');
  return `
    <div class="grimoire-entry" data-id="${d.id}">
      <div class="grimoire-entry-top">
        <input class="text_pole grimoire-input grimoire-entry-name" placeholder="Название (необязательно)" value="${escapeAttr(d.name || '')}" />
        <label class="grimoire-checkbox"><input type="checkbox" class="grimoire-entry-constant" ${d.constant ? 'checked' : ''} /> Всегда активна</label>
        <button class="menu_button grimoire-btn grimoire-entry-del" title="Удалить черновик">✕</button>
      </div>
      <div class="grimoire-label">Промт</div>
      <textarea class="text_pole grimoire-input grimoire-textarea grimoire-entry-prompt" placeholder="Например: Иван Кузнецов — старый кузнец города, делает мечи для стражи">${escapeHtml(d.prompt || '')}</textarea>
      <div class="grimoire-row">
        <button class="menu_button grimoire-btn grimoire-entry-gen">✦ Сгенерировать</button>
        <span class="grimoire-status grimoire-entry-status"></span>
      </div>
      <div class="grimoire-label">Ключи (через запятую)</div>
      <input class="text_pole grimoire-input grimoire-entry-keys" placeholder="ключ1, ключ2, ключ3" value="${escapeAttr(keysStr)}" />
      <div class="grimoire-label">Текст записи</div>
      <textarea class="text_pole grimoire-input grimoire-textarea grimoire-entry-content" placeholder="Появится после генерации">${escapeHtml(d.content || '')}</textarea>
      <div class="grimoire-row">
        <button class="menu_button grimoire-btn grimoire-entry-send">📥 Отправить в лорбук</button>
        <span class="grimoire-status grimoire-entry-send-status"></span>
      </div>
    </div>
  `;
}

function popupHtml(settings) {
  const entriesHtml = settings.drafts.length
    ? settings.drafts.map(d => entryCardHtml(d)).join('')
    : '<div class="grimoire-empty">Пока нет черновиков. Нажмите «+ Добавить запись».</div>';
  return `
    <div id="${POPUP_ROOT_ID}">
      ${bookPickerHtml('grimPopup', settings.targetBook)}
      <div class="grimoire-row" style="justify-content: space-between; margin-top:14px;">
        <div class="grimoire-label" style="margin:0;">Записи (<span id="grimPopupCount">${settings.drafts.length}</span>)</div>
        <button id="grimAddEntry" class="menu_button grimoire-btn">+ Добавить запись</button>
      </div>
      <div id="grimEntriesList" class="grimoire-entries">${entriesHtml}</div>
    </div>
  `;
}

jQuery(async () => {
  const settings = getSettings();
  const $panel = $(drawerHtml());
  $('#extensions_settings2').append($panel);

  const $format = $panel.find('#grimFormat');
  const $endpoint = $panel.find('#grimEndpoint');
  const $key = $panel.find('#grimKey');
  const $model = $panel.find('#grimModel');
  const $saveBtn = $panel.find('#grimSaveSettings');
  const $drawerCount = $panel.find('#grimDrawerCount');

  $format.val(settings.format);
  $endpoint.val(settings.endpoint);
  $key.val(settings.apiKey);
  $model.val(settings.model);
  $panel.find('#grimBook').val(settings.targetBook);
  $drawerCount.text(settings.drafts.length);

  function validateConnectionForm() {
    const ok = $endpoint.val().trim() && $key.val().trim() && $model.val().trim();
    $saveBtn.prop('disabled', !ok);
    $saveBtn.toggleClass('grimoire-btn-ready', !!ok);
    return ok;
  }
  validateConnectionForm();
  $endpoint.on('input', validateConnectionForm);
  $key.on('input', validateConnectionForm);
  $model.on('input', validateConnectionForm);

  $saveBtn.on('click', () => {
    if (!validateConnectionForm()) return;
    settings.format = $format.val();
    settings.endpoint = $endpoint.val().trim();
    settings.apiKey = $key.val().trim();
    settings.model = $model.val().trim();
    persist();
    setStatus($panel.find('#grimSettingsStatus'), '✓ Сохранено', false);
  });

  wireBookPicker({
    idPrefix: 'grim',
    find: (sel) => $panel.find(sel),
    on: (sel, evt, handler) => $panel.on(evt, sel, handler),
    getBook: () => settings.targetBook,
    setBook: (v) => { settings.targetBook = v; persist(); }
  });

  // ---- open the actual workspace as an official SillyTavern Popup ----
  $panel.find('#grimOpenPopup').on('click', () => {
    const { Popup, POPUP_TYPE } = getCtx();
    const popup = new Popup(popupHtml(settings), POPUP_TYPE.TEXT, '', {
      wide: true,
      okButton: false,
      cancelButton: 'Закрыть',
      allowVerticalScrolling: true
    });
    popup.show();
    wireBookPicker({
      idPrefix: 'grimPopup',
      find: (sel) => $(`#${POPUP_ROOT_ID}`).find(sel),
      on: (sel, evt, handler) => $(document).on(evt, `#${POPUP_ROOT_ID} ${sel}`, handler),
      getBook: () => settings.targetBook,
      setBook: (v) => { settings.targetBook = v; persist(); $drawerCount.text(settings.drafts.length); }
    });
  });

  function findDraft(id) {
    return settings.drafts.find(d => d.id === id);
  }

  function syncCounts() {
    $(`#${POPUP_ROOT_ID} #grimPopupCount`).text(settings.drafts.length);
    $drawerCount.text(settings.drafts.length);
  }

  const scope = `#${POPUP_ROOT_ID}`;

  $(document).on('click', `${scope} #grimAddEntry`, () => {
    settings.drafts.unshift({ id: uid(), prompt: '', name: '', keys: [], content: '', constant: false });
    persist();
    const $list = $(`${scope} #grimEntriesList`);
    $list.find('.grimoire-empty').remove();
    $list.prepend(entryCardHtml(settings.drafts[0]));
    syncCounts();
  });

  $(document).on('input change', `${scope} .grimoire-entry-name, ${scope} .grimoire-entry-prompt, ${scope} .grimoire-entry-keys, ${scope} .grimoire-entry-content, ${scope} .grimoire-entry-constant`, function () {
    const $card = $(this).closest('.grimoire-entry');
    const d = findDraft($card.data('id'));
    if (!d) return;
    d.name = $card.find('.grimoire-entry-name').val().trim();
    d.prompt = $card.find('.grimoire-entry-prompt').val();
    d.keys = $card.find('.grimoire-entry-keys').val().split(',').map(k => k.trim()).filter(Boolean);
    d.content = $card.find('.grimoire-entry-content').val();
    d.constant = $card.find('.grimoire-entry-constant').prop('checked');
    persist();
  });

  $(document).on('click', `${scope} .grimoire-entry-del`, function () {
    const $card = $(this).closest('.grimoire-entry');
    const id = $card.data('id');
    settings.drafts = settings.drafts.filter(d => d.id !== id);
    persist();
    $card.remove();
    if (!settings.drafts.length) {
      $(`${scope} #grimEntriesList`).html('<div class="grimoire-empty">Пока нет черновиков. Нажмите «+ Добавить запись».</div>');
    }
    syncCounts();
  });

  $(document).on('click', `${scope} .grimoire-entry-gen`, async function () {
    const $card = $(this).closest('.grimoire-entry');
    const d = findDraft($card.data('id'));
    const statusEl = $card.find('.grimoire-entry-status');
    if (!d) return;
    const promptText = $card.find('.grimoire-entry-prompt').val().trim();
    if (!promptText) { setStatus(statusEl, 'Сначала напишите промт', true); return; }
    setStatus(statusEl, 'Генерирую…', false);
    try {
      const result = await callModel(promptText);
      d.prompt = promptText;
      d.name = typeof result.name === 'string' ? result.name : d.name;
      d.keys = Array.isArray(result.keys) ? result.keys.map(String) : d.keys;
      d.content = typeof result.content === 'string' ? result.content : d.content;
      $card.find('.grimoire-entry-name').val(d.name || '');
      $card.find('.grimoire-entry-keys').val((d.keys || []).join(', '));
      $card.find('.grimoire-entry-content').val(d.content || '');
      persist();
      setStatus(statusEl, '✓ Готово', false);
    } catch (e) {
      setStatus(statusEl, e.message || 'Ошибка генерации', true);
    }
  });

  $(document).on('click', `${scope} .grimoire-entry-send`, async function () {
    const $card = $(this).closest('.grimoire-entry');
    const d = findDraft($card.data('id'));
    const statusEl = $card.find('.grimoire-entry-send-status');
    if (!d) return;
    const book = $(`${scope} #grimPopupBook`).val().trim();
    if (!book) { setStatus(statusEl, 'Укажите лорбук-получатель выше', true); return; }
    const content = $card.find('.grimoire-entry-content').val().trim();
    if (!content) { setStatus(statusEl, 'Сначала сгенерируйте (или впишите) текст записи', true); return; }
    setStatus(statusEl, 'Отправляю…', false);
    try {
      await pushEntryToBook(book, {
        name: $card.find('.grimoire-entry-name').val().trim(),
        keys: $card.find('.grimoire-entry-keys').val().split(',').map(k => k.trim()).filter(Boolean),
        content,
        constant: $card.find('.grimoire-entry-constant').prop('checked')
      });
      setStatus(statusEl, '✓ Добавлена в «' + book + '»', false);
    } catch (e) {
      setStatus(statusEl, e.message || 'Не удалось отправить запись', true);
    }
  });

  console.log(`[${EXT_NAME}] loaded`);
});
