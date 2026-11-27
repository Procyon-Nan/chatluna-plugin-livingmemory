export class MemoryInputError extends Error {}

export const missingMemory = (id: string) =>
    new MemoryInputError(`不存在 ID 为 ${id} 的记忆，请重新查明记忆 ID 后再调用。`)
