/**
 * note.com 自動投稿ロジック（note自動投稿プロジェクトの publish-hybrid.js から
 * 本文組版・画像挿入まわりの実装を移植・簡略化）。
 * 個人利用の単一アカウント向けのため、タグ/マガジン/予約投稿UIの自動化は行わない
 * （下書き作成後、note.comの通常画面で手動設定する想定）。
 */
import { firefox } from 'playwright';
import { resolve, dirname } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

const PROFILE_DIR = resolve(homedir(), '.note-auto-post-mcpb', 'browser-profile');
mkdirSync(PROFILE_DIR, { recursive: true });

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const LOGIN_MARKER = () =>
  document.querySelector('[data-testid="user-menu"]') !== null ||
  document.querySelector('.o-navBarUser') !== null ||
  document.querySelector('a[href="/mypage"]') !== null;

async function isLoggedIn(page) {
  return page.evaluate(LOGIN_MARKER).catch(() => false);
}

/** ログイン状態を確認する（ヘッドレス・高速） */
export async function checkLoginStatus() {
  const context = await firefox.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    timezoneId: 'Asia/Tokyo',
    locale: 'ja-JP',
  });
  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto('https://note.com/', { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForTimeout(1200);
    return await isLoggedIn(page);
  } finally {
    await context.close();
  }
}

/**
 * ブラウザウィンドウを開いてユーザーに手動ログインしてもらう。
 * ログイン完了（またはタイムアウト）まで待機してから返す。
 */
export async function startLogin({ timeoutMs = 5 * 60 * 1000 } = {}) {
  const context = await firefox.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    timezoneId: 'Asia/Tokyo',
    locale: 'ja-JP',
    args: ['--no-first-run'],
  });
  const page = context.pages()[0] || (await context.newPage());
  await page.goto('https://note.com/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1000);

  if (await isLoggedIn(page)) {
    await context.close();
    return { alreadyLoggedIn: true, loginSucceeded: true };
  }

  await page.goto('https://note.com/login', { waitUntil: 'networkidle', timeout: 30000 });

  const deadline = Date.now() + timeoutMs;
  let loggedIn = false;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    loggedIn = await isLoggedIn(page);
    if (loggedIn) break;
  }
  await context.close();
  return { alreadyLoggedIn: false, loginSucceeded: loggedIn };
}

// ── 以下、エディター操作（publish-hybrid.js から移植・簡略化） ──

async function dismissModals(page) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const overlay = page.locator('.ReactModal__Overlay').first();
      if (!(await overlay.isVisible({ timeout: 500 }).catch(() => false))) return;
      const cancelBtn = page.locator('button:has-text("キャンセル"), button:has-text("閉じる")').first();
      if (await cancelBtn.isVisible({ timeout: 500 }).catch(() => false)) {
        await cancelBtn.click();
      } else {
        await page.keyboard.press('Escape');
      }
      await page.waitForTimeout(400);
    } catch {
      return;
    }
  }
}

async function clickPlusMenuItem(page, itemText) {
  await dismissModals(page);
  const plusBtn = page.locator('button[aria-label="メニューを開く"]').first();
  if (!(await plusBtn.isVisible({ timeout: 3000 }).catch(() => false))) return false;
  await plusBtn.click({ force: true });
  await page.waitForTimeout(1200);
  const ok = await page.evaluate((text) => {
    const btn = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === text && b.offsetParent !== null
    );
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  }, itemText);
  if (!ok) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }
  await page.waitForTimeout(300);
  return ok;
}

async function typeRichText(page, text) {
  const tokens = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/);
  for (const token of tokens) {
    if (!token) continue;
    if (token.startsWith('`') && token.endsWith('`') && token.length > 2) {
      const code = token.slice(1, -1);
      await page.keyboard.type(code, { delay: 3 });
      for (let i = 0; i < code.length; i++) await page.keyboard.press('Shift+ArrowLeft');
      await page.keyboard.press(`${MOD}+Shift+m`);
      await page.keyboard.press('ArrowRight');
    } else if (token.startsWith('**') && token.endsWith('**')) {
      const bold = token.slice(2, -2);
      await page.keyboard.press(`${MOD}+b`);
      await page.keyboard.type(bold, { delay: 3 });
      await page.keyboard.press(`${MOD}+b`);
    } else {
      await page.keyboard.type(token, { delay: 3 });
    }
  }
}

async function setThumbnail(page, thumbnailPath) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(600);

  const existingEyecatch = page.locator('img[alt="eyecatch"]').first();
  if (await existingEyecatch.isVisible({ timeout: 2000 }).catch(() => false)) {
    const rect = await existingEyecatch.boundingBox();
    if (rect) {
      await page.mouse.click(Math.round(rect.x + rect.width - 32), Math.round(rect.y + 16));
      await page.waitForTimeout(1200);
    }
  }

  const addImgBtn = page.locator('button:has(svg[aria-label="画像を追加"])').first();
  if (!(await addImgBtn.isVisible({ timeout: 5000 }).catch(() => false))) return false;
  await addImgBtn.click();
  await page.waitForTimeout(1200);
  const uploadBtn = page.locator('button:has-text("画像をアップロード")').first();
  if (!(await uploadBtn.isVisible({ timeout: 3000 }).catch(() => false))) return false;
  const [fc] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 10000 }),
    uploadBtn.click(),
  ]);
  await fc.setFiles(resolve(thumbnailPath));
  await page.waitForTimeout(2500);
  const saveBtn = page.locator('.ReactModal__Content button:has-text("保存")').first();
  if (await saveBtn.isVisible({ timeout: 8000 }).catch(() => false)) {
    await saveBtn.click();
    await page.waitForTimeout(3500);
  }
  return true;
}

async function insertImage(page, imgPath) {
  await page.waitForTimeout(600);
  await dismissModals(page);
  const plusBtn = page.locator('button[aria-label="メニューを開く"]').first();
  if (!(await plusBtn.isVisible({ timeout: 3000 }).catch(() => false))) return false;
  await page.evaluate(() => {
    delete window.showOpenFilePicker;
  });
  await plusBtn.click();
  await page.waitForTimeout(1500);

  const beforeCount = await page.evaluate(() => {
    const eds = [...document.querySelectorAll('div[contenteditable="true"][role="textbox"], div.ProseMirror[contenteditable="true"]')];
    if (!eds.length) return 0;
    eds.sort((a, b) => (b.innerText || '').length - (a.innerText || '').length);
    return eds[0].querySelectorAll('img').length;
  });

  let fc;
  try {
    [fc] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 8000 }),
      page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find(
          (b) => b.textContent?.trim() === '画像' && b.offsetParent !== null
        );
        btn?.click();
      }),
    ]);
  } catch {
    return false;
  }
  await fc.setFiles(resolve(imgPath));

  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(1000);
    const status = await page.evaluate(() => {
      const eds = [...document.querySelectorAll('div[contenteditable="true"][role="textbox"], div.ProseMirror[contenteditable="true"]')];
      if (!eds.length) return { real: 0 };
      eds.sort((a, b) => (b.innerText || '').length - (a.innerText || '').length);
      const imgs = [...eds[0].querySelectorAll('img')];
      return { real: imgs.filter((im) => /assets\.st-note\.com|production\/uploads/.test(im.src || '')).length };
    });
    if (status.real > beforeCount) {
      await page.waitForTimeout(1500);
      break;
    }
  }

  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const eds = [...document.querySelectorAll('div[contenteditable="true"][role="textbox"], div.ProseMirror[contenteditable="true"]')];
    if (!eds.length) return;
    eds.sort((a, b) => (b.innerText || '').length - (a.innerText || '').length);
    const ed = eds[0];
    ed.scrollTop = ed.scrollHeight;
    const range = document.createRange();
    range.selectNodeContents(ed);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    ed.focus();
  });
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  return true;
}

/**
 * body: 見出し(## / ###)・箇条書き(- )・引用(> )・太字(**)・画像(![](path)) 対応の簡易Markdown。
 * imagesDir: body中の画像パスの基準ディレクトリ（省略時はpathをそのまま解決）
 */
async function writeBody(page, body, imagesDir) {
  const rawLines = body.split('\n');
  const lines = rawLines.filter((line, i) => {
    const t = line.trim();
    if (t !== '') return true;
    const prevImg = i > 0 && /^!\[/.test(rawLines[i - 1].trim());
    const nextImg = i < rawLines.length - 1 && /^!\[/.test(rawLines[i + 1].trim());
    return !prevImg && !nextImg;
  });

  let inList = false;
  let inQuote = false;
  const failedImages = [];

  for (const line of lines) {
    const t = line.trim();

    const imgMatch = t.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
    if (imgMatch) {
      const imgPath = resolve(imagesDir || '.', imgMatch[2]);
      if (!existsSync(imgPath)) {
        failedImages.push(`${imgMatch[2]} (ファイルが見つかりません)`);
        continue;
      }
      if (inList) {
        await page.keyboard.press('Backspace');
        inList = false;
      }
      if (inQuote) {
        await page.keyboard.press('Enter');
        inQuote = false;
      }
      const ok = await insertImage(page, imgPath).catch(() => false);
      if (!ok) failedImages.push(imgMatch[2]);
      continue;
    }

    if (inList && !t.startsWith('- ') && !t.startsWith('* ')) {
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(150);
      inList = false;
    }
    if (inQuote && !t.startsWith('> ')) {
      await page.keyboard.press('Enter');
      await page.waitForTimeout(150);
      inQuote = false;
    }

    if (t === '' || t === '---') {
      await page.keyboard.press('Enter');
      continue;
    }
    if (t.startsWith('## ')) {
      await clickPlusMenuItem(page, '大見出し');
      await typeRichText(page, t.slice(3));
      await page.keyboard.press('Enter');
      continue;
    }
    if (t.startsWith('### ')) {
      await clickPlusMenuItem(page, '小見出し');
      await typeRichText(page, t.slice(4));
      await page.keyboard.press('Enter');
      await page.waitForTimeout(400);
      continue;
    }
    if (t.startsWith('> ')) {
      if (!inQuote) {
        await clickPlusMenuItem(page, '引用');
        inQuote = true;
      }
      await typeRichText(page, t.slice(2));
      await page.keyboard.press('Enter');
      continue;
    }
    if (t.startsWith('- ') || t.startsWith('* ')) {
      if (!inList) {
        await clickPlusMenuItem(page, '箇条書き');
        inList = true;
      }
      await typeRichText(page, t.slice(2));
      await page.keyboard.press('Enter');
      continue;
    }
    await typeRichText(page, line);
    await page.keyboard.press('Enter');
  }

  if (inList) await page.keyboard.press('Backspace');
  if (inQuote) await page.keyboard.press('Enter');

  return { failedImages };
}

/**
 * note.comへ下書き投稿する。タグ・マガジン・予約投稿は自動化しない
 * （下書きが出来た後、note.comの画面で通常どおり設定してもらう）。
 */
export async function postToNote({ title, body, thumbnailPath, imagesDir }) {
  if (!title || !body) throw new Error('title と body は必須です');

  const loggedIn = await checkLoginStatus();
  if (!loggedIn) {
    throw new Error('note.comにログインしていません。先に note_login ツールでログインしてください。');
  }

  const context = await firefox.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    viewport: { width: 1280, height: 900 },
    timezoneId: 'Asia/Tokyo',
    locale: 'ja-JP',
  });
  let page = context.pages()[0] || (await context.newPage());

  try {
    const newPagePromise = context.waitForEvent('page', { timeout: 15000 }).catch(() => null);
    await page.goto('https://note.com/notes/new', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    const newPage = await newPagePromise;
    if (newPage) {
      page = newPage;
      await page.waitForLoadState('domcontentloaded').catch(() => {});
    }
    await page.waitForTimeout(3000);

    if (page.url().includes('login')) throw new Error('セッションが無効になっています。note_login を再実行してください。');

    for (let i = 0; i < 15; i++) {
      const ready = await page
        .evaluate(() => document.querySelectorAll('textarea').length > 0 || document.querySelectorAll('[contenteditable]').length > 0)
        .catch(() => false);
      if (ready) break;
      await page.waitForTimeout(1500);
    }
    const editorUrl = page.url();

    let thumbnailOk = false;
    if (thumbnailPath && existsSync(resolve(thumbnailPath))) {
      thumbnailOk = await setThumbnail(page, thumbnailPath).catch(() => false);
      const currentUrl = page.url();
      if (!currentUrl.includes('editor.note.com') || currentUrl !== editorUrl) {
        await page.goto(editorUrl, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(2000);
      }
    }

    const titleSel = 'textarea[placeholder*="タイトル"]';
    await page.waitForSelector(titleSel, { timeout: 10000 });
    await page.fill(titleSel, title);
    await page.waitForTimeout(400);

    const bodySel = 'div[contenteditable="true"][role="textbox"], div.ProseMirror';
    await page.waitForSelector(bodySel, { timeout: 10000 });
    await page.keyboard.press('Escape');
    await page.locator(bodySel).click({ force: true });

    const { failedImages } = await writeBody(page, body, imagesDir);

    await page.waitForTimeout(800);
    await dismissModals(page);
    const draftBtn = page.locator('button:has-text("下書き保存")').first();
    let saved = false;
    if (await draftBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await draftBtn.click({ force: true });
      await page.waitForTimeout(2500);
      saved = true;
    }

    return {
      saved,
      thumbnailOk,
      failedImages,
      editorUrl: page.url(),
    };
  } finally {
    await context.close();
  }
}
