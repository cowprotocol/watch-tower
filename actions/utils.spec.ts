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
