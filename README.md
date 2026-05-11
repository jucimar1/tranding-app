# 🎯 Timing Pro ULTRA v2.0

Sistema profissional de trading com dados em tempo real via WebSocket.

## 🚀 Deploy no Render

1. **Crie uma conta no [Render](https://render.com)**

2. **Clone este repositório ou faça upload dos arquivos**

3. **No dashboard do Render:**
   - Clique em "New" → "Web Service"
   - Conecte seu repositório GitHub
   - Configure:
     - **Name**: timing-pro-ultra
     - **Region**: São Paulo (ou mais próximo)
     - **Branch**: main
     - **Build Command**: `npm install`
     - **Start Command**: `npm start`

4. **Adicione Variáveis de Ambiente:**
   - `TELEGRAM_BOT_TOKEN` (opcional)
   - `TELEGRAM_CHAT_ID` (opcional)
   - `NODE_ENV`: production
   - `PORT`: 3000

5. **Clique em "Create Web Service"**

## 🔧 Funcionalidades

- ✅ Dados em tempo real via WebSocket
- ✅ Análise técnica completa (MACD, RSI, EMA, ATR)
- ✅ Sinais de compra/venda automáticos
- ✅ Gestão de risco (Stop Loss, Take Profit, Trailing)
- ✅ Interface responsiva e moderna
- ✅ Logs em tempo real
- ✅ Alertas via Telegram (opcional)

## 📊 Pares Suportados

Qualquer par da Binance com USDT:
- BTCUSDT (padrão)
- ETHUSDT
- SOLUSDT
- E muitos outros...

## 🔐 Segurança

- Variáveis de ambiente para dados sensíveis
- Rate limiting nas APIs
- Helmet.js para headers de segurança
- CORS configurado
- WebSocket seguro (WSS em produção)

## 📱 Acesso

Após deploy, acesse: `https://seu-app.onrender.com`

## 🛠 Desenvolvimento Local

```bash
npm install
npm start