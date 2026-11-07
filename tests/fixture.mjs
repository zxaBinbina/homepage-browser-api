import http from "node:http";
import { WebSocketServer } from "ws";
// Local-only upstream for meaningful browser tests; not included in the Worker.
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://fixture.test");
  if (url.pathname === "/data") {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        cookie: request.headers.cookie || "",
        ua: request.headers["user-agent"],
        range: request.headers.range || "",
      }),
    );
    return;
  }
  if (url.pathname === "/login") {
    response.setHeader("set-cookie", [
      "session=fixture-private; HttpOnly; SameSite=Lax; Path=/",
      "visible=fixture; Path=/",
    ]);
    response.writeHead(302, { location: "/page" });
    response.end();
    return;
  }
  if (url.pathname === "/range") {
    response.writeHead(206, {
      "content-range": "bytes 0-3/100",
      "content-type": "video/mp4",
    });
    response.end(Buffer.from([1, 2, 3, 4]));
    return;
  }
  if (url.pathname === "/submit") {
    let data = "";
    for await (const part of request) data += part;
    response.setHeader("content-type", "text/html");
    response.end('<h1 id="submitted">' + data.replace(/</g, "&lt;") + "</h1>");
    return;
  }
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(`<!doctype html><html><head><title>Proxy fixture</title></head><body><h1>Dynamic proxy fixture</h1><button id="login" onclick="location.href='/login'">Login</button><p id="result">waiting</p><p id="identity"></p><p id="socket">waiting</p><form action="/submit" method="post"><input name="message" value="你好世界"><button id="submit">Submit</button></form><script>
  window.ran=true; document.querySelector('#identity').textContent=navigator.userAgent;
  localStorage.setItem('private-note','fixture-local'); sessionStorage.setItem('private-session','fixture-session');
  fetch('/data').then(r=>r.json()).then(data=>{ document.querySelector('#result').textContent=data.cookie;window.upstream=data });
  const socket=new WebSocket('ws://fixture.test/echo');socket.onopen=()=>socket.send('fixture-message');socket.onmessage=e=>document.querySelector('#socket').textContent=e.data;
  </script></body></html>`);
});
const sockets = new WebSocketServer({ noServer: true });
server.on("upgrade", (request, socket, head) =>
  sockets.handleUpgrade(request, socket, head, (ws) =>
    sockets.emit("connection", ws),
  ),
);
sockets.on("connection", (socket) =>
  socket.on("message", (data, binary) => socket.send(data, { binary })),
);
server.listen(8790, "127.0.0.1", () =>
  console.log("Local fixture ready on :8790"),
);
