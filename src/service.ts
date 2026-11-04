import { Context, Service } from 'cordis'

declare module 'cordis' {
    interface Context {
        livingmemory: LivingmemoryService
    }
}

const serviceName = 'livingmemory'

export default class LivingmemoryService extends Service {
    constructor(ctx: Context) {
        super(ctx, serviceName)
    }
}
