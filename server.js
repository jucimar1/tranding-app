require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');

const app = express();

// Configurações
app.use(cors());
app.use(express.json());

// Variáveis de Ambiente (Configure no Render!)
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// --- ROTAS DA API ---

// 1. Rota para pegar preço da Binance (Proxy)
app.get('/api/price', async (req, res) => {
    try {
        const symbol = req.query.symbol || 'BTCUSDT';
        // Conecta na API pública da Binance
        const response = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
        const data = await response.json();
        res.json(data); // Retorna o preço para o frontend
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 2. Rota para enviar Telegram
app.post('/api/telegram', async (req, res) => {
    // Verifica se as variáveis existem
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
        return res.status(500).json({ error: '⚠️ Variáveis TELEGRAM_TOKEN e CHAT_ID não configuradas no servidor!' });
    }

    try {
        const message = req.body.message || '🔔 Alerta de Teste!';
        const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
        
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TELEGRAM_CHAT_ID,
                text: message
            })
        });
        
        const result = await response.json();
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Serve o arquivo HTML
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Inicia o servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
