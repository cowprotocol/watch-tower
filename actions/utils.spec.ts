import * as composableCow from './artifacts/ComposableCoW.json'
import * as extensibleFallbackHandler from './artifacts/ExtensibleFallbackHandler.json'
import { isCompatible } from './utils'

describe('test supports composable cow interface from bytecode', () => {
    it('should pass', () => {
        expect(isCompatible(composableCow.deployedBytecode.object)).toBe(true)
    })

    it('should fail', () => {
        expect(isCompatible(extensibleFallbackHandler.deployedBytecode.object)).toBe(false)
    })
})

describe('test against concrete examples', () => {
    const signatures = ['0x1c7662c8', '0x26e0a196']

    it('should pass with both selectors', () => {
        expect(isCompatible('0x1c7662c826e0a196')).toBe(true)
    })

    // using `forEach` here, be careful not to do async tests.
    signatures.forEach((s) => {
        it(`should fail with only selector ${s}`, () => {
            expect(isCompatible(s)).toBe(false)
        })
    })

    it('should fail with no selectors', () => {
        expect(isCompatible('0xdeadbeefdeadbeef')).toBe(false)
    })
})