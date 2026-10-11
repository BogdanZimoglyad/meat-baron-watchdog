/* Перевірка в бою (e2e, 11.10): справжній сайт, справжній бот, справжній
   Telegram — так, як іде покупець, але на прихованій «Тестовій точці».
   Її замовлення (№ 9001+) приходять лише в групу «Барон Тест-точка», не
   йдуть у статистику й підсумки, SMS по них не шлемо.

   Кроки:
   1. Сайт ?e2e=1: вхід через Telegram акаунтом «Барон Тест» (/start + свій
      номер), кошик, оформлення — номер замовлення.
   2. Картка в групі тестової точки — кнопки Прийняти → Готується → Готове
      → Видано, тими самими натисканнями, що й оператор.
   3. Клієнту в Telegram — «прийнято» й «готове».
   4. Сторінка замовлення — «Видано».
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

(async () => {
  const t0 = Date.now();
  let browser, client, no = 0;
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
    const group = await client.getEntity(TEST_CHAT);

    at('сайт відкривається');
    browser = await chromium.launch();
    const page = await browser.newPage({ ...devices['iPhone 13'], locale: 'uk-UA', timezoneId: 'Europe/Kyiv' });
    const jsErrors = [];
    page.on('pageerror', e => jsErrors.push(e.message));
    await page.goto(SITE + '/?e2e=1&cb=' + Date.now(), { waitUntil: 'networkidle' });
    await page.locator('.add').first().waitFor({ timeout: 20000 });

    at('вхід через Telegram');
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

    at('кошик і оформлення');
    await page.goto(SITE + '/?e2e=1&cb=' + Date.now(), { waitUntil: 'networkidle' });
    await page.locator('#q').fill('лаваш');
    await page.getByRole('button', { name: 'Додати Лаваш тонкий', exact: true }).click();
    await page.locator('#barL').filter({ hasText: /1 позиція/ }).waitFor({ timeout: 10000 });
    await page.locator('#barBtn').click();
    await page.locator('#toCheckout').click();
    const next = page.locator('#upNext');
    await page.locator('#send').or(next).first().waitFor({ timeout: 10000 });
    if (await next.isVisible()) await next.click();
    if (!(await page.locator('#nm').inputValue())) await page.locator('#nm').fill('Барон Тест');
    if (!(await page.locator('#sheet').innerText()).includes('Тестова точка')) throw new Error('у формі не «Тестова точка» — зупинились, щоб не замовити на справжню');
    await page.locator('#send').click();
    await page.locator('#sheet').filter({ hasText: /ЗАМОВЛЕННЯ ОФОРМЛЕНО/i }).waitFor({ timeout: 20000 });
    no = Number(((await page.locator('#sheet').innerText()).match(/№\s*(\d+)/) || [])[1]);
    if (!(no >= 9001)) throw new Error('номер замовлення не тестовий: ' + no);
    log('замовлення №', no);

    at('картка в групі тестової точки');
    const card = await until(async () => (await client.getMessages(group, { limit: 15 })).find(m => (m.message || '').includes('№ ' + no)),
      30000, `картка № ${no} у групі «Барон Тест-точка»`);

    /* Кнопки — тими самими даними, що й оператор: s:<№>:<статус> */
    for (const st of ['accepted', 'cooking', 'ready', 'done']) {
      at(`кнопка «${st}» у групі`);
      const r = await client.invoke(new Api.messages.GetBotCallbackAnswer({ peer: group, msgId: card.id, data: Buffer.from(`s:${no}:${st}`) }));
      if (r.alert) throw new Error(`бот відмовив на «${st}»: ${r.message}`);
      await until(async () => {
        const j = await (await fetch(`${API}/api/order/${no}`)).json().catch(() => ({}));
        return j.status === st;
      }, 15000, `статус «${st}» на сервері`);
    }

    at('сповіщення клієнту в Telegram');
    const fromBot = async re => (await client.getMessages(bot, { limit: 15 })).some(m => !m.out && re.test(m.message || ''));
    await until(() => fromBot(new RegExp(`№ ${no} прийнято`)), 20000, `«№ ${no} прийнято» клієнту`);
    await until(() => fromBot(new RegExp(`№ ${no} готове`)), 20000, `«№ ${no} готове» клієнту`);

    at('сторінка замовлення');
    await page.reload({ waitUntil: 'networkidle' });
    if (jsErrors.length) throw new Error('помилки JS на сайті: ' + jsErrors.slice(0, 2).join(' | '));

    const sec = Math.round((Date.now() - t0) / 1000);
    log(`✅ усе пройшло за ${sec} с`);
    if (NOTIFY_OK) await tellOwner(`✅ Перевірка в бою пройшла за ${sec} с: сайт → вхід → № ${no} → кнопки в групі → сповіщення клієнту.`);
    process.exitCode = 0;
  } catch (e) {
    log('❌', step, '—', e.message);
    await tellOwner(`❌ Перевірка в бою впала на кроці «${step}»${no ? ` (№ ${no})` : ''}:\n${e.message}` + (RUN_URL ? `\n${RUN_URL}` : ''));
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (client) await client.disconnect().catch(() => {});
    setTimeout(() => process.exit(process.exitCode || 0), 500);   // GramJS тримає таймери
  }
})();
