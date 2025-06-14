# SideSwap Bridge v2.0.0

Um bridge HTTP robusto e seguro para a API WebSocket do SideSwap Manager, com recursos avançados de monitoramento, segurança e confiabilidade.

## 🚀 Características

### Segurança
- **Helmet.js**: Proteção contra vulnerabilidades comuns
- **CORS**: Configuração flexível de Cross-Origin Resource Sharing
- **Rate Limiting**: Proteção contra ataques de força bruta
- **Validação de entrada**: Validação rigorosa de parâmetros

### Confiabilidade
- **Reconexão automática**: Reconexão inteligente com backoff exponencial
- **Timeout configurável**: Controle de timeout para requisições
- **Retry automático**: Sistema de retry com backoff para requisições falhadas
- **Health checks**: Monitoramento contínuo da saúde da conexão
- **Graceful shutdown**: Encerramento limpo do servidor

### Monitoramento
- **Logging estruturado**: Sistema de logs com níveis configuráveis
- **Métricas detalhadas**: Estatísticas de conexão e performance
- **Endpoints de status**: APIs para monitoramento da saúde do sistema
- **Limpeza automática**: Remoção automática de requisições obsoletas

## 📋 Pré-requisitos

- Node.js >= 16.0.0
- SideSwap Manager rodando e acessível via WebSocket

## 🛠️ Instalação

1. Clone ou baixe os arquivos do projeto
2. Instale as dependências:

```bash
npm install
```

## ⚙️ Configuração

O servidor pode ser configurado através de variáveis de ambiente:

```bash
# Configurações do servidor HTTP
HTTP_PORT=3000
HTTP_HOST=0.0.0.0

# Configurações do WebSocket
SIDESWAP_WS_HOST=127.0.0.1
SIDESWAP_WS_PORT=54321

# Configurações de timeout e retry
REQUEST_TIMEOUT=30000
MAX_RETRIES=3
RETRY_DELAY=1000

# Configurações de reconexão
RECONNECT_INTERVAL=5000
MAX_RECONNECT_ATTEMPTS=10

# Configurações de monitoramento
HEALTH_CHECK_INTERVAL=30000
LOG_LEVEL=info

# Configurações de rate limiting
RATE_LIMIT_WINDOW=900000
RATE_LIMIT_MAX=100
```

### Configuração via CLI (alternativa)

Você também pode configurar o servidor diretamente via linha de comando:

```bash
# Configuração básica
node server.js --port=3000 --ws-host=127.0.0.1 --ws-port=54321

# Configuração completa
node server.js \
  --port=3000 \
  --host=0.0.0.0 \
  --ws-host=127.0.0.1 \
  --ws-port=54321 \
  --request-timeout=30000 \
  --max-retries=3 \
  --retry-delay=1000 \
  --reconnect-interval=5000 \
  --max-reconnect-attempts=10 \
  --health-check-interval=30000 \
  --log-level=info \
  --rate-limit-window=900000 \
  --rate-limit-max=100

# Exemplo com configuração mista (CLI + variáveis de ambiente)
PORT=3000 node server.js --ws-host=192.168.1.100 --log-level=debug
```

**Nota:** As configurações via CLI têm prioridade sobre as variáveis de ambiente.

## 🚀 Uso

### Desenvolvimento
```bash
npm run dev
```

### Produção
```bash
npm start
```

## 📡 API Endpoints

### GET `/`
Informações básicas do serviço

**Resposta:**
```json
{
  "service": "SideSwap Bridge",
  "version": "2.0.0",
  "status": "running",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### GET `/health`
Verificação da saúde da conexão WebSocket

**Resposta:**
```json
{
  "status": "healthy",
  "websocket": {
    "connected": true,
    "state": "OPEN",
    "last_heartbeat": "2024-01-01T00:00:00.000Z"
  },
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### GET `/api/status`
Estatísticas detalhadas do sistema

**Resposta:**
```json
{
  "websocket": {
    "connected": true,
    "state": "OPEN",
    "reconnect_attempts": 0,
    "last_heartbeat": "2024-01-01T00:00:00.000Z"
  },
  "requests": {
    "inflight": 0,
    "total": 150,
    "errors": 2
  },
  "connection_stats": {
    "total_connections": 5,
    "total_disconnections": 4,
    "uptime_ms": 3600000
  },
  "config": {
    "request_timeout": 30000,
    "max_retries": 3,
    "log_level": "info"
  },
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### POST `/api/quote`
Obter cotação do SideSwap Manager

**Parâmetros:**
```json
{
  "send_asset": "btc",
  "recv_asset": "usdt",
  "send_amount": 100000,
  "recv_amount": null
}
```

**Resposta de sucesso:**
```json
{
  "send_asset": "btc",
  "recv_asset": "usdt",
  "send_amount": 100000,
  "recv_amount": 4350000,
  "price": 43500,
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

**Resposta de erro:**
```json
{
  "error": "Invalid parameters",
  "message": "send_asset is required",
  "details": {
    "field": "send_asset",
    "received": null,
    "expected": "string"
  },
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### POST `/api/reconnect`
Forçar reconexão do WebSocket

**Resposta:**
```json
{
  "message": "Reconnection initiated",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### POST `/api/reset-stats`
Limpar estatísticas do sistema

**Resposta:**
```json
{
  "message": "Statistics reset successfully",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

## 🔧 Códigos de Status HTTP

- **200**: Sucesso
- **400**: Parâmetros inválidos
- **404**: Rota não encontrada
- **429**: Rate limit excedido
- **500**: Erro interno do servidor
- **503**: Serviço indisponível (WebSocket desconectado)
- **504**: Timeout da requisição

## 📊 Logging

O sistema utiliza logging estruturado com os seguintes níveis:

- **error**: Erros críticos
- **warn**: Avisos importantes
- **info**: Informações gerais (padrão)
- **debug**: Informações detalhadas para debugging

Exemplo de log:
```
[2024-01-01T00:00:00.000Z] INFO: WebSocket connected to SideSwap Manager
[2024-01-01T00:00:00.000Z] DEBUG: Received quote response: {"id":"123","result":{...}}
[2024-01-01T00:00:00.000Z] WARN: WebSocket connection lost, attempting reconnection...
[2024-01-01T00:00:00.000Z] ERROR: Failed to connect after 10 attempts
```

## 🛡️ Segurança

### Rate Limiting
Por padrão, o servidor limita a 100 requisições por 15 minutos por IP.

### CORS
Configurado para aceitar requisições de qualquer origem em desenvolvimento. Para produção, configure adequadamente:

```javascript
app.use(cors({
    origin: ['https://yourdomain.com'],
    credentials: true
}));
```

### Helmet
Proteções ativadas:
- Content Security Policy
- DNS Prefetch Control
- Frame Guard
- Hide Powered-By
- HSTS
- IE No Open
- No Sniff
- Referrer Policy
- XSS Filter

## 🔄 Tratamento de Erros

### Reconexão Automática
- Backoff exponencial: 5s, 10s, 20s, 40s...
- Máximo de 10 tentativas por padrão
- Reset do contador após conexão bem-sucedida

### Timeout e Retry
- Timeout padrão de 30 segundos
- Máximo de 3 tentativas por requisição
- Backoff entre tentativas: 1s, 2s, 4s

### Graceful Shutdown
- Captura sinais SIGTERM, SIGINT, SIGUSR2
- Fecha conexões ativas graciosamente
- Rejeita requisições pendentes
- Limpa recursos antes de encerrar

## 📈 Monitoramento

### Health Checks
- Verificação periódica da conexão WebSocket
- Detecção de conexões obsoletas
- Reconexão automática quando necessário

### Métricas
- Total de conexões/desconexões
- Número de requisições e erros
- Tempo de atividade
- Requisições em andamento

### Limpeza Automática
- Remoção de requisições obsoletas a cada minuto
- Limpeza de timeouts não utilizados
- Prevenção de vazamentos de memória

## 🐛 Troubleshooting

### WebSocket não conecta
1. Verifique se o SideSwap Manager está rodando
2. Confirme o host e porta do WebSocket
3. Verifique logs para erros de conexão

### Rate limit atingido
1. Ajuste `RATE_LIMIT_MAX` e `RATE_LIMIT_WINDOW`
2. Implemente autenticação para limites maiores
3. Use `/api/reset-stats` para limpar contadores

### Timeouts frequentes
1. Aumente `REQUEST_TIMEOUT`
2. Verifique latência da rede
3. Monitore logs do SideSwap Manager

### Alto uso de memória
1. Verifique requisições em andamento em `/api/status`
2. Reduza `REQUEST_TIMEOUT` se necessário
3. Monitore limpeza automática nos logs

## 📝 Changelog

### v2.0.0
- ✨ Sistema de logging estruturado
- 🔒 Middlewares de segurança (Helmet, CORS, Rate Limiting)
- 🔄 Reconexão automática com backoff exponencial
- ⏱️ Sistema de timeout e retry configurável
- 📊 Endpoints de monitoramento e estatísticas
- 🛡️ Validação rigorosa de parâmetros
- 🧹 Limpeza automática de recursos
- 🚪 Graceful shutdown
- 💚 Health checks periódicos
- 📈 Métricas detalhadas de performance

## 📄 Licença

MIT License - veja o arquivo LICENSE para detalhes.

## 🤝 Contribuição

1. Fork o projeto
2. Crie uma branch para sua feature (`git checkout -b feature/AmazingFeature`)
3. Commit suas mudanças (`git commit -m 'Add some AmazingFeature'`)
4. Push para a branch (`git push origin feature/AmazingFeature`)
5. Abra um Pull Request

## 📞 Suporte

Para suporte, abra uma issue no repositório ou entre em contato através do email.
