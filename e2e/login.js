/* Разовий вхід робота в Telegram-акаунт «Барон Тест» (11.10).
   Запускає власник на своєму компʼютері: npm run login
   Питає api_id/api_hash (my.telegram.org), номер тестової SIM, код із
   Telegram і пароль двоетапної перевірки. Ключ входу (сесію) нікуди не
   друкує — одразу кладе в секрети GitHub цього репозиторію через gh:
   TG_API_ID, TG_API_HASH, TG_SESSION. Сесія — це повний доступ до
   акаунта, тому лише тестового: перед записом питаємо, чий це акаунт. */
const readline = require('readline');
const { spawnSync } = require('child_process');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');

const REPO = 'BogdanZimoglyad/meat-baron-watchdog';
const GH = process.platform === 'win32' ? 'C:\\Program Files\\GitHub CLI\\gh.exe' : 'gh';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let muted = false;
rl._writeToOutput = s => { if (!muted || /\r?\n/.test(s)) rl.output.write(muted ? '\n' : s) };
/* Підказку друкує сам rl.question — інакше readline стирав її, і питань не було видно (11.10).
   Приховане вводимо наосліп, тому кажемо, скільки символів отримали. */
const ask = (q, secret) => new Promise(res => {
  rl.question(q, a => {
    muted = false;
    if (secret && a) console.log(`   (отримано ${a.length} символів)`);
    res(secret ? a : a.trim());          // пароль — як ввели, з пробілами
  });
  muted = !!secret;
});
/* api_hash при вставці буває з пробілом чи лапками — прибираємо */
const clean = s => s.replace(/\s+/g, '').replace(/^["'«]+|["'»]+$/g, '');
/* У вікні терминалу програми вставка не спрацювала (11.10): беремо з
   буфера обміну самі — скопіював на my.telegram.org і натиснув Enter */
function clipboard() {
  if (process.platform !== 'win32') return '';
  const r = spawnSync('powershell', ['-NoProfile', '-Command', 'Get-Clipboard'], { encoding: 'utf8' });
  return (r.stdout || '').trim();
}
async function askClip(label, secret) {
  const typed = await ask(`${label}: скопіюйте його на my.telegram.org і натисніть тут Enter: `, secret);
  return clean(typed) || clean(clipboard());
}

function setSecret(name, value) {
  const r = spawnSync(GH, ['secret', 'set', name, '--repo', REPO], { input: value, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`gh secret set ${name}: ${(r.stderr || r.error || '').toString().trim()}`);
}

(async () => {
  console.log('\nВхід робота в акаунт «Барон Тест». Нічого з введеного не показуємо й не зберігаємо на диску.\n');
  const apiId = Number((await askClip('api_id (цифри)')).replace(/\D/g, ''));
  console.log(apiId ? `   api_id: ${apiId} ✓` : '   api_id не знайдено');
  const apiHash = await askClip('api_hash (довгий рядок)', true);
  if (/^[0-9a-f]{32}$/i.test(apiHash)) console.log('   api_hash: 32 символи ✓');
  if (!apiId) throw new Error('api_id — це лише цифри. Запустіть ще раз.');
  if (!/^[0-9a-f]{32}$/i.test(apiHash)) throw new Error(`api_hash має бути 32 символи (цифри й латинські a–f), а отримано ${apiHash.length}. Скопіюйте його ще раз із my.telegram.org і запустіть знову.`);

  const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 3 });
  client.setLogLevel('error');
  await client.start({
    phoneNumber: () => ask('Номер ТЕСТОВОЇ SIM (+380…): '),
    phoneCode: () => ask('Код, що прийшов у Telegram «Барон Тест»: '),
    password: () => ask('Пароль двоетапної перевірки (якщо не вмикали — просто Enter): ', true),
    onError: e => console.log('⚠️ ', e.message)
  });

  const me = await client.getMe();
  const who = [me.firstName, me.lastName].filter(Boolean).join(' ');
  console.log(`\nУвійшли як: ${who}${me.username ? ' (@' + me.username + ')' : ''}, номер +${me.phone}`);
  const yes = (await ask('Це тестовий акаунт «Барон Тест», а не ваш основний? Напишіть «так»: ')).toLowerCase();
  if (yes !== 'так') {
    await client.invoke(new Api.auth.LogOut());
    console.log('Вийшли з акаунта, нічого не записано. Запустіть ще раз із номером тестової SIM.');
    rl.close(); process.exit(1);
  }

  const session = client.session.save();
  setSecret('TG_API_ID', String(apiId));
  setSecret('TG_API_HASH', apiHash);
  setSecret('TG_SESSION', session);
  await client.disconnect();
  console.log(`\n✅ Готово: TG_API_ID, TG_API_HASH і TG_SESSION записано в секрети ${REPO}.`);
  console.log('Ключ входу на екран не виводили. Вікно можна закрити.\n');
  rl.close(); process.exit(0);
})().catch(e => { console.error('\n❌', e.message); rl.close(); process.exit(1) });
