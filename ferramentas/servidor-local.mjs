// Roda a função da Vercel (api/historico.mjs) no PC, para testar: node ferramentas/servidor-local.mjs [porta]
import http from 'node:http';
import { Readable } from 'node:stream';
import { GET } from '../api/historico.mjs';

const porta = Number(process.argv[2] ?? 8787);
http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${porta}`);
    if (url.pathname !== '/api/historico') {
      res.writeHead(404).end();
      return;
    }
    const resposta = await GET(new Request(url, { headers: req.headers }));
    res.writeHead(resposta.status, Object.fromEntries(resposta.headers));
    if (resposta.body) Readable.fromWeb(resposta.body).pipe(res);
    else res.end();
  })
  .listen(porta, '127.0.0.1', () => console.log(`servidor local em http://127.0.0.1:${porta}/api/historico`));
