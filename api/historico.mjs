// robo/motor.ts
var ARQUIVO = { "User-Agent": "historico-de-precos/1.0 (+https://github.com/matheusmerlim1/historico-de-precos)" };
var BloqueadoPeloArquivo = class extends Error {
  constructor() {
    super("O Internet Archive pediu para esperar (muitos pedidos seguidos).");
  }
};
var NAVEGADOR = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8"
};
function identificarLink(texto) {
  let url;
  try {
    url = new URL(texto.trim());
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (/(^|\.)amazon\.com\.br$/.test(host)) {
    const m = url.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:[/?]|$)/i);
    if (!m) return null;
    const id = m[1].toUpperCase();
    return { loja: "amazon", id, url: `https://www.amazon.com.br/dp/${id}` };
  }
  if (/(^|\.)mercadoli(vre|bre)\.com\.br$/.test(host)) {
    const m = (url.pathname + url.search).match(/MLB-?(\d{6,})/i);
    if (!m) return null;
    const limpa = `${url.origin}${url.pathname}`;
    return { loja: "mercadolivre", id: `MLB${m[1]}`, url: limpa };
  }
  return null;
}
function ehLinkCurto(texto) {
  try {
    const host = new URL(texto.trim()).hostname.toLowerCase();
    return /^(amzn\.to|a\.co|mercadolivre\.com|meli\.la|bit\.ly|tinyurl\.com)$/.test(host.replace(/^www\./, ""));
  } catch {
    return false;
  }
}
async function resolverLink(texto, buscar = fetch) {
  const direto = identificarLink(texto);
  if (direto) return direto;
  try {
    const resposta = await buscar(texto.trim(), { redirect: "follow", headers: NAVEGADOR });
    return identificarLink(resposta.url);
  } catch {
    return null;
  }
}
function precoBrParaCentavos(texto) {
  if (!texto) return null;
  const m = texto.replace(/\s/g, "").match(/(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?/);
  if (!m) return null;
  const reais2 = Number.parseInt(m[1].replace(/\./g, ""), 10);
  const centavos = m[2] ? Number.parseInt(m[2].padEnd(2, "0"), 10) : 0;
  const total = reais2 * 100 + centavos;
  return Number.isFinite(total) && total > 0 ? total : null;
}
function decodificar(texto) {
  return texto.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/\s+/g, " ").trim();
}
function trechoDepois(html, marcador, tamanho) {
  const i = html.indexOf(marcador);
  return i < 0 ? null : html.slice(i, i + tamanho);
}
function precoDoSpan(trecho) {
  const visivel = trecho.match(/class="a-offscreen">\s*(R\$\s?[\d.,]+)/);
  if (visivel) return precoBrParaCentavos(visivel[1]);
  const partes = trecho.match(/a-price-whole">([\d.]+)[\s\S]{0,120}?a-price-fraction">(\d{2})/);
  if (partes) return precoBrParaCentavos(`${partes[1]},${partes[2]}`);
  return null;
}
function precoNoTrecho(bruto) {
  if (!bruto) return null;
  const trecho = bruto.replace(/<span class="a-price a-text-price[\s\S]*?<\/span>\s*<\/span>/g, "");
  const aPagar = trecho.indexOf("priceToPay");
  if (aPagar >= 0) {
    const preco = precoDoSpan(trecho.slice(aPagar, aPagar + 900));
    if (preco) return preco;
  }
  const leitor = trecho.match(/class="aok-offscreen">\s*(R\$\s?[\d.,]+)/);
  if (leitor) return precoBrParaCentavos(leitor[1]);
  return precoDoSpan(trecho);
}
function lerAmazon(html) {
  const blocos = [
    'id="corePriceDisplay_desktop_feature_div"',
    'id="corePrice_feature_div"',
    'id="corePrice_desktop"',
    'id="priceblock_dealprice"',
    'id="priceblock_ourprice"',
    'id="price_inside_buybox"'
  ];
  let preco = null;
  for (const bloco of blocos) {
    preco = precoNoTrecho(trechoDepois(html, bloco, 4e3));
    if (preco) break;
  }
  let precoDe = null;
  const base = trechoDepois(html, "basisPrice", 1500) ?? trechoDepois(html, "a-text-price", 600);
  if (base) {
    const m = base.match(/class="a-offscreen">\s*(R\$\s?[\d.,]+)/);
    precoDe = m ? precoBrParaCentavos(m[1]) : null;
  }
  if (precoDe != null && preco != null && precoDe <= preco) precoDe = null;
  const titulo = html.match(/id="productTitle"[^>]*>([^<]+)/)?.[1] ?? html.match(/<title>([^<|]+)/)?.[1]?.replace(/\s*[:|-]\s*Amazon\.com\.br.*$/i, "") ?? null;
  return { precoCentavos: preco, precoDeCentavos: precoDe, titulo: titulo ? decodificar(titulo) : null };
}
function lerMercadoLivre(html) {
  let preco = null;
  const ld = html.match(/"offers"\s*:\s*\{[^}]*?"price"\s*:\s*"?([\d.]+)/) ?? html.match(/"price"\s*:\s*"?(\d+(?:\.\d+)?)"?\s*,\s*"priceCurrency"/);
  if (ld) preco = Math.round(Number.parseFloat(ld[1]) * 100);
  if (!preco) {
    const meta = html.match(/itemprop="price"\s+content="([\d.]+)"/);
    if (meta) preco = Math.round(Number.parseFloat(meta[1]) * 100);
  }
  if (!preco) {
    const og = html.match(/property="og:title"\s+content="[^"]*R\$\s?([\d.,]+)"/);
    if (og) preco = precoBrParaCentavos(og[1]);
  }
  let precoDe = null;
  const anterior = trechoDepois(html, "andes-money-amount--previous", 600);
  if (anterior) {
    const inteiro = anterior.match(/andes-money-amount__fraction"[^>]*>([\d.]+)/)?.[1];
    const fracao = anterior.match(/andes-money-amount__cents[^"]*"[^>]*>(\d{2})/)?.[1];
    if (inteiro) precoDe = precoBrParaCentavos(`${inteiro},${fracao ?? "00"}`);
  }
  if (precoDe != null && preco != null && precoDe <= preco) precoDe = null;
  const tituloBruto = html.match(/<h1[^>]*class="[^"]*ui-pdp-title[^"]*"[^>]*>([^<]+)/)?.[1] ?? html.match(/property="og:title"\s+content="([^"]+)"/)?.[1]?.replace(/\s*-\s*R\$.*$/, "") ?? null;
  const titulo = tituloBruto && tituloBruto.trim() ? decodificar(tituloBruto) : null;
  return { precoCentavos: preco && preco > 0 ? preco : null, precoDeCentavos: precoDe, titulo };
}
function lerPrecoDoHtml(loja, html) {
  return loja === "amazon" ? lerAmazon(html) : lerMercadoLivre(html);
}
function padroesDeBusca(produto) {
  if (produto.loja === "amazon") return [`amazon.com.br/dp/${produto.id}`, `amazon.com.br/gp/product/${produto.id}`];
  const numero = produto.id.replace(/^MLB/, "");
  const padroes = [
    `produto.mercadolivre.com.br/MLB-${numero}`,
    `www.mercadolivre.com.br/p/MLB${numero}`,
    `mercadolivre.com.br/up/MLBU${numero}`
  ];
  const informado = produto.url.replace(/^https?:\/\//, "");
  if (!padroes.some((p) => informado.startsWith(p))) padroes.push(informado);
  return padroes;
}
function timestampParaIso(ts) {
  return `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(8, 10) || "00"}:${ts.slice(10, 12) || "00"}:${ts.slice(12, 14) || "00"}Z`;
}
function espalharNoTempo(itens, maximo) {
  if (itens.length <= maximo) return itens;
  if (maximo <= 1) return itens.slice(-1);
  const escolhidos = [];
  const passo = (itens.length - 1) / (maximo - 1);
  for (let i = 0; i < maximo; i++) escolhidos.push(itens[Math.round(i * passo)]);
  return escolhidos;
}
var TAMANHO_MINIMO_DA_COPIA = 4e4;
async function listarCopiasArquivadas(produto, buscar = fetch) {
  return listarCopiasDosEnderecos(padroesDeBusca(produto), buscar);
}
async function listarCopiasDosEnderecos(padroes, buscar = fetch) {
  const porDia = /* @__PURE__ */ new Map();
  for (const padrao of padroes) {
    const url = `https://web.archive.org/cdx/search/cdx?output=json&fl=timestamp,original,statuscode,length&matchType=prefix&filter=statuscode:200&collapse=timestamp:10&url=${encodeURIComponent(padrao)}`;
    let linhas = [];
    try {
      const resposta = await buscar(url, { headers: ARQUIVO });
      if (resposta.status === 429) throw new BloqueadoPeloArquivo();
      if (!resposta.ok) continue;
      const texto = await resposta.text();
      linhas = texto.trim() ? JSON.parse(texto) : [];
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
      if (!atual || Number.isFinite(tamanho) && tamanho > atual.tamanho) {
        porDia.set(dia, { timestamp, original, tamanho: Number.isFinite(tamanho) ? tamanho : 0 });
      }
    }
  }
  return [...porDia.values()].map(({ timestamp, original }) => ({ timestamp, original })).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}
async function lerCopiaArquivada(produto, copia, buscar = fetch) {
  const endereco = `https://web.archive.org/web/${copia.timestamp}id_/${copia.original}`;
  try {
    const resposta = await buscar(endereco, { headers: ARQUIVO });
    if (resposta.status === 429) throw new BloqueadoPeloArquivo();
    if (!resposta.ok) return { ponto: null, titulo: null };
    const entregue = resposta.url.match(/\/web\/(\d{14})id_\//)?.[1] ?? copia.timestamp;
    const leitura = lerPrecoDoHtml(produto.loja, await resposta.text());
    if (!leitura.precoCentavos) return { ponto: null, titulo: leitura.titulo };
    return {
      titulo: leitura.titulo,
      ponto: {
        data: timestampParaIso(entregue),
        precoCentavos: leitura.precoCentavos,
        precoDeCentavos: leitura.precoDeCentavos,
        fonte: "arquivo",
        link: `https://web.archive.org/web/${entregue}/${copia.original}`
      }
    };
  } catch (erro) {
    if (erro instanceof BloqueadoPeloArquivo) throw erro;
    return { ponto: null, titulo: null };
  }
}
var esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));
async function buscarHistoricoArquivado(produto, opcoes = {}) {
  const buscar = opcoes.buscar ?? fetch;
  const pausa = opcoes.pausaMs ?? 1500;
  let todas;
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
  const pontos = [];
  const lidas = [];
  let titulo = null;
  let tituloDe = "";
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
async function lerPrecoAtual(produto, buscar = fetch) {
  try {
    const resposta = await buscar(produto.url, { headers: { ...NAVEGADOR, Accept: "text/html" }, redirect: "follow" });
    if (!resposta.ok) return { ponto: null, titulo: null };
    const leitura = lerPrecoDoHtml(produto.loja, await resposta.text());
    if (!leitura.precoCentavos) return { ponto: null, titulo: leitura.titulo };
    return {
      titulo: leitura.titulo,
      ponto: {
        data: (/* @__PURE__ */ new Date()).toISOString(),
        precoCentavos: leitura.precoCentavos,
        precoDeCentavos: leitura.precoDeCentavos,
        fonte: "loja",
        link: produto.url
      }
    };
  } catch {
    return { ponto: null, titulo: null };
  }
}
function juntarPontos(...listas) {
  const unicos = /* @__PURE__ */ new Map();
  for (const ponto of listas.flat()) {
    const chave = `${ponto.loja ?? ""}|${ponto.fonte}|${ponto.data.slice(0, 10)}|${ponto.precoCentavos}`;
    if (!unicos.has(chave)) unicos.set(chave, ponto);
  }
  return [...unicos.values()].sort((a, b) => a.data.localeCompare(b.data));
}
function reais(centavos) {
  return `R$ ${(centavos / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function resumir(pontos) {
  if (pontos.length === 0) {
    return {
      quantidade: 0,
      menor: null,
      maior: null,
      mediaCentavos: null,
      atual: null,
      primeiraData: null,
      veredito: "Ainda n\xE3o h\xE1 pre\xE7os registrados para este produto."
    };
  }
  const ordenados = [...pontos].sort((a, b) => a.data.localeCompare(b.data));
  const atual = ordenados.at(-1);
  const menor = ordenados.reduce((m, p) => p.precoCentavos < m.precoCentavos ? p : m);
  const maior = ordenados.reduce((m, p) => p.precoCentavos > m.precoCentavos ? p : m);
  const media = Math.round(ordenados.reduce((s, p) => s + p.precoCentavos, 0) / ordenados.length);
  let veredito;
  if (ordenados.length < 3) {
    veredito = "Poucos registros ainda: d\xE1 para ver o pre\xE7o, mas n\xE3o para dizer se est\xE1 bom.";
  } else if (atual.precoCentavos <= menor.precoCentavos) {
    veredito = `O \xFAltimo pre\xE7o (${reais(atual.precoCentavos)}) \xE9 o menor de todo o hist\xF3rico.`;
  } else {
    const acimaDoMenor = (atual.precoCentavos - menor.precoCentavos) / menor.precoCentavos;
    const contraMedia = (atual.precoCentavos - media) / media;
    const pct = (x) => `${Math.round(Math.abs(x) * 100)}%`;
    if (contraMedia <= -0.05) {
      veredito = `O \xFAltimo pre\xE7o est\xE1 ${pct(contraMedia)} abaixo da m\xE9dia e ${pct(acimaDoMenor)} acima do menor j\xE1 visto (${reais(menor.precoCentavos)}).`;
    } else if (contraMedia >= 0.05) {
      veredito = `O \xFAltimo pre\xE7o est\xE1 ${pct(contraMedia)} acima da m\xE9dia; o menor j\xE1 visto foi ${reais(menor.precoCentavos)}.`;
    } else {
      veredito = `O \xFAltimo pre\xE7o est\xE1 perto da m\xE9dia; o menor j\xE1 visto foi ${reais(menor.precoCentavos)}.`;
    }
  }
  return {
    quantidade: ordenados.length,
    menor,
    maior,
    mediaCentavos: media,
    atual,
    primeiraData: ordenados[0].data,
    veredito
  };
}
var PALAVRAS_VAZIAS = /* @__PURE__ */ new Set([
  "para",
  "com",
  "sem",
  "de",
  "da",
  "do",
  "das",
  "dos",
  "e",
  "em",
  "cor",
  "preto",
  "preta",
  "branco",
  "branca",
  "novo",
  "nova",
  "original",
  "modelo",
  "tela",
  "smartphone",
  "celular",
  "kit",
  "unidade",
  "unidades"
]);
var VARIANTES = /* @__PURE__ */ new Set(["fe", "plus", "ultra", "edge", "pro", "max", "mini", "lite", "slim", "neo", "prime"]);
var USADO = /\b(usado|recondicionado|vitrine|seminovo)\b/;
var UNIDADE = /^\d+(gb|tb|mb|mp|mah|hz|w|g|k|pol)$/;
function normalizarTexto(texto) {
  return texto.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/(\d+)\s+(gb|tb|mb|mp|mah|hz|w)\b/g, "$1$2").replace(/[^a-z0-9]+/g, " ").trim();
}
function palavrasDoTitulo(titulo, maximo = 8) {
  const unicas = [];
  for (const palavra of normalizarTexto(titulo).split(" ")) {
    const util = /\d/.test(palavra) ? palavra.length >= 2 : palavra.length >= 3 || VARIANTES.has(palavra);
    if (util && !PALAVRAS_VAZIAS.has(palavra) && !unicas.includes(palavra)) unicas.push(palavra);
    if (unicas.length >= maximo) break;
  }
  return unicas;
}
function semelhancaDeProduto(tituloA, tituloB) {
  const textoA = normalizarTexto(tituloA);
  const textoB = normalizarTexto(tituloB);
  const a = new Set(textoA.split(" ").filter(Boolean));
  const b = new Set(textoB.split(" ").filter(Boolean));
  const variantes = (x) => [...x].filter((p) => VARIANTES.has(p)).sort().join(",");
  if (variantes(a) !== variantes(b)) return 0;
  const capacidades = (x) => [...x].filter((p) => /^\d+(gb|tb)$/.test(p));
  const capA = capacidades(a);
  const capB = capacidades(b);
  if (capA.length && capB.length && !capA.some((c) => capB.includes(c))) return 0;
  if (USADO.test(textoA) !== USADO.test(textoB)) return 0;
  const aMaisCurto = tituloA.length <= tituloB.length;
  const curto = aMaisCurto ? a : b;
  const outro = aMaisCurto ? b : a;
  for (const p of curto) {
    const ehModelo = /[a-z]/.test(p) && /\d/.test(p) && !UNIDADE.test(p);
    const ehNumero = /^\d{1,3}$/.test(p);
    if ((ehModelo || ehNumero) && !outro.has(p)) return 0;
  }
  const curtas = palavrasDoTitulo(aMaisCurto ? tituloA : tituloB, 8);
  if (curtas.length === 0) return 0;
  return curtas.filter((p) => outro.has(p)).length / curtas.length;
}
function consultaDeBusca(titulo) {
  const nome = titulo.split(/,| - | \| /)[0] ?? titulo;
  const palavras = palavrasDoTitulo(nome, 5);
  const capacidades = normalizarTexto(titulo).split(" ").filter((p) => /^\d+(gb|tb)$/.test(p));
  for (const c of capacidades) {
    if (palavras.length >= 7) break;
    if (!palavras.includes(c)) palavras.push(c);
  }
  return palavras.join(" ");
}
function dadosNext(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}
function escolherNaBuscaDoBuscape(html, titulo) {
  const dados = dadosNext(html);
  const resultados = dados?.props?.initialReduxState?.hits?.hits ?? [];
  let melhor = null;
  let nota = 0;
  for (const r of resultados) {
    if (!r.name || !r.url || r.type !== "product" || !/^\/[a-z0-9-]+\/[a-z0-9-]+$/.test(r.url)) continue;
    const n = semelhancaDeProduto(titulo, r.name);
    if (n > nota) {
      nota = n;
      melhor = { nome: r.name, url: `https://www.buscape.com.br${r.url}` };
    }
  }
  return nota >= 0.75 ? melhor : null;
}
function lerOfertasDoBuscape(html) {
  const dados = dadosNext(html);
  const ofertas = dados?.props?.initialReduxState?.offers;
  const lista = [...ofertas?.displayOffers ?? [], ...ofertas?.offerList ?? []];
  const porLoja = /* @__PURE__ */ new Map();
  for (const o of lista) {
    const vendedor = (o.sellerName ?? o.merchantName ?? "").trim();
    const valor = typeof o.price === "number" && o.price > 0 ? o.price : o.totalPrice;
    if (!vendedor || typeof valor !== "number" || !(valor > 0)) continue;
    const centavos = Math.round(valor * 100);
    const atual = porLoja.get(vendedor);
    if (atual == null || centavos < atual) porLoja.set(vendedor, centavos);
  }
  return [...porLoja].map(([vendedor, precoCentavos]) => ({ vendedor, precoCentavos }));
}
var NOME_DA_LOJA = {
  amazon: /^amazon(\.com\.br)?$/i,
  mercadolivre: /^mercado\s*livre$/i
};
function pontosDasOfertas(produto, ofertas, data, fonte, link) {
  return ofertas.map((o) => ({
    data,
    precoCentavos: o.precoCentavos,
    precoDeCentavos: null,
    fonte,
    link,
    ...NOME_DA_LOJA[produto.loja].test(o.vendedor) ? {} : { loja: o.vendedor }
  }));
}
async function buscarOutrasLojas(produto, titulo, opcoes = {}) {
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
  const pontos = [];
  try {
    const resp = await buscar(pagina.url, { headers: NAVEGADOR });
    if (resp.ok) {
      const ofertas = lerOfertasDoBuscape(await resp.text());
      pontos.push(...pontosDasOfertas(produto, ofertas, (/* @__PURE__ */ new Date()).toISOString(), "loja", pagina.url));
    }
  } catch {
  }
  const lidas = [];
  let bloqueado = false;
  let copias = [];
  try {
    copias = await listarCopiasDosEnderecos([pagina.url.replace(/^https?:\/\//, "")], buscar);
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
        pontos.push(...pontosDasOfertas(produto, ofertas, timestampParaIso(entregue), "arquivo", link));
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

// robo/montar.ts
function principais(pontos) {
  return pontos.filter((p) => !p.loja);
}
async function montarHistorico(produto, antes, opcoes) {
  const avisar = opcoes.aoAvancar ?? (() => {
  });
  const avisos = [];
  const agora = (/* @__PURE__ */ new Date()).toISOString();
  avisar("Lendo o pre\xE7o de hoje na loja...");
  const hoje = await lerPrecoAtual(produto);
  if (!hoje.ponto) avisos.push("A loja n\xE3o mostrou o pre\xE7o de hoje (\xE0s vezes ela pede captcha).");
  avisar("Procurando c\xF3pias antigas da p\xE1gina no Internet Archive...");
  const arquivo = await buscarHistoricoArquivado(produto, {
    jaLidas: new Set(antes?.copiasLidas ?? []),
    maximoDeCopias: opcoes.copias,
    ...opcoes.pausaMs != null ? { pausaMs: opcoes.pausaMs } : {},
    aoAvancar: (lidas, total) => avisar(`Lendo c\xF3pias antigas da p\xE1gina: ${lidas} de ${total}...`)
  });
  if (arquivo.bloqueado) avisos.push("O Internet Archive pediu uma pausa; o resto das c\xF3pias antigas fica para depois.");
  if (arquivo.totalDeCopias === 0 && !arquivo.bloqueado && !antes?.copiasLidas?.length) {
    avisos.push("O Internet Archive n\xE3o tem c\xF3pias desta p\xE1gina; o hist\xF3rico desta loja cresce com a confer\xEAncia di\xE1ria.");
  }
  const titulo = hoje.titulo ?? antes?.titulo ?? arquivo.titulo ?? null;
  let comparador = antes?.comparador ?? null;
  let outras = [];
  let lidasComparador = [];
  if (titulo && opcoes.copiasComparador >= 0) {
    avisar("Procurando o mesmo produto em outras lojas...");
    const r = await buscarOutrasLojas(produto, titulo, {
      pagina: comparador,
      jaLidas: new Set(antes?.copiasComparadorLidas ?? []),
      maximoDeCopias: opcoes.copiasComparador,
      ...opcoes.pausaMs != null ? { pausaMs: opcoes.pausaMs } : {},
      aoAvancar: (lidas, total) => avisar(`Lendo pre\xE7os antigos das outras lojas: ${lidas} de ${total}...`)
    });
    comparador = r.pagina;
    outras = r.pontos;
    lidasComparador = r.lidas;
    if (!r.pagina) avisos.push("N\xE3o achei este mesmo produto (mesmo modelo e capacidade) em outras lojas.");
  }
  const pontos = juntarPontos(antes?.pontos ?? [], arquivo.pontos, hoje.ponto ? [hoje.ponto] : [], outras);
  const dados = {
    produto,
    titulo,
    criadoEm: antes?.criadoEm ?? agora,
    atualizadoEm: agora,
    copiasLidas: [.../* @__PURE__ */ new Set([...antes?.copiasLidas ?? [], ...arquivo.lidas])].sort(),
    copiasRestantes: arquivo.faltam,
    comparador,
    copiasComparadorLidas: [.../* @__PURE__ */ new Set([...antes?.copiasComparadorLidas ?? [], ...lidasComparador])].sort(),
    pontos,
    // O resumo (menor, maior, média, veredito) é da loja do link; as outras lojas têm a tabela própria.
    resumo: resumir(principais(pontos))
  };
  return { dados, avisos };
}

// servidor/api.ts
var PAGINA = "https://matheusmerlim1.github.io/historico-de-precos";
var ORIGENS = [/^https:\/\/matheusmerlim1\.github\.io$/, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];
var GUARDA_MS = 6 * 3600 * 1e3;
var recentes = /* @__PURE__ */ new Map();
function cabecalhosCors(req) {
  const origem = req.headers.get("Origin") ?? "";
  return ORIGENS.some((r) => r.test(origem)) ? { "Access-Control-Allow-Origin": origem, Vary: "Origin" } : {};
}
async function salvoPeloRobo(chave) {
  try {
    const resp = await fetch(`${PAGINA}/dados/produtos/${chave}.json?t=${Date.now()}`);
    return resp.ok ? await resp.json() : null;
  } catch {
    return null;
  }
}
async function GET(req) {
  const cors = cabecalhosCors(req);
  const link = new URL(req.url).searchParams.get("link")?.trim() ?? "";
  if (!/^https?:\/\/\S{4,1990}$/.test(link)) {
    return Response.json({ erro: "Cole o link de um produto." }, { status: 400, headers: cors });
  }
  const codificador = new TextEncoder();
  const fluxo = new TransformStream();
  const escritor = fluxo.writable.getWriter();
  const enviar = (obj) => escritor.write(codificador.encode(JSON.stringify(obj) + "\n"));
  (async () => {
    try {
      await enviar({ etapa: "Identificando o produto pelo link..." });
      const produto = identificarLink(link) ?? (ehLinkCurto(link) ? await resolverLink(link) : null);
      if (!produto) {
        await enviar({ erro: "N\xE3o reconheci o link. Use o link de um produto da amazon.com.br ou do mercadolivre.com.br." });
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
        pausaMs: 1e3,
        aoAvancar: (etapa) => void enviar({ etapa })
      });
      const resultado = { ...dados, avisos, chave };
      recentes.set(chave, { quando: Date.now(), resultado });
      if (recentes.size > 200) recentes.delete(recentes.keys().next().value);
      await enviar({ resultado });
    } catch (erro) {
      await enviar({ erro: `Falha ao montar o hist\xF3rico: ${erro instanceof Error ? erro.message : String(erro)}` });
    } finally {
      await escritor.close();
    }
  })();
  return new Response(fluxo.readable, {
    headers: {
      ...cors,
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}
export {
  GET
};
