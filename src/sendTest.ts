import "dotenv/config";
import handler from "./webhook/swap/handler.js";

handler({
  disableTelegram: true,
  destination: Number(process.env.TESTING_CHAT_ID) || 0,
  event: {
    data: {
      block: {
        logs: [
          {
            data: "0x00000000000000000000000000000000000000000000000002aa5ff3080526b5000000000000000000000000000000000000000000356c22205f933cd66e947a",
            topics: [
              "0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1",
            ],
            transaction: {
              hash: "0x48efa433dd9de7118d111a025fd11e29f2ae6803fc4fa32946d3aeb0c72831b2",
              from: {
                address: "0x90348e325bc286c7b7c1ec575cbb775b4b1903f0",
              },
              to: {
                address: "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
              },
              logs: [
                {
                  account: {
                    address: "0x4200000000000000000000000000000000000006",
                  },
                  data: "0x00000000000000000000000000000000000000000000000000038d7ea4c68000",
                  topics: [
                    "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c",
                    "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
                  ],
                },
                {
                  account: {
                    address: "0x4200000000000000000000000000000000000006",
                  },
                  data: "0x00000000000000000000000000000000000000000000000000027ca57357c000",
                  topics: [
                    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                    "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
                    "0x0000000000000000000000006dbf04dbfedc9aaf4eba14bab51e9a4298340c01",
                  ],
                },
                {
                  account: {
                    address: "0xea372c317c9965bfc06ff15d3f049b31787c550d",
                  },
                  data: "0x0000000000000000000000000000000000000000000031dfe5bab0487d5cde76",
                  topics: [
                    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                    "0x0000000000000000000000006dbf04dbfedc9aaf4eba14bab51e9a4298340c01",
                    "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
                  ],
                },
                {
                  account: {
                    address: "0x6dbf04dbfedc9aaf4eba14bab51e9a4298340c01",
                  },
                  data: "0x00000000000000000000000000000000000000000000000002aa5ff3080526b5000000000000000000000000000000000000000000356c22205f933cd66e947a",
                  topics: [
                    "0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1",
                  ],
                },
                {
                  account: {
                    address: "0x6dbf04dbfedc9aaf4eba14bab51e9a4298340c01",
                  },
                  data: "0x00000000000000000000000000000000000000000000000000027ca57357c000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000031dfe5bab0487d5cde76",
                  topics: [
                    "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822",
                    "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
                    "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
                  ],
                },
                {
                  account: {
                    address: "0xea372c317c9965bfc06ff15d3f049b31787c550d",
                  },
                  data: "0x00000000000000000000000000000000000000000000155fb4eb6a46edc16f7e",
                  topics: [
                    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                    "0x00000000000000000000000004b41fe46e8685719ac40101fc6478682256bc6f",
                    "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
                  ],
                },
                {
                  account: {
                    address: "0x4200000000000000000000000000000000000006",
                  },
                  data: "0x000000000000000000000000000000000000000000000000000110d9316ec000",
                  topics: [
                    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                    "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
                    "0x00000000000000000000000004b41fe46e8685719ac40101fc6478682256bc6f",
                  ],
                },
                {
                  account: {
                    address: "0x04b41fe46e8685719ac40101fc6478682256bc6f",
                  },
                  data: "0x000000000000000000000000000000000000000000000000000110d9316ec000ffffffffffffffffffffffffffffffffffffffffffffeaa04b1495b9123e908200000000000000000000000000000000000047a0303f63c37270191196a63125000000000000000000000000000000000000000000000050726e80cf50481db4000000000000000000000000000000000000000000000000000000000002fef6",
                  topics: [
                    "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67",
                    "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
                    "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
                  ],
                },
                {
                  account: {
                    address: "0xea372c317c9965bfc06ff15d3f049b31787c550d",
                  },
                  data: "0x00000000000000000000000000000000000000000000002d9958bc39f5634698",
                  topics: [
                    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                    "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
                    "0x0000000000000000000000005d64d14d2cf4fe5fe4e65b1c7e3d11e18d493091",
                  ],
                },
                {
                  account: {
                    address: "0xea372c317c9965bfc06ff15d3f049b31787c550d",
                  },
                  data: "0x000000000000000000000000000000000000000000004712014d5e5575bb075c",
                  topics: [
                    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                    "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
                    "0x00000000000000000000000090348e325bc286c7b7c1ec575cbb775b4b1903f0",
                  ],
                },
              ],
              type: 2,
              status: 1,
            },
          },
          {
            data: "0x00000000000000000000000000000000000000000000000000027ca57357c000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000031dfe5bab0487d5cde76",
            topics: [
              "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822",
              "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
              "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
            ],
            transaction: {
              hash: "0x48efa433dd9de7118d111a025fd11e29f2ae6803fc4fa32946d3aeb0c72831b2",
              from: {
                address: "0x90348e325bc286c7b7c1ec575cbb775b4b1903f0",
              },
              to: {
                address: "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
              },
              logs: [
                {
                  account: {
                    address: "0x4200000000000000000000000000000000000006",
                  },
                  data: "0x00000000000000000000000000000000000000000000000000038d7ea4c68000",
                  topics: [
                    "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c",
                    "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
                  ],
                },
                {
                  account: {
                    address: "0x4200000000000000000000000000000000000006",
                  },
                  data: "0x00000000000000000000000000000000000000000000000000027ca57357c000",
                  topics: [
                    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                    "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
                    "0x0000000000000000000000006dbf04dbfedc9aaf4eba14bab51e9a4298340c01",
                  ],
                },
                {
                  account: {
                    address: "0xea372c317c9965bfc06ff15d3f049b31787c550d",
                  },
                  data: "0x0000000000000000000000000000000000000000000031dfe5bab0487d5cde76",
                  topics: [
                    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                    "0x0000000000000000000000006dbf04dbfedc9aaf4eba14bab51e9a4298340c01",
                    "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
                  ],
                },
                {
                  account: {
                    address: "0x6dbf04dbfedc9aaf4eba14bab51e9a4298340c01",
                  },
                  data: "0x00000000000000000000000000000000000000000000000002aa5ff3080526b5000000000000000000000000000000000000000000356c22205f933cd66e947a",
                  topics: [
                    "0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1",
                  ],
                },
                {
                  account: {
                    address: "0x6dbf04dbfedc9aaf4eba14bab51e9a4298340c01",
                  },
                  data: "0x00000000000000000000000000000000000000000000000000027ca57357c000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000031dfe5bab0487d5cde76",
                  topics: [
                    "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822",
                    "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
                    "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
                  ],
                },
                {
                  account: {
                    address: "0xea372c317c9965bfc06ff15d3f049b31787c550d",
                  },
                  data: "0x00000000000000000000000000000000000000000000155fb4eb6a46edc16f7e",
                  topics: [
                    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                    "0x00000000000000000000000004b41fe46e8685719ac40101fc6478682256bc6f",
                    "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
                  ],
                },
                {
                  account: {
                    address: "0x4200000000000000000000000000000000000006",
                  },
                  data: "0x000000000000000000000000000000000000000000000000000110d9316ec000",
                  topics: [
                    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                    "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
                    "0x00000000000000000000000004b41fe46e8685719ac40101fc6478682256bc6f",
                  ],
                },
                {
                  account: {
                    address: "0x04b41fe46e8685719ac40101fc6478682256bc6f",
                  },
                  data: "0x000000000000000000000000000000000000000000000000000110d9316ec000ffffffffffffffffffffffffffffffffffffffffffffeaa04b1495b9123e908200000000000000000000000000000000000047a0303f63c37270191196a63125000000000000000000000000000000000000000000000050726e80cf50481db4000000000000000000000000000000000000000000000000000000000002fef6",
                  topics: [
                    "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67",
                    "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
                    "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
                  ],
                },
                {
                  account: {
                    address: "0xea372c317c9965bfc06ff15d3f049b31787c550d",
                  },
                  data: "0x00000000000000000000000000000000000000000000002d9958bc39f5634698",
                  topics: [
                    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                    "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
                    "0x0000000000000000000000005d64d14d2cf4fe5fe4e65b1c7e3d11e18d493091",
                  ],
                },
                {
                  account: {
                    address: "0xea372c317c9965bfc06ff15d3f049b31787c550d",
                  },
                  data: "0x000000000000000000000000000000000000000000004712014d5e5575bb075c",
                  topics: [
                    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                    "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
                    "0x00000000000000000000000090348e325bc286c7b7c1ec575cbb775b4b1903f0",
                  ],
                },
              ],
              type: 2,
              status: 1,
            },
          },
          {
            data: "0x000000000000000000000000000000000000000000000000000110d9316ec000ffffffffffffffffffffffffffffffffffffffffffffeaa04b1495b9123e908200000000000000000000000000000000000047a0303f63c37270191196a63125000000000000000000000000000000000000000000000050726e80cf50481db4000000000000000000000000000000000000000000000000000000000002fef6",
            topics: [
              "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67",
              "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
              "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
            ],
            transaction: {
              hash: "0x48efa433dd9de7118d111a025fd11e29f2ae6803fc4fa32946d3aeb0c72831b2",
              from: {
                address: "0x90348e325bc286c7b7c1ec575cbb775b4b1903f0",
              },
              to: {
                address: "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
              },
              logs: [
                {
                  account: {
                    address: "0x91d7950ac7ccb369589765e31d6d8996321556de",
                  },
                  data: "0x",
                  topics: [
                    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                    "0x0000000000000000000000000000000000000000000000000000000000000000",
                    "0x00000000000000000000000090348e325bc286c7b7c1ec575cbb775b4b1903f0",
                    "0x0000000000000000000000000000000000000000000000000000000000000180",
                  ],
                },
                {
                  account: {
                    address: "0x4200000000000000000000000000000000000006",
                  },
                  data: "0x00000000000000000000000000000000000000000000000000038d7ea4c68000",
                  topics: [
                    "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c",
                    "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
                  ],
                },
                {
                  account: {
                    address: "0x4200000000000000000000000000000000000006",
                  },
                  data: "0x00000000000000000000000000000000000000000000000000027ca57357c000",
                  topics: [
                    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                    "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
                    "0x0000000000000000000000006dbf04dbfedc9aaf4eba14bab51e9a4298340c01",
                  ],
                },
                {
                  account: {
                    address: "0xea372c317c9965bfc06ff15d3f049b31787c550d",
                  },
                  data: "0x0000000000000000000000000000000000000000000031dfe5bab0487d5cde76",
                  topics: [
                    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                    "0x0000000000000000000000006dbf04dbfedc9aaf4eba14bab51e9a4298340c01",
                    "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
                  ],
                },
                {
                  account: {
                    address: "0x6dbf04dbfedc9aaf4eba14bab51e9a4298340c01",
                  },
                  data: "0x00000000000000000000000000000000000000000000000002aa5ff3080526b5000000000000000000000000000000000000000000356c22205f933cd66e947a",
                  topics: [
                    "0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1",
                  ],
                },
                {
                  account: {
                    address: "0x6dbf04dbfedc9aaf4eba14bab51e9a4298340c01",
                  },
                  data: "0x00000000000000000000000000000000000000000000000000027ca57357c000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000031dfe5bab0487d5cde76",
                  topics: [
                    "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822",
                    "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
                    "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
                  ],
                },
                {
                  account: {
                    address: "0xea372c317c9965bfc06ff15d3f049b31787c550d",
                  },
                  data: "0x00000000000000000000000000000000000000000000155fb4eb6a46edc16f7e",
                  topics: [
                    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                    "0x00000000000000000000000004b41fe46e8685719ac40101fc6478682256bc6f",
                    "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
                  ],
                },
                {
                  account: {
                    address: "0x4200000000000000000000000000000000000006",
                  },
                  data: "0x000000000000000000000000000000000000000000000000000110d9316ec000",
                  topics: [
                    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                    "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
                    "0x00000000000000000000000004b41fe46e8685719ac40101fc6478682256bc6f",
                  ],
                },
                {
                  account: {
                    address: "0x04b41fe46e8685719ac40101fc6478682256bc6f",
                  },
                  data: "0x000000000000000000000000000000000000000000000000000110d9316ec000ffffffffffffffffffffffffffffffffffffffffffffeaa04b1495b9123e908200000000000000000000000000000000000047a0303f63c37270191196a63125000000000000000000000000000000000000000000000050726e80cf50481db4000000000000000000000000000000000000000000000000000000000002fef6",
                  topics: [
                    "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67",
                    "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
                    "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
                  ],
                },
                {
                  account: {
                    address: "0xea372c317c9965bfc06ff15d3f049b31787c550d",
                  },
                  data: "0x00000000000000000000000000000000000000000000002d9958bc39f5634698",
                  topics: [
                    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                    "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
                    "0x0000000000000000000000005d64d14d2cf4fe5fe4e65b1c7e3d11e18d493091",
                  ],
                },
                {
                  account: {
                    address: "0xea372c317c9965bfc06ff15d3f049b31787c550d",
                  },
                  data: "0x000000000000000000000000000000000000000000004712014d5e5575bb075c",
                  topics: [
                    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                    "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
                    "0x00000000000000000000000090348e325bc286c7b7c1ec575cbb775b4b1903f0",
                  ],
                },
              ],
              type: 2,
              status: 1,
            },
          },
        ],
      },
    },
  },
})
  .then(() => console.log("done"))
  .catch(console.error);
