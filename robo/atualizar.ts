// Robô diário da página pública: soma ao histórico salvo em dados/ o preço do dia, mais cópias
// antigas e as outras lojas, para os produtos da lista (dados/indice.json).
//   node --experimental-strip-types robo/atualizar.ts <link> [<link>...]
//   node --experimental-strip-types robo/atualizar.ts --todos [--minutos 20]
// Roda no GitHub Actions (todo dia) ou no PC.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolverLink } from './motor.ts';
import type { ProdutoLink } from './motor.ts';
import { montarHistorico } from './montar.ts';
import type { ArquivoProduto } from './montar.ts';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASTA_PRODUTOS = path.join(RAIZ, 'dados', 'produtos');
const INDICE = path.join(RAIZ, 'dados', 'indice.json');

interface ItemIndice {
  loja: string;
  id: string;
  url: string;
  titulo: string | null;
  atualizadoEm: string;
  quantidade: number;
  lojas: number;
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

export async function atualizarProduto(produto: ProdutoLink, copias: number, copiasComparador: number) {
  const antes = lerJson<ArquivoProduto>(arquivoDe(produto));
  const resultado = await montarHistorico(produto, antes, { copias, copiasComparador });
  gravarJson(arquivoDe(produto), resultado.dados);
  return resultado;
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
        lojas: new Set(dados.pontos.map((p) => p.loja ?? '')).size,
        ultimoPrecoCentavos: dados.resumo.atual?.precoCentavos ?? null,
        menorPrecoCentavos: dados.resumo.menor?.precoCentavos ?? null,
      });
    }
  }
  itens.sort((a, b) => (a.titulo ?? a.id).localeCompare(b.titulo ?? b.id, 'pt-BR'));
  gravarJson(INDICE, { atualizadoEm: new Date().toISOString(), produtos: itens });
  return itens;
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
    const { dados, avisos } = await atualizarProduto(produto, 5, 3);
    console.log(`${produto.id}: ${dados.pontos.length} preços. ${avisos.join(' ')}`);
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

  const links = args.filter((a) => /^https?:\/\//.test(a));
  if (links.length === 0) {
    console.log('Uso: atualizar.ts <link>... | --todos [--minutos N]');
    process.exitCode = 2;
    return;
  }
  for (const link of links) {
    const produto = await resolverLink(link);
    if (!produto) {
      console.log(`Link não reconhecido: ${link}`);
      continue;
    }
    const { dados, avisos } = await atualizarProduto(produto, Number(valor('--copias') ?? 25), Number(valor('--copias-lojas') ?? 8));
    const lojas = new Set(dados.pontos.map((p) => p.loja ?? '(link)'));
    console.log(`${produto.id} (${dados.titulo ?? '?'}): ${dados.pontos.length} preços em ${lojas.size} lojas. ${dados.resumo.veredito} ${avisos.join(' ')}`);
  }
  refazerIndice();
}

await principal();
