import type { Env } from "../env.ts";

// A separate navigation lets Chrome finish clearing the old storage partition
// before Scramjet opens a new IndexedDB connection or creates any workers.
export function recoveryPage(env: Env) {
  return new Response(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>清理浏览环境</title><style>html{color-scheme:light dark;font:14px system-ui}body{display:grid;place-content:center;min-height:90vh;margin:0;padding:16px;text-align:center}</style></head><body><p id="status">正在清理上次会话…</p><script>
  (async()=>{
    const home=${JSON.stringify(env.HOME_ORIGIN)};
    const attempt=new URL(location.href).searchParams.get('attempt')||'';
    const tell=(type,data={})=>parent.postMessage({channel:'bin-browser',type,attempt,...data},home);
    try {
      const control=new BroadcastChannel('bin-transport-control');
      control.postMessage({type:'stop',all:true});control.close();
      await Promise.race([
        (async()=>{
          const registrations=await navigator.serviceWorker.getRegistrations();
          await Promise.all(registrations.map(r=>r.unregister()));
          localStorage.clear();sessionStorage.clear();
        })(),
        new Promise((_,reject)=>setTimeout(()=>reject(new Error('清理超时，请关闭其他浏览器工具标签页后重试。')),12000))
      ]);
      document.getElementById('status').textContent='清理完成，正在重新进入…';
      if(parent!==window)tell('reset-done');
      else document.getElementById('status').textContent='清理完成，请返回主页的网页浏览器重新进入。';
    } catch(error) {
      const message=error instanceof Error?error.message:'浏览器未允许清理网站存储。';
      document.getElementById('status').textContent=message;
      tell('error',{message,fatal:true});
    }
  })();
  </script></body></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "clear-site-data": '"storage", "cache"',
      },
    },
  );
}
