"""Probe public sites through the deployed tool without using website accounts."""
import base64
import json
import os
import re
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[1]
base = os.environ.get('HOMEPAGE_TEST_URL', 'https://zxabinbina.cc.cd')
browse = os.environ.get('BIN_BROWSE_ORIGIN', 'https://browse.zxabinbina.cc.cd')
out = root / 'artifacts'
out.mkdir(exist_ok=True)
password = (root / '.secrets/access.txt').read_text().splitlines()[2]

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get('HOMEPAGE_BROWSER', '/usr/bin/google-chrome'), headless=True, args=['--no-sandbox'])
    context = browser.new_context(viewport={'width': 1440, 'height': 1100})
    page = context.new_page()
    errors = []
    network = []
    page.on('pageerror', lambda e: errors.append(str(e)[:300]))
    page.on('requestfailed', lambda r: print('network failure', r.url, r.failure, flush=True) if '/v1/auth/' in r.url else None)
    report = {}
    def response_received(response):
        if '/v1/auth/' in response.url:
            print('auth HTTP', response.status, flush=True)
        if not response.url.endswith('/v1/proxy/http'):
            return
        try:
            packed = response.request.headers.get('x-bin-request', '')
            meta = json.loads(base64.urlsafe_b64decode(packed + '=' * (-len(packed) % 4)))
            info = json.loads(base64.b64decode(response.headers['x-bin-response'])) if 'x-bin-response' in response.headers else {}
            network.append({'target': meta['url'], 'status': info.get('status', response.status), 'location': info.get('headers', {}).get('location')})
        except Exception:
            pass
    page.on('response', response_received)

    def frame():
        return next((f for f in page.frames if f.url.startswith(browse + '/p/')), None)

    def inspect(name):
        f = frame()
        result = {'address': page.get_by_role('textbox', name='目标网址').input_value()}
        if f:
            try:
                result['body'] = f.locator('body').inner_text(timeout=5000)[:3000]
                result['links'] = f.locator('h2 a').evaluate_all('(els)=>els.slice(0,6).map(e=>({text:e.textContent,href:e.href}))')
                result['media'] = f.locator('video').evaluate_all('(els)=>els.map(v=>({readyState:v.readyState,paused:v.paused,time:v.currentTime,error:v.error?.code}))')
            except Exception as e:
                result['inspection_error'] = str(e)[:400]
        result['errors'] = errors[-10:]
        result['failed_requests'] = [r for r in network if r['status'] >= 400][-15:]
        result['redirects'] = [r for r in network if r['location']][-10:]
        page.screenshot(path=str(out / f'production-{name}.png'), full_page=True)
        report[name] = result
        print(name, json.dumps({**result, 'body': result.get('body', '')[:220], 'links': result.get('links', [])[:2]}, ensure_ascii=False), flush=True)

    def go(url):
        page.get_by_role('textbox', name='目标网址').fill(url)
        page.get_by_role('button', name='前往', exact=True).click()

    try:
        page.goto(base + '/tools/web-browser', wait_until='domcontentloaded')
        for attempt in range(3):
            page.locator('#browser-password').fill(password)
            page.get_by_role('button', name='进入浏览器').click()
            page.wait_for_function("document.querySelector('.browser-workbench') || document.querySelector('.browser-error')", timeout=25000)
            if page.locator('.browser-workbench').count():
                break
            print('login attempt failed:', page.locator('.browser-error').inner_text(), flush=True)
            page.wait_for_timeout(2000)
        expect(page.locator('.browser-go')).to_be_enabled(timeout=60000)
        print('PASS: production login and browser initialization', flush=True)
        go('https://cn.bing.com/search?q=MDN+JavaScript')
        page.wait_for_timeout(18000)
        inspect('bing')
        if not (frame() and frame().locator('#b_results h2 a').count()):
            go('https://www.bing.com/search?q=MDN+JavaScript')
            page.wait_for_timeout(15000)
            inspect('bing-www')
        f = frame()
        if f and f.locator('#b_results h2 a').count() and f.locator('#b_results h2 a').first.is_visible():
            f.locator('#b_results h2 a').first.click(timeout=10000)
            page.wait_for_timeout(15000)
            inspect('bing-result')
        go('https://www.bing.com/search?bin_view=lite&q=MDN+JavaScript')
        page.wait_for_timeout(12000)
        inspect('bing-lite')
        f = frame()
        expect(f.locator('article h2 a').first).to_be_visible(timeout=15000)
        f.locator('article h2 a').first.click(timeout=10000)
        page.wait_for_timeout(15000)
        inspect('bing-lite-result')
        go('https://ys.mihoyo.com/cloud/')
        page.wait_for_timeout(22000)
        inspect('mihoyo')
        f = frame()
        if f and f.get_by_text('开始游戏', exact=True).count():
            f.get_by_text('开始游戏', exact=True).click(timeout=10000)
            page.wait_for_timeout(12000)
            inspect('mihoyo-login')
            report['mihoyo-login']['subframes'] = []
            for child in page.frames[2:]:
                try:
                    report['mihoyo-login']['subframes'].append({'url': child.url, 'text': child.locator('body').inner_text(timeout=1500)[:1200]})
                except Exception:
                    pass
        go('https://www.douyin.com/jingxuan')
        page.wait_for_timeout(25000)
        inspect('douyin')
        f = frame()
        if f:
            candidates = f.locator('a[href*="modal_id="],a[href*="/video/"]')
            if not candidates.count():
                candidates = f.get_by_text(re.compile(r'^\d{1,2}:\d{2}$'))
            if candidates.count():
                candidates.first.click(timeout=10000)
                page.wait_for_timeout(15000)
                inspect('douyin-open')
                f = frame()
        if f and f.locator('video').count():
            f.locator('video').first.evaluate('(v)=>{v.muted=true;return Promise.race([v.play().catch(e=>e.name),new Promise(r=>setTimeout(()=>r("play timeout"),10000))])}')
            page.wait_for_timeout(5000)
            inspect('douyin-play')
            report['douyin-play']['playback_observed'] = any(v['readyState'] >= 3 and v['time'] > 1 and not v['paused'] for v in report['douyin-play'].get('media', []))
        bridge = next(f for f in page.frames if f.url.startswith(browse + '/?attempt='))
        bridge.evaluate("async()=>{localStorage.setItem('production-cleanup-marker','private');const c=await caches.open('production-private');await c.put('/private',new Response('private'));await new Promise((resolve,reject)=>{const r=indexedDB.open('production-private');r.onsuccess=()=>{r.result.close();resolve()};r.onerror=reject})}")
        page.get_by_role('button', name='结束浏览并退出').click()
        expect(page.locator('#browser-password')).to_be_visible(timeout=15000)
        probe = context.new_page()
        probe.goto(browse + '/', wait_until='domcontentloaded')
        state = probe.evaluate('async()=>({local:localStorage.length,cache:await caches.keys(),db:await indexedDB.databases()})')
        assert state['local'] == 0 and not state['cache'] and not state['db'], state
        print('PASS: production logout cleared storage, caches and IndexedDB', flush=True)
        report['cleanup'] = state
    except Exception as e:
        raise RuntimeError(str(e).replace(password, '[redacted]')) from None
    finally:
        (out / 'production-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
        (out / 'production-network.json').write_text(json.dumps(network, ensure_ascii=False, indent=2))
        browser.close()
