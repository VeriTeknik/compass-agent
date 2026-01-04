# Compass Agent - AI Jury/Oracle

Multi-AI consensus agent for trusted research. Compass queries multiple AI models (GPT-4, Claude, Gemini) and synthesizes their responses into a verdict with confidence scoring.

**PAP-RFC-001 Compliant** | First reference implementation of a PAP agent.

## Features

- **Multi-Model Querying**: Query multiple AI models in parallel
- **Consensus Calculation**: Semantic similarity-based agreement scoring
- **Verdict Types**: Unanimous, Split, or No Consensus
- **Shareable Reports**: Twitter-optimized and Markdown formats
- **PAP Telemetry**: Heartbeat/metrics separation (zombie prevention)

## Quick Start

### Environment Variables

```bash
# PAP Station connection
PAP_STATION_URL=https://plugged.in
PAP_AGENT_ID=your-agent-id
PAP_AGENT_KEY=your-agent-key

# Model Router (pluggedin-app API)
PLUGGEDIN_API_URL=https://api.plugged.in
PLUGGEDIN_API_KEY=your-api-key

# Server
PORT=3000
BASE_URL=https://compass.plugged.in
```

### Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build for production
npm run build

# Run production build
npm start
```

### Docker

```bash
# Build image
docker build -t compass-agent .

# Run container
docker run -p 3000:3000 \
  -e PAP_STATION_URL=https://plugged.in \
  -e PAP_AGENT_ID=compass \
  -e PLUGGEDIN_API_URL=https://api.plugged.in \
  -e PLUGGEDIN_API_KEY=your-key \
  compass-agent
```

## API Endpoints

### Query - Execute AI Jury Query

```bash
POST /query
Content-Type: application/json

{
  "question": "What is the best programming language for web development?",
  "context": "Consider modern frameworks and ecosystem",
  "models": ["gpt-4o", "claude-sonnet-4-20250514", "gemini-2.0-flash"],
  "format": "json"
}
```

**Response**:

```json
{
  "id": "uuid",
  "question": "What is the best...",
  "verdict": "split",
  "confidence": "medium",
  "agreementScore": 0.75,
  "consensusAnswer": "JavaScript/TypeScript with React...",
  "responses": [
    { "model": "gpt-4o", "answer": "..." },
    { "model": "claude-sonnet-4-20250514", "answer": "..." },
    { "model": "gemini-2.0-flash", "answer": "..." }
  ],
  "dissent": {
    "model": "gemini-2.0-flash",
    "answer": "..."
  },
  "shareableUrl": "https://compass.plugged.in/v/uuid"
}
```

### Health - PAP Health Check

```bash
GET /health
```

### Status - Agent Status

```bash
GET /status
```

### Models - List Available Models

```bash
GET /models
```

### Metrics - Prometheus Metrics

```bash
GET /metrics
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    COMPASS AGENT (PAP Satellite)                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    QUERY PROCESSOR                        │   │
│  │  ┌───────────┐  ┌───────────┐  ┌───────────┐           │   │
│  │  │  GPT-4o   │  │  Claude   │  │  Gemini   │           │   │
│  │  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘           │   │
│  │        │              │              │                    │   │
│  │        └──────────────┼──────────────┘                    │   │
│  │                       ▼                                   │   │
│  │              ┌───────────────┐                            │   │
│  │              │  CONSENSUS    │                            │   │
│  │              │    ENGINE     │                            │   │
│  │              └───────┬───────┘                            │   │
│  │                      ▼                                    │   │
│  │              ┌───────────────┐                            │   │
│  │              │   VERDICT     │                            │   │
│  │              │   FORMATTER   │                            │   │
│  │              └───────────────┘                            │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                   PAP TELEMETRY                           │   │
│  │  ┌───────────┐              ┌───────────┐                │   │
│  │  │ HEARTBEAT │              │  METRICS  │                │   │
│  │  │ (30s IDLE)│              │(60s cycle)│                │   │
│  │  └───────────┘              └───────────┘                │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## PAP Compliance

This agent follows PAP-RFC-001 specifications:

### Heartbeat (Liveness Only)
- Sent every 30 seconds (IDLE mode)
- Contains ONLY: `mode` and `uptime_seconds`
- NO resource data (CPU, memory)

### Metrics (Separate Channel)
- Sent every 60 seconds
- Contains: CPU, memory, request counts, custom metrics
- Completely separate from heartbeats

### Lifecycle States
```
NEW → PROVISIONED → ACTIVE ↔ DRAINING → TERMINATED
                       ↓ (error)
                     KILLED
```

## Verdict Types

| Verdict | Agreement Score | Confidence | Description |
|---------|-----------------|------------|-------------|
| `unanimous` | ≥ 0.9 | High | All models agree |
| `split` | ≥ 0.6, < 0.9 | Medium | Majority agrees |
| `no_consensus` | < 0.6 | Low | Significant disagreement |

## License

MIT License - Plugged.in
