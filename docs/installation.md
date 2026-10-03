# Installation & Running

## Prerequisites

- **Node.js**: `v24.0.0` or higher
- **Browser Extension**: [Freighter Wallet](https://www.freighter.app/) configured for **Testnet**

## Setup

```bash
git clone https://github.com/aigbagbobila/stellar-agent-guard-dashboard.git
cd stellar-agent-guard-dashboard
npm ci
npm run dev
```

Navigate to `http://localhost:3000`. Connect Freighter to interact with testnet instances.

## Development Commands

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm test             # unit tests (175 passing tests)
npm run build        # production build
npm run inspect      # inspect deployed instance
```
