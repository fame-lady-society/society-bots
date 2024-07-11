## Events we are listening for:

### Uniswap v2

**topic**: `0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822`

```
event Swap(
  address indexed sender,
  uint amount0In,
  uint amount1In,
  uint amount0Out,
  uint amount1Out,
  address indexed to
);
```

ref: https://docs.uniswap.org/contracts/v2/reference/smart-contracts/pair#swap

### Uniswap v3

**topic**: `0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67`

```
  event Swap(
    address sender,
    address recipient,
    int256 amount0,
    int256 amount1,
    uint160 sqrtPriceX96,
    uint128 liquidity,
    int24 tick
  )
```

ref: https://docs.uniswap.org/contracts/v3/reference/core/interfaces/pool/IUniswapV3PoolEvents#swap

### Example webhook response from alchemy

```
{
  "webhookId": "wh_hw262frqbexzvwak",
  "id": "whevt_v07jyy79uu028eu0",
  "createdAt": "2024-07-07T04:01:03.900Z",
  "type": "GRAPHQL",
  "event": {
    "data": {
      "block": {
        "logs": [
          {
            "data": "0x00000000000000000000000000000000000000000000000000038d7ea4c68000fffffffffffffffffffffffffffffffffffffffffff3eae1fe86b60b1142812c000000000000000000000000000000000001d8b5e96be4eb3c55162bb9886ff7000000000000000000000000000000000000000000003a5125457b98ed3c96c30000000000000000000000000000000000000000000000000000000000039264",
            "transaction": {
              "hash": "0x489302f2ee857f94c1bd03161219f6df46fd5d57e0e64b4b4621cd5f15732aec",
              "from": {
                "address": "0x6e76967c1a78c516b6e8c96ffe6b1b884398a937"
              },
              "to": {
                "address": "0x3bfa4769fb09eefc5a80d6e87c3b9c650f7ae48e"
              },
              "logs": [
                {
                  "account": {
                    "address": "0xf661af827b0e89bf24b933a12da44f411abaed56"
                  },
                  "data": "0x",
                  "topics": [
                    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                    "0x0000000000000000000000000000000000000000000000000000000000000000",
                    "0x0000000000000000000000006e76967c1a78c516b6e8c96ffe6b1b884398a937",
                    "0x000000000000000000000000000000000000000000000000000000000000004f"
                  ]
                },
                {
                  "account": {
                    "address": "0xf661af827b0e89bf24b933a12da44f411abaed56"
                  },
                  "data": "0x",
                  "topics": [
                    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                    "0x0000000000000000000000000000000000000000000000000000000000000000",
                    "0x0000000000000000000000006e76967c1a78c516b6e8c96ffe6b1b884398a937",
                    "0x0000000000000000000000000000000000000000000000000000000000000050"
                  ]
                },
                {
                  "account": {
                    "address": "0xf661af827b0e89bf24b933a12da44f411abaed56"
                  },
                  "data": "0x",
                  "topics": [
                    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                    "0x0000000000000000000000000000000000000000000000000000000000000000",
                    "0x0000000000000000000000006e76967c1a78c516b6e8c96ffe6b1b884398a937",
                    "0x0000000000000000000000000000000000000000000000000000000000000051"
                  ]
                },
                {
                  "account": {
                    "address": "0xf661af827b0e89bf24b933a12da44f411abaed56"
                  },
                  "data": "0x",
                  "topics": [
                    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                    "0x0000000000000000000000000000000000000000000000000000000000000000",
                    "0x0000000000000000000000006e76967c1a78c516b6e8c96ffe6b1b884398a937",
                    "0x0000000000000000000000000000000000000000000000000000000000000052"
                  ]
                },
                {
                  "account": {
                    "address": "0xf661af827b0e89bf24b933a12da44f411abaed56"
                  },
                  "data": "0x",
                  "topics": [
                    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                    "0x0000000000000000000000000000000000000000000000000000000000000000",
                    "0x0000000000000000000000006e76967c1a78c516b6e8c96ffe6b1b884398a937",
                    "0x0000000000000000000000000000000000000000000000000000000000000053"
                  ]
                },
                {
                  "account": {
                    "address": "0xf661af827b0e89bf24b933a12da44f411abaed56"
                  },
                  "data": "0x",
                  "topics": [
                    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                    "0x0000000000000000000000000000000000000000000000000000000000000000",
                    "0x0000000000000000000000006e76967c1a78c516b6e8c96ffe6b1b884398a937",
                    "0x0000000000000000000000000000000000000000000000000000000000000054"
                  ]
                },
                {
                  "account": {
                    "address": "0xf661af827b0e89bf24b933a12da44f411abaed56"
                  },
                  "data": "0x",
                  "topics": [
                    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                    "0x0000000000000000000000000000000000000000000000000000000000000000",
                    "0x0000000000000000000000006e76967c1a78c516b6e8c96ffe6b1b884398a937",
                    "0x0000000000000000000000000000000000000000000000000000000000000055"
                  ]
                },
                {
                  "account": {
                    "address": "0xf661af827b0e89bf24b933a12da44f411abaed56"
                  },
                  "data": "0x",
                  "topics": [
                    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                    "0x0000000000000000000000000000000000000000000000000000000000000000",
                    "0x0000000000000000000000006e76967c1a78c516b6e8c96ffe6b1b884398a937",
                    "0x0000000000000000000000000000000000000000000000000000000000000056"
                  ]
                },
                {
                  "account": {
                    "address": "0xf661af827b0e89bf24b933a12da44f411abaed56"
                  },
                  "data": "0x",
                  "topics": [
                    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                    "0x0000000000000000000000000000000000000000000000000000000000000000",
                    "0x0000000000000000000000006e76967c1a78c516b6e8c96ffe6b1b884398a937",
                    "0x0000000000000000000000000000000000000000000000000000000000000057"
                  ]
                },
                {
                  "account": {
                    "address": "0xf661af827b0e89bf24b933a12da44f411abaed56"
                  },
                  "data": "0x",
                  "topics": [
                    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                    "0x0000000000000000000000000000000000000000000000000000000000000000",
                    "0x0000000000000000000000006e76967c1a78c516b6e8c96ffe6b1b884398a937",
                    "0x0000000000000000000000000000000000000000000000000000000000000058"
                  ]
                },
                {
                  "account": {
                    "address": "0xf661af827b0e89bf24b933a12da44f411abaed56"
                  },
                  "data": "0x",
                  "topics": [
                    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                    "0x0000000000000000000000000000000000000000000000000000000000000000",
                    "0x0000000000000000000000006e76967c1a78c516b6e8c96ffe6b1b884398a937",
                    "0x0000000000000000000000000000000000000000000000000000000000000059"
                  ]
                },
                {
                  "account": {
                    "address": "0xf661af827b0e89bf24b933a12da44f411abaed56"
                  },
                  "data": "0x",
                  "topics": [
                    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                    "0x0000000000000000000000000000000000000000000000000000000000000000",
                    "0x0000000000000000000000006e76967c1a78c516b6e8c96ffe6b1b884398a937",
                    "0x000000000000000000000000000000000000000000000000000000000000005a"
                  ]
                },
                {
                  "account": {
                    "address": "0xf661af827b0e89bf24b933a12da44f411abaed56"
                  },
                  "data": "0x",
                  "topics": [
                    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                    "0x0000000000000000000000000000000000000000000000000000000000000000",
                    "0x0000000000000000000000006e76967c1a78c516b6e8c96ffe6b1b884398a937",
                    "0x000000000000000000000000000000000000000000000000000000000000005b"
                  ]
                },
                {
                  "account": {
                    "address": "0xf661af827b0e89bf24b933a12da44f411abaed56"
                  },
                  "data": "0x",
                  "topics": [
                    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                    "0x0000000000000000000000000000000000000000000000000000000000000000",
                    "0x0000000000000000000000006e76967c1a78c516b6e8c96ffe6b1b884398a937",
                    "0x000000000000000000000000000000000000000000000000000000000000005c"
                  ]
                },
                {
                  "account": {
                    "address": "0xead0b62deced7d0e56e4e3b13e246e183278caee"
                  },
                  "data": "0x0000000000000000000000000000000000000000000c151e017949f4eebd7ed4",
                  "topics": [
                    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                    "0x0000000000000000000000006261bc8dc29cfadb1edeeb1dee9114d876dbfcd5",
                    "0x0000000000000000000000006e76967c1a78c516b6e8c96ffe6b1b884398a937"
                  ]
                },
                {
                  "account": {
                    "address": "0x7b79995e5f793a07bc00c21412e50ecae098e7f9"
                  },
                  "data": "0x00000000000000000000000000000000000000000000000000038d7ea4c68000",
                  "topics": [
                    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                    "0x0000000000000000000000006e76967c1a78c516b6e8c96ffe6b1b884398a937",
                    "0x0000000000000000000000006261bc8dc29cfadb1edeeb1dee9114d876dbfcd5"
                  ]
                },
                {
                  "account": {
                    "address": "0x6261bc8dc29cfadb1edeeb1dee9114d876dbfcd5"
                  },
                  "data": "0x00000000000000000000000000000000000000000000000000038d7ea4c68000fffffffffffffffffffffffffffffffffffffffffff3eae1fe86b60b1142812c000000000000000000000000000000000001d8b5e96be4eb3c55162bb9886ff7000000000000000000000000000000000000000000003a5125457b98ed3c96c30000000000000000000000000000000000000000000000000000000000039264",
                  "topics": [
                    "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67",
                    "0x0000000000000000000000003bfa4769fb09eefc5a80d6e87c3b9c650f7ae48e",
                    "0x0000000000000000000000006e76967c1a78c516b6e8c96ffe6b1b884398a937"
                  ]
                }
              ],
              "type": 2,
              "status": 1
            }
          }
        ]
      }
    },
    "sequenceNumber": "10000000098854763006"
  }
}
```
