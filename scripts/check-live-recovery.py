"""Production smoke test for initialization, rebuild and logout cleanup."""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

root=Path(__file__).resolve().parents[1]
secret=(root/'.secrets/access.txt').read_text().splitlines()[2]
browse='https://browse.zxabinbina.cc.cd'
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path='/usr/bin/google-chrome',headless=True,args=['--no-sandbox'])
    context=browser.new_context(viewport={'width':1440,'height':1000})
    page=context.new_page()
    def bridge(): return next(f for f in page.frames if f.url.startswith(browse+'/?attempt='))
    def remote(): return page.frame_locator('iframe[title="网页浏览环境"]').frame_locator('iframe[title="中转网页"]')
    try:
        page.goto('https://zxabinbina.cc.cd/tools/web-browser',wait_until='domcontentloaded')
        page.locator('#browser-password').fill(secret)
        page.get_by_role('button',name='进入浏览器').click()
        expect(page.locator('.browser-go')).to_be_enabled(timeout=60000)
        expect(remote().get_by_role('heading',name='Bing 简洁搜索')).to_be_visible(timeout=25000)
        print('PASS: production login, reset navigation and initialization.',flush=True)
        original=bridge().url
        bridge().evaluate("localStorage.setItem('recovery-check','private')")
        page.get_by_role('button',name='清理并重建',exact=True).click()
        expect(page.locator('.browser-go')).to_be_enabled(timeout=60000)
        expect(remote().get_by_role('heading',name='Bing 简洁搜索')).to_be_visible(timeout=25000)
        assert bridge().url!=original
        assert bridge().evaluate("localStorage.getItem('recovery-check')") is None
        print('PASS: production rebuild creates a new environment and clears previous storage.',flush=True)
        remote().get_by_role('searchbox',name='搜索关键词').fill('MDN JavaScript')
        remote().get_by_role('button',name='搜索',exact=True).click()
        expect(remote().locator('article h2 a').first).to_be_visible(timeout=30000)
        print('PASS: search works after rebuild.',flush=True)
        page.get_by_role('button',name='结束浏览并退出').click()
        expect(page.locator('#browser-password')).to_be_visible(timeout=15000)
        probe=context.new_page();probe.goto(browse+'/')
        assert not probe.evaluate('async()=>await indexedDB.databases()')
        assert probe.evaluate('localStorage.length')==0
        print('PASS: production logout clears database and local storage.',flush=True)
    except Exception as e:
        print('UI:',page.locator('main').inner_text()[:1000])
        raise RuntimeError(str(e).replace(secret,'[redacted]')) from None
    finally:browser.close()
