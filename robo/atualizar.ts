// Robô da página pública: busca o histórico de preço e grava em dados/.
//   node --experimental-strip-types robo/atualizar.ts <link> [<link>...]
//   node --experimental-strip-types robo/atualizar.ts --pedido pedido.txt --resposta resposta.md
//   node --experimental-strip-types robo/atualizar.ts --todos
// Roda no GitHub Actions (pedido aberto como issue e conferência diária) ou no PC.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buscarHistoricoArquivado,
  juntarPontos,
  lerPrecoAtual,
  resolverLink,
  resumir,
} from './motor.ts';
import type { PontoDePreco, ProdutoLink, Resumo } from './motor.ts';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASTA_PRODUTOS = path.join(RAIZ, 'dados', 'produtos');
const INDICE = path.join(RAIZ, 'dados', 'indice.json');
const LIMITE_DE_PRODUTOS = 500;
const ENDERECO_PAGINA = 'https://matheusmerlim1.github.io/historico-de-precos/';

interface ArquivoProduto {
  produto: ProdutoLink;
  titulo: string | null;
  criadoEm: string;
  atualizadoEm: string;
  copiasLidas: string[];
  copiasRestantes: number;
  pontos: PontoDePreco[];
  resumo: Resumo;
}

interface ItemIndice {
  loja: string;
  id: string;
  url: string;
  titulo: string | null;
  atualizadoEm: string;
  quantidade: number;
  ultimoPrecoCentavos: number | null;
  menorPrecoCentavos: number | null;
}

function arquivoDe(produto: { loja: string; id: string }): string {
  return path.join(PASTA_PRODUTOS, `${produto.loja}_${produto.id}.json`);
}

function lerJson<T>(arquivo: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(arquivo, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function gravarJson(arquivo: string, dados: unknown): void {
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  fs.writeFileSync(arquivo, JSON.stringify(dados, null, 1) + '\n', 'utf-8');
}

function reais(centavos: number | null | undefined): string {
  if (centavos == null) return '—';
  return (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export async function atualizarProduto(
  produto: ProdutoLink,
  maximoDeCopias: number,
): Promise<{ dados: ArquivoProduto; avisos: string[] }> {
  const antes = lerJson<ArquivoProduto>(arquivoDe(produto));
  const avisos: string[] = [];
  const agora = new Date().toISOString();

  const arquivo = await buscarHistoricoArquivado(produto, {
    jaLidas: new Set(antes?.copiasLidas ?? []),
    maximoDeCopias,
  });
  if (arquivo.bloqueado) avisos.push('O Internet Archive pediu uma pausa; o resto das cópias antigas fica para a próxima rodada.');
  if (arquivo.totalDeCopias === 0 && !arquivo.bloqueado && !antes) {
    avisos.push('O Internet Archive não tem cópias desta página; o histórico vai crescer com a conferência diária.');
  }

  const hoje = await lerPrecoAtual(produto);
  if (!hoje.ponto) avisos.push('A loja não mostrou o preço de hoje para o robô (às vezes ela pede captcha).');

  const pontos = juntarPontos(antes?.pontos ?? [], arquivo.pontos, hoje.ponto ? [hoje.ponto] : []);
  const dados: ArquivoProduto = {
    produto,
    titulo: hoje.titulo ?? antes?.titulo ?? arquivo.titulo ?? null,
    criadoEm: antes?.criadoEm ?? agora,
    atualizadoEm: agora,
    copiasLidas: [...new Set([...(antes?.copiasLidas ?? []), ...arquivo.lidas])].sort(),
    copiasRestantes: arquivo.faltam,
    pontos,
    resumo: resumir(pontos),
  };
  gravarJson(arquivoDe(produto), dados);
  return { dados, avisos };
}

function refazerIndice(): ItemIndice[] {
  const itens: ItemIndice[] = [];
  if (fs.existsSync(PASTA_PRODUTOS)) {
    for (const nome of fs.readdirSync(PASTA_PRODUTOS)) {
      if (!nome.endsWith('.json')) continue;
      const dados = lerJson<ArquivoProduto>(path.join(PASTA_PRODUTOS, nome));
      if (!dados) continue;
      itens.push({
        loja: dados.produto.loja,
        id: dados.produto.id,
        url: dados.produto.url,
        titulo: dados.titulo,
        atualizadoEm: dados.atualizadoEm,
        quantidade: dados.pontos.length,
        ultimoPrecoCentavos: dados.resumo.atual?.precoCentavos ?? null,
        menorPrecoCentavos: dados.resumo.menor?.precoCentavos ?? null,
      });
    }
  }
  itens.sort((a, b) => (a.titulo ?? a.id).localeCompare(b.titulo ?? b.id, 'pt-BR'));
  gravarJson(INDICE, { atualizadoEm: new Date().toISOString(), produtos: itens });
  return itens;
}

function primeiroLink(texto: string): string | null {
  return texto.match(/https?:\/\/[^\s<>()"'`]+/)?.[0]?.replace(/[.,;!?)]+$/, '') ?? null;
}

async function atenderPedido(arquivoPedido: string, arquivoResposta: string): Promise<void> {
  const texto = fs.readFileSync(arquivoPedido, 'utf-8');
  const link = primeiroLink(texto);
  const responder = (md: string) => fs.writeFileSync(arquivoResposta, md, 'utf-8');

  if (!link) {
    responder('Não achei nenhum link no pedido. Abra um novo pedido com o link do produto (Amazon ou Mercado Livre).');
    return;
  }
  const produto = await resolverLink(link);
  if (!produto) {
    responder(`Não reconheci \`${link.slice(0, 200)}\` como produto da Amazon (amazon.com.br) ou do Mercado Livre.`);
    return;
  }
  const jaExiste = fs.existsSync(arquivoDe(produto));
  const total = fs.existsSync(PASTA_PRODUTOS) ? fs.readdirSync(PASTA_PRODUTOS).length : 0;
  if (!jaExiste && total >= LIMITE_DE_PRODUTOS) {
    responder(`A lista chegou ao limite de ${LIMITE_DE_PRODUTOS} produtos; não foi possível incluir este agora.`);
    return;
  }

  const { dados, avisos } = await atualizarProduto(produto, 30);
  refazerIndice();
  const r = dados.resumo;
  const endereco = `${ENDERECO_PAGINA}?produto=${produto.loja}_${produto.id}`;
  responder(
    [
      `**${dados.titulo ?? produto.id}**`,
      '',
      r.quantidade
        ? `${r.quantidade} preços registrados desde ${r.primeiraData?.slice(0, 10)}. Menor: ${reais(r.menor?.precoCentavos)}, maior: ${reais(r.maior?.precoCentavos)}, último: ${reais(r.atual?.precoCentavos)}.`
        : 'Ainda não encontrei preços para este produto.',
      '',
      r.veredito,
      ...avisos.map((a) => `- ${a}`),
      '',
      `Gráfico: ${endereco} (a página leva cerca de 1 minuto para mostrar os dados novos).`,
      '',
      'O robô confere este produto todos os dias, então o histórico continua crescendo.',
    ].join('\n'),
  );
}

async function conferirTodos(minutos: number): Promise<void> {
  const fim = Date.now() + minutos * 60_000;
  const itens = refazerIndice().sort((a, b) => a.atualizadoEm.localeCompare(b.atualizadoEm));
  for (const item of itens) {
    if (Date.now() > fim) {
      console.log('Tempo da rodada acabou; os demais ficam para amanhã.');
      break;
    }
    const produto: ProdutoLink = { loja: item.loja as ProdutoLink['loja'], id: item.id, url: item.url };
    const { dados, avisos } = await atualizarProduto(produto, 5);
    console.log(`${item.id}: ${dados.pontos.length} preços. ${avisos.join(' ')}`);
  }
  refazerIndice();
}

async function principal(): Promise<void> {
  const args = process.argv.slice(2);
  const valor = (nome: string) => {
    const i = args.indexOf(nome);
    return i >= 0 ? args[i + 1] : undefined;
  };

  if (args.includes('--todos')) return conferirTodos(Number(valor('--minutos') ?? 20));

  const pedido = valor('--pedido');
  if (pedido) return atenderPedido(pedido, valor('--resposta') ?? 'resposta.md');

  const links = args.filter((a) => /^https?:\/\//.test(a));
  if (links.length === 0) {
    console.log('Uso: atualizar.ts <link>... | --pedido arquivo --resposta arquivo | --todos [--minutos N]');
    process.exitCode = 2;
    return;
  }
  for (const link of links) {
    const produto = await resolverLink(link);
    if (!produto) {
      console.log(`Link não reconhecido: ${link}`);
      continue;
    }
    const { dados, avisos } = await atualizarProduto(produto, Number(valor('--copias') ?? 30));
    console.log(`${produto.id} (${dados.titulo ?? '?'}): ${dados.pontos.length} preços. ${dados.resumo.veredito} ${avisos.join(' ')}`);
  }
  refazerIndice();
}

await principal();
