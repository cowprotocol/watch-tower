import { escalatingRetryDelay, handleOrderBookError } from ".";
import { PollResultCode } from "@cowprotocol/sdk-composable";

describe("escalatingRetryDelay", () => {
  it("retries on the next block for the first two failures", () => {
    expect(escalatingRetryDelay(1)).toBeUndefined();
    expect(escalatingRetryDelay(2)).toBeUndefined();
  });

  it("backs off for a minute on the third consecutive failure", () => {
    expect(escalatingRetryDelay(3)).toBe(60);
  });

  it("backs off for ten minutes on the fourth consecutive failure", () => {
    expect(escalatingRetryDelay(4)).toBe(600);
  });

  it("settles on an hourly retry once the order is clearly broken", () => {
    expect(escalatingRetryDelay(5)).toBe(3600);
    expect(escalatingRetryDelay(99)).toBe(3600);
  });
});

describe("handleOrderBookError", () => {
  const NOW = 1_784_857_003;
  const LABELS = ["8453", "0xhandler", "0xowner", "0xid"];
  const invalidSignature = {
    errorType: "InvalidEip1271Signature",
    description: "signature for computed order has bad format",
  };

  const handle = (consecutiveFailures: number) =>
    handleOrderBookError(
      400,
      invalidSignature,
      new Error("api"),
      NOW,
      LABELS,
      consecutiveFailures
    );

  it("retries on the next block while the failure may still be transient", () => {
    expect(handle(1)).toMatchObject({
      result: PollResultCode.TRY_NEXT_BLOCK,
    });
  });

  it("backs off once the same failure keeps repeating", () => {
    expect(handle(3)).toMatchObject({
      result: PollResultCode.TRY_AT_EPOCH,
      epoch: NOW + 60,
    });
  });

  it("escalates to an hourly retry for a persistently broken order", () => {
    expect(handle(9)).toMatchObject({
      result: PollResultCode.TRY_AT_EPOCH,
      epoch: NOW + 3600,
    });
  });
});
