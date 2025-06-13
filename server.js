const express = require('express');
const WebSocket = require('ws');
const app = express();
app.use(express.json());

// --- Configuração ---
const HETZNER_SERVER_IP = process.env.HETZNER_IP || 'localhost'; 
const SIDESWAP_MANAGER_WS_URL = `ws://${HETZNER_SERVER_IP}:9933/`;

let wsClient = null;
const reconnectInterval = 5000; 
const requestTimeout = 30000; 
let inflightRequests = new Map();

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
    });

    wsClient.on('message', (data) => {
        try {
            const messageString = data.toString();
            console.log('Received from SideSwap Manager:', messageString);
            const responseEnvelope = JSON.parse(messageString); // Espera o envelope From

            let requestId;
            let actualResponsePayload;
            let isError = false;

            // Verifica a estrutura do envelope 'From'
            if (responseEnvelope.From) {
                if (responseEnvelope.From.Resp && responseEnvelope.From.Resp.id !== undefined) {
                    requestId = responseEnvelope.From.Resp.id;
                    actualResponsePayload = responseEnvelope.From.Resp.resp;
                } else if (responseEnvelope.From.Error && responseEnvelope.From.Error.id !== undefined) {
                    requestId = responseEnvelope.From.Error.id;
                    actualResponsePayload = responseEnvelope.From.Error.err; // O payload é o objeto de erro
                    isError = true;
                } else if (responseEnvelope.From.Notif) {
                    const notification = responseEnvelope.From.Notif;
                    console.log('Received Async Notification:', notification);
                    // TODO: Implementar lógica para lidar com notificações
                    return; // Sai cedo, pois não é uma resposta a uma requisição
                }
            } else {
                 // Fallback para estruturas de resposta mais simples se o envelope "From" não estiver presente
                 // (improvável com base no api.rs, mas para robustez)
                if (responseEnvelope.Resp && responseEnvelope.Resp.id !== undefined) {
                    requestId = responseEnvelope.Resp.id;
                    actualResponsePayload = responseEnvelope.Resp.resp;
                } else if (responseEnvelope.Error && responseEnvelope.Error.id !== undefined) {
                    requestId = responseEnvelope.Error.id;
                    actualResponsePayload = responseEnvelope.Error.err;
                    isError = true;
                } else if (responseEnvelope.Notif) {
                     const notification = responseEnvelope.Notif;
                     console.log('Received Async Notification (no From envelope):', notification);
                     return;
                }
            }


            if (requestId !== undefined && inflightRequests.has(requestId)) {
                const { resolve, reject } = inflightRequests.get(requestId);
                if (isError) {
                    reject(actualResponsePayload); // Rejeita com o objeto de erro do manager
                } else {
                    resolve(actualResponsePayload); // Envia apenas o payload da resposta (o conteúdo de From.Resp.resp)
                }
                inflightRequests.delete(requestId);
            } else {
                console.warn('Received WebSocket message without a matching request ID or not a known notification structure:', responseEnvelope);
            }

        } catch (e) {
            console.error('Failed to parse message from SideSwap Manager or handle response logic:', e, data.toString());
        }
    });

    wsClient.on('close', (code, reason) => {
        console.log(`Disconnected from SideSwap Manager WebSocket. Code: ${code}, Reason: ${reason ? reason.toString() : 'N/A'}. Attempting to reconnect in ${reconnectInterval / 1000}s...`);
        wsClient = null;
        for (const [id, { reject }] of inflightRequests) {
            reject(new Error('WebSocket connection closed while request was in flight.'));
        }
        inflightRequests.clear();
        setTimeout(connectToSideSwapManager, reconnectInterval);
    });

    wsClient.on('error', (err) => {
        console.error('SideSwap Manager WebSocket connection error:', err.message);
        if (wsClient && wsClient.readyState !== WebSocket.CLOSED) {
            wsClient.terminate(); 
        }
    });
}

// Função auxiliar para enviar uma requisição e esperar uma resposta
function sendWsRequest(methodVariantName, params) {
    return new Promise((resolve, reject) => {
        if (!wsClient || wsClient.readyState !== WebSocket.OPEN) {
            if (!wsClient || wsClient.readyState === WebSocket.CLOSED) {
                console.warn('WebSocket not open. Attempting to connect before sending request...');
                connectToSideSwapManager();
                return reject(new Error('WebSocket not connected. Connection attempt initiated. Please try again shortly.'));
            } else if (wsClient.readyState === WebSocket.CONNECTING) {
                return reject(new Error('WebSocket is currently connecting. Please try again shortly.'));
            }
            return reject(new Error('WebSocket not open.'));
        }

        const requestId = `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;

        // Estrutura interna da requisição (o conteúdo do campo 'req' da variante 'Req' do enum 'To')
        const innerRequestPayload = {
            [methodVariantName]: params // Ex: { "GetQuote": { send_asset: "LBTC", ... } }
        };
        
        // Estrutura da variante 'Req' do enum 'To'
        const toReqVariantPayload = {
            id: requestId,
            req: innerRequestPayload 
        };

        // O JSON final enviado deve representar o enum 'To' com sua variante 'Req'
        // Conforme api.rs: pub enum To { Req { id: ReqId, req: Req } }
        // Então o JSON deve ser: { "Req": { "id": ..., "req": { ... } } }
        const payloadToSendViaWebSocket = {
            "Req": toReqVariantPayload 
        };

        try {
            const message = JSON.stringify(payloadToSendViaWebSocket); 
            console.log(`Sending to SideSwap Manager (ID: ${requestId}):`, message);
            wsClient.send(message);
            inflightRequests.set(requestId, { resolve, reject, timestamp: Date.now() });

            setTimeout(() => {
                if (inflightRequests.has(requestId)) {
                    console.error(`Request ${requestId} for method ${methodVariantName} timed out.`);
                    reject(new Error(`Request ${requestId} for method ${methodVariantName} timed out`));
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
    const state = wsClient ? wsStateMap[wsClient.readyState] : 'NOT INITIALIZED OR DISCONNECTED';
    res.send(`SideSwap Bridge is running. WebSocket to SideSwap Manager status: ${state}`);
});

app.post('/api/quote', async (req, res) => {
    const { send_asset, recv_asset, send_amount, receive_address, instant_swap = true } = req.body;

    if (!send_asset || !recv_asset || send_amount === undefined || !receive_address) {
        return res.status(400).json({ error: "Missing params: send_asset, recv_asset, send_amount, receive_address are required." });
    }

    try {
        const quoteParams = {
            send_asset,    
            recv_asset,    
            send_amount: parseFloat(send_amount), 
            receive_address, 
            instant_swap   
        };
        
        const quoteResponse = await sendWsRequest('GetQuote', quoteParams); // "GetQuote" é o nome da variante do enum Req
        res.json(quoteResponse); 
    } catch (e) {
        console.error('Quote API error:', e.message, e.stack ? '\n' + e.stack : '');
        const errorMessage = e instanceof Error ? e.message : (typeof e === 'object' && e !== null && e.text) ? e.text : e.toString();
        res.status(500).json({ error: `Failed to get quote: ${errorMessage}`, details: (typeof e === 'object' && e !== null) ? e : null });
    }
});

// --- Iniciar Servidor HTTP e Conexão WebSocket ---
const PORT = process.env.PORT || 3000; 
app.listen(PORT, () => {
    console.log(`SideSwap Bridge HTTP server listening on port ${PORT}`);
    connectToSideSwapManager(); 
});

// Limpeza de requests que possam ter ficado presas
setInterval(() => {
    const now = Date.now();
    for (const [id, { timestamp, reject }] of inflightRequests) {
        if (now - timestamp > requestTimeout + 5000) { 
            console.warn(`Forcefully removing stale request ${id} from inflightRequests.`);
            reject(new Error(`Request ${id} stale and removed.`));
            inflightRequests.delete(id);
        }
    }
}, 60000);
