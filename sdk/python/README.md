# Vienna OS Python SDK

The execution kernel for AI agents. Agents propose. Vienna decides.

## Install

```bash
pip install vienna-os
```

## Quick Start

```python
from vienna_os import ViennaClient

client = ViennaClient(
    base_url="https://console.regulator.ai",
    agent_id="my-agent",
    api_key="vos_..."
)

# Submit an intent through the governance pipeline
result = client.submit_intent(
    action="deploy",
    payload={"service": "api-gateway", "version": "v2.4.1"}
)

if result.pipeline == "executed":
    print(f"Warrant: {result.warrant.id}")
```

## Documentation

- [Getting Started](https://regulator.ai/docs/getting-started)
- [API Reference](https://regulator.ai/docs/api-reference)
- [GitHub](https://github.com/risk-ai/vienna-os)

## License

BSL-1.1
