export async function fetchJson<T>({ cid }: { cid: string }): Promise<T> {
  return JSON.parse(new TextDecoder().decode(await fetchBuffer({ cid })));
}

export async function fetchBuffer({
  cid,
  key,
}: {
  cid: string;
  key?: string;
}): Promise<Buffer> {
  const response = await fetch(
    `https://ipfs.infura.io:5001/api/v0/cat?arg=${cid}`,
    {
      method: "POST",
      headers: {
        Authorization:
          key ??
          `Basic ${Buffer.from(
            `${process.env.INFURA_KEY}:${process.env.INFURA_IPFS_KEY}`
          ).toString("base64")}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error(
      `Failed to fetch content: ${response.status} - ${response.statusText}`
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

export async function upload(data: Buffer | string): Promise<string> {
  const formData = new FormData();
  formData.append(
    "file",
    new Blob([data], { type: "application/octet-stream" })
  );
  const response = await fetch(`https://ipfs.infura.io:5001/api/v0/add`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(
        `${process.env.INFURA_KEY}:${process.env.INFURA_IPFS_KEY}`
      ).toString("base64")}`,
    },
    body: formData,
  });
  const details = await response.json();
  return details.Hash;
}
