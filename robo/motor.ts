// Motor do histórico de preço: identifica o produto pelo link, lista as cópias da página
// guardadas no Internet Archive (Wayback Machine), lê o preço de cada cópia e resume a série.
// Não depende de nenhuma biblioteca: roda no app local (tsx) e no robô do repositório público
// (node --experimental-strip-types). O repositório historico-de-precos tem uma cópia deste arquivo.

export type Loja = 'amazon' | 'mercadolivre';

export interface ProdutoLink {
  loja: Loja;
  id: string;
  url: string;
}

export type Fonte = 'arquivo' | 'loja' | 'telegram';

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
  for (const padrao of padroes) {
    const url =
      'https://web.archive.org/cdx/search/cdx?output=json&fl=timestamp,original,statuscode,length' +
      `&matchType=prefix&filter=statuscode:200&collapse=timestamp:10&url=${encodeURIComponent(padrao)}`;
    let linhas: string[][] = [];
    try {
      const resposta = await buscar(url, { headers: ARQUIVO });
      if (resposta.status === 429) throw new BloqueadoPeloArquivo();
      if (!resposta.ok) continue;
      const texto = await resposta.text();
      linhas = texto.trim() ? (JSON.parse(texto) as string[][]) : [];
    } catch (erro) {
      if (erro instanceof BloqueadoPeloArquivo) throw erro;
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
}

export interface HistoricoArquivado {
  pontos: PontoDePreco[];
  titulo: string | null;
  lidas: string[];
  totalDeCopias: number;
  faltam: number;
  bloqueado: boolean;
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
      return { pontos: [], titulo: null, lidas: [], totalDeCopias: 0, faltam: 0, bloqueado: true };
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
  return { pontos, titulo, lidas, totalDeCopias: todas.length, faltam: novas.length - lidas.length, bloqueado };
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
  for (const p of curto) {
    const ehModelo = /[a-z]/.test(p) && /\d/.test(p) && !UNIDADE.test(p);
    const ehNumero = /^\d{1,3}$/.test(p);
    if ((ehModelo || ehNumero) && !outro.has(p)) return 0;
  }
  const curtas = palavrasDoTitulo(aMaisCurto ? tituloA : tituloB, 8);
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
  if (!pagina) {
    const consulta = consultaDeBusca(titulo);
    try {
      const resp = await buscar(`https://www.buscape.com.br/search?q=${encodeURIComponent(consulta)}`, { headers: NAVEGADOR });
      if (resp.ok) pagina = escolherNaBuscaDoBuscape(await resp.text(), titulo);
    } catch {
      pagina = null;
    }
  }
  if (!pagina) return { pagina: null, pontos: [], lidas: [], bloqueado: false };

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
    if (!(erro instanceof BloqueadoPeloArquivo)) throw erro;
    bloqueado = true;
  }
  const novas = copias.filter((c) => !opcoes.jaLidas?.has(c.timestamp));
  const escolhidas = espalharNoTempo(novas, opcoes.maximoDeCopias ?? 8);
  for (const copia of escolhidas) {
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
