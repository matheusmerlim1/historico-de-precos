// Servidor da página pública (função da Vercel): recebe o link, monta o histórico na hora e
// devolve, linha a linha (NDJSON), o andamento e o resultado. A página chama
//   GET /api/historico?link=<link do produto>
// Empacotado em api/historico.js (ver README). Sem estado próprio: parte do histórico que o robô
// diário já salvou em dados/ (lido da página no GitHub Pages) e soma o que achar agora.
import { ehLinkCurto, identificarLink, resolverLink } from '../robo/motor.ts';
import { montarHistorico } from '../robo/montar.ts';
import type { ArquivoProduto } from '../robo/montar.ts';

const PAGINA = 'https://matheusmerlim1.github.io/historico-de-precos';
const ORIGENS = [/^https:\/\/matheusmerlim1\.github\.io$/, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];
const GUARDA_MS = 6 * 3600 * 1000;

// Resultados recentes guardados na memória da função (vale enquanto ela está "quente").
const recentes = new Map<string, { quando: number; resultado: unknown }>();

function cabecalhosCors(req: Request): Record<string, string> {
  const origem = req.headers.get('Origin') ?? '';
  return ORIGENS.some((r) => r.test(origem)) ? { 'Access-Control-Allow-Origin': origem, Vary: 'Origin' } : {};
}

async function salvoPeloRobo(chave: string): Promise<ArquivoProduto | null> {
  try {
    const resp = await fetch(`${PAGINA}/dados/produtos/${chave}.json?t=${Date.now()}`);
    return resp.ok ? ((await resp.json()) as ArquivoProduto) : null;
  } catch {
    return null;
  }
}

export async function GET(req: Request): Promise<Response> {
  const cors = cabecalhosCors(req);
  const link = new URL(req.url).searchParams.get('link')?.trim() ?? '';
  if (!/^https?:\/\/\S{4,1990}$/.test(link)) {
    return Response.json({ erro: 'Cole o link de um produto.' }, { status: 400, headers: cors });
  }

  const codificador = new TextEncoder();
  const fluxo = new TransformStream<Uint8Array, Uint8Array>();
  const escritor = fluxo.writable.getWriter();
  const enviar = (obj: unknown) => escritor.write(codificador.encode(JSON.stringify(obj) + '\n'));

  (async () => {
    try {
      await enviar({ etapa: 'Identificando o produto pelo link...' });
      const produto = identificarLink(link) ?? (ehLinkCurto(link) ? await resolverLink(link) : null);
      if (!produto) {
        await enviar({ erro: 'Não reconheci o link. Use o link de um produto da amazon.com.br ou do mercadolivre.com.br.' });
        return;
      }
      const chave = `${produto.loja}_${produto.id}`;
      const guardado = recentes.get(chave);
      if (guardado && Date.now() - guardado.quando < GUARDA_MS) {
        await enviar({ resultado: guardado.resultado });
        return;
      }

      const antes = await salvoPeloRobo(chave);
      const { dados, avisos } = await montarHistorico(produto, antes, {
        copias: antes ? 6 : 15,
        copiasComparador: antes ? 3 : 6,
        pausaMs: 1000,
        aoAvancar: (etapa) => void enviar({ etapa }),
      });
      const resultado = { ...dados, avisos, chave };
      recentes.set(chave, { quando: Date.now(), resultado });
      if (recentes.size > 200) recentes.delete(recentes.keys().next().value!);
      await enviar({ resultado });
    } catch (erro) {
      await enviar({ erro: `Falha ao montar o histórico: ${erro instanceof Error ? erro.message : String(erro)}` });
    } finally {
      await escritor.close();
    }
  })();

  return new Response(fluxo.readable, {
    headers: {
      ...cors,
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
