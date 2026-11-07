"""Regression: a transport that never responds must time out and be replaceable."""
from pathlib import Path
from urllib.parse import urlparse, parse_qs
import os, json, socket, subprocess, time, atexit
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[1]
base = os.environ.get('HOMEPAGE_TEST_URL', 'http://127.0.0.1:5173')
browse = os.environ.get('BIN_BROWSE_ORIGIN', 'http://127.0.0.1:8787')
password = (root / '.secrets/access.txt').read_text().splitlines()[2]

def fixture_running():
    try:
        with socket.create_connection(('127.0.0.1',8790),timeout=1): return True
    except OSError: return False

if not fixture_running():
    fixture = subprocess.Popen(['node','tests/fixture.mjs'],cwd=root,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    def stop_fixture():
        if fixture.poll() is None:
            fixture.terminate()
            fixture.wait(timeout=5)
    atexit.register(stop_fixture)
    for _ in range(50):
        if fixture_running(): break
        time.sleep(.1)
    assert fixture_running(), 'Local fixture did not start'

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get('HOMEPAGE_BROWSER', '/usr/bin/google-chrome'), headless=True, args=['--no-sandbox'])
    context = browser.new_context(viewport={'width':1440,'height':1000})
    page = context.new_page()
    context.on('console',lambda message: print('BROWSER',message.type,message.text[:600],flush=True) if message.type in ['error','warning'] else None)
    faulty = {'remaining': 1}
    def block_first_transport(route):
        response = route.fetch()
        content = response.text()
        if faulty['remaining'] and '?attempt=' in route.request.frame.url:
            faulty['remaining'] -= 1
            fault_attempt = parse_qs(urlparse(route.request.frame.url).query)['attempt'][0]
            # Bare-mux pings succeed, but its setTransport acknowledgement never
            # arrives. The previous implementation waited forever in this state.
            content = "if(new URL(location.href).searchParams.get('attempt')===" + json.dumps(fault_attempt) + "){const originalPost=MessagePort.prototype.postMessage;MessagePort.prototype.postMessage=function(message,...rest){if(message?.message?.type==='set')return;return originalPost.call(this,message,...rest)}};" + content
        route.fulfill(response=response, body=content)
    context.route(browse + '/bridge.js', block_first_transport)
    def bridge_frame():
        return next(f for f in page.frames if f.url.startswith(browse+'/?attempt='))
    def open_fixture():
        page.get_by_role('textbox',name='目标网址').fill('https://fixture.test/page')
        page.get_by_role('button',name='前往',exact=True).click()
        remote=page.frame_locator('iframe[title="网页浏览环境"]').frame_locator('iframe[title="中转网页"]')
        expect(remote.locator('#identity')).to_be_visible(timeout=20000)
        return remote
    try:
        # Simulate an existing tab retaining a database handle during recovery.
        holder=context.new_page();holder.goto(browse+'/')
        holder.evaluate("async()=>{window.heldDb=await new Promise((resolve,reject)=>{const r=indexedDB.open('$scramjet');r.onsuccess=()=>resolve(r.result);r.onerror=reject});window.heldDb.onversionchange=()=>{};localStorage.setItem('old-private-marker','private')}")
        page.goto(base+'/tools/web-browser')
        page.locator('#browser-password').fill(password)
        page.get_by_role('button',name='进入浏览器').click()
        expect(page.get_by_text('浏览环境启动失败',exact=True)).to_be_visible(timeout=35000)
        expect(page.locator('.browser-inline-error')).to_contain_text('超时')
        assert not page.locator('iframe[title="网页浏览环境"]').count()
        page.get_by_role('button',name='清理并重建',exact=True).click()
        expect(page.locator('.browser-go')).to_be_enabled(timeout=35000)
        print('Recovered from nonresponsive transport.',flush=True)
        assert bridge_frame().evaluate("localStorage.getItem('old-private-marker')") is None
        holder.close()
        prior_workers=[]
        for i in range(3):
            print('Rebuild cycle',i,flush=True)
            remote=open_fixture()
            remote.locator('#login').click()
            expect(remote.locator('#result')).to_contain_text('session=fixture-private')
            worker_path=bridge_frame().evaluate("localStorage.getItem('bare-mux-path')")
            assert worker_path and worker_path not in prior_workers
            prior_workers.append(worker_path)
            bridge_frame().evaluate("localStorage.setItem('restart-private-marker','private')")
            page.get_by_role('button',name='清理并重建',exact=True).click()
            expect(page.locator('.browser-go')).to_be_enabled(timeout=35000)
            assert bridge_frame().evaluate("localStorage.getItem('restart-private-marker')") is None
            remote=open_fixture()
            f=next(f for f in page.frames if f.url.startswith(browse+'/p/'))
            f.wait_for_function('Boolean(window.upstream)')
            assert 'session=fixture-private' not in f.evaluate('window.upstream.cookie')
        page.get_by_role('button',name='结束浏览并退出').click()
        expect(page.locator('#browser-password')).to_be_visible(timeout=10000)
        probe=context.new_page();probe.goto(browse+'/')
        assert not probe.evaluate('async()=>await indexedDB.databases()')
        assert probe.evaluate('localStorage.length')==0
        print('PASS: nonresponsive transport times out; recovery with retained database handle; three rebuilds use fresh workers; old cookies and storage removed; logout cleanup.')
    except Exception as e:
        (root/'artifacts').mkdir(exist_ok=True)
        page.screenshot(path=str(root/'artifacts/recovery-failure.png'),full_page=True)
        print('UI:',page.locator('main').inner_text()[:1200])
        for f in page.frames[1:]:
            try:print('FRAME',f.url,f.locator('body').text_content(timeout=1000)[:3500],flush=True)
            except Exception:pass
        raise RuntimeError(str(e).replace(password,'[redacted]')) from None
    finally:
        browser.close()
