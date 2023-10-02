import * as composableCow from "../../abi/ComposableCoW.json";
import * as extensibleFallbackHandler from "../../abi/ExtensibleFallbackHandler.json";
import { isComposableCowCompatible, customErrorDecode } from ".";

// consts for readability
const composableCowBytecode = composableCow.deployedBytecode.object;
const failBytecode = extensibleFallbackHandler.deployedBytecode.object;

describe("test supports composable cow interface from bytecode", () => {
  it("should pass", () => {
    expect(isComposableCowCompatible(composableCowBytecode)).toBe(true);
  });

  it("should fail", () => {
    expect(isComposableCowCompatible(failBytecode)).toBe(false);
  });
});

describe("test against concrete examples", () => {
  const signatures = ["0x1c7662c8", "0x26e0a196"];

  it("should pass with both selectors", () => {
    expect(isComposableCowCompatible("0x1c7662c826e0a196")).toBe(true);
  });

  // using `forEach` here, be careful not to do async tests.
  signatures.forEach((s) => {
    it(`should fail with only selector ${s}`, () => {
      expect(isComposableCowCompatible(s)).toBe(false);
    });
  });

  it("should fail with no selectors", () => {
    expect(isComposableCowCompatible("0xdeadbeefdeadbeef")).toBe(false);
  });
});

describe("custom errors (reversions)", () => {
  it("should pass the SingleOrderNotAuthed selector correctly", () => {
    expect(customErrorDecode(SINGLE_ORDER_NOT_AUTHED_ERROR)).toMatchObject({
      selector: "SINGLE_ORDER_NOT_AUTHED",
    });
  });

  it("should pass the OrderNotValid selector correctly", () => {
    expect(customErrorDecode(ORDER_NOT_VALID)).toMatchObject({
      selector: "ORDER_NOT_VALID",
      message: "after twap finish",
    });
  });

  it("should pass the PollTryNextBlock selector correctly", () => {
    expect(customErrorDecode(POLL_TRY_NEXT_BLOCK)).toMatchObject({
      selector: "POLL_TRY_NEXT_BLOCK",
      message: "try me again",
    });
  });

  it("should pass the PollTryAtBlock selector correctly", () => {
    expect(customErrorDecode(POLL_TRY_AT_BLOCK)).toMatchObject({
      selector: "POLL_TRY_AT_BLOCK",
      message: "red pill",
      blockNumberOrEpoch: 303,
    });
  });

  it("should pass the PollTryAtEpoch selector correctly", () => {
    expect(customErrorDecode(POLL_TRY_AT_EPOCH)).toMatchObject({
      selector: "POLL_TRY_AT_EPOCH",
      message: "here's looking at you",
      blockNumberOrEpoch: 1694340000,
    });
  });

  it("should pass the PollNever selector correctly", () => {
    expect(customErrorDecode(POLL_NEVER)).toMatchObject({
      selector: "POLL_NEVER",
      message: "after twap finish",
    });
  });
});

// test data

const SINGLE_ORDER_NOT_AUTHED_ERROR = "0x7a933234";

const ORDER_NOT_VALID =
  "0xc8fc272500000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000011616674657220747761702066696e697368000000000000000000000000000000";

const POLL_TRY_NEXT_BLOCK =
  "0xd05f30650000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000c747279206d6520616761696e0000000000000000000000000000000000000000";

const POLL_TRY_AT_BLOCK =
  "0x1fe8506e000000000000000000000000000000000000000000000000000000000000012f000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000087265642070696c6c000000000000000000000000000000000000000000000000";

const POLL_TRY_AT_EPOCH =
  "0x7e3346370000000000000000000000000000000000000000000000000000000064fd93a000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000015686572652773206c6f6f6b696e6720617420796f750000000000000000000000";

const POLL_NEVER =
  "0x981b64cd00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000011616674657220747761702066696e697368000000000000000000000000000000";
