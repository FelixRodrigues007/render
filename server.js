const express = require('express');
const WebSocket = require('ws'); // Biblioteca cliente WebSocket
const app = express();
app.use(express.json());

// --- Configuração ---
const SIDESWAP_MANAGER_WS_URL = 'ws://IP_DO_SEU_SERVIDOR_HETZNER:9933/'; // Use ws://, não wss://, pois é uma conexão direta ao seu servidor, a menos que você configure TLS no sideswap_manager
let wsClient = null;
let reconnectInterval = 5000; // Tentar reconectar a cada 5 segundos
let inflightRequests = new Map(); // Para rastrear requisições e suas callbacks de resposta

// --- Funções do Cliente WebSocket ---

function connectToSideSwapManager() {
    console.log(`Attempting to connect to SideSwap Manager at ${SIDESWAP_MANAGER_WS_URL}...`);
    wsClient = new WebSocket(SIDESWAP_MANAGER_WS_URL);

    wsClient.on('open', () => {
        console.log('Connected to SideSwap Manager WebSocket.');
        // Você pode enviar uma mensagem de inicialização/autenticação aqui se a API do manager exigir
    });

    wsClient.on('message', (data) => {
        try {
            const messageString = data.toString();
            console.log('Received from SideSwap Manager:', messageString);
            const response = JSON.parse(messageString);

            // Assumindo que a resposta segue o formato From::Resp ou From::Error com um 'id'
            if (response.Resp && response.Resp.id) {
                const requestId = response.Resp.id;
                if (inflightRequests.has(requestId)) {
                    const { resolve } = inflightRequests.get(requestId);
                    resolve(response.Resp.resp); // Envia apenas o payload da resposta
                    inflightRequests.delete(requestId);
                }
            } else if (response.Error && response.Error.id) {
                const requestId = response.Error.id;
                if (inflightRequests.has(requestId)) {
                    const { reject } = inflightRequests.get(requestId);
                    reject(response.Error); // Envia o objeto de erro
                    inflightRequests.delete(requestId);
                }
            } else if (response.Notif) {
                // Lidar com notificações assíncronas (ex: BalancesNotif, PegStatusNotif)
                console.log('Received Notification:', response.Notif);
                // Aqui você pode, por exemplo, emitir eventos, salvar no DB, etc.
            }

        } catch (e) {
            console.error('Failed to parse message from SideSwap Manager or handle response:', e);
        }
    });

    wsClient.on('close', () => {
        console.log('Disconnected from SideSwap Manager WebSocket. Attempting to reconnect...');
        wsClient = null;
        setTimeout(connectToSideSwapManager, reconnectInterval);
    });

    wsClient.on('error', (err) => {
        console.error('SideSwap Manager WebSocket error:', err.message);
        // A 'close' event will usually follow, triggering reconnection.
        // Se não, você pode forçar o fechamento para acionar a reconexão:
        if (wsClient) {
            wsClient.terminate(); // Força o fechamento para acionar o 'close' e reconectar
        }
    });
}

// Função auxiliar para enviar uma requisição e esperar uma resposta
function sendWsRequest(methodName, params) {
    return new Promise((resolve, reject) => {
        if (!wsClient || wsClient.readyState !== WebSocket.OPEN) {
            return reject(new Error('Not connected to SideSwap Manager WebSocket.'));
        }

        const requestId = Date.now() + Math.random(); // ID de requisição simples
        const requestPayload = {
            Req: { // Conforme a struct 'To' e 'Req' do api.rs
                id: requestId,
                req: {
                    [methodName]: params // Ex: { "GetQuote": { send_asset: "LBTC", ... } }
                }
            }
        };

        try {
            const message = JSON.stringify(requestPayload);
            console.log('Sending to SideSwap Manager:', message);
            wsClient.send(message);
            inflightRequests.set(requestId, { resolve, reject });

            // Timeout para a requisição
            setTimeout(() => {
                if (inflightRequests.has(requestId)) {
                    reject(new Error(`Request ${requestId} timed out`));
                    inflightRequests.delete(requestId);
                }
            }, 30000); // Timeout de 30 segundos

        } catch (e) {
            reject(new Error(`Failed to send WebSocket message: ${e.message}`));
        }
    });
}

// --- Endpoints HTTP ---

app.get('/', (req, res) => {
    res.send('SideSwap Bridge is running. WebSocket status: ' + (wsClient && wsClient.readyState === WebSocket.OPEN ? 'Connected' : 'Disconnected'));
});

app.post('/api/quote', async (req, res) => {
    const { send_asset, recv_asset, send_amount, receive_address, instant_swap = true } = req.body;

    if (!send_asset || !recv_asset || !send_amount || !receive_address) {
        return res.status(400).json({ error: "Missing params: send_asset, recv_asset, send_amount, receive_address are required." });
    }

    try {
        const quoteParams = {
            send_asset,     // String, ex: "LBTC" (conforme o Ticker esperado pelo manager)
            recv_asset,     // String, ex: "PEGxUSDT"
            send_amount: parseFloat(send_amount), // f64
            receive_address, // String do endereço Liquid
            instant_swap    // boolean
        };
        const quoteResponse = await sendWsRequest('GetQuote', quoteParams); // 'GetQuote' é o nome da variante do enum Req
        res.json(quoteResponse);
    } catch (e) {
        console.error('Quote API error:', e.message, e.stack);
        res.status(500).json({ error: `Failed to get quote: ${e.message || e}` });
    }
});

// TODO: Adicionar mais endpoints (ex: /api/accept_quote, /api/balances, etc.)

// --- Iniciar Servidor e Conexão WebSocket ---
const PORT = process.env.PORT || 3020; // Render.com define a PORT env var
app.listen(PORT, () => {
    console.log(`SideSwap Bridge HTTP server listening on port ${PORT}`);
    connectToSideSwapManager(); // Inicia a conexão WebSocket
});
