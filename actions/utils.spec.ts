import * as composableCow from './artifacts/ComposableCoW.json'
import * as extensibleFallbackHandler from './artifacts/ExtensibleFallbackHandler.json'
import { checkInterface } from './utils'

describe('test supports composable cow interface from bytecode', () => {
    it('should pass', async () => {
        expect(await checkInterface(composableCow.deployedBytecode.object)).toBe(true)
    })

    it('should fail', async () => {
        expect(await checkInterface(extensibleFallbackHandler.deployedBytecode.object)).toBe(false)
    })
})
