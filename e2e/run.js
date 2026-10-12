/* Перевірка в бою (e2e, 11.10; розширено 12.10): справжній сайт, справжній
   бот, справжній Telegram — так, як іде покупець, але на прихованій
   «Тестовій точці». Її замовлення (№ 9001+) приходять лише в групу
   «Барон Тест-точка», не йдуть у статистику й підсумки, SMS по них не
   шлемо — сервер лише записує, яку SMS надіслав би.

   Сценарії:
   А. Самовивіз із входом: сайт ?e2e=1 → вхід через Telegram акаунтом
      «Барон Тест» (/start + свій номер) → замовлення → кнопки в групі
      Прийняти → Готується → Готове → Видано → клієнту «прийнято» й
      «готове» в Telegram.
   Б. Доставка: те саме з адресою → у групі картка з адресою → у панелі
      точки (op.html) «🚕 Вартість доставки» 100 ₴ → кнопки до «Передали
      курʼєру» → клієнт у Telegram тисне «✅ Отримав замовлення» → «Видано».
   В. Без входу: гість оформлює сам → у панелі кнопками до «Готове» →
      сервер «надіслав би» SMS «готове» → «Видано».
   Г. Скасування: гість оформлює → у панелі «Скасувати» з причиною →
      «Скасовано» і SMS «скасовано», яку надіслав би.
   Наприкінці — /panel-off у групі: доступ робота до панелі не лишається.
   Упало — власнику в особисті «❌ … на кроці X» від нашого бота.

   Секрети: TG_API_ID, TG_API_HASH, TG_SESSION (вхід «Барон Тест»,
   npm run login), BOT_TOKEN, OWNER_ID; змінна TEST_CHAT — група. */
const { chromium, devices } = require('playwright');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');

const SITE = process.env.SITE || 'https://meat-baron.kh.ua';
const API = process.env.API || 'https://api.meat-baron.kh.ua';
const TEST_CHAT = Number(process.env.TEST_CHAT || -5536057153);
const { TG_API_ID, TG_API_HASH, TG_SESSION, BOT_TOKEN, OWNER_ID } = process.env;
const NOTIFY_OK = process.env.NOTIFY_OK === 'true';
const RUN_URL = process.env.RUN_URL || '';
/* Гість — номер, якого немає серед покупців із Telegram: тоді сервер
   «шле» SMS, а не пише в бот, і ми бачимо саме шлях без входу */
const GUEST_TEL = '+380500000001';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let step = 'старт';
const at = s => { step = s; log('▶', s) };

/* Чекаємо умову до timeout мс; повертаємо те, що вона дала */
async function until(fn, timeout, what) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('не дочекались: ' + what);
    await sleep(1500);
  }
}

async function botApi(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  return r.json();
}
const tellOwner = text => OWNER_ID && BOT_TOKEN
  ? botApi('sendMessage', { chat_id: OWNER_ID, text, disable_web_page_preview: true }).catch(() => {})
  : null;

const orderOf = async no => (await fetch(`${API}/api/order/${no}`)).json().catch(() => ({}));
const statusIs = (no, st, ms = 15000) =>
  until(async () => (await orderOf(no)).status === st, ms, `статус «${st}» у № ${no} на сервері`);

(async () => {
  const t0 = Date.now();
  let browser, client, group, no = 0, panelOn = false;
  const passed = [];
  try {
    at('підключення до Telegram');
    const me0 = await botApi('getMe', {});
    if (!me0.ok) throw new Error('BOT_TOKEN не підходить');
    const BOT = me0.result.username;
    client = new TelegramClient(new StringSession(TG_SESSION), Number(TG_API_ID), TG_API_HASH, { connectionRetries: 3 });
    client.setLogLevel('error');
    await client.connect();
    const me = await client.getMe();
    await client.getDialogs({ limit: 50 });          // свіжий вхід ще не знає груп — підтягуємо список чатів
    const bot = await client.getEntity(BOT);
    group = await client.getEntity(TEST_CHAT);
    const cardIn = (n, re) => until(async () => (await client.getMessages(group, { limit: 20 }))
      .find(m => (m.message || '').includes('№ ' + n) && (!re || re.test(m.message))), 30000, `картка № ${n} у групі «Барон Тест-точка»`);
    /* Кнопка під повідомленням — тими самими даними, що натискає людина */
    const press = async (msgId, data, peer = group) => {
      const r = await client.invoke(new Api.messages.GetBotCallbackAnswer({ peer, msgId, data: Buffer.from(data) }));
      if (r.alert) throw new Error(`бот відмовив на «${data}»: ${r.message}`);
    };
    const fromBot = async re => (await client.getMessages(bot, { limit: 20 })).find(m => !m.out && re.test(m.message || ''));

    at('сайт відкривається');
    browser = await chromium.launch();
    const phone = { ...devices['iPhone 13'], locale: 'uk-UA', timezoneId: 'Europe/Kyiv' };
    const page = await browser.newPage(phone);
    const jsErrors = [];
    page.on('pageerror', e => jsErrors.push('сайт: ' + e.message));
    await page.goto(SITE + '/?e2e=1&cb=' + Date.now(), { waitUntil: 'networkidle' });
    await page.locator('.add').first().waitFor({ timeout: 20000 });

    /* Кошик → форма → «Оформити». Повертає номер замовлення. */
    async function placeOrder(p, { delivery = false, guest = false } = {}) {
      await p.goto(SITE + '/?e2e=1&cb=' + Date.now(), { waitUntil: 'networkidle' });
      await p.locator('#q').fill('лаваш');
      await p.getByRole('button', { name: 'Додати Лаваш тонкий', exact: true }).click();
      await p.locator('#barL').filter({ hasText: /1 позиція/ }).waitFor({ timeout: 10000 });
      await p.locator('#barBtn').click();
      await p.locator('#toCheckout').click();
      const next = p.locator('#upNext');
      await p.locator('#send').or(next).first().waitFor({ timeout: 10000 });
      if (await next.isVisible()) await next.click();
      if (delivery) {
        await p.locator('#sheet .sg[data-mode="delivery"]').click();
        await p.locator('#addrStreet').fill('вул. Перевірочна');
        await p.locator('#addrHouse').fill('1');
      }
      if (guest || !(await p.locator('#nm').inputValue())) await p.locator('#nm').fill(guest ? 'Гість Перевірка' : 'Барон Тест');
      if (guest) await p.locator('#tel').fill(GUEST_TEL);
      /* Доставка не показує «Точку видачі» — питаємо саму сторінку, куди піде замовлення */
      const where = await p.evaluate(() => SHOPS[shop][0]).catch(() => '');
      if (where !== 'Тестова точка') throw new Error(`замовлення пішло б на «${where}», а не на тестову — зупинились, щоб не замовити на справжню`);
      await p.locator('#send').click();
      await p.locator('#sheet').filter({ hasText: /ЗАМОВЛЕННЯ ОФОРМЛЕНО/i }).waitFor({ timeout: 20000 });
      const n = Number(((await p.locator('#sheet').innerText()).match(/№\s*(\d+)/) || [])[1]);
      if (!(n >= 9001)) throw new Error('номер замовлення не тестовий: ' + n);
      log('замовлення №', n);
      return n;
    }

    /* ---------- А. самовивіз із входом ---------- */
    at('А: вхід через Telegram');
    const started = page.waitForResponse(r => r.url().includes('/api/auth/start'), { timeout: 20000 });
    await page.evaluate(() => openLogin());
    const { sid } = await (await started).json();
    if (!sid) throw new Error('сервер не дав посилання для входу');
    const since = Math.floor(Date.now() / 1000) - 5;
    await client.sendMessage(bot, { message: '/start ' + sid });
    await until(async () => (await client.getMessages(bot, { limit: 3 })).some(m => m.date >= since && !m.out && /Поділитися|номер/i.test(m.message || '')),
      30000, 'бот попросить поділитися номером');
    await client.invoke(new Api.messages.SendMedia({
      peer: bot, message: '', randomId: BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000)),
      media: new Api.InputMediaContact({ phoneNumber: me.phone, firstName: me.firstName || 'Барон', lastName: me.lastName || '', vcard: '' })
    }));
    await until(() => page.evaluate(() => { try { return !!(JSON.parse(localStorage.getItem('mb-auth') || 'null') || {}).token } catch (e) { return false } }),
      30000, 'сайт упізнає вхід');

    at('А: кошик і оформлення');
    no = await placeOrder(page);
    at('А: картка в групі тестової точки');
    const card = await cardIn(no);
    for (const st of ['accepted', 'cooking', 'ready', 'done']) {
      at(`А: кнопка «${st}» у групі`);
      await press(card.id, `s:${no}:${st}`);
      await statusIs(no, st);
    }
    at('А: сповіщення клієнту в Telegram');
    await until(() => fromBot(new RegExp(`№ ${no} прийнято`)), 20000, `«№ ${no} прийнято» клієнту`);
    await until(() => fromBot(new RegExp(`№ ${no} готове`)), 20000, `«№ ${no} готове» клієнту`);
    at('А: сторінка замовлення');
    await page.reload({ waitUntil: 'networkidle' });
    passed.push('самовивіз');

    /* ---------- панель точки ---------- */
    at('панель: вхід за /panel із групи');
    const pSince = Math.floor(Date.now() / 1000) - 5;
    await client.sendMessage(group, { message: '/panel' });
    const link = await until(async () => {
      const m = (await client.getMessages(group, { limit: 5 })).find(x => x.date >= pSince && !x.out && /op\.html#[0-9a-f]+/.test(x.message || ''));
      return m && (m.message.match(/https?:\/\/\S+?op\.html#[0-9a-f]+/) || [])[0];
    }, 30000, 'посилання на панель від бота');
    panelOn = true;
    const tablet = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'uk-UA', timezoneId: 'Europe/Kyiv' });
    tablet.on('pageerror', e => jsErrors.push('панель: ' + e.message));
    tablet.on('dialog', d => d.accept());           // «Скасувати замовлення № …?» — так
    await tablet.goto(link, { waitUntil: 'networkidle' });
    await tablet.locator('[data-view="orders"]').waitFor({ timeout: 20000 });
    const token = await until(() => tablet.evaluate(() => localStorage.getItem('mb-op-token')), 15000, 'панель отримає ключ');
    const opOrder = async n => {
      const j = await (await fetch(`${API}/api/op/orders`, { headers: { Authorization: 'Bearer ' + token } })).json().catch(() => ({}));
      return (j.orders || []).find(o => o.no === n) || {};
    };
    const panelCard = async n => {
      await tablet.reload({ waitUntil: 'networkidle' });
      const c = tablet.locator(`[data-card="${n}"]`);
      await c.waitFor({ timeout: 20000 });
      return c;
    };
    const panelGo = async (n, st) => {
      const c = await panelCard(n);
      await c.locator(`[data-go="${n}"][data-st="${st}"]`).click();
      await statusIs(n, st);
    };

    /* ---------- Б. доставка ---------- */
    at('Б: доставка — оформлення з адресою');
    no = await placeOrder(page, { delivery: true });
    at('Б: картка доставки в групі');
    const dCard = await cardIn(no, /Перевірочна/);
    at('Б: панель — вартість доставки');
    const before = (await opOrder(no)).total;
    const dc = await panelCard(no);
    await dc.locator('[data-kind="ship"]').click();
    await tablet.locator('#fv').fill('100');
    await tablet.locator('[data-send][data-kind="ship"]').click();
    await until(async () => Math.round(((await opOrder(no)).total - before) * 100) === 10000, 15000, 'сума + 100 ₴ за доставку');
    for (const st of ['accepted', 'cooking', 'ready', 'onway']) {
      at(`Б: кнопка «${st}» у групі`);
      await press(dCard.id, `s:${no}:${st}`);
      await statusIs(no, st);
    }
    at('Б: клієнт тисне «Отримав замовлення»');
    const onway = await until(async () => {
      const m = await fromBot(new RegExp(`№ ${no}`));
      return m && m.replyMarkup && JSON.stringify(m.replyMarkup).includes('Отримав') ? m : null;
    }, 20000, `сповіщення «№ ${no}» з кнопкою «Отримав»`);
    await press(onway.id, `r:${no}`, bot);
    await statusIs(no, 'done');
    passed.push('доставка');

    /* ---------- В. без входу ---------- */
    at('В: гість оформлює без входу');
    const guestCtx = await browser.newContext(phone);
    const guest = await guestCtx.newPage();
    guest.on('pageerror', e => jsErrors.push('сайт (гість): ' + e.message));
    no = await placeOrder(guest, { guest: true });
    at('В: панель — кнопки до «Готове»');
    for (const st of ['accepted', 'cooking', 'ready']) await panelGo(no, st);
    at('В: SMS «готове», яку надіслав би сервер');
    await until(async () => ((await opOrder(no)).smsWould || []).some(t => t.includes('№' + no) && /готове/.test(t)), 15000, `SMS «№${no} готове»`);
    at('В: панель — «Видано»');
    await panelGo(no, 'done');
    passed.push('без входу');

    /* ---------- Г. скасування ---------- */
    at('Г: гість оформлює');
    no = await placeOrder(guest, { guest: true });
    at('Г: панель — скасування з причиною');
    const cc = await panelCard(no);
    await cc.locator('[data-kind="cancel"]').click();
    await tablet.locator('#fv').fill('перевірка в бою');
    await tablet.locator('[data-send][data-kind="cancel"]').click();
    await statusIs(no, 'canceled');
    await until(async () => ((await opOrder(no)).smsWould || []).some(t => t.includes('№' + no) && /скасовано/.test(t)), 15000, `SMS «№${no} скасовано»`);
    passed.push('скасування');

    if (jsErrors.length) throw new Error('помилки JS: ' + jsErrors.slice(0, 2).join(' | '));

    const sec = Math.round((Date.now() - t0) / 1000);
    log(`✅ усе пройшло за ${sec} с: ${passed.join(', ')}`);
    if (NOTIFY_OK) await tellOwner(`✅ Перевірка в бою пройшла за ${sec} с: ${passed.join(', ')} — сайт, бот, група, панель, сповіщення.`);
    process.exitCode = 0;
  } catch (e) {
    log('❌', step, '—', e.message);
    await tellOwner(`❌ Перевірка в бою впала на кроці «${step}»${no ? ` (№ ${no})` : ''}:\n${e.message}` + (RUN_URL ? `\n${RUN_URL}` : ''));
    process.exitCode = 1;
  } finally {
    /* Ключ панелі робота не лишаємо жити 30 днів */
    if (panelOn && client && group) await client.sendMessage(group, { message: '/panel-off' }).catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (client) await client.disconnect().catch(() => {});
    setTimeout(() => process.exit(process.exitCode || 0), 500);   // GramJS тримає таймери
  }
})();
