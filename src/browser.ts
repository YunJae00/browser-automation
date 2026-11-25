import { chromium, type Browser, type BrowserContext } from 'playwright'

export interface Control { id: string; kind: string; name: string; context?: string; submits: boolean; posts: boolean; searchText?: string }
export interface PageView { url: string; title: string; text: string; dialog?: string; wall?: 'login' | 'captcha'; controls: Control[] }
export interface Move { ok: boolean; error?: string }
export type MoveKind = 'press' | 'type' | 'choose' | 'search'
export interface Surface {
  read(): Promise<PageView>
  act(kind: MoveKind, id: string, text?: string): Promise<Move>
}

const MOVE_TIMEOUT_MS = 3_000
const SETTLE_MS = 1_500

// A string, not a function: tsx injects helpers into functions that do not exist inside the page.
const READ_PAGE = String.raw`(() => {
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  const visible = el => { if (!el.getClientRects().length) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none'; };
  const kindOf = el => {
    const tag = el.tagName.toLowerCase(), role = el.getAttribute('role');
    if (role) return role;
    if (tag === 'a') return 'link';
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'field';
    if (tag !== 'input') return 'button';
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    return ['button', 'submit', 'reset', 'image'].includes(type) ? 'button' : ['checkbox', 'radio'].includes(type) ? type : 'field';
  };
  const nameOf = el => clean(el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) || el.innerText || (el.tagName === 'INPUT' && ['button', 'submit'].includes(el.type) && el.value) || el.placeholder || el.title || el.getAttribute('alt') || (el.querySelector('img') && el.querySelector('img').alt)).slice(0, 80);
  window.__liteNext = window.__liteNext || 1;
  const controls = [];
  for (const el of document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=switch],[role=option],[onclick]')) {
    if (!visible(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
    let id = el.getAttribute('data-lite-id');
    if (!id) { id = String(window.__liteNext++); el.setAttribute('data-lite-id', id); }
    const name = nameOf(el), row = el.closest('tr,li'), context = row ? clean(row.innerText).slice(0, 120) : '';
    const form = el.form || el.closest('form');
    const submits = !!form && (el.tagName === 'BUTTON' ? (el.getAttribute('type') || 'submit') === 'submit' : el.tagName === 'INPUT' && ['submit', 'image'].includes(el.type));
    const searchReady = el.tagName === 'INPUT' && !!el.value && !!el.form && el.form.method === 'get' &&
      /search|검색/i.test(el.type + ' ' + name) && el.form.action.startsWith(location.origin + '/') &&
      !el.form.querySelector('[formmethod],[formaction]');
    controls.push({ id, kind: kindOf(el), name, ...(context && context !== name ? { context } : {}), submits, posts: !!form && form.method === 'post', ...(searchReady ? { searchText: el.value } : {}) });
  }
  const dialog = [...document.querySelectorAll('[role=dialog],[role=alertdialog],dialog[open]')].find(visible);
  const wall = [...document.querySelectorAll('input[type=password]')].some(visible) ? 'login' : document.querySelector('iframe[src*=captcha],.g-recaptcha,.h-captcha,.cf-turnstile') ? 'captcha' : undefined;
  return { url: location.href, title: document.title, text: clean(document.body ? document.body.innerText : '').slice(0, 4000), ...(dialog ? { dialog: clean(dialog.innerText).slice(0, 300) } : {}), ...(wall ? { wall } : {}), controls };
})()`

export async function launch(headless: boolean): Promise<Browser> {
  return chromium.launch({ headless })
}

export async function openSurface(context: BrowserContext, url: string): Promise<Surface> {
  const first = await context.newPage()
  await first.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 })
  // A link that opens a tab moves the run to that tab.
  const current = () => context.pages().at(-1) ?? first
  return {
    async read() {
      const view = await current().evaluate(READ_PAGE) as PageView | undefined
      if (!view?.url || !Array.isArray(view.controls)) throw new Error('브라우저에서 페이지 구조를 읽지 못했습니다.')
      return view
    },
    async act(kind, id, text = '') {
      if (!/^\d+$/.test(id)) return { ok: false, error: 'unknown control' }
      const page = current()
      const target = page.locator(`[data-lite-id="${id}"]`).first()
      try {
        if (kind === 'press') await target.click({ timeout: MOVE_TIMEOUT_MS })
        else if (kind === 'type') await target.fill(text, { timeout: MOVE_TIMEOUT_MS })
        else if (kind === 'search') {
          const allowed = await page.evaluate(READ_PAGE) as PageView
          if (!text || !allowed.controls.some(control => control.id === id && control.searchText === text)) return { ok: false, error: 'read-only search form unavailable' }
          await target.press('Enter', { timeout: MOVE_TIMEOUT_MS })
        }
        else await target.selectOption({ label: text }, { timeout: MOVE_TIMEOUT_MS })
      } catch (error) {
        return { ok: false, error: (error instanceof Error ? error.message : String(error)).split('\n', 1)[0]!.slice(0, 200) }
      }
      // Waits for requests only: results a script shows later stay late, which is one of the traps measured.
      await current().waitForLoadState('networkidle', { timeout: SETTLE_MS }).catch(() => {})
      return { ok: true }
    },
  }
}
