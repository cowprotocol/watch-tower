import * as composableCow from './artifacts/ComposableCoW.json'
import * as extensibleFallbackHandler from './artifacts/ExtensibleFallbackHandler.json'
import { compatCheck } from './utils'

describe('test supports composable cow interface from bytecode', () => {
    it('should pass', () => {
        expect(compatCheck(composableCow.deployedBytecode.object)).toBe(true)
    })

    it('should fail', () => {
        expect(compatCheck(extensibleFallbackHandler.deployedBytecode.object)).toBe(false)
    })
})
