import * as composableCow from './artifacts/ComposableCoW.json'
import * as extensibleFallbackHandler from './artifacts/ExtensibleFallbackHandler.json'
import { isComposableCowCompatible } from './utils'

// consts for readability
const composableCowBytecode = composableCow.deployedBytecode.object
const failBytecode = extensibleFallbackHandler.deployedBytecode.object

describe('test supports composable cow interface from bytecode', () => {
    it('should pass', () => {
        expect(isComposableCowCompatible(composableCowBytecode)).toBe(true)
    })

    it('should fail', () => {
        expect(isComposableCowCompatible(failBytecode)).toBe(false)
    })
})

describe('test against concrete examples', () => {
    const signatures = ['0x1c7662c8', '0x26e0a196']

    it('should pass with both selectors', () => {
        expect(isComposableCowCompatible('0x1c7662c826e0a196')).toBe(true)
    })

    // using `forEach` here, be careful not to do async tests.
    signatures.forEach((s) => {
        it(`should fail with only selector ${s}`, () => {
            expect(isComposableCowCompatible(s)).toBe(false)
        })
    })

    it('should fail with no selectors', () => {
        expect(isComposableCowCompatible('0xdeadbeefdeadbeef')).toBe(false)
    })
})