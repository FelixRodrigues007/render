const express = require('express');
const WebSocket = require('ws');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');

const app = express();

// --- Middleware de Segurança ---
app.use(helmet());
app.use(cors({
    origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : ['http://localhost:3000'],
    credentials: true
}));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 100, // máximo 100 requests por IP por janela
    message: { error: 'Too many requests from this IP, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false
});
app.use(limiter);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// --- Configuração ---
// Modificar as configurações de timeout
const CONFIG = {
    HETZNER_IP: process.env.HETZNER_IP || 'localhost',
    WS_PORT: process.env.WS_PORT || '9933',
    HTTP_PORT: process.env.PORT || 3000,
    RECONNECT_INTERVAL: parseInt(process.env.RECONNECT_INTERVAL || '5000', 10), // Default 5 seconds
    REQUEST_TIMEOUT: parseInt(process.env.REQUEST_TIMEOUT || '35000', 10), // Aumentar para 35 segundos
    QUOTE_REQUEST_TIMEOUT: parseInt(process.env.QUOTE_REQUEST_TIMEOUT || '35000', 10), // Aumentar para 35 segundos
    MAX_RECONNECT_ATTEMPTS: parseInt(process.env.MAX_RECONNECT_ATTEMPTS || '10', 10),
    QUOTE_RETRIES: parseInt(process.env.QUOTE_RETRIES || '3', 10), // Default 3 retries for quote requests
    QUOTE_RETRY_DELAY_MS: parseInt(process.env.QUOTE_RETRY_DELAY_MS || '1000', 10), // Initial delay for quote retries
    QUOTE_RETRY_BACKOFF_FACTOR: parseFloat(process.env.QUOTE_RETRY_BACKOFF_FACTOR || '2.0'), // Backoff factor for quote retries
    HEALTH_CHECK_INTERVAL: parseInt(process.env.HEALTH_CHECK_INTERVAL || '30000', 10), // Default 30 seconds
    LOG_LEVEL: process.env.LOG_LEVEL || 'info', // debug, info, warn, error
    HEARTBEAT_INTERVAL: parseInt(process.env.HEARTBEAT_INTERVAL || '15000', 10), // 15 segundos para ping
    PONG_TIMEOUT: parseInt(process.env.PONG_TIMEOUT || '7000', 10) // 7 segundos para receber pong
};

const SIDESWAP_MANAGER_WS_URL = `ws://${CONFIG.HETZNER_IP}:${CONFIG.WS_PORT}/`;

// --- Estado da Aplicação ---
let wsClient = null;
let inflightRequests = new Map();
let reconnectAttempts = 0;
let isShuttingDown = false;
let lastHeartbeat = null;
let heartbeatIntervalId = null;
let pongTimeoutId = null;
let connectionStats = {
    totalConnections: 0,
    totalDisconnections: 0,
    totalRequests: 0,
    totalErrors: 0,
    uptime: Date.now()
};

// --- Sistema de Logging ---
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const currentLogLevel = LOG_LEVELS[CONFIG.LOG_LEVEL] || LOG_LEVELS.info;

function log(level, message, ...args) {
    if (LOG_LEVELS[level] <= currentLogLevel) {
        const timestamp = new Date().toISOString();
        console[level](`[${timestamp}] [${level.toUpperCase()}]`, message, ...args);
    }
}

// --- Validação de Parâmetros ---
function validateQuoteParams(params) {
    const { send_asset, recv_asset, send_amount, receive_address } = params;
    const errors = [];

    if (!send_asset || typeof send_asset !== 'string') {
        errors.push('send_asset must be a non-empty string');
    }
    if (!recv_asset || typeof recv_asset !== 'string') {
        errors.push('recv_asset must be a non-empty string');
    }
    if (send_amount === undefined || send_amount === null || isNaN(parseFloat(send_amount)) || parseFloat(send_amount) <= 0) {
        errors.push('send_amount must be a positive number');
    }
    if (!receive_address || typeof receive_address !== 'string') {
        errors.push('receive_address must be a non-empty string');
    }

    return errors;
}

// --- Funções do Cliente WebSocket ---

function connectToSideSwapManager() {
    if (isShuttingDown) {
        log('info', 'Application is shutting down, skipping connection attempt');
        return;
    }

    if (wsClient && (wsClient.readyState === WebSocket.OPEN || wsClient.readyState === WebSocket.CONNECTING)) {
        log('debug', 'WebSocket connection attempt already in progress or established.');
        return;
    }

    if (reconnectAttempts >= CONFIG.MAX_RECONNECT_ATTEMPTS) {
        log('error', `Maximum reconnection attempts (${CONFIG.MAX_RECONNECT_ATTEMPTS}) reached. Stopping reconnection attempts.`);
        return;
    }

    reconnectAttempts++;
    log('info', `Attempting to connect to SideSwap Manager at ${SIDESWAP_MANAGER_WS_URL}... (Attempt ${reconnectAttempts}/${CONFIG.MAX_RECONNECT_ATTEMPTS})`);
    
    wsClient = new WebSocket(SIDESWAP_MANAGER_WS_URL, {
        handshakeTimeout: 10000,
        perMessageDeflate: false
    });

    wsClient.on('open', () => {
        log('info', 'Successfully connected to SideSwap Manager WebSocket.');
        reconnectAttempts = 0;
        connectionStats.totalConnections++;
        lastHeartbeat = Date.now();
        sendHeartbeat();
        // Iniciar heartbeat periódico
        if (heartbeatIntervalId) clearInterval(heartbeatIntervalId);
        -         heartbeatIntervalId = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);
        +         heartbeatIntervalId = setInterval(sendHeartbeat, CONFIG.HEARTBEAT_INTERVAL);
    });

    wsClient.on('message', (data) => {
        try {
            const messageString = data.toString();
            log('debug', 'Received from SideSwap Manager:', messageString);
            const responseEnvelope = JSON.parse(messageString);
            
            lastHeartbeat = Date.now();

            let requestId;
            let actualResponsePayload;
            let isError = false;

            // Verifica a estrutura do envelope 'From'
            if (responseEnvelope.From) {
                if (responseEnvelope.From.Resp && responseEnvelope.From.Resp.id !== undefined) {
                    requestId = responseEnvelope.From.Resp.id;
                    actualResponsePayload = responseEnvelope.From.Resp.resp;
                    log('debug', `Received response for request ${requestId}`);
                } else if (responseEnvelope.From.Error && responseEnvelope.From.Error.id !== undefined) {
                    requestId = responseEnvelope.From.Error.id;
                    actualResponsePayload = responseEnvelope.From.Error.err;
                    isError = true;
                    log('warn', `Received error response for request ${requestId}:`, actualResponsePayload);
                } else if (responseEnvelope.From.Notif) {
                    const notification = responseEnvelope.From.Notif;
                    log('info', 'Received Async Notification:', notification);
                    handleNotification(notification);
                    return;
                }
            } else {
                // Fallback para estruturas de resposta mais simples
                if (responseEnvelope.Resp && responseEnvelope.Resp.id !== undefined) {
                    requestId = responseEnvelope.Resp.id;
                    actualResponsePayload = responseEnvelope.Resp.resp;
                } else if (responseEnvelope.Error && responseEnvelope.Error.id !== undefined) {
                    requestId = responseEnvelope.Error.id;
                    actualResponsePayload = responseEnvelope.Error.err;
                    isError = true;
                } else if (responseEnvelope.Notif) {
                    const notification = responseEnvelope.Notif;
                    log('info', 'Received Async Notification (no From envelope):', notification);
                    handleNotification(notification);
                    return;
                }
            }

            if (requestId !== undefined && inflightRequests.has(requestId)) {
                const { resolve, reject, timestamp } = inflightRequests.get(requestId);
                const responseTime = Date.now() - timestamp;
                
                if (isError) {
                    connectionStats.totalErrors++;
                    log('error', `Request ${requestId} failed after ${responseTime}ms:`, actualResponsePayload);
                    reject(new Error(JSON.stringify(actualResponsePayload)));
                } else {
                    log('debug', `Request ${requestId} completed successfully in ${responseTime}ms`);
                    resolve(actualResponsePayload);
                }
                inflightRequests.delete(requestId);
            } else {
                log('warn', 'Received WebSocket message without matching request ID:', {
                    requestId,
                    hasInflightRequest: inflightRequests.has(requestId),
                    inflightCount: inflightRequests.size,
                    envelope: responseEnvelope
                });
            }

        } catch (e) {
            connectionStats.totalErrors++;
            log('error', 'Failed to parse message from SideSwap Manager:', e.message, '\nRaw data:', data.toString());
        }
    });

    wsClient.on('close', (code, reason) => {
        connectionStats.totalDisconnections++;
        const reasonStr = reason ? reason.toString() : 'N/A';
        log('warn', `Disconnected from SideSwap Manager WebSocket. Code: ${code}, Reason: ${reasonStr}`);
        wsClient = null;
        lastHeartbeat = null;
        if (heartbeatIntervalId) clearInterval(heartbeatIntervalId);
        if (pongTimeoutId) clearTimeout(pongTimeoutId);
        
        wsClient = null;
        lastHeartbeat = null;
        
        // Reject all pending requests
        for (const [id, { reject }] of inflightRequests) {
            reject(new Error(`WebSocket connection closed while request was in flight. Code: ${code}, Reason: ${reasonStr}`));
        }
        inflightRequests.clear();
        
        // Schedule reconnection if not shutting down
        if (!isShuttingDown && reconnectAttempts < CONFIG.MAX_RECONNECT_ATTEMPTS) {
            const delay = Math.min(CONFIG.RECONNECT_INTERVAL * Math.pow(2, reconnectAttempts - 1), 30000); // Exponential backoff
            log('info', `Attempting to reconnect in ${delay / 1000}s...`);
            setTimeout(connectToSideSwapManager, delay);
        } else if (reconnectAttempts >= CONFIG.MAX_RECONNECT_ATTEMPTS) {
            log('error', 'Maximum reconnection attempts reached. Manual intervention required.');
        }
    });

    wsClient.on('error', (err) => {
        connectionStats.totalErrors++;
        log('error', 'SideSwap Manager WebSocket connection error:', err.message);
        
        if (wsClient && wsClient.readyState !== WebSocket.CLOSED) {
            wsClient.terminate();
        }
    });
}

// --- Funções Auxiliares ---

function handleNotification(notification) {
    // Implementar lógica específica para diferentes tipos de notificações
    log('info', 'Processing notification:', notification);
    // TODO: Adicionar handlers específicos baseados no tipo de notificação
}

function sendHeartbeat() {
    if (wsClient && wsClient.readyState === WebSocket.OPEN) {
        try {
            wsClient.ping();
            log('debug', 'Ping enviado para SideSwap Manager');
            if (pongTimeoutId) clearTimeout(pongTimeoutId);
            pongTimeoutId = setTimeout(() => {
                log('warn', 'Pong não recebido a tempo, terminando conexão WebSocket');
                wsClient.terminate();
-            }, PONG_TIMEOUT);
+            }, CONFIG.PONG_TIMEOUT);
        } catch (e) {
            log('error', 'Failed to send heartbeat:', e.message);
        }
    }
}

function getConnectionState() {
    if (!wsClient) return 'DISCONNECTED';
    
    const stateMap = {
        [WebSocket.CONNECTING]: 'CONNECTING',
        [WebSocket.OPEN]: 'OPEN',
        [WebSocket.CLOSING]: 'CLOSING',
        [WebSocket.CLOSED]: 'CLOSED'
    };
    
    return stateMap[wsClient.readyState] || 'UNKNOWN';
}

function isWebSocketReady() {
    return wsClient && wsClient.readyState === WebSocket.OPEN;
}

// Função auxiliar para enviar uma requisição e esperar uma resposta
function sendWsRequest(methodVariantName, params, options = {}) {
    return new Promise((resolve, reject) => {
        const timeout = options.timeout || CONFIG.REQUEST_TIMEOUT;
        const retries = options.retries !== undefined ? options.retries : 0;
        const retryDelay = options.retryDelay !== undefined ? options.retryDelay : CONFIG.QUOTE_RETRY_DELAY_MS;
        const backoffFactor = options.backoffFactor !== undefined ? options.backoffFactor : CONFIG.QUOTE_RETRY_BACKOFF_FACTOR;
        
        connectionStats.totalRequests++;
        
        // Validação de estado da conexão
        if (!isWebSocketReady()) {
            if (!wsClient || wsClient.readyState === WebSocket.CLOSED) {
                log('warn', 'WebSocket not open. Attempting to connect before sending request...');
                connectToSideSwapManager();
                return reject(new Error('WebSocket not connected. Connection attempt initiated. Please try again shortly.'));
            } else if (wsClient.readyState === WebSocket.CONNECTING) {
                return reject(new Error('WebSocket is currently connecting. Please try again shortly.'));
            }
            return reject(new Error('WebSocket not in ready state.'));
        }

        // Gerar ID único para a requisição
        const requestId = uuidv4();
        const timestamp = Date.now();

        // Validação de parâmetros
        if (!methodVariantName || typeof methodVariantName !== 'string') {
            return reject(new Error('methodVariantName must be a non-empty string'));
        }

        // Estrutura da requisição conforme protocolo SideSwap
        const innerRequestPayload = {
            [methodVariantName]: params
        };
        
        const toReqVariantPayload = {
            id: requestId,
            req: innerRequestPayload
        };

        const payloadToSendViaWebSocket = {
            "Req": toReqVariantPayload
        };

        try {
            const message = JSON.stringify(payloadToSendViaWebSocket);
            log('debug', `Sending to SideSwap Manager (ID: ${requestId}, Method: ${methodVariantName}):`, message);
            
            wsClient.send(message);
            
            // Armazenar requisição pendente
            inflightRequests.set(requestId, {
                resolve,
                reject,
                timestamp,
                method: methodVariantName,
                params,
                retries
            });

            // Configurar timeout
            const timeoutId = setTimeout(() => {
                if (inflightRequests.has(requestId)) {
                    connectionStats.totalErrors++;
                    log('error', `Request ${requestId} for method ${methodVariantName} timed out after ${timeout}ms`);
                    
                    const requestData = inflightRequests.get(requestId);
                    inflightRequests.delete(requestId);
                    
                    // Implementar retry se configurado
                    if (retries > 0) {
                        const nextRetryDelay = Math.min(retryDelay * backoffFactor, 30000); // Cap at 30 seconds
                        const jitter = Math.random() * 500; // Add up to 500ms of jitter
                        const finalDelay = nextRetryDelay + jitter;

                        log('info', `Retrying request ${requestId} (${retries} attempts remaining) in ${finalDelay.toFixed(0)}ms`);
                        setTimeout(() => {
                            sendWsRequest(methodVariantName, params, { 
                                ...options, 
                                retries: retries - 1,
                                retryDelay: nextRetryDelay // Pass the new delay for next retry
                            })
                                .then(resolve)
                                .catch(reject);
                        }, finalDelay);
                    } else {
                        reject(new Error(`Request ${requestId} for method ${methodVariantName} timed out after ${timeout}ms`));
                    }
                }
            }, timeout);
            
            // Armazenar timeout ID para limpeza posterior
            const requestData = inflightRequests.get(requestId);
            if (requestData) {
                requestData.timeoutId = timeoutId;
            }

        } catch (e) {
            connectionStats.totalErrors++;
            log('error', `Failed to stringify or send WebSocket message for ID ${requestId}:`, e.message);
            reject(new Error(`Failed to send WebSocket message: ${e.message}`));
        }
    });
}

// --- Middleware de Logging ---
app.use((req, res, next) => {
    const start = Date.now();
    const originalSend = res.send;
    
    res.send = function(data) {
        const duration = Date.now() - start;
        log('info', `${req.method} ${req.path} - ${res.statusCode} - ${duration}ms`);
        return originalSend.call(this, data);
    };
    
    next();
});

// --- Endpoints HTTP ---

app.get('/', (req, res) => {
    const state = getConnectionState();
    const uptime = Math.floor((Date.now() - connectionStats.uptime) / 1000);
    
    res.json({
        service: 'SideSwap Bridge',
        status: 'running',
        websocket_status: state,
        uptime_seconds: uptime,
        version: '2.0.0',
        timestamp: new Date().toISOString()
    });
});

app.get('/health', (req, res) => {
    const state = getConnectionState();
    const isHealthy = state === 'OPEN';
    const uptime = Math.floor((Date.now() - connectionStats.uptime) / 1000);
    
    const healthData = {
        status: isHealthy ? 'healthy' : 'unhealthy',
        websocket: {
            state,
            connected: isHealthy,
            last_heartbeat: lastHeartbeat ? new Date(lastHeartbeat).toISOString() : null,
            reconnect_attempts: reconnectAttempts
        },
        stats: {
            ...connectionStats,
            uptime_seconds: uptime,
            inflight_requests: inflightRequests.size
        },
        timestamp: new Date().toISOString()
    };
    
    res.status(isHealthy ? 200 : 503).json(healthData);
});

app.get('/api/status', (req, res) => {
    const state = getConnectionState();
    const uptime = Math.floor((Date.now() - connectionStats.uptime) / 1000);
    
    res.json({
        websocket: {
            state,
            url: SIDESWAP_MANAGER_WS_URL,
            connected: state === 'OPEN',
            last_heartbeat: lastHeartbeat ? new Date(lastHeartbeat).toISOString() : null,
            reconnect_attempts: reconnectAttempts,
            max_reconnect_attempts: CONFIG.MAX_RECONNECT_ATTEMPTS
        },
        requests: {
            inflight: inflightRequests.size,
            total: connectionStats.totalRequests,
            errors: connectionStats.totalErrors
        },
        connections: {
            total: connectionStats.totalConnections,
            disconnections: connectionStats.totalDisconnections
        },
        config: {
            request_timeout: CONFIG.REQUEST_TIMEOUT,
            reconnect_interval: CONFIG.RECONNECT_INTERVAL,
            log_level: CONFIG.LOG_LEVEL
        },
        uptime_seconds: uptime,
        timestamp: new Date().toISOString()
    });
});

app.post('/api/quote', async (req, res) => {
    try {
        const { send_asset, recv_asset, send_amount, receive_address, instant_swap = true } = req.body;
        
        // Validação detalhada dos parâmetros
        const validationErrors = validateQuoteParams(req.body);
        if (validationErrors.length > 0) {
            return res.status(400).json({
                error: 'Validation failed',
                details: validationErrors,
                timestamp: new Date().toISOString()
            });
        }
        
        // Verificar se o WebSocket está conectado
        if (!isWebSocketReady()) {
            return res.status(503).json({
                error: 'Service temporarily unavailable',
                message: 'WebSocket connection to SideSwap Manager is not ready',
                websocket_status: getConnectionState(),
                timestamp: new Date().toISOString()
            });
        }

        const quoteParams = {
            send_asset: send_asset.trim(),
            recv_asset: recv_asset.trim(),
            send_amount: parseFloat(send_amount),
            receive_address: receive_address.trim(),
            instant_swap: Boolean(instant_swap)
        };
        
        log('info', `Processing quote request: ${send_asset} -> ${recv_asset}, amount: ${send_amount}`);
        
        const startTime = Date.now();
        const quoteResponse = await sendWsRequest('GetQuote', quoteParams, {
            timeout: CONFIG.QUOTE_REQUEST_TIMEOUT,
            retries: CONFIG.QUOTE_RETRIES
        });
        
        const processingTime = Date.now() - startTime;
        log('info', `Quote request completed in ${processingTime}ms`);
        
        res.json({
            success: true,
            data: quoteResponse,
            processing_time_ms: processingTime,
            timestamp: new Date().toISOString()
        });
        
    } catch (e) {
        connectionStats.totalErrors++;
        log('error', 'Quote API error:', e.message);
        
        let statusCode = 500;
        let errorMessage = 'Internal server error';
        let errorDetails = null;
        
        if (e.message.includes('timeout')) {
            statusCode = 504;
            errorMessage = 'Request timeout';
        } else if (e.message.includes('not connected') || e.message.includes('not ready')) {
            statusCode = 503;
            errorMessage = 'Service unavailable';
        } else if (e.message.includes('Validation')) {
            statusCode = 400;
            errorMessage = 'Invalid request';
        }
        
        // Tentar extrair detalhes do erro do SideSwap Manager
        try {
            if (e.message.startsWith('{')) {
                errorDetails = JSON.parse(e.message);
            }
        } catch (parseError) {
            // Ignorar erro de parsing
        }
        
        res.status(statusCode).json({
            error: errorMessage,
            message: e.message,
            details: errorDetails,
            websocket_status: getConnectionState(),
            timestamp: new Date().toISOString()
        });
    }
});

// --- Endpoints Adicionais ---

// Endpoint para forçar reconexão
app.post('/api/reconnect', (req, res) => {
    if (wsClient) {
        log('info', 'Manual reconnection requested');
        wsClient.terminate();
    }
    
    reconnectAttempts = 0;
    setTimeout(() => {
        connectToSideSwapManager();
    }, 1000);
    
    res.json({
        message: 'Reconnection initiated',
        timestamp: new Date().toISOString()
    });
});

// Endpoint para limpar estatísticas
app.post('/api/reset-stats', (req, res) => {
    connectionStats = {
        totalConnections: 0,
        totalDisconnections: 0,
        totalRequests: 0,
        totalErrors: 0,
        uptime: Date.now()
    };
    
    log('info', 'Statistics reset');
    res.json({
        message: 'Statistics reset successfully',
        timestamp: new Date().toISOString()
    });
});

// Middleware de tratamento de erros global
app.use((err, req, res, next) => {
    connectionStats.totalErrors++;
    log('error', 'Unhandled error:', err.message);
    
    res.status(500).json({
        error: 'Internal server error',
        message: 'An unexpected error occurred',
        timestamp: new Date().toISOString()
    });
});

// Middleware para rotas não encontradas
app.use('*', (req, res) => {
    res.status(404).json({
        error: 'Not found',
        message: `Route ${req.method} ${req.originalUrl} not found`,
        timestamp: new Date().toISOString()
    });
});

// --- Funções de Limpeza e Manutenção ---

// Limpeza de requests que possam ter ficado presas
function cleanupStaleRequests() {
    const now = Date.now();
    let cleanedCount = 0;
    
    for (const [id, { timestamp, reject, timeoutId }] of inflightRequests) {
        if (now - timestamp > CONFIG.REQUEST_TIMEOUT + 5000) {
            log('warn', `Forcefully removing stale request ${id} from inflightRequests`);
            
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
            
            reject(new Error(`Request ${id} stale and removed`));
            inflightRequests.delete(id);
            cleanedCount++;
        }
    }
    
    if (cleanedCount > 0) {
        log('info', `Cleaned up ${cleanedCount} stale requests`);
    }
}

// Health check periódico
function performHealthCheck() {
    const now = Date.now();
    
    // Verificar se o heartbeat está muito antigo
    if (lastHeartbeat && (now - lastHeartbeat) > CONFIG.HEALTH_CHECK_INTERVAL * 2) {
        log('warn', 'WebSocket appears to be stale, forcing reconnection');
        if (wsClient) {
            wsClient.terminate();
        }
    }
    
    // Log de estatísticas periódicas
    if (CONFIG.LOG_LEVEL === 'debug') {
        log('debug', 'Health check stats:', {
            websocket_state: getConnectionState(),
            inflight_requests: inflightRequests.size,
            total_requests: connectionStats.totalRequests,
            total_errors: connectionStats.totalErrors,
            reconnect_attempts: reconnectAttempts
        });
    }
}

// Shutdown graceful
function gracefulShutdown(signal) {
    log('info', `Received ${signal}. Starting graceful shutdown...`);
    isShuttingDown = true;
    
    // Fechar servidor HTTP
    if (server) {
        server.close(() => {
            log('info', 'HTTP server closed');
        });
    }
    
    // Fechar conexão WebSocket
    if (wsClient) {
        wsClient.close(1000, 'Server shutting down');
    }
    
    // Rejeitar todas as requisições pendentes
    for (const [id, { reject, timeoutId }] of inflightRequests) {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
        reject(new Error('Server is shutting down'));
    }
    inflightRequests.clear();
    
    log('info', 'Graceful shutdown completed');
    process.exit(0);
}

// --- Inicialização do Servidor ---

const server = app.listen(CONFIG.HTTP_PORT, () => {
    log('info', `SideSwap Bridge HTTP server listening on port ${CONFIG.HTTP_PORT}`);
    log('info', `Environment: ${process.env.NODE_ENV || 'development'}`);
    log('info', `Log level: ${CONFIG.LOG_LEVEL}`);
    log('info', `WebSocket URL: ${SIDESWAP_MANAGER_WS_URL}`);
    
    // Iniciar conexão WebSocket
    connectToSideSwapManager();
});

// Configurar intervalos de manutenção
setInterval(cleanupStaleRequests, 60000); // A cada minuto
setInterval(performHealthCheck, CONFIG.HEALTH_CHECK_INTERVAL); // Conforme configuração

// Configurar handlers de shutdown
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGUSR2', () => gracefulShutdown('SIGUSR2')); // Para nodemon

// Tratamento de erros não capturados
process.on('uncaughtException', (err) => {
    log('error', 'Uncaught Exception:', err.message);
    log('error', err.stack);
    gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
    log('error', 'Unhandled Rejection at:', promise, 'reason:', reason);
    // Não fazer shutdown automático para unhandled rejections, apenas logar
});

log('info', 'SideSwap Bridge v2.0.0 initialized successfully');
