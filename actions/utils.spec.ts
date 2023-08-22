import * as composableCow from './artifacts/ComposableCoW.json'
import { checkInterface } from './utils'

describe('test contract bytecode', () => {
    it('should pass', async () => {
        console.log(composableCow.deployedBytecode.object)
        expect(await checkInterface(composableCow.deployedBytecode.object)).toBe(true)
    })
})
