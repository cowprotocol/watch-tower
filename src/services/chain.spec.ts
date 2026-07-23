import { providers } from "ethers";
import { isReorg } from "./chain";

const block = (
  number: number,
  hash: string,
  parentHash = ""
): providers.Block => ({ number, hash, parentHash } as providers.Block);

describe("isReorg", () => {
  const provider = {
    getBlock: jest.fn(),
  } as unknown as providers.Provider;

  beforeEach(() => jest.clearAllMocks());

  it("accepts a consecutive block with the expected parent", async () => {
    await expect(
      isReorg(provider, block(10, "old"), block(11, "new", "old"))
    ).resolves.toBe(false);
  });

  it("detects a consecutive block with a different parent", async () => {
    await expect(
      isReorg(provider, block(10, "old"), block(11, "new", "fork"))
    ).resolves.toBe(true);
  });

  it("accepts a block gap when the previous block remains canonical", async () => {
    provider.getBlock = jest.fn().mockResolvedValue(block(10, "old"));

    await expect(
      isReorg(provider, block(10, "old"), block(13, "new"))
    ).resolves.toBe(false);
    expect(provider.getBlock).toHaveBeenCalledWith(10);
  });

  it("detects a block gap when the previous block is no longer canonical", async () => {
    provider.getBlock = jest.fn().mockResolvedValue(block(10, "fork"));

    await expect(
      isReorg(provider, block(10, "old"), block(13, "new"))
    ).resolves.toBe(true);
  });

  it("propagates gap verification errors to the subscription handler", async () => {
    provider.getBlock = jest.fn().mockRejectedValue(new Error("RPC failed"));

    await expect(
      isReorg(provider, block(10, "old"), block(13, "new"))
    ).rejects.toThrow("RPC failed");
  });
});
