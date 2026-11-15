// Página pública: manda o link ao servidor, que monta o histórico na hora (sem pedido nem login).
// Se o servidor não responder, mostra o histórico que o robô diário já salvou em dados/.
(function () {
  const { desenhar, reais, dataCurta, esc } = window.HistoricoTela;
  const SERVIDOR = (window.HISTORICO_SERVIDOR || '').replace(/\/$/, '');
  const form = document.getElementById('form-busca');
  const campo = document.getElementById('link');
  const botao = form.querySelector('button[type="submit"]');
  const status = document.getElementById('status');
  const resultado = document.getElementById('resultado');
  let consultaAtual = 0;

  // Mesma regra de robo/motor.ts (identificarLink), para achar o histórico salvo sem o servidor.
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

  async function lerSalvo(chave) {
    const resp = await fetch(`dados/produtos/${encodeURIComponent(chave)}.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!resp.ok) return null;
    return resp.json();
  }

  /** Lê a resposta do servidor linha a linha, mostrando cada etapa, e devolve o resultado. */
  async function perguntarAoServidor(link, minhaConsulta) {
    const resp = await fetch(`${SERVIDOR}/api/historico?link=${encodeURIComponent(link)}`);
    if (!resp.ok || !resp.body) {
      const corpo = await resp.json().catch(() => ({}));
      throw new Error(corpo.erro || `o servidor respondeu ${resp.status}`);
    }
    const leitor = resp.body.getReader();
    const decodificador = new TextDecoder();
    let resto = '';
    for (;;) {
      const { value, done } = await leitor.read();
      if (done) break;
      resto += decodificador.decode(value, { stream: true });
      const linhas = resto.split('\n');
      resto = linhas.pop();
      for (const linha of linhas) {
        if (!linha.trim()) continue;
        const msg = JSON.parse(linha);
        if (msg.erro) throw new Error(msg.erro);
        if (msg.resultado) return msg.resultado;
        if (msg.etapa && minhaConsulta === consultaAtual) status.textContent = msg.etapa;
      }
    }
    throw new Error('a resposta do servidor veio incompleta');
  }

  async function consultar(link, chaveSalva) {
    const minhaConsulta = ++consultaAtual;
    resultado.innerHTML = '';
    if (!link && !chaveSalva) {
      status.textContent = 'Cole o link do produto.';
      campo.focus();
      return;
    }
    botao.disabled = true;
    status.textContent = 'Consultando…';
    const produto = link ? identificarLink(link) : null;
    const chave = chaveSalva || (produto ? `${produto.loja}_${produto.id}` : null);

    try {
      let dados = null;
      let aviso = '';
      if (SERVIDOR && link) {
        try {
          dados = await perguntarAoServidor(link, minhaConsulta);
        } catch (erro) {
          if (/Não reconheci/.test(erro.message)) throw erro;
          aviso = `O servidor não respondeu agora (${erro.message}).`;
        }
      }
      if (!dados && chave) {
        dados = await lerSalvo(chave);
        if (dados && aviso) dados.avisos = [`${aviso} Mostrando o histórico salvo até ${dataCurta(dados.atualizadoEm)}.`];
      }
      if (minhaConsulta !== consultaAtual) return;
      if (!dados) {
        status.textContent = aviso
          ? `${aviso} Tente de novo em alguns minutos.`
          : 'Não reconheci o link. Use o link de um produto da amazon.com.br ou do mercadolivre.com.br.';
        return;
      }
      status.textContent = '';
      desenhar(resultado, dados);
      const chaveFinal = dados.chave || chave || `${dados.produto.loja}_${dados.produto.id}`;
      history.replaceState(null, '', `${location.pathname}?produto=${encodeURIComponent(chaveFinal)}`);
    } catch (erro) {
      if (minhaConsulta === consultaAtual) status.textContent = erro.message;
    } finally {
      if (minhaConsulta === consultaAtual) botao.disabled = false;
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    consultar(campo.value.trim(), null);
  });

  async function carregarLista() {
    const lista = document.getElementById('lista');
    try {
      const resp = await fetch(`dados/indice.json?t=${Date.now()}`, { cache: 'no-store' });
      const { produtos } = await resp.json();
      if (!produtos.length) {
        lista.textContent = 'Nenhum produto ainda.';
        return;
      }
      lista.innerHTML = `<ul class="lista">${produtos
        .map((p) => {
          const chave = `${p.loja}_${p.id}`;
          const lojas = p.lojas > 1 ? ` · ${p.lojas} lojas` : '';
          return `<li><a href="?produto=${esc(encodeURIComponent(chave))}" data-chave="${esc(chave)}" data-url="${esc(p.url)}">
            <span class="nome">${esc(p.titulo || p.id)}</span>
            <span class="detalhe">${p.quantidade} preços${lojas} · último ${esc(reais(p.ultimoPrecoCentavos))} · menor ${esc(reais(p.menorPrecoCentavos))} · conferido em ${esc(dataCurta(p.atualizadoEm))}</span>
          </a></li>`;
        })
        .join('')}</ul>`;
      lista.querySelectorAll('a[data-chave]').forEach((a) =>
        a.addEventListener('click', (e) => {
          e.preventDefault();
          campo.value = a.dataset.url;
          consultar(a.dataset.url, a.dataset.chave);
          document.getElementById('titulo-busca').scrollIntoView({ behavior: 'smooth' });
        }),
      );
    } catch {
      lista.textContent = 'Não foi possível carregar a lista agora.';
    }
  }

  carregarLista();
  const parametros = new URLSearchParams(location.search);
  const linkInicial = parametros.get('link');
  const inicial = parametros.get('produto');
  if (linkInicial) {
    // ?link=... consulta na hora (dá para compartilhar o endereço de uma consulta).
    campo.value = linkInicial;
    consultar(linkInicial, null);
  } else if (inicial && /^(amazon|mercadolivre)_[A-Z0-9]+$/.test(inicial)) {
    // Abre direto o histórico salvo (rápido); quem quiser o mais novo consulta o link.
    lerSalvo(inicial).then((dados) => dados && desenhar(resultado, dados));
  }
})();
