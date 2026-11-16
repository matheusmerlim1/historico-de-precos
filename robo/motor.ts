// Motor do histórico de preço: identifica o produto pelo link, lista as cópias da página
// guardadas no Internet Archive (Wayback Machine), lê o preço de cada cópia e resume a série.
// Não depende de nenhuma biblioteca: roda no app local (tsx) e no robô do repositório público
// (node --experimental-strip-types). O repositório historico-de-precos tem uma cópia deste arquivo.

/** buscape = página de produto do comparador Buscapé (várias lojas; usada quando a busca pelo nome cai lá). */
export type Loja = 'amazon' | 'mercadolivre' | 'buscape';

export interface ProdutoLink {
  loja: Loja;
  id: string;
  url: string;
}

export type Fonte = 'arquivo' | 'loja' | 'telegram' | 'comparador';

export interface PontoDePreco {
  data: string;
  precoCentavos: number;
  precoDeCentavos: number | null;
  fonte: Fonte;
  link?: string;
  /** Outra loja onde o mesmo produto é vendido (vazio = a loja do link consultado). */
  loja?: string;
}

export interface LeituraDaPagina {
  precoCentavos: number | null;
  precoDeCentavos: number | null;
  titulo: string | null;
}

export interface CopiaArquivada {
  timestamp: string;
  original: string;
}

export interface Resumo {
  quantidade: number;
  menor: PontoDePreco | null;
  maior: PontoDePreco | null;
  mediaCentavos: number | null;
  atual: PontoDePreco | null;
  primeiraData: string | null;
  veredito: string;
}

type Buscar = (url: string, init?: RequestInit) => Promise<Response>;

const ARQUIVO = { 'User-Agent': 'historico-de-precos/1.0 (+https://github.com/matheusmerlim1/historico-de-precos)' };

export class ArquivoIndisponivel extends Error {
  constructor() {
    super('Não foi possível consultar o Internet Archive agora.');
  }
}

export class BloqueadoPeloArquivo extends Error {
  constructor() {
    super('O Internet Archive pediu para esperar (muitos pedidos seguidos).');
  }
}

const NAVEGADOR = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
};

export function identificarLink(texto: string): ProdutoLink | null {
  let url: URL;
  try {
    url = new URL(texto.trim());
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();

  if (/(^|\.)amazon\.com\.br$/.test(host)) {
    const m = url.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:[/?]|$)/i);
    if (!m) return null;
    const id = m[1]!.toUpperCase();
    return { loja: 'amazon', id, url: `https://www.amazon.com.br/dp/${id}` };
  }

  if (/(^|\.)mercadoli(vre|bre)\.com\.br$/.test(host)) {
    const m = (url.pathname + url.search).match(/MLB-?(\d{6,})/i);
    if (!m) return null;
    const limpa = `${url.origin}${url.pathname}`;
    return { loja: 'mercadolivre', id: `MLB${m[1]}`, url: limpa };
  }

  if (/(^|\.)buscape\.com\.br$/.test(host)) {
    const m = url.pathname.match(/^\/([a-z0-9-]+)\/([a-z0-9-]+)\/?$/);
    if (!m || /^(search|lead|busca|ofertas|cupons|promocoes)$/.test(m[1]!)) return null;
    return { loja: 'buscape', id: m[2]!, url: `https://www.buscape.com.br/${m[1]}/${m[2]}` };
  }

  return null;
}

export function ehLinkCurto(texto: string): boolean {
  try {
    const host = new URL(texto.trim()).hostname.toLowerCase();
    return /^(amzn\.to|a\.co|mercadolivre\.com|meli\.la|bit\.ly|tinyurl\.com)$/.test(host.replace(/^www\./, ''));
  } catch {
    return false;
  }
}

/** Segue redirecionamentos (links de afiliado e encurtados) até o link da loja. */
export async function resolverLink(texto: string, buscar: Buscar = fetch): Promise<ProdutoLink | null> {
  const direto = identificarLink(texto);
  if (direto) return direto;
  try {
    const resposta = await buscar(texto.trim(), { redirect: 'follow', headers: NAVEGADOR });
    return identificarLink(resposta.url);
  } catch {
    return null;
  }
}

export function precoBrParaCentavos(texto: string | null | undefined): number | null {
  if (!texto) return null;
  const m = texto.replace(/\s/g, '').match(/(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?/);
  if (!m) return null;
  const reais = Number.parseInt(m[1]!.replace(/\./g, ''), 10);
  const centavos = m[2] ? Number.parseInt(m[2].padEnd(2, '0'), 10) : 0;
  const total = reais * 100 + centavos;
  return Number.isFinite(total) && total > 0 ? total : null;
}

function decodificar(texto: string): string {
  return texto
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function trechoDepois(html: string, marcador: string, tamanho: number): string | null {
  const i = html.indexOf(marcador);
  return i < 0 ? null : html.slice(i, i + tamanho);
}

function precoDoSpan(trecho: string): number | null {
  const visivel = trecho.match(/class="a-offscreen">\s*(R\$\s?[\d.,]+)/);
  if (visivel) return precoBrParaCentavos(visivel[1]);
  const partes = trecho.match(/a-price-whole">([\d.]+)[\s\S]{0,120}?a-price-fraction">(\d{2})/);
  if (partes) return precoBrParaCentavos(`${partes[1]},${partes[2]}`);
  return null;
}

/** Preço a pagar dentro do bloco de preço; ignora o preço "de" riscado (a-text-price). */
function precoNoTrecho(bruto: string | null): number | null {
  if (!bruto) return null;
  const trecho = bruto.replace(/<span class="a-price a-text-price[\s\S]*?<\/span>\s*<\/span>/g, '');
  const aPagar = trecho.indexOf('priceToPay');
  if (aPagar >= 0) {
    const preco = precoDoSpan(trecho.slice(aPagar, aPagar + 900));
    if (preco) return preco;
  }
  const leitor = trecho.match(/class="aok-offscreen">\s*(R\$\s?[\d.,]+)/);
  if (leitor) return precoBrParaCentavos(leitor[1]);
  return precoDoSpan(trecho);
}

function lerAmazon(html: string): LeituraDaPagina {
  const blocos = [
    'id="corePriceDisplay_desktop_feature_div"',
    'id="corePrice_feature_div"',
    'id="corePrice_desktop"',
    'id="priceblock_dealprice"',
    'id="priceblock_ourprice"',
    'id="price_inside_buybox"',
  ];
  let preco: number | null = null;
  for (const bloco of blocos) {
    preco = precoNoTrecho(trechoDepois(html, bloco, 4000));
    if (preco) break;
  }

  let precoDe: number | null = null;
  const base = trechoDepois(html, 'basisPrice', 1500) ?? trechoDepois(html, 'a-text-price', 600);
  if (base) {
    const m = base.match(/class="a-offscreen">\s*(R\$\s?[\d.,]+)/);
    precoDe = m ? precoBrParaCentavos(m[1]) : null;
  }
  if (precoDe != null && preco != null && precoDe <= preco) precoDe = null;

  const titulo =
    html.match(/id="productTitle"[^>]*>([^<]+)/)?.[1] ??
    html.match(/<title>([^<|]+)/)?.[1]?.replace(/\s*[:|-]\s*Amazon\.com\.br.*$/i, '') ??
    null;

  return { precoCentavos: preco, precoDeCentavos: precoDe, titulo: titulo ? decodificar(titulo) : null };
}

function lerMercadoLivre(html: string): LeituraDaPagina {
  let preco: number | null = null;
  const ld = html.match(/"offers"\s*:\s*\{[^}]*?"price"\s*:\s*"?([\d.]+)/) ?? html.match(/"price"\s*:\s*"?(\d+(?:\.\d+)?)"?\s*,\s*"priceCurrency"/);
  if (ld) preco = Math.round(Number.parseFloat(ld[1]!) * 100);
  if (!preco) {
    const meta = html.match(/itemprop="price"\s+content="([\d.]+)"/);
    if (meta) preco = Math.round(Number.parseFloat(meta[1]!) * 100);
  }
  if (!preco) {
    const og = html.match(/property="og:title"\s+content="[^"]*R\$\s?([\d.,]+)"/);
    if (og) preco = precoBrParaCentavos(og[1]);
  }

  let precoDe: number | null = null;
  const anterior = trechoDepois(html, 'andes-money-amount--previous', 600);
  if (anterior) {
    const inteiro = anterior.match(/andes-money-amount__fraction"[^>]*>([\d.]+)/)?.[1];
    const fracao = anterior.match(/andes-money-amount__cents[^"]*"[^>]*>(\d{2})/)?.[1];
    if (inteiro) precoDe = precoBrParaCentavos(`${inteiro},${fracao ?? '00'}`);
  }
  if (precoDe != null && preco != null && precoDe <= preco) precoDe = null;

  const tituloBruto =
    html.match(/<h1[^>]*class="[^"]*ui-pdp-title[^"]*"[^>]*>([^<]+)/)?.[1] ??
    html.match(/property="og:title"\s+content="([^"]+)"/)?.[1]?.replace(/\s*-\s*R\$.*$/, '') ??
    null;
  const titulo = tituloBruto && tituloBruto.trim() ? decodificar(tituloBruto) : null;

  return { precoCentavos: preco && preco > 0 ? preco : null, precoDeCentavos: precoDe, titulo };
}

export function lerPrecoDoHtml(loja: Loja, html: string): LeituraDaPagina {
  return loja === 'amazon' ? lerAmazon(html) : lerMercadoLivre(html);
}

function padroesDeBusca(produto: ProdutoLink): string[] {
  if (produto.loja === 'amazon') return [`amazon.com.br/dp/${produto.id}`, `amazon.com.br/gp/product/${produto.id}`];
  const numero = produto.id.replace(/^MLB/, '');
  const padroes = [
    `produto.mercadolivre.com.br/MLB-${numero}`,
    `www.mercadolivre.com.br/p/MLB${numero}`,
    `mercadolivre.com.br/up/MLBU${numero}`,
  ];
  const informado = produto.url.replace(/^https?:\/\//, '');
  if (!padroes.some((p) => informado.startsWith(p))) padroes.push(informado);
  return padroes;
}

export function timestampParaIso(ts: string): string {
  return `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(8, 10) || '00'}:${ts.slice(10, 12) || '00'}:${ts.slice(12, 14) || '00'}Z`;
}

/** Escolhe até `maximo` cópias espalhadas no tempo, sempre com a primeira e a última. */
export function espalharNoTempo<T>(itens: T[], maximo: number): T[] {
  if (maximo <= 0) return [];
  if (itens.length <= maximo) return itens;
  if (maximo <= 1) return itens.slice(-1);
  const escolhidos: T[] = [];
  const passo = (itens.length - 1) / (maximo - 1);
  for (let i = 0; i < maximo; i++) escolhidos.push(itens[Math.round(i * passo)]!);
  return escolhidos;
}

// Páginas de captcha da loja também ficam guardadas no Archive com status 200, mas são pequenas
// (até ~20 KB comprimidas); uma página de produto de verdade passa de 60 KB.
const TAMANHO_MINIMO_DA_COPIA = 40000;

/** Lista as cópias da página do produto guardadas no Internet Archive (a maior de cada dia). */
export async function listarCopiasArquivadas(produto: ProdutoLink, buscar: Buscar = fetch): Promise<CopiaArquivada[]> {
  return listarCopiasDosEnderecos(padroesDeBusca(produto), buscar);
}

export async function listarCopiasDosEnderecos(padroes: string[], buscar: Buscar = fetch): Promise<CopiaArquivada[]> {
  const porDia = new Map<string, CopiaArquivada & { tamanho: number }>();
  let falhas = 0;
  for (const padrao of padroes) {
    const url =
      'https://web.archive.org/cdx/search/cdx?output=json&fl=timestamp,original,statuscode,length' +
      `&matchType=prefix&filter=statuscode:200&collapse=timestamp:10&url=${encodeURIComponent(padrao)}`;
    let linhas: string[][] = [];
    try {
      const resposta = await buscar(url, { headers: ARQUIVO });
      if (resposta.status === 429) throw new BloqueadoPeloArquivo();
      if (!resposta.ok) {
        falhas++;
        continue;
      }
      const texto = await resposta.text();
      linhas = texto.trim() ? (JSON.parse(texto) as string[][]) : [];
    } catch (erro) {
      if (erro instanceof BloqueadoPeloArquivo) throw erro;
      falhas++;
      continue;
    }
    for (const linha of linhas.slice(1)) {
      const [timestamp, original, , tamanhoTexto] = linha;
      if (!timestamp || !original || /%22|\+t\.|\.(jpg|png|gif|js|css)(\?|$)/i.test(original)) continue;
      const tamanho = Number(tamanhoTexto);
      if (Number.isFinite(tamanho) && tamanho < TAMANHO_MINIMO_DA_COPIA) continue;
      const dia = timestamp.slice(0, 8);
      const atual = porDia.get(dia);
      if (!atual || (Number.isFinite(tamanho) && tamanho > atual.tamanho)) {
        porDia.set(dia, { timestamp, original, tamanho: Number.isFinite(tamanho) ? tamanho : 0 });
      }
    }
  }
  if (padroes.length > 0 && falhas === padroes.length) throw new ArquivoIndisponivel();
  return [...porDia.values()]
    .map(({ timestamp, original }) => ({ timestamp, original }))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export async function lerCopiaArquivada(
  produto: ProdutoLink,
  copia: CopiaArquivada,
  buscar: Buscar = fetch,
): Promise<{ ponto: PontoDePreco | null; titulo: string | null }> {
  const endereco = `https://web.archive.org/web/${copia.timestamp}id_/${copia.original}`;
  try {
    const resposta = await buscar(endereco, { headers: ARQUIVO });
    if (resposta.status === 429) throw new BloqueadoPeloArquivo();
    if (!resposta.ok) return { ponto: null, titulo: null };
    // O Archive pode redirecionar para a cópia mais próxima, de outro dia: vale a data entregue.
    const entregue = resposta.url.match(/\/web\/(\d{14})id_\//)?.[1] ?? copia.timestamp;
    const leitura = lerPrecoDoHtml(produto.loja, await resposta.text());
    if (!leitura.precoCentavos) return { ponto: null, titulo: leitura.titulo };
    return {
      titulo: leitura.titulo,
      ponto: {
        data: timestampParaIso(entregue),
        precoCentavos: leitura.precoCentavos,
        precoDeCentavos: leitura.precoDeCentavos,
        fonte: 'arquivo',
        link: `https://web.archive.org/web/${entregue}/${copia.original}`,
      },
    };
  } catch (erro) {
    if (erro instanceof BloqueadoPeloArquivo) throw erro;
    return { ponto: null, titulo: null };
  }
}

export interface OpcoesHistorico {
  buscar?: Buscar;
  maximoDeCopias?: number;
  pausaMs?: number;
  jaLidas?: Set<string>;
  aoAvancar?: (lidas: number, total: number) => void;
  /** Quando devolver true, para de ler cópias (ex.: o tempo da consulta está acabando). */
  parar?: () => boolean;
}

export interface HistoricoArquivado {
  pontos: PontoDePreco[];
  titulo: string | null;
  lidas: string[];
  totalDeCopias: number;
  faltam: number;
  bloqueado: boolean;
  /** O Internet Archive não respondeu (fora do ar ou lento): não dá para dizer se há cópias. */
  indisponivel: boolean;
}

const esperar = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

/**
 * Lê o preço das cópias arquivadas ainda não lidas (`jaLidas` guarda os timestamps), uma por vez
 * e com pausa, como o Internet Archive pede. Se ele bloquear, devolve o que já leu.
 */
export async function buscarHistoricoArquivado(
  produto: ProdutoLink,
  opcoes: OpcoesHistorico = {},
): Promise<HistoricoArquivado> {
  const buscar = opcoes.buscar ?? fetch;
  const pausa = opcoes.pausaMs ?? 1500;
  let todas: CopiaArquivada[];
  try {
    todas = await listarCopiasArquivadas(produto, buscar);
  } catch (erro) {
    if (erro instanceof BloqueadoPeloArquivo) {
      return { pontos: [], titulo: null, lidas: [], totalDeCopias: 0, faltam: 0, bloqueado: true, indisponivel: false };
    }
    if (erro instanceof ArquivoIndisponivel) {
      return { pontos: [], titulo: null, lidas: [], totalDeCopias: 0, faltam: 0, bloqueado: false, indisponivel: true };
    }
    throw erro;
  }
  const novas = todas.filter((c) => !opcoes.jaLidas?.has(c.timestamp));
  const escolhidas = espalharNoTempo(novas, opcoes.maximoDeCopias ?? 25);

  const pontos: PontoDePreco[] = [];
  const lidas: string[] = [];
  let titulo: string | null = null;
  let tituloDe = '';
  let bloqueado = false;

  for (const copia of escolhidas) {
    if (opcoes.parar?.()) break;
    if (lidas.length > 0) await esperar(pausa);
    try {
      const resultado = await lerCopiaArquivada(produto, copia, buscar);
      lidas.push(copia.timestamp);
      if (resultado.ponto) pontos.push(resultado.ponto);
      if (resultado.titulo && copia.timestamp > tituloDe) {
        titulo = resultado.titulo;
        tituloDe = copia.timestamp;
      }
    } catch (erro) {
      if (!(erro instanceof BloqueadoPeloArquivo)) throw erro;
      bloqueado = true;
      break;
    }
    opcoes.aoAvancar?.(lidas.length, escolhidas.length);
  }

  pontos.sort((a, b) => a.data.localeCompare(b.data));
  return {
    pontos,
    titulo,
    lidas,
    totalDeCopias: todas.length,
    faltam: novas.length - lidas.length,
    bloqueado,
    indisponivel: false,
  };
}

/** Preço de agora, lido direto da página da loja (a Amazon às vezes responde com captcha). */
export async function lerPrecoAtual(
  produto: ProdutoLink,
  buscar: Buscar = fetch,
): Promise<{ ponto: PontoDePreco | null; titulo: string | null }> {
  try {
    const resposta = await buscar(produto.url, { headers: { ...NAVEGADOR, Accept: 'text/html' }, redirect: 'follow' });
    if (!resposta.ok) return { ponto: null, titulo: null };
    const leitura = lerPrecoDoHtml(produto.loja, await resposta.text());
    if (!leitura.precoCentavos) return { ponto: null, titulo: leitura.titulo };
    return {
      titulo: leitura.titulo,
      ponto: {
        data: new Date().toISOString(),
        precoCentavos: leitura.precoCentavos,
        precoDeCentavos: leitura.precoDeCentavos,
        fonte: 'loja',
        link: produto.url,
      },
    };
  } catch {
    return { ponto: null, titulo: null };
  }
}

/** Junta séries de fontes diferentes, sem repetir o mesmo preço da mesma fonte no mesmo dia. */
export function juntarPontos(...listas: PontoDePreco[][]): PontoDePreco[] {
  const unicos = new Map<string, PontoDePreco>();
  for (const ponto of listas.flat()) {
    const chave = `${ponto.loja ?? ''}|${ponto.fonte}|${ponto.data.slice(0, 10)}|${ponto.precoCentavos}`;
    if (!unicos.has(chave)) unicos.set(chave, ponto);
  }
  return [...unicos.values()].sort((a, b) => a.data.localeCompare(b.data));
}

function reais(centavos: number): string {
  return `R$ ${(centavos / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function resumir(pontos: PontoDePreco[]): Resumo {
  if (pontos.length === 0) {
    return {
      quantidade: 0,
      menor: null,
      maior: null,
      mediaCentavos: null,
      atual: null,
      primeiraData: null,
      veredito: 'Ainda não há preços registrados para este produto.',
    };
  }
  const ordenados = [...pontos].sort((a, b) => a.data.localeCompare(b.data));
  const atual = ordenados.at(-1)!;
  const menor = ordenados.reduce((m, p) => (p.precoCentavos < m.precoCentavos ? p : m));
  const maior = ordenados.reduce((m, p) => (p.precoCentavos > m.precoCentavos ? p : m));
  const media = Math.round(ordenados.reduce((s, p) => s + p.precoCentavos, 0) / ordenados.length);

  let veredito: string;
  if (ordenados.length < 3) {
    veredito = 'Poucos registros ainda: dá para ver o preço, mas não para dizer se está bom.';
  } else if (atual.precoCentavos <= menor.precoCentavos) {
    veredito = `O último preço (${reais(atual.precoCentavos)}) é o menor de todo o histórico.`;
  } else {
    const acimaDoMenor = (atual.precoCentavos - menor.precoCentavos) / menor.precoCentavos;
    const contraMedia = (atual.precoCentavos - media) / media;
    const pct = (x: number) => `${Math.round(Math.abs(x) * 100)}%`;
    if (contraMedia <= -0.05) {
      veredito = `O último preço está ${pct(contraMedia)} abaixo da média e ${pct(acimaDoMenor)} acima do menor já visto (${reais(menor.precoCentavos)}).`;
    } else if (contraMedia >= 0.05) {
      veredito = `O último preço está ${pct(contraMedia)} acima da média; o menor já visto foi ${reais(menor.precoCentavos)}.`;
    } else {
      veredito = `O último preço está perto da média; o menor já visto foi ${reais(menor.precoCentavos)}.`;
    }
  }

  return {
    quantidade: ordenados.length,
    menor,
    maior,
    mediaCentavos: media,
    atual,
    primeiraData: ordenados[0]!.data,
    veredito,
  };
}

// ---------------------------------------------------------------------------------------------
// Mesmo produto em outras lojas. O Buscapé reúne as ofertas de várias lojas (KaBuM!, Magazine
// Luiza, Casas Bahia...) numa página pública por produto; achamos essa página pelo título e lemos o
// preço de cada loja nela e nas cópias antigas dela guardadas no Internet Archive.
// ---------------------------------------------------------------------------------------------

const PALAVRAS_VAZIAS = new Set([
  'para', 'com', 'sem', 'de', 'da', 'do', 'das', 'dos', 'e', 'em', 'cor', 'preto', 'preta', 'branco', 'branca',
  'novo', 'nova', 'original', 'modelo', 'tela', 'smartphone', 'celular', 'kit', 'unidade', 'unidades',
]);

const VARIANTES = new Set(['fe', 'plus', 'ultra', 'edge', 'pro', 'max', 'mini', 'lite', 'slim', 'neo', 'prime']);
const USADO = /\b(usado|recondicionado|vitrine|seminovo)\b/;
const UNIDADE = /^\d+(gb|tb|mb|mp|mah|hz|w|g|k|pol)$/;

export function normalizarTexto(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/(\d+)\s+(gb|tb|mb|mp|mah|hz|w)\b/g, '$1$2')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** As palavras que identificam o produto (as primeiras do título, onde ficam marca e modelo). */
export function palavrasDoTitulo(titulo: string, maximo = 8): string[] {
  const unicas: string[] = [];
  for (const palavra of normalizarTexto(titulo).split(' ')) {
    const util = /\d/.test(palavra) ? palavra.length >= 2 : palavra.length >= 3 || VARIANTES.has(palavra);
    if (util && !PALAVRAS_VAZIAS.has(palavra) && !unicas.includes(palavra)) unicas.push(palavra);
    if (unicas.length >= maximo) break;
  }
  return unicas;
}

/**
 * Nota de 0 a 1 para "é o mesmo produto": 0 quando a variante (Ultra, FE, Plus...), a capacidade
 * (256GB...) ou o estado (usado) é diferente; senão, a parte das palavras do nome mais curto que
 * aparecem no outro.
 */
export function semelhancaDeProduto(tituloA: string, tituloB: string): number {
  const textoA = normalizarTexto(tituloA);
  const textoB = normalizarTexto(tituloB);
  const a = new Set(textoA.split(' ').filter(Boolean));
  const b = new Set(textoB.split(' ').filter(Boolean));
  const variantes = (x: Set<string>) => [...x].filter((p) => VARIANTES.has(p)).sort().join(',');
  if (variantes(a) !== variantes(b)) return 0;
  const capacidades = (x: Set<string>) => [...x].filter((p) => /^\d+(gb|tb)$/.test(p));
  const capA = capacidades(a);
  const capB = capacidades(b);
  if (capA.length && capB.length && !capA.some((c) => capB.includes(c))) return 0;
  if (USADO.test(textoA) !== USADO.test(textoB)) return 0;
  const aMaisCurto = tituloA.length <= tituloB.length;
  const curto = aMaisCurto ? a : b;
  const outro = aMaisCurto ? b : a;
  // Códigos de modelo (S24, A55, G7...) e números soltos (iPhone 15) do nome curto têm de
  // aparecer iguais no outro: "S24 Ultra" e "S25 Ultra" diferem só nisso.
  const tituloCurto = aMaisCurto ? tituloA : tituloB;
  const nomeCurto = tituloCurto.split(/,| - | \| /)[0] ?? tituloCurto;
  for (const p of palavrasDoTitulo(nomeCurto, 6)) {
    const ehModelo = /[a-z]/.test(p) && /\d/.test(p) && !UNIDADE.test(p);
    const ehNumero = /^\d{1,3}$/.test(p);
    if ((ehModelo || ehNumero) && !outro.has(p)) return 0;
  }
  // Para a nota, contam marca, modelo e capacidade; câmera, bateria, IP54 etc. não.
  const curtas = palavrasDoTitulo(tituloCurto, 10)
    .filter((p) => !/^\d+(mp|mah|hz|w|g|k|pol)$/.test(p) && !/^ip\d+$/.test(p))
    .slice(0, 8);
  if (curtas.length === 0) return 0;
  return curtas.filter((p) => outro.has(p)).length / curtas.length;
}

/** Texto para buscar o produto num comparador: o nome do modelo e a capacidade. */
export function consultaDeBusca(titulo: string): string {
  const nome = titulo.split(/,| - | \| /)[0] ?? titulo;
  const palavras = palavrasDoTitulo(nome, 5);
  const capacidades = normalizarTexto(titulo)
    .split(' ')
    .filter((p) => /^\d+(gb|tb)$/.test(p));
  for (const c of capacidades) {
    if (palavras.length >= 7) break;
    if (!palavras.includes(c)) palavras.push(c);
  }
  return palavras.join(' ');
}

export interface PaginaComparador {
  nome: string;
  url: string;
}

export interface OfertaDeLoja {
  vendedor: string;
  precoCentavos: number;
}

function dadosNext(html: string): unknown {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]!);
  } catch {
    return null;
  }
}

/** Escolhe, na busca do Buscapé, a página do mesmo produto (ou nenhuma, se não tiver certeza). */
export function escolherNaBuscaDoBuscape(html: string, titulo: string): PaginaComparador | null {
  const dados = dadosNext(html) as { props?: { initialReduxState?: { hits?: { hits?: unknown[] } } } } | null;
  const resultados = (dados?.props?.initialReduxState?.hits?.hits ?? []) as Array<{
    name?: string;
    url?: string;
    type?: string;
  }>;
  let melhor: PaginaComparador | null = null;
  let nota = 0;
  for (const r of resultados) {
    if (!r.name || !r.url || r.type !== 'product' || !/^\/[a-z0-9-]+\/[a-z0-9-]+$/.test(r.url)) continue;
    const n = semelhancaDeProduto(titulo, r.name);
    if (n > nota) {
      nota = n;
      melhor = { nome: r.name, url: `https://www.buscape.com.br${r.url}` };
    }
  }
  return nota >= 0.75 ? melhor : null;
}

// Mesma loja com nomes diferentes ao longo do tempo (o Pontofrio virou Ponto).
const APELIDOS: Record<string, string> = { pontofrio: 'Ponto', 'ponto frio': 'Ponto' };

function nomeDaLoja(nome: string): string {
  const limpo = nome.trim().replace(/\s+/g, ' ');
  return APELIDOS[limpo.toLowerCase()] ?? limpo;
}

/** Ofertas soltas de lojas na própria busca do Buscapé, só as do mesmo produto (a mais barata de cada loja). */
export function ofertasNaBuscaDoBuscape(html: string, titulo: string): OfertaDeLoja[] {
  const dados = dadosNext(html) as { props?: { initialReduxState?: { hits?: { hits?: unknown[] } } } } | null;
  const resultados = (dados?.props?.initialReduxState?.hits?.hits ?? []) as Array<{
    name?: string;
    type?: string;
    merchantName?: string;
    price?: number;
  }>;
  const porLoja = new Map<string, number>();
  for (const r of resultados) {
    if (r.type !== 'offer' || !r.name || !r.merchantName || typeof r.price !== 'number' || !(r.price > 0)) continue;
    if (semelhancaDeProduto(titulo, r.name) < 0.75) continue;
    const vendedor = nomeDaLoja(r.merchantName);
    const centavos = Math.round(r.price * 100);
    const atual = porLoja.get(vendedor);
    if (atual == null || centavos < atual) porLoja.set(vendedor, centavos);
  }
  return [...porLoja].map(([vendedor, precoCentavos]) => ({ vendedor, precoCentavos }));
}

/** Ofertas de cada loja numa página de produto do Buscapé (a mais barata de cada loja, preço à vista). */
export function lerOfertasDoBuscape(html: string): OfertaDeLoja[] {
  const dados = dadosNext(html) as {
    props?: { initialReduxState?: { offers?: { displayOffers?: unknown[]; offerList?: unknown[] } } };
  } | null;
  const ofertas = dados?.props?.initialReduxState?.offers;
  const lista = [...(ofertas?.displayOffers ?? []), ...(ofertas?.offerList ?? [])] as Array<{
    sellerName?: string;
    merchantName?: string;
    price?: number;
    totalPrice?: number;
  }>;
  const porLoja = new Map<string, number>();
  for (const o of lista) {
    const vendedor = nomeDaLoja(o.sellerName ?? o.merchantName ?? '');
    const valor = typeof o.price === 'number' && o.price > 0 ? o.price : o.totalPrice;
    if (!vendedor || typeof valor !== 'number' || !(valor > 0)) continue;
    const centavos = Math.round(valor * 100);
    const atual = porLoja.get(vendedor);
    if (atual == null || centavos < atual) porLoja.set(vendedor, centavos);
  }
  return [...porLoja].map(([vendedor, precoCentavos]) => ({ vendedor, precoCentavos }));
}

const NOME_DA_LOJA: Record<Loja, RegExp> = {
  amazon: /^amazon(\.com\.br)?$/i,
  mercadolivre: /^mercado\s*livre$/i,
  buscape: /^$/, // produto do Buscapé: toda oferta é de uma loja
};

function pontosDasOfertas(
  produto: ProdutoLink,
  ofertas: OfertaDeLoja[],
  data: string,
  fonte: Fonte,
  link: string,
): PontoDePreco[] {
  return ofertas.map((o) => ({
    data,
    precoCentavos: o.precoCentavos,
    precoDeCentavos: null,
    fonte,
    link,
    ...(NOME_DA_LOJA[produto.loja].test(o.vendedor) ? {} : { loja: o.vendedor }),
  }));
}

export interface ResultadoOutrasLojas {
  pagina: PaginaComparador | null;
  pontos: PontoDePreco[];
  lidas: string[];
  bloqueado: boolean;
}

/** Procura o mesmo produto no Buscapé e lê o preço de cada loja hoje e nas cópias antigas. */
export async function buscarOutrasLojas(
  produto: ProdutoLink,
  titulo: string,
  opcoes: OpcoesHistorico & { pagina?: PaginaComparador | null } = {},
): Promise<ResultadoOutrasLojas> {
  const buscar = opcoes.buscar ?? fetch;
  let pagina = opcoes.pagina ?? null;
  let ofertasSoltas: OfertaDeLoja[] = [];
  const enderecoDaBusca = `https://www.buscape.com.br/search?q=${encodeURIComponent(consultaDeBusca(titulo))}`;
  if (!pagina) {
    try {
      const resp = await buscar(enderecoDaBusca, { headers: NAVEGADOR });
      if (resp.ok) {
        const html = await resp.text();
        pagina = escolherNaBuscaDoBuscape(html, titulo);
        if (!pagina) ofertasSoltas = ofertasNaBuscaDoBuscape(html, titulo);
      }
    } catch {
      pagina = null;
    }
  }
  if (!pagina) {
    // Sem página do produto: ficam as ofertas de hoje que aparecem na busca (sem histórico antigo).
    const hoje = pontosDasOfertas(produto, ofertasSoltas, new Date().toISOString(), 'loja', enderecoDaBusca);
    return { pagina: null, pontos: hoje, lidas: [], bloqueado: false };
  }

  const pontos: PontoDePreco[] = [];
  try {
    const resp = await buscar(pagina.url, { headers: NAVEGADOR });
    if (resp.ok) {
      const ofertas = lerOfertasDoBuscape(await resp.text());
      pontos.push(...pontosDasOfertas(produto, ofertas, new Date().toISOString(), 'loja', pagina.url));
    }
  } catch {
    // sem as ofertas de hoje; seguem as cópias antigas
  }

  const lidas: string[] = [];
  let bloqueado = false;
  let copias: CopiaArquivada[] = [];
  try {
    copias = await listarCopiasDosEnderecos([pagina.url.replace(/^https?:\/\//, '')], buscar);
  } catch (erro) {
    if (erro instanceof BloqueadoPeloArquivo) bloqueado = true;
    else if (!(erro instanceof ArquivoIndisponivel)) throw erro;
  }
  const novas = copias.filter((c) => !opcoes.jaLidas?.has(c.timestamp));
  const escolhidas = espalharNoTempo(novas, opcoes.maximoDeCopias ?? 8);
  for (const copia of escolhidas) {
    if (opcoes.parar?.()) break;
    if (lidas.length > 0) await esperar(opcoes.pausaMs ?? 1500);
    try {
      const resp = await buscar(`https://web.archive.org/web/${copia.timestamp}id_/${copia.original}`, { headers: ARQUIVO });
      if (resp.status === 429) throw new BloqueadoPeloArquivo();
      lidas.push(copia.timestamp);
      if (resp.ok) {
        const entregue = resp.url.match(/\/web\/(\d{14})id_\//)?.[1] ?? copia.timestamp;
        const ofertas = lerOfertasDoBuscape(await resp.text());
        const link = `https://web.archive.org/web/${entregue}/${copia.original}`;
        pontos.push(...pontosDasOfertas(produto, ofertas, timestampParaIso(entregue), 'arquivo', link));
      }
    } catch (erro) {
      if (!(erro instanceof BloqueadoPeloArquivo)) throw erro;
      bloqueado = true;
      break;
    }
    opcoes.aoAvancar?.(lidas.length, escolhidas.length);
  }
  return { pagina, pontos, lidas, bloqueado };
}

export interface ResumoDeLoja {
  loja: string | null;
  quantidade: number;
  ultimo: PontoDePreco;
  menor: PontoDePreco;
}

/** Último e menor preço de cada loja (a loja do link primeiro, depois da mais barata hoje à mais cara). */
export function resumirPorLoja(pontos: PontoDePreco[]): ResumoDeLoja[] {
  const grupos = new Map<string | null, PontoDePreco[]>();
  for (const p of pontos) {
    const chave = p.loja ?? null;
    grupos.set(chave, [...(grupos.get(chave) ?? []), p]);
  }
  const lista = [...grupos].map(([loja, doGrupo]) => {
    const ordenados = [...doGrupo].sort((a, b) => a.data.localeCompare(b.data));
    return {
      loja,
      quantidade: ordenados.length,
      ultimo: ordenados.at(-1)!,
      menor: ordenados.reduce((m, p) => (p.precoCentavos < m.precoCentavos ? p : m)),
    };
  });
  return lista.sort((a, b) => {
    if (a.loja === null) return -1;
    if (b.loja === null) return 1;
    return a.ultimo.precoCentavos - b.ultimo.precoCentavos;
  });
}

// ---------- Busca pelo nome do produto ----------

export interface ProdutoEncontrado {
  titulo: string;
  link: string;
  precoCentavos: number | null;
  imagem: string | null;
  /** De onde veio (sem o campo: Amazon). No Buscapé, o preço é o menor entre `lojas` lojas. */
  fonte?: 'amazon' | 'buscape';
  lojas?: number;
}

const PATROCINADO = /^(an[uú]ncio patrocinado|patrocinado|sponsored ad)\s*[–—-]\s*/i;

/** Lê os produtos da página de busca da Amazon (título, link /dp/, preço à vista e foto). */
export function lerBuscaDaAmazon(html: string): ProdutoEncontrado[] {
  const blocos = html.split(/(?=<div[^>]*\bdata-component-type="s-search-result")/).slice(1);
  const vistos = new Set<string>();
  const lista: ProdutoEncontrado[] = [];
  for (const bloco of blocos) {
    const asin = bloco.slice(0, 600).match(/data-asin="([A-Z0-9]{10})"/)?.[1];
    if (!asin || vistos.has(asin)) continue;
    const h2 = bloco.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/);
    const rotulo = h2?.[0].match(/aria-label="([^"]+)"/)?.[1];
    const texto = rotulo ?? h2?.[1]?.replace(/<[^>]+>/g, ' ');
    const titulo = texto ? decodificar(texto).replace(/\s+/g, ' ').replace(PATROCINADO, '').trim() : '';
    if (!titulo) continue;
    // Só o preço a pagar (span "a-price"); o "a-price a-text-price" é o preço "de", riscado.
    const preco = bloco.match(/<span class="a-price"[^>]*>\s*<span class="a-offscreen">([^<]+)</)?.[1];
    const imagem = bloco.match(/<img[^>]*class="s-image"[^>]*>/)?.[0].match(/src="(https:\/\/[^"]+)"/)?.[1] ?? null;
    vistos.add(asin);
    lista.push({
      titulo,
      link: `https://www.amazon.com.br/dp/${asin}`,
      precoCentavos: precoBrParaCentavos(preco ? decodificar(preco) : null),
      imagem,
    });
  }
  return lista;
}

/** Parte das palavras do nome procurado que aparecem no título (0 a 1). */
export function notaDaBusca(nome: string, titulo: string): number {
  const procuradas = palavrasDoTitulo(nome, 12);
  if (procuradas.length === 0) return 0;
  const doTitulo = new Set(normalizarTexto(titulo).split(' '));
  return procuradas.filter((p) => doTitulo.has(p)).length / procuradas.length;
}

const ACESSORIO = /\b(capa|capinha|case|pelicula|protetor|carregador|fonte|cabo|suporte|kit|adesivo|skin|bolsa|estojo|controle remoto|refil|filtro)\b/;

/** O título é de um acessório (capa, película, carregador...) e o nome procurado não pede acessório? */
export function ehAcessorioNaoPedido(nome: string, titulo: string): boolean {
  const inicio = normalizarTexto(titulo).split(' ').slice(0, 2).join(' '); // "Capa ..." ou "Marca Capa ..."
  const pedido = normalizarTexto(nome);
  const m = inicio.match(ACESSORIO);
  return !!m && !ACESSORIO.test(pedido) && !pedido.includes(m[1]!);
}

/** Procura o produto pelo nome na Amazon e devolve os mais parecidos com o que foi digitado. */
export async function buscarPorNome(nome: string, buscar: Buscar = fetch, maximo = 8): Promise<ProdutoEncontrado[]> {
  const resposta = await buscar(`https://www.amazon.com.br/s?k=${encodeURIComponent(nome.trim())}`, { headers: NAVEGADOR });
  if (!resposta.ok) throw new Error(`a Amazon respondeu ${resposta.status}`);
  const html = await resposta.text();
  const encontrados = lerBuscaDaAmazon(html);
  if (encontrados.length === 0 && /bm-verify|captcha|validateCaptcha/i.test(html)) {
    throw new Error('a Amazon pediu uma verificação de robô agora');
  }
  return encontrados
    .map((p, ordem) => ({ p, ordem, nota: notaDaBusca(nome, p.titulo) }))
    .filter((x) => x.nota >= 0.5 && !ehAcessorioNaoPedido(nome, x.p.titulo))
    .sort((a, b) => b.nota - a.nota || a.ordem - b.ordem)
    .slice(0, maximo)
    .map((x) => x.p);
}

// ---------- Produto do Buscapé (quando a busca pelo nome não consegue usar a Amazon) ----------

/** Nome do produto na página do Buscapé (o <title> sem o "em Promoção é no Buscapé"). */
export function lerTituloDoBuscape(html: string): string | null {
  const bruto = html.match(/<title>([^<]*)<\/title>/)?.[1];
  if (!bruto) return null;
  const titulo = decodificar(bruto).replace(/\s*(em promoção é no buscapé|\|\s*buscapé|- buscapé)\s*$/i, '').trim();
  return titulo || null;
}

/** Menor preço de cada dia guardado pelo próprio Buscapé (bloco priceHistory da página do produto). */
export function lerHistoricoDoBuscape(html: string, link: string): PontoDePreco[] {
  const dados = dadosNext(html) as {
    props?: { initialReduxState?: { priceHistory?: { priceHistory?: Record<string, { days?: unknown[] }> } } };
  } | null;
  const porProduto = dados?.props?.initialReduxState?.priceHistory?.priceHistory ?? {};
  const pontos: PontoDePreco[] = [];
  for (const { days } of Object.values(porProduto)) {
    for (const dia of (days ?? []) as Array<{ date?: string; price?: number }>) {
      if (!dia.date || !/^\d{4}-\d{2}-\d{2}$/.test(dia.date) || typeof dia.price !== 'number' || !(dia.price > 0)) continue;
      pontos.push({
        data: `${dia.date}T12:00:00Z`,
        precoCentavos: Math.round(dia.price * 100),
        precoDeCentavos: null,
        fonte: 'comparador',
        link,
      });
    }
  }
  return pontos.sort((a, b) => a.data.localeCompare(b.data));
}

/** Lê a página do produto no Buscapé: nome e histórico do menor preço de cada dia. */
export async function lerPaginaDoBuscape(
  produto: ProdutoLink,
  buscar: Buscar = fetch,
): Promise<{ titulo: string | null; pontos: PontoDePreco[] }> {
  try {
    const resposta = await buscar(produto.url, { headers: NAVEGADOR });
    if (!resposta.ok) return { titulo: null, pontos: [] };
    const html = await resposta.text();
    return { titulo: lerTituloDoBuscape(html), pontos: lerHistoricoDoBuscape(html, produto.url) };
  } catch {
    return { titulo: null, pontos: [] };
  }
}

/** Produtos achados pelo nome na busca do Buscapé (reserva quando a Amazon recusa a busca). */
export function lerBuscaDoBuscape(html: string, nome: string, maximo = 8): ProdutoEncontrado[] {
  const dados = dadosNext(html) as { props?: { initialReduxState?: { hits?: { hits?: unknown[] } } } } | null;
  const resultados = (dados?.props?.initialReduxState?.hits?.hits ?? []) as Array<{
    name?: string;
    url?: string;
    type?: string;
    price?: number;
    image?: unknown;
    storeCount?: number;
  }>;
  const lista: ProdutoEncontrado[] = [];
  const vistos = new Set<string>();
  resultados.forEach((r) => {
    if (r.type !== 'product' || !r.name || !r.url || !/^\/[a-z0-9-]+\/[a-z0-9-]+$/.test(r.url)) return;
    if (vistos.has(r.url) || notaDaBusca(nome, r.name) < 0.5 || ehAcessorioNaoPedido(nome, r.name)) return;
    vistos.add(r.url);
    lista.push({
      titulo: r.name,
      link: `https://www.buscape.com.br${r.url}`,
      precoCentavos: typeof r.price === 'number' && r.price > 0 ? Math.round(r.price * 100) : null,
      imagem: typeof r.image === 'string' && /^https:\/\//.test(r.image) ? r.image : null,
      fonte: 'buscape',
      ...(typeof r.storeCount === 'number' ? { lojas: r.storeCount } : {}),
    });
  });
  return lista
    .map((p, ordem) => ({ p, ordem, nota: notaDaBusca(nome, p.titulo) }))
    .sort((a, b) => b.nota - a.nota || a.ordem - b.ordem)
    .slice(0, maximo)
    .map((x) => x.p);
}

export async function buscarNoBuscapePorNome(nome: string, buscar: Buscar = fetch): Promise<ProdutoEncontrado[]> {
  const resposta = await buscar(`https://www.buscape.com.br/search?q=${encodeURIComponent(nome.trim())}`, { headers: NAVEGADOR });
  if (!resposta.ok) throw new Error(`o Buscapé respondeu ${resposta.status}`);
  return lerBuscaDoBuscape(await resposta.text(), nome);
}

/** Busca pelo nome: Amazon primeiro; se ela recusar (comum vindo de servidores), o Buscapé. */
export async function buscarPorNomeComReserva(
  nome: string,
  buscar: Buscar = fetch,
): Promise<{ produtos: ProdutoEncontrado[]; aviso: string | null }> {
  let motivo = '';
  try {
    const produtos = await buscarPorNome(nome, buscar);
    if (produtos.length) return { produtos, aviso: null };
  } catch (erro) {
    motivo = erro instanceof Error ? erro.message : String(erro);
  }
  const produtos = await buscarNoBuscapePorNome(nome, buscar);
  return { produtos, aviso: motivo ? `A busca na Amazon não respondeu (${motivo}); a lista vem do Buscapé.` : null };
}
