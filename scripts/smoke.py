from pathlib import Path
import os, json
from playwright.sync_api import sync_playwright

base = os.environ.get('HOMEPAGE_TEST_URL', 'http://127.0.0.1:5173')
password = (Path(__file__).resolve().parents[1] / '.secrets/access.txt').read_text().splitlines()[2]
out = Path(__file__).resolve().parents[1] / 'artifacts'
out.mkdir(exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True, args=['--no-sandbox'])
    context = browser.new_context(viewport={'width':1440,'height':1000})
    page = context.new_page()
    page.on('pageerror', lambda error: print('pageerror',str(error)[:350]))
    page.on('console', lambda msg: print('console',msg.text[:350]) if msg.type == 'error' else None)
    page.goto(base+'/tools/web-browser',wait_until='networkidle')
    page.screenshot(path=str(out/'login.png'),full_page=True)
    page.locator('#browser-password').fill(password)
    page.get_by_role('button',name='进入浏览器').click()
    try:
        page.locator('.browser-workbench').wait_for(timeout=25000)
        page.get_by_role('button',name='前往',exact=True).wait_for(timeout=25000)
        page.wait_for_function("!document.querySelector('.browser-go')?.disabled",timeout=30000)
        page.get_by_role('textbox',name='目标网址').fill(os.environ.get('BIN_TARGET', 'https://fixture.test/page'))
        page.get_by_role('button',name='前往',exact=True).click()
        page.wait_for_timeout(9000)
    except Exception as error:
        print(type(error).__name__,str(error)[:400])
    print('main',page.locator('.browser-login,.browser-workbench').inner_text()[:1500])
    for frame in page.frames:
        print('frame',frame.url[:250])
        try: print('text',frame.locator('body').inner_text(timeout=1000)[:500])
        except Exception: pass
    page.screenshot(path=str(out/'browser.png'),full_page=True)
    browser.close()
