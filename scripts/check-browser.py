"""Integration tests against local Worker + deterministic upstream, with no real account."""
from pathlib import Path
from urllib.parse import unquote_plus
import json, os
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[1]
base = os.environ.get('HOMEPAGE_TEST_URL', 'http://127.0.0.1:5173')
browse = os.environ.get('BIN_BROWSE_ORIGIN', 'http://127.0.0.1:8787')
password = (root / '.secrets/access.txt').read_text().splitlines()[2]
out = root / 'artifacts'
out.mkdir(exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get('HOMEPAGE_BROWSER','/usr/bin/google-chrome'), headless=True, args=['--no-sandbox'])
    context = browser.new_context(viewport={'width':1440,'height':1000})
    page = context.new_page()
    errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)[:250]))
    def start():
        page.goto(base+'/tools/web-browser',wait_until='networkidle')
        page.locator('#browser-password').fill(password)
        page.get_by_role('button',name='进入浏览器').click()
        expect(page.locator('.browser-go')).to_be_enabled(timeout=35000)
    def go(url):
        page.get_by_role('textbox',name='目标网址').fill(url)
        page.get_by_role('button',name='前往',exact=True).click()
    def remote():
        return page.frame_locator('iframe[title="网页浏览环境"]').frame_locator('iframe[title="中转网页"]')
    def actual_frame():
        return next(f for f in page.frames if f.url.startswith(browse+'/p/'))
    def bridge_frame():
        return next(f for f in page.frames if f.url.startswith(browse+'/?attempt='))
    try:
        start();go('https://fixture.test/page')
        expect(remote().locator('h1')).to_have_text('Dynamic proxy fixture',timeout=20000)
        expect(remote().locator('#socket')).to_have_text('fixture-message',timeout=15000)
        remote().locator('#login').click()
        expect(remote().locator('#result')).to_contain_text('session=fixture-private',timeout=15000)
        assert 'session=' not in actual_frame().evaluate('document.cookie'), 'HttpOnly cookie leaked to page script'
        assert 'visible=fixture' in actual_frame().evaluate('document.cookie')
        data=actual_frame().evaluate("async()=>{const r=await fetch('/range',{headers:{Range:'bytes=0-3'}});return {status:r.status,bytes:[...new Uint8Array(await r.arrayBuffer())]}}")
        assert data=={'status':206,'bytes':[1,2,3,4]},data
        remote().locator('#submit').click()
        expect(remote().locator('#submitted')).to_contain_text('message=',timeout=15000)
        assert '你好世界' in unquote_plus(remote().locator('#submitted').inner_text())
        go('https://fixture.test/page')
        expect(remote().locator('#result')).to_contain_text('session=fixture-private',timeout=15000)
        page.get_by_role('button',name='切换设备模拟').click()
        page.locator('.browser-devices select').nth(0).select_option('iphone')
        expect(remote().locator('#identity')).to_contain_text('iPhone',timeout=15000)
        actual_frame().wait_for_function("window.upstream && window.upstream.ua.includes('iPhone')")
        assert actual_frame().evaluate('innerWidth')==390
        page.get_by_role('button',name='切换横竖屏').click()
        assert page.get_by_role('spinbutton',name='模拟宽度').input_value()=='844'
        page.get_by_role('spinbutton',name='模拟宽度').fill('1024')
        page.get_by_role('spinbutton',name='模拟宽度').press('Tab')
        assert actual_frame().evaluate('innerWidth')==1024
        for theme in ['dark','light']:
            page.evaluate("theme=>{localStorage.setItem('homepage-theme',theme);document.documentElement.dataset.theme=theme}",theme)
            for width in [768,1024,1440]:
                page.set_viewport_size({'width':width,'height':1000})
                page.wait_for_timeout(200)
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'),f'overflow {theme}/{width}'
            page.screenshot(path=str(out/f'browser-{theme}.png'),full_page=True)
        # Plant real storage outside the virtual site's wrappers, then prove deletion.
        bridge_frame().evaluate("async()=>{localStorage.setItem('private-marker','private');sessionStorage.setItem('private-marker','private');const c=await caches.open('private-test');await c.put('/private',new Response('private'));await new Promise((resolve,reject)=>{const r=indexedDB.open('private-test');r.onsuccess=()=>{r.result.close();resolve()};r.onerror=reject})}")
        page.get_by_role('button',name='结束浏览并退出').click()
        expect(page.locator('#browser-password')).to_be_visible(timeout=10000)
        probe=context.new_page();probe.goto(browse+'/')
        state=probe.evaluate("async()=>({local:localStorage.length,cache:await caches.keys(),db:await indexedDB.databases()})")
        assert state['local']==0 and not state['cache'] and not state['db'],state
        probe.close()
        start()
        assert page.get_by_role('textbox',name='目标网址').input_value()=='https://www.bing.com/search?bin_view=lite'
        go('https://fixture.test/page')
        expect(remote().locator('#identity')).to_be_visible(timeout=15000)
        actual_frame().wait_for_function('Boolean(window.upstream)')
        assert 'session=fixture-private' not in actual_frame().evaluate('window.upstream.cookie')
        bridge_frame().evaluate("localStorage.setItem('route-exit-marker','private')")
        page.locator('a.tool-back').click()
        expect(page.locator('.tools-directory')).to_be_visible()
        page.wait_for_timeout(700)
        probe=context.new_page();probe.goto(browse+'/')
        assert probe.evaluate("localStorage.getItem('route-exit-marker')") is None
        probe.close()
        start();go('https://fixture.test/page')
        expect(remote().locator('#identity')).to_be_visible(timeout=15000)
        bridge_frame().evaluate("localStorage.setItem('tab-exit-marker','private')")
        page.close()
        page=context.new_page();page.goto(browse+'/')
        page.wait_for_function("localStorage.getItem('tab-exit-marker')===null")
        assert not page.evaluate('async()=>await indexedDB.databases()')
        for width in [320,390]:
            phone=browser.new_context(viewport={'width':width,'height':844},user_agent='Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36',is_mobile=True,has_touch=True)
            mobile=phone.new_page();mobile.goto(base+'/tools/web-browser',wait_until='networkidle')
            expect(mobile.get_by_role('heading',name='抱歉，暂不支持此设备')).to_be_visible()
            assert mobile.locator('iframe').count()==0
            assert mobile.evaluate('document.documentElement.scrollWidth <= innerWidth')
            mobile.screenshot(path=str(out/f'mobile-{width}.png'),full_page=True)
            phone.close()
        assert not errors,errors
        print('PASS: dynamic scripts, HttpOnly cookies, forms, Range, WebSocket, device UA, resize, rotation, themes, widths, session cleanup, address reset, navigation cleanup, tab close cleanup, mobile refusal.')
    except Exception as error:
        page.screenshot(path=str(out/'failure.png'),full_page=True)
        print('browser errors',errors)
        for f in page.frames:
            try: print('frame body',f.locator('body').inner_text(timeout=1000)[:700])
            except Exception: pass
        raise RuntimeError(str(error).replace(password, '[redacted]')) from None
    finally: browser.close()
