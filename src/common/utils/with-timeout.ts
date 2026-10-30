/** Bounds dependency waits; the underlying client still owns cancellation/reconnect. */
export async function withTimeout<T>(
    work: PromiseLike<T>,
    milliseconds = 2000,
): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            Promise.resolve(work),
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error('Dependency request timed out')),
                    milliseconds,
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}
