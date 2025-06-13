const express = require('express');
const WebSocket = require('ws');
const app = express();
app.use(express.json());

// --- Configuração ---
// É ALTAMENTE RECOMENDADO usar variáveis de ambiente para o IP do servidor.
// No painel da Render.com, vá em "Environment" e adicione uma variável:
// Key: HETZNER_IP
// Value: SEU_ENDERECO_IP_REAL_DO_HETZNER
// Se HETZNER_IP não estiver definida, ele usará 'localhost' (bom para teste local se tudo rodar na mesma máquina).
const HETZNER_SERVER_IP = process.env.HETZNER_IP || 'localhost'; 
const SIDESWAP_MANAGER_WS_URL = `ws://${HETZNER_SERVER_IP}:9933/`;

let wsClient = null;
const reconnectInterval = 5000; // Tentar reconectar a cada 5 segundos (em ms)
const requestTimeout = 30000; // Timeout para uma requisição WebSocket (em ms)
let inflightRequests = new Map(); // Para rastrear requisições e suas callbacks/promises

// --- Funções do Cliente WebSocket ---

function connectToSideSwapManager() {
    if (wsClient && (wsClient.readyState === WebSocket.OPEN || wsClient.readyState === WebSocket.CONNECTING)) {
        console.log('WebSocket connection attempt already in progress or established.');
        return;
    }

    console.log(`Attempting to connect to SideSwap Manager at ${SIDESWAP_MANAGER_WS_URL}...`);
    wsClient = new WebSocket(SIDESWAP_MANAGER_WS_URL);

    wsClient.on('open', () => {
        console.log('Successfully connected to SideSwap Manager WebSocket.');
        // Limpar o intervalo de reconexão se ele existir de uma tentativa anterior
    });

    wsClient.on('message', (data) => {
        try {
            const messageString = data.toString();
            console.log('Received from SideSwap Manager:', messageString);
            const response = JSON.parse(messageString);

            let requestId;
            if (response.From && response.From.Resp && response.From.Resp.id !== undefined) {
                requestId = response.From.Resp.id;
            } else if (response.From && response.From.Error && response.From.Error.id !== undefined) {
                requestId = response.From.Error.id;
            } else if (response.Resp && response.Resp.id !== undefined) { // Estrutura alternativa sem o "From"
                requestId = response.Resp.id;
            } else if (response.Error && response.Error.id !== undefined) { // Estrutura alternativa sem o "From"
                requestId = response.Error.id;
            }


            if (requestId !== undefined && inflightRequests.has(requestId)) {
                const { resolve, reject } = inflightRequests.get(requestId);
                if (response.From && response.From.Resp) {
                    resolve(response.From.Resp.resp);
                } else if (response.From && response.From.Error) {
                    reject(response.From.Error.err); // Rejeita com o objeto de erro do manager
                } else if (response.Resp) { // Estrutura alternativa
                    resolve(response.Resp.resp);
                } else if (response.Error) { // Estrutura alternativa
                    reject(response.Error.err);
                }
                inflightRequests.delete(requestId);
            } else if ((response.From && response.From.Notif) || response.Notif) {
                const notification = (response.From && response.From.Notif) ? response.From.Notif : response.Notif;
                console.log('Received Async Notification:', notification);
                // TODO: Implementar lógica para lidar com notificações (ex: emitir eventos, WebSockets para clientes do bridge)
            } else {
                console.warn('Received WebSocket message without a matching request ID or not a known notification structure:', response);
            }

        } catch (e) {
            console.error('Failed to parse message from SideSwap Manager or handle response logic:', e, data.toString());
        }
    });

    wsClient.on('close', (code, reason) => {
        console.log(`Disconnected from SideSwap Manager WebSocket. Code: ${code}, Reason: ${reason ? reason.toString() : 'N/A'}. Attempting to reconnect in ${reconnectInterval / 1000}s...`);
        wsClient = null; // Garante que o objeto antigo seja liberado
        for (const [id, { reject }] of inflightRequests) {
            reject(new Error('WebSocket connection closed while request was in flight.'));
        }
        inflightRequests.clear();
        setTimeout(connectToSideSwapManager, reconnectInterval);
    });

    wsClient.on('error', (err) => {
        console.error('SideSwap Manager WebSocket connection error:', err.message);
        // O evento 'close' geralmente é disparado após um 'error',
        // então a lógica de reconexão já deve ser acionada.
        // Se wsClient não for null aqui e o estado não for CLOSED, podemos forçar.
        if (wsClient && wsClient.readyState !== WebSocket.CLOSED) {
            wsClient.terminate(); // Força o fechamento para acionar o 'close' e reconectar
        }
    });
}

// Função auxiliar para enviar uma requisição e esperar uma resposta
function sendWsRequest(methodVariantName, params) {
    return new Promise((resolve, reject) => {
        if (!wsClient || wsClient.readyState !== WebSocket.OPEN) {
            // Tenta conectar se não estiver conectado, mas avisa que pode demorar
            if (!wsClient || wsClient.readyState === WebSocket.CLOSED) {
                console.warn('WebSocket not open. Attempting to connect before sending request...');
                connectToSideSwapManager(); // Tenta reconectar
                 // Rejeita imediatamente ou espera um pouco e tenta de novo?
                 // Por simplicidade, vamos rejeitar e o cliente HTTP pode tentar novamente.
                return reject(new Error('WebSocket not connected. Connection attempt initiated. Please try again shortly.'));
            } else if (wsClient.readyState === WebSocket.CONNECTING) {
                return reject(new Error('WebSocket is currently connecting. Please try again shortly.'));
            }
            return reject(new Error('WebSocket not open.'));
        }

        // Gera um ID de requisição único (simples, para este exemplo)
        // Em produção, um UUID seria melhor.
        const requestId = `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;

        // Monta o payload conforme a estrutura `To` e `Req` do `api.rs`
        // A mensagem é o CONTEÚDO da variante `To::Req`
        const requestPayloadForSideSwap = {
            id: requestId,
            req: {
                [methodVariantName]: params // Ex: { "GetQuote": { send_asset: "LBTC", ... } }
            }
        };
        
        // O envelope `To` completo se a API esperar `{"To": {"Req": ...}}`
        // Mas, geralmente, para mensagens JSON em WS, você envia o objeto interno.
        // Baseado no `process_ws_msg` e `serde_json::from_str::<api::To>(&msg);` no `ws_server.rs`,
        // ele espera o envelope `To` completo.
        const fullPayload = {
            "To": requestPayloadForSideSwap // Ajuste aqui se o servidor esperar apenas o requestPayloadForSideSwap
        };


        try {
            const message = JSON.stringify(fullPayload); // Ou JSON.stringify(requestPayloadForSideSwap) se o envelope "To" não for necessário
            console.log(`Sending to SideSwap Manager (ID: ${requestId}):`, message);
            wsClient.send(message);
            inflightRequests.set(requestId, { resolve, reject, timestamp: Date.now() });

            // Timeout para a requisição
            setTimeout(() => {
                if (inflightRequests.has(requestId)) {
                    console.error(`Request ${requestId} for method ${methodVariantName} timed out.`);
                    reject(new Error(`Request ${requestId} timed out`));
                    inflightRequests.delete(requestId);
                }
            }, requestTimeout);

        } catch (e) {
            console.error(`Failed to stringify or send WebSocket message for ID ${requestId}:`, e);
            reject(new Error(`Failed to send WebSocket message: ${e.message}`));
        }
    });
}

// --- Endpoints HTTP ---

app.get('/', (req, res) => {
    const wsStateMap = {
        [WebSocket.CONNECTING]: 'CONNECTING',
        [WebSocket.OPEN]: 'OPEN',
        [WebSocket.CLOSING]: 'CLOSING',
        [WebSocket.CLOSED]: 'CLOSED',
    };
    const state = wsClient ? wsStateMap[wsClient.readyState] : 'NOT INITIALIZED';
    res.send(`SideSwap Bridge is running. WebSocket to SideSwap Manager status: ${state}`);
});

// Endpoint para obter uma cotação
app.post('/api/quote', async (req, res) => {
    const { send_asset, recv_asset, send_amount, receive_address, instant_swap = true } = req.body;

    if (!send_asset || !recv_asset || send_amount === undefined || !receive_address) {
        return res.status(400).json({ error: "Missing params: send_asset, recv_asset, send_amount, receive_address are required." });
    }

    try {
        // Os parâmetros para GetQuoteReq conforme api.rs
        const quoteParams = {
            send_asset,     // Ticker (String)
            recv_asset,     // Ticker (String)
            send_amount: parseFloat(send_amount), // f64
            receive_address, // elements::Address (String)
            instant_swap    // boolean
        };
        
        // O nome da variante do enum Req é "GetQuote"
        const quoteResponse = await sendWsRequest('GetQuote', quoteParams);
        res.json(quoteResponse); // A resposta já deve ser a struct GetQuoteResp serializada
    } catch (e) {
        console.error('Quote API error:', e.message, e.stack ? '\n' + e.stack : '');
        res.status(500).json({ error: `Failed to get quote: ${e.message || e.toString()}` });
    }
});

// Exemplo de endpoint para listar assets (requer método correspondente no sideswap_manager)
// Supondo que exista um Req::ListConfiguredAssets que retorna um Resp::ListConfiguredAssetsResp
/*
app.get('/api/assets', async (req, res) => {
    try {
        // Supondo que não há parâmetros para ListConfiguredAssets
        const assetsResponse = await sendWsRequest('ListConfiguredAssets', {}); 
        res.json(assetsResponse);
    } catch (e) {
        console.error('Assets API error:', e.message, e.stack ? '\n' + e.stack : '');
        res.status(500).json({ error: `Failed to list assets: ${e.message || e.toString()}` });
    }
});
*/

// TODO: Adicionar mais endpoints (ex: /api/accept_quote, /api/balances, etc.)
// Para cada um, você precisará:
// 1. Identificar a variante correta do enum `Req` em `api.rs` (ex: `AcceptQuote`).
// 2. Identificar a struct de request correspondente em `api.rs` (ex: `AcceptQuoteReq`) para saber os parâmetros.
// 3. Chamar `sendWsRequest('NomeDaVarianteReq', { ...parametros... })`.

// --- Iniciar Servidor HTTP e Conexão WebSocket ---
const PORT = process.env.PORT || 3000; // Render.com define a PORT env var. 3020 que você usou antes também serve.
app.listen(PORT, () => {
    console.log(`SideSwap Bridge HTTP server listening on port ${PORT}`);
    connectToSideSwapManager(); // Inicia a primeira tentativa de conexão WebSocket
});

// Limpeza de requests que possam ter ficado presas (raro, mas para robustez)
setInterval(() => {
    const now = Date.now();
    for (const [id, { timestamp, reject }] of inflightRequests) {
        if (now - timestamp > requestTimeout + 5000) { // Adiciona uma margem ao timeout
            console.warn(`Forcefully removing stale request ${id} from inflightRequests.`);
            reject(new Error(`Request ${id} stale and removed.`));
            inflightRequests.delete(id);
        }
    }
}, 60000); // Verifica a cada minuto
