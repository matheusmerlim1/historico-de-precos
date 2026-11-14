// Página pública: lê os históricos que o robô grava em dados/ e pede produtos novos por issue.
(function () {
  const { desenhar, reais, dataCurta, esc } = window.HistoricoTela;
  const REPO = 'https://github.com/matheusmerlim1/historico-de-precos';
  const form = document.getElementById('form-busca');
  const campo = document.getElementById('link');
  const status = document.getElementById('status');
  const resultado = document.getElementById('resultado');
  const pedido = document.getElementById('pedido');
  const linkPedido = document.getElementById('link-pedido');
  const aguardando = document.getElementById('aguardando');
  let espera = null;

  // Mesma regra de src/historico/motor.ts (identificarLink).
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
      return m ? { loja: 'amazon', id: m[1].toUpperCase() } : null;
    }
    if (/(^|\.)mercadoli(vre|bre)\.com\.br$/.test(host)) {
      const m = (url.pathname + url.search).match(/MLB-?(\d{6,})/i);
      return m ? { loja: 'mercadolivre', id: 'MLB' + m[1] } : null;
    }
    return null;
  }

  function ehLinkCurto(texto) {
    try {
      const host = new URL(texto.trim()).hostname.toLowerCase().replace(/^www\./, '');
      return /^(amzn\.to|a\.co|mercadolivre\.com|meli\.la|bit\.ly|tinyurl\.com)$/.test(host);
    } catch {
      return false;
    }
  }

  async function lerDados(chave) {
    const resp = await fetch(`dados/produtos/${encodeURIComponent(chave)}.json?t=${Date.now()}`, { cache: 'no-store' });
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`erro ${resp.status} ao ler os dados`);
    return resp.json();
  }

  function pararEspera() {
    if (espera) clearInterval(espera);
    espera = null;
    aguardando.hidden = true;
  }

  function enderecoDoPedido(link, chave) {
    const titulo = `Histórico: ${chave || link}`.slice(0, 120);
    const corpo = `${link}\n\n(Pedido feito pela página. O robô responde aqui com o resumo e fecha o pedido.)`;
    return `${REPO}/issues/new?title=${encodeURIComponent(titulo)}&body=${encodeURIComponent(corpo)}`;
  }

  function mostrarPedido(link, chave) {
    pedido.hidden = false;
    linkPedido.href = enderecoDoPedido(link, chave);
    linkPedido.onclick = () => {
      if (!chave) {
        status.textContent = 'Depois que o robô terminar, a resposta no GitHub traz o link do gráfico.';
        return;
      }
      pararEspera();
      aguardando.hidden = false;
      const inicio = Date.now();
      espera = setInterval(async () => {
        if (Date.now() - inicio > 15 * 60 * 1000) {
          pararEspera();
          status.textContent = 'O robô está demorando. Veja a resposta no pedido aberto no GitHub.';
          return;
        }
        try {
          const dados = await lerDados(chave);
          if (dados) {
            pararEspera();
            pedido.hidden = true;
            status.textContent = '';
            desenhar(resultado, dados);
            carregarLista();
          }
        } catch {
          // tenta de novo na próxima volta
        }
      }, 30000);
    };
  }

  async function consultar(link, chaveDireta) {
    pararEspera();
    pedido.hidden = true;
    resultado.innerHTML = '';
    status.textContent = '';

    let chave = chaveDireta;
    if (!chave) {
      if (!link) {
        status.textContent = 'Cole o link do produto.';
        campo.focus();
        return;
      }
      const produto = identificarLink(link);
      if (!produto) {
        if (ehLinkCurto(link)) {
          status.textContent =
            'Este é um link encurtado. Abra-o, copie o endereço completo da página do produto e cole aqui — ou peça ao robô, que abre o link sozinho.';
          mostrarPedido(link, null);
        } else {
          status.textContent = 'Não reconheci o link. Use o link de um produto da amazon.com.br ou do mercadolivre.com.br.';
        }
        campo.focus();
        return;
      }
      chave = `${produto.loja}_${produto.id}`;
    }

    status.textContent = 'Carregando…';
    try {
      const dados = await lerDados(chave);
      if (!dados) {
        status.textContent = '';
        mostrarPedido(link || chave, chave);
        return;
      }
      status.textContent = '';
      desenhar(resultado, dados);
      const novaUrl = `${location.pathname}?produto=${encodeURIComponent(chave)}`;
      history.replaceState(null, '', novaUrl);
    } catch (err) {
      status.textContent = `Não foi possível carregar: ${err.message}`;
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    consultar(campo.value.trim());
  });

  async function carregarLista() {
    const lista = document.getElementById('lista');
    try {
      const resp = await fetch(`dados/indice.json?t=${Date.now()}`, { cache: 'no-store' });
      const { produtos } = await resp.json();
      if (!produtos.length) {
        lista.textContent = 'Nenhum produto ainda. Consulte um link acima para pedir o primeiro.';
        return;
      }
      lista.innerHTML = `<ul class="lista">${produtos
        .map((p) => {
          const chave = `${p.loja}_${p.id}`;
          return `<li><a href="?produto=${esc(encodeURIComponent(chave))}" data-chave="${esc(chave)}">
            <span class="nome">${esc(p.titulo || p.id)}</span>
            <span class="detalhe">${p.quantidade} preços · último ${esc(reais(p.ultimoPrecoCentavos))} · menor ${esc(reais(p.menorPrecoCentavos))} · conferido em ${esc(dataCurta(p.atualizadoEm))}</span>
          </a></li>`;
        })
        .join('')}</ul>`;
      lista.querySelectorAll('a[data-chave]').forEach((a) =>
        a.addEventListener('click', (e) => {
          e.preventDefault();
          consultar('', a.dataset.chave);
          document.getElementById('titulo-busca').scrollIntoView({ behavior: 'smooth' });
        }),
      );
    } catch {
      lista.textContent = 'Não foi possível carregar a lista agora.';
    }
  }

  carregarLista();
  const inicial = new URLSearchParams(location.search).get('produto');
  if (inicial && /^(amazon|mercadolivre)_[A-Z0-9]+$/.test(inicial)) consultar('', inicial);
})();
