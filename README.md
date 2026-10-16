# LiveApp (white label)

Chat, voz, câmera e compartilhamento de tela para você e seus amigos. Funciona como site e como app de desktop (Electron), com o mesmo código.

## Rodar

```bash
npm install
npm start          # site em http://localhost:3000
npm run desktop    # app de desktop (sobe o servidor junto se o serverUrl for local)
```

## Trocar a marca (white label)

Tudo está em `brand.config.json`, sem mexer em código:

| Campo | O que faz |
|---|---|
| `appName`, `tagline` | Nome e frase da tela de entrada |
| `logoText` / `logoUrl` | Iniciais ou imagem do logo |
| `colors` | Paleta inteira |
| `channels` | Lista de canais de voz/chat |
| `accessCode` | Se preenchido, só entra quem souber o código |
| `maxPeersPerChannel` | Limite por canal (veja "Limites") |
| `serverUrl` | Endereço que o app de desktop abre |
| `iceServers` | Servidores STUN/TURN |

## Jogar com amigos pela internet

A câmera, o microfone e a tela só funcionam em **HTTPS** (ou `localhost`). Duas opções:

1. **Túnel rápido** (seu PC é o servidor): com o servidor rodando, use `cloudflared tunnel --url http://localhost:3000` ou `ngrok http 3000` e mande o link HTTPS para os amigos.
2. **Hospedar** em Render, Railway, Fly.io etc. (qualquer host com Node e HTTPS) e definir `serverUrl` com o endereço final.

Defina um `accessCode` antes de divulgar o link.

## Limites

- **Malha P2P:** cada pessoa envia o vídeo para todas as outras. Funciona bem até uns 4–6 participantes; acima disso a internet de quem envia vira o gargalo. Para grupos grandes, troque por um servidor SFU (LiveKit ou mediasoup).
- **TURN:** só há STUN. Se alguém estiver atrás de uma rede restritiva (4G, empresa), a conexão pode falhar. Nesse caso adicione um servidor TURN em `iceServers` (coturn ou um serviço gerenciado).
- **Chat em memória:** o histórico (últimas 100 mensagens por canal) some quando o servidor reinicia.
- **Áudio do sistema na tela:** no Chrome vale para abas; no app de desktop, para a tela inteira (Windows).

## Atalhos

`M` microfone · `D` ensurdecer · `V` câmera · `S` compartilhar tela. Clique em um bloco de vídeo para ampliar.

## Estrutura

```
server.js           servidor (site, chat, sinalização)
brand.config.json   marca e configuração
public/             site (index.html, style.css, app.js)
desktop/main.js     app de desktop (Electron)
```

## Não ouço / não vejo meus amigos

**Plano B automático (v0.0.5):** se o caminho direto (P2P) não abrir em ~12 s, o app passa a repassar
câmera, tela e voz **pelo servidor** (o mesmo link do chat). Funciona atrás de qualquer NAT, sem TURN.
Custo: ~1 a 2 s de atraso, e quem hospeda gasta mais upload (uma cópia por pessoa que precisa do plano B).
Em **Configurações → Rede** aparece "via servidor do app".

### Melhor qualidade: servidor TURN

Câmera, voz e tela vão **direto entre os PCs** (P2P). O link da Cloudflare só leva o chat e a sinalização.
Em redes com NAT restritivo (CGNAT de operadora, 4G, algumas fibras) esse caminho direto não abre e o
resultado é áudio mudo e vídeo preto. A solução é um servidor **TURN**, que repassa a mídia.

1. Crie uma conta gratuita em um provedor TURN (por exemplo metered.ca) e copie os endereços, usuário e senha.
2. No app de **quem hospeda**: Configurações → **Rede** → cole os dados → **Testar** → **Salvar para todos**.
3. Todo mundo sai do canal e entra de novo (a lista é recarregada ao entrar).

Em **Configurações → Rede** cada conexão mostra o estado, o caminho (direto ou via relay), os KB recebidos e
os quadros de vídeo. Se ainda assim falhar, marque *Forçar relay* para testar só pelo TURN.
Sem TURN, uma VPN (Radmin, Tailscale) também resolve, porque coloca todos na mesma rede.
